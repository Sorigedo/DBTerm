# 审计交付状态（2026-11-15）

## 2026-11-15 冻结回归续验

- 修复发布工作流 Apple 公证凭据预检：强制 Developer ID 签名材料；公证凭据允许完整 Apple ID 三件套或完整 App Store Connect API 三件套，拒绝缺项。API 私钥使用固定临时文件名并在退出时清理。工作流 YAML 可解析，五种合成凭据组合（无凭据、Apple ID、API key、API key 缺项、两套均完整）按预期通过/拒绝；未使用真实 secrets，也未执行云端签名。
- 全量 `cargo test --offline --locked --no-fail-fast` 首次发现 `export_acceptance` 示例在编译 SSH 导入路径时缺少 `connection_import` 模块声明；补齐示例装配后重跑通过：Rust 466 通过、74 忽略、0 失败，文档测试 9 通过、2 忽略。该缺陷会阻断 CI 测试构建，但不涉及生产运行路径。
- 本轮 `npm test -- --runInBand` 226 通过、1 跳过、0 失败；TypeScript 检查、`npm run build`、`cargo check --offline --locked`、验收 Python 脚本编译和 `git diff --check` 均通过。生产构建仍有现存 Vite 大 chunk/dynamic import 提示；不作为构建失败，也未在本轮扩展优化范围。
- 签名门禁未通过验收：本机可用 Apple codesigning identity 数量为 0。真实触摸板、Windows 原生运行、跨平台完整桌面 E2E、真实签名/公证安装升级和长时间桌面 RSS 仍未获得证据；不得据此称为全平台验收完成或发布成功。
- 本轮隔离矩阵实际运行临时 MySQL 8.4 与 PostgreSQL 17，服务退出且数据目录清理；DuckDB 固定官方归档校验和后运行两个原生专项及完整 Rust 库套件，全部通过并删除临时动态库。发布工作流新增 Rust 全量测试（Apple Silicon job）和 Release 资产完整性检查，缺少任一 macOS、Windows x64 或 Windows ARM64 安装包都会阻止发布。
- 新增 `.github/workflows/platform-validation.yml`，计划在 PR/master 的 Windows x64 runner 上原生构建 Tauri 并运行前端及 Windows 可运行 Rust 回归。当前本机无法执行 Windows runner；该 workflow 的首次 GitHub Actions 实际通过记录尚缺，因此 Windows 原生构建仍为未验证。新增 workflow 和脚本只通过 YAML/结构静态检查。
- 再次集中运行后端普通套件为 Rust 466 通过、74 忽略、0 失败；文档测试9通过、2忽略；前端226通过、1跳过、0失败；TypeScript 检查和 `cargo check --offline --locked` 通过。

**当前状态入口：** [固定验收清单](audit-closeout-checklist.md)。下文为历次记录，计数按时间变化；旧临时日志不视为仍可复查的证据。

本文件按用户原始问题交付，不把审计轮数或单元测试数量当作完成度。停止新增审计分支，当前批次冻结后只做已有修改的整合验证。

| 用户问题 | 已有证据 | 未完成验收 |
|---|---|---|
| A库复制到B库不私改DDL/字符集 | 原表SQL夹具及隔离MySQL复制、迁移、导出回放专项已有通过记录，详见software-safety-audit.md | 全服务器版本与打包版完整流程未覆盖 |
| INSERT/UPDATE/复制迁移安全 | SQLite/MySQL/PG多项事务、约束失败回滚、原值冲突实测已记录 | 不存在跨服务器全局原子性保证；其他原生驱动及提交断网矩阵未完成 |
| 结构/数据比对准确 | 完整定义比对、类型/字符集及并发专项已有实库证据 | 两侧独立快照不是跨服务器同一业务时点；全部引擎未认证 |
| mac触摸板单击后误选中 | 事件状态修复与自动回归有记录 | 真实mac触摸板硬件未验收，不标完成 |
| SSH文件传输断开无法刷新 | 本地真实SSH/SFTP关闭通道与配置变化重连回归通过 | 用户实际远程环境及打包版未验收 |
| 内存明显过大 | 结果/暂存预算、连接回收及流式路径有修改和专项证据 | 桌面进程RSS前后对照未完成，不能声称达标 |
| 表预览复制粘贴赋值 | 单格/连续区/多列/暂存提交浏览器交互通过 | Tauri WKWebView系统剪贴板实机未验收 |

当前批次整合：Rust 386通过、55默认忽略、0失败；cargo check及git diff --check通过，仍有3条vendor上游dead_code警告。仅证明当前已运行测试，不代表全软件通过。本批修改普通查询、DB高级操作、连接测试、能力探测和MariaDB管理的配置错误拒绝/隧道凭据处理；真实用户凭据与业务库未操作。

## 冻结代码整合验收

