use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
};
use crate::models::ConnConfig;

pub struct Storage {
    path: PathBuf,
}

impl Storage {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("无法创建配置目录: {e}"))?;
        Ok(Self {
            path: app_data_dir.join("connections.json"),
        })
    }

    pub fn load(&self) -> Result<Vec<ConnConfig>, String> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&self.path)
            .map_err(|e| format!("读取配置文件失败: {e}"))?;
        if content.trim().is_empty() {
            return Ok(vec![]);
        }
        serde_json::from_str(&content)
            .map_err(|e| format!("解析配置文件失败: {e}"))
    }

    fn write_all(&self, conns: &[ConnConfig]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(conns)
            .map_err(|e| format!("序列化失败: {e}"))?;
        // 先写临时文件再原子重命名，防止写入中途崩溃损坏配置
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &json)
            .map_err(|e| format!("写入临时配置文件失败: {e}"))?;
        // 连接表含主机/用户名/密钥路径及（SSH 代理/跳板机）密码，收紧到 0600 防同机其他用户读取
        crate::keychain::restrict_permissions(&tmp);
        fs::rename(&tmp, &self.path)
            .map_err(|e| format!("配置文件重命名失败: {e}"))?;
        crate::keychain::restrict_permissions(&self.path);
        Ok(())
    }

    pub fn upsert(&self, config: ConnConfig) -> Result<ConnConfig, String> {
        let mut all = self.load()?;
        let pos = all.iter().position(|c| c.id == config.id);
        let saved = config.clone();
        match pos {
            Some(i) => all[i] = config,
            None => all.push(config),
        }
        self.write_all(&all)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut all = self.load()?;
        all.retain(|c| c.id != id);
        self.write_all(&all)
    }

    /// 删除整个连接配置文件（清空本机数据用，不可恢复）。
    pub fn clear(&self) -> Result<(), String> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .map_err(|e| format!("删除连接配置失败: {e}"))?;
        }
        Ok(())
    }
}

pub type StorageState = Mutex<Storage>;
