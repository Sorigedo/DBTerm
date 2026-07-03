import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    // 关闭压缩：生产 esbuild 压缩会把变量名折叠复用，在某条代码路径上压出越界引用
    // （运行时 ReferenceError: Can't find variable: s），导致打包版 xterm 解析器解析特定转义序列时抛错、
    // 写队列中毒，vim/less/tmux 等全屏应用「按键无反应、画面卡死」。dev 不压缩故正常。
    // 桌面应用从本地加载、体积无影响，关压缩换取正确性。详见排查：xterm 解析增量写入卡死问题。
    minify: false,
  },
})
