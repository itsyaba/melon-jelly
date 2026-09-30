// Wedge profile, seeded randomness, 2D Delaunay, lattices, props and barycentric embedding.
//
// Conventions: world +Y up, floor y = 0. The rest plane (u, w) is world (x, z); the wedge
// apex is at the origin and +w runs from the tip toward the rind. Every piece shares this
// rest frame, so seeds and rind colour never move when the slice is cut.

export const SHAPE = {
  alpha: (32 * Math.PI) / 180, // half-angle of the wedge
  Ri: 1.62, // inner sector radius (before rounding)
  rho: 0.17, // in-plane corner rounding
  T: 0.58, // thickness
  bevel: 0.13, // rounding of top/bottom edges
  skin: 0.075, // green skin band depth
  pale: 0.25, // skin + pale layer depth
};
SHAPE.Ro = SHAPE.Ri + SHAPE.rho;

export const RC = SHAPE.rho;

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Inigo Quilez's exact pie SDF (opening along +w).
export function sdPie(u, w, alpha, r) {
  const px = Math.abs(u), py = w;
  const cx = Math.sin(alpha), cy = Math.cos(alpha);
  const l = Math.hypot(px, py) - r;
  const d = Math.min(Math.max(px * cx + py * cy, 0), r);
  const m = Math.hypot(px - cx * d, py - cy * d);
  const s = Math.sign(cy * px - cx * py) || 1;
  return Math.max(l, m * s);
}
export const sdShape = (u, w, inset = 0) => sdPie(u, w, SHAPE.alpha, SHAPE.Ri) - SHAPE.rho + inset;

// Material region by radial depth from the rind: 0 flesh, 1 pale, 2 rind.
export function regionOf(x, z) {
  const depth = SHAPE.Ro - Math.hypot(x, z);
  return depth < SHAPE.skin + 0.03 ? 2 : depth < SHAPE.pale ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Convex pieces: outline samples, signed distance, lattices

// Boundary samples of a convex CCW polygon I grown by RC: { q, n } where q is on the inner
// polygon and n the outward normal. Any offset curve is q + n·d with identical indexing.
export function pieceSamples(I, spacing, maxAngleStep) {
  const out = [], N = I.length, edgeN = [];
  for (let i = 0; i < N; i++) {
    const p = I[i], q = I[(i + 1) % N], ex = q[0] - p[0], ew = q[1] - p[1], l = Math.hypot(ex, ew) || 1;
    edgeN.push([ew / l, -ex / l, l]);
  }
  for (let i = 0; i < N; i++) {
    const n0 = edgeN[(i - 1 + N) % N], n1 = edgeN[i];
    const a0 = Math.atan2(n0[1], n0[0]), a1 = Math.atan2(n1[1], n1[0]);
    let da = a1 - a0;
    while (da < 0) da += Math.PI * 2;
    if (da > Math.PI * 1.5) da = 0;
    const na = Math.max(1, Math.ceil(Math.max((RC * da) / spacing, da / maxAngleStep)));
    for (let k = 0; k < na; k++) {
      const t = a0 + (da * k) / na;
      out.push({ q: I[i], n: [Math.cos(t), Math.sin(t)] });
    }
    const nl = Math.max(1, Math.ceil(n1[2] / spacing));
    for (let k = 1; k < nl; k++) {
      const t = k / nl, p = I[i], q = I[(i + 1) % N];
      out.push({ q: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], n: [n1[0], n1[1]] });
    }
  }
  return out;
}

// Approximate signed distance to the INNER polygon (max over edge half-planes).
export function sdInner(I, u, w) {
  let d = -Infinity;
  const N = I.length;
  for (let i = 0; i < N; i++) {
    const p = I[i], q = I[(i + 1) % N], ex = q[0] - p[0], ew = q[1] - p[1], l = Math.hypot(ex, ew) || 1;
    const s = ((u - p[0]) * ew - (w - p[1]) * ex) / l;
    if (s > d) d = s;
  }
  return d;
}
export const sdPiece = (I, u, w) => sdInner(I, u, w) - RC;

// Hex lattice over the bbox of I padded by `pad`; keep(u, w) filters points.
export function bboxLattice(I, pad, spacing, keep) {
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const [u, w] of I) {
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    w0 = Math.min(w0, w); w1 = Math.max(w1, w);
  }
  u0 -= pad; u1 += pad; w0 -= pad; w1 += pad;
  const dy = (spacing * Math.sqrt(3)) / 2, out = [];
  // Anchor the lattice to the global origin so neighbouring pieces use the same grid.
  const r0 = Math.floor(w0 / dy), r1 = Math.ceil(w1 / dy);
  for (let r = r0; r <= r1; r++) {
    const w = r * dy, off = (r & 1) * spacing * 0.5;
    const c0 = Math.floor((u0 - off) / spacing), c1 = Math.ceil((u1 - off) / spacing);
    for (let c = c0; c <= c1; c++) {
      const u = c * spacing + off;
      if (keep(u, w)) out.push([u, w]);
    }
  }
  return out;
}

