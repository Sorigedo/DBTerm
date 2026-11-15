//! Strict DBterm row XML. No DTD, external entities, or partial-file acceptance.
use quick_xml::{events::Event, Reader};
use std::collections::HashMap;
fn invalid(reason: impl std::fmt::Display) -> String {
    format!("解析XML失败，数据库尚未写入: {reason}")
}
pub(crate) fn records(
    content: &str,
    columns: &[String],
    _null_value: &str,
) -> Result<Vec<Vec<Option<String>>>, String> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut fields: HashMap<String, Option<String>> = HashMap::new();
    let mut cell: Option<(String, String)> = None;
    let mut rows = Vec::new();
    loop {
        match reader.read_event().map_err(invalid)? {
            Event::Start(start) => {
                if start.attributes().next().is_some() {
                    return Err(invalid("不支持带属性的行或字段，拒绝猜测字段语义"));
                }
                let name = std::str::from_utf8(start.name().as_ref())
                    .map_err(invalid)?
                    .to_string();
                match depth {
                    0 => {
                        if root_seen || root_closed {
                            return Err(invalid("只能有一个根节点"));
                        }
                        root_seen = true;
                    }
                    1 => {
                        if name != "row" {
                            return Err(invalid("根节点下只允许row记录"));
                        }
                        fields.clear();
                    }
                    2 => {
                        if fields.contains_key(&name) {
                            return Err(invalid(format!("重复字段: {name}")));
                        }
                        cell = Some((name, String::new()));
                    }
                    _ => return Err(invalid("字段内不允许嵌套元素；请使用转义文本或CDATA")),
                }
                depth += 1;
            }
            Event::Empty(start) => {
                if start.attributes().next().is_some() {
                    return Err(invalid("不支持带属性的空节点"));
                }
                let name = std::str::from_utf8(start.name().as_ref())
                    .map_err(invalid)?
                    .to_string();
                match depth {
                    0 => {
                        if root_seen {
                            return Err(invalid("只能有一个根节点"));
                        }
                        root_seen = true;
                        root_closed = true;
                    }
                    1 => {
                        if name != "row" {
                            return Err(invalid("根节点下只允许row记录"));
                        }
                        rows.push(vec![None; columns.len()]);
                    }
                    2 => {
                        if fields.insert(name.clone(), None).is_some() {
                            return Err(invalid(format!("重复字段: {name}")));
                        }
                    }
                    _ => return Err(invalid("字段内不允许嵌套元素")),
                }
            }
            Event::End(_) => {
                match depth {
                    3 => {
                        let (name, value) = cell.take().ok_or_else(|| invalid("字段状态无效"))?;
                        fields.insert(name, Some(value));
                    }
                    2 => rows.push(
                        columns
                            .iter()
                            .map(|name| fields.get(name).cloned().unwrap_or(None))
                            .collect(),
                    ),
                    1 => root_closed = true,
                    _ => return Err(invalid("多余的结束节点")),
                }
                depth -= 1;
            }
            Event::Text(text) => {
                let value = text.decode().map_err(invalid)?;
                if let Some((_, ref mut output)) = cell {
                    output.push_str(&value);
                } else if !value.trim().is_empty() {
                    return Err(invalid("行或根节点外出现数据文本"));
                }
            }
            Event::CData(text) => {
                let value = std::str::from_utf8(text.as_ref()).map_err(invalid)?;
                if let Some((_, ref mut output)) = cell {
                    output.push_str(value);
                } else {
                    return Err(invalid("CDATA只能出现在字段中"));
                }
            }
            Event::GeneralRef(reference) => {
                let value = if let Some(character) = reference.resolve_char_ref().map_err(invalid)? {
                    character.to_string()
                } else {
                    let name = reference.decode().map_err(invalid)?;
                    quick_xml::escape::resolve_predefined_entity(&name)
                        .ok_or_else(|| invalid(format!("不支持的实体: {name}")))?
                        .to_string()
                };
                if let Some((_, ref mut output)) = cell {
                    output.push_str(&value);
                } else {
                    return Err(invalid("实体引用只能出现在字段中"));
                }
            }
            Event::Decl(decl) => {
                if root_seen || depth != 0 {
                    return Err(invalid("XML声明位置无效"));
                }
                if decl.version().map_err(invalid)?.as_ref() != b"1.0" {
                    return Err(invalid("只支持XML1.0"));
                }
                if let Some(encoding) = decl.encoding() {
                    if !encoding.map_err(invalid)?.eq_ignore_ascii_case(b"utf-8") {
                        return Err(invalid("只支持UTF-8文件"));
                    }
                }
            }
            Event::Comment(_) => {}
            Event::DocType(_) => return Err(invalid("不允许DTD或外部实体")),
            Event::PI(_) => return Err(invalid("不支持处理指令")),
            Event::Eof => break,
        }
    }
    if depth != 0 || !root_seen || !root_closed {
        return Err(invalid("XML文档为空或未完整结束"));
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exported_empty_root_rows_whitespace_and_reordered_fields_are_readable() {
        let cols = ["id", "value", "missing"].map(String::from);
        assert!(
            records("<?xml version=\"1.0\"?><fixture></fixture>", &cols, "NULL")
                .unwrap()
                .is_empty()
        );
        let rows = records(
            "<fixture><!--note--><row><value>  a\n b  </value><id>1</id></row><row/></fixture>",
            &cols,
            "NULL",
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![
                vec![Some("1".into()), Some("  a\n b  ".into()), None],
                vec![None, None, None]
            ]
        );
    }
    #[test]
    fn xml_values_keep_entities_cdata_empty_text_and_explicit_null() {
        let input = r#"<?xml version="1.0"?><fixture><row><id>1</id><value>&#x4E2D;&#25991;<![CDATA[<raw>&]]>&amp;lt;</value></row><row><id>2</id><value></value></row><row><id>3</id><value/></row><row><id>4</id><value>NULL</value></row></fixture>"#;
        let rows = records(input, &["id", "value"].map(String::from), "NULL").unwrap();
        assert_eq!(
            rows,
            vec![
                vec![Some("1".into()), Some("中文<raw>&&lt;".into())],
                vec![Some("2".into()), Some("".into())],
                vec![Some("3".into()), None],
                vec![Some("4".into()), Some("NULL".into())]
            ]
        );
    }
    #[test]
    fn damaged_or_ambiguous_xml_never_returns_partial_records() {
        for input in ["<t><row><id>1</id></row><row><id>2</id>","<t><row><id>1</id><id>2</id></row></t>","<t><row><id><nested>1</nested></id></row></t>","<t><row><id>&undefined;</id></row></t>","<!DOCTYPE t [<!ENTITY ext SYSTEM 'file:///not-read'>]><t><row><id>&ext;</id></row></t>","<t/><other/>"]{
 assert!(records(input,&["id".into()],"NULL").is_err(),"invalid XML silently accepted: {input}");
 }
    }
}
