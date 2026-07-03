//! MariaDB 专属管理命令（mariadb_* 前缀，不污染 MySQL/TiDB/OceanBase 共享函数）
//! 所有命令仅在 connType = Mariadb 时有意义；其他类型连接误调会返回明确错误。

use serde::{Deserialize, Serialize};
use sqlx::{ConnectOptions, Row};
use tauri::State;
use crate::{
    models::{ConnConfig, ConnType},
    storage::StorageState,
};

// ── 私有连接工具（与其他 commands/*.rs 保持一致，各文件独立） ─────────────────

#[derive(serde::Deserialize, Default)]
struct DbConnCfg {
    #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
    #[serde(rename = "sslMode",  default)] ssl_mode:  String,
    #[serde(rename = "sslCa",   default)] ssl_ca:    String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:   bool,
    #[serde(rename = "sshHost",     default)] ssh_host:     String,
    #[serde(rename = "sshPort",     default)] ssh_port:     u16,
    #[serde(rename = "sshUser",     default)] ssh_user:     String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password: String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path: String,
}
impl DbConnCfg {
    fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            if self.connect_timeout == 0 { 15 } else { self.connect_timeout.clamp(3, 60) }
        )
    }
}

fn load_conn(id: &str, storage: &State<'_, StorageState>) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().map_err(|_| "存储锁失败".to_string())?.load()?;
    let config  = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

async fn maria_connect(
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<(sqlx::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
    use crate::commands::query::MySqlPwdExt;
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(3306)).await?;
        let lp = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(3306))
    };

    let mut opts = MySqlConnectOptions::new().host(&h).port(p).username(user).password_opt(pwd);
    if !db.is_empty() { opts = opts.database(db); }
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => MySqlSslMode::Required,
        "verify-ca"   => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _             => MySqlSslMode::Disabled,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    Ok((conn, tunnel))
}

// ── MA1.1 序列对象列表（MariaDB 10.3+ 原生序列）────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaSequence {
    pub sequence_name:   String,
    pub sequence_schema: String,
    pub start_value:     i64,
    pub minimum_value:   i64,
    pub maximum_value:   i64,
    pub increment:       i64,
    pub cycle_option:    bool,
}

