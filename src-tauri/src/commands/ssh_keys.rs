// SSH 密钥管理命令（列出/生成/导入/删除/读取公钥）
use russh_keys::PublicKeyBase64;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub path: String,
    pub algo: String,
    pub comment: String,
    pub has_pubkey: bool,
    pub pub_path: Option<String>,
}

fn ssh_dir() -> PathBuf {
    crate::tester::expand_home("~/.ssh")
}

/// 验证路径在 ~/.ssh/ 下，防止 `..` 路径穿越。
/// 对已存在的文件：canonicalize 展开符号链接和 `..`。
/// 对不存在的文件：字符串层面检查 `..` 后验证前缀（用于清理孤立文件等场景）。
fn validate_in_ssh_dir(path: &PathBuf) -> Result<PathBuf, String> {
    if path.exists() {
        let canon = path.canonicalize().map_err(|e| format!("路径解析失败: {e}"))?;
        let allowed = ssh_dir().canonicalize().map_err(|e| format!("无法解析 ~/.ssh: {e}"))?;
        if !canon.starts_with(&allowed) {
            return Err("只允许操作 ~/.ssh/ 下的密钥文件".to_string());
        }
        Ok(canon)
    } else {
        // 文件不存在时退化为字符串检查，拒绝含 `..` 的路径
        let path_str = path.to_string_lossy();
        if path_str.contains("..") {
            return Err("路径不合法（含 ..）".to_string());
        }
        let allowed = ssh_dir();
        if !path.starts_with(&allowed) {
            return Err("只允许操作 ~/.ssh/ 下的密钥文件".to_string());
        }
        Ok(path.clone())
    }
}

/// 用于读取公钥：若文件不存在返回专用错误信息
fn validate_pub_key_path(pub_path: &PathBuf) -> Result<PathBuf, String> {
    if !pub_path.exists() {
        return Err("找不到对应的公钥文件（.pub）".to_string());
    }
    validate_in_ssh_dir(pub_path)
}

