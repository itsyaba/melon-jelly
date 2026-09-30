# Melon Jelly

*No. 009, Material Studies.* A slice of watermelon jelly you can pull and cut, rendered with
WebGPU and simulated as a real soft body. Nothing on the page is a picture: the geometry,
Delaunay tetrahedralisation, XPBD physics, matrix maths and WGSL are all hand-written. The only
runtime dependency is React, which runs the specimen-sheet UI.

## Run it

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # static build in dist/
```

It needs a browser with WebGPU: current Chrome or Edge, Safari 26+, or Firefox on Windows.
Without WebGPU the page shows a fallback notice rather than a weaker renderer.

### Controls

| | |
|---|---|
| **Hand** | Drag any part of the slice to pull it. Scroll (or add a second finger) while holding to twist it. |
| **Knife** | Draw a line across the slice. The knife lines up over the line, presses in and cuts when you let go. Pieces can be cut again. |
| `Space` | Pause / resume |
| `N` / `R` | Nudge / reset |
| `K` / `H` | Knife / hand |

The panel sets the variety (crimson, golden, rosé), firmness, internal damping, ¼ speed and a
wireframe of the simulation mesh.

## How it works

```
src/
  App.jsx, components/      React UI: masthead, panel, readouts, notes
  index.css                 specimen-sheet design system and responsive layouts
  engine/
    app.js                  engine entry: camera, picking, tools, knife choreography, frame loop
    geometry.js             wedge SDF, hex lattice, Bowyer–Watson Delaunay, barycentric embedding
    pieces.js               piece model (convex inner polygon grown by RC), splitting, world build
    physics.js              XPBD soft body: co-rotational tet shape matching, volume, friction,
                            grab, piece–piece collisions, blade constraint
    knife.js                procedural chef's knife mesh and poses
    renderer.js             WebGPU passes: key shadow, contact height map, MSAA scene,
                            back-face depth, refractive jelly, tone map
    shaders.js              all WGSL
    palettes.js, math.js
```

- **Physics:** about 600 particles and 2,200 tetrahedra, 10 XPBD substeps per 60 Hz frame. The
  step count adapts to the machine so slow CPUs don't spiral.
- **Cutting:** every piece is a convex polygon in one shared rest frame, with its real outline
  grown by `RC`. A cut clips the polygon at `±RC`, so both rounded halves meet exactly on the
  knife line. The new world is built while the knife is still in the air, and state is carried
  over by barycentric embedding into the old tetrahedra. Pieces narrower than about 2·RC can't be
  split again ("Too thin to cut there"), and there are at most 14 pieces.
- **Rendering:** the jelly pass refracts the scene behind it using the back-face depth for
  thickness, applies coloured absorption, scatters light in the pale rind, and adds back-lit edge
  glow and studio reflections. The result is tone-mapped with Khronos PBR Neutral.

## Checks

```sh
pnpm check                      # Node: geometry + physics (settling, volume, stretch)
pnpm dev --port 5391 &          # then, with Playwright's Chromium installed:
pnpm e2e http://localhost:5391/ # browser checks + screenshots into e2e-shots/
```

The e2e run covers settling, the backdrop colour, grab and stretch without inverted tets, knife
cuts and separation, many cuts with a clean refusal, reset, pause, fps and the short-desktop and
phone layouts, and fails on any page errors.

## Making another Material Study

The engine doesn't know it is a watermelon. To make a new specimen:

1. **Shape:** change `SHAPE` and `sdShape` in `geometry.js` (any extruded convex outline works
   directly with the piece model), plus `regionOf` for the material bands.
2. **Materials:** add palettes in `palettes.js` and adjust the region colours and absorption in
   `fsJelly` (`shaders.js`). The props (seeds, bubbles) come from `globalProps()`.
3. **Feel:** firmness and damping map to compliance in `physics.js`. The slider ranges are in
   `Panel.jsx`.
4. **Copy:** masthead, hints and notes live in `App.jsx`, `Readouts.jsx` and `Notes.jsx`.
