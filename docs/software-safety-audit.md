# DBTerm 安全与性能修复记录（2026-11-13）

## SSH / SFTP / macOS 终端

- SFTP 配置变更路径曾在持锁的 if-let 中再次加锁，刷新会死锁；现释放查找锁再失效旧会话。
- 补齐连接关闭错误识别；只淘汰本请求实际使用的会话，避免旧请求误删并发新连接。传输失败、取消、超时后丢弃异常会话。
- 删除、改名等有副作用操作断线不自动重放，提示用户核对结果。
- 上传先打开本地文件，写入独占 UUID 临时文件，关闭成功后提交；不删除旧文件兜底。覆盖前保留服务器提供的权限、UID/GID，属性设置失败拒绝替换。新临时文件权限 0600。
- 终端检测漏失 mouseup 后 buttons=0 或窗口失焦，结束 xterm 拖选；监听随组件卸载释放，普通拖选保留。
- 使用纯 Rust 临时 localhost SSH/SFTP 服务完成握手、认证、列目录、关闭通道后重连、配置变化、防死锁、上传权限与失败保护测试。未使用保存连接。

## 数据库与内存

- 保留此前 MySQL DDL 原文复制、结构回读、旧表恢复、外键及触发器保护。用户提供完整建表 SQL 已存入回归夹具，并经真实 MySQL 8.4 目标 latin1 库建表逐字核对。
- 修复 WHERE 校验仅验证首语句/条件的问题；现在只接受完整单个表达式，拒绝追加语句、UNION、ORDER/LIMIT 和注释截断。
- MySQL 结构对比生成的 ADD/MODIFY 使用 SHOW CREATE 中完整字段定义，避免丢失 ON UPDATE、字符集和注释，避免将 CURRENT_TIMESTAMP 错当字符串默认值。
- 非 MySQL 组合的完整迁移以及 PostgreSQL 原 CTAS 复制无法保证结构与恢复，现执行前明确拒绝。增量迁移接入安全主迁移，不再将类型解码失败写 NULL、忽略冲突并计为成功。
- 大表数据对比遵守 TLS/隧道配置，保持隧道守卫；文本协议读取避免数字/日期变 NULL；区分 NULL 与空字符串。
- 交互查询逐行解码，单结果预算 100000 行 / 32 MiB，事务查询相同；超限报错，不把截断结果冒充完整结果。关闭结果和导出窗口释放快照。迁移批次加 8 MiB 字节刷新阈值。
- SQL 草稿 JSON 序列化与存储共同防抖，避免每次输入序列化全部草稿；只订阅本标签状态，避免隐藏编辑器跟随其他标签重渲染。编辑 SQL 完整保留，持久化独立限额。

## 导出

- 修复单表漏 DDL、ZIP 缺语句结束符，保留原表定义；不私自 ALTER 数据库默认属性。
- MySQL SQL 导出保留二进制、BIT、大整数、DECIMAL、TIMESTAMP、负 TIME、不可见列；生成列不显式插入。设置并恢复导出 SQL_MODE/时区，保护 id=0 与转义语义。
- PostgreSQL 使用服务器文本表示；SQLite 使用真实存储类别，并以精确二进制幂表达式回放 REAL；SQL Server 和 ClickHouse 使用类型序列化器。无法保证的类型报错，不再转 NULL。

## 验证与限制

- 前端 143 项测试、TypeScript 及生产构建通过。Rust 全量 185 通过、0 失败、3 项实库测试默认忽略；这 3 项已另行显式执行，全部通过。DB 功能静态审计脚本执行通过，静态报告不代表实库功能全部验收。
- 显式运行的真实 MySQL 三项测试通过：完整 DDL/失败恢复、导出回放、数据对比类型解码。默认单测另含本地 SSH/SFTP 服务及 SQLite 实库回归。
- 未完成 macOS 真触摸板硬件验收或桌面进程堆/RSS 基准；32 MiB 是解码结果预算，不是进程总内存上限。多个标签、驱动单行/块及 DuckDB 原生物化有额外内存。
- PostgreSQL / SQL Server / ClickHouse 序列化未进行实服务器回放。明确拒绝的范围包括 PG/SQL Server MONEY、Oracle/DuckDB SQL 数据导出、CH TCP 部分地理/DateTime64、MySQL 零日期和未知类型。
- 外部并发 DDL、SFTP 完整 ACL 和所有服务器版本组合未由本轮覆盖。不能由测试通过推导全软件绝无 bug。

本轮不提交、推送、不操作真实保存连接；现有用户改动保留。

## 复审补充（2026-11-14）

本节为本次结果，前文测试计数属于上一轮。

- 修复 MySQL 结构对比遗漏列级字符集、排序规则、注释、ON UPDATE、生成列及不可见属性：逐字段比较完整 SHOW CREATE 定义，ALTER 复用同一份验证定义。不能完整生成的列顺序、索引、约束及表选项差异明确拒绝。
- 同库复制写入进入事务，失败回滚后清理；迁移新建目标写入或开启事务失败时清理本次新表，已有目标保留备份用于恢复。恢复失败返回实际错误及保留表名。
- 流式、单表、整库、逻辑备份、ZIP 与二进制导出使用同目录暂存，flush/sync 后 rename；失败不截断已有目标。Unix 暂存权限 0600，写盘/尾部/ZIP 错误上报，GBK 不可表示字符拒绝，提交前重查取消。工作目录 UUID 化并限制清理范围。
- 整库与建库备份保留源 SHOW CREATE DATABASE 字符集、排序规则、版本注释，仅添加 IF NOT EXISTS；不 ALTER 已有库默认属性。SET NAMES 是会话编码，不修改源列定义。备份对象读取失败或定义为空时终止，不漏对象后报告成功。
- 统一普通/事务只读护栏，防 CTE/EXPLAIN 隐藏写操作；SQL Server CTE、多行 SELECT 的 TOP 定位修复，复杂集合运算保持原文。锁查询不再错误追加 LIMIT，非 Oracle 的 ROWNUM 字段不再绕过默认限行。
- 对象粘贴不先 DROP，保留 DEFINER，仅改声明目标名；前端移除后端拒绝的迁移引擎与策略。
- SFTP 下载先暂存，已有目录拒绝合并覆盖；提前登记取消，上传提交前再检查。终端过滤旧会话事件，修复缺失 buttons 的误判，接管先绑定身份再二次核验。

最终验证：npm test 152 通过；npm run build（TypeScript + Vite）通过；cargo test --lib 206 通过、0 失败、3 默认忽略；这 3 项在隔离 MySQL 33379 显式执行全部通过。实测新增列级 charset/collation/comment/INVISIBLE 的 ALTER 后完整 DDL 一致。包含 localhost SSH/SFTP 与 SQLite 回归。git diff --check 通过。未操作保存业务连接、未提交推送。

尚未解决或完成验收：DuckDB 的 duckdb_query 先物化原生结果再检查解码预算，峰值内存仍有风险；多标签/驱动大行大块也有额外内存。未完成 macOS 真触摸板、桌面 RSS/堆基准及所有数据库实服务器版本矩阵。32 MiB 不是进程总内存上限。Windows rename 失败保留原文件；父目录未 fsync，不宣称断电持久性。并发外部 DDL、提交途中断网、服务器 rename 开始后的取消仍有边界。源定义以数据库当前 SHOW CREATE 为准，数据库不保留用户最初 SQL 排版。

## 第二次连接、内存与原子性复审（2026-11-14）

本节取代前文有关「覆盖时先改名旧表、失败恢复」的实现描述；历史测试计数保留用于追踪，不代表当前最终结果。

### 已实施

- DB SSH 隧道按随机盐 SHA-256 配置/凭据身份与存活状态复用；身份包含跳板地址、账户、认证、私钥内容及 DB 目的地址。配置保存后失效；私钥认证期间变更拒绝复用。按 ID 的建连锁使用 Weak，清理过期项。
- MySQL / PostgreSQL / SQLite 池在每次命中时核对完整配置和凭据摘要，串行同 ID 建连，防止旧配置请求在失效后重新发布旧池。只读连接在缓存命中前拒绝 init SQL；SET NAMES 失败上报。
- MySQL 完整迁移源连接开启一致性事务并取得实际源表 MDL，再复查基础表、类型、引擎、触发器和自引用约束；仅数据目标在实际写事务持有 MDL 时复查完整 DDL、引擎和触发器，避免预检到执行之间的结构变化。
- 结构复制/覆盖先建立随机命名暂存表，使用源 SHOW CREATE 原文且只替换声明表名。加载期间旧目标保持原名可见。流式内容指纹包含每个单元的 NULL 标记与字节长度，使用 SHA-256 多重集累加并同时核对行数；这是概率性内容指纹，不是数学上无碰撞的证明。预提交复核后，在发布锁内再次核验暂存完整定义、触发器、引擎及内容，再以单条 RENAME 发布。仅结构复制也要求暂存内容为空。
- 覆盖保留完整旧表备份，并在结果显示名称，不自动 DROP；保留装载期间旧 B 的业务写入供核对。发布失败或 COMMIT/RENAME 未得到成功确认时不盲目 DROP、恢复或重试。发布前确定失败只清理本次随机暂存表。元数据/行锁等待设为 30 秒；锁内全表复核仍可能较长时间阻塞访问。
- 仅数据清空改用事务 DELETE，并在提交前对全部目标行核对流式内容指纹。追加仍是独立事务，不声称目标所有行与源相同。
- 向导首个对象错误立即停止后续对象，明确标记未执行；声明逐对象独立提交，已成功对象不会因后续失败自动回滚。原行数验证接口不再把 count_match 当 sample_ok，界面明确显示「内容未校验」。
- SQL 批量执行累计保留结果限制为 32 MiB 逻辑字符串/100000 行，达到阈值保留已完成结果并在下一语句前停止；事务状态明确提示。DuckDB 在 Rust 解码分配前检查预算，RAII 释放原生单元缓冲，BLOB 十六进制单缓冲生成。
- DuckDB 导出临时 CSV 不再由 task_id 拼接路径；随机独立目录在 Unix mkdir 时直接 0700，RAII 清理正常、错误及 unwind 路径。

