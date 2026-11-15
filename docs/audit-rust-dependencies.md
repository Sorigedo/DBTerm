# Rust依赖审计（2026-11-15）

状态：未通过安全验收。cargo-audit 0.23.0；数据库提交 4ef2df8e806a65e2f1ecc14f56f51249062b23d6，更新时间 2026-11-13T13:33:03+01:00。

## 第一阶段：兼容锁文件更新（历史）

- 仅Cargo.lock兼容更新：anyhow、crossbeam-epoch、event-listener、hickory三包、quinn两包、rustix、rustls0.23、webpki0.103、tokio、webpki-roots；新增rand_pcg，移除concurrent-queue。未重写DB/SSH业务逻辑，未升级驱动主版本。
- 锁文件漏洞匹配由60条降为25条；另有11条unmaintained、1条unsound、3条yanked警告。条目数不是可利用漏洞数，不能由此推断全部实际可达或不可达。
- cargo tree确认：russh/crypto-bigint由SSH依赖；rustls0.21及webpki0.101由SQLServer tiberius；quick-xml0.31由直接XML导入和calamine，0.39由Tauri plist。quinn和rkyv在当前默认目标树未显示，不能据此排除其他平台/特性。

## 解析器修复前的漏洞匹配（历史快照，不是当前剩余清单）

| ID | 包 | 版本 | 修复版本范围 |
|---|---|---|---|
| RUSTSEC-2026-0436 | calamine | 0.26.1 | >=0.38.0 |
| RUSTSEC-2026-0387 | crypto-bigint | 0.5.5 | >=0.7.6 |
| RUSTSEC-2026-0459 | libsqlite3-sys | 0.30.1 | >=0.39.0 |
| RUSTSEC-2026-0195 | quick-xml | 0.31.0 | >=0.41.0 |
| RUSTSEC-2026-0194 | quick-xml | 0.31.0 | >=0.41.0 |
| RUSTSEC-2026-0195 | quick-xml | 0.39.4 | >=0.41.0 |
| RUSTSEC-2026-0194 | quick-xml | 0.39.4 | >=0.41.0 |
| RUSTSEC-2026-0235 | rkyv | 0.7.46 | >=0.8.17 |
| RUSTSEC-2023-0071 | rsa | 0.9.10 | >=0.10.0 |
| RUSTSEC-2026-0154 | russh | 0.46.0 | >=0.60.3 |
| RUSTSEC-2026-0494 | russh | 0.46.0 | >=0.61.0 |
| RUSTSEC-2026-0492 | russh | 0.46.0 | >=0.63.1 |
| RUSTSEC-2026-0496 | russh | 0.46.0 | >=0.60.1 |
| RUSTSEC-2026-0493 | russh | 0.46.0 | >=0.61.1 |
| RUSTSEC-2026-0153 | russh-cryptovec | 0.7.3 | >=0.60.3 |
| RUSTSEC-2026-0346 | rustls | 0.21.12 | >=0.23.46 |
| RUSTSEC-2026-0349 | rustls | 0.21.12 | >=0.23.46 |
| RUSTSEC-2026-0104 | rustls-webpki | 0.101.7 | >=0.103.13, <0.104.0-alpha.1, >=0.104.0-alpha.7 |
| RUSTSEC-2026-0098 | rustls-webpki | 0.101.7 | >=0.103.12, <0.104.0-alpha.1, >=0.104.0-alpha.6 |
| RUSTSEC-2026-0099 | rustls-webpki | 0.101.7 | >=0.103.12, <0.104.0-alpha.1, >=0.104.0-alpha.6 |
| RUSTSEC-2026-0382 | rustls-webpki | 0.101.7 | >=0.103.16, <0.104.0-alpha.1, >=0.104.0-alpha.8 |
| RUSTSEC-2026-0429 | zip | 2.4.2 | >=9.0.0 |
| RUSTSEC-2026-0367 | zip | 2.4.2 | >=9.0.0 |
| RUSTSEC-2026-0368 | zip | 2.4.2 | >=9.0.0 |
| RUSTSEC-2026-0369 | zip | 2.4.2 | >=9.0.0 |

## 第一阶段后的缺项记录（历史）

- calamine恶意CFB文件内存分配/崩溃；SQLite与WAL组合文件；russh报文字段/解压/通道验证；SQLServer旧TLS证书与会话；XML/ZIP输入及加密依赖需分别按真实使用路径修复。
- 同一漏洞可能匹配多个版本。服务端专属问题不能直接当客户端已利用；ZIP extract专属问题也需检查实际API。未用忽略列表消除告警。
- 修复门槛包含不兼容升级，需分模块更改、真实协议/文件回归，不能强制全树升级后仅靠编译结论。
- 原始JSON保存于证据目录dbterm-rust-audit.json与dbterm-rust-compatible-audit.json。


## 更新：Excel/XML解析与文件上限（2026-11-15）

