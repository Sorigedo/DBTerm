// 全局 DB 工具面板 host：根据 dbToolsStore 渲染当前打开的运维面板。
// 面板本体按需加载，避免首屏解析所有数据库工具。
import { lazy, Suspense } from 'react'
import { useDbToolsStore } from '../../stores/dbToolsStore'
import { useAppStore } from '../../stores/appStore'

const DbaPanel = lazy(() => import('./DbaPanel'))
const OraclePanel = lazy(() => import('./OraclePanel'))
const DatabaseManagerPanel = lazy(() => import('./DatabaseManagerPanel'))
const DataDictPanel = lazy(() => import('./DataDictPanel'))
const ErDiagramPanel = lazy(() => import('./ErDiagramPanel'))
const FullTextSearchPanel = lazy(() => import('./FullTextSearchPanel'))
const BackupRestorePanel = lazy(() => import('./BackupRestorePanel'))
const ExportTaskCenter = lazy(() => import('./ExportTaskCenter'))
const SchedulerPanel = lazy(() => import('./SchedulerPanel'))
const BinlogFlashbackPanel = lazy(() => import('./BinlogFlashbackPanel'))
const OnlineDdlPanel = lazy(() => import('./OnlineDdlPanel'))
const TimeravelPanel = lazy(() => import('./TimeravelPanel'))
const GaleraPanel = lazy(() => import('./GaleraPanel'))
const OptimizerPanel = lazy(() => import('./OptimizerPanel'))
const MaxScalePanel = lazy(() => import('./MaxScalePanel'))
const MariaPhysicalToolsPanel = lazy(() => import('./MariaPhysicalToolsPanel'))
const PgMaintenancePanel = lazy(() => import('./PgMaintenancePanel'))
const PgReplicationPanel = lazy(() => import('./PgReplicationPanel'))
const PgAdvancedPanel = lazy(() => import('./PgAdvancedPanel'))
const PgPartitionPanel = lazy(() => import('./PgPartitionPanel'))
const PgRolesPanel = lazy(() => import('./PgRolesPanel'))
const PgFdwPanel = lazy(() => import('./PgFdwPanel'))
const PgPartmanPanel = lazy(() => import('./PgPartmanPanel'))
const PgBouncerPanel = lazy(() => import('./PgBouncerPanel'))
const ConfigComparePanel = lazy(() => import('./ConfigComparePanel'))
const PgVectorPanel = lazy(() => import('./PgVectorPanel'))
const PgPitrGuidePanel = lazy(() => import('./PgPitrGuidePanel'))
const KbMonitorPanel = lazy(() => import('./KbMonitorPanel'))
const KbAuditPanel = lazy(() => import('./KbAuditPanel'))
const OgDbePerfPanel = lazy(() => import('./OgDbePerfPanel'))
const OgIndexAdvisePanel = lazy(() => import('./OgIndexAdvisePanel'))
const OgSecurityPanel = lazy(() => import('./OgSecurityPanel'))
const TidbPanel = lazy(() => import('./TidbPanel'))
const OceanBasePanel = lazy(() => import('./OceanBasePanel'))
const ClickHousePanel = lazy(() => import('./ClickHousePanel'))
const ChLineagePanel = lazy(() => import('./ChLineagePanel'))
const RedisToolsPanel = lazy(() => import('./RedisToolsPanel'))
const MssqlIndexFragPanel = lazy(() => import('./MssqlToolsPanels').then((m) => ({ default: m.MssqlIndexFragPanel })))
const MssqlAgentJobsPanel = lazy(() => import('./MssqlToolsPanels').then((m) => ({ default: m.MssqlAgentJobsPanel })))
const MssqlWaitStatsPanel = lazy(() => import('./MssqlToolsPanels').then((m) => ({ default: m.MssqlWaitStatsPanel })))
const MssqlBackupPanel = lazy(() => import('./MssqlToolsPanels').then((m) => ({ default: m.MssqlBackupPanel })))
const MssqlPitrGuidePanel = lazy(() => import('./MssqlPitrGuidePanel'))

function runSql(connId: string, sql: string) {
  window.dispatchEvent(new CustomEvent('dbterm:run-sql', { detail: { sql, connId } }))
}

function LoadingPanel() {
  return (
    <div className="modal-overlay">
      <div className="db-tool-loading">正在加载数据库工具...</div>
    </div>
  )
}

function renderMssqlTool(tool: string, connectionId: string, onClose: () => void) {
  const onRunSql = (sql: string) => runSql(connectionId, sql)
  switch (tool) {
    case 'mssqlIndexFrag':
      return <MssqlIndexFragPanel connectionId={connectionId} onClose={onClose} onRunSql={onRunSql} />
    case 'mssqlAgentJobs':
      return <MssqlAgentJobsPanel connectionId={connectionId} onClose={onClose} />
    case 'mssqlWaitStats':
      return <MssqlWaitStatsPanel connectionId={connectionId} onClose={onClose} />
    case 'mssqlBackup':
      return <MssqlBackupPanel connectionId={connectionId} onClose={onClose} />
    case 'mssqlPitr':
      return <MssqlPitrGuidePanel onClose={onClose} />
    default:
      return null
  }
}