### 必须保留的边界

- 当前是单表原子发布/单表目标写事务，**不是多表、跨服务器的分布式原子事务**，也不是整个数据库统一源快照。逐表复制时源业务继续写入会导致表间时间点不同。不能承诺 A/B 在继续并发写入时始终相同。
- 覆盖有替换语义：新目标是源快照，旧 B 并发写入保存在备份，不自动合并。源端快照后的新数据不在本次复制范围。无损原文不能经暂存重命名保持的自引用外键拒绝；约束名称冲突安全报错，不私自改名。
- 数据库服务器当前 SHOW CREATE 才是定义来源；原始用户 SQL 排版/未显式属性无法从服务器恢复。迁移不增加列级字符集来替代原定义。
- DuckDB 原生 duckdb_query 仍会先物化，32 MiB 是解码及前端保留预算，**不是进程 RSS 上限**；未进行桌面 RSS/堆基准。DuckDB 空 BLOB/NULL 及 CSV NULL/空字符串既有区分问题尚未验收，不宣称已修复。
- 保存前已经运行的请求可以完成于旧端点；新请求不得从配置不匹配的缓存取旧端点。凭据 keychain 与配置文件仍是两个存储，未实现跨存储事务。
- MySQL 8.4 实库回归不代表 MariaDB/TiDB/OceanBase 全版本验收；SQL Server/ClickHouse/DuckDB 真服务器/驱动矩阵和 macOS 触摸板硬件仍需分别验收。

### 扩展引擎补修

- SQL Server 和 ClickHouse TCP 缓存也校验完整配置/凭据摘要；SQL Server 实际检查隧道存活。修复相同 ID 修改到 B 后普通查询仍复用 A，以及旧 A 建连晚完成污染新配置缓存的问题。
- DuckDB 复用前比较完整配置及驱动路径，串行建立与发布；已有查询持有旧句柄时拒绝重定向，空闲后重新打开正确文件。
- DuckDB / SQL Server 手动事务改为持有 BEGIN 时的实际 Arc 连接，使用独立连接而非普通查询池；exec/COMMIT/ROLLBACK 不再重新读取配置或按 ID 重新选择库。配置修改不重定向旧事务，普通查询不加入该事务。
- 修复 SQL Server UI 写 ssEncrypt/ssTrustCert/ssInstance/ssAppIntent、后端读不同字段名导致安全选项未生效。后端匹配实际字段且保留旧键别名；新连接默认验证服务器证书。已保存的显式 ssTrustCert=true 仍是用户选择，不擅自覆盖。
- DuckDB 缓存及事务实驱动测试已提供 opt-in 用例（DBTERM_TEST_DUCKDB_LIBRARY），本机无驱动未执行。取消阻塞原生查询不保证立即中止；回滚须等待该原生查询释放连接锁，不宣称即时取消。

### 本轮最终验证

- npm test：160 通过，0 失败；npx tsc --noEmit、npm run build 通过。
- cargo test --lib --offline：225 通过、0 失败、4 默认忽略；cargo check --lib --offline 通过，无新增编译警告。
- 3 项 MySQL 实库测试分别显式执行全部通过（隔离 localhost:33379）：原始 DDL/暂存发布/流中断保留旧目标/事务 DELETE 回滚/同数量暂存内容篡改拒绝发布/旧表备份保留；SQL 导出回放；数据对比数字日期 NULL 解码。
- 第 4 项是 DuckDB 驱动可选集成测试，本机缺少驱动，未执行；不能以「默认忽略」算通过。SQL Server/ClickHouse 仅身份、安全配置和持有句柄相关测试，未进行真实服务器故障注入。
- git diff --check 通过。全量 Rust 包含本地 SSH/SFTP 与 SQLite 回归；未使用任何保存的业务连接，未提交、推送或执行业务库 SQL。

## 第三次写入与结构/数据比对复审（2026-11-14）

本节取代前文关于同库直接建立正式复制目标、迁移校验仅比行数及通用比对能力的描述。

### 确认并修复的问题

- 批量 INSERT/DELETE 部分路径逐行自动提交，后行失败保留前行；现单请求持有专用连接与完整事务，预检全部参数，准确上报回滚失败和提交状态未知。MySQL 写入拒绝非 InnoDB、触发器和无法核验触发器可见性的表，转换警告回滚。
- 更新先提交后查影响行数、非唯一定位、Oracle OCI 提交/回滚错误被忽略均已修复。多格保存改为单次 IPC 事务更新；混合新增/修改/删除保存和不支持引擎的多格更新写前拒绝。
- SQL Server 将所选数据库误当 schema 的定位已修复：专用连接使用所选数据库，绑定参数查询实际唯一 schema，三段限定目标，歧义拒绝。
- 同库复制随机暂存、明确 RR 源快照、双方 UTC；完整原始 DDL 与全字段原始字节内容指纹校验，发布锁内复核后单条 RENAME，已有目标拒绝覆盖。生成列不插入但核验，不可见列显式复制。源 DDL 仅替换声明目标名，不增加字符集/排序规则。提交/发布未知不盲目删除、重试。
- 结构比对持有双方表元数据锁，同连接核对原始 DDL 和全部字段，列 SQL 复用源原文。库默认字符集/排序规则/加密/版本注释参与只读比较。未支持的索引/约束/表选项差异、触发器表及非 MySQL 完整比对明确报错，不误报一致。
- 结构界面旧结果误用于新连接已修复；清除过期结果、忽略过期请求、移除直接执行入口，仅提供审阅复制 SQL。
- 数据比对曾猜测排序、遗漏非共有列，差异 UPDATE 使用不可靠定位甚至 WHERE 1=1；现删除可执行同步 SQL，只读结果和差异 JSON。精确比对限定相同列结构、完整非空整数主键的 MySQL 族 InnoDB 基础表；字符串/小数主键、不可见列、不可靠解码及未支持引擎明确拒绝。
- 扫描使用双方独立 RR 只读快照、UTC、元数据锁、完整主键和跨页递增核验。生成列参与、二进制编码、NULL/空串区分，解码失败报错。每批有限额，差异样本每类最多200条、合计8MiB，超限中止不出完整结论；仅新增样本时核算预算，复制时才构造 JSON。
- MySQL 迁移验证升级原始定义与全字段指纹，覆盖生成列/不可见列/BLOB及 UTC。SQLite 明确仅行数/内容未校验，删除不完整同步脚本。DuckDB 修复 file_path 误用、跨 schema 同名混淆，专用只读连接，仅声明字段名/类型摘要。

### 集成验证

- Rust261通过、0失败、12默认忽略；cargo check通过，无编译警告。10项 MySQL 忽略测试显式执行全部通过；剩余 PostgreSQL、DuckDB 两项无实服务/驱动未执行。
- MySQL 实测覆盖原文 DDL、暂存发布、同行数篡改、批量失败回滚、转换警告、导出回放、整数排序/游标、DECIMAL/微秒/二进制/NULL、生成列/不可见列边界。额外 UTC 实测两连接初始 +08/-05 归一后 TIMESTAMP(6) 原始指纹一致。
- 前端167通过，TypeScript和生产构建通过，git diff --check通过。仅使用隔离 MySQL 和临时 SQLite，未操作保存的业务连接，未提交推送。

### 保留边界

- 两端快照分别建立，不是跨服务器共同时间点；逐表比对不是整库全局快照。多表迁移逐对象提交，不是多表/分布式原子事务。
- 定义以服务器 SHOW CREATE 为准，不能恢复最初输入排版。结构比对不覆盖视图、存储程序、事件、权限、外部依赖；清单前后复查不等于全局 DDL 锁。
- SHA-256多重集与行数是概率校验，不宣称数学无碰撞。样本上限不截断成功扫描；不支持/超预算报错，不给完整一致结论。
- SQL Server/Oracle/DuckDB事务编排有测试和编译检查，未完成相应实服务/驱动故障矩阵。DuckDB原生物化峰值、桌面RSS、macOS真触摸板仍待验收。不能据此宣称整个项目绝无bug。

### 第三次复审追加

- 整数分页游标统一解析为 i128 后输出不带引号的规范整数，拒绝 NULL、形状错误和非整数，避免字符串/数值比较的精度转换风险。实测 CAST 常量表达式存在精度转换问题；修复前索引表路径未复现漏行，不能混称已复现。新增有/无符号最大值附近2003行跨页和元组测试通过。
- 实测相同原始 DDL 在 NO_BACKSLASH_ESCAPES 不同的会话下会改变默认值（HEX6108 与 HEX615C62）。结构同步生成、复制、迁移均核验实际源/目标的 NO_BACKSLASH_ESCAPES 和 ANSI_QUOTES；不一致在修改前拒绝，缺源模式拒绝。原始字面量不改写，结构 SQL 标注目标会话前置条件。迁移元数据 COLUMN_TYPE 显式 CAST，避免驱动类型标记导致解析失败。
- 手动事务移除重复 MySQL/PG 建连器，复用标准连接器并在 ActiveTx 持有原 SSH 隧道 Arc；PG 事务不再绕过 SSH，MySQL 不再遗漏密钥链隧道密码，只读初始化策略一致。事务模块19项及联网前拒绝回归通过，未做真实 SSH/TLS 故障注入。
- MySQL/PG TLS 策略统一正常查询、池、管理、测试连接和手动事务。旧配置 useSsl=true 且未保存模式时要求 TLS；显式 disabled 保留用户选择；未知模式、损坏配置、类型错误和解析丢失明确拒绝，不能静默降级。4项专项通过；不代表全部证书/隧道主机名场景实连验收。

