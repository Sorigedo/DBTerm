// 各数据库类型「专属/高级工具」的嵌入渲染：供 DBA 面板作为 tab 内容渲染。
// 每个面板已支持 embedded 模式（去模态外壳）。ADV_EMBEDDED 收录可作为 DBA 面板 tab 的工具 key，
// DBA 面板的「专属工具▾」下拉据此过滤显示。Redis 工具因 Redis 无 DBA 面板，未纳入（仍走树里入口）。
import GaleraPanel from './GaleraPanel'
import TimeravelPanel from './TimeravelPanel'
import OptimizerPanel from './OptimizerPanel'
import MaxScalePanel from './MaxScalePanel'
import MariaPhysicalToolsPanel from './MariaPhysicalToolsPanel'
import PgMaintenancePanel from './PgMaintenancePanel'
import PgReplicationPanel from './PgReplicationPanel'
import PgAdvancedPanel from './PgAdvancedPanel'
import PgPartitionPanel from './PgPartitionPanel'
import PgRolesPanel from './PgRolesPanel'
import PgFdwPanel from './PgFdwPanel'
import PgPartmanPanel from './PgPartmanPanel'
import PgBouncerPanel from './PgBouncerPanel'
import ConfigComparePanel from './ConfigComparePanel'
import PgVectorPanel from './PgVectorPanel'
import PgPitrGuidePanel from './PgPitrGuidePanel'
import KbMonitorPanel from './KbMonitorPanel'
import KbAuditPanel from './KbAuditPanel'
import OgDbePerfPanel from './OgDbePerfPanel'
import OgIndexAdvisePanel from './OgIndexAdvisePanel'
import OgSecurityPanel from './OgSecurityPanel'
import TidbPanel from './TidbPanel'
import OceanBasePanel from './OceanBasePanel'
import ClickHousePanel from './ClickHousePanel'
import ChLineagePanel from './ChLineagePanel'
import { MssqlIndexFragPanel, MssqlAgentJobsPanel, MssqlWaitStatsPanel, MssqlBackupPanel } from './MssqlToolsPanels'
import MssqlPitrGuidePanel from './MssqlPitrGuidePanel'
import type { ConnType } from '../../types'

export interface AdvCtx {
  connectionId: string
  connType: string
  schema: string
  onClose: () => void
  onRunSql: (sql: string) => void
}

// 已支持 embedded、可作为 DBA 面板 tab 的专属工具 key
export const ADV_EMBEDDED = new Set<string>([
  // MariaDB
  'galera', 'timeravel', 'optimizer', 'maxScale', 'mariaPhysical',
  // PostgreSQL 系
  'pgMaintenance', 'pgReplication', 'pgAdvanced', 'pgPartition', 'pgRoles', 'pgFdw',
  'pgPartman', 'pgBouncer', 'configCompare', 'pgVector', 'pgPitr',
  // 金仓 / openGauss
  'kbMonitor', 'kbAudit', 'ogDbePerf', 'ogIndexAdvise', 'ogSecurity',
  // TiDB / OceanBase / ClickHouse
  'tidb', 'oceanBase', 'clickHouse', 'chLineage',
  // SQL Server
  'mssqlIndexFrag', 'mssqlAgentJobs', 'mssqlWaitStats', 'mssqlBackup', 'mssqlPitr',
])

export function renderAdvancedEmbedded(tool: string, ctx: AdvCtx): React.ReactNode {
  const { connectionId, connType, schema, onClose, onRunSql } = ctx
  switch (tool) {
    // ── MariaDB ──
    case 'galera':        return <GaleraPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'timeravel':     return <TimeravelPanel embedded connectionId={connectionId} defaultSchema={schema} onRunSql={onRunSql} onClose={onClose} />
    case 'optimizer':     return <OptimizerPanel embedded connectionId={connectionId} schema={schema} onClose={onClose} />
    case 'maxScale':      return <MaxScalePanel embedded connectionId={connectionId} onClose={onClose} />
    case 'mariaPhysical': return <MariaPhysicalToolsPanel embedded onClose={onClose} />
    // ── PostgreSQL 系 ──
    case 'pgMaintenance': return <PgMaintenancePanel embedded connectionId={connectionId} schema={schema} onClose={onClose} />
    case 'pgReplication': return <PgReplicationPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'pgAdvanced':    return <PgAdvancedPanel embedded connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
    case 'pgPartition':   return <PgPartitionPanel embedded connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
    case 'pgRoles':       return <PgRolesPanel embedded connectionId={connectionId} onClose={onClose} onRunSql={onRunSql} />
    case 'pgFdw':         return <PgFdwPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'pgPartman':     return <PgPartmanPanel embedded connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
    case 'pgBouncer':     return <PgBouncerPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'configCompare': return <ConfigComparePanel embedded connectionId={connectionId} connType={connType as ConnType} onClose={onClose} />
    case 'pgVector':      return <PgVectorPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'pgPitr':        return <PgPitrGuidePanel embedded onClose={onClose} />
    // ── 金仓 / openGauss ──
    case 'kbMonitor':     return <KbMonitorPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'kbAudit':       return <KbAuditPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'ogDbePerf':     return <OgDbePerfPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'ogIndexAdvise': return <OgIndexAdvisePanel embedded connectionId={connectionId} onClose={onClose} />
    case 'ogSecurity':    return <OgSecurityPanel embedded connectionId={connectionId} onClose={onClose} />
    // ── TiDB / OceanBase / ClickHouse ──
    case 'tidb':          return <TidbPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'oceanBase':     return <OceanBasePanel embedded connectionId={connectionId} onClose={onClose} />
    case 'clickHouse':    return <ClickHousePanel embedded connectionId={connectionId} onClose={onClose} />
    case 'chLineage':     return <ChLineagePanel embedded connectionId={connectionId} onClose={onClose} />
    // ── SQL Server ──
    case 'mssqlIndexFrag': return <MssqlIndexFragPanel embedded connectionId={connectionId} onClose={onClose} onRunSql={onRunSql} />
    case 'mssqlAgentJobs': return <MssqlAgentJobsPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'mssqlWaitStats': return <MssqlWaitStatsPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'mssqlBackup':    return <MssqlBackupPanel embedded connectionId={connectionId} onClose={onClose} />
    case 'mssqlPitr':     return <MssqlPitrGuidePanel embedded onClose={onClose} />
    default:              return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12 }}>该工具尚未支持嵌入</div>
  }
}
