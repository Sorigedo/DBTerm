#![allow(dead_code)]

//! # Connection Pool Manager
//!
//! Generic connection pool manager with lifecycle management, health checks,
//! and automatic cleanup for database connections.
//!
//! ## Features
//!
//! - **Lifecycle Management** - Automatic expiration based on idle and total lifetime
//! - **Health Checks** - Periodic validation of pooled connections
//! - **Background Cleanup** - Automatic removal of expired/unhealthy connections
//! - **Connection Statistics** - Monitoring of pool size, usage, and health
//!
//! ## Usage
//!
//! ```rust,ignore
//! use pool_manager::{PoolManager, PoolConfig};
//! use std::time::Duration;
//!
//! let config = PoolConfig {
//!     max_idle_time: Duration::from_secs(300),    // 5 minutes
//!     max_lifetime: Duration::from_secs(3600),    // 1 hour
//!     health_check_interval: Duration::from_secs(60),
//! };
//!
//! let manager = PoolManager::new(config);
//! manager.add_connection("conn-1", my_connection).await;
//! let conn = manager.get_connection("conn-1").await;
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// Connection pool configuration
///
/// Defines lifecycle timeouts and health check intervals for pooled connections.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Maximum idle time before connection is cleaned up
    pub max_idle_time: Duration,
    /// Maximum total lifetime of a connection since creation
    pub max_lifetime: Duration,
    /// Interval between health checks
    pub health_check_interval: Duration,
}

impl Default for PoolConfig {
    /// Default configuration:
    /// - Max idle time: 5 minutes
    /// - Max lifetime: 1 hour
    /// - Health check interval: 1 minute
    fn default() -> Self {
        Self {
            max_idle_time: Duration::from_secs(300),      // 5 分钟
            max_lifetime: Duration::from_secs(3600),      // 1 小时
            health_check_interval: Duration::from_secs(60), // 1 分钟
        }
    }
}

/// Connection health status
///
/// Indicates the health of a pooled connection for monitoring and cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    /// Connection is healthy and fully functional
    Healthy,
    /// Connection has warnings but is still usable
    Degraded,
    /// Connection is unhealthy and should be removed
    Unhealthy,
}

/// Pooled connection entry with metadata
///
/// Tracks creation time, last access, and usage statistics for lifecycle management.
pub struct PoolEntry<T> {
    /// Connection instance
    pub conn: T,
    /// Creation timestamp
    pub created_at: Instant,
    /// 最后使用时间
    pub last_used: Instant,
    /// 最后健康检查时间
    pub last_health_check: Instant,
    /// 健康状态
    pub health_status: HealthStatus,
}

impl<T> PoolEntry<T> {
    fn new(conn: T) -> Self {
        let now = Instant::now();
        Self {
            conn,
            created_at: now,
            last_used: now,
            last_health_check: now,
            health_status: HealthStatus::Healthy,
        }
    }

    /// 更新最后使用时间
    fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    /// 检查是否超过最大存活时间
    fn is_expired(&self, max_lifetime: Duration) -> bool {
        Instant::now().duration_since(self.created_at) > max_lifetime
    }

    /// 检查是否闲置超时
    fn is_idle(&self, max_idle_time: Duration) -> bool {
        Instant::now().duration_since(self.last_used) > max_idle_time
    }
}

/// 通用连接池管理器
pub struct PoolManager<T> {
    pool: Arc<RwLock<HashMap<String, PoolEntry<T>>>>,
    config: PoolConfig,
}