### 本轮最终集成证据（取代本节较早计数）

- Rust 266通过、0失败、15默认忽略；cargo check通过。13项隔离 MySQL 集成测试显式运行全部通过，剩余 PostgreSQL、DuckDB 两项仍未实跑。
- 前端170通过，TypeScript、生产构建及数据库功能注册静态检查通过；静态检查不替代实库测试。git diff --check通过。
- SQL 表导出的 DDL、sql_mode 和数据流共用实际连接，MySQL SQL 导出先开启 RR 只读快照并持有元数据锁；数据导出要求 InnoDB 基础表。视图 ZIP 导出保存同会话模式及创建字符上下文，非 utf8mb4 创建上下文明确拒绝。MySQL 函数/存储过程 ZIP 归档暂拒绝：当前不能可靠重放创建时数据库默认排序规则，不能以原始文本存在冒充语义保真。原 DDL 不改写。
- 数据比对总时限5分钟（包含建连和完整扫描），元数据/行锁等待上限30秒；超时返回错误而非完整一致结论。关闭窗口不等于立即取消后台扫描；客户端超时丢弃专用连接，服务端释放仍依赖断连处理，未宣称即时中止。

## 第四次事务生命周期、取消、行定位与导入复审（2026-11-14）

上一轮产生实际代码修复和实库证据，属于有效进展。本轮继续按当前工作树检查，尚不据前轮通过认定整个项目完成。

### 已确认缺陷及当前修复

- 严重：结果表排序/过滤后，显示行号被用于读取原始结果主键，编辑/删除可落在其他记录。现在投影保留 sourceIndex，选择、编辑、删除、表单、虚拟窗口及回滚记录使用原始行身份；范围选择显式映射显示顺序。暂存值不再污染原始结果，放弃修改可恢复真实基线。
- 保存确认前没有同步锁，快速点击可重复写入；热键也可并发启动 SQL。前端同步请求门闩在首个 await 前保留执行权。旧结果写回不清除新结果；成功写回后先清理暂存，刷新或辅助存档失败单独提示数据已提交。提交回执失败不自动回滚并暗示已撤销。
- 手动事务 COMMIT 先从 map 删除后等待连接锁，排队旧请求可在提交后自动提交执行，新 BEGIN 可与旧终结重叠。现同连接生命周期操作门闩及 Arc 身份核验覆盖 BEGIN/exec/finish/cleanup，其他连接不相互阻塞。Oracle 并发 BEGIN 覆盖原生句柄、空闲清理只删除 String 没有回滚原生事务已修复，后台接入实际原生池清理。
- 取消注册重复 token 原先替换 sender，会意外唤醒旧请求；清理按 token 删除也无代际保护。现在重复拒绝、连接 ID 所有者核验、RAII 代际清理，取消后 token 保留到原请求退出。直接丢弃请求 future 同样清理。
- 取消原先重新读取当前配置再按旧 PID KILL/terminate，配置变化或节点差异会命中错误服务端；已移除该路径，只通知原请求持有的连接。MySQL/PG 池请求中断、错误或 future 被丢弃时关闭该会话，只有完整成功才回池。真实 SQLite 连接池测试确认不完整会话不复用、正常会话仍复用；隔离 MySQL 实测取消后的实际专用池会话 ID 被替换。取消只表示客户端请求处理，不代表服务端已经确认终止或写入已回滚。
- MySQL USE 原先删除名称内反引号，可能把合法 a反引号b 选成 ab；现在使用标识符转义，不改变目标名字。
- SQL 文件清理原先修改字符串中的注释文本、删除可执行版本注释、同一行多语句分隔错误、整文件缓存并在错误后继续。现增量词法读取、单语句/单行16MiB限额，保留字面量/注释，支持 DELIMITER、PG dollar/E字符串、动态会话模式及 SQLite trigger 完整语句，首错停止并提示既有修改可能已提交。Duck 导入使用独立会话。
- 对象编辑原先去除 DEFINER/SQL SECURITY/限定名，保存自动先 DROP；已改为原定义和编辑文本原样执行，不自动删原对象。已有对象需要用户明确使用引擎支持的 ALTER/CREATE OR REPLACE；不支持原子替换的 MySQL routine 原 CREATE 会安全重名报错，不能称为替换成功。
- 备份恢复传参 filePath/path 不匹配及忽略后端 failed/errors 已修复；导入界面显示实际错误和先前提交风险，不鼓励整体盲目重试。
- 恢复辅助 SQL 不再猜测数字字符串，保留前导零/引号/反斜杠；主键变更后使用新主键定位，一行多个字段合并恢复。不支持二进制/特殊类型时提示无法可靠生成。辅助 SQL 仅供审阅，不等于事务回滚，不自动执行，旧存档不擅自重写。

### 已取得的专项证据与边界

- 事务23项专项通过；取消重复 token 测试先红后绿。SQLite 池2项真实会话测试通过，MySQL取消专用池会话测试通过。MySQL测试先前误观察其他健康空闲连接，已通过占用其余池槽改成可确定的真实执行会话；不将测试观察错误算生产缺陷。
- SQL文件解析7项专项通过，含隔离 MySQL 的可执行注释/DELIMITER/模式变更/首错停止和 SQLite trigger/CASE/字面量执行。对象保存3项通过，SqlEditor67项通过及4项MySQL只读字节往返验证。
- 脚本成功执行条数不等于提交条数，任意 SQL 文件不保证整文件原子。原生 DuckDB/Oracle/SQL Server 阻塞任务取消后仍可继续到驱动返回，不能宣称即时中止。尚无桌面挂载交互、所有数据库实服/版本矩阵或 RSS 硬件验收。整体审计目标保持进行中。


### 第四次复审目标库补充

- PostgreSQL/KingBase/OpenGauss 的 UI schema 不再覆盖物理数据库名；在实际池连接上绑定参数设置安全引用的 search_path。Oracle 普通查询及 BEGIN 在实际专用会话设置选中 owner；SQL Server BEGIN 使用选中数据库。
- DuckDB 实际验证 catalog 存在、同锁切换后执行原 SQL，选中目标参与连接缓存身份；SQLite 新会话没有 ATTACH 时拒绝非 main，不能默默写入 main。上述映射/引用测试及编译通过，尚不宣称 PG/Oracle/Duck 原生实服验收。

## 第五次库表结构及数据比对专项（2026-11-14）

### 已证实并修复

- 整库结构比对原先逐表 IPC，较早表的元数据锁提前释放，其后 ALTER 不影响末尾表名复查，可误报一致。现在单次后端调用持有双方已捕获全部普通表的 MDL，直到差异构建及最终复查完成。
- 实库证实默认 RR 的 information_schema 表清单复查会看不到新建表，现结构读取用 READ COMMITTED 并复查对象名/类型和数据库原始默认定义。逐表授权可漏看其他表，整库结论要求可证明的直接库级或全局 SELECT/TRIGGER 可见性，角色授权尚不能证明则拒绝完整结论。
- 数据 FLOAT 文本协议把实际不同的 1.0000001192092896、1.000000238418579 都编码成 1，曾误判一致。现在只读投影把 FLOAT 精确拓宽成 DOUBLE 后传输；不修改存储数据、DDL。实库生产分页游标回归先失败后通过。
- SET 空集合和选中空成员都显示空串，ENUM 非严格历史错误序号0与空成员序号1也同样空串；现按实际无符号位图/序号读取，保留 NULL，结果附带 column_encodings，界面明确表示方式。实库先失败后通过。
- 前端 NULL 与空字符串曾被合并显示、二进制和 0x 文本混淆；现类型元数据区分 NULL/空串/缺列/带引号文本/二进制。请求同步保留执行权，旧请求不能解除新请求状态，连接/库/表/主键与元数据、结果、进度、复制反馈绑定。
- 全量比对使用同一 scan_comparison 核心供 IPC 与实库测试；跨2000行分页、与声明顺序不同的复合整数主键、u64最大值、源独有1/目标独有1/差异252的完整计数及200条样本上限实测通过，再恢复相同内容后完整计数归零。只读，不生成数据同步 SQL。

### 当前证据及限制

- 最新完整 Rust：288通过、21默认忽略、0失败；cargo check通过。19项隔离 MySQL 集成测试显式运行全部通过（其中包含新增结构快照、浮点、ENUM/SET、完整归并计数、导入、取消及迁移）；剩余 PostgreSQL/DuckDB 两项未实跑。
- 最后UI表示补丁后，前端197项全部通过；TypeScript、生产构建、数据库功能注册静态检查及 git diff --check 均通过。实库测试使用专用33387隔离实例，UUID夹具及账号已清理；未操作业务数据库。
- 数据比对仍限 MySQL 族 InnoDB 基础表、同字段结构及完整非空整数主键；不支持的引擎/类型或超预算明确报错，不能当作一致。双方快照独立建立，不代表跨服务器共同瞬间。
- 整库结构仅涵盖普通表与库默认定义，不含视图、存储程序、事件、权限；触发器与无法完整生成的索引/约束/表选项差异明确拒绝。不能阻止其他会话新建表/改库默认值，最后复查后也存在变化窗口，须暂停DDL；不能声称在线全库全局快照或之后手工执行DDL有事务保证。
- 以上为真实MySQL核心执行与前端逻辑/静态联调证据，未代替完整桌面点击、全引擎版本矩阵、macOS触摸板和RSS验收，整体软件审计不作绝无bug承诺。


## 第六次导出与迁移类型保真复审（2026-11-14）

本轮继续取得新的真实缺陷和代码修改，上一轮属于有效进展；整体软件审计仍进行中。

### 已复现的问题与修复

