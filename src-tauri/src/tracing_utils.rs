#![allow(dead_code)]

// tracing_utils.rs — Tracing 辅助工具
//
// 提供常用的 tracing 工具函数和宏

use std::time::Instant;
use tracing::{info, warn, error, debug};

/// 记录操作的执行时间
pub struct Timer {
    operation: String,
    start: Instant,
    finished: bool,
}

impl Timer {
    /// 创建新的计时器
    pub fn new(operation: impl Into<String>) -> Self {
        let operation = operation.into();
        debug!("开始操作: {}", operation);
        Self {
            operation,
            start: Instant::now(),
            finished: false,
        }
    }

    /// 记录成功完成
    pub fn success(mut self) {
        self.finished = true;
        let duration = self.start.elapsed();
        info!(
            operation = %self.operation,
            duration_ms = duration.as_millis() as u64,
            "操作成功完成"
        );
    }

    /// 记录失败
    pub fn failure(mut self, error: &str) {
        self.finished = true;
        let duration = self.start.elapsed();
        error!(
            operation = %self.operation,
            duration_ms = duration.as_millis() as u64,
            error = %error,
            "操作失败"
        );
    }

    /// 记录警告
    pub fn warning(mut self, message: &str) {
        self.finished = true;
        let duration = self.start.elapsed();
        warn!(
            operation = %self.operation,
            duration_ms = duration.as_millis() as u64,
            message = %message,
            "操作完成但有警告"
        );
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if self.finished { return }
        // Production call sites keep the timer in a local (`let _timer = ...`)
        // and return through many `?` paths.  Drop guarantees every path gets
        // a completion/latency record without requiring duplicated plumbing.
        info!(
            operation = %self.operation,
            duration_ms = self.start.elapsed().as_millis() as u64,
            "操作完成"
        );
    }
}

/// 为结果添加 tracing 支持
pub trait TracedResult<T, E> {
    /// 在成功时记录日志
    fn trace_ok(self, operation: &str) -> Result<T, E>;

    /// 在失败时记录日志
    fn trace_err(self, operation: &str) -> Result<T, E>;
}

impl<T, E: std::fmt::Display> TracedResult<T, E> for Result<T, E> {
    fn trace_ok(self, operation: &str) -> Result<T, E> {
        if self.is_ok() {
            info!(operation = %operation, "操作成功");
        }
        self
    }

    fn trace_err(self, operation: &str) -> Result<T, E> {
        if let Err(e) = &self {
            error!(operation = %operation, error = %e, "操作失败");
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timer_success() {
        let timer = Timer::new("test_operation");
        std::thread::sleep(std::time::Duration::from_millis(10));
        timer.success();
    }

    #[test]
    fn test_timer_failure() {
        let timer = Timer::new("test_operation");
        timer.failure("测试错误");
    }

    #[test]
    fn test_traced_result_ok() {
        let result: Result<i32, String> = Ok(42);
        let traced = result.trace_ok("测试操作");
        assert_eq!(traced.unwrap(), 42);
    }

    #[test]
    fn test_traced_result_err() {
        let result: Result<i32, String> = Err("错误".to_string());
        let traced = result.trace_err("测试操作");
        assert!(traced.is_err());
    }
}
