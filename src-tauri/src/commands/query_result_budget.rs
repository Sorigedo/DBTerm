//! Bound decoded interactive results; full exports use separate streaming commands.
pub(crate) const MAX_RESULT_ROWS: usize = 100_000;
pub(crate) const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct ResultBudget {
    rows: usize,
    bytes: usize,
    max_rows: usize,
    max_bytes: usize,
}

impl Default for ResultBudget {
    fn default() -> Self {
        Self { rows: 0, bytes: 0, max_rows: MAX_RESULT_ROWS, max_bytes: MAX_RESULT_BYTES }
    }
}

impl ResultBudget {
    fn error() -> String {
        "查询结果超过内存安全上限（100000 行或 32 MiB），已停止读取，未返回部分结果。请使用 WHERE / LIMIT 缩小范围，或使用流式导出。".to_string()
    }

    pub(crate) fn start_row(&mut self) -> Result<(), String> {
        self.rows += 1;
        self.charge(std::mem::size_of::<Vec<Option<String>>>())
    }

    pub(crate) fn cell(&mut self, value: Option<&str>) -> Result<(), String> {
        self.charge(std::mem::size_of::<Option<String>>() + value.map_or(0, str::len))
    }

    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.rows > self.max_rows || self.bytes > self.max_bytes {
            return Err(Self::error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_first_row_beyond_limit() {
        let mut budget = ResultBudget { max_rows: 2, ..ResultBudget::default() };
        assert!(budget.start_row().is_ok());
        assert!(budget.start_row().is_ok());
        assert!(budget.start_row().unwrap_err().contains("未返回部分结果"));
    }

    #[test]
    fn includes_utf8_and_null_cell_overhead_in_memory_budget() {
        let overhead = std::mem::size_of::<Vec<Option<String>>>() + std::mem::size_of::<Option<String>>();
        let mut budget = ResultBudget { max_bytes: overhead + "中文".len(), ..ResultBudget::default() };
        assert!(budget.start_row().is_ok());
        assert!(budget.cell(Some("中文")).is_ok());
        assert!(budget.cell(None).unwrap_err().contains("32 MiB"));
    }
}