- SQL表导出将ENUM/SET当普通字符串，实际往返使SET('','a')的位图1变为0、位图3变为2，ENUM历史错误序号0变为正常空成员1。已先取得MySQL行为失败，再将表SQL导出的读取投影改为CAST AS UNSIGNED并alias原列；INSERT列名仍原名，DDL不改。数值标签也按序号回放。任意查询结果中的原始ENUM/SET若不能证明成员身份明确拒绝生成SQL，提示使用表导出或显式数值投影。
- 流式文本/Excel及表导出曾将类型解码失败的非空值伪装成NULL，零日期实库复现。现先区分协议真NULL，再检查类型解码，失败终止并不发布临时文件；二进制统一十六进制表示，YEAR和有符号TINYINT(1)兼容实测通过。SQL零日期仍明确拒绝，不能宣称已支持零日期回放。
- PostgreSQL导出open_conn仍把选中schema覆盖物理数据库，SQLite也默默接受新会话不存在的附加库别名。复用引擎感知目标选择，PG实际专用连接初始化后绑定参数设置引用后的search_path，SQLite main保留、附加别名前置拒绝；不改用户SQL及保存的连接。

### 迁移与原生导出追加修复

- 活动流式迁移使用CAST CHAR源读取及指纹校验，合法SET空成员的不同位图经迁移会合并，旧指纹仍一致。已取得真实drive_stream路径失败证据，源改为ENUM序号/SET位图的规范十进制文本，目标绑定值显式CAST AS UNSIGNED，锁内目标校验使用同一规范投影。原始完整DDL保持；不会把字符串数字标签误作枚举名称。SHOW COLUMNS完整声明识别，不能依赖把ENUM/SET显示成CHAR的协议类型标签。
- MySQL迁移零日期在严格模式写入失败时，不降级模式、不变成NULL，整个请求失败且旧正式目标保留；实库drive_stream故障路径通过。活动跨连接迁移的FLOAT/DOUBLE/二进制/BLOB/BIT仍因现有保真边界前置拒绝，不能冒称已支持；同服务器原生表复制的二进制原始指纹路径不受此限制。
- 原生文本/XLSX导出8个分支统一目标选择：Oracle保留service/SID，在实际流会话设置owner；DuckDB同锁验证/切换catalog后COPY，目标参与既有缓存身份；SQLServer/ClickHouse保留物理库选择。未重写用户SQL。Oracle/DuckDB没有真实原生驱动验收，只有目标映射/引用/编译证据。

### 本轮最终验证

- Rust完整293通过、25默认忽略、0失败；cargo check通过。23项MySQL隔离实库测试显式全部通过（含SQL导出SET/ENUM往返、非空解码错误、活动迁移SET/ENUM、零日期失败保留旧表），剩余PostgreSQL/DuckDB两项未实跑。
- 前端197项通过，TypeScript、生产构建、数据库命令注册静态审计及git diff --check通过。未操作业务数据库。
- SQL表导出是保真回放通道；CSV/TSV/Markdown等展示格式并不等于数据库备份，二进制以十六进制展示但纯文本相同字样在无类型格式中仍可相同，NULL/空字符串也依格式能力受限，不能承诺这些格式完整往返。
- 本轮未完成全部数据库实服、断电/磁盘故障矩阵、桌面RSS或macOS触摸板真机验收；整体目标继续进行，不据单轮绿测宣称软件绝无bug。


## 第七次只读隔离、并发编辑与结果导出复审（2026-11-14）

前轮取得真实修复及集成证据，属于有效进展。当前轮次仍以现工作树和实际执行为准。

### 根因与当前修复

- JSON/JSONL用列名构造对象，SELECT两列同名时后值静默覆盖前值；实际失败回归证明两列变一列。RowWriter现在对对象格式及SQL格式拒绝重复列（MySQL/SQLServer SQL列名还按大小写折叠检查），逐列唯一别名正常；CSV等位置格式保留两列不改名。行/字段形状不一致也拒绝，错误逐引擎传播，已有文件不被替换。真实SQLite重复投影配合临时文件发布路径验证通过。
- XLSX把所有可parse f64的数据库数字当Excel数值，BIGINT/高精度DECIMAL会在Excel中舍入；现超过15位有效数字、溢出/下溢/非有限值以inlineStr保留完整数字。实库读取u64最大值和高精度小数并解压XLSX检查XML，精确文本与普通123.5数值各自保留。
- XLSX XML文本原先把NUL等控制字符替为空格、CR受XML行尾归一化、字面量_x0041_可被Excel解释成A。现按OOXML转义保留控制字符、CR及FFFE/FFFF，并转义字面量OOXML前缀；先失败后通过。
- 只读导出入口原先允许SQL绕过普通编辑器检查；SQLite文件只读模式仍允许TEMP表写入。实际SQLite回归先确认query_only=0及TEMP写成功，修复为所有只读配置实际会话query_only=ON。导出创建临时文件前及实际配置连接处均校验单条只读SQL，拒绝隐藏DML、写入会话指令及可执行注释；Oracle同一流会话开启READ ONLY事务，Duck保留原生只读模式。

### 并发编辑与结果身份追加

- 单项/批量UPDATE原先只按主键定位，保存时FOR UPDATE也不能检测用户读取后其他会话已提交的新值。现在IPC携带每个修改字段原始值，MySQL/PG/SQLite在事务内读取锁定目标、核验字段及主键的真实非空状态和精确显示基线再修改；有一项冲突整批回滚。MySQL大小写、尾空格及NULL变化和SQLite整批回滚已实库验证。其他未修改字段的并发变化不会被覆盖；不是完整行版本号/ABA检测。
- 前端旧parser允许表达式伪装主键/列别名，现只给能证明裸列/同名别名、主键齐全且不重复的单表结果启用编辑；集合操作/注释/复杂结果保守不启用。支持常见裸列、限定列、表别名、星号；不是通用SQL语义解析器。
- 单条结果捕获实际execute所用schema，元数据与结果对象绑定，切库及新结果异步加载阶段不给旧editCtx写入。多结果及手动事务会话可能自行USE/SET search_path，当前不能证明实际源身份，暂不提供结果网格写回；原始SQL执行能力不受此限制。
- SQLServer/Oracle在专用实际事务/表锁下核元数据，原始字段及主键采用字节谓词而非不区分大小写的collation等值，影响行数须1。已有原生事务编排回归通过，尚无实际服务验证。
- 无法从显示值精确恢复的类型拒绝行内覆盖：MySQL浮点/二进制/BIT/ENUM/SET/生成列，PG未知或复杂类型，SQLite BLOB等；支持范围以实际类型守卫为准。原生SS/Oracle只接受已限制的文本/精确数值字段与键，日期/LOB等不冒充已验证。用户仍可审阅执行明确SQL，不擅改DDL。

### 本轮最终集成证据

- Rust完整302通过、27默认忽略、0失败；cargo check无警告通过。25项隔离MySQL测试显式全部通过；剩余PostgreSQL/DuckDB两项未实跑。真实SQLite只读/重复投影/冲突测试包含在常规套件。
- 前端200通过、TypeScript、生产构建、数据库功能注册静态检查、git diff --check通过。XLSX实际MySQL读取大整数/小数并检查ZIP内XML，证明精确字符串存储，未在本机Excel应用做人工打开验收。
- 只读限制并非任意SQL沙箱：带自主事务/外部副作用的SELECT函数不能靠词法护栏完全封禁，需正确服务端授权。不声称原生OCI/Duck/SS已通过实服、全版本或桌面硬件验收。
- 专用33387测试实例独立于业务库；先前失败的四个明确UUID标量夹具已清理。本轮不提交、不推送、不操作业务库；整体审计继续，不作绝无bug保证。

## 第八次资源生命周期与删除并发复审（2026-11-14）

- 结果编辑身份强引用导致旧结果关闭后仍被持有，现改为 WeakRef。显式 GC 专项 3 项通过；隔离 Node 150000 行探针强弱引用堆占用相差 38385000 字节，这是所有权实验，不能等同桌面 RSS 节省。
- MySQL/PG/SQLite 静态连接池及数据库隧道缓存增加闲置 300 秒、每 60 秒检查的引用清理，不调用 pool.close 或中断活跃事务。MySQL/PG pool options 独立持有隧道守卫；真实 SQLx 借用生命周期测试和缓存清理策略共新增 4 项通过。没有真实 SSH 隧道寿命或桌面 RSS 测量，时间上限也不是缓存条目数量硬上限。
- 网格删除原先仅按主键，可删除其他会话已修改的行。db_delete_rows 现强制原始选中字段基线，在同一事务校验并删除，任一冲突整批回滚。SQLite 历史实现取得真实失败证据；MySQL 大小写冲突、后项冲突整批回滚及正常删除专项通过。TableBrowser 确认框冻结选中行副本及目标，并补齐 UPDATE 原始值参数。
- DuckDB 新删除路径按既有机制选择 catalog 后 BEGIN；SQL Server 谓词使用 Unicode N 前缀。原生 Oracle/SQLServer/DuckDB 尚无实服认证。基线仅覆盖显示选中字段，不检测未展示字段变化或 ABA；独立 Oracle ROWID 删除命令不在该修复内，不能宣称所有入口已经覆盖。
- 删除专项 4 项通过，报告 /tmp/dbterm-r8-delete-safety-audit.md；资源报告 /tmp/dbterm-r8-pool-lifecycle.md。最终集成计数见后续章节，不宣称跨服务器 A/B 分布式原子性。

## 第九次结构与数据比对专项复审（2026-11-14）

### 已复现与修复