- 当前源码重新运行：前端221通过、1跳过，TypeScript与生产构建通过；后端常规386通过、55默认忽略。
- 将其中可用的MySQL8.4与PG17实服专项全部显式串行运行：54通过、0失败；仅DuckDB原生库专项未运行。覆盖原表DDL保真复制/迁移、导出回放、INSERT/UPDATE/DELETE失败回滚、结构/数据比对、TLS/取消及计划分析。
- 首次实服整合53通过1失败，原因是draft_insert测试把应用端口写死33389，而fixture来自33379。只修测试从同一URL取得端点，生产代码未为绿测改变；随后54项整批复跑通过。失败日志保留。
- cargo check、功能注册审计、git diff --check通过；保留3条vendor上游警告。证据/tmp/dbterm-acceptance-{npm,build,real-databases,real-databases-final,rust,check,features}.log。
- 结论：已完成上述源码整合检查，但不是生产发布认证。未完成打包桌面端到端、真实触摸板和系统剪贴板、RSS前后对照及全部原生驱动/网络故障矩阵；当前开发版不应操作唯一重要数据或执行生产覆盖迁移。业务库和真实用户凭据未操作。

## 隔离桌面启动验收

- 使用独立 identifier `com.dbterm.acceptance.20261114` 完成 Tauri debug 原生构建（无安装包），数据目录为独立的 `com.dbterm.acceptance.20261114-dev`；未启动已安装生产应用或读取其连接。原生窗口已显示中文首页，无保存连接。
- 第二次受控启动在第3/6/9/12秒均仍存活，主进程RSS分别为129344/129136/128992/128944 KiB。只代表空白debug应用主进程基线，不含WebKit完整归属，也不证明实际负载、峰值、无泄漏或优化幅度。采样后由测试脚本终止其自建PID（退出码-15），不是运行中自行崩溃。
- 更早一次交互启动退出码为0，无同期崩溃报告；退出原因未确认，不计为稳定性通过或崩溃证据。
- 运行日志仍记录结构化日志订阅器重复初始化警告，随后使用应用日志插件；不能把本次启动描述为零告警。当前冻结范围内未继续扩展修改。
- 证据：`/tmp/dbterm-acceptance-desktop-build.log`、`/tmp/dbterm-acceptance-desktop-runtime-final.log`、`/tmp/dbterm-acceptance-desktop-samples.json`。真实硬件交互、桌面数据库完整流程与内存前后对照仍未完成。

## 粘贴保存异常路径验收

对当前真实 `TableBrowser.tsx` 使用 Chromium/React StrictMode 交互，数据库IPC和剪贴板IPC由隔离fixture模拟；本项不计为真实数据库或WKWebView剪贴板验收。未为验收修改业务代码。

- 保存请求悬而未决时再次按保存快捷键，只发出一次 `update_cells`。模拟提交回执丢失后，暂存仍在，保存按钮禁用，再按快捷键不再提交；显式撤销可清除暂存。
- 模拟写入已确认、随后读取刷新失败：暂存已清除，fixture保存新值，仅一次写入请求，避免因刷新失败把已提交写入当作可重试草稿。
- 剪贴板读取未返回时切换表，再返回旧读取结果：新表不产生暂存，也无写入请求。三项交互均通过，浏览器无pageerror。
- 当前脚本 `/tmp/dbterm-grid-failure-acceptance.mjs`，运行结果 `/tmp/dbterm-acceptance-grid-failures.log`。这只证明UI状态和IPC调度；真实提交断网后的数据库状态仍须单独核验，不能由模拟结果宣称已回滚。

## MySQL发布前并发变更验收

- 新增永久实库验收 `publication_acceptance_tests::real_mysql_publish_rejects_stage_charset_and_concurrent_target_ddl_changes`，只修改测试代码。MySQL8.4隔离实例中，在暂存建表后从另一连接：一是修改暂存字段字符集/排序规则；二是修改正式目标定义。两种情况均拒绝发布。
- 每种情况逐项读取确认：正式目标原记录 `42/preserve` 保留；正式目标DDL保留测试前或并发修改后的定义；未把正式目标改名成备份；源端完整DDL未改变。该测试1通过0失败。
- 邻近 `mysql_ddl_fidelity_tests` 包含原始用户建表SQL、函数索引、字符集、完整字段定义、失败保留及真实复制/迁移路径，使用同一隔离实例显式运行（含ignored）。结果见 `/tmp/dbterm-acceptance-ddl-final.log`；新增测试日志 `/tmp/dbterm-acceptance-publish-races.log`。
- 本次未证明网络分区/提交回执丢失后的数据库最终状态，也不把上述两个确定的并发场景外推为全部竞态安全。

## MySQL批量更新真实提交断线验收

