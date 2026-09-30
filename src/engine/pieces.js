// Convex-polygon pieces in the shared rest plane, splitting, per-piece sim/render meshes,
// and concatenation of all pieces into one "world".

import {
  SHAPE, RC, pieceSamples, sdInner, sdPiece, bboxLattice, delaunay, tetVolume, embed,
  regionOf, globalProps, polyArea,
} from './geometry.js';

function polyPerimeter(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) s += Math.hypot(P[(i + 1) % P.length][0] - P[i][0], P[(i + 1) % P.length][1] - P[i][1]);
  return s;
}

export const MAX_PIECES = 14;
export const MIN_INNER_AREA = 0.004;
// Smallest corner radius a cut may fall back to, so small pieces can still be cut.
export const MIN_CUT_R = 0.02;

// The sector, approximated by a 42-vertex convex polygon (apex + 41 arc points).
export function initialPiece() {
  const { alpha: a, Ri } = SHAPE;
  const I = [[0, 0]];
  const a0 = Math.PI / 2 - a, a1 = Math.PI / 2 + a, n = 40;
  for (let k = 0; k <= n; k++) {
    const t = a0 + ((a1 - a0) * k) / n;
    I.push([Math.cos(t) * Ri, Math.sin(t) * Ri]);
  }
  return { I, r: RC, cache: null };
}

// Sutherland–Hodgman: keep a·u + b·w ≤ c.
export function clipHalf(P, a, b, c) {
  const out = [], N = P.length;
  for (let i = 0; i < N; i++) {
    const p = P[i], q = P[(i + 1) % N];
    const fp = a * p[0] + b * p[1] - c, fq = a * q[0] + b * q[1] - c;
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  const clean = [];
  for (const p of out) {
    const l = clean[clean.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-5) clean.push(p);
  }
  while (clean.length > 1) {
    const f = clean[0], l = clean[clean.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 1e-5) break;
    clean.pop();
  }
  return clean;
}

// Grow a convex polygon by d, sampling each corner's arc so the result hugs the old rounded
// outline. Used to hand a piece a smaller corner radius without moving its outline.
export function growPoly(I, d) {
  if (d <= 1e-6) return I;
  const N = I.length, out = [];
  const edgeN = (i) => {
    const p = I[i], q = I[(i + 1) % N], ex = q[0] - p[0], ew = q[1] - p[1], l = Math.hypot(ex, ew) || 1;
    return [ew / l, -ex / l];
  };
  for (let i = 0; i < N; i++) {
    const n0 = edgeN((i - 1 + N) % N), n1 = edgeN(i);
    const a0 = Math.atan2(n0[1], n0[0]);
    let da = Math.atan2(n1[1], n1[0]) - a0;
    while (da < 0) da += Math.PI * 2;
    if (da > Math.PI * 1.5) da = 0;
    const na = Math.ceil(da / 0.3);
    for (let k = 0; k <= na; k++) {
      const t = a0 + (na ? (da * k) / na : 0);
      const p = [I[i][0] + Math.cos(t) * d, I[i][1] + Math.sin(t) * d], l = out[out.length - 1];
      if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-5) out.push(p);
    }
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-5) out.pop();
  return out;
}

// Inner polygons are pulled back by the corner radius r so their ROUNDED outlines meet exactly
// on the cut. A piece too small for its radius is cut with a tighter one instead (its inner
// polygon grown to match), so any piece that the line really crosses can be split.
export function splitPiece(piece, a, b, c) {
  const r0 = piece.r ?? RC;
  for (const f of [1, 0.75, 0.55, 0.4, 0.3, 0.22, 0.16, 0.12, 0]) {
    const r = Math.min(r0, Math.max(MIN_CUT_R, r0 * f));
    const J = growPoly(piece.I, r0 - r);
    const A = clipHalf(J, a, b, c - r);
    const B = clipHalf(J, -a, -b, -(c + r));
    const minA = f === 1 ? MIN_INNER_AREA : 0.0002;
    if (A.length >= 3 && B.length >= 3 && polyArea(A) >= minA && polyArea(B) >= minA) {
      const halves = [{ I: A, r, cache: null }, { I: B, r, cache: null }];
      if (halves.every((h) => ensureCache(h).sim.nT > 0)) return halves;
    }
    if (r <= MIN_CUT_R) break;
  }
  return null;
}

export function lineCrossesPiece(piece, a, b, c) {
  const r = piece.r ?? RC;
  let lo = Infinity, hi = -Infinity;
  for (const p of piece.I) {
    const s = a * p[0] + b * p[1];
    lo = Math.min(lo, s); hi = Math.max(hi, s);
  }
  return c > lo - 0.6 * r && c < hi + 0.6 * r;
}

// ---------------------------------------------------------------------------
// Simulation mesh: particles + tetrahedra