/// 列出指定 schema 下的 MariaDB 原生序列（10.3+）。
/// 只读查询 information_schema.SEQUENCES，绝不修改数据。
#[tauri::command]
pub async fn mariadb_list_sequences(
    id:     String,
    schema: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<MariaSequence>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    let schema_name = if schema.is_empty() {
        config.database.as_deref().unwrap_or("").to_string()
    } else {
        schema.clone()
    };
    if schema_name.is_empty() {
        return Ok(vec![]);
    }
    drop(storage);

    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    let sql = "SELECT SEQUENCE_NAME, SEQUENCE_SCHEMA, \
                      START_VALUE, MINIMUM_VALUE, MAXIMUM_VALUE, INCREMENT, CYCLE_OPTION \
               FROM information_schema.SEQUENCES \
               WHERE SEQUENCE_SCHEMA = ? \
               ORDER BY SEQUENCE_NAME";

    let rows = sqlx::query(sql)
        .bind(&schema_name)
        .fetch_all(&mut conn)
        .await
        .map_err(|e| format!("查询序列失败: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let cycle_raw: String = row.try_get(6).unwrap_or_default();
        out.push(MariaSequence {
            sequence_name:   row.try_get(0).unwrap_or_default(),
            sequence_schema: row.try_get(1).unwrap_or_default(),
            start_value:     row.try_get::<i64, _>(2).unwrap_or(1),
            minimum_value:   row.try_get::<i64, _>(3).unwrap_or(1),
            maximum_value:   row.try_get::<i64, _>(4).unwrap_or(i64::MAX),
            increment:       row.try_get::<i64, _>(5).unwrap_or(1),
            cycle_option:    cycle_raw.eq_ignore_ascii_case("1") || cycle_raw.eq_ignore_ascii_case("yes"),
        });
    }
    Ok(out)
}

// ── MA1.2 表结构额外信息（MariaDB 专属属性：引擎/系统版本化/INVISIBLE列）────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaColumnExtra {
    pub column_name:  String,
    pub is_invisible: bool,
    pub is_virtual:   bool,
    pub is_persistent: bool,
    pub generation_expr: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaTableExtra {
    pub engine:             String,
    pub has_system_versioning: bool,
    pub row_format:         String,
    pub columns:            Vec<MariaColumnExtra>,
}

/// 获取 MariaDB 表的专属属性：引擎、系统版本化、每列的 INVISIBLE/PERSISTENT 信息。
/// 只读查询，不修改任何数据。
#[tauri::command]
pub async fn mariadb_table_extra_info(
    id:     String,
    schema: String,
    table:  String,
    storage: State<'_, StorageState>,
) -> Result<MariaTableExtra, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    let schema_name = if schema.is_empty() {
        config.database.as_deref().unwrap_or("").to_string()
    } else {
        schema.clone()
    };
    drop(storage);

    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    // 表级别信息
    let tbl_row = sqlx::query(
        "SELECT ENGINE, CREATE_OPTIONS, ROW_FORMAT \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1"
    )
    .bind(&schema_name)
    .bind(&table)
    .fetch_optional(&mut conn)
    .await
    .map_err(|e| format!("查询表信息失败: {e}"))?;

    let (engine, create_opts, row_format) = tbl_row.map(|r| {
        let engine:  String = r.try_get(0).unwrap_or_default();
        let opts:    String = r.try_get(1).unwrap_or_default();
        let rfmt:    String = r.try_get(2).unwrap_or_default();
        (engine, opts, rfmt)
    }).unwrap_or_default();

    let has_system_versioning = create_opts.to_lowercase().contains("with system versioning");

    // 列级别信息（INVISIBLE、VIRTUAL/PERSISTENT 生成列）
    // information_schema.COLUMNS 在 MariaDB 含 IS_GENERATED 和 EXTRA 列
    let col_rows = sqlx::query(
        "SELECT COLUMN_NAME, \
                IF(FIND_IN_SET('INVISIBLE', UPPER(EXTRA)) > 0, 1, 0) AS is_invisible, \
                IF(GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION != '', 1, 0) AS is_generated, \
                IF(FIND_IN_SET('VIRTUAL', UPPER(EXTRA)) > 0, 1, 0) AS is_virtual, \
                IFNULL(GENERATION_EXPRESSION, '') AS gen_expr \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION"
    )
    .bind(&schema_name)
    .bind(&table)
    .fetch_all(&mut conn)
    .await
    .map_err(|e| format!("查询列信息失败: {e}"))?;

    let columns = col_rows.into_iter().map(|row| {
        let col_name:  String = row.try_get(0).unwrap_or_default();
        let invisible: i32    = row.try_get(1).unwrap_or(0);
        let is_gen:    i32    = row.try_get(2).unwrap_or(0);
        let is_virt:   i32    = row.try_get(3).unwrap_or(0);
        let gen_expr:  String = row.try_get(4).unwrap_or_default();
        MariaColumnExtra {
            column_name:  col_name,
            is_invisible: invisible != 0,
            is_virtual:   is_gen != 0 && is_virt != 0,
            is_persistent: is_gen != 0 && is_virt == 0,
            generation_expr: gen_expr,
        }
    }).collect();

    Ok(MariaTableExtra {
        engine,
        has_system_versioning,
        row_format,
        columns,
    })
}

// ── MA3.3 Galera 集群状态（只读，不提供变更入口）────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GaleraStatus {
    pub cluster_size:          u32,
    pub cluster_status:        String,   // Primary / Non-Primary
    pub local_state:           String,   // Synced / Donor / Joiner / Disconnected …
    pub flow_control_paused:   f64,      // wsrep_flow_control_paused (0.0–1.0)
    pub local_recv_queue:      u64,
    pub wsrep_ready:           bool,
    pub connected:             bool,
    pub local_bf_aborts:       u64,
    pub cert_failures:         u64,
    pub last_committed:        u64,
    pub is_galera:             bool,
}

