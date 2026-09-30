// XPBD soft body: co-rotational tet shape matching + volume constraints, floor with
// positional Coulomb friction, edge damping, soft grab, piece–piece collisions and a blade.

import { KNIFE } from './knife.js';



function quatToMat(q, R) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
}

// Müller et al. 2016, "A Robust Method to Extract the Rotational Part of Deformations".
// A is row-major; q (x, y, z, w) is updated in place (warm start).
function extractRotation(A, q, iters, R) {
  for (let it = 0; it < iters; it++) {
    quatToMat(q, R);
    // ω = Σ_col (r_col × a_col) / |Σ_col r_col · a_col|
    let wx = 0, wy = 0, wz = 0, d = 0;
    for (let c = 0; c < 3; c++) {
      const rx = R[c], ry = R[3 + c], rz = R[6 + c];
      const ax = A[c], ay = A[3 + c], az = A[6 + c];
      wx += ry * az - rz * ay;
      wy += rz * ax - rx * az;
      wz += rx * ay - ry * ax;
      d += rx * ax + ry * ay + rz * az;
    }
    const inv = 1 / (Math.abs(d) + 1e-9);
    wx *= inv; wy *= inv; wz *= inv;
    const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (w < 1e-9) break;
    const sc = w > 1 ? 0.5 / w : 0.5;
    // q ← normalise(q + sc·(ω ⊗ q)),  ω as a pure quaternion
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const dx = qw * wx + (wy * qz - wz * qy);
    const dy = qw * wy + (wz * qx - wx * qz);
    const dz = qw * wz + (wx * qy - wy * qx);
    const dw = -(wx * qx + wy * qy + wz * qz);
    let nx = qx + sc * dx, ny = qy + sc * dy, nz = qz + sc * dz, nw = qw + sc * dw;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
    q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
  }
  quatToMat(q, R);
}

export class SoftBody {
  constructor(world, { firmness = 0.4, damping = 0.45 } = {}) {
    const { rest, tets, region, comp, compStart, nComp } = world;
    const n = rest.length / 3, nT = tets.length / 4;
    this.n = n;
    this.nT = nT;
    this.rest = rest;
    this.tets = tets;
    this.comp = comp;
    this.compStart = compStart;
    this.nComp = nComp;

    this.gravity = -9.81;
    this.stepDt = 1 / 60;
    this.substeps = 10;
    this.friction = 0.55;
    this.maxSpeed = 12;
    this.floorY = 0;
    this.firmness = firmness;
    this.damping = damping;

    this.x = new Float32Array(rest);
    this.prev = new Float32Array(rest);
    this.v = new Float32Array(3 * n);
    this.mass = new Float32Array(n);
    this.invMass = new Float32Array(n);

    this.restVol = new Float32Array(nT);
    this.tetQ = new Float32Array(12 * nT);
    this.tetRot = new Float32Array(4 * nT);
    this.tetFirm = new Float32Array(nT);

    let totalVol = 0;
    for (let t = 0; t < nT; t++) {
      const v = this.tetVol(rest, t);
      this.restVol[t] = v;
      totalVol += v;
      for (let k = 0; k < 4; k++) this.mass[tets[4 * t + k]] += v / 4;
      const rg = region[tets[4 * t]] + region[tets[4 * t + 1]] + region[tets[4 * t + 2]] + region[tets[4 * t + 3]];
      this.tetFirm[t] = rg >= 6 ? 0.3 : rg >= 3 ? 0.5 : rg >= 1 ? 0.75 : 1.0;
      this.tetRot[4 * t + 3] = 1;
    }
    this.totalRestVolume = totalVol;
    let tm = 0;
    for (let i = 0; i < n; i++) {
      if (this.mass[i] <= 0) this.mass[i] = 1e-6;
      this.invMass[i] = 1 / this.mass[i];
      tm += this.mass[i];
    }
    this.totalMass = tm;
    this.tetM = new Float64Array(4 * nT);
    for (let i = 0; i < 4 * nT; i++) this.tetM[i] = this.mass[tets[i]];
    // rest corners relative to the mass-weighted tet centroid
    for (let t = 0; t < nT; t++) {
      let cx = 0, cy = 0, cz = 0, M = 0;
      for (let k = 0; k < 4; k++) {
        const i = tets[4 * t + k], m = this.mass[i];
        cx += rest[3 * i] * m; cy += rest[3 * i + 1] * m; cz += rest[3 * i + 2] * m; M += m;
      }
      cx /= M; cy /= M; cz /= M;
      for (let k = 0; k < 4; k++) {
        const i = tets[4 * t + k];
        this.tetQ[12 * t + 3 * k] = rest[3 * i] - cx;
        this.tetQ[12 * t + 3 * k + 1] = rest[3 * i + 1] - cy;
        this.tetQ[12 * t + 3 * k + 2] = rest[3 * i + 2] - cz;
      }
    }

    // unique edges, lightly shuffled with a deterministic hash (less Gauss–Seidel bias)
    const map = new Map();
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    for (let t = 0; t < nT; t++) {
      for (const [a, b] of pairs) {
        let i = tets[4 * t + a], j = tets[4 * t + b];
        if (i > j) [i, j] = [j, i];
        const key = i * 65536 + j;
        if (!map.has(key)) map.set(key, [i, j]);
      }
    }
    const list = [...map.values()];
    const h = (k) => (Math.imul(k + 1, 2654435761) >>> 0) / 4294967296;
    const order = list.map((_, k) => [h(k), k]).sort((a, b) => a[0] - b[0]);
    this.edges = new Uint32Array(list.length * 2);
    order.forEach(([, k], o) => { this.edges[2 * o] = list[k][0]; this.edges[2 * o + 1] = list[k][1]; });

    // grab state
    this.grabbing = false;
    this.grabIdx = null;
    this.grabW = null;
    this.grabOff = null;
    this.grabTarget = [0, 0, 0];
    this.grabRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.grabStart = [0, 0, 0];
    this.grabComp = -1;

    // blade (set by the knife choreography)
    this.blade = null;
    this.subIndex = 0;
  }