- MySQL 数据比对继承 latin1/GBK 结果字符集，服务端将不同 Unicode 值替换为相同问号。真实 scan_comparison 修复前错误返回 total_mismatch=0。现每侧专用比对会话在元数据、快照和数据读取前 SET NAMES utf8mb4，只改变传输，不改用户 SQL、DDL、保存连接或库表默认字符集/排序规则。真实回归在 latin1 和 GBK 下均识别差异并精确保留原始样本。
- SQLite 内部对象过滤使用 LIKE 'sqlite_%'，下划线被当任意字符，合法 sqliteXlegal 表被跳过，TEXT/INTEGER 差异漏报。真实文件库回归先失败，改为 GLOB 'sqlite_*' 精确匹配下划线后通过；SQLite 比对专项 3 项通过。
- DuckDB/SQLite 文件库比对切换目标后可能展示旧结果并接收旧响应。增加源/目标选择键及请求代次，切换和卸载废弃旧响应，渲染同步校验归属，不等待 effect 才隐藏。专项 3 项通过，含异步切换后再切回的所有权验证；面板接线测试不等于浏览器端人工验收。

### 覆盖范围与证据

- MySQL 数据比对专项 18 项通过，其中 7 项为隔离实库，覆盖复合主键跨批、64 位边界、FLOAT、ENUM/SET、二进制、NULL、并发写及有界样本。支持范围仍为 MySQL 族 InnoDB 基础表、完整非空整数主键及匹配列签名，不支持情况报错。两侧独立快照不代表跨服务器同一业务时点；比对不写回数据，不从有限样本生成可执行同步 SQL。内存预算不是进程 RSS 硬上限。
- SQLite 数据目前仅比行数，明确标注内容未校验；DuckDB 仅表名及列名/类型摘要，明确排除完整结构和数据结论，不能解读成完整数据校验。
- MySQL 库结构当前范围是库默认定义、普通表清单与表定义，视图、存储程序、权限不在一致结论内。不能完整生成的索引、约束、顺序等差异明确报错，拒绝部分同步语句不代表已提供完整自动同步能力。
- 行为证据：/tmp/dbterm-r9-compare-charset-red.log、/tmp/dbterm-r9-compare-charset-green.log、/tmp/dbterm-r9-data-compare-all.log、/tmp/dbterm-r9-sqlite-prefix-red.log、/tmp/dbterm-r9-sqlite-prefix-green.log、/tmp/dbterm-r9-file-owner-red.log、/tmp/dbterm-r9-file-owner-green.log。

### 结构补充与最终集成验证

- StructureDiffPanel 原有异步归属校验之外，补齐同步渲染归属校验，切换库表的当前渲染帧不再展示旧一致徽标、差异列表或旧 ALTER；可复制 SQL 同样以当前选择为准。回归验证选择变化即返回空结果。
- 新增真实 MySQL Unicode/函数索引回归：中文标识符和注释、emoji 默认值、NULLIF 表达式唯一索引读取完整；相同定义通过，函数索引改普通唯一索引明确拒绝生成部分同步 SQL，注释不同被检出且生成内容复用源 SHOW CREATE 定义。默认值的十六进制写法来自服务器 SHOW CREATE 输出，不是客户端私自修改用户 DDL。未对业务库执行 ALTER。
- 最终 Rust 常规测试 310 通过、30 默认忽略、0 失败；cargo check 无警告通过。显式选中隔离 MySQL 测试 28 项全部通过，剩余 PostgreSQL 和 DuckDB 两项未实跑。第一次集成筛选遗漏 PostgreSQL 测试名，因缺少其测试 URL 失败；纠正为精确排除该测试后获得本计数，未将缺少服务的失败解释为数据库功能通过。
- 前端 207 通过、1 项 GC 测试默认跳过；显式 --expose-gc 单独运行 3 项均通过。TypeScript、生产构建、数据库功能注册审计与 git diff --check 通过。最终日志 /tmp/dbterm-r9-final-{rust,check,mysql,npm,tsc,build,features,gc}.log。
- 本轮不提交、不推送、不操作业务数据库。原生 Oracle/SQLServer/DuckDB、跨版本矩阵、断电/网络故障、macOS 触摸板与桌面 RSS 仍未完成全面验收，整体审计不据本轮绿测宣告全软件绝无 bug。

## 第十次原生授权与 SQLite 恢复复审（2026-11-14）

### Oracle 原生写入口

- 确认原生 Oracle 查询、ROWID 修改/删除、插入、DDL、用户/权限/会话/分区管理 IPC 没有统一检查 readOnly，能绕过通用 SQL 编辑器护栏。真实生产 helper 测试修复前对只读 INSERT/DELETE 继续走到驱动查找而不是授权拒绝，两项测试实际失败（/tmp/dbterm-r10-oracle-red.log）；未发送 SQL 至原生服务器，不冒称实服写入复现。
- 增加 Oracle 类型校验、只读写入拒绝和专用 write loader；16 个管理 IPC 在凭据与驱动加载前校验，内部 INSERT/UPDATE/DELETE 及写 PLAN_TABLE 的 EXPLAIN 同样检查。读取凭据的错误不再静默当无密码继续。
- 原生查询及流式查询在实际连接前校验只读 SQL，拒绝写入、会话修改、FOR UPDATE 和多语句；token 校验保留字符串字面量中的 DELETE/分号。只读普通查询及手动事务在实际会话设置 SET TRANSACTION READ ONLY，schema 选择保持在同一连接。用户原始 SQL 不被重写。
- Oracle 专项 16 项通过，含 readonly 原生 INSERT/UPDATE/DELETE、错引擎、单查询策略、20 个写入口接线及既有事务回滚编排。/tmp/dbterm-r10-oracle-final.log。没有 OCI 实服，因此不宣称 Oracle 端到端认证，也不把 SELECT 中自主事务函数等外部副作用当作词法校验能完全封禁。

### SQL Server 原生管理授权

- native loader 未校验连接引擎，KILL 与 Query Store force/unforce 绕过只读限制，EXPLAIN 可执行调用方 SQL 却未校验。现在配置入口、直接查询分发、行内更新、管理 write loader 与 EXPLAIN 均在凭据/网络访问前检查类型及策略。生产 helper 两项实际失败后，新增专项 5 项通过。
- 证据 /tmp/dbterm-r10-sqlserver-red.log、/tmp/dbterm-r10-sqlserver-final.log、/tmp/dbterm-r10-sqlserver.md。未进行 TDS 实服认证，KILL 完成响应消费、EXPLAIN mode/error cleanup 仍需单独验证；不是全引擎任意 SQL 沙箱证明。

### SQLite 真实文件回归与修复

- 管理连接忽略 global readOnly、sqliteReadonly、sqliteImmutable，真实临时库 UPDATE/TEMP CREATE 可成功。现实际 readonly 打开并设置 query_only，VACUUM/ANALYZE/optimize/WAL/PRAGMA/ALTER/序列重置/恢复均前置写权限校验，只读锁诊断不再执行 checkpoint。受控只读备份到新文件仍允许。
- dump/rescue 用 File::create 可截断已有输出甚至源库的硬链接。现写私有暂存、flush/fsync 后用 hard_link 原子发布且不覆盖；已有文件/链接、源库及 WAL/SHM/journal 路径拒绝，发布竞争也保留并发产生的文件。文件系统不支持硬链接时明确失败，不降级覆盖。
- 旧恢复逻辑 rename 当前库、删除 WAL/SHM 后复制，真实 WAL 场景恢复成功但已有连接读 7、新连接读 11。现先完整性检查和 VACUUM INTO 归档，再通过锁定 SQLx native handle 的 sqlite3_backup 写入原目标 inode；成功后旧连接及新连接均读 11，写锁竞争失败保持原值 7。原有读事务仍遵守 SQLite 快照语义。
- 同源备份 canonicalize 不能识别硬链接，实测仍允许恢复并创建归档。增加 same-file 直接依赖，按跨平台文件身份在归档前拒绝同物理文件；本机回归通过，Windows 尚未实跑。
- dump/rescue 的 LIKE sqlite_% 同样漏掉合法 sqliteXlegal 表，改为 GLOB 后两种真实导出再回放均保留值 17。专项 8 项通过，含只读、覆盖拒绝、发布竞争、BUSY 回滚、已有连接恢复和导出回放。报告 /tmp/dbterm-r10-sqlite.md，行为失败及通过日志 /tmp/dbterm-r10-sqlite-{policy-red,output-red,restore-red,alias-red,final}.log。

### 本轮边界与后续审计

- SQLite rescue 仍按表 fetch_all，dump 尚未建立整库一致性快照，简单 ALTER 多条执行缺少整体事务，PRAGMA 可写参数校验仍需专项修复；这些不是本轮已解决事项。归档与实际恢复是两步，期间并发写入不保证归档等于替换前最后瞬间；不宣称全库恢复业务协调已完整解决。
- native backup_step(-1) 同步运行，未验证大文件性能/RSS、取消、断电矩阵。Oracle OCI 文本截断/字符解码与 ROWID 并发基线仍有待原生实服验证，不以只读修复替代数据保真认证。

### 最终验证

- Rust 常规集成 324 通过、30 需要外部服务的测试默认忽略、0 失败；cargo check 无警告。前端 207 通过、1 项 GC 默认跳过，显式 GC 专项 3 项通过；TypeScript 与 git diff --check 通过。日志 /tmp/dbterm-r10-final-{rust,check,npm,tsc,gc}.log。本轮原生驱动与授权/SQLite 改动未重新启动 MySQL，也未将默认忽略项目当成实测通过。
- 前次 SQLServer 子审计全套在根代理修改中途曾遇 Oracle 字符串字面量误拦截失败，已修正为 token 校验并重跑，本节最终全套全部通过。
- 未提交、推送或操作业务库；本轮不涉及 SSH 侧代码。已知尚未完成项继续保留，整体专业软件审计目标不标记完成。

## 第十一次 SQLite 导出与 ALTER 原子性复审（2026-11-14）

