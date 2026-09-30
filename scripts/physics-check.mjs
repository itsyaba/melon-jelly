import { initialPiece, buildWorld } from '../src/engine/pieces.js';
import { SoftBody } from '../src/engine/physics.js';
import { buildKnifeMesh } from '../src/engine/knife.js';
const w = buildWorld([initialPiece()]);
const sim = new SoftBody(w);
sim.reset(0.35);
let t0 = performance.now();
for (let f = 0; f < 180; f++) {
  sim.step();
  if (f % 20 === 0 || f === 179) console.log(f, 'KE/M', (sim.kineticEnergy()/sim.totalMass).toExponential(2), 'vol', sim.volumeRatio().toFixed(4), 'minY', sim.minY().toFixed(4), 'minVR', sim.minVolumeRatio().toFixed(3), 'c', sim.centroid().map(v=>v.toFixed(3)).join(','));
}
console.log('ms/step', ((performance.now()-t0)/180).toFixed(2));
// grab & pull
const c = sim.centroid();
const tip = [0, 0.3, 0.2];
sim.beginGrab(tip, 0.4);
for (let f = 0; f < 90; f++) { sim.moveGrab([0, 2.0, -1.5]); sim.step(); }
console.log('pulled: vol', sim.volumeRatio().toFixed(4), 'minVR', sim.minVolumeRatio().toFixed(3), 'minY', sim.minY().toFixed(3), 'strain', sim.meanStrain().toFixed(3));
sim.endGrab();
for (let f = 0; f < 240; f++) sim.step();
console.log('released: KE/M', (sim.kineticEnergy()/sim.totalMass).toExponential(2), 'vol', sim.volumeRatio().toFixed(4), 'minVR', sim.minVolumeRatio().toFixed(3));
sim.nudge(1); for (let f = 0; f < 240; f++) sim.step();
console.log('nudged: KE/M', (sim.kineticEnergy()/sim.totalMass).toExponential(2), 'vol', sim.volumeRatio().toFixed(4), 'minY', sim.minY().toFixed(3));
const k = buildKnifeMesh(); console.log('knife verts', k.nV, 'tris', k.index.length/3);