- 新增 `query::commit_disconnect_tests` 永久验收：本地TCP协议代理连接隔离MySQL8.4，调用实际 `mysql_update_cells` 一次更新两行；只增加测试及cfg(test)模块，未更改生产写入逻辑。
- 断点一：代理截住COMMIT，在服务端收到前关闭两端连接。独立观察连接读取，两行均保持原值；应用返回「提交未得到成功确认／勿重复写入」，没有宣称已回滚。
- 断点二：代理转发COMMIT并读取服务端成功OK包，丢弃该回执后关闭连接。独立观察连接读取，两行均为新值；应用同样返回未确认且不要重复写入，没有误报成功或自动补偿覆盖。
- 两个确定断点均通过，未出现半批更新；日志 `/tmp/dbterm-acceptance-commit-disconnect.log`。结合浏览器已验证的未确认禁重试状态，覆盖这条批量UPDATE链路的后端结果语义与前端保护，尚非桌面端到端联测。
- 不能由此宣称断网时一定未提交：本测试恰好证明提交回执丢失时数据库可以已经提交。INSERT、DELETE、迁移发布和其他引擎的故障矩阵仍须各自验收。
- 添加上述两项显式实库测试后，后端普通整套重新运行386通过、0失败、57默认忽略（新增2项均已分别显式通过）；相邻MySQL乐观锁/整批回滚实库测试再跑1通过。日志 `/tmp/dbterm-acceptance-rust-with-fault-tests.log` 与 `/tmp/dbterm-acceptance-commit-neighbor.log`。隔离MySQL已正常关闭。

## INSERT/DELETE断线及删除确认缺陷修复

- 同一协议代理扩展到真实 `mysql_drafts` 和 `mysql_delete_rows`：各验证COMMIT到达前断开、服务端成功后丢失回执两个断点，观察连接核对完整两行内容。INSERT/UPDATE/DELETE共3项实库测试通过，6个断点结果无半批数据，错误均不假称成功/已回滚。日志 `/tmp/dbterm-acceptance-all-write-disconnect.log`。
- 确认并修复 `TableBrowser.tsx::confirmDeleteRows` 两处前端缺陷：①提交未确认后旧确认仍可再次提交；②同一事件轮连续确认可发两次IPC。修复为同步ref互斥；提交结果未知时清除确认/选择、提示勿重试并重新读取数据。普通可确认失败仍显示原错误。未改变后端SQL或SSH代码。
- 两项先取得失败证据：`/tmp/dbterm-delete-uncertain-red.log` 与 `/tmp/dbterm-delete-double-submit-red.log`；修复后同一真实组件浏览器回归通过，确认只一次删除IPC、旧确认不再可提交且触发刷新。永久交互脚本 `scripts/acceptance/delete-confirmation.mjs` 需要隔离grid fixture与Playwright；不计入普通npm单测数。
- 修复后前端221通过1跳过、生产构建通过；粘贴正常/异常邻近交互通过；后端386通过0失败59忽略（新增实库项已显式通过）。日志 `/tmp/dbterm-acceptance-delete-{npm,build,grid-neighbor,grid-main,rust}.log`。
- 本次验收仍是后端真实连接与前端模拟故障分别验证，未宣称桌面端到端、跨服务器全局事务或全部引擎断线认证。

## 冻结交接构建

- 用户要求收敛后不再追加业务修改。核对发现19:19的原生验证程序早于19:51的最终删除确认修复，不能将其启动证据当作最后源码的运行证据。
- 仅重新执行独立identifier的Tauri debug/no-bundle构建，2026-11-14 19:56:35生成 `src-tauri/target/debug/DBTerm`，退出码0；内含19:55:44重新构建前端。未安装、未启动生产应用、未改源码配置。日志 `/tmp/dbterm-acceptance-desktop-final-build.log`。
- 本地验证程序SHA256：`4aa2f7ee16682c06d75d9f934dd4bc73b66f166803bfe03dc45688b32a774437`。先前桌面启动和RSS测量属于前一构建，不外推为该构建已通过运行验收。
- 当前状态为代码冻结、已有回归及构建通过、尚未生产认证；不得将未完成验收写成完成。
- 随后对上述SHA256完全相同的最终程序完成一次隔离启动：第5秒进程存活，系统读取到DBTerm窗口（1200×800），截图人工核对中文首页及「暂无连接」。测试脚本随后关闭自己的PID，退出码-15来自脚本终止。未连接任何数据库。证据 `/tmp/dbterm-acceptance-frozen-runtime.json`、`/tmp/dbterm-acceptance-frozen-runtime.log`、`/tmp/dbterm-acceptance-frozen-window.png`。
- 该最终构建已获启动/首页渲染证据，但不是完整实机操作或稳定性验收；仍有重复日志订阅器初始化警告，未为消除警告扩展业务修改。

## PostgreSQL迁移恢复分支核验

