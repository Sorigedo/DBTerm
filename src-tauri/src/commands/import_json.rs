//! JSON is typed: string "NULL" is text, numbers retain their source precision.
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use std::collections::HashMap;

struct Object(HashMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Object;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object with unique field names")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Object, M::Error> {
                let mut fields = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if fields.insert(key.clone(), value).is_some() {
                        return Err(serde::de::Error::custom(format!("重复JSON字段: {key}")));
                    }
                }
                Ok(Object(fields))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}
pub(crate) fn records(
    content: &str,
    columns: &[String],
    _null_value: &str,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let objects: Vec<Object> = serde_json::from_str(content)
        .map_err(|e| format!("解析JSON对象数组失败，数据库尚未写入: {e}"))?;
    objects
        .into_iter()
        .map(|object| {
            columns
                .iter()
                .map(|name| {
                    let Some(value) = object.0.get(name) else {
                        return Ok(None);
                    };
                    let raw = value.get();
                    if raw == "null" {
                        Ok(None)
                    } else if raw.starts_with('"') {
                        serde_json::from_str::<String>(raw)
                            .map(Some)
                            .map_err(|e| format!("解析JSON字符串失败: {e}"))
                    } else {
                        Ok(Some(raw.to_string()))
                    }
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_numbers_and_explicit_json_null_are_preserved() {
        let rows=records(r#"[{"id":123456789012345678901234567890,"v":"NULL","n":null,"d":1.2345678901234567890123456789}]"#,&["id","v","n","d"].map(String::from),"NULL").unwrap();
        assert_eq!(
            rows[0],
            vec![
                Some("123456789012345678901234567890".into()),
                Some("NULL".into()),
                None,
                Some("1.2345678901234567890123456789".into())
            ]
        );
    }
    #[test]
    fn strings_boolean_missing_and_structured_values_keep_their_types() {
        let input = r#"[{"text":"line\n\"quoted\"","empty":"","b":true,"object": { "n": 123456789012345678901234567890 },"array":[1, null]}]"#;
        let result = records(
            input,
            &["text", "empty", "b", "missing", "object", "array"].map(String::from),
            "",
        )
        .unwrap();
        assert_eq!(
            result[0],
            vec![
                Some("line\n\"quoted\"".into()),
                Some("".into()),
                Some("true".into()),
                None,
                Some(r#"{ "n": 123456789012345678901234567890 }"#.into()),
                Some("[1, null]".into())
            ]
        );
    }
    #[test]
    fn non_object_rows_and_duplicate_fields_fail_before_writes() {
        for input in [
            r#"[{"id":1},42]"#,
            r#"[{"id":1,"id":2}]"#,
            r#"[{"id":1,"\u0069d":2}]"#,
            r#"[{"id":1},null]"#,
            r#"[{"id":1}] trailing"#,
        ] {
            assert!(
                records(input, &["id".into()], "NULL").is_err(),
                "invalid input accepted: {input}"
            );
        }
    }
}