- 确定复现：使用1,025字节损坏OLE/XLS样本调用calamine0.26.1的Xls::new，旧解析在cfb.rs读短目录项时越界panic。回归测试修复前失败，升级后正常返回解析错误。
- calamine升至0.38.0（修复CVE所列CFB越界/OOM缺陷），quick-xml直接依赖升到0.41.0（修复本应用XML解析器相关两个未界定内存/重复属性CPU问题），Rust最低版本升到1.88并更新README。快速XML解析器增加对quick-xml0.41的GeneralRef事件处理，避免升级后数值/内建实体丢失。
- 应用Tauri plist仍锁在quick-xml0.39.4，因plist要求^0.39.2而0.41不满足semver；cargo tree确认它随Tauri运行时与构建依赖引入。其两个NsReader告警仍保留。当前cargo-audit有22条匹配，包括该版本与zip2主版本告警；zip2搜索结果未见调用extract方法，生产读取使用ZipFile流式读取及自建路径检查，因此extract专属漏洞未证明可达，但不能靠搜索结果关闭整个依赖风险。
- DB文件导入及Mongo文件导入改用实际最多读取128MiB+1字节的有界读取，超过限制在数据库连接/写入前拒绝；Mongo Excel从同一受限字节缓冲交给calamine。以可注入小上限测试恰好达到边界和超过1字节均通过。此上限仅限制原始文件；解析结果/文档仍全量驻留，不能据此称总体RSS有128MiB上限。
- 全新回归：Rust452通过、73忽略；数据库/TLS专项66通过；前端226通过、1跳过；原生debug构建通过。损坏XLS反例、现有XLSX实际读取与SQLite值保真、CSV/JSON/XML/Excel事务导入、Mongo有界reader回归均通过。临时DB已停。
- RustSec库快照为2026-11-13；漏洞匹配不等于实际可利用。russh、旧TLS(SQLServer驱动)、SQLite依赖、zip2和传递quick-xml0.39仍未处理。前端依赖审计、桌面安装/触摸板/RSS、SQLServer原生服务、多引擎DDL/恢复仍未完成。整体安全/发布判定不变为未通过。

## 当前剩余风险路径补查（2026-11-15）

- （后续兼容补丁前的评估）SQLx0.8.6固定libsqlite3-sys0.30.1且sqlite feature启用bundled。单独cargo update无法跨该不兼容约束；SQLx0.9.0要求Rust1.94，故当时没有强升。后续以 vendored SQLx SQLite 驱动的窄 manifest 补丁解决，见本文件后文。
- russh0.63.1提供修复，但该版换用ssh-key并要求Rust1.85，DBterm当前直接依赖russh-keys API（加载/生成密钥、agent），且自己的loopback SSH test server也实现旧server Handler；目前不是只改一个版本号的安全升级。未将API迁移与SSH/SFTP两侧故障矩阵完成，russh告警开放。
- RSA timing告警来自russh/russh-keys及SQLx MySQL对RSA能力的传递依赖，禁用可能破坏SSH RSA密钥或MySQL非TLS密码认证，不能为清告警而移除。Tiberius0.12固定rustls0.21，旧TLS告警在SQLServer连接路径，需兼容驱动新版本并做真实隔离SQLServer握手验证。
- 恢复审核口径：RustSec22条是匹配项，不等同22个可利用路径；但未处置的重要客户可控输入风险仍阻止完整安全结论。

## 2026-11-15 后续兼容升级与最新扫描

