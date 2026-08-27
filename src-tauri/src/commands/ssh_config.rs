// 已信任主机（known_hosts）查询/删除命令。纯委托 ssh 模块，与 DB 侧无关。

/// 列出所有已信任的 known_hosts 条目（host:port → fingerprint）。
#[tauri::command]
pub fn list_known_hosts() -> Vec<(String, String)> {
    crate::ssh::list_known_hosts()
}

/// 删除指定 host:port 的 known_hosts 条目。
#[tauri::command]
pub fn delete_known_host(host_port: String) -> Result<(), String> {
    // 委托给 ssh::delete_host_key，确保与 tofu_check/clear_host_key 共用同一把锁
    crate::ssh::delete_host_key(&host_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_known_hosts() {
        let hosts = list_known_hosts();
        // 验证返回类型正确（实际结果取决于系统状态）
        assert!(hosts.iter().all(|(h, f)| !h.is_empty() && !f.is_empty()));
    }

    #[test]
    fn test_delete_nonexistent_host() {
        // 删除不存在的主机应该成功（幂等）
        let result = delete_known_host("nonexistent-host-12345:22".to_string());
        assert!(result.is_ok());
    }
}
