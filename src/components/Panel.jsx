import { PALETTES, linToHex } from '../engine/palettes.js'

const HandIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <path d="M5.5 8V3.2a1 1 0 0 1 2 0V7.5m0-.5V2.2a1 1 0 0 1 2 0V7m0-.3V3.2a1 1 0 0 1 2 0v5.3c0 3-1.7 5.5-4.6 5.5-1.8 0-2.8-.9-3.7-2.4L2.5 8.8a1 1 0 0 1 1.7-1L5.5 9.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const KnifeIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <path d="M1.5 12.5 11 3h3.5v3L5 12.5z" strokeLinejoin="round" />
    <path d="M9.2 8.3 14.5 13.6" strokeLinecap="round" strokeWidth="2.2" />
  </svg>
)

function Slider({ id, label, value, onChange, lo, hi, disabled }) {
  return (
    <label className="slider" htmlFor={id}>
      <span className="row">
        <span className="label">{label}</span>
        <output htmlFor={id}>{value.toFixed(2)}</output>
      </span>
      <input
        id={id}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="ends" aria-hidden="true">
        <span>{lo}</span>
        <span>{hi}</span>
      </span>
    </label>
  )
}

export default function Panel({ ui, set, actions, disabled }) {
  const keys = Object.keys(PALETTES)
  const onSwatchKey = (e) => {
    const i = keys.indexOf(ui.variety)
    let j = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % keys.length
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + keys.length) % keys.length
    if (j < 0) return
    e.preventDefault()
    set.variety(keys[j])
    e.currentTarget.parentElement.children[j]?.focus()
  }

  return (
    <aside className="panel" aria-label="Specimen controls">
      <div className="group">
        <span className="label" id="toolLabel">Tool</span>
        <div className="tools" role="group" aria-labelledby="toolLabel">
          <button type="button" className="tool" aria-pressed={ui.tool === 'hand'} disabled={disabled} onClick={() => set.tool('hand')}>
            <HandIcon /> Hand
          </button>
          <button type="button" className="tool" aria-pressed={ui.tool === 'knife'} disabled={disabled} onClick={() => set.tool('knife')}>
            <KnifeIcon /> Knife
          </button>
        </div>
      </div>

      <div className="group">
        <span className="label" id="varietyLabel">Variety</span>
        <div className="swatches" role="radiogroup" aria-labelledby="varietyLabel">
          {keys.map((k) => {
            const p = PALETTES[k]
            const checked = ui.variety === k
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="swatch"
                disabled={disabled}
                onClick={() => set.variety(k)}
                onKeyDown={onSwatchKey}
              >
                <span className="chip" aria-hidden="true">
                  <i style={{ background: linToHex(p.skin) }} />
                  <i style={{ background: linToHex(p.pale) }} />
                  <i style={{ background: linToHex(p.ui.flesh) }} />
                </span>
                <span>{p.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="group">
        <Slider id="firmness" label="Firmness" value={ui.firmness} onChange={set.firmness} lo="trembling" hi="set" disabled={disabled} />
        <Slider id="damping" label="Internal damping" value={ui.damping} onChange={set.damping} lo="lively" hi="syrupy" disabled={disabled} />
      </div>

      <div className="group">
        <div className="buttons">
          <button type="button" className="btn" disabled={disabled} onClick={actions.nudge}>Give it a nudge</button>
          <button type="button" className="btn" disabled={disabled} onClick={actions.reset}>Reset</button>
        </div>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={ui.slow} disabled={disabled} onChange={(e) => set.slow(e.target.checked)} />
            <span className="box" aria-hidden="true" />
            ¼ speed
          </label>
          <label className="check">
            <input type="checkbox" checked={ui.showMesh} disabled={disabled} onChange={(e) => set.showMesh(e.target.checked)} />
            <span className="box" aria-hidden="true" />
            Show mesh
          </label>
        </div>
      </div>

      <div className="group">
        <button type="button" className="btn wide" aria-pressed={ui.paused} disabled={disabled} onClick={() => set.paused(!ui.paused)}>
          {ui.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </aside>
  )
}
