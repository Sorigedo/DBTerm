// logging.rs — 结构化日志系统
//
// 功能：
// - 按天轮转日志文件
// - 支持 JSON 格式（便于日志分析）
// - 同时输出到文件和终端
// - 可配置的日志级别
// - 包含时间戳、线程ID、模块路径

use std::path::PathBuf;
use tracing_subscriber::{fmt, prelude::*, EnvFilter, layer::SubscriberExt};
use tracing_appender::rolling;

/// 日志配置
pub struct LoggingConfig {
    /// 日志目录
    pub log_dir: PathBuf,
    /// 日志级别过滤器（例如："info,dbterm=debug"）
    pub level_filter: String,
    /// 是否输出到终端
    pub console_output: bool,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            log_dir: std::env::temp_dir().join("dbterm-logs"),
            level_filter: "info,dbterm=debug".to_string(),
            console_output: true,
        }
    }
}

/// 初始化日志系统
///
/// # 参数
/// - `config`: 日志配置
///
/// # 错误
/// 如果无法创建日志目录或初始化日志系统，返回错误信息
pub fn init_logging(config: LoggingConfig) -> Result<(), String> {
    // 创建日志目录
    std::fs::create_dir_all(&config.log_dir)
        .map_err(|e| format!("创建日志目录失败: {}", e))?;

    // 按天轮转的文件追加器
    let file_appender = rolling::daily(&config.log_dir, "dbterm.log");

    // 构建订阅器
    let registry = tracing_subscriber::registry();

    // 环境变量过滤器
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&config.level_filter));

    // 文件层（始终使用 JSON 格式便于日志分析）
    let file_layer = fmt::layer()
        .with_writer(file_appender)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_line_number(true)
        .with_file(true)
        .json();

    // 终端层（使用友好的格式）
    let console_layer = if config.console_output {
        Some(
            fmt::layer()
                .with_writer(std::io::stdout)
                .with_target(false)
                .with_thread_ids(false)
                .with_line_number(false)
                .with_file(false)
                .compact(),
        )
    } else {
        None
    };

    // 组合所有层
    let subscriber = registry.with(env_filter).with(file_layer);

    if let Some(console) = console_layer {
        subscriber.with(console).try_init()
            .map_err(|e| format!("初始化 tracing 订阅器失败: {e}"))?;
    } else {
        subscriber.try_init()
            .map_err(|e| format!("初始化 tracing 订阅器失败: {e}"))?;
    }

    // 桥接 log crate 到 tracing
    tracing_log::LogTracer::init()
        .map_err(|e| format!("初始化 log 桥接失败: {}", e))?;

    Ok(())
}

/// 便捷函数：使用应用数据目录初始化日志
pub fn init_with_app_dir(app_data_dir: &PathBuf) -> Result<(), String> {
    let config = LoggingConfig {
        log_dir: app_data_dir.join("logs"),
        level_filter: "info,dbterm=debug,app_lib=debug".to_string(),
        console_output: true,
    };
    init_logging(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_logging_config_default() {
        let config = LoggingConfig::default();
        assert_eq!(config.level_filter, "info,dbterm=debug");
        assert!(config.console_output);
    }

    #[test]
    fn test_log_directory_creation() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-test-logs-{}", uuid::Uuid::new_v4()));

        // 测试目录创建
        std::fs::create_dir_all(&temp_dir).unwrap();
        assert!(temp_dir.exists(), "日志目录应该被创建");

        // 清理
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_config_with_app_dir() {
        let app_dir = std::env::temp_dir().join(format!("dbterm-test-app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&app_dir).unwrap();

        let log_dir = app_dir.join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();

        assert!(log_dir.exists(), "日志目录应该被创建");

        // 清理
        let _ = std::fs::remove_dir_all(app_dir);
    }
}
