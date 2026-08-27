// DB SSH 隧道：为数据库连接建立 direct-tcpip 代理
//
// 用法:
//   let t = DbTunnel::open(&cfg, "10.1.2.3", 3306).await?;
//   // 之后连接 127.0.0.1:t.local_port 即透过 SSH 到达目标数据库
//   // t 超出作用域时自动关闭隧道

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{info, warn, instrument};
use crate::tracing_utils::Timer;

/// 全局隧道池：key = 连接 ID。复用已建立的 SSH 连接，避免每次查询都重新登录跳板机
static POOL: OnceLock<Mutex<HashMap<String, Arc<DbTunnel>>>> = OnceLock::new();
fn pool() -> &'static Mutex<HashMap<String, Arc<DbTunnel>>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 每个 key 的建连锁：防止并发首次建连时重复握手（TOCTOU 修复）
static BUILD_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
fn build_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    BUILD_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// SSH 隧道连接参数（由调用方直接构造）
#[derive(Default, Clone)]
pub struct DbTunnelCfg {
    pub host:      String,
    pub port:      u16,
    pub user:      String,
    /// "password" | "key" | "mfa" | "agent" | "none"
    pub auth_type: String,
    pub password:  String,
    pub key_path:  String,
}

impl DbTunnelCfg {
    /// SSH 端口，为 0 时返回默认 22
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 { 22 } else { self.port }
    }
}

/// 活跃的 DB SSH 隧道（RAII：drop 时自动停止代理并关闭 SSH 连接）
pub struct DbTunnel {
    pub local_port: u16,
    _task:   tokio::task::JoinHandle<()>,
    // Arc 持有引用，保证 SSH 连接在整个测试/查询期间不被关闭
    _handle: Arc<russh::client::Handle<crate::ssh::SshHandler>>,
}

impl DbTunnel {
    /// SSH 连接是否仍然存活（同时检查 SSH handle 和后台代理 task）
    pub fn is_alive(&self) -> bool {
        !self._handle.is_closed() && !self._task.is_finished()
    }

