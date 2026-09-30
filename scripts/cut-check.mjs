// Cutting stress test. "largest": always cut the biggest piece — every cut must succeed up to
// MAX_PIECES. "smallest": always cut the tiniest piece — must keep going down to crumbs.
// Either way the resulting soft body must stay stable.
import { initialPiece, buildWorld, splitPiece, MAX_PIECES } from '../src/engine/pieces.js';
import { polyCentroid } from '../src/engine/geometry.js';
import { SoftBody } from '../src/engine/physics.js';

function run(mode) {
  let pieces = [initialPiece()], fails = 0;
  for (let k = 0; pieces.length < MAX_PIECES && fails < 3; k++) {
    buildWorld(pieces);
    let s = 0;
    const size = (i) => pieces[i].cache.sim.n * (mode === 'largest' ? -1 : 1);
    for (let i = 1; i < pieces.length; i++) if (size(i) < size(s)) s = i;
    const pc = pieces[s], [cu, cw] = polyCentroid(pc.I), ang = k * 2.39996;
    const a = Math.cos(ang), b = Math.sin(ang);
    const halves = splitPiece(pc, a, b, a * cu + b * cw);
    if (!halves) { fails++; continue; }
    pieces.splice(s, 1, ...halves);
  }
  const world = buildWorld(pieces);
  const sim = new SoftBody(world, { firmness: 0.4, damping: 0.45 });
  const t1 = performance.now();
  for (let i = 0; i < 180; i++) sim.step();
  const ms = (performance.now() - t1) / 180;
  const stable = Number.isFinite(sim.minY()) && sim.minVolumeRatio() > 0 && sim.volumeRatio() > 0.95;
  const ok = stable && (mode === 'largest' ? fails === 0 && pieces.length === MAX_PIECES : pieces.length >= 9);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode}: ${pieces.length} pieces, ${fails} refused, ${world.n} particles, ` +
    `vol ${(sim.volumeRatio() * 100).toFixed(1)}%, min tet ratio ${sim.minVolumeRatio().toFixed(2)}, ${ms.toFixed(1)} ms/step`);
  return ok;
}
const ok = [run('largest'), run('smallest')].every(Boolean);
process.exit(ok ? 0 : 1);
