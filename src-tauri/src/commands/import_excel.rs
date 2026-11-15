//! Deterministic worksheet mapping; validate every selected cell before DB writes.
use calamine::{Data, Range};
use std::collections::HashSet;
pub(crate) fn records(
    range: &Range<Data>,
    columns: &[String],
    has_header: bool,
    null_value: &str,
) -> Result<Vec<Vec<Option<String>>>, String> {
    if columns.is_empty() || columns.iter().collect::<HashSet<_>>().len() != columns.len() {
        return Err("Excel目标字段为空或重复，数据库尚未写入".into());
    }
    let mut source = range.rows();
    let Some(first) = source.next() else {
        return Ok(Vec::new());
    };
    let indices = if has_header {
        let mut seen = HashSet::new();
        let names = first
            .iter()
            .map(|cell| match cell {
                Data::String(name) if !name.is_empty() => {
                    if !seen.insert(name.as_str()) {
                        Err(format!("Excel表头字段重复: {name}"))
                    } else {
                        Ok(name.as_str())
                    }
                }
                _ => Err("Excel表头必须是非空文本，数据库尚未写入".into()),
            })
            .collect::<Result<Vec<_>, String>>()?;
        columns
            .iter()
            .map(|column| {
                names
                    .iter()
                    .position(|name| *name == column)
                    .ok_or_else(|| format!("Excel缺少目标字段: {column}，数据库尚未写入"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        if range.width() != columns.len() {
            return Err(format!(
                "Excel无表头列数{}与目标字段数{}不一致，数据库尚未写入",
                range.width(),
                columns.len()
            ));
        }
        (0..columns.len()).collect()
    };
    let offset = range.start().map(|p| p.0 as usize).unwrap_or(0);
    let mut output = Vec::new();
    for (number, row) in range.rows().enumerate().skip(usize::from(has_header)) {
        let mut values = Vec::with_capacity(indices.len());
        for &index in &indices {
            let cell = row.get(index).ok_or_else(|| {
                format!(
                    "Excel第{}行缺少映射字段，数据库尚未写入",
                    offset + number + 1
                )
            })?;
            let value = match cell {
                Data::Empty => None,
                Data::Error(error) => {
                    return Err(format!(
                        "Excel第{}行第{}列含错误值{error}，数据库尚未写入",
                        offset + number + 1,
                        index + 1
                    ))
                }
                Data::Float(value) if !value.is_finite() => {
                    return Err(format!(
                        "Excel第{}行含非有限数值，数据库尚未写入",
                        offset + number + 1
                    ))
                }
                Data::String(value) => {
                    if value == null_value {
                        None
                    } else {
                        Some(value.clone())
                    }
                }
                other => {
                    let value = other.to_string();
                    if value == null_value {
                        None
                    } else {
                        Some(value)
                    }
                }
            };
            values.push(value);
        }
        output.push(values);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn truncated_ole_directory_returns_error_instead_of_panicking() {
        use calamine::Reader;
        // Header + one FAT sector + a one-byte truncated directory sector.
        // No huge length or allocation is needed to reproduce the old parser panic.
        let mut bytes = vec![0u8; 1025];
        bytes[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        for (offset, value) in [(26, 3u16), (28, 0xfffe), (30, 9), (32, 6)] {
            bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }
        bytes[44..48].copy_from_slice(&1u32.to_le_bytes());
        bytes[48..52].copy_from_slice(&1u32.to_le_bytes());
        bytes[68..72].copy_from_slice(&0xffff_fffeu32.to_le_bytes());
        bytes[76..512].fill(0xff);
        bytes[76..80].copy_from_slice(&0u32.to_le_bytes());
        bytes[512..1024].fill(0xff);
        bytes[512..516].copy_from_slice(&0xffff_fffdu32.to_le_bytes());
        bytes[516..520].copy_from_slice(&0xffff_fffeu32.to_le_bytes());
        let outcome = std::panic::catch_unwind(|| calamine::Xls::new(std::io::Cursor::new(bytes)));
        assert!(outcome.is_ok(), "malformed XLS must return an error, not panic");
        assert!(outcome.unwrap().is_err());
    }
    fn fixture(header: &[&str]) -> Range<Data> {
        let mut r = Range::new((0, 0), (1, header.len() as u32 - 1));
        for (i, name) in header.iter().enumerate() {
            r.set_value((0, i as u32), Data::String(name.to_string()));
            r.set_value((1, i as u32), Data::String(format!("v{i}")));
        }
        r
    }
    #[test]
    fn missing_or_duplicate_header_must_fail_before_writes() {
        for header in [vec!["id", "other"], vec!["id", "id"]] {
            assert!(
                records(
                    &fixture(&header),
                    &["id", "value"].map(String::from),
                    true,
                    "NULL"
                )
                .is_err(),
                "ambiguous header accepted: {header:?}"
            );
        }
    }
    #[test]
    fn spreadsheet_errors_must_not_be_inserted_as_text() {
        let mut r = fixture(&["id", "value"]);
        r.set_value((1, 1), Data::Error(calamine::CellErrorType::Div0));
        assert!(records(&r, &["id", "value"].map(String::from), true, "NULL").is_err());
    }
    #[test]
    fn headerless_width_mismatch_must_not_drop_data() {
        assert!(records(
            &fixture(&["id", "value", "extra"]),
            &["id", "value"].map(String::from),
            false,
            "NULL"
        )
        .is_err());
    }
}

#[cfg(test)]
mod fidelity_tests {
    use super::*;
    #[test]
    fn reordered_header_maps_null_empty_unicode_and_integer_values_exactly() {
        let mut range = Range::new((0, 0), (2, 2));
        for (column, name) in ["value", "extra", "id"].iter().enumerate() {
            range.set_value((0, column as u32), Data::String(name.to_string()));
        }
        range.set_value((1, 0), Data::String("中文\n001".into()));
        range.set_value((1, 2), Data::Int(1));
        range.set_value((2, 0), Data::String("".into()));
        range.set_value((2, 2), Data::Int(2));
        assert_eq!(
            records(&range, &["id", "value"].map(String::from), true, "NULL").unwrap(),
            vec![
                vec![Some("1".into()), Some("中文\n001".into())],
                vec![Some("2".into()), Some("".into())]
            ]
        );
        range.set_value((2, 0), Data::Empty);
        assert_eq!(
            records(&range, &["id", "value"].map(String::from), true, "NULL").unwrap()[1][1],
            None
        );
    }
    #[test]
    fn actual_xlsx_first_sheet_header_and_error_cell_are_validated() {
        use calamine::Reader;
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "dbterm-excel-{}.xlsx",
            uuid::Uuid::new_v4().simple()
        ));
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let files = [
            (
                "[Content_Types].xml",
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="fixture" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>001中文</t></is></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>"#,
            ),
        ];
        for (name, body) in files {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        let mut workbook = calamine::open_workbook_auto(&path).unwrap();
        let mut range = workbook.worksheet_range_at(0).unwrap().unwrap();
        assert!(records(&range, &["id", "value"].map(String::from), true, "NULL").is_err());
        range.set_value((2, 1), Data::Empty);
        let rows = records(&range, &["id", "value"].map(String::from), true, "NULL").unwrap();
        drop(workbook);
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            rows,
            vec![
                vec![Some("1".into()), Some("001中文".into())],
                vec![Some("2".into()), None]
            ]
        );
    }
}
