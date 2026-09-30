// Procedural nakiri knife: blade (ground bevel + flat grind), bolster, oval walnut handle.
// Local frame: +x along the blade toward the tip, +y up, cutting edge on y = 0, faces ±z,
// handle along −x. Material ids: 3.0 edge bevel, 3.45 blade flat, 3.7 bolster, 5 handle.

export const KNIFE = { Lb: 1.72, H: 0.63, xr: 0.86, handleLen: 0.84 };

const edgeY = (u) => (u > 0.86 ? 0.06 * ((u - 0.86) / 0.14) ** 2 : 0);
function spineY(u) {
  if (u <= 0.72) return KNIFE.H;
  const s = (u - 0.72) / 0.28;
  return KNIFE.H - (KNIFE.H * 0.5) * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
}
function halfThick(u, v) {
  const taper = 1 - 0.35 * u * u;
  const t = v < 0.2 ? 0.0009 + (0.0062 - 0.0009) * (v / 0.2) : 0.0062 + (0.0157 - 0.0062) * ((v - 0.2) / 0.8);
  return t * taper;
}

export function buildKnifeMesh() {
  const pos = [], nrm = [], mat = [], index = [];
  const vert = (p, n, m) => {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    pos.push(p[0], p[1], p[2]);
    nrm.push(n[0] / l, n[1] / l, n[2] / l);
    mat.push(m);
    return mat.length - 1;
  };
  const quad = (a, b, c, d) => index.push(a, b, c, b, d, c); // a b / c d grid order

  // ---- blade faces
  const NU = 44, NV = 12, Lb = KNIFE.Lb;
  const vs = [];
  for (let k = 0; k <= NV; k++) vs.push((k / NV) ** 1.6);
  const bladeP = (u, v, s) => {
    const e = edgeY(u), sp = spineY(u), y = e + v * (sp - e);
    return [u * Lb, y, s * halfThick(u, v)];
  };
  const faceGrid = {};
  for (const s of [1, -1]) {
    const g = [];
    for (let i = 0; i <= NU; i++) {
      const u = i / NU, row = [];
      for (let k = 0; k <= NV; k++) {
        const v = vs[k], p = bladeP(u, v, s);
        const e = edgeY(u), sp = spineY(u), span = Math.max(sp - e, 1e-3);
        const dv = 1e-3, dtdy = (halfThick(u, Math.min(1, v + dv)) - halfThick(u, Math.max(0, v - dv))) / (2 * dv * span);
        row.push(vert(p, [0, -dtdy, s], v < 0.2 ? 3.0 : 3.45));
      }
      g.push(row);
    }
    faceGrid[s] = g;
    for (let i = 0; i < NU; i++) for (let k = 0; k < NV; k++) quad(g[i][k], g[i + 1][k], g[i][k + 1], g[i + 1][k + 1]);
  }

  // ---- spine, edge, nose and heel strips (duplicated vertices keep creases sharp)
  const strip = (pointsA, pointsB, normals, m) => {
    const a = [], b = [];
    for (let i = 0; i < pointsA.length; i++) {
      a.push(vert(pointsA[i], normals[i], m));
      b.push(vert(pointsB[i], normals[i], m));
    }
    for (let i = 0; i + 1 < a.length; i++) quad(a[i], a[i + 1], b[i], b[i + 1]);
  };
  const colP = (s, k) => Array.from({ length: NU + 1 }, (_, i) => bladeP(i / NU, vs[k], s));
  const spN = [], edN = [];
  for (let i = 0; i <= NU; i++) {
    const u = i / NU, du = 1 / NU;
    const dS = (spineY(Math.min(1, u + du / 2)) - spineY(Math.max(0, u - du / 2))) / (du * Lb);
    const dE = (edgeY(Math.min(1, u + du / 2)) - edgeY(Math.max(0, u - du / 2))) / (du * Lb);
    spN.push([-dS, 1, 0]);
    edN.push([dE, -1, 0]);
  }
  strip(colP(1, NV), colP(-1, NV), spN, 3.45);
  strip(colP(1, 0), colP(-1, 0), edN, 3.0);
  const rowP = (s, i) => vs.map((v) => bladeP(i / NU, v, s));
  const noseN = vs.map(() => [1, 0, 0]), heelN = vs.map(() => [-1, 0, 0]);
  strip(rowP(1, NU), rowP(-1, NU), noseN, 3.45);
  strip(rowP(1, 0), rowP(-1, 0), heelN, 3.45);

  // ---- bolster: a small box
  {
    const x0 = -0.07, x1 = 0.004, y0 = 0.46, y1 = 0.645, z = 0.042;
    const faces = [
      [[1, 0, 0], [[x1, y0, -z], [x1, y0, z], [x1, y1, -z], [x1, y1, z]]],
      [[-1, 0, 0], [[x0, y0, z], [x0, y0, -z], [x0, y1, z], [x0, y1, -z]]],
      [[0, 1, 0], [[x0, y1, -z], [x1, y1, -z], [x0, y1, z], [x1, y1, z]]],
      [[0, -1, 0], [[x0, y0, z], [x1, y0, z], [x0, y0, -z], [x1, y0, -z]]],
      [[0, 0, 1], [[x0, y0, z], [x1, y0, z], [x0, y1, z], [x1, y1, z]]],
      [[0, 0, -1], [[x1, y0, -z], [x0, y0, -z], [x1, y1, -z], [x0, y1, -z]]],
    ];
    for (const [n, ps] of faces) {
      const q = ps.map((p) => vert(p, n, 3.7));
      quad(q[0], q[1], q[2], q[3]);
    }
  }

  // ---- handle: 26 oval rings × 22 segments, swelling mid-length, dropping toward the butt
  {
    const NR = 26, NS = 22, rings = [];
    const ringAt = (p) => {
      const sw = 1 + 0.1 * Math.sin(Math.PI * p);
      return { x: -0.07 - KNIFE.handleLen * p, cy: 0.56 - 0.028 * p * p, ry: 0.066 * sw, rz: 0.045 * sw };
    };
    for (let i = 0; i < NR; i++) {
      const r = ringAt(i / (NR - 1)), row = [];
      for (let j = 0; j < NS; j++) {
        const ph = (j / NS) * Math.PI * 2, c = Math.cos(ph), s = Math.sin(ph);
        row.push(vert([r.x, r.cy + c * r.ry, s * r.rz], [0, c / r.ry, s / r.rz], 5));
      }
      rings.push(row);
    }
    for (let i = 0; i + 1 < NR; i++) {
      for (let j = 0; j < NS; j++) quad(rings[i][j], rings[i][(j + 1) % NS], rings[i + 1][j], rings[i + 1][(j + 1) % NS]);
    }
    for (const [p, nx] of [[0, 1], [1, -1]]) {
      const r = ringAt(p), ctr = vert([r.x, r.cy, 0], [nx, 0, 0], 5), ring = [];
      for (let j = 0; j < NS; j++) {
        const ph = (j / NS) * Math.PI * 2;
        ring.push(vert([r.x, r.cy + Math.cos(ph) * r.ry, Math.sin(ph) * r.rz], [nx, 0, 0], 5));
      }
      for (let j = 0; j < NS; j++) index.push(ctr, ring[j], ring[(j + 1) % NS]);
    }
  }

  // winding repair against the intended outward normals
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    const e1 = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]];
    const e2 = [pos[3 * c] - pos[3 * a], pos[3 * c + 1] - pos[3 * a + 1], pos[3 * c + 2] - pos[3 * a + 2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    let s = 0;
    for (const v of [a, b, c]) s += g[0] * nrm[3 * v] + g[1] * nrm[3 * v + 1] + g[2] * nrm[3 * v + 2];
    if (s < 0) { index[i + 1] = c; index[i + 2] = b; }
  }

  const n = mat.length, statics = new Float32Array(4 * n);
  for (let v = 0; v < n; v++) {
    statics[4 * v] = pos[3 * v];
    statics[4 * v + 1] = pos[3 * v + 1];
    statics[4 * v + 2] = pos[3 * v + 2];
    statics[4 * v + 3] = mat[v];
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), statics, index: new Uint32Array(index), nV: n };
}

