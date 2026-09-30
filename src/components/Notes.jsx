export default function Notes({ counts }) {
  return (
    <details className="notes">
      <summary>
        <span className="t">Inside the experiment</span>
        <span className="pm" aria-hidden="true" />
      </summary>
      <div className="body">
        <p>
          <b>A real soft body.</b> The slice is filled with <span className="num">{counts.particles || '—'}</span> particles
          joined into <span className="num">{counts.tets || '—'}</span> tetrahedra. Every sixtieth of a second, ten small
          XPBD substeps pull each tetrahedron back toward a rotated copy of its rest shape and hold its volume. The rind is
          about three times stiffer than the flesh.
        </p>
        <p>
          <b>The knife is a constraint.</b> The blade dents the jelly into a groove, then breaks through. The slice is
          re-meshed along the cut and the new pieces inherit the exact pose and velocity of the flesh they came from.
          Everything shares one rest frame, so seeds and rind never move.
        </p>
        <p>
          <b>Light through candy.</b> Colour comes from absorption, not paint: the renderer measures how far each ray
          travels through the jelly and filters the scene behind it by that distance (Beer–Lambert). The pale rind
          scatters, thin edges glow when lit from behind, and the shadow is tinted by what passed through.
        </p>
        <p>
          <b>No libraries.</b> Geometry, Delaunay triangulation, physics, matrix maths and the WGSL shaders are all
          hand-written. It needs WebGPU and does not fall back to a lesser renderer.
        </p>
        <p>
          Keys: <span className="num">Space</span> pause · <span className="num">N</span> nudge ·{' '}
          <span className="num">R</span> reset · <span className="num">K</span> knife ·{' '}
          <span className="num">H</span> hand. Double-click resets the view.
        </p>
      </div>
    </details>
  )
}