/// 查询 Galera 集群状态变量（MariaDB 专属，只读）。
/// 非 Galera 节点返回 is_galera=false，前端据此隐藏面板。
#[tauri::command]
pub async fn mariadb_galera_status(
    id:     String,
    storage: State<'_, StorageState>,
) -> Result<GaleraStatus, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    drop(storage);

    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    // 通过 wsrep_on 快速判断是否 Galera
    // 注意：wsrep_on 是系统“变量”，存在于 GLOBAL_VARIABLES，而非 GLOBAL_STATUS（后者查不到此名，会返回 NULL）
    let wsrep_on: Option<String> = sqlx::query_scalar(
        "SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_VARIABLES WHERE VARIABLE_NAME = 'wsrep_on'")
        .fetch_optional(&mut conn)
        .await
        .unwrap_or(None);

    // 如果 wsrep_on 不可用，尝试 SHOW GLOBAL STATUS
    let is_galera = wsrep_on
        .as_deref()
        .map(|v| v.eq_ignore_ascii_case("on") || v == "1")
        .unwrap_or(false);

    if !is_galera {
        // 再尝试 SHOW GLOBAL STATUS LIKE 'wsrep_ready'
        let row = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_ready'")
            .fetch_optional(&mut conn)
            .await
            .unwrap_or(None);
        let ready = row
            .and_then(|r| r.try_get::<String, _>(1).ok())
            .map(|v| v.eq_ignore_ascii_case("on"))
            .unwrap_or(false);
        if !ready {
            return Ok(GaleraStatus { is_galera: false, ..Default::default() });
        }
    }

    // 批量拉取 wsrep 状态变量
    let rows = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_%'")
        .fetch_all(&mut conn)
        .await
        .map_err(|e| format!("查询 Galera 状态失败: {e}"))?;

    let mut status = GaleraStatus { is_galera: true, ..Default::default() };
    for row in rows {
        let name:  String = row.try_get(0).unwrap_or_default();
        let value: String = row.try_get(1).unwrap_or_default();
        match name.as_str() {
            "wsrep_cluster_size"          => status.cluster_size        = value.parse().unwrap_or(0),
            "wsrep_cluster_status"        => status.cluster_status       = value,
            "wsrep_local_state_comment"   => status.local_state          = value,
            "wsrep_flow_control_paused"   => status.flow_control_paused  = value.parse().unwrap_or(0.0),
            "wsrep_local_recv_queue"      => status.local_recv_queue     = value.parse().unwrap_or(0),
            "wsrep_ready"                 => status.wsrep_ready          = value.eq_ignore_ascii_case("on"),
            "wsrep_connected"             => status.connected            = value.eq_ignore_ascii_case("on"),
            "wsrep_local_bf_aborts"       => status.local_bf_aborts      = value.parse().unwrap_or(0),
            "wsrep_cert_deps_distance"    => {}  // 忽略
            "wsrep_last_committed"        => status.last_committed       = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    // cert_failures 是独立统计变量
    let cert_row = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_local_cert_failures'")
        .fetch_optional(&mut conn)
        .await
        .unwrap_or(None);
    status.cert_failures = cert_row
        .and_then(|r| r.try_get::<String, _>(1).ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    Ok(status)
}

// ── 可选增强 MA2.4: MyRocks 引擎指标 ─────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaRocksStat {
    pub name: String,
    pub value: String,
}

/// MyRocks 引擎状态变量（rocksdb_* 前缀）。
/// 非 MyRocks 实例返回空列表（graceful degradation）。
#[tauri::command]
pub async fn mariadb_rocksdb_stats(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<MariaRocksStat>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    let rows = match sqlx::query("SHOW GLOBAL STATUS LIKE 'rocksdb%'")
        .fetch_all(&mut conn).await
    {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),  // MyRocks 未安装
    };

    if rows.is_empty() {
        return Ok(vec![]);  // 已安装但无 rocksdb 变量（不太可能但防御）
    }

    Ok(rows.into_iter().map(|row| MariaRocksStat {
        name:  row.try_get::<String, _>(0).unwrap_or_default(),
        value: row.try_get::<String, _>(1).unwrap_or_default(),
    }).collect())
}

// ── 可选增强 MA3: binlog 事件浏览 ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaBinlogFile {
    pub log_name: String,
    pub file_size: u64,
    pub encrypted: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaBinlogEvent {
    pub log_name: String,
    pub pos: u64,
    pub event_type: String,
    pub server_id: u64,
    pub end_log_pos: u64,
    pub info: String,
}

