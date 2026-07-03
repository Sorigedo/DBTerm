// TI3 — TiDB TiCDC 同步任务状态（HTTP API）
//
// TiCDC 是 TiDB 的增量数据同步组件，自身暴露 REST API（默认端口 8300），
// 与 MySQL 协议无关，因此独立成命令、走 HTTP。本模块只读查询 changefeed 列表与状态，
// 不下发任何变更。与 SQL 侧 / 其它模块完全隔离。
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicdcResult {
    /// 实际命中的 API 版本（v2 优先，回退 v1）
    pub api_version: String,
    /// 原始 JSON（前端按需解析展示）
    pub raw: serde_json::Value,
}

fn normalize(addr: &str) -> String {
    let a = addr.trim().trim_end_matches('/');
    if a.starts_with("http://") || a.starts_with("https://") {
        a.to_string()
    } else {
        format!("http://{a}")
    }
}

/// 查询 TiCDC changefeed 列表与状态。addr 形如 "127.0.0.1:8300" 或带协议的完整地址。
#[tauri::command]
pub async fn tidb_ticdc_changefeeds(addr: String) -> Result<TicdcResult, String> {
    if addr.trim().is_empty() {
        return Err("请填写 TiCDC 地址（如 127.0.0.1:8300）".to_string());
    }
    let base = normalize(&addr);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    // 先试 v2（TiCDC 6.x+），失败再回退 v1
    for (ver, path) in [("v2", "/api/v2/changefeeds"), ("v1", "/api/v1/changefeeds")] {
        let url = format!("{base}{path}");
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let raw: serde_json::Value = resp.json().await
                        .map_err(|e| format!("解析 TiCDC 响应失败: {e}"))?;
                    return Ok(TicdcResult { api_version: ver.to_string(), raw });
                }
                // 404 时继续尝试下一版本；其它状态码直接报错
                if status.as_u16() != 404 {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(format!("TiCDC {ver} 返回 {status}: {body}"));
                }
            }
            Err(e) => {
                // 连接级错误（地址不通），v1 也不必再试
                if ver == "v1" {
                    return Err(format!("连接 TiCDC 失败（{url}）: {e}"));
                }
            }
        }
    }
    Err("未找到 TiCDC changefeed 接口（v1/v2 均 404），请确认地址与版本".to_string())
}