- 代码审阅确认 `db_migrate_table` 目前在[非 MySQL→MySQL 入口处](../src-tauri/src/commands/db_extra.rs)直接拒绝迁移；同函数后续 PostgreSQL/SQLite流迁移分支因此当前不可由该命令触发。以下修复和测试覆盖的是该内部实现，不能描述成当前用户可触发问题的实机修复。
- 该内部路径原有问题：替换目标时把旧表改名为备份；后续失败的 DROP/RENAME 错误被忽略，可能仅返回最初迁移错误。恢复失败时原表可能仍以备份名存在，调用者无法据错误定位。
- 修复将检查迁移新表 OID，只有确认仍是本次创建的目标才删除；恢复失败报告备份限定名；创建新目标后准备阶段失败也尝试恢复；成功迁移但旧备份清理失败作为结果警告返回。另在改名前拒绝存在入向外键引用的目标，以免约束继续指向被改名旧表；备份名按限定 schema 查重。未能确认迁移状态时保留对象并报错，不盲目删除。
- 隔离 PostgreSQL17 测试覆盖：入向FK目标拒绝替换且值保留；恢复因依赖无法删除临时目标时明确报告并保留备份和阻挡对象；解除阻挡后备份恢复成功；无旧表场景按OID删除本次新表；DROP成功但备份改名失败时事务回滚并保留双方对象；COMMIT错误分类不触发自动恢复。最终针对恢复的实库测试2通过；后端常规387通过、61忽略；cargo check与git diff --check通过。日志 `/tmp/dbterm-acceptance-pg-recovery-focused.log`、`/tmp/dbterm-acceptance-pg-recovery-rust.log`、`/tmp/dbterm-acceptance-pg-recovery-check.log`。
- 测试只直接调用内部目标建表/恢复函数，未覆盖不可达的整条命令流程，也未声称此 PostgreSQL 迁移功能当前可用或已获端到端认证。隔离 PostgreSQL 服务已关闭。曾尝试运行全部以 `postgres_` 命名的实服专项；其中新增夹具最初漏了被引用列主键，另外5个TLS专项缺少 `DBTERM_TEST_PG_TLS_ROOT` 证书而失败。这不是代码通过证据；修复夹具后重跑本次2项目标测试通过，完整常规套件仍通过。

### 覆盖纠正与当前整合结果

- 复核发现旧版 `postgres_restore_transaction_rolls_back_target_drop_if_backup_rename_fails` 夹具存在外键依赖，实际在DROP阶段失败，没有触发名称所说的后续ALTER失败；此前据此宣称已验证后半程回滚不准确。只修改测试，去除DROP阻挡，传入不存在的备份名，要求错误明确来自ALTER；随后验证目标OID与原记录恢复，并再次使用真实备份恢复成功。纠正后2项恢复实库测试通过，业务代码未因此变更。日志 `/tmp/dbterm-acceptance-pg-recovery-exact.log`。
- 为先前失败的TLS/草稿测试补齐全部隔离fixture环境参数后，对当前源码运行可用的全部MySQL8.4/PostgreSQL17显式实库测试：60通过、0失败；仅排除DuckDB原生库专项。包括DDL原文/函数索引/字符集、数据迁移及发布保护、INSERT/UPDATE/DELETE提交断线、导出回放、TLS/取消等。日志 `/tmp/dbterm-acceptance-integrated-current.log`。
- 不将此结果外推到未运行的驱动、桌面完整交互、真实触摸板或内存改进；PostgreSQL迁移入口仍受原有保护拒绝，没有因测试而开放。先前桌面构建早于本次PostgreSQL内部实现变更，不能代表当前源码已做最终桌面构建/运行验收。

## DuckDB 原生专项补验（2026-11-14）

- 使用项目固定的 DuckDB v1.5.3 官方 macOS universal 包，加载前核对项目固定 SHA256 完全一致；仅下载至临时目录，未安装或修改驱动配置。
- 显式运行 real_duckdb_cache_changes_files_without_redirecting_retained_transaction：1通过、0失败。同一连接标识切换文件后，保留事务仍提交至原文件，目标文件未串写。仅使用临时测试库。日志：/tmp/dbterm-acceptance-duck-native.log。
- 此前 MySQL/PostgreSQL 的60项与本次1项均通过；61项是分别显式运行，并非一次整批运行。后端普通套件387通过、61默认忽略。
- 本轮没有业务代码修改。真实macOS触摸板、WKWebView系统剪贴板端到端、实际负载内存前后对照仍未验收；最后桌面构建早于后续PostgreSQL内部修改。不能据此宣称全部审计通过或零风险。

## 真实 xterm 交互及 DuckDB 空 BLOB 修复（2026-11-14）

- 新增 scripts/acceptance/terminal-drag.mjs：隔离浏览器中使用实际安装的 xterm 6 和生产拖选恢复模块。先关闭保护，确定复现丢失 mouseup 后 buttons=0 移动仍选中；启用保护后无误选，正常按住拖动、松开保留选择、失焦结束拖选均通过。5项邻近单测也通过。证据 /tmp/dbterm-acceptance-terminal-real-xterm.log。该测试不是WKWebView或真实触摸板手势验收。
- 内存解码路径审阅确认 DuckDB 把 size=0 的 BLOB 直接解为 None。新增真实原生测试先失败：空BLOB与NULL均返回None；随后仅修复该读取路径，先调用官方头文件定义的 duckdb_value_is_null 区分NULL，非NULL空值返回0x，非空值按原有十六进制解码。异常非空空指针明确报错。没有修改DDL、事务或写入SQL。
- 使用已校验官方v1.5.3库，空BLOB/NULL/非空二进制保真与事务文件切换2项专项通过。失败及修复日志 /tmp/dbterm-acceptance-duck-blob-red.log、/tmp/dbterm-acceptance-duck-blob-green.log。新增1项默认忽略实库测试。
- 本轮修复前的当前源码桌面构建及独立identifier启动已通过，系统读取到1200×800窗口。主进程空闲RSS采样不含WebKit全部内存，不能证明负载内存改善。证据 /tmp/dbterm-acceptance-current-desktop-window.json；该二进制不包含本节后续空BLOB修复，需以后续构建结果为准。

