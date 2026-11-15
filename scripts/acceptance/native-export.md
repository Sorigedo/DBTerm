# 原生导出命令验收

在项目根目录执行（当前已验收 macOS arm64、MySQL 8.4.11）：

```bash
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --offline --example export_acceptance
python3 scripts/acceptance/native-export.py
```

默认 MySQL 二进制目录为 `/opt/homebrew/opt/mysql@8.4/bin`，可通过 `DBTERM_MYSQL_BIN` 指定。需要可运行图形应用的桌面会话；示例程序单独构建，不进入正常应用或发行包。

驱动在系统临时目录创建 `dbterm-native-export-*`，初始化独立数据目录、随机回环端口MySQL及独立连接/密码目录。它启动本地只读静态文件服务提供现有 `dist`，打开真实 Tauri Wry/WKWebView，并注入验收脚本，通过真实IPC调用生产命令。验收程序不运行正常应用初始化，不读取已保存连接。所有写数据库、删除重建数据库操作仅针对其启动的临时实例。程序和服务在结束或失败时关闭，临时目录保留回执、导出文件和日志，便于审查。

覆盖：

- `get_table_ddl` 与独立mysql客户端读取的完整DDL一致。
- `execute_query` 经真实IPC执行新增列、重命名、改默认值、显式完整列定义修改、删除列；每一步与独立客户端对照表的SHOW CREATE一致。临时服务器查询日志确认ALTER内容保持不变，失败多动作ALTER不留部分变更，原有字段值保留。
- `db_logical_backup` 的结构、结构加数据完整文件回放；库级默认字符集/排序规则、表DDL与精确数据核对。
- `db_stream_export` 的SQL文件完整回放，含显式序号/位图投影的ENUM/SET。
- NUL文本、空BLOB、NULL、64位无符号边界、DECIMAL、BIT、不可见列及生成列。
- 回放后调用者SQL_MODE/TIME_ZONE恢复。
- 查询执行失败不覆盖旧导出文件、不留part文件、取消任务登记释放后同任务ID可重用。

结果以Python退出码、`receipt.json` 和全部独立回放断言共同判断，不能仅看GUI进程退出码。

边界：这是独立验收程序里的真实Tauri IPC和生产命令，覆盖DDL提交后端链路；不是完整编辑界面点击、生产打包程序或全部数据库版本认证。失败多动作ALTER验证仅适用于此次MySQL8.4/InnoDB，不能推导多条DDL可事务回滚。临时库无并发写入，不能据此宣称备份具备跨表或跨服务器全局一致快照。