export function polyArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polyCentroid(P) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-12) return P[0].slice();
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------------------------------------------------------------------------
// Bowyer–Watson Delaunay (2D). P: array of [u, w]. Returns a flat CCW triangle index array.

export function delaunay(P) {
  const n = P.length;
  if (n < 3) return new Uint32Array(0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const d = Math.max(x1 - x0, y1 - y0) * 20 || 1, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  // Tiny deterministic jitter breaks exact co-circular / collinear lattice cases.
  const R = rng(1234);
  const X = new Float64Array(n + 3), Y = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) {
    X[i] = P[i][0] + (R() - 0.5) * 1e-7;
    Y[i] = P[i][1] + (R() - 0.5) * 1e-7;
  }
  X[n] = mx - d; Y[n] = my - d;
  X[n + 1] = mx + d; Y[n + 1] = my - d;
  X[n + 2] = mx; Y[n + 2] = my + d;

  const mk = (a, b, c) => {
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-18) return { a, b, c, x: 0, y: 0, r2: Infinity };
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };

  let tris = [mk(n, n + 1, n + 2)];
  const edges = new Map();
  for (let i = 0; i < n; i++) {
    const px = X[i], py = Y[i], keep = [];
    edges.clear();
    for (const t of tris) {
      const dx = px - t.x, dy = py - t.y;
      if (dx * dx + dy * dy - t.r2 < 1e-9) {
        for (const [e0, e1] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
          const key = Math.min(e0, e1) * 100003 + Math.max(e0, e1);
          const e = edges.get(key);
          if (e) e.n++;
          else edges.set(key, { a: e0, b: e1, n: 1 });
        }
      } else keep.push(t);
    }
    for (const e of edges.values()) if (e.n === 1) keep.push(mk(e.a, e.b, i));
    tris = keep;
  }

  const out = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    const cr = (X[t.b] - X[t.a]) * (Y[t.c] - Y[t.a]) - (Y[t.b] - Y[t.a]) * (X[t.c] - X[t.a]);
    if (cr > 0) out.push(t.a, t.b, t.c);
    else out.push(t.a, t.c, t.b);
  }
  return Uint32Array.from(out);
}

// ---------------------------------------------------------------------------
// Tetrahedra

export function tetVolume(p, a, b, c, d) {
  const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
  const bx = p[3 * b] - ax, by = p[3 * b + 1] - ay, bz = p[3 * b + 2] - az;
  const cx = p[3 * c] - ax, cy = p[3 * c + 1] - ay, cz = p[3 * c + 2] - az;
  const dx = p[3 * d] - ax, dy = p[3 * d + 1] - ay, dz = p[3 * d + 2] - az;
  return (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
}

// Row-major 3×3 inverse into out[o..o+8]; returns false if singular.
export function inv3(m, out, o = 0) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return false;
  const s = 1 / det;
  out[o] = A * s; out[o + 1] = -(b * i - c * h) * s; out[o + 2] = (b * f - c * e) * s;
  out[o + 3] = B * s; out[o + 4] = (a * i - c * g) * s; out[o + 5] = -(a * f - c * d) * s;
  out[o + 6] = C * s; out[o + 7] = -(a * h - b * g) * s; out[o + 8] = (a * e - b * d) * s;
  return true;
}

