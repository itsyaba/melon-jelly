import { useCallback, useEffect, useRef, useState } from 'react'
import Panel from './components/Panel.jsx'
import Readouts from './components/Readouts.jsx'
import Notes from './components/Notes.jsx'
import { PALETTES, linToHex } from './engine/palettes.js'

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const FALLBACKS = {
  'no-webgpu': {
    title: 'This specimen needs WebGPU.',
    body: 'Open it in a current Chrome or Edge, Safari 26 or newer, or Firefox on Windows. The page deliberately does not fake it with a weaker renderer.',
  },
  'no-adapter': {
    title: 'No GPU adapter was available.',
    body: 'Your browser supports WebGPU, but hardware acceleration looks switched off, or this GPU is on the browser’s block list.',
  },
  lost: {
    title: 'The GPU device was lost.',
    body: 'Reload the page to start the specimen again.',
  },
}

export default function App() {
  const canvasRef = useRef(null)
  const strokeRef = useRef(null)
  const engineRef = useRef(null)
  const toastTimer = useRef(0)

  const [ui, setUi] = useState({
    tool: 'hand',
    variety: 'crimson',
    firmness: 0.4,
    damping: reducedMotion ? 0.65 : 0.45,
    slow: false,
    showMesh: false,
    paused: false,
  })
  const uiRef = useRef(ui)
  uiRef.current = ui

  const [status, setStatus] = useState({ text: 'WEBGPU · STARTING', state: 'idle' })
  const [stats, setStats] = useState({ mass: '—', vol: '—', ke: '—', pieces: '1' })
  const [counts, setCounts] = useState({ particles: 0, tets: 0 })
  const [toast, setToast] = useState({ msg: '', show: false })
  const [fallback, setFallback] = useState(null)

  const showToast = useCallback((msg) => {
    clearTimeout(toastTimer.current)
    setToast({ msg, show: true })
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, show: false })), 2600)
  }, [])

  // Start the engine once. StrictMode mounts twice in dev, so creation is cancellable.
  useEffect(() => {
    let cancelled = false
    let engine = null
    const showFallback = (code, message) => {
      const f = FALLBACKS[code] || {
        title: 'The renderer could not start.',
        body: 'Something went wrong while setting up WebGPU.',
        detail: String(message || code).slice(0, 400),
      }
      setFallback(f)
      setStatus({ text: 'WEBGPU · UNAVAILABLE', state: 'off' })
      document.body.classList.add('no-gpu')
    }

    import('./engine/app.js')
      .then(({ createEngine }) =>
        createEngine({
          canvas: canvasRef.current,
          strokeLine: strokeRef.current,
          settings: { ...uiRef.current, reducedMotion },
          on: {
            status: (text, state) => setStatus({ text, state }),
            stats: setStats,
            counts: setCounts,
            toast: showToast,
            lost: (message) => showFallback(message ? 'error' : 'lost', message),
          },
        }),
      )
      .then((e) => {
        if (cancelled) e.destroy()
        else engine = engineRef.current = e
      })
      .catch((err) => {
        if (cancelled) return
        console.error(err)
        showFallback(err?.message, err?.message)
      })

    return () => {
      cancelled = true
      engine?.destroy()
      engineRef.current = null
      document.body.classList.remove('ready', 'no-gpu')
    }
  }, [showToast])

  // Variety also drives the page accent.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', linToHex(PALETTES[ui.variety].ui.flesh))
  }, [ui.variety])

  const set = {
    tool: (tool) => { setUi((u) => ({ ...u, tool })); engineRef.current?.setTool(tool) },
    variety: (variety) => { setUi((u) => ({ ...u, variety })); engineRef.current?.setVariety(variety) },
    firmness: (firmness) => { setUi((u) => ({ ...u, firmness })); engineRef.current?.setFirmness(firmness) },
    damping: (damping) => { setUi((u) => ({ ...u, damping })); engineRef.current?.setDamping(damping) },
    slow: (slow) => { setUi((u) => ({ ...u, slow })); engineRef.current?.setSlow(slow) },
    showMesh: (showMesh) => { setUi((u) => ({ ...u, showMesh })); engineRef.current?.setShowMesh(showMesh) },
    paused: (paused) => { setUi((u) => ({ ...u, paused })); engineRef.current?.setPaused(paused) },
  }
  const setRef = useRef(set)
  setRef.current = set

  const actions = {
    nudge: () => engineRef.current?.nudge(reducedMotion ? 0.45 : 1),
    reset: () => engineRef.current?.reset(),
  }
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  // Keyboard shortcuts (ignored while typing or operating a control).
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !engineRef.current) return
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const k = e.key.toLowerCase()
      const s = setRef.current
      const u = uiRef.current
      if (e.key === ' ') { e.preventDefault(); s.paused(!u.paused) }
      else if (k === 'n') actionsRef.current.nudge()
      else if (k === 'r') actionsRef.current.reset()
      else if (k === 'k') s.tool(u.tool === 'knife' ? 'hand' : 'knife')
      else if (k === 'h') s.tool('hand')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const disabled = !!fallback

  return (
    <>
      <div className="stage" id="stage">
        <canvas
          id="gl"
          ref={canvasRef}
          role="img"
          aria-label="Interactive 3D watermelon jelly slice on a paper studio floor. Grab and pull it with the Hand tool, or draw a line with the Knife tool to cut it into pieces."
        />
        <svg className="stroke" id="stroke" aria-hidden="true">
          <line id="strokeLine" ref={strokeRef} />
        </svg>
        <div className={'toast' + (toast.show ? ' show' : '')} id="toast" role="status" aria-live="polite">
          {toast.msg}
        </div>
        <div className="fallback" id="fallback" hidden={!fallback}>
          {fallback && (
            <>
              <span className="label">Specimen unavailable</span>
              <h2>{fallback.title}</h2>
              <p>{fallback.body}</p>
              {fallback.detail && <code>{fallback.detail}</code>}
            </>
          )}
        </div>
      </div>

      <header className="masthead" id="masthead">
        <div className="kicker">
          <span className="no">No. 009</span>
          <span className="label">Material Studies</span>
        </div>
        <h1 id="headline">
          <span>Melon</span>
          <span>Jelly.</span>
        </h1>
        <p className="caption">
          A slice of watermelon jelly you can pull and cut. About a thousand particles of soft body, lit through like
          candy. Nothing here is a picture.
        </p>
      </header>

      <div className="status" id="status" data-state={status.state} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        <span className="text">{status.text}</span>
      </div>

      <Panel ui={ui} set={set} actions={actions} disabled={disabled} />
      <Readouts tool={ui.tool} stats={stats} />
      <Notes counts={counts} />
    </>
  )
}