## 空 BLOB 修复后整合验证

- 后端常规整套：387通过、0失败、62默认忽略；新增的空BLOB实库专项及原连接切换专项均已单独显式通过。没有因测试默认忽略而把新测试算进387。日志 /tmp/dbterm-acceptance-duck-final-regular.log。
- 包含空BLOB修复的独立identifier debug/no-bundle桌面构建成功，随后启动第5秒仍存活，系统读取到DBTerm窗口1200×800。测试脚本关闭自建PID，-15来自主动清理。未安装或操作业务连接。日志 /tmp/dbterm-acceptance-duck-final-desktop-build.log、/tmp/dbterm-acceptance-duck-final-runtime.json。
- 当前验证二进制SHA256为451ecd628103ff9e73fcf1a531970e4182b7a75029416c358888e364c88dc75d。脚本语法和git diff --check通过；保留上游vendor警告与启动日志订阅器重复初始化告警。
- 尚无真实macOS触摸板、WKWebView系统剪贴板完整交互、实际负载RSS前后对照的完成证据；不将Chromium事件测试或空白窗口启动冒充这些验收。目标仍在进行。

## DuckDB 零字节文本保真及批量格式化

- 实库复现：文本 a + NUL + 中文被旧C字符串接口截为a。固定v1.5.3源码明确使用strlen；分配式与internal旧接口均不能修复，失败证据保留在 /tmp/dbterm-acceptance-duck-text-red.log 与早期green日志（文件名不代表通过）。
- 使用官方chunk/vector接口读取带长度文本与BLOB，不再进入会丢失长度的legacy物化转换。新模块 src-tauri/src/commands/duckdb/vector_reader.rs；仅涉及DuckDB结果读取，没有改写用户DDL、重执行用户查询或修改其他数据库/SSH业务。复杂值及带时区时间使用绑定值的批量只读CAST，保持嵌套NUL与连接时区。
- 验证覆盖整数边界、精确小数、浮点、日期/时间/时区、UUID、ENUM、LIST/ARRAY/STRUCT/MAP/UNION/BIT、空BLOB/NULL、4105行跨块与NULL位图、超100000行/32MiB后连接继续使用、事务文件切换、复杂结果读取后的COMMIT/ROLLBACK及INSERT RETURNING。5项原生专项通过，日志 /tmp/dbterm-acceptance-duck-batched-final.log。未覆盖的特殊类型明确报错，不伪装NULL。
- 性能纠正：最初每个复杂单元格执行一次格式化，2049行四列样例耗时322ms；改为按列/原生批次绑定格式化后同一测试37ms，两次均为本机debug单次样本，不外推到全软件性能或RSS改善。参数及时清理、chunk/值/类型使用RAII释放；原生duckdb_query仍先物化，32MiB不是总内存上限。
- 当前修改的整套后端回归与独立桌面构建以随后实际结果为准，不沿用上一节二进制指纹作为本次已构建证据。
- 本节后续整合结果：后端387通过、0失败、65默认忽略；其中DuckDB5项已显式运行通过。当前源码独立identifier debug桌面构建成功，启动5秒存活且系统读取到1200×800窗口；测试脚本随后清理自建进程。SHA256：49df19daa68fd4d7532e3a65c5b5470df36b31f120addfed7b5f8578df146f0d。证据 /tmp/dbterm-acceptance-vector-final-regular.log、/tmp/dbterm-acceptance-vector-final-build.log、/tmp/dbterm-acceptance-vector-final-runtime.json。git diff --check通过。该启动不是桌面数据库端到端验收，触摸板/剪贴板/实际负载内存证据仍不完整。

## DuckDB 重复读取与超限释放压力验证

