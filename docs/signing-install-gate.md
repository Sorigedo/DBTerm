# 签名、安装与升级门禁

发布前需要在 macOS/Windows 的隔离账户中分别安装两个已签名版本，验证首次启动、数据目录迁移、升级后连接配置和卸载残留。当前仓库脚本会检查 bundle 元数据、`codesign --verify`、显式签名配置，并保持无副作用；缺少证书、安装包或隔离账户时结果为 `UNVERIFIED`。

CI 发布工作流现在会在构建前强制检查 macOS 和 Windows 签名 secrets；macOS 必须提供 Developer ID 证书、证书密码和签名身份，并且 Apple ID 三项凭据（Apple ID、应用专用密码、Team ID）或 App Store Connect API 三项凭据（Key ID、Issuer ID、私钥）必须完整提供一组。Windows 必须提供代码签名 PFX 和密码。缺少配置会直接失败，不再使用 `APPLE_SIGNING_IDENTITY=-` 生成未签名发布资产。

CI 会把 macOS P12 导入临时 Keychain 并检查身份，再对 `.app`/DMG 执行签名与公证票据验证；Windows 会把 PFX 导入 runner 证书存储，将证书 thumbprint 传给 Tauri bundler，并用 `Get-AuthenticodeSignature` 验证 MSI/EXE。任一步失败都会阻止 artifact 上传和 Release 发布。当前只完成 workflow 静态检查，远端 runner/secrets 尚未执行。

发布作业在重命名后还会逐项检查两个 macOS 包、Windows x64 MSI/EXE 和 Windows ARM64 EXE；缺少任一平台资产会阻止 Release 创建，不能因为 ARM runner 被标记为实验而发布不完整版本。

签名 CI 会检查 Windows 证书有效期和 Code Signing EKU；签名完成后无论成功或失败都会删除临时 macOS Keychain/P12 和 Windows 当前用户证书存储中的导入证书。仅验证 YAML 和步骤结构不代表云端证书导入已验证。