export function buildPieceSim(I, r = RC, h = 0.15, layers = 3) {
  const { T } = SHAPE;
  // small pieces get a finer lattice so they still hold a few particles across
  h = Math.min(h, Math.max(0.05, 0.45 * Math.sqrt(polyArea(I) + polyPerimeter(I) * r + Math.PI * r * r)));
  // boundary points on the rounded outline, de-duplicated
  const pts = [];
  const tooClose = (u, w, r) => pts.some((p) => (p[0] - u) ** 2 + (p[1] - w) ** 2 < r * r);
  for (const s of pieceSamples(I, h, 0.6, r)) {
    const u = s.q[0] + s.n[0] * r, w = s.q[1] + s.n[1] * r;
    if (!tooClose(u, w, 0.45 * h)) pts.push([u, w]);
  }
  const nB = pts.length;
  for (const p of bboxLattice(I, r, h, (u, w) => sdPiece(I, u, w, r) < -0.55 * h)) pts.push(p);
  if (pts.length - nB < 1) {
    // tiny piece: at least one interior point at the inner centroid
    let cu = 0, cw = 0;
    for (const p of I) { cu += p[0]; cw += p[1]; }
    pts.push([cu / I.length, cw / I.length]);
  }

  // Delaunay, drop slivers, compact
  const raw = delaunay(pts), tris = [];
  for (let i = 0; i < raw.length; i += 3) {
    const a = pts[raw[i]], b = pts[raw[i + 1]], c = pts[raw[i + 2]];
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    const e = Math.max((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2, (c[0] - b[0]) ** 2 + (c[1] - b[1]) ** 2, (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2);
    if (area / e > 0.1) tris.push(raw[i], raw[i + 1], raw[i + 2]);
  }
  if (!tris.length) for (const v of raw) tris.push(v); // thin sliver: keep what there is
  const remap = new Int32Array(pts.length).fill(-1), used = [];
  for (const v of tris) if (remap[v] < 0) { remap[v] = used.length; used.push(pts[v]); }
  for (let i = 0; i < tris.length; i++) tris[i] = remap[tris[i]];

  // extrude into layers of prisms, 3 tets each (sorted indices → conforming diagonals)
  const n2 = used.length, n = n2 * (layers + 1);
  const rest = new Float32Array(3 * n), region = new Uint8Array(n);
  for (let l = 0; l <= layers; l++) {
    for (let i = 0; i < n2; i++) {
      const k = l * n2 + i;
      rest[3 * k] = used[i][0];
      rest[3 * k + 1] = (T * l) / layers;
      rest[3 * k + 2] = used[i][1];
      region[k] = regionOf(used[i][0], used[i][1]);
    }
  }
  const tets = [];
  for (let l = 0; l < layers; l++) {
    for (let i = 0; i < tris.length; i += 3) {
      const s = [tris[i], tris[i + 1], tris[i + 2]].sort((x, y) => x - y);
      const a = l * n2 + s[0], b = l * n2 + s[1], c = l * n2 + s[2];
      tets.push(a, b, c, a + n2, b, c, a + n2, b + n2, c, a + n2, b + n2, c + n2);
    }
  }
  const tetsA = new Uint32Array(tets);
  for (let t = 0; t < tetsA.length; t += 4) {
    if (tetVolume(rest, tetsA[t], tetsA[t + 1], tetsA[t + 2], tetsA[t + 3]) < 0) {
      const tmp = tetsA[t + 2]; tetsA[t + 2] = tetsA[t + 3]; tetsA[t + 3] = tmp;
    }
  }
  return { rest, tets: tetsA, region, n, nT: tetsA.length / 4 };
}

// ---------------------------------------------------------------------------
// Render mesh: beveled rounded slab + caps + seeds + bubbles

export function buildPieceRender(I, r = RC) {
  const { T } = SHAPE;
  const b = Math.min(SHAPE.bevel, r); // tight-cornered pieces get a matching edge bevel
  const pos = [], nrm = [], mat = [];
  const body = [], seeds = [], bubbles = [];
  const vert = (x, y, z, nx, ny, nz, m) => {
    pos.push(x, y, z); nrm.push(nx, ny, nz); mat.push(m);
    return mat.length - 1;
  };
  vert.count = () => mat.length;

  // rings around the outline
  const S = pieceSamples(I, 0.03, 0.1, r), N = S.length;
  const qb = 8, qs = 3, rings = [];
  for (let j = 0; j <= qb; j++) {
    const ps = -Math.PI / 2 + ((Math.PI / 2) * j) / qb;
    rings.push({ d: r - b + b * Math.cos(ps), y: b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) });
  }
  for (let j = 1; j < qs; j++) rings.push({ d: r, y: b + ((T - 2 * b) * j) / qs, ny: 0, nr: 1 });
  for (let j = 0; j <= qb; j++) {
    const ps = ((Math.PI / 2) * j) / qb;
    rings.push({ d: r - b + b * Math.cos(ps), y: T - b + b * Math.sin(ps), ny: Math.sin(ps), nr: Math.cos(ps) });
  }
  const ringBase = [];
  for (const r of rings) {
    ringBase.push(mat.length);
    for (const s of S) {
      vert(s.q[0] + s.n[0] * r.d, r.y, s.q[1] + s.n[1] * r.d, s.n[0] * r.nr, r.ny, s.n[1] * r.nr, 0);
    }
  }
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < N; k++) {
      const a = ringBase[r] + k, bb = ringBase[r] + ((k + 1) % N);
      const c = ringBase[r + 1] + k, d = ringBase[r + 1] + ((k + 1) % N);
      body.push(a, c, bb, bb, c, d);
    }
  }

  // caps: outline inset by r − bevel + a fine lattice, Delaunay'd; welded onto the end rings
  const d0 = r - b, sp = 0.048;
  const cap = S.map((s) => [s.q[0] + s.n[0] * d0, s.q[1] + s.n[1] * d0]);
  for (const p of bboxLattice(I, d0, sp, (u, w) => sdInner(I, u, w) < d0 - 0.55 * sp)) cap.push(p);
  const capTris = delaunay(cap);
  for (const [ring, y, ny] of [[0, 0, -1], [rings.length - 1, T, 1]]) {
    const map = new Int32Array(cap.length);
    for (let i = 0; i < cap.length; i++) {
      map[i] = i < N ? ringBase[ring] + i : vert(cap[i][0], y, cap[i][1], 0, ny, 0, 0);
    }
    for (let i = 0; i < capTris.length; i += 3) {
      const a = map[capTris[i]], bb = map[capTris[i + 1]], c = map[capTris[i + 2]];
      if (ny > 0) body.push(a, c, bb); else body.push(a, bb, c);
    }
  }

  // props wholly inside this piece
  for (const pr of globalProps()) {
    if (sdPiece(I, pr.cx, pr.cz, r) + pr.rad > -0.02) continue;
    if (pr.kind === 'seed') addSeed(pr, vert, seeds);
    else addBubble(pr, vert, bubbles);
  }

  // winding repair: every front face CCW, agreeing with the analytic normals
  const P = pos, Nn = nrm;
  for (const list of [body, seeds, bubbles]) {
    for (let i = 0; i < list.length; i += 3) {
      const a = list[i], bb = list[i + 1], c = list[i + 2];
      const e1 = [P[3 * bb] - P[3 * a], P[3 * bb + 1] - P[3 * a + 1], P[3 * bb + 2] - P[3 * a + 2]];
      const e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
      const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      let s = 0;
      for (const v of [a, bb, c]) s += g[0] * Nn[3 * v] + g[1] * Nn[3 * v + 1] + g[2] * Nn[3 * v + 2];
      if (s < 0) { list[i + 1] = c; list[i + 2] = bb; }
    }
  }

  return {
    pos: new Float32Array(pos),
    mat: new Float32Array(mat),
    body: new Uint32Array(body),
    seeds: new Uint32Array(seeds),
    bubbles: new Uint32Array(bubbles),
    nV: mat.length,
  };
}

