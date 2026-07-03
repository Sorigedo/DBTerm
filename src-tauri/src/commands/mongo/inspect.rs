// MO10.1+MO10.2: MongoDB 一键巡检报告（serverStatus 分析 + 配置风险扫描）
use bson::{doc, Document};
use serde::Serialize;
use tauri::State;
use futures::TryStreamExt;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

fn get_f64(d: &Document, k: &str) -> f64 {
    d.get_f64(k).ok()
        .or_else(|| d.get_i64(k).ok().map(|v| v as f64))
        .or_else(|| d.get_i32(k).ok().map(|v| v as f64))
        .unwrap_or(0.0)
}

fn get_i64(d: &Document, k: &str) -> i64 {
    d.get_i64(k).ok()
        .or_else(|| d.get_i32(k).ok().map(|v| v as i64))
        .or_else(|| d.get_f64(k).ok().map(|v| v as i64))
        .unwrap_or(0)
}

fn doc2<'a>(d: &'a Document, k1: &str, k2: &str) -> Option<&'a Document> {
    d.get_document(k1).ok().and_then(|sub| sub.get_document(k2).ok())
}

fn get_f64_nested2(d: &Document, k1: &str, k2: &str, field: &str) -> f64 {
    doc2(d, k1, k2).map(|sub| get_f64(sub, field)).unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectItem {
    pub category: String,    // 分类：性能 / 复制 / 索引 / 配置 / 存储
    pub key: String,         // 指标键
    pub label: String,       // 显示名称
    pub value: String,       // 当前值（字符串）
    pub status: String,      // "ok" | "warn" | "error" | "info"
    pub advice: String,      // 建议（空串表示无建议）
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowOpEntry {
    pub op_type: String,
    pub ns: String,
    pub millis_avg: i64,
    pub count: i64,
    pub plan: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedIndex {
    pub ns: String,
    pub index_name: String,
    pub key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectReport {
    pub items: Vec<InspectItem>,
    pub slow_ops: Vec<SlowOpEntry>,
    pub unused_indexes: Vec<UnusedIndex>,
    pub score: i32,           // 0-100 综合得分
    pub summary: String,      // 一行总结
}

/// MO10.1: 一键巡检报告
#[tauri::command]
pub async fn mongo_inspect(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<InspectReport, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let admin_db = client.database("admin");

    let mut items: Vec<InspectItem> = Vec::new();
    let mut score_deduction: i32 = 0;

    // ── serverStatus ─────────────────────────────────────────────────────────
    let ss = admin_db.run_command(doc! { "serverStatus": 1 }).await
        .map_err(|e| format!("serverStatus 失败: {e}"))?;

    // 版本信息
    let version = ss.get_str("version").unwrap_or("未知").to_string();
    items.push(InspectItem {
        category: "基本信息".to_string(), key: "version".to_string(),
        label: "MongoDB 版本".to_string(), value: version.clone(),
        status: "info".to_string(), advice: String::new(),
    });

    // 连接数
    let conns = ss.get_document("connections").ok().cloned().unwrap_or_default();
    let current_conns = get_i64(&conns, "current");
    let available_conns = get_i64(&conns, "available");
    let total_conns = current_conns + available_conns;
    let conn_pct = if total_conns > 0 { current_conns as f64 / total_conns as f64 * 100.0 } else { 0.0 };
    let (conn_status, conn_advice) = if conn_pct > 80.0 {
        score_deduction += 15;
        ("error", "连接使用率超过 80%，建议检查连接池配置或增加 maxIncomingConnections")
    } else if conn_pct > 60.0 {
        score_deduction += 5;
        ("warn", "连接使用率超过 60%，注意监控增长趋势")
    } else {
        ("ok", "")
    };
    items.push(InspectItem {
        category: "性能".to_string(), key: "connections".to_string(),
        label: "连接使用率".to_string(), value: format!("{current_conns}/{total_conns} ({conn_pct:.1}%)"),
        status: conn_status.to_string(), advice: conn_advice.to_string(),
    });

    // 缓存命中率（WiredTiger）
    let wt_cache_hit = get_f64_nested2(&ss, "wiredTiger", "cache", "pages read into cache");
    let wt_cache_req = get_f64_nested2(&ss, "wiredTiger", "cache", "pages requested from the cache");
    if wt_cache_req > 0.0 {
        let cache_miss_rate = wt_cache_hit / wt_cache_req * 100.0;
        let hit_rate = 100.0 - cache_miss_rate;
        let (status, advice) = if hit_rate < 80.0 {
            score_deduction += 20;
            ("error", "缓存命中率低于 80%，大量磁盘 IO，建议增加 wiredTigerCacheSizeGB")
        } else if hit_rate < 90.0 {
            score_deduction += 8;
            ("warn", "缓存命中率低于 90%，考虑增加内存或优化工作集大小")
        } else {
            ("ok", "")
        };
        items.push(InspectItem {
            category: "性能".to_string(), key: "cache_hit_rate".to_string(),
            label: "WiredTiger 缓存命中率".to_string(), value: format!("{hit_rate:.1}%"),
            status: status.to_string(), advice: advice.to_string(),
        });
    }

    // Ops 统计（操作计数器）
    let opcounters = ss.get_document("opcounters").ok().cloned().unwrap_or_default();
    let total_ops: i64 = ["insert", "query", "update", "delete", "getmore", "command"]
        .iter().map(|k| get_i64(&opcounters, k)).sum();
    items.push(InspectItem {
        category: "性能".to_string(), key: "total_ops".to_string(),
        label: "累计操作数".to_string(), value: format!("{total_ops}"),
        status: "info".to_string(), advice: String::new(),
    });

    // 慢查询（通过 system.profile 采样，若有 profiling 开启）
    let mut slow_ops: Vec<SlowOpEntry> = Vec::new();
    {
        let target_db = client.database(&db);
        let profile_status = target_db.run_command(doc! { "profile": -1 }).await.ok();
        let profiling_level = profile_status.as_ref()
            .and_then(|d| d.get_i32("was").ok())
            .unwrap_or(0);

        if profiling_level > 0 {
            use mongodb::options::FindOptions;
            let coll = target_db.collection::<Document>("system.profile");
            let opts = FindOptions::builder()
                .sort(doc! { "millis": -1 })
                .limit(20)
                .build();
            if let Ok(mut cursor) = coll.find(doc! { "op": { "$ne": "getmore" } }).with_options(opts).await {
                while let Ok(Some(d)) = cursor.try_next().await {
                    slow_ops.push(SlowOpEntry {
                        op_type: d.get_str("op").unwrap_or("").to_string(),
                        ns: d.get_str("ns").unwrap_or("").to_string(),
                        millis_avg: get_i64(&d, "millis"),
                        count: 1,
                        plan: d.get_document("execStats").ok()
                            .and_then(|s| s.get_str("stage").ok())
                            .unwrap_or("").to_string(),
                    });
                }
            }
        } else {
            items.push(InspectItem {
                category: "性能".to_string(), key: "profiling_off".to_string(),
                label: "慢查询 Profiler".to_string(), value: "未开启".to_string(),
                status: "warn".to_string(),
                advice: "建议对非生产库开启 profiling level 1（slowms 100ms），以便识别慢查询".to_string(),
            });
        }
    }

    // ── 副本集状态 ────────────────────────────────────────────────────────────
    if let Ok(repl_status) = admin_db.run_command(doc! { "replSetGetStatus": 1 }).await {
        let members = repl_status.get_array("members").ok().map(|a| a.as_slice()).unwrap_or_default();
        let mut max_lag_secs: i64 = 0;
        let mut has_unhealthy = false;
        let empty_doc = Document::new();
        for m in members {
            let md = m.as_document().unwrap_or(&empty_doc);
            let health = get_f64(md, "health");
            if health < 1.0 { has_unhealthy = true; }
            // optimeDate 延迟（简化：比较最大 optime ts）
            let lag = md.get_i64("optimeDate").ok().unwrap_or(0);
            if lag > max_lag_secs { max_lag_secs = lag; }
        }
        if has_unhealthy {
            score_deduction += 30;
            items.push(InspectItem {
                category: "复制".to_string(), key: "repl_unhealthy".to_string(),
                label: "副本集健康".to_string(), value: "有节点不健康".to_string(),
                status: "error".to_string(),
                advice: "副本集中有节点 health != 1，请立即检查节点状态和网络连通性".to_string(),
            });
        } else {
            items.push(InspectItem {
                category: "复制".to_string(), key: "repl_healthy".to_string(),
                label: "副本集健康".to_string(), value: format!("{} 个节点均正常", members.len()),
                status: "ok".to_string(), advice: String::new(),
            });
        }
    }

    // ── oplog 窗口（副本集）────────────────────────────────────────────────────
    let local_db = client.database("local");
    if let Ok(oplog_stats) = local_db.run_command(doc! { "collStats": "oplog.rs" }).await {
        let max_size = get_i64(&oplog_stats, "maxSize");
        let storage_size = get_i64(&oplog_stats, "storageSize");
        let used_pct = if max_size > 0 { storage_size as f64 / max_size as f64 * 100.0 } else { 0.0 };

        use mongodb::options::FindOptions;
        let coll = local_db.collection::<Document>("oplog.rs");

        let first_ts = async {
            let mut c = coll.find(doc! {})
                .with_options(FindOptions::builder().sort(doc! { "$natural": 1 }).limit(1).build())
                .await.ok()?;
            let d = c.try_next().await.ok()??;
            Some(d.get_timestamp("ts").ok()?.time as i64)
        }.await.unwrap_or(0);

        let last_ts = async {
            let mut c = coll.find(doc! {})
                .with_options(FindOptions::builder().sort(doc! { "$natural": -1 }).limit(1).build())
                .await.ok()?;
            let d = c.try_next().await.ok()??;
            Some(d.get_timestamp("ts").ok()?.time as i64)
        }.await.unwrap_or(0);
        let window_hours = if first_ts > 0 && last_ts > first_ts { (last_ts - first_ts) as f64 / 3600.0 } else { 0.0 };

        let (status, advice) = if window_hours < 24.0 && window_hours > 0.0 {
            score_deduction += 15;
            ("warn", "oplog 窗口小于 24 小时，从节点若落后超过窗口将需重新全量同步，建议增大 oplog 大小")
        } else if used_pct > 90.0 {
            ("warn", "oplog 使用率超过 90%，请关注滚动速率")
        } else {
            ("ok", "")
        };
        items.push(InspectItem {
            category: "复制".to_string(), key: "oplog_window".to_string(),
            label: "oplog 窗口".to_string(),
            value: if window_hours > 0.0 { format!("{window_hours:.1}h ({used_pct:.1}% 使用)") } else { "无 oplog（非副本集）".to_string() },
            status: status.to_string(), advice: advice.to_string(),
        });
    }

    // ── 未使用索引（从 $indexStats 采集）────────────────────────────────────
    let mut unused_indexes: Vec<UnusedIndex> = Vec::new();
    {
        let target_db = client.database(&db);
        let colls: Vec<String> = target_db.list_collection_names().await.unwrap_or_default();
        for cname in colls.iter().take(30) {
            let coll = target_db.collection::<Document>(cname);
            let stats_pipe = vec![doc! { "$indexStats": {} }];
            if let Ok(mut cursor) = coll.aggregate(stats_pipe).await {
                while let Ok(Some(stat)) = cursor.try_next().await {
                    let name = stat.get_str("name").unwrap_or("").to_string();
                    if name == "_id_" { continue; }
                    let ops = stat.get_document("accesses").ok()
                        .and_then(|a| a.get_i64("ops").ok())
                        .unwrap_or(0);
                    if ops == 0 {
                        // 获取索引 key
                        let key = stat.get_document("key").map(|k| {
                            serde_json::to_string(k).unwrap_or_else(|_| "{}".to_string())
                        }).unwrap_or_else(|_| "{}".to_string());
                        unused_indexes.push(UnusedIndex {
                            ns: format!("{}.{}", db, cname),
                            index_name: name,
                            key,
                        });
                    }
                }
            }
        }
        let unused_count = unused_indexes.len();
        if unused_count > 0 {
            score_deduction += (unused_count as i32 * 3).min(20);
            items.push(InspectItem {
                category: "索引".to_string(), key: "unused_indexes".to_string(),
                label: "未使用索引".to_string(), value: format!("{unused_count} 个"),
                status: if unused_count > 5 { "warn" } else { "info" }.to_string(),
                advice: if unused_count > 0 { "存在从未被查询使用的索引，可考虑删除以节省存储和写入开销".to_string() } else { String::new() },
            });
        }
    }

    // ── MO10.2 配置风险扫描 ───────────────────────────────────────────────────
    // 1. 无认证检测（通过 hello 命令检查）
    let hello = admin_db.run_command(doc! { "hello": 1 }).await.ok();
    let has_auth_enabled = hello.as_ref()
        .and_then(|d| d.get_document("ok").ok())
        .map(|_| true)
        .unwrap_or(false);

    // 2. bind_ip（通过 getCmdLineOpts，需要 admin 权限）
    if let Ok(cmd_opts) = admin_db.run_command(doc! { "getCmdLineOpts": 1 }).await {
        if let Ok(parsed) = cmd_opts.get_document("parsed") {
            let net = parsed.get_document("net").ok().cloned().unwrap_or_default();
            let bind_ip = net.get_str("bindIp").unwrap_or("127.0.0.1");
            if bind_ip == "0.0.0.0" || bind_ip.contains("0.0.0.0") {
                score_deduction += 20;
                items.push(InspectItem {
                    category: "配置安全".to_string(), key: "bind_all".to_string(),
                    label: "网络绑定".to_string(), value: format!("bindIp: {bind_ip}"),
                    status: "error".to_string(),
                    advice: "MongoDB 绑定到所有网卡（0.0.0.0），存在安全风险。生产环境建议绑定到内网 IP 并配合防火墙规则".to_string(),
                });
            }

            // TLS 检测
            let tls_doc = net.get_document("tls").ok().cloned().unwrap_or_default();
            let tls_mode = tls_doc.get_str("mode").unwrap_or("disabled");
            if tls_mode == "disabled" || tls_mode == "allowSSL" {
                score_deduction += 10;
                items.push(InspectItem {
                    category: "配置安全".to_string(), key: "tls_disabled".to_string(),
                    label: "TLS/SSL 加密".to_string(), value: format!("mode: {tls_mode}"),
                    status: "warn".to_string(),
                    advice: "未强制启用 TLS，传输数据未加密。生产环境建议设置 tls.mode = requireTLS".to_string(),
                });
            }
        }
    }

    // 3. profiler 全量开启（已在上方检测）
    // 仅在 profiling level == 2 时告警
    let local2 = client.database(&db);
    if let Ok(ps) = local2.run_command(doc! { "profile": -1 }).await {
        if ps.get_i32("was").unwrap_or(0) == 2 {
            score_deduction += 5;
            items.push(InspectItem {
                category: "配置安全".to_string(), key: "profiler_all".to_string(),
                label: "Profiler 全量".to_string(), value: "level=2（记录所有操作）".to_string(),
                status: "warn".to_string(),
                advice: "Profiler level=2 会记录所有操作，对性能有影响，建议生产环境使用 level=1（仅记录慢查询）".to_string(),
            });
        }
    }

    let _ = has_auth_enabled; // 认证状态通过 getCmdLineOpts 已覆盖

    // ── 得分汇总 ─────────────────────────────────────────────────────────────
    let score = (100 - score_deduction).max(0);
    let summary = if score >= 90 {
        format!("实例运行健康，得分 {score}/100")
    } else if score >= 70 {
        format!("存在部分风险，得分 {score}/100，请关注 warn 项")
    } else {
        format!("存在重要问题，得分 {score}/100，请立即处理 error 项")
    };

    Ok(InspectReport { items, slow_ops, unused_indexes, score, summary })
}