- dump/rescue 原 SELECT 星号会写入生成列，实际回放失败；导出先建触发器会重复执行业务触发器；虚拟表数据和自增高水位遗漏。现共享导出核心用单一读取事务、显式普通字段、流式读取，按表定义、数据、自增序列、索引/视图/触发器顺序回放；原对象 DDL 原文保留。真实回放验证生成列、触发器仅执行一次、FTS 可检索 rowid41、自增99、合法非影子表。
- 字段序列化按实际存储类型处理，TEXT 用 hex CAST 保留 NUL/非法 UTF8 字节，BLOB、整数、REAL/Infinity 保留；解码错误不再降级 NULL。脱敏保留文本中的单引号正确转义。无内容 FTS 无法从可见字段重建索引，普通逻辑导出明确拒绝并提示文件备份，rescue 标记不完整，不冒充完整备份。
- 导出专项6项及既有SQLite边界8项通过，包含导出期间并发提交仍读取同一快照、5002行流式抢救回放。消除按表 fetch_all/OFFSET 扫描，不保证单个超大字段或进程 RSS 硬上限；长事务可能保留 WAL 页。元数据与当前行仍占内存，扩展私有状态及全部数据库 PRAGMA 不属于逻辑导出完整物理复制承诺。报告 /tmp/dbterm-r11-export.md。
- ALTER 原先多条逐项提交；foreign_key_check 返回违规记录却继续提交；按分号换行切脚本拆坏触发器。已取得真实失败证据，改为 SQLite 语句边界解析、事务整体执行、检查外键结果再提交，生产入口在元数据规划前 BEGIN IMMEDIATE，并恢复实际原外键设置。
- 旧分类器忽略已有字段 type/default/null 修改而报告成功；重建按简化字段合成会丢 CHECK/FK/UNIQUE/COLLATE/AUTOINCREMENT。现在从原始 CREATE AST 修改受支持属性，保留原选项及约束；生成列不直接 INSERT。SQL 会规范化格式，不承诺与原DDL逐字相同；不涉及复制迁移原文通道。复杂混合操作或无法证明支持的定义明确拒绝。
- 重建在删除源表前检查行身份、数量、typeof、二进制比较及hex，阻止 TEXT 001 变 INTEGER1 等隐式转换；自增高水位和可访问 rowid 保留。ALTER字段片段注入 COMMIT/DELETE 曾真实删行，现普通ALTER仅接受单条同目标ALTER并校验新列定义。预览确认与当前目标/字段绑定，改动字段后不能沿用旧确认。
- 最终本轮后端常规集成347通过、31默认忽略、0失败；日志 /tmp/dbterm-r11-final-rust.log。新增SQLite-only SQL reader实例的非SQLite方法未使用警告已局部说明并抑制，后续cargo check复验。ALTER专项11通过；前端功能追加前208通过1跳过、类型检查及生产构建通过。后续表格剪贴板功能需追加最终集成记录，不能沿用此计数冒称新功能验收。
- 源证据 /tmp/dbterm-r11-alter-red.log、/tmp/dbterm-r11-alter-injection-red.log、/tmp/dbterm-r11-alter-all.log、/tmp/dbterm-r11-export-final.log、/tmp/dbterm-r11-export-boundaries.log、/tmp/dbterm-r11-alter-review.md。高级SQLite依赖/特殊语法、原生服务、硬件性能矩阵仍未完成全面认证，整体目标继续。

## 第十二次表预览剪贴板功能与安全复审（2026-11-14）

- 表预览支持单格、Shift 连续矩形、列选择按钮及 Ctrl/Cmd 多列、Shift 连续列复制粘贴。普通列标题点击仍为排序。单个值填充选区，多行多列文本从单格锚点展开或与明确选区严格匹配；仅限已加载当前页，不自动新增行。
- 粘贴先暂存，显示待保存数，可撤销；点击保存只调用一次现有 update_cells，按行分组携带完整显式主键及原始字段值。原值冲突整批回滚；只读、主键/生成列、元数据缺失、越界、无可靠事务支持引擎拒绝整次粘贴。成功后重新读取数据库结果，不以本地请求值代替触发器/转换后的实际值。提交异常后禁止直接重试，需核验并撤销刷新。
- 暂存期间禁止页码/每页数量/排序/筛选变化与刷新及其他写入口；异步结果用目标和代次隔离。修正 StrictMode 挂载状态、非活动表响应粘贴、多个可见表响应全选、旧请求错误串入新表问题。原生剪贴板异步读取捕获发起时选区。字段详情与置 NULL 补齐原始值基线。
- 普通文本没有数据库 NULL 类型：复制 NULL 显示为文字 NULL，粘贴 NULL 保持字符串；真实空字段粘贴为空字符串，数据库空值使用明确的置 NULL 操作。不再按剪贴板文字碰巧相同推断类型，也不保留全局敏感剪贴板矩阵。
- 剪贴板解析最多10000格，累计暂存最多10000格；按原值/新值/主键的保守序列化体积设置8MiB预算，拒绝大字符串整列填充导致IPC体积倍增。渲染用索引Map。该预算不是整个桌面进程RSS硬上限。
- Chrome运行实际TableBrowser组件并启用React StrictMode，通过单格复制到另一行/显式保存、连续两列复制与标量填充、待保存禁止排序、一次IPC按行分组、矩阵展开及撤销不写入四组交互。后端与剪贴板使用本地夹具IPC，不连接业务数据库；不能代替Tauri WKWebView/macOS系统剪贴板手工验收。
- 增补真实DOM ClipboardEvent回归：图片粘贴原先因为getData返回空字符串会暂存清空字段，取得失败证据后增加text/plain类型检查；复跑通过。日志 /tmp/dbterm-r12-nontext-red.log 与 /tmp/dbterm-r12-browser.log，临时浏览器依赖和夹具均位于/tmp，项目依赖清单未更改。
- 最终后端常规347通过、31默认忽略、0失败；cargo check无警告。前端214通过、1跳过（含剪贴板6项纯行为测试），TypeScript及生产构建通过；功能注册审计与git diff --check通过。日志 /tmp/dbterm-r12-final-{rust,npm,build,features}.log、/tmp/dbterm-r11-post-check.log。最后非文本粘贴修复后重跑前端测试及构建。
- 独立复审另外在隔离MySQL8.4运行源表DDL保真复制/迁移两项测试通过，包含用户提供函数索引、字段注释、默认值及字符集；实例已停止。不以此宣称所有数据库、所有DDL或跨服务器分布式事务已经全面认证。整体审计仍未完成全部原生服务/故障/桌面硬件矩阵。

## 第十三次表预览新增事务与复制值保真复审（2026-11-14）

### 已确认的问题与修改

- TableBrowser.commitDrafts 仍循环调用 execute_query，一行一提交；后行约束失败会保留前行写入，也存在前几行成功后才发现后续草稿全空的情况。现新增 db_insert_drafts IPC，前端先验证全部草稿并只调用一次，后端在一个专用连接事务执行不同字段集合的所有行。空输入仍表示省略字段使用该行默认值，不以统一字段并补 NULL 改变默认值。
- 原 sqlLiteral 将文字 NULL 转数据库 NULL，001 转数字1，还把 SQLite 文本 true/false 改成整数。新增参数化草稿保留原始字符串；复制 INSERT 与确认摘要改为区分真实 null 和普通文字。MySQL 复制文本用UTF8十六进制CONVERT避免反斜杠SQL模式差异，PG用E字面量转义反斜杠，SQLServer用N前缀，SQLite含NUL文本用hex CAST。只影响由网格数据生成的INSERT，不改源表DDL或用户SQL。
- 新增提交在生产确认前同步预留busy，冻结目标/行/字段快照，确认后校验归属；提交中禁改草稿、重复保存及导航。已发送后任何异常均禁止直接重试，保留核验提示。提交成功后清草稿，再读真实数据库，不把刷新失败解释成写失败。
- 真实Chrome夹具复现：新增提交中父组件切换另一张表，旧busy阻止新表fetch，旧请求结束后新表永远未加载。现在保留最新reload引用，旧请求完成后仅刷新当前目标；取得先失败后通过证据。原粘贴同类结束路径一并修正。

### 后端约束与性能

- MySQL仅允许既有InnoDB/可验证触发器/严格模式等原子性条件；相邻同字段行最多200行及65535参数一批，所有批次仍共用单个事务，警告拒绝提交。隔离MySQL8.4真实测试保留不同字段默认值及文字NULL，超过400行后段主键冲突验证前面批次全部回滚。
- SQLite真实文件库覆盖各行不同默认值、文字NULL、真实NULL、后行唯一约束失败及只读前置拒绝；显式开启外键。PG在同一事务只读取一次目标类型元数据，TEXT协议参数先::text再CAST至按namespace/name引用的真实类型，避免整数/布尔二进制协议错配。PG已新增编译通过的实服测试，但本机无PostgreSQL服务，未实跑。
- DuckDB选择实际catalog后执行专用事务；SQLServer沿用专用连接/XACT_ABORT事务；Oracle使用专用OCI事务，空schema不再生成空标识符，空字符串会被Oracle隐式转NULL，故明确拒绝而非假称保真。原生服务未做端到端认证，SQLite替身仅证明共用事务编排，不证明驱动实现或全部触发器副作用。
- 前后端验证最多10000行、后端单行2000字段、8MiB负载、字段数量/重复字段/标识符/只读属性；前端保守预算按JSON编码长度乘3。边界不是整个进程RSS保证；跨服务器仍没有分布式原子性保证。

### 实测与边界