  tetVol(p, t) {
    const T = this.tets, a = 3 * T[4 * t], b = 3 * T[4 * t + 1], c = 3 * T[4 * t + 2], d = 3 * T[4 * t + 3];
    const bx = p[b] - p[a], by = p[b + 1] - p[a + 1], bz = p[b + 2] - p[a + 2];
    const cx = p[c] - p[a], cy = p[c + 1] - p[a + 1], cz = p[c + 2] - p[a + 2];
    const dx = p[d] - p[a], dy = p[d + 1] - p[a + 1], dz = p[d + 2] - p[a + 2];
    return (bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx)) / 6;
  }

  shapeCompliance() {
    return Math.exp(Math.log(3.0) + (Math.log(0.05) - Math.log(3.0)) * this.firmness);
  }
  volCompliance() {
    return 1e-4 * (1 - 0.7 * this.firmness);
  }
  dampRate() {
    return 2 + 40 * this.damping * this.damping;
  }

  step() {
    const dt = this.stepDt / this.substeps;
    for (let s = 0; s < this.substeps; s++) this.substep(dt);

    // settling: bleed off the last micro-jitter
    if (!this.grabbing && !(this.blade && this.blade.mode)) {
      const ke = this.kineticEnergy() / this.totalMass;
      if (ke < 2e-3) {
        const f = Math.max(0.86, 1 - 0.14 * (1 - ke / 2e-3));
        const v = this.v;
        for (let i = 0; i < v.length; i++) v[i] *= f;
      }
    }
    // safety: NaN guard
    const x = this.x;
    for (let i = 0; i < x.length; i += 97) {
      if (!Number.isFinite(x[i])) { this.reset(0.2); break; }
    }
  }

  substep(dt) {
    const { x, prev, v, n } = this;
    const air = Math.exp(-(this.grabbing ? 2.5 : 0.08) * dt);
    const g = this.gravity * dt;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      v[o + 1] += g;
      v[o] *= air; v[o + 1] *= air; v[o + 2] *= air;
      prev[o] = x[o]; prev[o + 1] = x[o + 1]; prev[o + 2] = x[o + 2];
      x[o] += v[o] * dt; x[o + 1] += v[o + 1] * dt; x[o + 2] += v[o + 2] * dt;
    }
    if (this.grabbing) this.solveGrab(dt);
    this.solveTets(dt);
    this.solveVolumes(dt);
    if (this.nComp > 1 && (this.subIndex++ & 1) === 0) this.collidePieces();
    if (this.blade && this.blade.mode) this.solveBlade();
    this.solveFloor();
    const inv = 1 / dt, ms = this.maxSpeed;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      let vx = (x[o] - prev[o]) * inv, vy = (x[o + 1] - prev[o + 1]) * inv, vz = (x[o + 2] - prev[o + 2]) * inv;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp > ms) { const k = ms / sp; vx *= k; vy *= k; vz *= k; }
      v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
    }
    this.dampEdges(dt);
  }

  // co-rotational shape matching per tet; one fraction for all four corners (momentum-safe)
  solveTets(dt) {
    const { x, tets, tetM, tetQ, tetRot, tetFirm, nT } = this;
    const base = this.shapeCompliance() / (dt * dt);
    for (let t = 0; t < nT; t++) {
      const t4 = 4 * t, t12 = 12 * t;
      const a = 3 * tets[t4], b = 3 * tets[t4 + 1], c = 3 * tets[t4 + 2], d = 3 * tets[t4 + 3];
      const m0 = tetM[t4], m1 = tetM[t4 + 1], m2 = tetM[t4 + 2], m3 = tetM[t4 + 3], M = m0 + m1 + m2 + m3, iM = 1 / M;
      const ax = x[a], ay = x[a + 1], az = x[a + 2], bx = x[b], by = x[b + 1], bz = x[b + 2];
      const cx_ = x[c], cy_ = x[c + 1], cz_ = x[c + 2], dx = x[d], dy = x[d + 1], dz = x[d + 2];
      const gx0 = (ax * m0 + bx * m1 + cx_ * m2 + dx * m3) * iM;
      const gy0 = (ay * m0 + by * m1 + cy_ * m2 + dy * m3) * iM;
      const gz0 = (az * m0 + bz * m1 + cz_ * m2 + dz * m3) * iM;
      const q0x = tetQ[t12], q0y = tetQ[t12 + 1], q0z = tetQ[t12 + 2];
      const q1x = tetQ[t12 + 3], q1y = tetQ[t12 + 4], q1z = tetQ[t12 + 5];
      const q2x = tetQ[t12 + 6], q2y = tetQ[t12 + 7], q2z = tetQ[t12 + 8];
      const q3x = tetQ[t12 + 9], q3y = tetQ[t12 + 10], q3z = tetQ[t12 + 11];
      const p0x = (ax - gx0) * m0, p0y = (ay - gy0) * m0, p0z = (az - gz0) * m0;
      const p1x = (bx - gx0) * m1, p1y = (by - gy0) * m1, p1z = (bz - gz0) * m1;
      const p2x = (cx_ - gx0) * m2, p2y = (cy_ - gy0) * m2, p2z = (cz_ - gz0) * m2;
      const p3x = (dx - gx0) * m3, p3y = (dy - gy0) * m3, p3z = (dz - gz0) * m3;
      // A = Σ m (x − c) qᵀ, row-major
      const A0 = p0x * q0x + p1x * q1x + p2x * q2x + p3x * q3x;
      const A1 = p0x * q0y + p1x * q1y + p2x * q2y + p3x * q3y;
      const A2 = p0x * q0z + p1x * q1z + p2x * q2z + p3x * q3z;
      const A3 = p0y * q0x + p1y * q1x + p2y * q2x + p3y * q3x;
      const A4 = p0y * q0y + p1y * q1y + p2y * q2y + p3y * q3y;
      const A5 = p0y * q0z + p1y * q1z + p2y * q2z + p3y * q3z;
      const A6 = p0z * q0x + p1z * q1x + p2z * q2x + p3z * q3x;
      const A7 = p0z * q0y + p1z * q1y + p2z * q2y + p3z * q3y;
      const A8 = p0z * q0z + p1z * q1z + p2z * q2z + p3z * q3z;
      // Müller rotation extraction, 2 warm-started iterations
      let qx = tetRot[t4], qy = tetRot[t4 + 1], qz = tetRot[t4 + 2], qw = tetRot[t4 + 3];
      let R0 = 1, R1 = 0, R2 = 0, R3 = 0, R4 = 1, R5 = 0, R6 = 0, R7 = 0, R8 = 1;
      for (let it = 0; it < 3; it++) {
        R0 = 1 - 2 * (qy * qy + qz * qz); R1 = 2 * (qx * qy - qz * qw); R2 = 2 * (qx * qz + qy * qw);
        R3 = 2 * (qx * qy + qz * qw); R4 = 1 - 2 * (qx * qx + qz * qz); R5 = 2 * (qy * qz - qx * qw);
        R6 = 2 * (qx * qz - qy * qw); R7 = 2 * (qy * qz + qx * qw); R8 = 1 - 2 * (qx * qx + qy * qy);
        if (it === 2) break;
        // columns r_c = (R[c], R[3+c], R[6+c]), a_c = (A[c], A[3+c], A[6+c])
        let wx = (R3 * A6 - R6 * A3) + (R4 * A7 - R7 * A4) + (R5 * A8 - R8 * A5);
        let wy = (R6 * A0 - R0 * A6) + (R7 * A1 - R1 * A7) + (R8 * A2 - R2 * A8);
        let wz = (R0 * A3 - R3 * A0) + (R1 * A4 - R4 * A1) + (R2 * A5 - R5 * A2);
        const dd = R0 * A0 + R3 * A3 + R6 * A6 + R1 * A1 + R4 * A4 + R7 * A7 + R2 * A2 + R5 * A5 + R8 * A8;
        const inv = 1 / ((dd < 0 ? -dd : dd) + 1e-9);
        wx *= inv; wy *= inv; wz *= inv;
        const w2 = wx * wx + wy * wy + wz * wz;
        if (w2 < 1e-18) break;
        const sc = w2 > 1 ? 0.5 / Math.sqrt(w2) : 0.5;
        const ex = qw * wx + (wy * qz - wz * qy);
        const ey = qw * wy + (wz * qx - wx * qz);
        const ez = qw * wz + (wx * qy - wy * qx);
        const ew = -(wx * qx + wy * qy + wz * qz);
        qx += sc * ex; qy += sc * ey; qz += sc * ez; qw += sc * ew;
        const il = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        qx *= il; qy *= il; qz *= il; qw *= il;
      }
      tetRot[t4] = qx; tetRot[t4 + 1] = qy; tetRot[t4 + 2] = qz; tetRot[t4 + 3] = qw;
      // pull every corner toward c + R q by the same fraction (momentum-preserving)
      const f = 1 / (1 + base * tetFirm[t] * M * 0.25);
      x[a] = ax + (gx0 + R0 * q0x + R1 * q0y + R2 * q0z - ax) * f;
      x[a + 1] = ay + (gy0 + R3 * q0x + R4 * q0y + R5 * q0z - ay) * f;
      x[a + 2] = az + (gz0 + R6 * q0x + R7 * q0y + R8 * q0z - az) * f;
      x[b] = bx + (gx0 + R0 * q1x + R1 * q1y + R2 * q1z - bx) * f;
      x[b + 1] = by + (gy0 + R3 * q1x + R4 * q1y + R5 * q1z - by) * f;
      x[b + 2] = bz + (gz0 + R6 * q1x + R7 * q1y + R8 * q1z - bz) * f;
      x[c] = cx_ + (gx0 + R0 * q2x + R1 * q2y + R2 * q2z - cx_) * f;
      x[c + 1] = cy_ + (gy0 + R3 * q2x + R4 * q2y + R5 * q2z - cy_) * f;
      x[c + 2] = cz_ + (gz0 + R6 * q2x + R7 * q2y + R8 * q2z - cz_) * f;
      x[d] = dx + (gx0 + R0 * q3x + R1 * q3y + R2 * q3z - dx) * f;
      x[d + 1] = dy + (gy0 + R3 * q3x + R4 * q3y + R5 * q3z - dy) * f;
      x[d + 2] = dz + (gz0 + R6 * q3x + R7 * q3y + R8 * q3z - dz) * f;
    }
  }

  solveVolumes(dt) {
    const { x, tets, invMass, restVol, nT } = this;
    const alphaT = this.volCompliance() / (dt * dt);
    for (let t = 0; t < nT; t++) {
      const a = 3 * tets[4 * t], b = 3 * tets[4 * t + 1], c = 3 * tets[4 * t + 2], d = 3 * tets[4 * t + 3];
      const wa = invMass[a / 3], wb = invMass[b / 3], wc = invMass[c / 3], wd = invMass[d / 3];
      const ax = x[a], ay = x[a + 1], az = x[a + 2];
      const bax = x[b] - ax, bay = x[b + 1] - ay, baz = x[b + 2] - az;
      const cax = x[c] - ax, cay = x[c + 1] - ay, caz = x[c + 2] - az;
      const dax = x[d] - ax, day = x[d + 1] - ay, daz = x[d + 2] - az;
      // g_b = (c−a)×(d−a), g_c = (d−a)×(b−a), g_d = (b−a)×(c−a), g_a = −(g_b+g_c+g_d)
      const gbx = cay * daz - caz * day, gby = caz * dax - cax * daz, gbz = cax * day - cay * dax;
      const gcx = day * baz - daz * bay, gcy = daz * bax - dax * baz, gcz = dax * bay - day * bax;
      const gdx = bay * caz - baz * cay, gdy = baz * cax - bax * caz, gdz = bax * cay - bay * cax;
      const gax = -(gbx + gcx + gdx), gay = -(gby + gcy + gdy), gaz = -(gbz + gcz + gdz);
      const V = (dax * gdx + day * gdy + daz * gdz) / 6;
      const V0 = restVol[t];
      const C = 6 * (V - V0);
      const at = V < 0.25 * V0 ? 0 : alphaT;
      const den = wa * (gax * gax + gay * gay + gaz * gaz) + wb * (gbx * gbx + gby * gby + gbz * gbz)
        + wc * (gcx * gcx + gcy * gcy + gcz * gcz) + wd * (gdx * gdx + gdy * gdy + gdz * gdz) + at;
      if (den < 1e-12) continue;
      const l = -C / den;
      x[a] += wa * gax * l; x[a + 1] += wa * gay * l; x[a + 2] += wa * gaz * l;
      x[b] += wb * gbx * l; x[b + 1] += wb * gby * l; x[b + 2] += wb * gbz * l;
      x[c] += wc * gcx * l; x[c + 1] += wc * gcy * l; x[c + 2] += wc * gcz * l;
      x[d] += wd * gdx * l; x[d + 1] += wd * gdy * l; x[d + 2] += wd * gdz * l;
    }
  }

  solveFloor() {
    const { x, prev, n, floorY } = this, mu = this.friction;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      const pen = floorY - x[o + 1];
      if (pen <= 0) continue;
      x[o + 1] = floorY;
      const dx = x[o] - prev[o], dz = x[o + 2] - prev[o + 2], dl = Math.sqrt(dx * dx + dz * dz);
      if (dl < 1e-12) continue;
      const f = dl < mu * pen ? 1 : (mu * pen) / dl;
      x[o] -= dx * f;
      x[o + 2] -= dz * f;
    }
  }

  // damp only relative velocity along edges: rigid motion is untouched
  dampEdges(dt) {
    const { x, v, invMass, edges } = this;
    const k = 1 - Math.exp(-this.dampRate() * dt);
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e], j = edges[e + 1], a = 3 * i, b = 3 * j;
      let nx = x[b] - x[a], ny = x[b + 1] - x[a + 1], nz = x[b + 2] - x[a + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      const wi = invMass[i], wj = invMass[j];
      const rv = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
      const imp = (rv * k) / (wi + wj);
      v[a] += nx * imp * wi; v[a + 1] += ny * imp * wi; v[a + 2] += nz * imp * wi;
      v[b] -= nx * imp * wj; v[b + 1] -= ny * imp * wj; v[b + 2] -= nz * imp * wj;
    }
  }

  // ---------------------------------------------------------------- grab

  beginGrab(hit, radius = 0.4) {
    const { x, n, comp } = this;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (x[3 * i] - hit[0]) ** 2 + (x[3 * i + 1] - hit[1]) ** 2 + (x[3 * i + 2] - hit[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return false;
    const cg = comp[best], idx = [], w = [], off = [];
    for (let i = this.compStart[cg]; i < this.compStart[cg + 1]; i++) {
      const dx = x[3 * i] - hit[0], dy = x[3 * i + 1] - hit[1], dz = x[3 * i + 2] - hit[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < radius) {
        const f = 1 - d / radius;
        idx.push(i); w.push(f * f * (3 - 2 * f)); off.push(dx, dy, dz);
      }
    }
    if (!idx.length) {
      idx.push(best); w.push(1);
      off.push(x[3 * best] - hit[0], x[3 * best + 1] - hit[1], x[3 * best + 2] - hit[2]);
    }
    this.grabIdx = Uint32Array.from(idx);
    this.grabW = Float32Array.from(w);
    this.grabOff = Float32Array.from(off);
    this.grabTarget = hit.slice();
    this.grabStart = hit.slice();
    this.grabRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.grabComp = cg;
    this.grabbing = true;
    return true;
  }

  moveGrab(target, rot) {
    if (!this.grabbing) return;
    const t = target.slice(), s = this.grabStart;
    // bounded reach
    const dx = t[0] - s[0], dy = t[1] - s[1], dz = t[2] - s[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz), reach = 2.2;
    if (d > reach) { const k = reach / d; t[0] = s[0] + dx * k; t[1] = s[1] + dy * k; t[2] = s[2] + dz * k; }
    const R = rot || this.grabRot;
    // never crush into the floor
    let minY = Infinity;
    const off = this.grabOff;
    for (let k = 0; k < this.grabIdx.length; k++) {
      const oy = R[3] * off[3 * k] + R[4] * off[3 * k + 1] + R[5] * off[3 * k + 2];
      minY = Math.min(minY, oy);
    }
    const floor = this.floorY + 0.004;
    if (t[1] + minY < floor) t[1] = floor - minY;
    this.grabTarget = t;
    this.grabRot = R;
  }

  endGrab() {
    this.grabbing = false;
    this.grabIdx = null;
    this.grabComp = -1;
  }

  solveGrab(dt) {
    const { x, invMass, grabIdx, grabW, grabOff, grabTarget: T, grabRot: R } = this;
    const a = 2e-6 / (dt * dt);
    for (let k = 0; k < grabIdx.length; k++) {
      const i = grabIdx[k], o = 3 * i, w = invMass[i];
      const ox = grabOff[3 * k], oy = grabOff[3 * k + 1], oz = grabOff[3 * k + 2];
      const tx = T[0] + R[0] * ox + R[1] * oy + R[2] * oz;
      const ty = T[1] + R[3] * ox + R[4] * oy + R[5] * oz;
      const tz = T[2] + R[6] * ox + R[7] * oy + R[8] * oz;
      let f = (grabW[k] * w) / (w + a);
      if (ty < x[o + 1] && ty < 0.45) f *= Math.max(0.12, ty / 0.45); // yield near the table
      x[o] += (tx - x[o]) * f;
      x[o + 1] += (ty - x[o + 1]) * f;
      x[o + 2] += (tz - x[o + 2]) * f;
    }
  }

  // ---------------------------------------------------------------- pieces

  collidePieces() {
    const { x, invMass, compStart, nComp } = this;
    const D = 0.13, D2 = D * D;
    const box = new Float32Array(6 * nComp);
    for (let c = 0; c < nComp; c++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = compStart[c]; i < compStart[c + 1]; i++) {
        const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
      }
      box.set([x0, y0, z0, x1, y1, z1], 6 * c);
    }
    const grid = this._grid || (this._grid = new Map());
    for (let p = 0; p < nComp; p++) {
      for (let q = p + 1; q < nComp; q++) {
        const P = 6 * p, Q = 6 * q;
        const ox0 = Math.max(box[P], box[Q]) - D, ox1 = Math.min(box[P + 3], box[Q + 3]) + D;
        const oy0 = Math.max(box[P + 1], box[Q + 1]) - D, oy1 = Math.min(box[P + 4], box[Q + 4]) + D;
        const oz0 = Math.max(box[P + 2], box[Q + 2]) - D, oz1 = Math.min(box[P + 5], box[Q + 5]) + D;
        if (ox0 > ox1 || oy0 > oy1 || oz0 > oz1) continue;
        // hash q's particles in the shared region
        grid.clear();
        const inside = (i) => {
          const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
          return px >= ox0 && px <= ox1 && py >= oy0 && py <= oy1 && pz >= oz0 && pz <= oz1;
        };
        const key = (a, b, c) => ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) | 0;
        for (let j = compStart[q]; j < compStart[q + 1]; j++) {
          if (!inside(j)) continue;
          const k = key(Math.floor(x[3 * j] / D), Math.floor(x[3 * j + 1] / D), Math.floor(x[3 * j + 2] / D));
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(j);
        }
        if (!grid.size) continue;
        for (let i = compStart[p]; i < compStart[p + 1]; i++) {
          if (!inside(i)) continue;
          const cx = Math.floor(x[3 * i] / D), cy = Math.floor(x[3 * i + 1] / D), cz = Math.floor(x[3 * i + 2] / D);
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
            const l = grid.get(key(cx + a, cy + b, cz + c));
            if (!l) continue;
            for (const j of l) {
              const dx = x[3 * j] - x[3 * i], dy = x[3 * j + 1] - x[3 * i + 1], dz = x[3 * j + 2] - x[3 * i + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= D2 || d2 < 1e-12) continue;
              const d = Math.sqrt(d2), wp = invMass[i], wq = invMass[j];
              const push = Math.min(D - d, 0.006) / (d * (wp + wq));
              x[3 * i] -= dx * push * wp; x[3 * i + 1] -= dy * push * wp; x[3 * i + 2] -= dz * push * wp;
              x[3 * j] += dx * push * wq; x[3 * j + 1] += dy * push * wq; x[3 * j + 2] += dz * push * wq;
            }
          }
        }
      }
    }
  }

  // Best-fit rigid frame of piece c: world/rest centroids and a row-major rotation.
  pieceFrame(c) {
    const { x, rest, mass, compStart } = this;
    let M = 0;
    const cw = [0, 0, 0], cr = [0, 0, 0];
    for (let i = compStart[c]; i < compStart[c + 1]; i++) {
      const m = mass[i];
      M += m;
      for (let k = 0; k < 3; k++) { cw[k] += x[3 * i + k] * m; cr[k] += rest[3 * i + k] * m; }
    }
    for (let k = 0; k < 3; k++) { cw[k] /= M; cr[k] /= M; }
    const A = new Float64Array(9);
    for (let i = compStart[c]; i < compStart[c + 1]; i++) {
      const m = mass[i];
      const p = [x[3 * i] - cw[0], x[3 * i + 1] - cw[1], x[3 * i + 2] - cw[2]];
      const q = [rest[3 * i] - cr[0], rest[3 * i + 1] - cr[1], rest[3 * i + 2] - cr[2]];
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) A[3 * r + s] += m * p[r] * q[s];
    }
    const q = [0, 0, 0, 1], R = new Float64Array(9);
    extractRotation(A, q, 40, R);
    return { cw, cr, R: Array.from(R) };
  }

  // After installing a new world, start every tet rotation from its current pose.
  warmRotations(iters = 24) {
    const saveBase = this.shapeCompliance;
    this.shapeCompliance = () => Infinity; // f → 0: rotation extraction only, no position change
    for (let k = 0; k < Math.ceil(iters / 2); k++) this.solveTets(this.stepDt / this.substeps);
    this.shapeCompliance = saveBase;
  }

  // ---------------------------------------------------------------- blade

  solveBlade() {
    const b = this.blade, { x, n, comp } = this;
    const W = 0.12, H = KNIFE.H, xr = KNIFE.xr, Lb = KNIFE.Lb;
    const [px, py, pz] = b.p, [dx, , dz] = b.d, [nx, , nz] = b.n;
    for (let i = 0; i < n; i++) {
      const o = 3 * i;
      const rx = x[o] - px, rz = x[o + 2] - pz;
      const along = rx * dx + rz * dz;
      if (along < -xr || along > Lb - xr) continue;
      const h = x[o + 1] - py;
      if (h > 0.95 * H) continue;
      const s = rx * nx + rz * nz, az = Math.abs(s);
      if (b.mode === 'press') {
        if (az < W) {
          const hmax = 0.1 * (az / W) ** 2;
          if (h > hmax) x[o + 1] = py + hmax;
        }
      } else {
        if (az < W) {
          const lim = b.holdY + 0.1 * (az / W) ** 2;
          if (x[o + 1] > lim && h > -0.03) x[o + 1] = lim;
        }
        const side = b.side ? b.side[comp[i]] : 0;
        if (side && az < b.halfGap && h > -0.03) {
          const want = side * b.halfGap - s;
          if (want * side > 0) {
            const mv = side * Math.min(Math.abs(want), 0.003);
            x[o] += nx * mv;
            x[o + 2] += nz * mv;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- utilities

  reset(drop = 0.35) {
    const { x, prev, v, rest, n } = this;
    for (let i = 0; i < n; i++) {
      x[3 * i] = rest[3 * i]; x[3 * i + 1] = rest[3 * i + 1] + drop; x[3 * i + 2] = rest[3 * i + 2];
    }
    prev.set(x);
    v.fill(0);
    this.tetRot.fill(0);
    for (let t = 0; t < this.nT; t++) this.tetRot[4 * t + 3] = 1;
    this.endGrab();
  }

  nudge(s = 1) {
    const c = this.centroid(), { x, v, n } = this;
    const w = [2.4 * s, 1.2 * s, -1.5 * s];
    for (let i = 0; i < n; i++) {
      const rx = x[3 * i] - c[0], ry = x[3 * i + 1] - c[1], rz = x[3 * i + 2] - c[2];
      v[3 * i] += w[1] * rz - w[2] * ry;
      v[3 * i + 1] += 2.2 * s + (w[2] * rx - w[0] * rz);
      v[3 * i + 2] += w[0] * ry - w[1] * rx;
    }
  }

  centroid(c = -1) {
    const { x, mass } = this;
    const i0 = c < 0 ? 0 : this.compStart[c], i1 = c < 0 ? this.n : this.compStart[c + 1];
    let M = 0, cx = 0, cy = 0, cz = 0;
    for (let i = i0; i < i1; i++) {
      const m = mass[i];
      M += m; cx += x[3 * i] * m; cy += x[3 * i + 1] * m; cz += x[3 * i + 2] * m;
    }
    return [cx / M, cy / M, cz / M];
  }

  kineticEnergy() {
    const { v, mass, n } = this;
    let e = 0;
    for (let i = 0; i < n; i++) e += 0.5 * mass[i] * (v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2);
    return e;
  }

  volumeRatio() {
    let V = 0;
    for (let t = 0; t < this.nT; t++) V += this.tetVol(this.x, t);
    return V / this.totalRestVolume;
  }

  minVolumeRatio() {
    let m = Infinity;
    for (let t = 0; t < this.nT; t++) m = Math.min(m, this.tetVol(this.x, t) / this.restVol[t]);
    return m;
  }

  meanStrain() {
    const { x, rest, edges } = this;
    let s = 0;
    for (let e = 0; e < edges.length; e += 2) {
      const a = 3 * edges[e], b = 3 * edges[e + 1];
      const l = Math.sqrt((x[b] - x[a]) ** 2 + (x[b + 1] - x[a + 1]) ** 2 + (x[b + 2] - x[a + 2]) ** 2);
      const l0 = Math.sqrt((rest[b] - rest[a]) ** 2 + (rest[b + 1] - rest[a + 1]) ** 2 + (rest[b + 2] - rest[a + 2]) ** 2);
      s += Math.abs(l / l0 - 1);
    }
    return s / (edges.length / 2);
  }

  minY() {
    let m = Infinity;
    for (let i = 1; i < this.x.length; i += 3) m = Math.min(m, this.x[i]);
    return m;
  }
}
