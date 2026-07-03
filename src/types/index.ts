// 与 Rust 后端 ConnType enum 对应（serde camelCase）
// 'local' 为前端专有，不发送到后端
export type ConnType =
  | 'local'
  | 'ssh'
  | 'mysql'
  | 'postgres'
  | 'sqlite'
  | 'redis'
  | 'tidb'
  | 'oceanBase'
  | 'mariadb'
  | 'kingBase'
  | 'openGauss'
  | 'clickHouse'
  | 'mongodb'
  | 'duckdb'
  | 'sqlServer'
  | 'oracle'

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface ConnConfig {
  id: string
  name: string
  type: ConnType
  host?: string
  port?: number
  username?: string
  database?: string
  filePath?: string
  sshKeyPath?: string
  useSsl: boolean
  createdAt: number
  updatedAt: number
  color?: string      // 用户颜色标签
  extraJson?: string  // 扩展配置 JSON（SSH extra / 本地终端 extra）
  envLabel?: 'prod' | 'staging' | 'test' | null  // 环境标签（生产/预发/测试）
  readonly?: boolean  // 只读连接模式（兼容旧字段）
  readOnly?: boolean  // 只读连接模式（新字段，与后端对应）
}

export interface TestResult {
  success: boolean
  message: string
  latencyMs?: number
}

export type ActiveView = 'all' | 'ssh' | 'db'
export type TabType = 'terminal' | 'query' | 'schema-browser' | 'table-data' | 'object-editor'

export interface WorkspaceTab {
  id: string
  connectionId: string
  title: string
  type: TabType
  error?: boolean
  meta?: Record<string, string>
  pinned?: boolean   // 固定标签（最左、不可关闭）：每个连接的对象浏览标签
  dirty?: boolean    // 有未保存编辑（对象编辑页）：标签显示 * 标志
}