export default function DbToolPanels() {
  const open = useDbToolsStore((s) => s.open)
  const close = useDbToolsStore((s) => s.closeTool)
  const connections = useAppStore((s) => s.connections)
  if (!open) return null
  const { tool, ctx } = open
  const { connectionId, connType, schema } = ctx
  const connName = connections.find((c) => c.id === connectionId)?.name ?? connectionId
  const onClose = close
  const onRunSql = (sql: string) => runSql(connectionId, sql)

  let panel: React.ReactNode = null
  switch (tool) {
    case 'dbaPanel':
      panel = connType === 'oracle'
        ? <OraclePanel connectionId={connectionId} onClose={onClose} />
        : <DbaPanel connectionId={connectionId} connType={connType} onClose={onClose} />
      break

    case 'dbManager':
      panel = <DatabaseManagerPanel connectionId={connectionId} currentSchema={schema} onClose={onClose} onRefresh={() => window.dispatchEvent(new CustomEvent('dbterm:schemas-changed', { detail: { connId: connectionId } }))} />
      break
    case 'dataDict':
      panel = <DataDictPanel connectionId={connectionId} schema={schema} onClose={onClose} />
      break
    case 'erDiagram':
      panel = <ErDiagramPanel connId={connectionId} schema={schema} connName={connName} onClose={onClose} />
      break
    case 'fullText':
      panel = <FullTextSearchPanel connId={connectionId} schema={schema} connName={connName} onClose={onClose} />
      break
    case 'backupRestore':
      panel = <BackupRestorePanel connectionId={connectionId} schema={schema} onClose={onClose} />
      break
    case 'exportCenter':
      panel = <ExportTaskCenter onClose={onClose} />
      break
    case 'scheduler':
      panel = <SchedulerPanel connId={connectionId} connName={connName} onClose={onClose} />
      break
    case 'binlogFb':
      panel = <BinlogFlashbackPanel connectionId={connectionId} connType={connType} onClose={onClose} />
      break
    case 'onlineDdl':
      panel = <OnlineDdlPanel connectionId={connectionId} schema={schema} connType={connType} onClose={onClose} onRunSql={onRunSql} />
      break

    case 'timeravel':
      panel = <TimeravelPanel connectionId={connectionId} defaultSchema={schema} onRunSql={onRunSql} onClose={onClose} />
      break
    case 'galera':
      panel = <GaleraPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'optimizer':
      panel = <OptimizerPanel connectionId={connectionId} schema={schema} onClose={onClose} />
      break
    case 'maxScale':
      panel = <MaxScalePanel connectionId={connectionId} onClose={onClose} />
      break
    case 'mariaPhysical':
      panel = <MariaPhysicalToolsPanel onClose={onClose} />
      break
    case 'pgMaintenance':
      panel = <PgMaintenancePanel connectionId={connectionId} schema={schema} onClose={onClose} />
      break
    case 'pgReplication':
      panel = <PgReplicationPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'pgAdvanced':
      panel = <PgAdvancedPanel connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
      break
    case 'pgPartition':
      panel = <PgPartitionPanel connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
      break
    case 'pgRoles':
      panel = <PgRolesPanel connectionId={connectionId} onClose={onClose} onRunSql={onRunSql} />
      break
    case 'pgFdw':
      panel = <PgFdwPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'pgPartman':
      panel = <PgPartmanPanel connectionId={connectionId} schema={schema} onClose={onClose} onRunSql={onRunSql} />
      break
    case 'pgBouncer':
      panel = <PgBouncerPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'configCompare':
      panel = <ConfigComparePanel connectionId={connectionId} connType={connType} onClose={onClose} />
      break
    case 'pgVector':
      panel = <PgVectorPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'pgPitr':
      panel = <PgPitrGuidePanel onClose={onClose} />
      break
    case 'kbMonitor':
      panel = <KbMonitorPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'kbAudit':
      panel = <KbAuditPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'ogDbePerf':
      panel = <OgDbePerfPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'ogIndexAdvise':
      panel = <OgIndexAdvisePanel connectionId={connectionId} onClose={onClose} />
      break
    case 'ogSecurity':
      panel = <OgSecurityPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'tidb':
      panel = <TidbPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'oceanBase':
      panel = <OceanBasePanel connectionId={connectionId} onClose={onClose} />
      break
    case 'clickHouse':
      panel = <ClickHousePanel connectionId={connectionId} onClose={onClose} />
      break
    case 'chLineage':
      panel = <ChLineagePanel connectionId={connectionId} onClose={onClose} />
      break
    case 'redisTools':
      panel = <RedisToolsPanel connectionId={connectionId} onClose={onClose} />
      break
    case 'mssqlIndexFrag':
    case 'mssqlAgentJobs':
    case 'mssqlWaitStats':
    case 'mssqlBackup':
    case 'mssqlPitr':
      panel = renderMssqlTool(tool, connectionId, onClose)
      break

    default:
      panel = null
  }

  return <Suspense fallback={<LoadingPanel />}>{panel}</Suspense>
}
