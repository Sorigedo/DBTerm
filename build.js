#!/usr/bin/env node
/**
 * DBTerm 打包脚本
 *
 * 用法：
 *   node build.js [--platform <win|mac|linux>] [--arch <x64|arm64|universal>]
 *                 [--bundle <msi,nsis|dmg|deb,appimage|...>] [--debug]
 *
 * 省略 --platform 自动检测当前操作系统；省略 --arch 自动检测当前 CPU
 * 架构（M 系列 → arm64，Intel → x64）。
 *
 * 示例：
 *   node build.js                              # 当前平台+当前架构，默认格式
 *   node build.js --platform win               # Windows x64 (.msi + .exe)
 *   node build.js --platform win --bundle msi  # 只打 MSI
 *   node build.js --platform win --arch arm64  # Windows ARM64
 *   node build.js --platform mac --arch universal  # macOS 通用包
 *   node build.js --platform linux --bundle deb    # 只打 .deb
 *   node build.js --debug                          # 调试包（跳过优化）
 *
 * 也可通过 npm scripts 调用：
 *   npm run dist -- --platform win
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import os from 'os'

// macOS：Tauri 打的 DMG 默认带 .VolumeIcon.icns。部分 Finder 设置会显示隐藏文件，
// 用户会在安装窗口看到这个内部文件。处理策略：挂载可写 DMG 后直接删除卷图标文件，
// 并清理 .DS_Store 中残留的定位记录，宁可不用自定义卷标图标，也不暴露内部文件。
// best-effort：失败仅告警，不影响安装包可用。
function hideDmgVolumeIcon(rustTarget) {
  const dmgDir = `src-tauri/target/${rustTarget}/release/bundle/dmg`
  if (!existsSync(dmgDir)) return
  for (const name of readdirSync(dmgDir).filter(f => f.endsWith('.dmg'))) {
    const dmg = join(dmgDir, name)
    const tmp = join(dmgDir, '__volicon_rw.dmg')
    let mount = null
    const pyTmp = '/tmp/__patch_dsstore.py'
    try {
      console.log(`\n隐藏 DMG 卷图标: ${name}`)
      execSync(`rm -f "${tmp}"`)
      execSync(`hdiutil convert "${dmg}" -format UDRW -o "${tmp}"`, { stdio: 'pipe' })
      const out = execSync(`hdiutil attach "${tmp}" -noverify -nobrowse -noautoopen`, { encoding: 'utf8' })
      mount = out.split('\n').map(l => l.match(/\t(\/Volumes\/.+)$/)?.[1]).find(Boolean)?.trim()

      if (mount) {
        const dsStore = `${mount}/.DS_Store`

        try {
          execSync(`rm -f "${mount}/.VolumeIcon.icns"`, { stdio: 'pipe' })
        } catch (e) {
          console.warn(`  删除 .VolumeIcon.icns 失败: ${e.message}`)
        }

        // Python 脚本：在 DS_Store 二进制中找 .VolumeIcon.icns 的 Iloc 记录，
        // 将记录类型字段（Iloc 四字节）改为 \x00\x00\x00\x00（无效类型）。
        writeFileSync(pyTmp, [
          'import sys, struct',
          'with open(sys.argv[1], "rb") as f:',
          '    data = bytearray(f.read())',
          'name = ".VolumeIcon.icns"',
          'pattern = struct.pack(">I", len(name)) + name.encode("utf-16-be") + b"Iloc"',
          'pos = 0; found = 0',
          'while True:',
          '    idx = data.find(pattern, pos)',
          '    if idx < 0: break',
          '    iloc_pos = idx + len(pattern) - 4',
          '    data[iloc_pos:iloc_pos + 4] = b"\\x00\\x00\\x00\\x00"',
          '    pos = idx + 1; found += 1',
          'if found:',
          '    with open(sys.argv[1], "wb") as f: f.write(data)',
          '    print(f"patched {found} record(s)")',
          'else:',
          '    print("Iloc record not found in DS_Store")',
        ].join('\n'))

        try {
          const r = execSync(`python3 "${pyTmp}" "${dsStore}"`, { encoding: 'utf8', stdio: 'pipe' })
          console.log(`  DS_Store patch: ${r.trim()}`)
        } catch (e) {
          console.warn(`  DS_Store patch failed: ${e.message}`)
        }

        execSync(`hdiutil detach "${mount}" -quiet`, { stdio: 'pipe' })
        mount = null
      }

      execSync(`rm -f "${dmg}"`)
      execSync(`hdiutil convert "${tmp}" -format UDZO -o "${dmg}"`, { stdio: 'pipe' })
      console.log(`  ✅ DMG 卷图标文件已移除`)
    } catch (e) {
      if (mount) try { execSync(`hdiutil detach "${mount}" -quiet`, { stdio: 'pipe' }) } catch {}
      console.warn(`  ⚠️ 隐藏失败（不影响安装包可用）: ${e.message}`)
    } finally {
      try { execSync(`rm -f "${tmp}"`, { stdio: 'pipe' }) } catch {}
      try { unlinkSync(pyTmp) } catch {}
    }
  }
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function flag(name) {
  const i = args.indexOf(name)
  if (i === -1) return null
  return args[i + 1] ?? null
}

const platform = (flag('--platform') || flag('-p') || '').toLowerCase()
const arch     = (flag('--arch')     || flag('-a') || '').toLowerCase()
const bundle   = (flag('--bundle')   || flag('-b') || '').toLowerCase()
const debug    = args.includes('--debug') || args.includes('-d')

// ── 自动检测当前平台 ──────────────────────────────────────────────────────────

function detectPlatform() {
  switch (os.platform()) {
    case 'win32':  return 'win'
    case 'darwin': return 'mac'
    default:       return 'linux'
  }
}

// 自动检测当前 CPU 架构：M 系列 → arm64，Intel → x64
function detectArch() {
  switch (os.arch()) {
    case 'arm64': return 'arm64'
    default:      return 'x64'
  }
}

const target_platform = platform || detectPlatform()

// ── 规范化 ────────────────────────────────────────────────────────────────────

const platformAliases = { windows: 'win', macos: 'mac', darwin: 'mac' }
const resolvedPlatform = platformAliases[target_platform] ?? target_platform

const archAliases = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64' }
const resolvedArch = arch ? (archAliases[arch] ?? arch) : detectArch()

// ── 平台 + 架构 → Rust 目标三元组 ────────────────────────────────────────────

const TARGET_MAP = {
  'win/x64':       'x86_64-pc-windows-msvc',
  'win/arm64':     'aarch64-pc-windows-msvc',
  'mac/x64':       'x86_64-apple-darwin',
  'mac/arm64':     'aarch64-apple-darwin',
  'mac/universal': 'universal-apple-darwin',
  'linux/x64':     'x86_64-unknown-linux-gnu',
  'linux/arm64':   'aarch64-unknown-linux-gnu',
}

const key = `${resolvedPlatform}/${resolvedArch}`
const rustTarget = TARGET_MAP[key]

if (!rustTarget) {
  console.error(`\n不支持的平台/架构：${key}`)
  console.error('支持的组合：')
  Object.keys(TARGET_MAP).forEach(k => console.error(`  --platform ${k.replace('/', ' --arch ')}`))
  process.exit(1)
}

// ── 平台默认安装包格式 ────────────────────────────────────────────────────────

const DEFAULT_BUNDLES = { win: 'msi,nsis', mac: 'dmg', linux: 'deb,appimage' }
const resolvedBundle = bundle || DEFAULT_BUNDLES[resolvedPlatform]

// ── 跨平台警告 ────────────────────────────────────────────────────────────────

const currentPlatform = detectPlatform()
if (resolvedPlatform !== currentPlatform) {
  console.warn(`\n⚠️  警告：当前运行在 ${currentPlatform}，目标平台为 ${resolvedPlatform}`)
  console.warn('   Tauri 不支持真跨平台编译，建议在目标系统或 CI 中运行。')
  console.warn('   继续执行，如失败请切换到对应平台。\n')
}

// ── 检查 / 安装 Rust 目标 ─────────────────────────────────────────────────────

function hasRustTarget(target) {
  try {
    const out = execSync('rustup target list --installed', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    return out.split('\n').some(l => l.trim() === target)
  } catch { return false }
}

if (!hasRustTarget(rustTarget)) {
  console.log(`Rust 目标 ${rustTarget} 未安装，正在安装…`)
  const r = spawnSync('rustup', ['target', 'add', rustTarget], { stdio: 'inherit' })
  if (r.status !== 0) { console.error('rustup target add 失败'); process.exit(1) }
}

// ── 组装 tauri build 命令 ─────────────────────────────────────────────────────

const tauriArgs = ['tauri', 'build', '--target', rustTarget, '--bundles', resolvedBundle]
if (debug) tauriArgs.push('--debug')

// ── 摘要 ─────────────────────────────────────────────────────────────────────

console.log('\n=====================================')
console.log('  DBTerm 打包')
console.log('=====================================')
console.log(`  平台    : ${resolvedPlatform}`)
console.log(`  架构    : ${resolvedArch}`)
console.log(`  Rust目标: ${rustTarget}`)
console.log(`  安装包  : ${resolvedBundle}`)
console.log(`  模式    : ${debug ? '调试' : 'release'}`)
console.log('=====================================\n')
console.log(`执行: npx ${tauriArgs.join(' ')}\n`)

// ── 执行 ──────────────────────────────────────────────────────────────────────

const result = spawnSync('npx', tauriArgs, { stdio: 'inherit', shell: process.platform === 'win32' })

if (result.status === 0) {
  // macOS DMG：隐藏多余的 .VolumeIcon.icns
  if (resolvedPlatform === 'mac' && resolvedBundle.includes('dmg') && process.platform === 'darwin') {
    hideDmgVolumeIcon(rustTarget)
  }
  console.log(`\n✅ 打包成功！`)
  console.log(`   输出目录: src-tauri/target/${rustTarget}/release/bundle/`)
} else {
  process.exit(result.status ?? 1)
}