- 新增仅测试代码 real_duckdb_repeated_results_and_budget_failures_release_native_memory。一个临时内存库连续24轮：读取192行每行32KiB文本并释放、触发34行每行1MiB结果的解码预算错误、读取256行嵌套结果并释放，最后确认连接仍可查询。没有修改业务实现或操作用户库。
- 每轮使用duckdb_memory()核对引擎缓冲区记账为0。独立测试进程macOS RSS首轮145744KiB，预热后第6至23轮175648至175712KiB，最后12轮175712KiB；该样本未见逐轮无界增长。RSS包含测试框架、Rust和原生分配器，0缓冲区记账不是0内存，也不排除其他负载/更长时间泄漏。没有旧版本同负载对照，不能宣称内存优化幅度。
- 证据 /tmp/dbterm-acceptance-duck-memory-stress.log。当前6项DuckDB原生专项整批通过，后端普通套件387通过、0失败、66默认忽略；git diff --check通过。日志 /tmp/dbterm-acceptance-duck-memory-all.log、/tmp/dbterm-acceptance-duck-memory-regular.log。本次仅cfg(test)增加验收，上一节业务二进制不因本次测试内容变化而被描述成重新构建。
- 仍需真实桌面多标签结果/终端负载内存对照、WKWebView系统剪贴板完整交互及真实触摸板手势验收；本项不能替代它们。

## Mac WKWebView 系统剪贴板与复制异常清理

- 确认并修复 src/utils/clipboard.ts 的异常清理问题：备用execCommand抛错时，承载复制内容的隐藏textarea残留。新增单测先复现失败，finally现清空值并移除节点，再进入navigator.clipboard备用写入。仅此共享工具业务修改，未修改数据库写入或DDL。失败证据 /tmp/dbterm-acceptance-clipboard-cleanup-red.log。
- 前端222通过、1跳过，TS/Vite构建通过；实际TableBrowser的单格/连选列/矩阵复制粘贴、暂存及撤销浏览器验收通过，实际xterm拖选保护邻近验收通过。证据 /tmp/dbterm-acceptance-clipboard-cleanup-tests.log、/tmp/dbterm-acceptance-clipboard-cleanup-build.log、/tmp/dbterm-acceptance-clipboard-grid-neighbor.log、/tmp/dbterm-acceptance-clipboard-terminal-neighbor.log。
- 新增 scripts/acceptance/webkit-clipboard.swift，在独立macOS WKWebView内加载真实TableBrowser，以真实NSPasteboard桥接插件的读写请求：复制alpha后系统回读一致，粘贴到第二行只暂存无写请求，显式保存后fixture值一致。系统剪贴板原格式/字节在无其他变更时恢复。证据 /tmp/dbterm-acceptance-native-webkit-clipboard.log。
- 限定：数据库IPC和Tauri transport由fixture替代；本项验证真实WKWebView与系统剪贴板组合，不等于实际Tauri插件IPC/ACL或真实数据库桌面端到端。按键为DOM事件，并非真实键盘/触摸板硬件输入。首次Swift脚本把Promise作为evaluateJavaScript返回值，因WKWebView不支持该返回类型失败；改为void后验收通过，未为测试修改业务行为。
- 本节修改后独立identifier桌面debug构建退出0，SHA256 f7c4ff541aee1909abe2a50087d8587a76251c6f76d76f9f4d6511e8076a9ea3。启动第5秒进程存活，但System Events窗口枚举仅返回空项，不能计为窗口显示通过。证据 /tmp/dbterm-acceptance-clipboard-final-desktop-build.log、/tmp/dbterm-acceptance-clipboard-final-runtime.json；脚本随后关闭自身进程。此项保留为桌面窗口验收缺口，不沿用旧二进制窗口证据。隔离grid服务已关闭，git diff --check通过。
- 对相同最新二进制另一次受控启动，在同一存活PID第3/6/9/12秒逐次查询窗口仍为空；没有判为崩溃，也没有判为窗口正常。证据 /tmp/dbterm-acceptance-clipboard-window-recheck.json。后续需使用系统窗口列表/渲染证据区分应用窗口创建与辅助功能枚举问题；本轮未为此修改启动逻辑。
- 窗口疑点已收口：相同SHA256最新程序的CoreGraphics按PID查询在第3/6/9秒均读到同一可见DBTerm窗口，1200×800；另外受控启动仅截取该窗口，人工核对中文首页与「暂无连接」实际渲染正常。证据 /tmp/dbterm-acceptance-window-diagnosis.json、/tmp/dbterm-acceptance-current-window-render.png。主线程采样处于AppKit正常事件循环等待；此前System Events空结果不能作为窗口缺失证据。本项未改任何业务代码，不认定新增启动故障。仅证明本次隔离启动与首页渲染，不代表所有操作或长期稳定性通过。


## 2026-11-15 固定清单导出/比对复验

- 全新隔离MySQL 8.4.11上显式运行生产导出序列化器/回放4项、数据比对7项、原始ALTER模式保护及完整字段定义2项，共13通过0失败。没有业务代码修改。测试日志与相关源码SHA256已持久化到docs/audit-evidence/2026-11-14-closeout。
- 临时MySQL已关闭；未读取保存连接。完整桌面导出/编辑与同步命令端到端、全引擎版本矩阵仍未完成，不由序列化器/比较器专项替代。详细范围见audit-closeout-checklist.md。

## 2026-11-15 当前续审补充

