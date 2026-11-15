//! Shared RFC-style CSV/TSV record decoding for preview and data import.
use std::io::Read;
const MAX_HEADER_BYTES:u64=1024*1024;
fn delimiter(format:&str)->Result<u8,String>{match format{"csv"=>Ok(b','),"tsv"|"txt"=>Ok(b'\t'),_=>Err("不支持此分隔文本格式".into())}}
fn reader<R:Read>(input:R,format:&str)->Result<csv::Reader<R>,String>{Ok(csv::ReaderBuilder::new().has_headers(false).delimiter(delimiter(format)?).flexible(false).from_reader(input))}
pub(crate)fn header<R:Read>(input:R,format:&str)->Result<Vec<String>,String>{
    let mut limited=input.take(MAX_HEADER_BYTES+1);
    let mut csv=reader(&mut limited,format)?;
    let record=csv.records().next().transpose().map_err(|e|format!("读取分隔文件表头失败: {e}"))?;
    let consumed=csv.position().byte();drop(csv);
    if consumed>MAX_HEADER_BYTES||limited.limit()==0{return Err("文件首条记录超过1MiB，已停止预览".into());}
    Ok(record.map(|r|r.iter().map(str::to_string).collect()).unwrap_or_default())
}
pub(crate)fn records<R:Read>(input:R,format:&str,has_header:bool,columns:usize,null_value:&str)->Result<Vec<Vec<Option<String>>>,String>{
    if columns==0{return Err("导入至少需要一个目标列".into());}
    let mut csv=reader(input,format)?;
    let mut rows=Vec::new();
    for(number,record)in csv.records().enumerate(){
        let record=record.map_err(|e|format!("第{}条记录解析失败，数据库尚未写入: {e}",number+1))?;
        if record.len()!=columns{return Err(format!("第{}条记录有{}列，但映射为{}列，数据库尚未写入",number+1,record.len(),columns));}
        if has_header&&number==0{continue;}
        rows.push(record.iter().map(|v|if v==null_value{None}else{Some(v.to_string())}).collect());
    }
    Ok(rows)
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn quoted_newlines_delimiters_quotes_and_crlf_stay_in_one_value(){let bytes=b"id,value\r\n1,\"first\nsecond,\"\"quote\"\"\"\r\n2,plain\r\n";let rows=records(&bytes[..],"csv",true,2,"NULL").unwrap();assert_eq!(rows.len(),2);assert_eq!(rows[0][1].as_deref(),Some("first\nsecond,\"quote\""));}
    #[test]fn preview_and_import_agree_on_quoted_header_and_bom(){let text="\u{feff}\"id,part\",\"value\nlabel\"\r\n1,2\r\n";assert_eq!(header(text.as_bytes(),"csv").unwrap(),vec!["id,part","value\nlabel"]);assert_eq!(records(text.as_bytes(),"csv",true,2,"NULL").unwrap().len(),1);}
    #[test]fn tsv_empty_string_null_and_no_header_preserve_existing_null_marker_policy(){let rows=records("1\t\"a\tb\"\t\tNULL\n".as_bytes(),"tsv",false,4,"NULL").unwrap();assert_eq!(rows[0],vec![Some("1".into()),Some("a\tb".into()),Some("".into()),None]);}
    #[test]fn mismatched_width_fails_before_any_row_is_returned(){assert!(records("id,v\n1,a\n2,b,c\n".as_bytes(),"csv",true,2,"NULL").is_err());assert!(records("id,v\n1,a\n".as_bytes(),"csv",true,1,"NULL").is_err());}
    #[test]fn preview_rejects_oversized_record_with_bounded_read(){let bytes=vec![b'x';MAX_HEADER_BYTES as usize+20];assert!(header(bytes.as_slice(),"csv").unwrap_err().contains("1MiB"));}
}

#[cfg(test)]
mod sqlite_fidelity_tests {
    use super::*;
    use sqlx::Connection;
    #[tokio::test]
    async fn decoded_records_keep_exact_multiline_unicode_empty_and_null_values_in_sqlite() {
        let mut conn=sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("CREATE TABLE fixture(id TEXT, value TEXT)").execute(&mut conn).await.unwrap();
        let rows=records("id,value\r\n1,\"第一行\n第二行,\"\"引号\"\"\"\r\n2,\r\n3,NULL\r\n".as_bytes(),"csv",true,2,"NULL").unwrap();
        for row in rows {sqlx::query("INSERT INTO fixture VALUES(?,?)").bind(row[0].as_deref()).bind(row[1].as_deref()).execute(&mut conn).await.unwrap();}
        let actual=sqlx::query_as::<_,(String,Option<String>)>("SELECT id,value FROM fixture ORDER BY id").fetch_all(&mut conn).await.unwrap();
        assert_eq!(actual,vec![("1".into(),Some("第一行\n第二行,\"引号\"".into())),("2".into(),Some("".into())),("3".into(),None)]);
    }
}
