# DBTerm

DBTerm 是一款基于 Tauri v2 的桌面数据库终端，面向数据库开发、日常运维、SQL 调试、SSH 登录和数据管理场景。它把数据库客户端、SQL 编辑器、对象浏览器、SSH 终端和常用 DBA 工具整合在一个轻量桌面应用中，目标是在本地环境里提供快速、稳定、可控的数据库工作台体验。

DBTerm 采用 React 18、TypeScript、Zustand、xterm.js 与 Rust 后端实现。前端负责高效交互，后端负责连接、驱动、SSH、文件和系统能力，避免把核心连接逻辑堆在浏览器环境中。

## 软件特点

- 轻量桌面体验：基于 Tauri 构建，复用系统 WebView，不内置完整浏览器内核，启动和安装包体积更克制。
- 数据库与终端一体化：数据库连接、SQL 编辑、对象浏览、SSH 终端、本地终端和 SFTP 在同一工作台内完成。
- 多数据库统一入口：覆盖关系型数据库、NoSQL、分析型数据库和国产数据库，减少在多个客户端之间切换。
- 面向真实运维场景：提供环境标签、只读模式、查询取消、连接测试、驱动检测、慢日志、进程列表、巡检等实用能力。
- 方言感知：对象编辑、DDL、表结构工具和 SQL 生成按数据库类型处理，避免把 MySQL 语法误用到其他数据库。
- 安全优先：密码独立存储，不写入连接配置；生产环境可通过标签和只读模式降低误操作风险。
- 按需驱动：DuckDB、Oracle、SQL Server、达梦等外部驱动按需下载或手动指定，主安装包不默认塞入无关驱动。
- 中文优先：界面、提示、错误信息和常用操作面向中文用户优化。

## 核心能力

- 连接管理：数据库、SSH、本地终端统一管理，支持连接分组、颜色标记、环境标记、只读模式和连接测试。
- SQL 编辑：支持多标签、保存查询、批量执行、取消查询、结果表格、SQL 格式化、查询历史和对象编辑。
- 对象浏览：支持库、表、视图、字段、索引、例程等对象浏览，并按不同数据库方言生成 SQL。
- 表结构维护：支持创建表、修改表结构、查看 DDL、数据预览、字段和索引管理。
- 数据工具：包含数据导入导出、表结构对比、执行计划、进程列表、审计、巡检和 DBA 辅助工具。
- SSH 能力：基于 Rust SSH 实现远程终端、SFTP、SSH 配置和密钥管理，不依赖 C 绑定 SSH 库。
- Redis 管理：支持 key 浏览、值查看、慢日志、服务状态、发布订阅和常用管理工具。
- MongoDB 管理：支持集合浏览、索引、聚合、GridFS、用户权限、运行状态和安全巡检。
- 驱动管理：内置 DuckDB、Oracle Instant Client、SQL Server ODBC、达梦 DM8 等外部驱动探测、下载和手动指定能力。
- 安全存储：连接密码不写入连接配置文件，后端通过系统钥匙串/本地安全存储能力管理敏感信息。

## 适用场景

- 开发人员：编写和调试 SQL、快速查看表结构、保存常用查询、对比数据结果。
- DBA / 运维人员：管理多套数据库环境、查看进程和执行计划、做巡检和基础故障定位。
- 后端团队：在同一个应用里完成数据库查询、SSH 登录、日志查看和简单文件传输。
- 数据处理人员：使用 SQLite、DuckDB、ClickHouse 等工具进行本地或分析型数据处理。
- 企业内部工具链：统一连接配置、驱动来源和安全边界，减少临时脚本和散落客户端。

## 轻量体积

DBTerm 基于 Tauri 构建，复用系统 WebView，相比内置完整浏览器内核的桌面应用体积更小。

- 前端静态资源约 8.3 MB。
- macOS ARM64 release 可执行文件约 30 MB。
- 当前 macOS ARM64 DMG 安装包约 14 MB。
- 安装包体积随平台、架构、签名方式和打包格式变化，通常保持在几十 MB 级别。
- 外部数据库驱动不默认打入主安装包，按需下载或手动指定，避免无关驱动拉大基础包体积。

## 支持的连接类型

| 类型 | 连接方式 | 说明 |
| --- | --- | --- |
| SSH / 本地终端 | Rust + PTY | 终端、远程命令、SFTP |
| MySQL / MariaDB / TiDB / OceanBase | 原生协议 | 兼容 MySQL 协议族 |
| PostgreSQL / KingBase / openGauss | 原生协议 | 兼容 PostgreSQL 协议族 |
| SQLite | 本地文件 | 支持本地数据库文件 |
| Redis | 原生协议 | 键浏览、慢日志、服务状态 |
| MongoDB | 官方 Rust 驱动 | 集合、索引、聚合、巡检 |
| ClickHouse | TCP / HTTP | 优先原生 TCP，必要时回退 HTTP |
| DuckDB | 动态库加载 | 通过 libduckdb 动态库运行 |
| SQL Server | TDS / ODBC | 管理工具与驱动探测 |
| Oracle | Instant Client | 通过 OCI 动态加载 |
| 达梦 DM8 | ODBC | 需要安装官方客户端与 ODBC 驱动 |

## 技术栈

- 桌面框架：Tauri v2
- 前端：React 18、TypeScript、Vite、Zustand
- 编辑器：CodeMirror、sql-formatter
- 终端：xterm.js、xterm addons
- 后端：Rust、Tokio、Tauri IPC
- 数据库：sqlx、redis、mongodb、tiberius、ClickHouse、ODBC/OCI/动态库桥接
- 图形与导出：React Flow、html-to-image、xlsx

## 本地开发

### 环境要求

- Node.js 18 或更高版本
- npm
- Rust stable
- Tauri v2 所需系统依赖
- 如需连接 Oracle、SQL Server、达梦、DuckDB，请按应用内驱动管理提示安装对应驱动

### 安装依赖

```bash
npm install
```

### 前端开发

```bash
npm run dev
```

### 桌面端开发

```bash
cd src-tauri
cargo tauri dev
```

### 类型检查与测试

```bash
npx tsc --noEmit
npm test -- --runInBand
cd src-tauri && cargo check
```

### 生产构建

```bash
npm run build
npm run dist
```

## 项目结构

```text
src/                    前端应用
src-tauri/              Tauri/Rust 后端
build.js                跨平台打包脚本
```

## 安全特性

- 连接密码独立存储，不写入连接配置文件。
- 支持生产、预发、测试等环境标记，降低误操作风险。
- 支持只读连接模式，适合生产库查询和巡检场景。
- ClickHouse 等连接的认证信息通过请求头或驱动能力传递，避免拼入 URL。
- 外部驱动按需安装，便于在企业环境中统一管控来源和版本。

## 授权

本项目为私有软件项目，未公开授予开源许可证。未经授权，不得复制、分发、转售、托管、二次发布或用于商业交付。

详细条款见 [LICENSE](LICENSE)，项目授权与真实性声明见 [CERTIFICATE.md](CERTIFICATE.md)。