- 前端新增5项行为测试通过，覆盖单次批量调用、后续空行导致零写入、不同字段默认值、文字NULL/001、预算、未知提交不自动重试、方言转义。Chrome实际TableBrowser+StrictMode夹具通过单次批量IPC、两行不同字段、防重复/不确定提交禁止重试、提交中切表后加载新表；原剪贴板四组交互复跑通过。浏览器后端和剪贴板是夹具，不是Tauri打包版或实库UI端到端证明。
- 后端新增专项5项通过（含显式运行的隔离MySQL），Oracle空schema目标单测另1项通过；常规完整352通过、33默认忽略、0失败，cargo check无警告。前端219通过、1默认跳过，TypeScript与生产构建通过，功能注册审计和git diff --check通过。没有操作业务库，没有提交或推送。
- 日志 /tmp/dbterm-r13-{drafts-red,copy-sql-red,target-red,draft-browser,clipboard-regression,final-npm,final-build,final-rust,final-check,final-features}.log；后端 /tmp/dbterm-drafts-final.log。测试文件 src/components/DbTools/tableDrafts.test.ts、tableDataSql.test.ts 和 src-tauri/src/commands/draft_insert.rs。最初后端专项调用工作目录错误的失败未计为通过，最终明确使用src-tauri工作目录执行。
- 仍需继续受控验证原生Oracle/SQLServer/DuckDB、PG实服、断网/断电/取消、打包版WKWebView和macOS硬件交互及整体RSS。审计目标保持进行中，不能将本轮绿测解读为整个数据库软件绝无bug。

## 第十四次 PostgreSQL 实服写入与并发结构变更复审（2026-11-14）

### 环境与实际失败证据

- 前轮PostgreSQL测试未运行，本轮安装本地PostgreSQL17.12后新建/tmp/dbterm-r14-pg-9a881e37私有集群，独占127.0.0.1:33391。仅临时UUID schema，不连接业务库；没有启用brew后台服务。软件安装附带的默认空集群没有启动，测试结束仅停止本轮私有实例。
- 普通结果页db_insert_rows的PG路径把所有值以TEXT参数直接INSERT；真实INT列报 column id is of type integer but expression is of type text，两项新实服测试修复前实际失败。此问题不同于上轮db_insert_drafts路径，后者本轮实跑原有INT/NUMERIC/BOOL场景通过。
- 修复pg_insert_rows：同一事务读取目标真实字段类型（类型所属schema和名称均按标识符引用），TEXT参数明确::text后CAST目标类型。不按输入字符串猜数字/NULL；UUID、数组、JSONB和domain遵守服务器类型约束。每次操作只读一次字段元数据，仍按200行/65535参数分批且整批共用事务；draft路径复用同一元数据helper。
- 进一步实测发现元数据读取不会阻止另一个连接在INSERT前ALTER字段，实际并发测试先失败。现读取类型前在写事务取得ROW EXCLUSIVE关系锁，保持目标定义直到提交/回滚，允许普通并发DML。真实第二连接100ms lock_timeout证明ALTER被阻止；事务结束释放。该锁不会取消或替换用户业务事务，也不等同跨服务器锁。

### 实服覆盖

- 新增：整数、精确NUMERIC小数、BOOL、前导零文字、UUID、数组、中文JSONB；超过200行后段转换错误保持前批零写入；VARCHAR长度溢出不静默截断；domain约束失败整批回滚；不同字段草稿保留默认值、后行主键冲突回滚、domain/数组/长度约束；旧有跨块重复主键事务回归。
- 更新：原有CAST参数路径在真实PG17修复前已通过，未据推测修改生产代码。新增实服测试覆盖INT/BOOL/DATE、大小写/尾空格/NULL原值基线、后项过期/UNIQUE/CHECK失败整批回滚、非唯一定位拒绝、反序传入复合主键仍精确定位。NUMERIC/UUID/JSONB网格更新仍因无法恢复精确基线明确拒绝，需显式SQL；不能将新增能力误报为更新全部类型能力。
- 删除：3项真实测试覆盖整数复合主键准确删除、大小写/尾空格/NULL基线变化拒绝、后项过期导致前项回滚。受测路径没有复现新缺陷，仅新增测试，未改删除生产逻辑。浮点、原生扩展类型及所有并发调度不在本轮证明范围。

### 最终验证与范围

- 显式两组过滤pg_与postgres_共9项实服测试全部通过（7+2，0忽略）。常规完整352通过、40默认忽略、0失败；新增外服测试默认忽略但已按上述9项显式运行，不能把40项全部解读为未验证或已验证。cargo check无警告，前端219通过1跳过、TypeScript通过，git diff --check通过；本轮仅改Rust后端及测试，没有修改前端源码，生产构建沿用上一轮证据，不冒称新跑。
- 证据 /tmp/dbterm-r14-insert-red.log、schema-race-red.log、insert-green.log、schema-race-green.log、draft-live.log、final-pg.log、final-rust.log、final-check.log、final-npm.log、final-tsc.log（均带dbterm-r14-前缀）；更新基线通过日志 /tmp/dbterm-r14-update-baseline.log，最终 /tmp/dbterm-r14-update-live.log，报告 /tmp/dbterm-r14-pg-update.md。元数据锁测试及类型保真测试位于pg_insert_fidelity_tests.rs，删除专项pg_delete_fidelity_tests.rs。
- 结束核验所有本轮UUID schema已删除，pg_ctl fast停止私有集群，未留33391监听；数据目录与日志保留供追溯。Homebrew新增PostgreSQL17.12及依赖的本地安装仍保留。
- 仍未完成Oracle/SQLServer/DuckDB实服、其他PG版本/兼容引擎、故障注入/取消、打包版WKWebView/macOS硬件及整个进程RSS验收。本轮不提交、不推送，整体专业数据库软件审计目标继续保持进行中。

## 第十五次手动事务提交结果准确性复审（2026-11-14）

- 实际PostgreSQL17.12复现严重结果误报：BEGIN后第一条INSERT成功、第二条主键冲突，连接进入失败事务；用户点击提交时服务器以ROLLBACK完成COMMIT命令，SQLx execute返回成功，finish_transaction原来映射Ok，软件误报提交成功而实际数据为零。新真实测试修复前确实失败，非推测驱动协议缺陷。
- SQLx QueryResult不暴露CommandComplete标签，本次在持有原per-id串行门及事务锁时，COMMIT前用SELECT1检查事务。遇25P02只执行显式ROLLBACK，收到回滚确认后返回独立的已回滚结果，不再发送COMMIT或把已知回滚包装为未知；连接/回滚失败仍保守报告结果不确定，不自动重试。无论成功失败都移除原事务身份，排队旧操作不能复用。
- 真实回归3项覆盖失败事务提交不报成功、普通提交、ROLLBACK TO SAVEPOINT恢复后仍可正常提交、明确回滚、延迟唯一约束在COMMIT失败、pg_terminate_backend断连不报成功。前置探针只用于PG手动提交，增加一次往返；不改用户SQL、不改MySQL/SQLite/原生驱动结果逻辑。探针失败且非25P02不尝试提交。
- 前端事务按钮和脚本COMMIT两个入口统一已确认回滚提示，隐藏内部DBTERM_TX_ROLLED_BACK标记；后续脚本明确标为事务已回滚而非提交未知。未知提交仍提示核查禁止重复写。独立审阅找到脚本入口遗漏后已补齐，并新增2项纯函数测试；无Tauri桌面交互端到端验收，不把纯函数测试当作整页UI证明。
- 本轮专项真实PG3项通过；常规Rust352通过、43默认忽略、0失败，cargo check无警告。前端221通过1跳过（含新增2项）、TypeScript及生产构建通过，git diff --check通过。日志 /tmp/dbterm-r15-commit-red.log、commit-green.log、pg-final.log、outcome-red.log、script-red.log、final-rust.log、final-check.log、final-npm.log、final-build.log（均使用dbterm-r15-前缀）。首次重启私有实例漏传端口导致ConnectionRefused，仅属测试环境失败，修正后才取得真正COMMIT误报RED证据。
- 仅重启上轮私有测试目录/tmp/dbterm-r14-pg-9a881e37，端口33391，无业务库连接。临时表随连接关闭清理；结束由pg_ctl fast停止本轮实例。不提交、不推送，SSH侧代码未动。
- 边界：一次成功预检不能消除COMMIT期间断网的结果不确定，也不证明所有服务端扩展/非事务性外部副作用；原生驱动、取消故障与桌面验收仍需继续。整体目标保持active，本轮不据绿测宣称全软件审计完成。

## 第十六次手动事务取消与服务端锁复审（2026-11-14）

- 已确认并修复：db_exec_in_tx原先先等per-id事务门和事务锁，之后才登记取消令牌。真实SQLite生产执行helper测试持有事务门时反复取消均找不到令牌，修复前失败；现请求在等锁前登记，等门及等事务锁均可取消。尚未执行的排队请求取消只结束该请求，原事务保留，不错误回滚另一条正在执行的语句。实际执行阶段优先检查已收到的取消，防止随机select先启动被取消的SQL。
- 为直接测试生产逻辑，把IPC薄壳转发给execute_transaction；原校验、只读、行数预算及事务归属继续使用原路径。SQLite排队取消回归修复后通过。
- **尚未解决的真实问题**：PostgreSQL执行pg_sleep(30)期间客户端取消，客户端移除事务并断开连接后，服务端正在运行的语句及其先前行锁没有立即结束；另一会话1秒lock_timeout实际失败。日志/tmp/dbterm-r16-server-lock-red.log保留。不能把客户端future取消或map移除等同服务端已停止，也不能承诺锁立即释放。提示已改成客户端连接作废但服务端语句/锁不保证立即结束，禁止重复写。
- PostgreSQL目前SQLx版本未公开后端CancelRequest所需process_id/secret_key及安全取消接口。不能通过可变配置重连并按PID盲杀：代理/集群可能连接别的服务器。该问题需继续设计与原会话绑定、认证且能验证目标的服务器取消通道；本轮没有以降低安全标准的KILL回退冒充修复。
- 新增较短服务端查询实测表明客户端状态失效、原未提交修改最终回滚、后续更新可成功，但这仅证明最终清理，不证明即时取消。较长失败测试记录与短查询最终清理测试严格分开，未抹去未修复事项。
- 专项2项通过（其中PG显式运行），常规Rust353通过、44默认忽略、0失败；cargo check通过。本轮只改DB事务Rust及测试，前端未改，不重新宣称桌面/硬件取消端到端验收。日志/tmp/dbterm-r16-{queued-red,queued-green,server-lock-red,cancel-final,final-rust,final-check}.log。
- 私有PG33391仅用于本轮，结束停止；不触及业务库、不提交推送。整体目标继续active，服务端即时取消明确列为优先未完成项。