- `cargo test --locked` 此前发现9个公开文档示例因 `models` 模块私有而失败；公开模型模块并将过期的 `ServerPerf` 示例改为真实字段。当前完整 Rust 测试453通过、73忽略，文档测试9通过、2忽略；`cargo check --locked`、`npx tsc --noEmit`、前端226通过/1跳过及 `git diff --check` 通过。
- ZIP组件安装路径新增临时目录符号链接逃逸回归。旧实现测试稳定失败并写到目标目录外；修复为拒绝非普通路径组件与既有符号链接、创建目录后再次校验规范父路径，并用流式复制避免单个条目全量驻留。回归修复后通过。并发符号链接替换竞态及所有ZIP解压入口的压缩炸弹预算仍未完整验证。
- 继续审计发现非OCI ZIP中的动态库提取入口也会跟随已存在的输出符号链接；新增失败回归后修复为拒绝符号链接并流式写出，临时目录测试通过。Windows 专用 Poppler 入口未在当前 macOS 环境编译/运行，仍需 Windows 隔离验证。
- 本地 RustSec 数据库（2026-11-13快照）复扫仍为22条漏洞匹配；尝试联网更新数据库超时，因此不是当前最新公告扫描。完整发布/安全验收仍未通过；本轮未启动安装应用、未访问真实数据库或读取已保存凭据。
- 驱动下载路径原先把整个响应累积到 `Vec`（上限256MiB）后再写盘；已改为边接收边写唯一临时文件、同步计算SHA-256，校验后直接从临时文件识别/解压/原子改名，消除下载阶段的大块内存副本。当前仍保留256MiB磁盘预算，解压后的单个ZIP条目和其他组件安装路径还需独立预算审计。
- 迁移审计发现 Oracle/SQL Server/ClickHouse 通用路径的多语句结构替换和分批写入没有真实事务封装；新增保护后仅放行同一连接、仅数据、追加模式（单条 `INSERT … SELECT`），其他组合在修改目标前拒绝，避免半成品和误报原子性。该限制需在未来实现并验证方言原生事务/发布流程后才能放宽。

## 2026-11-15 Windows 组件解压路径补审

- 复查发现 Windows Poppler ZIP 入口仍将每个条目完整读入 `Vec`，且公共目录复制函数会跟随已有符号链接；这两个路径未在 macOS 的平台条件编译中执行。
- 已改为流式写入，增加 256 MB 解压后总量预算；复制和写出前拒绝源/目标符号链接，保留路径限制和临时目录发布流程。
- 新增 Unix 隔离回归：源目录符号链接与目标目录符号链接均拒绝，且外部目录没有被写入；定向测试 2/2 通过，`cargo check --locked` 通过。Windows 原生编译/运行仍需 Windows 环境验证。
- 历史快照（SQLite兼容补丁、rustix/plist修复之前）：`zip` 升到9.5.1，Tiberius升到0.13.0；当时RustSec数据库扫描为12条漏洞匹配、15项其他警告。此数据不是当前结果。最终SSH升级因API断裂撤回；当时SQL Server实服握手、Windows原生解压测试未完成，后续状态见本文末续审记录。

## 2026-11-15 当前续审验证
- 对当前工作区再次确认：`cargo test --locked` 457通过、0失败、73忽略；Rust文档测试9通过、0失败、2忽略；`npm run typecheck` 通过；`npm test` 226通过、0失败、1跳过；`git diff --check` 通过。
- 这些是本地自动化验证，不等于跨平台和生产连接验收。Windows原生验证、SQL Server隔离服务握手、桌面真实触摸板与完整数据库引擎矩阵仍未验证，因此整体安全验收保持未通过。
- 后续补救将 RustSec unsound 告警 `rustix 1.1.5` 更新至修复版 `1.1.6`；当前扫描为11条漏洞匹配、14项其他警告（10 unmaintained、1 unsound、3 yanked）。
- Tauri `plist` 升级到1.10.3；全平台树剩余 `quick-xml 0.39.4` 来自构建依赖 `wayland-scanner`。扫描仍报告该依赖公告匹配，依赖审计文档记录了 API/输入可达性分析。
- SQLite 绑定补丁保留 SQLx 0.8.6 API，将 vendored `sqlx-sqlite` 对 `libsqlite3-sys` 的约束放宽到 0.39.1，实际 bundled SQLite 为 3.54.1。最新完整 Rust 测试458通过/73忽略，文档测试9通过/2忽略；SQLite 运行时版本门禁通过。cargo-audit 的 SQLite CVE 匹配已消失。前端类型检查通过，前端测试226通过/1跳过。该 vendored 补丁只改依赖版本字段，后续 SQLx 升级时需重新评估。
- SSH调用链复核确认剩余 `russh` 漏洞覆盖实际客户端能力：用户可开启的zlib压缩、客户端通道消息处理和SSH agent认证。不能按理论不可达关闭。RustSec在线刷新本轮超时，报告基于2026-11-13已更新快照；官方 npm registry 前端审计为0。SSH主版本迁移仍需独立完成密钥加载/agent/jump-host/转发/压缩/exec/SFTP矩阵，整体安全验收继续未通过。
- 在迁移完成前先落实临时安全门：SSH 后端无论旧配置 `enableCompression` 值为何，都只向 russh 提供 `none`，不再协商 zlib/zlib@openssh.com；连接设置页显示“传输压缩（安全策略关闭）”。新增策略测试通过。此项降低了当前解压缩内存耗尽风险，但不修复通道消息、agent 帧等其余 russh 公告。
- 临时门禁后的完整 Rust 回归为459通过、73忽略，文档测试9通过、2忽略；前端测试226通过、1跳过，类型检查通过。
- 记录口径更正：上面的12条漏洞是SQLite兼容补丁前的历史扫描，不是当前数值；SQLite补丁后的RustSec可验证快照为11条匹配、14项其他警告，数据库快照日期为2026-11-13。当前可用完整回归结果为Rust 459通过/73忽略、文档测试9通过/2忽略、前端226通过/1跳过，类型检查与diff检查通过。后续在线刷新超时，不能称为当前最新公告扫描。
- SSH风险状态更正：传输压缩目前由后端策略固定为 `none`，已不再是可由用户启用的路径；这是压缩风险缓解，不代表SSH整体风险已关闭。russh通道消息和agent处理仍在可达功能路径内，主版本迁移及完整隔离回归未完成，因此整体安全/发布验收仍未通过。