// yaw about Y, then roll about the blade axis (face toward the viewer), then pitch (tip down).
// Row-major 3×3; columns are the local axes in world space.
export function knifeBasis(yaw, roll, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cr = Math.cos(-roll), sr = Math.sin(-roll);
  const cp = Math.cos(-pitch), sp = Math.sin(-pitch);
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rx = [1, 0, 0, 0, cr, -sr, 0, sr, cr];
  const Rz = [cp, -sp, 0, sp, cp, 0, 0, 0, 1];
  return mul3(mul3(Ry, Rx), Rz);
}

function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
  return o;
}

// Write posed positions + normals (stride 6) into out. pose.p is where the blade's
// reference point (xr along the edge) lands.
export function poseKnife(mesh, pose, out) {
  const B = knifeBasis(pose.yaw, pose.roll, pose.pitch), { pos, nrm, nV } = mesh, [px, py, pz] = pose.p;
  const xr = KNIFE.xr;
  for (let v = 0; v < nV; v++) {
    const lx = pos[3 * v] - xr, ly = pos[3 * v + 1], lz = pos[3 * v + 2];
    const nx = nrm[3 * v], ny = nrm[3 * v + 1], nz = nrm[3 * v + 2], o = 6 * v;
    out[o] = px + B[0] * lx + B[1] * ly + B[2] * lz;
    out[o + 1] = py + B[3] * lx + B[4] * ly + B[5] * lz;
    out[o + 2] = pz + B[6] * lx + B[7] * ly + B[8] * lz;
    out[o + 3] = B[0] * nx + B[1] * ny + B[2] * nz;
    out[o + 4] = B[3] * nx + B[4] * ny + B[5] * nz;
    out[o + 5] = B[6] * nx + B[7] * ny + B[8] * nz;
  }
}
