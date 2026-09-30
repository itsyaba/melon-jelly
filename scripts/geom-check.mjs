import { initialPiece, buildWorld, splitPiece } from '../src/engine/pieces.js';
import { tetVolume } from '../src/engine/geometry.js';
let t0 = performance.now();
const p = initialPiece();
const w = buildWorld([p]);
console.log('build ms', (performance.now() - t0).toFixed(0));
console.log('particles', w.n, 'tets', w.nT, 'renderV', w.mesh.nV, 'ranges', JSON.stringify(w.mesh.ranges));
let minV = Infinity, tot = 0;
for (let t = 0; t < w.nT; t++) { const v = tetVolume(w.rest, ...w.tets.slice(4*t, 4*t+4)); minV = Math.min(minV, v); tot += v; }
console.log('min tet vol', minV.toExponential(2), 'total vol', tot.toFixed(3));
let minW = 0; for (const x of w.mesh.skinW) minW = Math.min(minW, x);
console.log('min skin weight', minW.toFixed(3));
const reg = [0,0,0]; for (const r of w.region) reg[r]++; console.log('regions', reg);
t0 = performance.now();
const halves = splitPiece(p, 1, 0, 0.1);
const w2 = buildWorld(halves);
console.log('split build ms', (performance.now() - t0).toFixed(0), 'n', w2.n, 'nComp', w2.nComp);