// Lathe-like teardrop, long axis radial, wider toward the rind.
function addSeed(pr, vert, out) {
  const nt = 10, nph = 12;
  const ax = [Math.sin(pr.th), 0, Math.cos(pr.th)];
  // tilt the long axis slightly out of plane
  const ct = Math.cos(pr.tilt), st = Math.sin(pr.tilt);
  const along = [ax[0] * ct, st, ax[2] * ct];
  const side = [Math.cos(pr.th), 0, -Math.sin(pr.th)];
  const up = [
    along[1] * side[2] - along[2] * side[1],
    along[2] * side[0] - along[0] * side[2],
    along[0] * side[1] - along[1] * side[0],
  ];
  const upS = up[1] < 0 ? -1 : 1;
  const base = [];
  for (let i = 0; i <= nt; i++) {
    const s = i / nt, t = s * Math.PI;
    const prof = Math.pow(Math.max(Math.sin(t), 0), 0.9) * (0.38 + 0.62 * Math.pow(s, 0.7));
    const a = (s - 0.5) * pr.L;
    base.push(vert.count());
    for (let j = 0; j < nph; j++) {
      const ph = (j / nph) * Math.PI * 2;
      const cs = Math.cos(ph) * prof * pr.W * 0.5, sn = Math.sin(ph) * prof * pr.H * 0.5 * upS;
      const x = pr.cx + along[0] * a + side[0] * cs + up[0] * sn;
      const y = pr.cy + along[1] * a + side[1] * cs + up[1] * sn;
      const z = pr.cz + along[2] * a + side[2] * cs + up[2] * sn;
      // outward-ish normal for winding repair
      const nx = x - pr.cx, ny = y - pr.cy, nz = z - pr.cz, l = Math.hypot(nx, ny, nz) || 1;
      vert(x, y, z, nx / l, ny / l, nz / l, 1);
    }
  }
  for (let i = 0; i < nt; i++) {
    for (let j = 0; j < nph; j++) {
      const a = base[i] + j, b = base[i] + ((j + 1) % nph), c = base[i + 1] + j, d = base[i + 1] + ((j + 1) % nph);
      if (i > 0) out.push(a, c, b);
      if (i < nt - 1) out.push(b, c, d);
    }
  }
}

