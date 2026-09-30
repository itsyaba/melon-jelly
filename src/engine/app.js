// App glue: skinning, camera, light, picking, input, cutting, knife choreography, loop, readouts.

import { SHAPE, embed, polyCentroid } from './geometry.js';
import { initialPiece, buildWorld, splitPiece, lineCrossesPiece, MAX_PIECES } from './pieces.js';
import { SoftBody } from './physics.js';
import { Renderer, UNIFORM_FLOATS } from './renderer.js';
import { buildKnifeMesh, poseKnife } from './knife.js';
import { PALETTES, hexToLin } from './palettes.js';
import {
  M4, sub, add, scale, dot, cross, norm, clamp, rotMat, mat3MulVec, mat3TMulVec,
} from './math.js';

const KT = { align: 0.16, press: 0.42, through: 0.6, hold: 0.7, lift: 1.08 };
const HOME = [0, 0.24, 1.0];
const FOV = (27 * Math.PI) / 180;
const KEY_DIR = norm([-0.45, 0.86, -0.36]);
const KEY_INTENSITY = 2.3;
const BG_HEX = '#E2DFDA';
const STACKED_MQ = '(max-width: 860px), (max-height: 560px) and (max-width: 1000px)';

const MSG = {
  miss: 'Missed — draw the blade across the slice.',
  plenty: 'That’s plenty of pieces. Reset to start a fresh slice.',
  thin: 'Too thin to cut there.',
  busy: 'One cut at a time.',
  paused: 'Resume to cut.',
};

