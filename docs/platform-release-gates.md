# 平台发布门禁

`scripts/acceptance/` 中的门禁脚本只执行本地、可重复的检查，不读取凭据，也不连接业务数据库或远程 SSH。

`.github/workflows/platform-validation.yml` 在 PR、master 更新和手动触发时使用 GitHub 原生 Windows x64 runner 安装依赖、运行前端检查/测试、构建 Windows Tauri 可执行文件并运行 Windows 可运行的 Rust 测试。一个依赖 Unix shell 的 SSH 回退集成测试只在 Windows 跳过；它仍由 macOS/Linux Rust 回归覆盖。该 workflow 首次真实执行并通过前，Windows 原生构建状态仍记为未验证；即使通过，也只证明 runner 上的构建/测试，不证明真实用户桌面交互、安装升级或触摸板硬件。

- `platform-release-gates.py`：主机、Rust target、容器工具和签名工具可用性。
- `cross-platform-build.py`：当前主机编译；只有安装 Windows MSVC target 时才执行 Windows 检查。
- `memory-stress.py`：临时 SQLite 的有界结果集压力测量，不能代替完整桌面应用 RSS 测试。
- `local-matrix.py`：SQLite、Rust loopback 与可选本地数据库服务矩阵。
- `signing-install-gate.py`：检查 bundle、签名配置和升级测试夹具，不自行签名或联网。

真实触摸板手势、Windows 原生运行、签名安装升级和完整数据库版本矩阵必须在相应外部环境中执行；脚本会输出 `UNVERIFIED`，不会将缺失证据报告为通过。
- `desktop-startup-smoke.py`：启动本地 debug Tauri 二进制 8 秒，使用临时 HOME 后终止；这是启动烟测，不是完整桌面交互或触摸板验收。