/// MA3: 列出 binlog 文件（SHOW BINARY LOGS）
#[tauri::command]
pub async fn mariadb_binlog_files(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<MariaBinlogFile>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    let rows = match sqlx::query("SHOW BINARY LOGS").fetch_all(&mut conn).await {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not enabled") || msg.contains("1381") {
                return Ok(vec![]);  // binlog 未开启
            }
            return Err(format!("查询 binlog 文件失败: {e}"));
        }
    };

    Ok(rows.into_iter().map(|row| {
        let col_count = row.len();
        MariaBinlogFile {
            log_name:  row.try_get::<String, _>(0).unwrap_or_default(),
            // File_size 列在不同驱动/版本下可能呈现有/无符号，先 u64 再 i64 兜底，避免静默归零
            file_size: row.try_get::<u64, _>(1)
                .or_else(|_| row.try_get::<i64, _>(1).map(|v| v.max(0) as u64))
                .unwrap_or(0),
            encrypted: if col_count > 2 {
                row.try_get::<String, _>(2).unwrap_or_default()
            } else { "No".to_string() },
        }
    }).collect())
}

/// MA3: SHOW BINLOG EVENTS IN '<file>' LIMIT n（只读，不修改数据）
#[tauri::command]
pub async fn mariadb_binlog_events(
    id: String,
    log_name: String,
    limit: Option<u32>,
    storage: State<'_, StorageState>,
) -> Result<Vec<MariaBinlogEvent>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    if log_name.is_empty() || log_name.contains('\'') || log_name.contains('\\') {
        return Err("非法的 binlog 文件名".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    let n = limit.unwrap_or(200).clamp(1, 2000);
    // log_name 已验证无单引号/反斜杠，安全拼入 SQL
    let sql = format!("SHOW BINLOG EVENTS IN '{log_name}' LIMIT {n}");

    let rows = sqlx::query(&sql).fetch_all(&mut conn).await
        .map_err(|e| format!("读取 binlog 事件失败: {e}"))?;

    // 数值列先 u64 再 i64 兜底，避免类型不匹配时静默归零
    let as_u64 = |row: &sqlx::mysql::MySqlRow, idx: usize| -> u64 {
        row.try_get::<u64, _>(idx)
            .or_else(|_| row.try_get::<i64, _>(idx).map(|v| v.max(0) as u64))
            .unwrap_or(0)
    };
    Ok(rows.into_iter().map(|row| MariaBinlogEvent {
        log_name:    row.try_get::<String, _>(0).unwrap_or_default(),
        pos:         as_u64(&row, 1),
        event_type:  row.try_get::<String, _>(2).unwrap_or_default(),
        server_id:   as_u64(&row, 3),
        end_log_pos: as_u64(&row, 4),
        info:        row.try_get::<String, _>(5).unwrap_or_default(),
    }).collect())
}

// ── 可选增强 MA0: MaxScale 中间件探测 ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaxScaleInfo {
    pub is_maxscale: bool,
    pub version: String,
    pub version_comment: String,
    pub note: String,
}

/// MaxScale 中间件探测（尽力而为）：检查 @@version / @@version_comment 是否含 maxscale 特征。
/// 注意：MaxScale 是透明代理，多数配置下 SQL 层拿到的是后端真实版本，无法识别；
/// 仅当 MaxScale 配置了含 "maxscale" 的 version_string 时可探测到。
#[tauri::command]
pub async fn mariadb_maxscale_detect(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<MaxScaleInfo, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::Mariadb) {
        return Err("此命令仅适用于 MariaDB 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = maria_connect(&config, password.as_deref()).await?;

    let version: String = sqlx::query_scalar("SELECT @@version")
        .fetch_one(&mut conn).await.unwrap_or_default();
    let comment: String = sqlx::query_scalar("SELECT @@version_comment")
        .fetch_one(&mut conn).await.unwrap_or_default();

    let is_maxscale = version.to_lowercase().contains("maxscale")
        || comment.to_lowercase().contains("maxscale");
    let note = if is_maxscale {
        "检测到 MaxScale 特征（版本字符串含 maxscale）。".to_string()
    } else {
        "未检测到 MaxScale 特征。MaxScale 透明代理时 SQL 层通常无法识别（特征仅在连接握手 banner 暴露），此结果不能完全排除经 MaxScale 连接的可能。".to_string()
    };

    Ok(MaxScaleInfo { is_maxscale, version, version_comment: comment, note })
}