## 第十七次 PostgreSQL 认证取消与表预览剪贴板复验（2026-11-14）

- 延续第十六次真实长查询取消失败，增加原会话PID与secret绑定的CancelRequest。基于准确SQLx PostgreSQL0.8.6源码的小范围vendor补丁，保留上游双许可证；传输沿用原端点与TLS选项，清除保存选项中的密码，取消能力Debug脱敏，不按可变配置重连后仅凭PID终止。补丁范围和升级责任见src-tauri/vendor/sqlx-postgres/DBTERM_PATCH.md。
- 新取消helper的两次失败测试发现：预先取消，以及查询future已经让出但尚未真正发SQL时，发送取消后继续等待原future会反而启动SQL。现取消后绝不再次poll任意查询工作；未开始则不发送取消。普通查询作废池连接，手动事务按原Arc身份移除连接。发送有3秒上限；CancelRequest无确认，提示明确结果和服务端停止尚未确认，不能视为已撤销提交。
- 6项取消行为单测通过；隔离PG17真实pg_sleep(30)取消测试通过，验证原事务移除、先前未提交修改回滚及1秒锁超时条件下后续写成功。该证据不覆盖所有代理、DNS变更、TLS配置、兼容引擎及断网场景；仍不能保证所有服务端立即停止。常规Rust359通过、45默认忽略、0失败；cargo check通过，vendor引入3条上游dead_code警告，未隐藏。日志/tmp/dbterm-r17-pg-cancel-{red,yield-red,final-green,live,final-suite}.log与/tmp/dbterm-r17-final-check.log。
- Cargo不允许直接测试非workspace依赖的dev-dependencies，原package测试命令失败，未计为通过。另用rustc直接include实际ProtocolEncode trait和实际CancelRequest源文件运行编码单测，1通过，证据/tmp/dbterm-r17-wire-test.log；不将此当成全部驱动单测或TLS测试。
- 用户再次要求表预览单格、连续区域及多列复制粘贴。本轮复跑真实TableBrowser+StrictMode浏览器夹具，原单格/连续列/标量填充/矩阵展开/暂存禁止排序/撤销/非文本拒绝均通过。另确认系统菜单触发DOM copy没有网格处理器，复制得到空文本；新增onCopy复用原选区序列化，编辑输入框继续使用文本原生复制。先失败后通过，日志/tmp/dbterm-clipboard-copyevent-{red,green}.log。
- 粘贴仍先暂存再显式一次update_cells，不自动写库；只操作当前已加载页，支持Cmd/Ctrl列多选及Shift连续列。保护完整主键、生成列/只读列、元数据、边界和原值基线；不因这个UI请求修改DDL、共享外壳或SSH侧代码。普通NULL文本不自动转换数据库空值。
- 新鲜前端验证221通过、1跳过、0失败，TypeScript及生产构建通过。浏览器夹具后端和剪贴板为mock IPC，不能代替Tauri WKWebView/系统剪贴板硬件验收；未对业务库做写入。证据/tmp/dbterm-clipboard-current-browser.log、final-npm.log、final-build.log。私有PG测试服务已停止。整体审计仍在进行，不宣称全软件绝无bug。

## 第十八次 TLS 策略一致性与执行计划副作用复审（2026-11-14）

### 确认并修复

- R17新认证取消驱动仍复制Prefer模式：原连接已协商TLS，后续取消重新协商时若服务端拒绝TLS，会把后端PID/secret发送到明文通道。隔离PG17实测先连接TLS，再关闭新连接SSL，原实现取消返回成功，测试真实失败。现PgStream记录实际TLS协商状态；原连接Prefer且已加密时，取消选项提升为Require，不允许降级；VerifyCa/VerifyFull保持原证书策略，原首连Prefer语义不变。此问题位于新vendor能力，不能据此声称主查询所有入口此前都会降级。上游补丁文件清单同步补齐stream.rs/tls.rs。
- 继续沿连接入口审计发现pg_admin私有连接器未使用统一TLS解析：useSsl=true且extra sslMode空时退到Prefer，服务端关闭SSL仍能连明文；未知模式还会先尝试SSH连接。两项均先失败后通过。现建隧道前调用统一pg_tls_mode；显式disabled仍关闭TLS、Require拒绝无TLS、VerifyFull验证CA。只改DB管理入口，不改SSH功能代码。
- pg_explain_json为获得JSON与TEXT计划，原先两次EXPLAIN ANALYZE实际执行同一查询；普通ROLLBACK不能撤销nextval序列推进。抽出原生产执行逻辑为pg_explain::run后，真实持久sequence回归先失败。现一个只读事务只发一次JSON EXPLAIN，plan_text由同次计划生成格式化JSON；不再假称第二次执行能被回滚完全抵消，回滚错误明确报告。只读事务在分析前设置，实测拒绝持久sequence与写CTE；TEMP对象写入仍是PG允许范围，测试验证随后回滚。普通SELECT、无ANALYZE计划及失败后连接恢复均验证。

### 证据与限制

- 5项真实TLS测试通过：拒绝加密取消降级；服务端实际返回57014且原连接可继续查询；A令牌不取消B；原连接已关闭的令牌不取消新连接（不等于穷举PID复用）；VerifyFull可信证书成功、错误CA及取消阶段替换CA均拒绝。3项sleep任务有AbortOnDrop，配置变更测试在断言前恢复SSL，fixture明确限制127.0.0.1:33391及专用证书路径。
- 管理入口专项1项无网络单测、1项真实TLS回归通过。执行计划专项2项实服通过：持久sequence不推进；临时sequence计数准确1，证明不重复执行；写CTE拒绝并保持零行；失败后再次分析成功。旧长期查询取消+回滚+释放行锁专项1项复跑通过。
- 最终后端常规360通过、53默认忽略、0失败；本轮新增忽略实服专项已按上述显式运行，不能把全部53项一概当作本轮已运行。cargo check通过，存在3条vendor上游dead_code警告；git diff --check通过。本轮未改前端，未将上一轮浏览器测试冒充本轮桌面验证。
- 日志/tmp/dbterm-r18-pg-tls-{red,green,all,suite}.log、pg-admin-{unit-red,unit-green,live-red,live-green}.log、explain-{red,green,all}.log、cancel-integration.log、final-rust.log、final-check.log（均dbterm-r18前缀）。独立代码复审未发现TLS修复和单次只读分析补丁的额外已证实缺陷；维护清单遗漏已修正。
- READ ONLY不是任意函数沙箱：外部网络/文件副作用、恶意或错误标注的扩展函数及服务器管理员权限不能由数据库客户端完全隔离；不宣称任意SELECT绝无副作用。计划文本现在是格式化同次JSON，当前前端无该IPC消费者，但外部调用方依赖原生TEXT格式时需适配。DNS重新解析/代理取消路由、全部兼容引擎、其他原生服务、桌面硬件和整体RSS仍未全面验收。另发现pg_admin SSH密码路径未使用标准安全存储回退，待单独复现修复，不能把本轮当作全项目通过。没有业务库写入、没有提交或推送，整体目标保持进行中。


## 第十九次管理入口凭据、配置拒绝与分析预算复审（2026-11-14）

- 保存连接会将DB隧道密码迁入{连接ID}::ssh-tunnel并清空旧字段；管理入口原先仍只读取旧字段。实际DbTunnelCfg构造边界先失败后修复，恢复已保存密码，保留非空旧值优先，存储错误脱敏拒绝，不降级为空认证。agent/none明确不需要密码，跳过无关查找；key仍可能需要私钥口令，保留查找。仅DB管理入口修改，未触碰真实用户凭据或SSH侧代码。
- 独立复审发现更严重配置回退：原始sshTunnel=true但sshPort类型错误且sslMode缺省时，serde失败静默默认无隧道，实际pg_connect尝试直连。真实失败日志返回Connection refused而非配置拒绝。现解析返回Result，格式错误在联网前明确拒绝；缺省、空白、合法空对象继续可用。无效JSON此前已被TLS校验拦截，不将其冒充新发现。
- 执行计划缺少服务端预算，40ms专项预算下pg_sleep(0.4)仍成功返回，先失败后修复。分析功能默认30000ms事务局部statement_timeout，范围1至300000ms；已有更短非零限额不被放宽，回滚恢复原值。不修改普通SQL编辑器时限，也不宣称断网客户端等待或任意扩展函数具备硬时限。
- 真实PG分析专项4项覆盖睡眠超时、原20ms限额保留、事务局部值恢复、ACCESS EXCLUSIVE锁等待超时，以及前轮单次分析/序列/写CTE/失败恢复回归。凭据与解析行为测试覆盖准确连接键、旧值优先、存储故障、agent/none免查找、畸形配置拒绝及合法缺省。最终集成计数在结束验证后追加。
- 日志/tmp/dbterm-r19-pg-admin-secret-{red,green}.log、pg-admin-typed-red.log、pg-admin-parse-red.log、explain-timeout-{red,green}.log、explain-all.log、admin-live.log、final-{rust,check}.log（均dbterm-r19前缀）。其他连接器配置解析失败回退及凭据错误传播仍需继续审计；整体目标保持进行中，无业务库写入、无提交推送。
- 最终集成：常规Rust367通过、55默认忽略、0失败；显式PG分析4项及管理入口TLS1项通过。cargo check和git diff --check通过，保留3条vendor上游dead_code警告。本轮未改前端，不冒称桌面验收；私有PG33391结束停止。
