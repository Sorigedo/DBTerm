// DB 运维工具目录：定义每个工具的归类、标签、图标、适用连接类型。
// 三处入口（DBA 工具 / 对象工具 / 高级工具）从此过滤取项，点击派发 openTool。
import {
  Server, Activity, Settings, Database, GitBranch, Network, HardDriveDownload,
  BookOpen, RotateCcw, Zap, SearchCode, Download, BarChart2,
  Undo2, Layers, Globe, GitCompare, Boxes, Star, Clock, Shield,
} from 'lucide-react'
import type { ConnType } from '../../types'

export type ToolCat = 'dba' | 'object' | 'advanced'

export interface ToolDef {
  tool: string
  label: string
  cat: ToolCat
  icon: React.ReactNode
  show: (c: ConnType) => boolean
}

const isMysql = (c: ConnType) => ['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(c)
const isPg = (c: ConnType) => ['postgres', 'kingBase', 'openGauss'].includes(c)
const is = (...types: ConnType[]) => (c: ConnType) => types.includes(c)
const any = () => true

export const TOOL_CATALOG: ToolDef[] = [
  // 注：DBA 总览面板 + 变量/状态、事务监控、主从复制、MGR、死锁历史、Perf Schema、实例仪表盘
  // 已整合为「DBA 面板」弹窗内的 tab，由连接树「DBA 面板」入口直接打开，不再列在此目录。

  // ── 对象 / 数据 ──
  { tool: 'dbManager',     label: '库管理',        cat: 'object', icon: <Database size={12} />,  show: isMysql },
  { tool: 'dataDict',      label: '数据字典',      cat: 'object', icon: <BookOpen size={12} />,   show: any },
  { tool: 'erDiagram',     label: 'ER 关系图',     cat: 'object', icon: <Network size={12} />,    show: any },
  { tool: 'fullText',      label: '数据全文检索',  cat: 'object', icon: <SearchCode size={12} />,  show: (c) => isMysql(c) || isPg(c) },
  { tool: 'backupRestore', label: '备份恢复',      cat: 'object', icon: <RotateCcw size={12} />,   show: (c) => isMysql(c) || isPg(c) },
  { tool: 'exportCenter',  label: '导出任务中心',  cat: 'object', icon: <Download size={12} />,    show: any },
  { tool: 'scheduler',     label: '定时任务',      cat: 'object', icon: <Clock size={12} />,       show: isMysql },
  { tool: 'binlogFb',      label: 'Binlog 闪回',   cat: 'object', icon: <Undo2 size={12} />,       show: isMysql },
  { tool: 'onlineDdl',     label: '在线大表改表',  cat: 'object', icon: <Zap size={12} />,         show: isMysql },

  // ── 高级 / 专属（按数据库类型）──
  { tool: 'galera',        label: 'Galera 集群',    cat: 'advanced', icon: <Network size={12} />,         show: is('mariadb') },
  { tool: 'timeravel',     label: '时间旅行查询',   cat: 'advanced', icon: <Clock size={12} />,           show: is('mariadb') },
  { tool: 'optimizer',     label: '优化器治理',     cat: 'advanced', icon: <Settings size={12} />,        show: is('mariadb') },
  { tool: 'maxScale',      label: 'MaxScale 探测',  cat: 'advanced', icon: <Network size={12} />,         show: is('mariadb') },
  { tool: 'mariaPhysical', label: '物理工具引导',   cat: 'advanced', icon: <HardDriveDownload size={12} />, show: is('mariadb') },
  { tool: 'pgMaintenance', label: 'PG 维护工具',    cat: 'advanced', icon: <Settings size={12} />,        show: isPg },
  { tool: 'pgReplication', label: 'PG 复制状态',    cat: 'advanced', icon: <GitBranch size={12} />,       show: isPg },
  { tool: 'pgAdvanced',    label: 'PG 高级对象',    cat: 'advanced', icon: <Database size={12} />,        show: isPg },
  { tool: 'pgPartition',   label: 'PG 声明式分区',  cat: 'advanced', icon: <Layers size={12} />,          show: isPg },
  { tool: 'pgRoles',       label: 'PG 角色管理',    cat: 'advanced', icon: <Server size={12} />,          show: isPg },
  { tool: 'pgFdw',         label: 'PG FDW 外部表',  cat: 'advanced', icon: <Globe size={12} />,           show: isPg },
  { tool: 'pgPartman',     label: 'PG 自动分区维护', cat: 'advanced', icon: <Layers size={12} />,         show: isPg },
  { tool: 'pgBouncer',     label: 'PgBouncer 连接池', cat: 'advanced', icon: <Zap size={12} />,           show: isPg },
  { tool: 'pgPitr',        label: 'PG 误删恢复指南', cat: 'advanced', icon: <BookOpen size={12} />,        show: isPg },
  { tool: 'configCompare', label: 'PG 配置对比',    cat: 'advanced', icon: <GitCompare size={12} />,      show: isPg },
  { tool: 'pgVector',      label: 'pgvector 查询',  cat: 'advanced', icon: <Boxes size={12} />,           show: isPg },
  { tool: 'kbMonitor',     label: '金仓 KES 监控',  cat: 'advanced', icon: <Activity size={12} />,        show: is('kingBase') },
  { tool: 'kbAudit',       label: '金仓内置审计',   cat: 'advanced', icon: <Shield size={12} />,          show: is('kingBase') },
  { tool: 'ogDbePerf',     label: 'dbe_perf 性能看板', cat: 'advanced', icon: <BarChart2 size={12} />,    show: is('openGauss') },
  { tool: 'ogSecurity',    label: 'openGauss 高安全特性', cat: 'advanced', icon: <Shield size={12} />,    show: is('openGauss') },
  { tool: 'ogIndexAdvise', label: '智能索引推荐',   cat: 'advanced', icon: <Star size={12} />,            show: is('openGauss') },
  { tool: 'tidb',          label: 'TiDB 分布式运维', cat: 'advanced', icon: <Server size={12} />,         show: is('tidb') },
  { tool: 'oceanBase',     label: 'OceanBase 分布式运维', cat: 'advanced', icon: <Database size={12} />,  show: is('oceanBase') },
  { tool: 'clickHouse',    label: 'CH 运维面板',    cat: 'advanced', icon: <BarChart2 size={12} />,       show: is('clickHouse') },
  { tool: 'chLineage',     label: '物化视图血缘',   cat: 'advanced', icon: <GitBranch size={12} />,       show: is('clickHouse') },
  { tool: 'redisTools',    label: 'Redis 工具',     cat: 'advanced', icon: <Zap size={12} />,             show: is('redis') },
  // SQL Server 专属
  { tool: 'mssqlIndexFrag', label: '索引碎片整理',  cat: 'advanced', icon: <Layers size={12} />,          show: is('sqlServer') },
  { tool: 'mssqlAgentJobs', label: 'SQL Agent 作业', cat: 'advanced', icon: <Clock size={12} />,           show: is('sqlServer') },
  { tool: 'mssqlWaitStats', label: '等待统计',      cat: 'advanced', icon: <BarChart2 size={12} />,        show: is('sqlServer') },
  { tool: 'mssqlBackup',    label: '备份 / AlwaysOn', cat: 'advanced', icon: <Shield size={12} />,         show: is('sqlServer') },
  { tool: 'mssqlPitr',     label: '误删恢复指南',    cat: 'advanced', icon: <BookOpen size={12} />,         show: is('sqlServer') },
]

/** 取某分类下、适用于该连接类型的工具项。 */
export function toolsFor(cat: ToolCat, connType: ConnType): ToolDef[] {
  return TOOL_CATALOG.filter((t) => t.cat === cat && t.show(connType))
}
