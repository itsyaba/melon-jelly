const HINTS = {
  hand: 'Grab any piece — tip, corner, flesh or rind — and pull. Scroll, or add a second finger, while holding to twist it.',
  knife: 'Draw a line across the slice — the knife lines up over it and cuts when you let go. Cut the pieces again, as small as you like.',
}

export default function Readouts({ tool, stats }) {
  return (
    <section className="readouts" aria-label="Live readouts">
      <p className="hint" aria-live="polite">{HINTS[tool]}</p>
      <dl className="stats">
        <div>
          <dt className="label">Mass</dt>
          <dd>{stats.mass}<small>g</small></dd>
        </div>
        <div>
          <dt className="label">Volume</dt>
          <dd>{stats.vol}<small>%</small></dd>
        </div>
        <div>
          <dt className="label">Kinetic</dt>
          <dd>{stats.ke}<small>µJ</small></dd>
        </div>
        <div>
          <dt className="label">Pieces</dt>
          <dd>{stats.pieces}</dd>
        </div>
      </dl>
      <p className="footnote">Illustrative scale: 1 unit ≈ 3.5 cm, gummy candy at 1.3 g/cm³.</p>
    </section>
  )
}