    /// 按 key（连接 ID）复用隧道：已存在且存活则直接返回，否则新建并入池。
    /// 每个 key 持有独立建连锁，防止并发首次建连时重复握手。
    #[instrument(skip(cfg), fields(key = %key, db_host = %db_host, db_port = db_port))]
    pub async fn open_shared(key: &str, cfg: &DbTunnelCfg, db_host: &str, db_port: u16)
        -> Result<Arc<Self>, String>
    {
        let _timer = Timer::new("open_shared_tunnel");
        // 快速路径：池中已有活跃隧道直接返回
        {
            let p = pool().lock().await;
            if let Some(t) = p.get(key) {
                if t.is_alive() {
                    info!("Reusing existing SSH tunnel");
                    return Ok(t.clone());
                }
            }
        }

        // 获取（或创建）该 key 的建连锁，序列化并发首次建连
        let build_lock = {
            let mut locks = build_locks().lock().await;
            locks.entry(key.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
        };
        let _guard = build_lock.lock().await;

        // 再次检查：前一个等待者可能已建好并入池
        {
            let mut p = pool().lock().await;
            if let Some(t) = p.get(key) {
                if t.is_alive() {
                    info!("SSH tunnel built by concurrent request");
                    return Ok(t.clone());
                }
                p.remove(key);
                warn!("DB SSH tunnel disconnected, rebuilding");
            }
        }

        // 耗时的 SSH 握手在池锁外执行（但在 build_lock 内，保证唯一性）
        let t = Arc::new(Self::open(cfg, db_host, db_port).await?);
        info!(local_port = t.local_port, "SSH tunnel established");
        pool().lock().await.insert(key.to_string(), t.clone());
        Ok(t)
    }

    /// 建立 SSH 连接，绑定本地随机端口，代理到 db_host:db_port
    #[instrument(skip(cfg), fields(ssh_host = %cfg.host, ssh_port = cfg.effective_port(), db_host = %db_host, db_port = db_port))]
    pub async fn open(cfg: &DbTunnelCfg, db_host: &str, db_port: u16) -> Result<Self, String> {
        let _timer = Timer::new("open_tunnel");
        // 统一展开私钥路径中的 ~（覆盖所有调用方：query/db_tx/redis/mongo/sqlserver…）
        let owned;
        let cfg = if cfg.key_path.starts_with("~/") {
            owned = DbTunnelCfg {
                key_path: crate::tester::expand_home(&cfg.key_path).to_string_lossy().into_owned(),
                ..cfg.clone()
            };
            &owned
        } else { cfg };
        if cfg.host.trim().is_empty() {
            return Err("SSH 隧道：主机地址为空，请在 SSH 隧道标签页填写主机".to_string());
        }
        if cfg.user.trim().is_empty() {
            return Err("SSH 隧道：用户名为空".to_string());
        }
        // 私钥路径校验：必须是绝对路径且文件存在
        if !cfg.key_path.is_empty() {
            let kp = std::path::Path::new(&cfg.key_path);
            if !kp.is_absolute() {
                return Err("SSH 隧道：私钥路径必须是绝对路径".to_string());
            }
            if !kp.exists() {
                return Err(format!("SSH 隧道：私钥文件不存在: {}", cfg.key_path));
            }
        }

        // ── 1. 建立 SSH 连接并认证 ──────────────────────────
        let handle = crate::ssh::connect_for_db_tunnel(cfg).await
            .map_err(|e| format!("SSH 隧道认证失败: {e}"))?;
        let handle = Arc::new(handle);

        // ── 2. OS 分配随机本地端口（绑定 127.0.0.1:0）──────
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("SSH 隧道：绑定本地端口失败: {e}"))?;
        let local_port = listener.local_addr()
            .map_err(|e| format!("SSH 隧道：获取本地端口失败: {e}"))?.port();

        let db_host_s = db_host.to_string();
        let h = handle.clone();

        // ── 3. 后台代理任务：接受 TCP → direct-tcpip → 双向复制 ──
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((mut tcp, peer)) => {
                        let h2 = h.clone();
                        let host_c = db_host_s.clone();
                        tokio::spawn(async move {
                            match h2.channel_open_direct_tcpip(
                                host_c, db_port as u32,
                                peer.ip().to_string(), peer.port() as u32,
                            ).await {
                                Ok(ch) => {
                                    let mut stream = ch.into_stream();
                                    if let Err(e) = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await {
                                        log::debug!("DB 隧道流结束: {e}");
                                    }
                                }
                                Err(e) => log::warn!("DB 隧道 direct-tcpip 失败: {e}"),
                            }
                        });
                    }
                    Err(_) => break, // listener 已关闭
                }
            }
        });

        log::info!("DB SSH 隧道就绪: 127.0.0.1:{local_port} → {db_host}:{db_port} (via {}:{})",
            cfg.host, cfg.effective_port());
        Ok(DbTunnel { local_port, _task: task, _handle: handle })
    }
}

impl Drop for DbTunnel {
    fn drop(&mut self) {
        self._task.abort();
        log::debug!("DB SSH 隧道已关闭 (local_port={})", self.local_port);
    }
}

