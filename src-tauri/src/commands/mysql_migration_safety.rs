/// String transport cannot preserve these MySQL values. Reject before touching the target.
pub(crate) fn unsupported_transfer_type(data_type: &str, extra: &str) -> bool {
    matches!(data_type.to_ascii_lowercase().as_str(),
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" |
        "bit" | "geometry" | "point" | "linestring" | "polygon" | "multipoint" |
        "multilinestring" | "multipolygon" | "geometrycollection" | "float" | "double")
        || extra.to_ascii_uppercase().contains("GENERATED") && !extra.to_ascii_uppercase().contains("DEFAULT_GENERATED")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_values_that_string_transport_cannot_preserve() {
        assert!(unsupported_transfer_type("blob", ""));
        assert!(unsupported_transfer_type("BIT", ""));
        assert!(unsupported_transfer_type("double", ""));
        assert!(unsupported_transfer_type("int", "STORED GENERATED"));
        assert!(!unsupported_transfer_type("decimal", ""));
        assert!(!unsupported_transfer_type("datetime", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP"));
    }
}
