import type { ToolId } from '../../types'
import { getToolInfo } from './catalog'
import {
  Base64Tool,
  CaseTool,
  ColorTool,
  DiffTool,
  HashTool,
  JsonTool,
  JwtTool,
  NumberTool,
  PasswordTool,
  RegexTool,
  TextStatsTool,
  TimestampTool,
  UrlTool,
  UuidTool,
} from './tools/BasicTools'
import { DocumentConvertTool } from './tools/DocumentTools'

export default function ToolPage({ toolId }: { toolId: ToolId }) {
  const info = getToolInfo(toolId)
  const Icon = info.Icon
  return (
    <div className={`tool-page tool-page--${toolId}`}>
      <div className="tool-page__header">
        <span className="tool-page__icon"><Icon size={20} strokeWidth={1.8} /></span>
        <div>
          <h1>{info.title}</h1>
          <p>{info.desc}</p>
        </div>
      </div>
      {toolId === 'json' && <JsonTool />}
      {toolId === 'base64' && <Base64Tool />}
      {toolId === 'url' && <UrlTool />}
      {toolId === 'timestamp' && <TimestampTool />}
      {toolId === 'uuid' && <UuidTool />}
      {toolId === 'hash' && <HashTool />}
      {toolId === 'jwt' && <JwtTool />}
      {toolId === 'regex' && <RegexTool />}
      {toolId === 'color' && <ColorTool />}
      {toolId === 'text' && <TextStatsTool />}
      {toolId === 'password' && <PasswordTool />}
      {toolId === 'case' && <CaseTool />}
      {toolId === 'diff' && <DiffTool />}
      {toolId === 'number' && <NumberTool />}
      {toolId === 'documentConvert' && <DocumentConvertTool />}
    </div>
  )
}
