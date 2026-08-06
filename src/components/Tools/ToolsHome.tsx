import { TOOLS } from './catalog'
import { openToolTab } from './openToolTab'

export default function ToolsHome() {
  return (
    <div className="tools-home">
      <div className="tools-home__header">
        <div>
          <h1>工具中心</h1>
          <p>常用开发与运维小工具</p>
        </div>
      </div>

      <div className="tools-grid">
        {TOOLS.map(({ id, title, desc, Icon }) => (
          <button key={id} className="tool-card" onClick={() => openToolTab(id, title)}>
            <span className="tool-card__icon"><Icon size={22} strokeWidth={1.8} /></span>
            <span className="tool-card__body">
              <span className="tool-card__title">{title}</span>
              <span className="tool-card__desc">{desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