// ── 测试模块 ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_tunnel_cfg_default() {
        let cfg = DbTunnelCfg::default();
        assert_eq!(cfg.host, "");
        assert_eq!(cfg.port, 0);
        assert_eq!(cfg.user, "");
        assert_eq!(cfg.auth_type, "");
        assert_eq!(cfg.password, "");
        assert_eq!(cfg.key_path, "");
    }

    #[test]
    fn test_db_tunnel_cfg_effective_port_default() {
        let cfg = DbTunnelCfg {
            port: 0,
            ..Default::default()
        };
        assert_eq!(cfg.effective_port(), 22);
    }

    #[test]
    fn test_db_tunnel_cfg_effective_port_custom() {
        let cfg = DbTunnelCfg {
            port: 2222,
            ..Default::default()
        };
        assert_eq!(cfg.effective_port(), 2222);
    }

    #[test]
    fn test_db_tunnel_cfg_clone() {
        let cfg1 = DbTunnelCfg {
            host: "jump.example.com".to_string(),
            port: 22,
            user: "admin".to_string(),
            auth_type: "key".to_string(),
            password: "".to_string(),
            key_path: "~/.ssh/id_rsa".to_string(),
        };

        let cfg2 = cfg1.clone();
        assert_eq!(cfg2.host, "jump.example.com");
        assert_eq!(cfg2.port, 22);
        assert_eq!(cfg2.user, "admin");
        assert_eq!(cfg2.auth_type, "key");
        assert_eq!(cfg2.key_path, "~/.ssh/id_rsa");
    }

    #[test]
    fn test_db_tunnel_cfg_various_auth_types() {
        let auth_types = vec!["password", "key", "mfa", "agent", "none"];

        for auth_type in auth_types {
            let cfg = DbTunnelCfg {
                auth_type: auth_type.to_string(),
                ..Default::default()
            };
            assert_eq!(cfg.auth_type, auth_type);
        }
    }

    #[test]
    fn test_db_tunnel_cfg_construction() {
        let cfg = DbTunnelCfg {
            host: "192.168.1.100".to_string(),
            port: 2222,
            user: "dbuser".to_string(),
            auth_type: "password".to_string(),
            password: "secret123".to_string(),
            key_path: "".to_string(),
        };

        assert_eq!(cfg.host, "192.168.1.100");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.user, "dbuser");
        assert_eq!(cfg.auth_type, "password");
        assert_eq!(cfg.password, "secret123");
        assert_eq!(cfg.key_path, "");
        assert_eq!(cfg.effective_port(), 2222);
    }

    #[test]
    fn test_db_tunnel_cfg_key_auth() {
        let cfg = DbTunnelCfg {
            host: "jump.internal".to_string(),
            port: 22,
            user: "automation".to_string(),
            auth_type: "key".to_string(),
            password: "".to_string(),
            key_path: "/home/user/.ssh/automation_key".to_string(),
        };

        assert_eq!(cfg.auth_type, "key");
        assert_eq!(cfg.key_path, "/home/user/.ssh/automation_key");
        assert_eq!(cfg.password, "");
    }

    #[test]
    fn test_db_tunnel_cfg_mfa_auth() {
        let cfg = DbTunnelCfg {
            host: "secure.example.com".to_string(),
            port: 22,
            user: "adminuser".to_string(),
            auth_type: "mfa".to_string(),
            password: "pass123".to_string(),
            key_path: "".to_string(),
        };

        assert_eq!(cfg.auth_type, "mfa");
        assert_eq!(cfg.password, "pass123");
    }

    #[test]
    fn test_db_tunnel_cfg_agent_auth() {
        let cfg = DbTunnelCfg {
            host: "dev.example.com".to_string(),
            port: 22,
            user: "developer".to_string(),
            auth_type: "agent".to_string(),
            password: "".to_string(),
            key_path: "".to_string(),
        };

        assert_eq!(cfg.auth_type, "agent");
        assert_eq!(cfg.password, "");
        assert_eq!(cfg.key_path, "");
    }

    #[test]
    fn test_pool_initialization() {
        // 测试pool可以初始化
        let _p = pool();
        // 多次调用应该返回同一个实例
        let p1 = pool();
        let p2 = pool();
        assert!(std::ptr::eq(p1, p2));
    }

    #[test]
    fn test_build_locks_initialization() {
        // 测试build_locks可以初始化
        let _locks = build_locks();
        // 多次调用应该返回同一个实例
        let l1 = build_locks();
        let l2 = build_locks();
        assert!(std::ptr::eq(l1, l2));
    }

    #[test]
    fn test_db_tunnel_cfg_standard_port() {
        let cfg = DbTunnelCfg {
            host: "ssh.example.com".to_string(),
            port: 22,
            user: "user".to_string(),
            auth_type: "password".to_string(),
            password: "pass".to_string(),
            key_path: "".to_string(),
        };

        assert_eq!(cfg.effective_port(), 22);
    }

    #[test]
    fn test_db_tunnel_cfg_high_port() {
        let cfg = DbTunnelCfg {
            host: "custom.example.com".to_string(),
            port: 9999,
            user: "user".to_string(),
            auth_type: "key".to_string(),
            password: "".to_string(),
            key_path: "~/.ssh/custom".to_string(),
        };

        assert_eq!(cfg.effective_port(), 9999);
    }

    // 注意：实际的DbTunnel::open和open_shared需要真实SSH连接，
    // 在单元测试中无法测试。这些测试应该在集成测试中进行。
    // 这里我们只测试配置和初始化相关的逻辑。
}