impl<T> PoolManager<T>
where
    T: Clone,
{
    /// 创建新的连接池管理器
    pub fn new(config: PoolConfig) -> Self {
        Self {
            pool: Arc::new(RwLock::new(HashMap::new())),
            config,
        }
    }

    /// 使用默认配置创建连接池管理器
    pub fn with_default_config() -> Self {
        Self::new(PoolConfig::default())
    }

    /// 获取或创建连接
    ///
    /// # 参数
    /// - `key`: 连接标识符（通常是连接 ID）
    /// - `factory`: 连接工厂函数，当需要创建新连接时调用
    ///
    /// # 返回
    /// - `Ok(T)`: 连接实例（可能是池中已有的，也可能是新创建的）
    /// - `Err(E)`: 创建连接失败时返回的错误
    pub async fn get_or_create<F, E>(&self, key: &str, factory: F) -> Result<T, E>
    where
        F: FnOnce() -> Result<T, E>,
    {
        // 1. 尝试从池中获取现有连接
        {
            let mut pool = self.pool.write().await;
            if let Some(entry) = pool.get_mut(key) {
                let _now = Instant::now();

                // 检查连接是否过期
                if entry.is_expired(self.config.max_lifetime) {
                    log::info!("连接已过期，移除: {}", key);
                    pool.remove(key);
                } else if entry.health_status == HealthStatus::Unhealthy {
                    log::warn!("连接不健康，移除: {}", key);
                    pool.remove(key);
                } else {
                    // 连接可用，更新使用时间并返回
                    entry.touch();
                    log::debug!("从池中获取连接: {}", key);
                    return Ok(entry.conn.clone());
                }
            }
        }

        // 2. 池中没有可用连接，创建新连接
        log::info!("创建新连接: {}", key);
        let conn = factory()?;

        // 3. 将新连接加入池中
        {
            let mut pool = self.pool.write().await;
            pool.insert(key.to_string(), PoolEntry::new(conn.clone()));
        }

        Ok(conn)
    }

    /// 从池中移除指定连接
    pub async fn remove(&self, key: &str) {
        let mut pool = self.pool.write().await;
        if pool.remove(key).is_some() {
            log::info!("从池中移除连接: {}", key);
        }
    }

    /// 清理闲置和过期的连接
    pub async fn cleanup_idle(&self) {
        let mut pool = self.pool.write().await;
        let now = Instant::now();

        let mut removed_keys = Vec::new();

        for (key, entry) in pool.iter() {
            // 检查是否过期
            if entry.is_expired(self.config.max_lifetime) {
                let age = now.duration_since(entry.created_at);
                log::info!("清理过期连接: {}, 存活时间: {:?}", key, age);
                removed_keys.push(key.clone());
                continue;
            }

            // 检查是否闲置超时
            if entry.is_idle(self.config.max_idle_time) {
                let idle_time = now.duration_since(entry.last_used);
                log::info!("清理闲置连接: {}, 闲置时长: {:?}", key, idle_time);
                removed_keys.push(key.clone());
                continue;
            }

            // 检查健康状态
            if entry.health_status == HealthStatus::Unhealthy {
                log::warn!("清理不健康连接: {}", key);
                removed_keys.push(key.clone());
            }
        }

        // 批量移除
        for key in removed_keys {
            pool.remove(&key);
        }
    }

    /// 执行健康检查
    ///
    /// # 参数
    /// - `check_fn`: 健康检查函数，返回 true 表示健康
    pub async fn health_check<F>(&self, check_fn: F)
    where
        F: Fn(&T) -> bool,
    {
        let mut pool = self.pool.write().await;
        let now = Instant::now();

        for (key, entry) in pool.iter_mut() {
            // 检查是否需要健康检查
            if now.duration_since(entry.last_health_check) < self.config.health_check_interval {
                continue;
            }

            entry.last_health_check = now;

            // 执行健康检查
            let is_healthy = check_fn(&entry.conn);
            let old_status = entry.health_status;

            entry.health_status = if is_healthy {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy
            };

            // 记录状态变化
            if old_status != entry.health_status {
                log::warn!("连接健康状态变化: {} {:?} -> {:?}", key, old_status, entry.health_status);
            }
        }
    }

    /// 获取连接池统计信息
    pub async fn stats(&self) -> PoolStats {
        let pool = self.pool.read().await;
        let now = Instant::now();

        let total = pool.len();
        let healthy = pool.values().filter(|e| e.health_status == HealthStatus::Healthy).count();
        let degraded = pool.values().filter(|e| e.health_status == HealthStatus::Degraded).count();
        let unhealthy = pool.values().filter(|e| e.health_status == HealthStatus::Unhealthy).count();

        let avg_age = if pool.is_empty() {
            Duration::ZERO
        } else {
            let total: Duration = pool.values()
                .map(|e| now.duration_since(e.created_at))
                .sum();
            total / pool.len() as u32
        };

        let avg_idle = if pool.is_empty() {
            Duration::ZERO
        } else {
            let total: Duration = pool.values()
                .map(|e| now.duration_since(e.last_used))
                .sum();
            total / pool.len() as u32
        };

        PoolStats {
            total,
            healthy,
            degraded,
            unhealthy,
            avg_age,
            avg_idle,
        }
    }

    /// 获取所有连接的键
    pub async fn keys(&self) -> Vec<String> {
        let pool = self.pool.read().await;
        pool.keys().cloned().collect()
    }

    /// 清空整个连接池
    pub async fn clear(&self) {
        let mut pool = self.pool.write().await;
        let count = pool.len();
        pool.clear();
        log::info!("清空连接池，移除 {} 个连接", count);
    }
}