/// 列出 ~/.ssh/ 下所有私钥（过滤 .pub 和非 PEM 文件）
#[tauri::command]
pub fn list_ssh_keys() -> Result<Vec<SshKeyInfo>, String> {
    let dir = ssh_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result: Vec<SshKeyInfo> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "pub" || ext == "tmp" { continue; }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if matches!(name.as_str(), "known_hosts" | "known_hosts.old" | "authorized_keys" | "config" | "environment") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !content.contains("PRIVATE KEY") { continue; }

        // PKCS8 格式（BEGIN PRIVATE KEY）不含具体算法名，用 russh_keys 解析再取算法名
        let algo = if content.contains("RSA PRIVATE KEY") {
            "RSA".to_string()
        } else if content.contains("EC PRIVATE KEY") || content.contains("ECDSA") {
            "ECDSA".to_string()
        } else if content.contains("DSA PRIVATE KEY") {
            "DSA".to_string()
        } else if content.contains("PRIVATE KEY") {
            // PKCS8 / OpenSSH 通用格式 —— 尝试解析确认算法
            russh_keys::load_secret_key(&path, None)
                .map(|k| k.name().to_string())
                .unwrap_or_else(|_| "Unknown".to_string())
        } else {
            "Ed25519".to_string()
        };

        // 用字符串追加 .pub，与 generate_ssh_key / import_ssh_key 保持一致
        // with_extension("pub") 会替换最后一个扩展名（如 id_rsa.pem → id_rsa.pub），不符合预期
        let pub_path = path.parent().unwrap_or(path.as_path()).join(
            format!("{}.pub", path.file_name().unwrap_or_default().to_string_lossy())
        );
        let has_pubkey = pub_path.exists();
        let pub_path_str = if has_pubkey { Some(pub_path.to_string_lossy().to_string()) } else { None };

        let comment = if has_pubkey {
            fs::read_to_string(&pub_path)
                .ok()
                .and_then(|c| c.split_whitespace().nth(2).map(|s| s.to_string()))
                .unwrap_or_default()
        } else { String::new() };

        result.push(SshKeyInfo {
            name,
            path: path.to_string_lossy().to_string(),
            algo,
            comment,
            has_pubkey,
            pub_path: pub_path_str,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// 生成新 SSH 密钥对（Ed25519 或 RSA-4096），保存到 ~/.ssh/
#[tauri::command]
pub fn generate_ssh_key(
    algo: String,
    comment: String,
    filename: String,
) -> Result<SshKeyInfo, String> {
    let ssh_dir = ssh_dir();
    fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("文件名不合法".to_string());
    }
    let priv_path = ssh_dir.join(&filename);
    let pub_path  = ssh_dir.join(format!("{filename}.pub"));
    // 私钥和公钥都检查，避免静默覆盖已有公钥
    if priv_path.exists() {
        return Err(format!("文件已存在: {}", priv_path.display()));
    }
    if pub_path.exists() {
        return Err(format!("公钥文件已存在: {}", pub_path.display()));
    }

    let algo_lower = algo.to_lowercase();
    let key_pair = if algo_lower == "rsa" {
        russh_keys::key::KeyPair::generate_rsa(4096, russh_keys::key::SignatureHash::SHA2_512)
            .ok_or_else(|| "生成 RSA 密钥失败".to_string())?
    } else {
        russh_keys::key::KeyPair::generate_ed25519()
    };

    // 写私钥（PKCS8 PEM 格式）
    {
        let mut pem = Vec::new();
        russh_keys::encode_pkcs8_pem(&key_pair, &mut pem)
            .map_err(|e| format!("编码私钥失败: {e}"))?;
        fs::write(&priv_path, &pem).map_err(|e| format!("写私钥失败: {e}"))?;
        crate::keychain::restrict_permissions(&priv_path);
    }

    // 写公钥（OpenSSH authorized_keys 格式）
    let pub_str = {
        let pub_key = key_pair.clone_public_key().map_err(|e| format!("获取公钥失败: {e}"))?;
        let typ = pub_key.name();
        let blob = pub_key.public_key_base64();
        let cmt = if comment.is_empty() { "dbterm".to_string() } else { comment.clone() };
        format!("{typ} {blob} {cmt}\n")
    };
    fs::write(&pub_path, &pub_str).map_err(|e| {
        // 公钥写失败，清理已写入的私钥，避免孤立文件
        let _ = fs::remove_file(&priv_path);
        format!("写公钥失败: {e}")
    })?;

    Ok(SshKeyInfo {
        name: filename,
        path: priv_path.to_string_lossy().to_string(),
        algo: if algo_lower == "rsa" { "RSA".to_string() } else { "Ed25519".to_string() },
        comment,
        has_pubkey: true,
        pub_path: Some(pub_path.to_string_lossy().to_string()),
    })
}

/// 读取公钥内容（用于复制到服务器 authorized_keys），限制只读 ~/.ssh/ 下的文件
#[tauri::command]
pub fn get_public_key(key_path: String) -> Result<String, String> {
    let priv_path = PathBuf::from(&key_path);
    let pub_path = if key_path.ends_with(".pub") {
        priv_path
    } else {
        // 字符串追加 .pub，与 generate/import/list 保持一致
        // with_extension 会替换末尾扩展名（id_rsa.pem → id_rsa.pub），导致找不到实际公钥
        let fname = priv_path.file_name().unwrap_or_default().to_string_lossy();
        priv_path.parent().unwrap_or(priv_path.as_path())
            .join(format!("{fname}.pub"))
    };
    // 文件不存在时返回准确的用户友好错误信息
    let canon = validate_pub_key_path(&pub_path)?;
    fs::read_to_string(&canon).map_err(|e| e.to_string())
}

/// 将外部私钥文件导入到 ~/.ssh/
#[tauri::command]
pub fn import_ssh_key(src_path: String, new_name: String) -> Result<SshKeyInfo, String> {
    let src = PathBuf::from(&src_path);
    if !src.exists() { return Err("源文件不存在".to_string()); }
    let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
    if !content.contains("PRIVATE KEY") {
        return Err("文件不是有效的 SSH 私钥".to_string());
    }
    let filename = if new_name.is_empty() {
        src.file_name().and_then(|n| n.to_str()).unwrap_or("imported_key").to_string()
    } else { new_name };
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("文件名不合法".to_string());
    }

    let dst = ssh_dir().join(&filename);
    if dst.exists() { return Err(format!("~/.ssh/{filename} 已存在，请换个名字")); }
    fs::copy(&src, &dst).map_err(|e| format!("复制失败: {e}"))?;
    crate::keychain::restrict_permissions(&dst);

    let src_pub = src.with_extension("pub");
    let has_pubkey = if src_pub.exists() {
        let dst_pub = ssh_dir().join(format!("{filename}.pub"));
        fs::copy(&src_pub, &dst_pub).is_ok()
    } else { false };

    let algo = if content.contains("RSA PRIVATE") { "RSA".to_string() }
        else if content.contains("EC PRIVATE") { "ECDSA".to_string() }
        else { "Ed25519".to_string() };

    Ok(SshKeyInfo {
        name: filename.clone(),
        path: dst.to_string_lossy().to_string(),
        algo,
        comment: String::new(),
        has_pubkey,
        pub_path: if has_pubkey {
            Some(ssh_dir().join(format!("{filename}.pub")).to_string_lossy().to_string())
        } else { None },
    })
}

/// 删除 SSH 密钥（私钥 + 对应 .pub），validate_in_ssh_dir 同时支持文件不存在的场景
/// 以确保孤立 .pub 也能被清理
#[tauri::command]
pub fn delete_ssh_key(key_path: String) -> Result<(), String> {
    let raw = PathBuf::from(&key_path);
    let priv_path = validate_in_ssh_dir(&raw)?;
    if priv_path.exists() {
        fs::remove_file(&priv_path).map_err(|e| format!("删除私钥失败: {e}"))?;
    }
    // 字符串追加 .pub，与 generate/import 保持一致（with_extension 会替换 .pem 等后缀）
    let pub_path = ssh_dir().join(
        format!("{}.pub", raw.file_name().unwrap_or_default().to_string_lossy())
    );
    if pub_path.exists() {
        fs::remove_file(&pub_path).map_err(|e| format!("删除公钥失败: {e}"))?;
    }
    Ok(())
}