function addBubble(pr, vert, out) {
  const nlat = 8, nlon = 12, base = [];
  for (let i = 0; i <= nlat; i++) {
    const th = (i / nlat) * Math.PI;
    base.push(vert.count());
    for (let j = 0; j < nlon; j++) {
      const ph = (j / nlon) * Math.PI * 2;
      const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
      vert(pr.cx + nx * pr.r, pr.cy + ny * pr.r, pr.cz + nz * pr.r, nx, ny, nz, 2);
    }
  }
  for (let i = 0; i < nlat; i++) {
    for (let j = 0; j < nlon; j++) {
      const a = base[i] + j, b = base[i] + ((j + 1) % nlon), c = base[i + 1] + j, d = base[i + 1] + ((j + 1) % nlon);
      if (i > 0) out.push(a, c, b);
      if (i < nlat - 1) out.push(b, c, d);
    }
  }
}

// ---------------------------------------------------------------------------

export function ensureCache(piece) {
  if (piece.cache) return piece.cache;
  const sim = buildPieceSim(piece.I, piece.r ?? RC);
  const ren = buildPieceRender(piece.I, piece.r ?? RC);
  const emb = embed(sim.rest, sim.tets, ren.pos);
  piece.cache = { sim, ren, emb };
  return piece.cache;
}

// Concatenate every piece's sim mesh, render mesh and embedding into single arrays.
export function buildWorld(pieces) {
  const caches = pieces.map(ensureCache);
  let n = 0, nT = 0, nV = 0, nBody = 0, nSeed = 0, nBub = 0;
  for (const c of caches) {
    n += c.sim.n; nT += c.sim.nT; nV += c.ren.nV;
    nBody += c.ren.body.length; nSeed += c.ren.seeds.length; nBub += c.ren.bubbles.length;
  }
  const rest = new Float32Array(3 * n), region = new Uint8Array(n), comp = new Uint16Array(n);
  const tets = new Uint32Array(4 * nT);
  const statics = new Float32Array(4 * nV), vComp = new Uint16Array(nV);
  const skinIdx = new Uint32Array(4 * nV), skinW = new Float32Array(4 * nV);
  const index = new Uint32Array(nBody + nSeed + nBub);
  const compStart = new Uint32Array(pieces.length + 1);
  let po = 0, to = 0, vo = 0, bo = 0, so = nBody, uo = nBody + nSeed;
  caches.forEach((c, ci) => {
    const { sim, ren, emb } = c;
    compStart[ci] = po;
    rest.set(sim.rest, 3 * po);
    region.set(sim.region, po);
    comp.fill(ci, po, po + sim.n);
    for (let i = 0; i < sim.tets.length; i++) tets[4 * to + i] = sim.tets[i] + po;
    for (let v = 0; v < ren.nV; v++) {
      statics[4 * (vo + v)] = ren.pos[3 * v];
      statics[4 * (vo + v) + 1] = ren.pos[3 * v + 1];
      statics[4 * (vo + v) + 2] = ren.pos[3 * v + 2];
      statics[4 * (vo + v) + 3] = ren.mat[v];
    }
    vComp.fill(ci, vo, vo + ren.nV);
    for (let i = 0; i < 4 * ren.nV; i++) {
      skinIdx[4 * vo + i] = emb.idx[i] + po;
      skinW[4 * vo + i] = emb.w[i];
    }
    for (const v of ren.body) index[bo++] = v + vo;
    for (const v of ren.seeds) index[so++] = v + vo;
    for (const v of ren.bubbles) index[uo++] = v + vo;
    po += sim.n; to += sim.nT; vo += ren.nV;
  });
  compStart[pieces.length] = po;
  return {
    rest, tets, region, comp, compStart, nComp: pieces.length, n, nT,
    mesh: {
      statics, index, nV, vComp, skinIdx, skinW,
      ranges: {
        body: { first: 0, count: nBody },
        seeds: { first: nBody, count: nSeed },
        bubbles: { first: nBody + nSeed, count: nBub },
      },
    },
  };
}