/// 连接池统计信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    /// 总连接数
    pub total: usize,
    /// 健康连接数
    pub healthy: usize,
    /// 降级连接数
    pub degraded: usize,
    /// 不健康连接数
    pub unhealthy: usize,
    /// 平均连接年龄
    #[serde(serialize_with = "serialize_duration_ms")]
    pub avg_age: Duration,
    /// 平均闲置时间
    #[serde(serialize_with = "serialize_duration_ms")]
    pub avg_idle: Duration,
}

fn serialize_duration_ms<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_u64(duration.as_millis() as u64)
}

/// 启动后台清理任务
///
/// # 参数
/// - `manager`: 连接池管理器
/// - `interval`: 清理间隔（默认 60 秒）
pub fn start_cleanup_task<T>(manager: Arc<PoolManager<T>>, interval: Duration)
where
    T: Clone + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            manager.cleanup_idle().await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_pool_manager_get_or_create() {
        let manager = PoolManager::with_default_config();

        let conn1 = manager.get_or_create("conn-1", || Ok::<String, String>("connection-1".to_string()))
            .await
            .unwrap();

        assert_eq!(conn1, "connection-1");

        // 再次获取应该返回相同的连接
        let conn2 = manager.get_or_create("conn-1", || Ok::<String, String>("should-not-be-called".to_string()))
            .await
            .unwrap();

        assert_eq!(conn2, "connection-1");
    }

    #[tokio::test]
    async fn test_pool_manager_remove() {
        let manager = PoolManager::with_default_config();

        manager.get_or_create("conn-1", || Ok::<String, String>("connection-1".to_string()))
            .await
            .unwrap();

        assert_eq!(manager.stats().await.total, 1);

        manager.remove("conn-1").await;

        assert_eq!(manager.stats().await.total, 0);
    }

    #[tokio::test]
    async fn test_pool_manager_cleanup_idle() {
        let config = PoolConfig {
            max_idle_time: Duration::from_millis(100),
            max_lifetime: Duration::from_secs(3600),
            health_check_interval: Duration::from_secs(60),
        };

        let manager = PoolManager::new(config);

        manager.get_or_create("conn-1", || Ok::<String, String>("connection-1".to_string()))
            .await
            .unwrap();

        assert_eq!(manager.stats().await.total, 1);

        // 等待超过闲置时间
        tokio::time::sleep(Duration::from_millis(150)).await;

        manager.cleanup_idle().await;

        assert_eq!(manager.stats().await.total, 0);
    }

    #[tokio::test]
    async fn test_pool_manager_health_check() {
        // 使用较短的健康检查间隔
        let config = PoolConfig {
            max_idle_time: Duration::from_secs(300),
            max_lifetime: Duration::from_secs(3600),
            health_check_interval: Duration::from_millis(10),
        };
        let manager = PoolManager::new(config);

        manager.get_or_create("conn-1", || Ok::<i32, String>(1))
            .await
            .unwrap();
        manager.get_or_create("conn-2", || Ok::<i32, String>(2))
            .await
            .unwrap();

        // 等待超过健康检查间隔
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 健康检查：奇数为健康，偶数为不健康
        manager.health_check(|conn| *conn % 2 == 1).await;

        let stats = manager.stats().await;
        assert_eq!(stats.total, 2);
        assert_eq!(stats.healthy, 1, "conn-1 应该健康");
        assert_eq!(stats.unhealthy, 1, "conn-2 应该不健康");
    }

    #[tokio::test]
    async fn test_pool_manager_stats() {
        let manager = PoolManager::with_default_config();

        manager.get_or_create("conn-1", || Ok::<String, String>("c1".to_string()))
            .await
            .unwrap();
        manager.get_or_create("conn-2", || Ok::<String, String>("c2".to_string()))
            .await
            .unwrap();

        let stats = manager.stats().await;
        assert_eq!(stats.total, 2);
        assert_eq!(stats.healthy, 2);
    }

    #[tokio::test]
    async fn test_pool_manager_clear() {
        let manager = PoolManager::with_default_config();

        manager.get_or_create("conn-1", || Ok::<String, String>("c1".to_string()))
            .await
            .unwrap();
        manager.get_or_create("conn-2", || Ok::<String, String>("c2".to_string()))
            .await
            .unwrap();

        assert_eq!(manager.stats().await.total, 2);

        manager.clear().await;

        assert_eq!(manager.stats().await.total, 0);
    }

    #[tokio::test]
    async fn test_pool_manager_degraded_connections() {
        let config = PoolConfig {
            max_idle_time: Duration::from_secs(300),
            max_lifetime: Duration::from_secs(3600),
            health_check_interval: Duration::from_millis(10),
        };
        let manager = PoolManager::new(config);

        manager.get_or_create("conn-1", || Ok::<i32, String>(1)).await.unwrap();
        manager.get_or_create("conn-2", || Ok::<i32, String>(2)).await.unwrap();
        manager.get_or_create("conn-3", || Ok::<i32, String>(3)).await.unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;

        // 1为健康，2为降级，3为不健康
        manager.health_check(|conn| match *conn {
            1 => true,
            3 => false,
            _ => true,  // 2为降级（健康但有问题）
        }).await;

        // 手动设置conn-2为降级状态
        {
            let mut pool = manager.pool.write().await;
            if let Some(entry) = pool.get_mut("conn-2") {
                entry.health_status = HealthStatus::Degraded;
            }
        }

        let stats = manager.stats().await;
        assert_eq!(stats.total, 3);
        assert_eq!(stats.healthy, 1);
        assert_eq!(stats.degraded, 1);
        assert_eq!(stats.unhealthy, 1);
    }

    #[tokio::test]
    async fn test_pool_manager_max_lifetime() {
        let config = PoolConfig {
            max_idle_time: Duration::from_secs(300),
            max_lifetime: Duration::from_millis(100),
            health_check_interval: Duration::from_secs(60),
        };
        let manager = PoolManager::new(config);

        manager.get_or_create("conn-1", || Ok::<String, String>("c1".to_string()))
            .await
            .unwrap();

        assert_eq!(manager.stats().await.total, 1);

        tokio::time::sleep(Duration::from_millis(150)).await;

        manager.cleanup_idle().await;

        assert_eq!(manager.stats().await.total, 0, "连接应该因超过最大生命周期被清理");
    }

    #[tokio::test]
    async fn test_pool_manager_keys() {
        let manager = PoolManager::with_default_config();

        manager.get_or_create("conn-1", || Ok::<String, String>("c1".to_string()))
            .await
            .unwrap();
        manager.get_or_create("conn-2", || Ok::<String, String>("c2".to_string()))
            .await
            .unwrap();

        let keys = manager.keys().await;
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&"conn-1".to_string()));
        assert!(keys.contains(&"conn-2".to_string()));
    }

    #[tokio::test]
    async fn test_pool_manager_concurrent_access() {
        let manager = Arc::new(PoolManager::with_default_config());

        let mut handles = vec![];
        for i in 0..10 {
            let mgr = manager.clone();
            let handle = tokio::spawn(async move {
                let key = format!("conn-{}", i);
                mgr.get_or_create(&key, || Ok::<i32, String>(i))
                    .await
                    .unwrap();
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(manager.stats().await.total, 10);
    }

    #[tokio::test]
    async fn test_pool_manager_stats_empty() {
        let manager = PoolManager::<String>::with_default_config();
        let stats = manager.stats().await;
        assert_eq!(stats.total, 0);
        assert_eq!(stats.healthy, 0);
        assert_eq!(stats.degraded, 0);
        assert_eq!(stats.unhealthy, 0);
        assert_eq!(stats.avg_age, Duration::ZERO);
        assert_eq!(stats.avg_idle, Duration::ZERO);
    }

    #[tokio::test]
    async fn test_pool_manager_avg_age_calculation() {
        let manager = PoolManager::with_default_config();

        manager.get_or_create("conn-1", || Ok::<String, String>("c1".to_string()))
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(100)).await;

        manager.get_or_create("conn-2", || Ok::<String, String>("c2".to_string()))
            .await
            .unwrap();

        let stats = manager.stats().await;
        assert!(stats.avg_age > Duration::from_millis(50), "平均年龄应该大于50ms");
        assert!(stats.avg_age < Duration::from_millis(150), "平均年龄应该小于150ms");
    }
}