const easeInOut = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export async function createEngine({ canvas, strokeLine, settings, on = {} }) {
  const emit = (name, ...args) => on[name]?.(...args);
  const state = {
    tool: settings.tool || 'hand',
    variety: settings.variety || 'crimson',
    paused: !!settings.paused,
    slow: !!settings.slow,
    showMesh: !!settings.showMesh,
    reducedMotion: !!settings.reducedMotion,
  };

  // ------------------------------------------------------------------ world
  const wholePiece = initialPiece();
  let pieces = [wholePiece];
  let world = buildWorld(pieces);
  let sim = new SoftBody(world, { firmness: settings.firmness ?? 0.4, damping: settings.damping ?? 0.45 });
  sim.reset(state.reducedMotion ? 0.0 : 0.35);
  let mesh = world.mesh;
  const homeCentroid = sim.centroid();
  const knifeMesh = buildKnifeMesh();

  let renderer = await Renderer.create(canvas, mesh, sim.edges, sim.n);
  renderer.setKnife(knifeMesh);
  let dyn = renderer.dyn;
  emit('counts', { particles: sim.n, tets: sim.nT });

  // ------------------------------------------------------------------ skinning
  function skin() {
    const { skinIdx, skinW, index, nV } = mesh, x = sim.x, d = dyn;
    for (let v = 0; v < nV; v++) {
      const i4 = 4 * v, o = 6 * v;
      const a = 3 * skinIdx[i4], b = 3 * skinIdx[i4 + 1], c = 3 * skinIdx[i4 + 2], e = 3 * skinIdx[i4 + 3];
      const w0 = skinW[i4], w1 = skinW[i4 + 1], w2 = skinW[i4 + 2], w3 = skinW[i4 + 3];
      d[o] = x[a] * w0 + x[b] * w1 + x[c] * w2 + x[e] * w3;
      d[o + 1] = x[a + 1] * w0 + x[b + 1] * w1 + x[c + 1] * w2 + x[e + 1] * w3;
      d[o + 2] = x[a + 2] * w0 + x[b + 2] * w1 + x[c + 2] * w2 + x[e + 2] * w3;
      d[o + 3] = 0; d[o + 4] = 0; d[o + 5] = 0;
    }
    // area-weighted face normals over ALL triangles
    for (let i = 0; i < index.length; i += 3) {
      const a = 6 * index[i], b = 6 * index[i + 1], c = 6 * index[i + 2];
      const e1x = d[b] - d[a], e1y = d[b + 1] - d[a + 1], e1z = d[b + 2] - d[a + 2];
      const e2x = d[c] - d[a], e2y = d[c + 1] - d[a + 1], e2z = d[c + 2] - d[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      d[a + 3] += nx; d[a + 4] += ny; d[a + 5] += nz;
      d[b + 3] += nx; d[b + 4] += ny; d[b + 5] += nz;
      d[c + 3] += nx; d[c + 4] += ny; d[c + 5] += nz;
    }
    for (let v = 0; v < nV; v++) {
      const o = 6 * v, l = Math.sqrt(d[o + 3] * d[o + 3] + d[o + 4] * d[o + 4] + d[o + 5] * d[o + 5]) || 1;
      d[o + 3] /= l; d[o + 4] /= l; d[o + 5] /= l;
    }
  }

  // ------------------------------------------------------------------ camera
  const cam = {
    az: 0.62, el: 0.6, zoom: 1, target: HOME.slice(),
    eye: [0, 0, 0], fwd: [0, 0, -1], right: [1, 0, 0],
    view: M4.identity(), proj: M4.identity(), viewProj: M4.identity(), invViewProj: M4.identity(),
  };
  let stacked = false;
  let cr = canvas.getBoundingClientRect();

  function safeRect() {
    const W = cr.width, H = cr.height, full = { x: 0, y: 0, w: W, h: H };
    if (stacked) return full;
    const hl = document.getElementById('headline')?.getBoundingClientRect();
    const panel = document.querySelector('.panel')?.getBoundingClientRect();
    const read = document.querySelector('.readouts')?.getBoundingClientRect();
    const left = hl ? Math.max(0, (hl.right - cr.left) * 0.3) : 0;
    const right = panel ? panel.left - cr.left - 16 : W;
    const top = hl ? Math.max(0, hl.bottom - cr.top - hl.height * 0.35) : 0;
    const bottom = read ? read.top - cr.top + read.height * 0.25 : H;
    const r = { x: left, y: top, w: right - left, h: bottom - top };
    if (r.w < W * 0.4 || r.h < H * 0.4) return full;
    return r;
  }

  function updateCamera() {
    const W = Math.max(1, cr.width), H = Math.max(1, cr.height), aspect = W / H;
    const r = safeRect(), t2 = Math.tan(FOV / 2), hf = r.h / H, wf = r.w / W;
    const Rh = 1.32, Rv = 1.0;
    const dist = Math.max(Rv / (t2 * 0.9 * hf), Rh / (t2 * 0.92 * aspect * wf)) * cam.zoom;
    const ce = Math.cos(cam.el);
    cam.eye = add(cam.target, scale([ce * Math.sin(cam.az), Math.sin(cam.el), ce * Math.cos(cam.az)], dist));
    cam.view = M4.lookAt(cam.eye, cam.target, [0, 1, 0]);
    const proj = M4.perspective(FOV, aspect, 0.05, 80);
    const cx = (r.x + r.w / 2) / W, cy = (r.y + r.h / 2) / H;
    proj[8] -= cx * 2 - 1;
    proj[9] -= -(cy * 2 - 1);
    cam.proj = proj;
    cam.viewProj = M4.mul(proj, cam.view);
    cam.invViewProj = M4.invert(cam.viewProj);
    cam.fwd = norm(sub(cam.target, cam.eye));
    cam.right = norm(cross(cam.fwd, [0, 1, 0]));
  }

  // keep a thrown slice in view
  function followSlice(dt) {
    if (sim.grabbing) return;
    const c = sim.centroid(), k = 1 - Math.exp(-1.4 * dt);
    const gx = HOME[0] + 0.7 * (c[0] - homeCentroid[0]), gz = HOME[2] + 0.7 * (c[2] - homeCentroid[2]);
    cam.target[0] += (clamp(gx, -3, 3) - cam.target[0]) * k;
    cam.target[2] += (clamp(gz, -2, 4) - cam.target[2]) * k;
  }

  function resetView() {
    cam.az = 0.62; cam.el = 0.6; cam.zoom = 1;
    cam.target = HOME.slice();
  }

  // ------------------------------------------------------------------ light
  const light = { lightVP: M4.identity(), topVP: M4.identity() };
  function updateLight() {
    const c = sim.centroid(), at = [clamp(c[0], -4, 4), 0.3, clamp(c[2], -4, 5)];
    light.lightVP = M4.mul(M4.ortho(-2.4, 2.4, -2.4, 2.4, 0.1, 14), M4.lookAt(add(at, scale(KEY_DIR, 7)), at, [0, 0, 1]));
    light.topVP = M4.mul(M4.ortho(-2.6, 2.6, -2.6, 2.6, 0, 5), M4.lookAt([at[0], -1, at[2]], [at[0], 1, at[2]], [0, 0, -1]));
  }

  // ------------------------------------------------------------------ uniforms
  const U = new Float32Array(UNIFORM_FLOATS);
  const bgLin = hexToLin(BG_HEX).map((c) => c + 0.04);
  function packUniforms(time) {
    const p = PALETTES[state.variety], [w, h] = renderer.size;
    U.set(cam.viewProj, 0);
    U.set(cam.view, 16);
    U.set(cam.invViewProj, 32);
    U.set(light.lightVP, 48);
    U.set(light.topVP, 64);
    U.set([...cam.eye, time], 80);
    U.set([...cam.fwd, 0], 84);
    U.set([...KEY_DIR, KEY_INTENSITY], 88);
    U.set([w, h, 1 / w, 1 / h], 92);
    U.set([...p.flesh, 1], 96);
    U.set([...p.fleshDeep, 1], 100);
    U.set([...p.pale, 1], 104);
    U.set([...p.skin, 1], 108);
    U.set([...p.stripe, 1], 112);
    U.set([...p.seed, 1], 116);
    U.set([SHAPE.T, SHAPE.Ro, SHAPE.skin, SHAPE.pale], 120);
    U.set([1.0, state.showMesh ? 0.32 : 0, sim.floorY, 0], 124);
    U.set([...bgLin, 1], 128);
    U.set([...p.shadowTint, 1], 132);
  }

  // ------------------------------------------------------------------ rays & picking
  function rayFrom(clientX, clientY) {
    const nx = ((clientX - cr.left) / cr.width) * 2 - 1, ny = 1 - ((clientY - cr.top) / cr.height) * 2;
    const p0 = M4.transform(cam.invViewProj, [nx, ny, 0]).slice(0, 3);
    const p1 = M4.transform(cam.invViewProj, [nx, ny, 1]).slice(0, 3);
    return { o: p0, d: norm(sub(p1, p0)) };
  }

  function rayPlaneY(ray, y) {
    if (Math.abs(ray.d[1]) < 1e-6) return null;
    const t = (y - ray.o[1]) / ray.d[1];
    if (t < 0) return null;
    return add(ray.o, scale(ray.d, t));
  }

  function rayPlane(ray, p, n) {
    const den = dot(ray.d, n);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot(sub(p, ray.o), n) / den;
    return add(ray.o, scale(ray.d, t));
  }

  // Möller–Trumbore over body triangles of the skinned surface.
  function pick(ray) {
    const { index, ranges } = mesh, d = dyn, end = ranges.body.count;
    const [ox, oy, oz] = ray.o, [dx, dy, dz] = ray.d;
    let best = Infinity, bestTri = -1;
    for (let i = 0; i < end; i += 3) {
      const a = 6 * index[i], b = 6 * index[i + 1], c = 6 * index[i + 2];
      const e1x = d[b] - d[a], e1y = d[b + 1] - d[a + 1], e1z = d[b + 2] - d[a + 2];
      const e2x = d[c] - d[a], e2y = d[c + 1] - d[a + 1], e2z = d[c + 2] - d[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const inv = 1 / det;
      const tx = ox - d[a], ty = oy - d[a + 1], tz = oz - d[a + 2];
      const uu = (tx * px + ty * py + tz * pz) * inv;
      if (uu < 0 || uu > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const vv = (dx * qx + dy * qy + dz * qz) * inv;
      if (vv < 0 || uu + vv > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-4 && t < best) { best = t; bestTri = i / 3; }
    }
    if (bestTri < 0) return null;
    return { t: best, p: add(ray.o, scale(ray.d, best)), tri: bestTri, comp: mesh.vComp[index[3 * bestTri]] };
  }

  // Forgiving fallback: nearest particle on screen within maxPx.
  function pickNear(clientX, clientY, maxPx) {
    const x = sim.x, m = cam.viewProj, W = cr.width, H = cr.height;
    const px = clientX - cr.left, py = clientY - cr.top;
    let best = -1, bs = Infinity;
    for (let i = 0; i < sim.n; i++) {
      const X = x[3 * i], Y = x[3 * i + 1], Z = x[3 * i + 2];
      const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
      if (w <= 0) continue;
      const sx = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
      const sy = (0.5 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5) * H;
      const d2 = (sx - px) ** 2 + (sy - py) ** 2;
      if (d2 > maxPx * maxPx) continue;
      const score = d2 + w * 4; // prefer nearer depth on ties
      if (score < bs) { bs = score; best = i; }
    }
    if (best < 0) return null;
    return { p: [x[3 * best], x[3 * best + 1], x[3 * best + 2]], comp: sim.comp[best] };
  }

  // ------------------------------------------------------------------ knife
  const T = SHAPE.T;
  let kp = { p: [0, T + 2, 1], yaw: 0, roll: 0.16, pitch: 0.05 };
  let knifeAnim = null;
  const hover = { x: 0, y: 0, set: false };

  const canonicalYaw = (d) => {
    let dd = d;
    if (dot(dd, cam.right) < 0) dd = scale(dd, -1);
    return { yaw: Math.atan2(-dd[2], dd[0]), d: dd };
  };

  function hoverPose() {
    const hx = hover.set ? hover.x : cr.left + cr.width / 2, hy = hover.set ? hover.y : cr.top + cr.height / 2;
    let p = rayPlaneY(rayFrom(hx, hy), T + 0.42) || [cam.target[0], T + 0.42, cam.target[2]];
    const dx = p[0] - cam.target[0], dz = p[2] - cam.target[2], l = Math.hypot(dx, dz);
    if (l > 3) p = [cam.target[0] + (dx / l) * 3, p[1], cam.target[2] + (dz / l) * 3];
    return { p, yaw: Math.atan2(-cam.right[2], cam.right[0]), roll: 0.16, pitch: 0.05 };
  }

  function strokePose() {
    const A = rayPlaneY(rayFrom(drag.ax, drag.ay), T + 0.1), B = rayPlaneY(rayFrom(drag.bx, drag.by), T + 0.1);
    if (!A || !B) return hoverPose();
    const mid = lerp3(A, B, 0.5), dv = sub(B, A);
    if (Math.hypot(dv[0], dv[2]) < 0.05) return { ...hoverPose(), p: mid };
    const { yaw } = canonicalYaw(norm([dv[0], 0, dv[2]]));
    return { p: mid, yaw, roll: 0.08, pitch: 0 };
  }

  function easeToward(pose, target, k) {
    return {
      p: lerp3(pose.p, target.p, k),
      yaw: pose.yaw + wrapAngle(target.yaw - pose.yaw) * k,
      roll: pose.roll + (target.roll - pose.roll) * k,
      pitch: pose.pitch + (target.pitch - pose.pitch) * k,
    };
  }

  function liftPose() {
    if (state.tool === 'knife') return hoverPose();
    return { ...kp, p: [kp.p[0], kp.p[1] + 2.5, kp.p[2]] };
  }

  function setBlade(mode, p, extra = {}) {
    const A = knifeAnim;
    sim.blade = { mode, p, d: A.plan.d, n: A.plan.n, halfGap: 0.012, holdY: A.P2[1], side: sim.blade?.side || null, ...extra };
  }

  function updateKnife(animDt, realDt) {
    if (knifeAnim) {
      const A = knifeAnim;
      A.t += animDt;
      const t = A.t;
      if (t < KT.align) {
        kp = easeToward(A.from, { p: A.P1, yaw: A.yaw, roll: 0, pitch: 0 }, easeInOut(t / KT.align));
        sim.blade = null;
      } else if (t < KT.press) {
        const s = (t - KT.align) / (KT.press - KT.align), p = lerp3(A.P1, A.P2, s * s);
        kp = { p, yaw: A.yaw, roll: 0, pitch: 0 };
        setBlade('press', p);
      } else {
        if (!A.committed) {
          A.committed = true;
          installWorld(A.plan, 0.22, 0);
          const side = new Float32Array(sim.nComp);
          for (const s of A.plan.sep) side[s.index] = s.dir;
          sim.blade = { mode: 'split', p: A.P2, d: A.plan.d, n: A.plan.n, halfGap: 0.012, holdY: A.P2[1], side };
        }
        if (t < KT.hold) {
          const s = Math.min((t - KT.press) / (KT.through - KT.press), 1), p = lerp3(A.P2, A.P3, easeOut(s));
          const g = Math.min((t - KT.press) / (KT.hold - KT.press), 1);
          kp = { p, yaw: A.yaw, roll: 0, pitch: 0 };
          setBlade('split', p, { halfGap: 0.012 + 0.02 * g });
        } else if (t < KT.lift) {
          sim.blade = null;
          if (!A.liftFrom) A.liftFrom = { ...kp };
          const s = easeInOut((t - KT.hold) / (KT.lift - KT.hold));
          kp = easeToward(A.liftFrom, liftPose(), s);
        } else {
          sim.blade = null;
          knifeAnim = null;
        }
      }
    } else if (state.tool === 'knife') {
      const target = drag.mode === 'cut' ? strokePose() : hoverPose();
      kp = easeToward(kp, target, 1 - Math.exp(-16 * realDt));
    }
  }

  const knifeVisible = () => state.tool === 'knife' || !!knifeAnim;

  // ------------------------------------------------------------------ cutting
  function planCut(ax, ay, bx, by) {
    if (Math.hypot(bx - ax, by - ay) < 24) return { miss: '' };
    if (pieces.length >= MAX_PIECES) return { miss: MSG.plenty };
    const hits = new Set();
    let yTop = -Infinity, t0 = -1, t1 = -1;
    for (let i = 0; i < 49; i++) {
      const t = i / 48, h = pick(rayFrom(ax + (bx - ax) * t, ay + (by - ay) * t));
      if (!h) continue;
      hits.add(h.comp);
      yTop = Math.max(yTop, h.p[1]);
      if (t0 < 0) t0 = t;
      t1 = t;
    }
    if (!hits.size) return { miss: MSG.miss };
    const A = rayPlaneY(rayFrom(ax, ay), yTop), B = rayPlaneY(rayFrom(bx, by), yTop);
    if (!A || !B) return { miss: MSG.miss };
    const L = Math.hypot(B[0] - A[0], B[2] - A[2]);
    if (L < 1e-4) return { miss: MSG.miss };
    const { d } = canonicalYaw([(B[0] - A[0]) / L, 0, (B[2] - A[2]) / L]);
    const n = [-d[2], 0, d[0]];
    const H0 = rayPlaneY(rayFrom(ax + (bx - ax) * t0, ay + (by - ay) * t0), yTop) || A;
    const H1 = rayPlaneY(rayFrom(ax + (bx - ax) * t1, ay + (by - ay) * t1), yTop) || B;
    const o = lerp3(H0, H1, 0.5);

    const next = [], origin = [], sep = [];
    let split = 0, thin = false;
    pieces.forEach((pc, c) => {
      const keep = () => { next.push(pc); origin.push(c); };
      if (!hits.has(c)) return keep();
      const F = sim.pieceFrame(c);
      const nr = mat3TMulVec(F.R, n), pr = add(mat3TMulVec(F.R, sub(o, F.cw)), F.cr);
      const Ln = Math.hypot(nr[0], nr[2]);
      if (Ln < 0.3) { thin = true; return keep(); } // lying on its side
      const cc = (dot(nr, pr) - nr[1] * (T / 2)) / Ln, a = nr[0] / Ln, b = nr[2] / Ln;
      if (!lineCrossesPiece(pc.I, a, b, cc)) return keep();
      const halves = splitPiece(pc.I, a, b, cc);
      if (!halves) { thin = true; return keep(); }
      for (const Hh of halves) {
        const rc = polyCentroid(Hh), restC = [rc[0], T / 2, rc[1]];
        const wc = add(F.cw, mat3MulVec(F.R, sub(restC, F.cr)));
        sep.push({ index: next.length, dir: dot(sub(wc, o), n) >= 0 ? 1 : -1 });
        next.push({ I: Hh, cache: null });
        origin.push(c);
      }
      split++;
    });
    if (!split) return { miss: thin ? MSG.thin : MSG.miss };
    if (next.length > MAX_PIECES) return { miss: MSG.plenty };
    const tb = performance.now();
    const nextWorld = buildWorld(next);
    const nextSim = new SoftBody(nextWorld, { firmness: sim.firmness, damping: sim.damping });
    return { next, origin, sep, world: nextWorld, sim: nextSim, n, d, o, yTop, buildMs: performance.now() - tb };
  }

  // Transfer state into the planned world: new rest particles live inside the OLD rest tets.
  function installWorld(plan, sepSpeed = 0.75, hop = 0.35) {
    const tc = performance.now();
    endDrag();
    const old = sim, ns = plan.sim;
    plan.next.forEach((pc, k) => {
      const oc = plan.origin[k], i0 = ns.compStart[k], i1 = ns.compStart[k + 1];
      if (pc === pieces[oc]) {
        const j0 = old.compStart[oc];
        ns.x.set(old.x.subarray(3 * j0, 3 * (j0 + i1 - i0)), 3 * i0);
        ns.v.set(old.v.subarray(3 * j0, 3 * (j0 + i1 - i0)), 3 * i0);
        return;
      }
      const tl = [];
      for (let t = 0; t < old.nT; t++) {
        if (old.comp[old.tets[4 * t]] === oc) tl.push(old.tets[4 * t], old.tets[4 * t + 1], old.tets[4 * t + 2], old.tets[4 * t + 3]);
      }
      const e = embed(old.rest, Uint32Array.from(tl), ns.rest.subarray(3 * i0, 3 * i1));
      for (let i = i0; i < i1; i++) {
        const q = 4 * (i - i0);
        for (let a = 0; a < 3; a++) {
          let xs = 0, vs = 0;
          for (let k2 = 0; k2 < 4; k2++) {
            const j = e.idx[q + k2], w = e.w[q + k2];
            xs += old.x[3 * j + a] * w;
            vs += old.v[3 * j + a] * w;
          }
          ns.x[3 * i + a] = xs;
          ns.v[3 * i + a] = vs;
        }
        ns.x[3 * i + 1] = Math.max(0, ns.x[3 * i + 1]);
      }
    });
    for (const s of plan.sep) {
      for (let i = ns.compStart[s.index]; i < ns.compStart[s.index + 1]; i++) {
        ns.v[3 * i] += plan.n[0] * s.dir * sepSpeed;
        ns.v[3 * i + 1] += hop;
        ns.v[3 * i + 2] += plan.n[2] * s.dir * sepSpeed;
      }
    }
    ns.prev.set(ns.x);
    ns.warmRotations();
    ns.firmness = old.firmness;
    ns.damping = old.damping;
    swapWorld(plan.next, plan.world, ns);
    api.lastCommitMs = performance.now() - tc;
  }

  function swapWorld(nextPieces, nextWorld, nextSim) {
    pieces = nextPieces;
    world = nextWorld;
    sim = nextSim;
    mesh = world.mesh;
    renderer.setMesh(mesh, sim.edges, sim.n);
    dyn = renderer.dyn;
    skin();
    emit('counts', { particles: sim.n, tets: sim.nT });
    statTimer = 1; // refresh readouts now
  }

  function startCut(plan) {
    const P1 = add(plan.o, scale(plan.d, -0.12)); P1[1] = plan.yTop + 0.1;
    const P2 = plan.o.slice(); P2[1] = plan.yTop - 0.13;
    const P3 = add(plan.o, scale(plan.d, 0.2)); P3[1] = 0.004;
    knifeAnim = { t: 0, plan, from: { ...kp }, committed: false, P1, P2, P3, yaw: Math.atan2(-plan.d[2], plan.d[0]) };
  }

  function performCut(x0, y0, x1, y1) {
    const plan = planCut(x0, y0, x1, y1);
    if (plan.miss !== undefined) return { ok: false, miss: plan.miss };
    installWorld(plan, 0.75, 0.35);
    return { ok: true, pieces: pieces.length };
  }

  // ------------------------------------------------------------------ input
  const drag = { mode: null, id: -1, plane: null, cx: 0, cy: 0, lx: 0, ly: 0, ax: 0, ay: 0, bx: 0, by: 0, twist: 0, twistId: -1, twistBase: 0 };
  const pointers = new Map();
  let hoverDirty = true;
  let strokeTimer = 0;

  function setCursor(c) {
    if (canvas.style.cursor !== c) canvas.style.cursor = c;
  }

  function dragTarget() {
    const hit = rayPlane(rayFrom(drag.cx, drag.cy), drag.plane.p, drag.plane.n);
    if (!hit) return null;
    const dx = hit[0] - cam.target[0], dz = hit[2] - cam.target[2], l = Math.hypot(dx, dz);
    if (l > 3.4) { hit[0] = cam.target[0] + (dx / l) * 3.4; hit[2] = cam.target[2] + (dz / l) * 3.4; }
    hit[1] = clamp(hit[1], 0.02, 3.2);
    return hit;
  }

  function strokeSet(cls) {
    if (!strokeLine) return;
    strokeLine.setAttribute('class', cls);
  }
  function strokeCoords() {
    if (!strokeLine) return;
    strokeLine.setAttribute('x1', drag.ax - cr.left);
    strokeLine.setAttribute('y1', drag.ay - cr.top);
    strokeLine.setAttribute('x2', drag.bx - cr.left);
    strokeLine.setAttribute('y2', drag.by - cr.top);
  }

  function endDrag() {
    if (drag.mode === 'grab') sim.endGrab();
    if (drag.mode === 'cut') strokeSet('');
    drag.mode = null;
    drag.id = -1;
    drag.twistId = -1;
    hoverDirty = true;
  }

  const fingerAngle = () => {
    const a = pointers.get(drag.id), b = pointers.get(drag.twistId);
    return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  };

  function onPointerDown(e) {
    cr = canvas.getBoundingClientRect();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hover.x = e.clientX; hover.y = e.clientY; hover.set = true;
    if (drag.mode === 'grab' && e.pointerType === 'touch' && drag.twistId < 0 && e.pointerId !== drag.id) {
      drag.twistId = e.pointerId;
      drag.twistBase = fingerAngle() - drag.twist;
      return;
    }
    if (drag.mode) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    drag.id = e.pointerId;
    drag.cx = drag.lx = e.clientX;
    drag.cy = drag.ly = e.clientY;
    if (e.button === 2 || e.button === 1) { drag.mode = 'orbit'; setCursor('move'); return; }
    if (state.tool === 'knife') {
      if (knifeAnim) { emit('toast', MSG.busy); drag.mode = 'orbit'; setCursor('move'); return; }
      if (state.paused) { emit('toast', MSG.paused); drag.mode = 'orbit'; setCursor('move'); return; }
      drag.mode = 'cut';
      drag.ax = drag.bx = e.clientX;
      drag.ay = drag.by = e.clientY;
      clearTimeout(strokeTimer);
      strokeCoords();
      strokeSet('drawing');
      return;
    }
    const ray = rayFrom(e.clientX, e.clientY);
    const hit = pick(ray) || pickNear(e.clientX, e.clientY, e.pointerType === 'touch' ? 34 : 18);
    if (hit) {
      drag.mode = 'grab';
      drag.plane = { p: hit.p.slice(), n: cam.fwd.slice() };
      drag.twist = 0;
      sim.beginGrab(hit.p, 0.4);
      setCursor('grabbing');
    } else {
      drag.mode = 'orbit';
      setCursor('move');
    }
  }

  function onPointerMove(e) {
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (e.pointerId === drag.twistId) {
      drag.twist = clamp(fingerAngle() - drag.twistBase, -1.3, 1.3);
      return;
    }
    if (!drag.mode || e.pointerId === drag.id || e.pointerType === 'mouse') {
      hover.x = e.clientX; hover.y = e.clientY; hover.set = true;
      hoverDirty = true;
    }
    if (e.pointerId !== drag.id) return;
    if (drag.mode === 'grab') {
      drag.cx = e.clientX; drag.cy = e.clientY;
      if (drag.twistId >= 0) drag.twist = clamp(fingerAngle() - drag.twistBase, -1.3, 1.3);
    } else if (drag.mode === 'orbit') {
      const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY;
      cam.az = clamp(cam.az - dx * 0.006, -0.35, 1.6);
      cam.el = clamp(cam.el + dy * 0.005, 0.12, 1.25);
    } else if (drag.mode === 'cut') {
      drag.bx = e.clientX; drag.by = e.clientY;
      strokeCoords();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (e.pointerId === drag.twistId) { drag.twistId = -1; return; }
    if (e.pointerId !== drag.id) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (drag.mode === 'cut') {
      const { ax, ay, bx, by } = drag;
      drag.mode = null;
      drag.id = -1;
      const plan = e.type === 'pointerup' ? planCut(ax, ay, bx, by) : { miss: '' };
      if (plan.miss !== undefined) {
        strokeSet('');
        if (plan.miss) emit('toast', plan.miss);
      } else {
        strokeSet('done');
        strokeTimer = setTimeout(() => {
          strokeSet('fade');
          strokeTimer = setTimeout(() => strokeSet(''), 420);
        }, 60);
        startCut(plan);
      }
      hoverDirty = true;
      return;
    }
    endDrag();
  }

  function onWheel(e) {
    if (drag.mode === 'grab') {
      e.preventDefault();
      drag.twist = clamp(drag.twist + e.deltaY * 0.004, -1.3, 1.3);
    } else if (e.target === canvas) {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      cam.zoom = clamp(cam.zoom * Math.exp(dy * 0.0012), 0.65, 1.6);
    }
  }

  const onDblClick = () => resetView();
  const onContext = (e) => e.preventDefault();
  const onLeave = () => { hover.set = hover.set && state.tool === 'knife'; hoverDirty = true; };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('pointerleave', onLeave);
  window.addEventListener('wheel', onWheel, { passive: false });

  function updateCursor() {
    if (drag.mode === 'grab') return setCursor('grabbing');
    if (drag.mode === 'orbit') return setCursor('move');
    if (state.tool === 'knife') return setCursor('crosshair');
    if (!hoverDirty) return;
    hoverDirty = false;
    setCursor(hover.set && pick(rayFrom(hover.x, hover.y)) ? 'grab' : 'default');
  }

  // ------------------------------------------------------------------ layout
  const mq = matchMedia(STACKED_MQ);
  const applyStacked = () => {
    stacked = mq.matches;
    document.body.classList.toggle('stacked', stacked);
    needResize = true;
  };
  let needResize = true;
  mq.addEventListener('change', applyStacked);
  applyStacked();
  const ro = new ResizeObserver(() => { needResize = true; });
  ro.observe(canvas);
  const onWinResize = () => { needResize = true; };
  window.addEventListener('resize', onWinResize);

  function resize() {
    cr = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(cr.width * dpr, cr.height * dpr);
    needResize = false;
  }

  // ------------------------------------------------------------------ readouts
  let statTimer = 0;
  function readouts(dt) {
    statTimer += dt;
    if (statTimer < 0.12) return;
    statTimer = 0;
    const massG = sim.totalRestVolume * 3.5 ** 3 * 1.3;
    const vol = sim.volumeRatio() * 100;
    const keJ = (sim.kineticEnergy() / sim.totalMass) * (massG / 1000) * 0.035 ** 2;
    const uj = keJ * 1e6;
    const ke = uj < 0.05 ? '0.00' : uj < 100 ? uj.toFixed(2) : uj.toFixed(0);
    emit('stats', { mass: massG.toFixed(0), vol: vol.toFixed(1), ke, pieces: String(pieces.length) });
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now(), acc = 0, first = true, raf = 0, destroyed = false;
  let fps = 60, fpsAcc = 0, fpsN = 0, lossAttempts = 0, stepMs = 4;
  const startTime = performance.now();

  function frame(now) {
    raf = 0;
    if (destroyed || renderer.lost) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    if (needResize) resize();

    updateCamera();
    const animDt = state.paused ? 0 : dt * (state.slow ? 0.25 : 1);
    updateKnife(animDt, dt);

    if (sim.grabbing && drag.mode === 'grab') {
      const t = dragTarget();
      if (t) sim.moveGrab(t, rotMat(cam.fwd, drag.twist));
    }
    if (!state.paused) {
      acc += animDt;
      // At most 3 steps per frame; fewer when steps are expensive on this machine, so a
      // slow CPU gets slow motion instead of a collapsing frame rate.
      const maxSteps = clamp(Math.floor(14 / Math.max(stepMs, 1)), 1, 3);
      let steps = 0;
      const ts = performance.now();
      while (acc >= sim.stepDt && steps < maxSteps) { sim.step(); acc -= sim.stepDt; steps++; }
      if (steps) stepMs += ((performance.now() - ts) / steps - stepMs) * 0.1;
      if (steps === maxSteps) acc = Math.min(acc, sim.stepDt); // drop backlog, don't spiral
    }

    skin();
    if (knifeVisible()) poseKnife(knifeMesh, kp, renderer.knifeDyn);
    followSlice(dt);
    updateCamera();
    updateLight();
    updateCursor();
    packUniforms((now - startTime) / 1000);
    renderer.setUniforms(U, light.lightVP, light.topVP);
    renderer.uploadGeometry({ particles: state.showMesh ? sim.x : null, knife: knifeVisible() });
    renderer.draw({ showMesh: state.showMesh, knifeVisible: knifeVisible() });
    readouts(dt);

    if (first) {
      first = false;
      emit('status', state.paused ? 'WEBGPU · PAUSED' : 'WEBGPU · LIVE', state.paused ? 'paused' : 'live');
      document.body.classList.add('ready');
    }
    if (!renderer.lost && !destroyed) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ device loss
  async function handleLoss(info) {
    if (destroyed) return;
    console.warn('GPU device lost:', info?.reason, info?.message);
    if (info?.reason !== 'destroyed' && lossAttempts < 2) {
      lossAttempts++;
      try {
        renderer = await Renderer.create(canvas, mesh, sim.edges, sim.n);
        renderer.setKnife(knifeMesh);
        renderer.onLost = handleLoss;
        dyn = renderer.dyn;
        needResize = true;
        last = performance.now();
        if (!raf) raf = requestAnimationFrame(frame);
        return;
      } catch (err) {
        console.error(err);
      }
    }
    emit('status', 'WEBGPU · LOST', 'off');
    emit('lost');
  }
  renderer.onLost = handleLoss;

  // ------------------------------------------------------------------ public API
  const api = {
    lastCommitMs: 0,
    setTool(t) {
      if (t === state.tool) return;
      if (drag.mode === 'cut') endDrag();
      state.tool = t;
      document.body.dataset.tool = t;
      if (t === 'knife' && !knifeAnim) {
        const hp = hoverPose();
        kp = { ...hp, p: [hp.p[0], hp.p[1] + 1.6, hp.p[2]] };
      }
      hoverDirty = true;
    },
    setVariety(v) { if (PALETTES[v]) state.variety = v; },
    setFirmness(f) { sim.firmness = f; },
    setDamping(d) { sim.damping = d; },
    setSlow(s) { state.slow = s; },
    setShowMesh(s) { state.showMesh = s; },
    setPaused(p) {
      state.paused = p;
      if (p && drag.mode) endDrag();
      emit('status', p ? 'WEBGPU · PAUSED' : 'WEBGPU · LIVE', p ? 'paused' : 'live');
    },
    nudge(s = 1) { sim.nudge(s); },
    reset() {
      knifeAnim = null;
      endDrag();
      if (pieces.length !== 1 || pieces[0] !== wholePiece) {
        const w = buildWorld([wholePiece]);
        const s = new SoftBody(w, { firmness: sim.firmness, damping: sim.damping });
        swapWorld([wholePiece], w, s);
      }
      sim.blade = null;
      sim.reset(0.35);
      acc = 0;
      if (state.tool === 'knife') {
        const hp = hoverPose();
        kp = { ...hp, p: [hp.p[0], hp.p[1] + 1.6, hp.p[2]] };
      }
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(strokeTimer);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('lostpointercapture', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onWinResize);
      mq.removeEventListener('change', applyStacked);
      ro.disconnect();
      renderer.destroy();
      if (window.__melon?.api === api) delete window.__melon;
    },
  };

  // test hooks (Playwright etc.)
  window.__melon = {
    api,
    get sim() { return sim; },
    get renderer() { return renderer; },
    get world() { return world; },
    state,
    cam,
    pick,
    rayFrom,
    performCut,
    planCut,
    startCut,
    get kp() { return kp; },
    get blade() { return sim.blade; },
    get knifeAnim() { return knifeAnim; },
    get lastCommitMs() { return api.lastCommitMs; },
    setHover(x, y) { hover.x = x; hover.y = y; hover.set = true; hoverDirty = true; },
    // step knife + sim deterministically at 1/60
    advance(sec) {
      const n = Math.round(sec * 60);
      for (let i = 0; i < n; i++) { updateKnife(1 / 60, 1 / 60); sim.step(); }
      skin();
    },
    compStats() {
      const out = [];
      for (let c = 0; c < sim.nComp; c++) {
        let vmax = 0;
        for (let i = sim.compStart[c]; i < sim.compStart[c + 1]; i++) {
          vmax = Math.max(vmax, Math.hypot(sim.v[3 * i], sim.v[3 * i + 1], sim.v[3 * i + 2]));
        }
        out.push({ centroid: sim.centroid(c), maxSpeed: vmax });
      }
      return out;
    },
    get pieces() { return pieces.length; },
    get fps() { return fps; },
    get stepMs() { return stepMs; },
  };

  document.body.dataset.tool = state.tool;
  skin();
  raf = requestAnimationFrame(frame);
  return api;
}
