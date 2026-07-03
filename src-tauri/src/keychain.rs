// 密码存储（软件内，不调用操作系统钥匙串/凭据管理器，避免弹系统授权框）：
// - Windows：用 DPAPI（CryptProtectData）加密后写盘，绑定当前 Windows 用户账户。
// - Unix：  文件权限 0600，仅所有者可读写。
// 代理/跳板密码用复合键 "{id}::proxy" / "{id}::jump" 同样存于此。

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

static PWD_FILE: OnceLock<PathBuf> = OnceLock::new();
static PWD_LOCK: Mutex<()> = Mutex::new(());

pub fn init(app_data_dir: &PathBuf) {
    let _ = PWD_FILE.set(app_data_dir.join("passwords.json"));
}

pub fn set_password(conn_id: &str, password: &str) -> Result<(), String> {
    let _lock = PWD_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = pwd_path()?;
    let mut map = load_map(&path)?;
    map.insert(conn_id.to_string(), password.to_string());
    save_map(&path, &map)
}

pub fn get_password(conn_id: &str) -> Result<Option<String>, String> {
    let _lock = PWD_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = pwd_path()?;
    let map = load_map(&path)?;
    Ok(map.get(conn_id).cloned())
}

pub fn delete_password(conn_id: &str) -> Result<(), String> {
    let _lock = PWD_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = pwd_path()?;
    let mut map = load_map(&path)?;
    if map.remove(conn_id).is_none() { return Ok(()); }
    save_map(&path, &map)
}

fn pwd_path() -> Result<PathBuf, String> {
    PWD_FILE.get().cloned().ok_or_else(|| "密码存储未初始化".to_string())
}

/// 删除整个密码文件（清空本机数据用，不可恢复）。
pub fn clear_all() -> Result<(), String> {
    let _lock = PWD_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = pwd_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|_| "删除密码文件失败".to_string())?;
    }
    Ok(())
}

// ── 平台无关层 ────────────────────────────────────────────────────────────────

fn load_map(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = fs::read(path).map_err(|_| "读取密码文件失败".to_string())?;
    if raw.is_empty() {
        return Ok(HashMap::new());
    }
    let json_bytes = platform_decrypt(&raw, path)?;
    let content = String::from_utf8(json_bytes).map_err(|_| "密码文件编码错误".to_string())?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|_| "解析密码文件失败".to_string())
}

fn save_map(path: &PathBuf, map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|_| "序列化密码失败".to_string())?;
    let data = platform_encrypt(json.as_bytes())?;
    // 原子写：先写临时文件，收紧权限后 rename（消除 TOCTOU）
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &data).map_err(|_| "写入临时密码文件失败".to_string())?;
    restrict_permissions(&tmp);
    fs::rename(&tmp, path).map_err(|_| "重命名密码文件失败".to_string())
}

/// 收紧文件权限为仅所有者可读写（0600）
pub fn restrict_permissions(_path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(_path, fs::Permissions::from_mode(0o600));
    }
}

// ── Windows DPAPI ─────────────────────────────────────────────────────────────

#[cfg(windows)]
fn platform_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::protect(plaintext)
}

#[cfg(windows)]
fn platform_decrypt(raw: &[u8], path: &PathBuf) -> Result<Vec<u8>, String> {
    // 先尝试 DPAPI 解密
    if let Ok(dec) = dpapi::unprotect(raw) {
        return Ok(dec);
    }
    // 回退：检查是否为旧版明文 JSON（迁移场景）
    if let Ok(s) = std::str::from_utf8(raw) {
        if s.trim_start().starts_with('{') {
            log::info!("密码文件为旧版明文格式，自动迁移为 DPAPI 加密格式");
            // 立即用 DPAPI 重新加密并写回（当前持锁，安全）
            let encrypted = dpapi::protect(raw)?;
            let tmp = path.with_extension("tmp");
            // 写回失败不阻断读取（仍返回已解析的明文），但必须记录告警，避免"误以为已加密"
            if let Err(e) = fs::write(&tmp, &encrypted) {
                log::error!("迁移写入临时文件失败，密码文件仍为明文: {e}");
            } else {
                restrict_permissions(&tmp);
                if let Err(e) = fs::rename(&tmp, path) {
                    log::error!("迁移重命名失败，密码文件仍为明文: {e}");
                    let _ = fs::remove_file(&tmp);
                }
            }
            return Ok(raw.to_vec());
        }
    }
    Err("密码文件格式无法识别（可能由不同 Windows 账户加密）".to_string())
}

// ── Unix（无加密，依赖文件系统 0600 权限）────────────────────────────────────

#[cfg(not(windows))]
fn platform_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plaintext.to_vec())
}

#[cfg(not(windows))]
fn platform_decrypt(raw: &[u8], _path: &PathBuf) -> Result<Vec<u8>, String> {
    Ok(raw.to_vec())
}

// ── DPAPI 实现（仅 Windows）──────────────────────────────────────────────────

#[cfg(windows)]
mod dpapi {
    // windows 0.61 API：CryptProtectData/CryptUnprotectData 返回 Result<()>；
    // LocalFree 取 Option<HLOCAL>，HLOCAL 为 *mut c_void
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn make_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = make_blob(plaintext);
            let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            CryptProtectData(
                &input,
                windows::core::w!("DBTerm"),
                None,          // pvpOptionalEntropy（Option<*const CRYPT_INTEGER_BLOB>）
                None,          // pvReserved（Option<*const c_void>）
                None,          // pPromptStruct（Option<*const CRYPTPROTECT_PROMPTSTRUCT>）
                0,
                &mut output,
            ).map_err(|e| format!("DPAPI 加密失败: {e}"))?;
            if output.pbData.is_null() {
                return Err("DPAPI 加密返回空缓冲区".to_string());
            }
            let enc = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(enc)
        }
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = make_blob(ciphertext);
            let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            CryptUnprotectData(
                &input,
                None,          // 不取描述字符串（Option<PWSTR>）
                None,          // pvOptionalEntropy
                None,          // pvReserved
                None,          // pPromptStruct
                0,
                &mut output,
            ).map_err(|e| format!("DPAPI 解密失败: {e}"))?;
            if output.pbData.is_null() {
                return Err("DPAPI 解密返回空缓冲区".to_string());
            }
            let dec = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            Ok(dec)
        }
    }
}
