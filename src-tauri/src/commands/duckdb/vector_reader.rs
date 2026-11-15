//! Read the documented flat vector representation. Never mix chunk access with
//! the legacy result API: its VARCHAR conversion uses strlen and loses NULs.
use super::*;

#[repr(C)]
#[derive(Clone, Copy)]
struct Huge { lower: u64, upper: i64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct UHuge { lower: u64, upper: u64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Decimal { width: u8, scale: u8, value: Huge }
#[repr(C)]
#[derive(Clone, Copy)]
struct Interval { months: i32, days: i32, micros: i64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Date { days: i32 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Time { micros: i64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct TimeTz { bits: u64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct StringSlot { length: u32, prefix: [u8; 4], tail: u64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct ListEntry { offset: u64, length: u64 }
#[repr(C)]
struct Bit { data: *const u8, size: u64 }

type Destroy = unsafe extern "C" fn(*mut *mut c_void);
struct Owned { pointer: *mut c_void, destroy: Destroy }
impl Drop for Owned {
    fn drop(&mut self) { if !self.pointer.is_null() { unsafe { (self.destroy)(&mut self.pointer); } } }
}

struct Api<'a> { library: &'a Library, symbols: HashMap<&'static [u8], usize> }
impl Api<'_> {
    unsafe fn get<T: Copy>(&mut self, name: &'static [u8]) -> Result<T, String> {
        let pointer = if let Some(pointer) = self.symbols.get(name) { *pointer } else {
            let pointer = *self.library.get::<usize>(name).map_err(|e| format!("DuckDB 向量接口不可用: {e}"))?;
            self.symbols.insert(name, pointer);
            pointer
        };
        Ok(std::mem::transmute_copy(&pointer))
    }
    unsafe fn own(&mut self, pointer: *mut c_void, destroy: &'static [u8]) -> Result<Owned, String> {
        if pointer.is_null() { return Err("DuckDB 结果读取失败，未返回部分结果".into()); }
        Ok(Owned { pointer, destroy: self.get(destroy)? })
    }
    unsafe fn kind(&mut self, logical: *mut c_void) -> Result<i32, String> {
        Ok(self.get::<unsafe extern "C" fn(*mut c_void) -> i32>(b"duckdb_get_type_id\0")?(logical))
    }
    unsafe fn vector_type(&mut self, vector: *mut c_void) -> Result<Owned, String> {
        let pointer = self.get::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(b"duckdb_vector_get_column_type\0")?(vector);
        self.own(pointer, b"duckdb_destroy_logical_type\0")
    }
    unsafe fn data(&mut self, vector: *mut c_void) -> Result<*const u8, String> {
        let pointer = self.get::<unsafe extern "C" fn(*mut c_void) -> *const u8>(b"duckdb_vector_get_data\0")?(vector);
        if pointer.is_null() { return Err("DuckDB 向量数据不可用，未返回部分结果".into()); }
        Ok(pointer)
    }
    unsafe fn valid(&mut self, vector: *mut c_void, row: usize) -> Result<bool, String> {
        let mask = self.get::<unsafe extern "C" fn(*mut c_void) -> *const u64>(b"duckdb_vector_get_validity\0")?(vector);
        Ok(mask.is_null() || (*mask.add(row / 64) & (1u64 << (row % 64))) != 0)
    }
    unsafe fn bytes<'b>(&mut self, vector: *mut c_void, row: usize) -> Result<&'b [u8], String> {
        let slot = self.data(vector)?.cast::<StringSlot>().add(row);
        let length = (*slot).length as usize;
        let data = self.get::<unsafe extern "C" fn(*mut StringSlot) -> *const u8>(b"duckdb_string_t_data\0")?(slot as *mut StringSlot);
        if length == 0 { return Ok(&[]); }
        if data.is_null() || length > isize::MAX as usize { return Err(DuckDecodeBudget::error()); }
        Ok(std::slice::from_raw_parts(data, length))
    }
    unsafe fn value(&mut self, vector: *mut c_void, logical: *mut c_void, row: usize, depth: usize, budget: &mut DuckDecodeBudget) -> Result<Owned, String> {
        if depth > 64 { return Err("DuckDB 嵌套结果超过安全深度，未返回部分结果".into()); }
        if !self.valid(vector, row)? {
            let value = self.get::<unsafe extern "C" fn() -> *mut c_void>(b"duckdb_create_null_value\0")?();
            return self.own(value, b"duckdb_destroy_value\0");
        }
        let kind = self.kind(logical)?;
        macro_rules! scalar {
            ($ty:ty, $name:literal) => {{
                let input = std::ptr::read_unaligned(self.data(vector)?.cast::<$ty>().add(row));
                self.get::<unsafe extern "C" fn($ty) -> *mut c_void>($name)?(input)
            }};
        }
        let value = match kind {
            1 => scalar!(bool, b"duckdb_create_bool\0"),
            2 => scalar!(i8, b"duckdb_create_int8\0"),
            3 => scalar!(i16, b"duckdb_create_int16\0"),
            4 => scalar!(i32, b"duckdb_create_int32\0"),
            5 => scalar!(i64, b"duckdb_create_int64\0"),
            6 => scalar!(u8, b"duckdb_create_uint8\0"),
            7 => scalar!(u16, b"duckdb_create_uint16\0"),
            8 => scalar!(u32, b"duckdb_create_uint32\0"),
            9 => scalar!(u64, b"duckdb_create_uint64\0"),
            10 => scalar!(f32, b"duckdb_create_float\0"),
            11 => scalar!(f64, b"duckdb_create_double\0"),
            12 => scalar!(Time, b"duckdb_create_timestamp\0"),
            13 => scalar!(Date, b"duckdb_create_date\0"),
            14 => scalar!(Time, b"duckdb_create_time\0"),
            15 => scalar!(Interval, b"duckdb_create_interval\0"),
            16 => scalar!(Huge, b"duckdb_create_hugeint\0"),
            20 => scalar!(Time, b"duckdb_create_timestamp_s\0"),
            21 => scalar!(Time, b"duckdb_create_timestamp_ms\0"),
            22 => scalar!(Time, b"duckdb_create_timestamp_ns\0"),
            30 => scalar!(TimeTz, b"duckdb_create_time_tz_value\0"),
            31 => scalar!(Time, b"duckdb_create_timestamp_tz\0"),
            32 => scalar!(UHuge, b"duckdb_create_uhugeint\0"),
            39 => scalar!(Time, b"duckdb_create_time_ns\0"),
            17 => {
                let bytes = self.bytes(vector, row)?;
                budget.charge(bytes.len())?;
                self.get::<unsafe extern "C" fn(*const u8, u64) -> *mut c_void>(b"duckdb_create_varchar_length\0")?(bytes.as_ptr(), bytes.len() as u64)
            }
            18 => {
                let bytes = self.bytes(vector, row)?;
                budget.charge(duck_blob_display_len(bytes.len())?)?;
                self.get::<unsafe extern "C" fn(*const u8, u64) -> *mut c_void>(b"duckdb_create_blob\0")?(bytes.as_ptr(), bytes.len() as u64)
            }
            19 => {
                let width = self.get::<unsafe extern "C" fn(*mut c_void) -> u8>(b"duckdb_decimal_width\0")?(logical);
                let scale = self.get::<unsafe extern "C" fn(*mut c_void) -> u8>(b"duckdb_decimal_scale\0")?(logical);
                let physical = self.get::<unsafe extern "C" fn(*mut c_void) -> i32>(b"duckdb_decimal_internal_type\0")?(logical);
                let data = self.data(vector)?;
                let value = match physical {
                    3 => std::ptr::read_unaligned(data.cast::<i16>().add(row)) as i128,
                    4 => std::ptr::read_unaligned(data.cast::<i32>().add(row)) as i128,
                    5 => std::ptr::read_unaligned(data.cast::<i64>().add(row)) as i128,
                    16 => std::ptr::read_unaligned(data.cast::<i128>().add(row)),
                    _ => return Err("DuckDB DECIMAL 存储类型不可用".into()),
                };
                self.get::<unsafe extern "C" fn(Decimal) -> *mut c_void>(b"duckdb_create_decimal\0")?(Decimal { width, scale, value: Huge { lower: value as u64, upper: (value >> 64) as i64 } })
            }
            23 => {
                let physical = self.get::<unsafe extern "C" fn(*mut c_void) -> i32>(b"duckdb_enum_internal_type\0")?(logical);
                let data = self.data(vector)?;
                let index = match physical {
                    6 => *data.add(row) as u64,
                    7 => std::ptr::read_unaligned(data.cast::<u16>().add(row)) as u64,
                    8 => std::ptr::read_unaligned(data.cast::<u32>().add(row)) as u64,
                    _ => return Err("DuckDB ENUM 存储类型不可用".into()),
                };
                self.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_create_enum_value\0")?(logical, index)
            }
            27 => {
                let raw = std::ptr::read_unaligned(self.data(vector)?.cast::<UHuge>().add(row));
                self.get::<unsafe extern "C" fn(UHuge) -> *mut c_void>(b"duckdb_create_uuid\0")?(UHuge { lower: raw.lower, upper: raw.upper ^ (1u64 << 63) })
            }
            24 | 33 => {
                let child = self.get::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(if kind == 24 { b"duckdb_list_vector_get_child\0" } else { b"duckdb_array_vector_get_child\0" })?(vector);
                let child_type = self.vector_type(child)?;
                let (offset, length) = if kind == 24 {
                    let entry = std::ptr::read_unaligned(self.data(vector)?.cast::<ListEntry>().add(row));
                    let total = self.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_list_vector_get_size\0")?(vector);
                    if entry.offset.checked_add(entry.length).filter(|end| *end <= total).is_none() { return Err("DuckDB LIST 范围无效".into()); }
                    (entry.offset, entry.length)
                } else {
                    let length = self.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_array_type_array_size\0")?(logical);
                    ((row as u64).checked_mul(length).ok_or_else(DuckDecodeBudget::error)?, length)
                };
                budget.charge(usize::try_from(length).ok().and_then(|n| n.checked_mul(std::mem::size_of::<Owned>())).ok_or_else(DuckDecodeBudget::error)?)?;
                let mut children = Vec::new();
                for index in offset..offset.checked_add(length).ok_or_else(DuckDecodeBudget::error)? {
                    children.push(self.value(child, child_type.pointer, usize::try_from(index).map_err(|_| DuckDecodeBudget::error())?, depth + 1, budget)?);
                }
                let mut pointers: Vec<_> = children.iter().map(|v| v.pointer).collect();
                self.get::<unsafe extern "C" fn(*mut c_void, *mut *mut c_void, u64) -> *mut c_void>(if kind == 24 { b"duckdb_create_list_value\0" } else { b"duckdb_create_array_value\0" })?(child_type.pointer, pointers.as_mut_ptr(), length)
            }
            25 => {
                let count = self.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_struct_type_child_count\0")?(logical);
                budget.charge(usize::try_from(count).ok().and_then(|n| n.checked_mul(std::mem::size_of::<Owned>())).ok_or_else(DuckDecodeBudget::error)?)?;
                let mut children = Vec::new();
                for index in 0..count {
                    let child = self.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_struct_vector_get_child\0")?(vector, index);
                    let child_type = self.vector_type(child)?;
                    children.push(self.value(child, child_type.pointer, row, depth + 1, budget)?);
                }
                let mut pointers: Vec<_> = children.iter().map(|v| v.pointer).collect();
                self.get::<unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> *mut c_void>(b"duckdb_create_struct_value\0")?(logical, pointers.as_mut_ptr())
            }
            26 => {
                let entry = std::ptr::read_unaligned(self.data(vector)?.cast::<ListEntry>().add(row));
                let total = self.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_list_vector_get_size\0")?(vector);
                if entry.offset.checked_add(entry.length).filter(|end| *end <= total).is_none() { return Err("DuckDB MAP 范围无效".into()); }
                budget.charge(usize::try_from(entry.length).ok().and_then(|n| n.checked_mul(2 * std::mem::size_of::<Owned>())).ok_or_else(DuckDecodeBudget::error)?)?;
                let entries = self.get::<unsafe extern "C" fn(*mut c_void) -> *mut c_void>(b"duckdb_list_vector_get_child\0")?(vector);
                let child = self.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_struct_vector_get_child\0")?;
                let keys = child(entries, 0); let values = child(entries, 1);
                let key_type = self.vector_type(keys)?; let value_type = self.vector_type(values)?;
                let mut key_values = Vec::new(); let mut value_values = Vec::new();
                for index in entry.offset..entry.offset + entry.length {
                    let index = usize::try_from(index).map_err(|_| DuckDecodeBudget::error())?;
                    key_values.push(self.value(keys, key_type.pointer, index, depth + 1, budget)?);
                    value_values.push(self.value(values, value_type.pointer, index, depth + 1, budget)?);
                }
                let mut keys: Vec<_> = key_values.iter().map(|v| v.pointer).collect();
                let mut values: Vec<_> = value_values.iter().map(|v| v.pointer).collect();
                self.get::<unsafe extern "C" fn(*mut c_void, *mut *mut c_void, *mut *mut c_void, u64) -> *mut c_void>(b"duckdb_create_map_value\0")?(logical, keys.as_mut_ptr(), values.as_mut_ptr(), entry.length)
            }
            28 => {
                let child = self.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_struct_vector_get_child\0")?;
                let tag_vector = child(vector, 0);
                let tag = *self.data(tag_vector)?.add(row) as u64;
                let count = self.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_union_type_member_count\0")?(logical);
                if tag >= count { return Err("DuckDB UNION 标签无效".into()); }
                let member = child(vector, tag + 1); let member_type = self.vector_type(member)?;
                let member_value = self.value(member, member_type.pointer, row, depth + 1, budget)?;
                self.get::<unsafe extern "C" fn(*mut c_void, u64, *mut c_void) -> *mut c_void>(b"duckdb_create_union_value\0")?(logical, tag, member_value.pointer)
            }
            29 => {
                let bytes = self.bytes(vector, row)?; budget.charge(bytes.len())?;
                self.get::<unsafe extern "C" fn(Bit) -> *mut c_void>(b"duckdb_create_bit\0")?(Bit { data: bytes.as_ptr(), size: bytes.len() as u64 })
            }
            _ => return Err(format!("DuckDB 结果类型 {kind} 尚无保真解码，未返回部分结果；请显式转换所需列类型")),
        };
        self.own(value, b"duckdb_destroy_value\0")
    }
}

unsafe fn format_column(api: &mut Api<'_>, state: &DuckConnState, vector: *mut c_void, logical: *mut c_void, count: usize, formatter: &mut Option<Owned>, budget: &mut DuckDecodeBudget) -> Result<Vec<Option<String>>, String> {
    budget.charge(count.checked_mul(std::mem::size_of::<Owned>()).ok_or_else(DuckDecodeBudget::error)?)?;
    let mut values = Vec::new();
    for row in 0..count { values.push(api.value(vector, logical, row, 0, budget)?); }
    let mut pointers: Vec<_> = values.iter().map(|value| value.pointer).collect();
    let pointer = api.get::<unsafe extern "C" fn(*mut c_void, *mut *mut c_void, u64) -> *mut c_void>(b"duckdb_create_list_value\0")?(logical, pointers.as_mut_ptr(), count as u64);
    let list = api.own(pointer, b"duckdb_destroy_value\0")?;
    if formatter.is_none() {
        let destroy = api.get::<Destroy>(b"duckdb_destroy_prepare\0")?;
        let mut pointer = std::ptr::null_mut();
        let status = api.get::<unsafe extern "C" fn(*mut c_void, *const c_char, *mut *mut c_void) -> i32>(b"duckdb_prepare\0")?(state.conn, c"SELECT CAST(unnest($1) AS VARCHAR)".as_ptr(), &mut pointer);
        let statement = Owned { pointer, destroy };
        if status != 0 || pointer.is_null() { return Err("DuckDB 值格式化准备失败，未返回部分结果".into()); }
        *formatter = Some(statement);
    }
    let statement = formatter.as_ref().unwrap().pointer;
    if api.get::<unsafe extern "C" fn(*mut c_void, u64, *mut c_void) -> i32>(b"duckdb_bind_value\0")?(statement, 1, list.pointer) != 0 { return Err("DuckDB 值格式化绑定失败".into()); }
    let execute = api.get::<unsafe extern "C" fn(*mut c_void, *mut DuckRawResult) -> i32>(b"duckdb_execute_prepared\0")?;
    let mut rendered = DuckRawResult::zeroed();
    let status = execute(statement, &mut rendered);
    let formatted = (|| -> Result<Vec<Option<String>>, String> {
        if status != 0 { return Err("DuckDB 值格式化失败，未返回部分结果".into()); }
        let chunks = api.get::<unsafe extern "C" fn(DuckRawResult) -> u64>(b"duckdb_result_chunk_count\0")?(std::ptr::read(&rendered));
        let mut output = Vec::new();
        for index in 0..chunks {
            let pointer = api.get::<unsafe extern "C" fn(DuckRawResult, u64) -> *mut c_void>(b"duckdb_result_get_chunk\0")?(std::ptr::read(&rendered), index);
            let chunk = api.own(pointer, b"duckdb_destroy_data_chunk\0")?;
            let size = api.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_data_chunk_get_size\0")?(chunk.pointer);
            let vector = api.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_data_chunk_get_vector\0")?(chunk.pointer, 0);
            if vector.is_null() { return Err("DuckDB 格式化结果列读取失败".into()); }
            for row in 0..usize::try_from(size).map_err(|_| DuckDecodeBudget::error())? {
                if output.len() >= count { return Err("DuckDB 格式化结果行数不一致".into()); }
                if !api.valid(vector, row)? { budget.cell(0)?; output.push(None); continue; }
                let bytes = api.bytes(vector, row)?;
                budget.cell(lossy_utf8_len(bytes)?)?;
                output.push(Some(String::from_utf8_lossy(bytes).into_owned()));
            }
        }
        if output.len() != count { return Err("DuckDB 格式化结果行数不一致".into()); }
        Ok(output)
    })();
    (state.fns.destroy_result)(&mut rendered);
    // Drop bound copies promptly instead of retaining the previous chunk's values.
    let cleared = api.get::<unsafe extern "C" fn(*mut c_void) -> i32>(b"duckdb_clear_bindings\0")?(statement);
    if cleared != 0 { return Err("DuckDB 格式化参数释放失败".into()); }
    formatted
}

pub(super) unsafe fn decode(state: &DuckConnState, result: &mut DuckRawResult, columns: usize, take: usize) -> Result<Vec<Vec<Option<String>>>, String> {
    let mut api = Api { library: &state._lib, symbols: HashMap::new() };
    // Resolve destructors before allocating native objects, including error paths.
    api.get::<Destroy>(b"duckdb_destroy_data_chunk\0")?;
    api.get::<Destroy>(b"duckdb_destroy_logical_type\0")?;
    api.get::<Destroy>(b"duckdb_destroy_value\0")?;
    let chunk_count = api.get::<unsafe extern "C" fn(DuckRawResult) -> u64>(b"duckdb_result_chunk_count\0")?(std::ptr::read(result));
    let mut rows = Vec::new();
    let mut budget = DuckDecodeBudget::default();
    let mut formatter: Option<Owned> = None;
    'chunks: for chunk_index in 0..chunk_count {
        if rows.len() >= take { break; }
        let pointer = api.get::<unsafe extern "C" fn(DuckRawResult, u64) -> *mut c_void>(b"duckdb_result_get_chunk\0")?(std::ptr::read(result), chunk_index);
        let chunk = api.own(pointer, b"duckdb_destroy_data_chunk\0")?;
        let count = api.get::<unsafe extern "C" fn(*mut c_void) -> u64>(b"duckdb_data_chunk_get_size\0")?(chunk.pointer);
        let mut vectors = Vec::new();
        for column in 0..columns {
            let vector = api.get::<unsafe extern "C" fn(*mut c_void, u64) -> *mut c_void>(b"duckdb_data_chunk_get_vector\0")?(chunk.pointer, column as u64);
            if vector.is_null() { return Err("DuckDB 结果列读取失败".into()); }
            vectors.push((vector, api.vector_type(vector)?));
        }
        let count = usize::try_from(count).map_err(|_| DuckDecodeBudget::error())?.min(take.saturating_sub(rows.len()));
        let mut formatted_columns = Vec::new();
        for (vector, logical) in &vectors {
            let kind = api.kind(logical.pointer)?;
            formatted_columns.push(if matches!(kind, 24 | 25 | 26 | 28 | 31 | 33) {
                Some(format_column(&mut api, state, *vector, logical.pointer, count, &mut formatter, &mut budget)?)
            } else { None });
        }
        for row_index in 0..count {
            if rows.len() >= take { break 'chunks; }
            budget.start_row()?;
            let mut row = Vec::new();
            for (column_index, (vector, logical)) in vectors.iter().enumerate() {
                if let Some(formatted) = &mut formatted_columns[column_index] {
                    row.push(formatted[row_index].take());
                    continue;
                }
                if !api.valid(*vector, row_index)? { budget.cell(0)?; row.push(None); continue; }
                let kind = api.kind(logical.pointer)?;
                let text = if kind == 17 || kind == 18 {
                    let bytes = api.bytes(*vector, row_index)?;
                    if kind == 18 { budget.cell(duck_blob_display_len(bytes.len())?)?; encode_blob_display(bytes)? }
                    else { budget.cell(lossy_utf8_len(bytes)?)?; String::from_utf8_lossy(bytes).into_owned() }
                } else {
                    // Reconstruction and rendered output are both charged. Never silently
                    // turn an unsupported or failed non-NULL conversion into SQL NULL.
                    budget.cell(0)?;
                    let value = api.value(*vector, logical.pointer, row_index, 0, &mut budget)?;
                    let pointer = api.get::<unsafe extern "C" fn(*mut c_void) -> *mut c_char>(b"duckdb_get_varchar\0")?(value.pointer);
                    let allocation = DuckAllocation { pointer: pointer as *mut c_void, free: state.fns.free };
                    if allocation.pointer.is_null() { return Err("DuckDB 值转换失败，未返回部分结果".into()); }
                    let bytes = CStr::from_ptr(pointer).to_bytes();
                    budget.charge(bytes.len())?;
                    String::from_utf8_lossy(bytes).into_owned()
                };
                row.push(Some(text));
            }
            rows.push(row);
        }
    }
    if rows.len() != take { return Err("DuckDB 结果行数不一致，未返回部分结果".into()); }
    Ok(rows)
}