// For each point in `pts` (flat xyz), find the tet of (rest, tets) that contains it (or the
// "least outside" one) and return 4 particle indices + 4 barycentric weights per point.
export function embed(rest, tets, pts) {
  const nT = tets.length / 4, nP = pts.length / 3;
  const inv = new Float64Array(9 * nT), valid = new Uint8Array(nT);
  const cell = 0.2;
  let gx0 = Infinity, gz0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gz1 = -Infinity, gy1 = -Infinity;
  const box = new Float32Array(6 * nT);
  for (let t = 0; t < nT; t++) {
    const a = tets[4 * t];
    const ax = rest[3 * a], ay = rest[3 * a + 1], az = rest[3 * a + 2];
    const cols = [];
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const v = tets[4 * t + k], x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
      by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
      if (k) cols.push([x - ax, y - ay, z - az]);
    }
    box.set([bx0, by0, bz0, bx1, by1, bz1], 6 * t);
    gx0 = Math.min(gx0, bx0); gy0 = Math.min(gy0, by0); gz0 = Math.min(gz0, bz0);
    gx1 = Math.max(gx1, bx1); gy1 = Math.max(gy1, by1); gz1 = Math.max(gz1, bz1);
    // columns are edge vectors → matrix E = [b-a | c-a | d-a], we need E⁻¹
    const E = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
    valid[t] = inv3(E, inv, 9 * t) ? 1 : 0;
  }
  const nx = Math.max(1, Math.ceil((gx1 - gx0) / cell) + 1);
  const ny = Math.max(1, Math.ceil((gy1 - gy0) / cell) + 1);
  const nz = Math.max(1, Math.ceil((gz1 - gz0) / cell) + 1);
  const grid = new Map();
  for (let t = 0; t < nT; t++) {
    if (!valid[t]) continue;
    const i0 = Math.floor((box[6 * t] - gx0) / cell), i1 = Math.floor((box[6 * t + 3] - gx0) / cell);
    const j0 = Math.floor((box[6 * t + 1] - gy0) / cell), j1 = Math.floor((box[6 * t + 4] - gy0) / cell);
    const k0 = Math.floor((box[6 * t + 2] - gz0) / cell), k1 = Math.floor((box[6 * t + 5] - gz0) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const key = (i * ny + j) * nz + k;
      let l = grid.get(key);
      if (!l) grid.set(key, (l = []));
      l.push(t);
    }
  }

  const bary = (t, x, y, z) => {
    const a = tets[4 * t], dx = x - rest[3 * a], dy = y - rest[3 * a + 1], dz = z - rest[3 * a + 2], I = 9 * t;
    const b1 = inv[I] * dx + inv[I + 1] * dy + inv[I + 2] * dz;
    const b2 = inv[I + 3] * dx + inv[I + 4] * dy + inv[I + 5] * dz;
    const b3 = inv[I + 6] * dx + inv[I + 7] * dy + inv[I + 8] * dz;
    return [1 - b1 - b2 - b3, b1, b2, b3];
  };

  const idx = new Uint32Array(4 * nP), w = new Float32Array(4 * nP);
  for (let p = 0; p < nP; p++) {
    const x = pts[3 * p], y = pts[3 * p + 1], z = pts[3 * p + 2];
    const ci = Math.floor((x - gx0) / cell), cj = Math.floor((y - gy0) / cell), ck = Math.floor((z - gz0) / cell);
    let best = -1, bestScore = -Infinity, bestB = null;
    const tryTet = (t) => {
      const b = bary(t, x, y, z), s = Math.min(b[0], b[1], b[2], b[3]);
      if (s > bestScore) { bestScore = s; best = t; bestB = b; }
    };
    for (let r = 0; r <= 2 && bestScore < -1e-4; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue; // shell only
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
        const l = grid.get((i * ny + j) * nz + k);
        if (l) for (const t of l) tryTet(t);
      }
    }
    if (best < 0) for (let t = 0; t < nT; t++) if (valid[t]) tryTet(t);
    if (best < 0) { best = 0; bestB = [1, 0, 0, 0]; }
    for (let k = 0; k < 4; k++) {
      idx[4 * p + k] = tets[4 * best + k];
      w[4 * p + k] = bestB[k];
    }
  }
  return { idx, w };
}

// ---------------------------------------------------------------------------
// Seeds and bubbles, generated once in the shared rest frame.

let PROPS = null;

export function globalProps() {
  if (PROPS) return PROPS;
  const R = rng(9), { alpha, T } = SHAPE, props = [];
  const radii = [0.46, 0.68, 0.9, 1.12, 1.33], counts = [2, 3, 4, 5, 5];

  const addSeed = (r, th, y, s, tilt) => {
    const L = 0.15 * s, W = 0.088 * s, H = 0.042 * s;
    props.push({ kind: 'seed', cx: r * Math.sin(th), cz: r * Math.cos(th), cy: y, th: th + (R() - 0.5) * 0.18, tilt, L, W, H, rad: L / 2 + 0.01 });
  };

  for (const face of [1, -1]) {
    radii.forEach((r0, row) => {
      const cnt = counts[row], maxTh = alpha - 0.19 / r0 - 0.02;
      for (let k = 0; k < cnt; k++) {
        const th = cnt === 1 ? 0 : -maxTh + (2 * maxTh * (k + 0.5)) / cnt + (R() - 0.5) * 0.05;
        const r = r0 + (R() - 0.5) * 0.05, s = 0.82 + R() * 0.3, H = 0.042 * s;
        const y = face > 0 ? T - 0.64 * H : 0.64 * H;
        addSeed(r, th, y, s, (R() - 0.5) * 0.25 * face);
      }
    });
  }
  // two suspended seeds, glimpsed through the jelly
  addSeed(0.8, 0.12, T * 0.52, 1.0, 0.35);
  addSeed(1.05, -0.16, T * 0.45, 0.95, -0.25);

  // bubbles: 9 random + 2 placed
  for (let i = 0; i < 9; i++) {
    const rad = 0.009 + R() * R() * 0.02;
    const r = 0.35 + R() * 1.05, lim = alpha - 0.16 / r;
    const th = (R() * 2 - 1) * lim;
    const y = R() < 0.6 ? T - 0.045 - R() * 0.08 : 0.08 + R() * (T - 0.2);
    props.push({ kind: 'bubble', cx: r * Math.sin(th), cz: r * Math.cos(th), cy: y, r: rad, rad: rad + 0.005 });
  }
  props.push({ kind: 'bubble', cx: 0.12, cz: 0.95, cy: T - 0.06, r: 0.024, rad: 0.029 });
  props.push({ kind: 'bubble', cx: -0.2, cz: 1.22, cy: T * 0.4, r: 0.016, rad: 0.021 });

  PROPS = props;
  return props;
}