- 将直接依赖 `zip` 从2.4.2升至9.5.1。调用点按新 API 显式处理损坏文件名错误；未使用 `ZipArchive::extract`。更新后 `cargo check`、完整 Rust 测试457通过/73忽略、文档测试9通过/2忽略。
- 将 Tiberius 从0.12.3升至0.13.0，保持关闭默认特性并仅启用tokio/chrono/rustls/rust_decimal/tds73。编译通过且锁文件不再包含 rustls0.21/rustls-webpki0.101，替换为0.23/0.103。完整Rust套件457通过/73忽略；本轮未运行真实隔离 SQL Server 握手/类型矩阵，因此发布前仍需SQL Server专项。
- 安装并运行 cargo-audit 0.23.0，成功联网更新 RustSec 数据库（1509条公告，Cargo.lock 811个依赖）。SQLite兼容补丁前结果为12条漏洞匹配、14条其他警告；相较旧记录的22条，zip四条与Tiberius旧TLS路径已消失；不能把匹配计数等同可利用问题数量。
- SQLite补丁前锁文件复扫：12条漏洞匹配，另有14个未维护/unsound/yanked告警。匹配项为 crypto-bigint0.5.5（SSH密码学）、libsqlite3-sys0.30.1（SQLx bundled SQLite）、quick-xml0.39.4两条（Tauri/plist传递依赖）、rkyv0.7.46、rsa0.9.10、russh0.46.0五条及russh-cryptovec0.7.3一条。对应路径与升级约束需继续处理；本项目安全验收仍未通过。
- `plist` 已在现有 Tauri 版本约束内从1.9.0更新到1.10.3；`cargo check --locked` 与完整Rust测试通过。其 `quick-xml 0.39.4` 依赖消失。全平台树中仍有 `quick-xml 0.39.4`，来源是 `wayland-scanner 0.31.10`；源码审阅显示它用普通 `Reader` 与 `BytesStart::attributes()`，不是 `NsReader`。因此 `NsReader` namespace 分配公告不命中此路径；重复属性二次复杂度公告只涉及构建时扫描源 XML，未发现应用运行时用户可控输入路径。cargo-audit 仍如实报告匹配，未加忽略规则。
- 早先扫描中的15项其他警告包含 `rustix 1.1.5` unsound 告警。本轮将其锁定升级到1.1.6；当前复扫分类为10项unmaintained、1项unsound（glib）、3项yanked，合计14项。
- SSH 0.65.1 / SFTP 3.0.1 试迁移因多个 API 断裂而已撤回；当前 Cargo.toml/Cargo.lock 保留 russh0.46/russh-sftp2.3。撤回后 `cargo test --locked` 重新通过457/73，文档测试9/2。不要把试验依赖图当作当前版本。
- SQLite升级评估与修复：SQLx0.9要求Rust1.94并带来大范围API迁移，未采用。保留SQLx0.8.6 API，复制其上游0.8.6 `sqlx-sqlite` 源码到 `src-tauri/vendor/sqlx-sqlite`，唯一清晰的manifest差异是将 `libsqlite3-sys` 约束从0.30.1放宽到0.39.1；其余源码逐文件对比无差异。Cargo锁定 bundled SQLite 3.54.1。`cargo check --locked`、完整Rust测试457/73、运行时 SQLite 版本门禁均通过。RustSec不再报告 `libsqlite3-sys` CVE-2026-119375。该补丁需在下一次 SQLx 升级时重新评估并尽量移除。

## 2026-11-15 后续修复验证
- `cargo update -p rustix --precise 1.1.6` 仅将锁定版本从1.1.5提升至1.1.6；全平台目标依赖树确认由arboard/wayland/x11rb路径引入。当前 cargo-audit 不再报告该 unsound 公告。
- 更新后的中间锁文件 `cargo test --locked` 为457通过、0失败、73忽略；文档测试9通过、2忽略。该结果早于 SQLite 运行时门禁新增。
- Tauri plist 提升至1.10.3后，`cargo check --locked` 和 `cargo test --locked` 再次通过；quick-xml 剩余匹配由构建依赖 wayland-scanner 引入。具体 API 路径与可达性分析如上。
- SQLite 兼容补丁验证后 cargo-audit 为11条漏洞匹配；`libsqlite3-sys` 已从匹配列表消失。最新锁文件完整Rust测试458通过/73忽略，文档测试9通过/2忽略；前端类型检查通过，前端测试226通过/1跳过。当前剩余匹配集中在SSH密码学/协议、rkyv/rsa及构建依赖quick-xml，不能据此宣称全体依赖风险关闭。
- 本轮本地 RustSec GitHub 更新超时，因此最新可验证快照仍是此前成功更新的2026-11-13数据库；不把失败的联网刷新说成新鲜扫描。npm默认配置的 npmmirror audit endpoint 返回404；显式指定 `https://registry.npmjs.org` 后前端依赖审计结果为0项（critical/high/moderate/low均为0）。
- SSH公告调用链确认 `russh` 直接用于客户端交互终端、命令执行、隧道、agent认证/转发及SFTP。修改前，压缩默认关闭但可由用户启用；当前后端策略固定只提供 `none`，因此不再协商zlib。RUSTSEC-2026-0493所述压缩路径已由临时策略关闭；RUSTSEC-2026-0492通道伪造校验对本客户端适用；RUSTSEC-2026-0154 agent协议相关路径在本地agent认证中适用。后两项仍是实际可达风险，不能按“服务端专属”关闭。
- `russh 0.63.1` 是覆盖上述修复的已知最低可用升级目标，但将密钥接口改为内部fork的`ssh-key`，DBterm还直接使用`russh-keys`密钥加载/agent API，并自行实现loopback server Handler。此前0.65.1迁移的API断裂及回归风险已记录；本轮未做半套迁移，避免让SSH/SFTP运维功能处于未经验证状态。SSH安全公告仍是发布阻断项。
- 在完成主版本迁移前，后端已固定 SSH 压缩首选项为 `[none]`，旧配置中的 `enableCompression` 不再触发 zlib 协商；前端开关改为禁用提示。策略单测通过，完整Rust回归459通过/73忽略。该缓解仅覆盖解压缩炸弹公告，不覆盖通道伪造或 agent 帧边界问题。