## 当前工作区整合回归补充（2026-11-15）
- `cargo test --offline --locked --no-fail-fast`：459 通过、0 失败、73 默认忽略；文档测试 9 通过、2 忽略。
- `npm test`：226 通过、0 失败、1 跳过；`npm run typecheck` 与 `git diff --check` 通过。
- `cargo tree` 确认应用使用 `russh 0.63.1` 与 `russh-cryptovec 0.62.0`。本次 `cargo audit` 因 RustSec 远端拉取超时未形成新快照，不能据此宣称依赖审计完成；此前记录的 RustSec 快照仍适用。
- 本轮仍只使用本地隔离测试，未连接真实业务数据库、SSH 服务或读取保存凭据；真实 macOS 触摸板、桌面端到端传输和生产负载 RSS 仍未由本轮验证覆盖。
- 关闭 SFTP 的 SSH 回退下载此前直接 `std::fs::write` 覆盖本地目标；现改为 24 MiB 上限、同目录临时文件、刷盘后原子改名，并拒绝符号链接/非普通文件目标。新增 3 项本地临时目录测试验证替换、目标保护和临时文件清理。
- 连接备份此前使用未认证的自制 SHA-256 XOR 流；现导出使用版本化 AES-256-GCM + Argon2（新口令至少 12 个字符），错误口令/篡改会失败；导入仍兼容既有旧备份格式，但旧格式不具备认证，不能作为新备份安全性证明。新增本地格式认证/旧格式兼容测试。
- 上述两项修复后的整套回归：Rust 463 通过、0 失败、73 忽略；文档测试 9 通过、2 忽略。前端 226 通过、0 失败、1 跳过，类型检查通过；`git diff --check` 通过。RustSec 在线刷新仍受网络超时影响，整体审计结论仍未通过。
- 更正：上一条所称“旧格式兼容测试”当时仅覆盖 DBT2 新格式，且测试字节不是有效 JSON，证据不足。续审新增真实 DBT1 盐+SHA256-XOR 样本，确认现有解密器能还原有效 JSON；新增错误口令和导出大小上限测试，并在 Base64 解码前限制输入长度。专项测试通过（备份筛选 5 通过、2 忽略；批量配置存储失败回归 1 通过），`git diff --check` 与 TypeScript 类型检查通过。
- 续审发现连接备份导入此前逐条 upsert，若后续配置文件写入失败会留下部分连接。现新增 `Storage::upsert_many`，所有配置合并后单次写临时文件并原子 rename；本地注入发布失败测试确认旧文件保持原样。密码与连接配置在不同文件，跨文件没有事务：现配置批量发布后若密码文件写失败会返回包含“配置已导入、密码恢复失败”的明确错误，但连接配置可能已存在、密码也可能部分恢复；不宣称跨文件原子性，后续仍需设计可恢复导入协议。
- 续审另发现配置和密码文件原先使用固定 `.tmp` 配合 `fs::write`，预置符号链接可导致写入跟随链接。两处持久化现改为随机同目录临时名、`create_new`、`sync_all` 后 rename；Windows 旧明文密码迁移分支同步修复。Unix 隔离回归覆盖配置发布和密码映射写入，确认旧临时链接目标未被修改；本轮汇总验证见下方更新结果。
- 本轮集中回归（代码冻结后）：`cargo test --offline --locked --no-fail-fast` 为 Rust 467 通过、73 忽略，文档测试9通过、2忽略；`npm test` 为226通过、1跳过；`npm run typecheck`、`cargo check --offline --locked`、`git diff --check` 均通过。测试期间有既存 vendor deprecated/dead-code、SSH loopback 未消费 Result 与 unused_mut 警告；这些不作为测试失败，但仍应清理。
