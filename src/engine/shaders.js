// WGSL modules: common, depth, scene (background + props), back, main (copy + jelly + lines), post.

export const WGSL_COMMON = /* wgsl */ `
struct U {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  lightVP: mat4x4f,
  topVP: mat4x4f,
  camPos: vec4f,      // xyz, w = time
  camFwd: vec4f,
  keyDir: vec4f,      // xyz toward light, w = intensity
  screen: vec4f,      // w, h, 1/w, 1/h
  flesh: vec4f,       // transmission tint
  fleshDeep: vec4f,   // scattering albedo
  pale: vec4f,
  skin: vec4f,
  stripe: vec4f,
  seed: vec4f,
  shape: vec4f,       // T, Ro, skinDepth, paleDepth
  misc: vec4f,        // exposure, meshAlpha, floorY, -
  bg: vec4f,          // backdrop (linear + 0.04)
  shadowTint: vec4f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var shadowTex: texture_depth_2d;
@group(0) @binding(2) var shadowSmp: sampler_comparison;
@group(0) @binding(3) var topTex: texture_depth_2d;
@group(0) @binding(4) var linSmp: sampler;

const PI = 3.14159265;

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = mix(hash3(i), hash3(i + vec3f(1, 0, 0)), s.x);
  let b = mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), s.x);
  let c = mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), s.x);
  let d = mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), s.x);
  return mix(mix(a, b, s.y), mix(c, d, s.y), s.z);
}

fn fbm(p: vec3f) -> f32 {
  return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.1) + 0.15 * vnoise(p * 4.01 + 31.7);
}

// A rounded-rectangle light seen along direction d.
fn softbox(d: vec3f, c: vec3f, up: vec3f, size: vec2f, blur: f32) -> f32 {
  let cn = normalize(c);
  let cd = dot(d, cn);
  if (cd <= 0.0) { return 0.0; }
  let right = normalize(cross(cn, up));
  let upv = cross(right, cn);
  let p = d / cd;
  let lp = vec2f(dot(p, right), dot(p, upv));
  let q = abs(lp) - size + vec2f(0.06);
  let dist = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.06;
  return 1.0 - smoothstep(-blur, blur, dist);
}

// A procedural photo studio.
fn studioEnv(d: vec3f, rough: f32, bg: vec3f) -> vec3f {
  let y = d.y;
  var col = bg * mix(0.62, 1.0, smoothstep(-0.5, 0.35, y));
  col += bg * 0.22 * exp(-abs(y - 0.02) * 9.0);                 // paper sweep near the horizon
  let blur = 0.012 + rough * 0.55;
  let k = mix(1.0, 0.35, clamp(rough * 1.6, 0.0, 1.0));        // blurrier → dimmer peak
  col += vec3f(3.2) * k * softbox(d, vec3f(0.05, 1.0, 0.18), vec3f(0, 0, 1), vec2f(0.62, 0.36), blur);
  col += vec3f(3.0, 2.95, 2.85) * k * softbox(d, vec3f(-0.72, 0.36, -0.6), vec3f(0, 1, 0), vec2f(0.55, 0.07), blur);
  col += vec3f(4.0, 3.95, 3.85) * k * softbox(d, vec3f(-1.0, 0.18, 0.28), vec3f(0, 1, 0), vec2f(0.06, 0.55), blur);
  col += vec3f(1.1, 1.2, 1.34) * k * softbox(d, vec3f(0.85, 0.22, 0.75), vec3f(0, 1, 0), vec2f(0.4, 0.3), blur * 1.5);
  return col;
}

fn ggx(N: vec3f, V: vec3f, L: vec3f, rough: f32) -> f32 {
  let H = normalize(V + L);
  let a = max(rough * rough, 0.002);
  let a2 = a * a;
  let NdH = max(dot(N, H), 0.0);
  let NdL = max(dot(N, L), 0.0);
  let NdV = max(dot(N, V), 1e-3);
  let dn = NdH * NdH * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dn * dn);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let G = (NdV / (NdV * (1.0 - k) + k)) * (NdL / (NdL * (1.0 - k) + k));
  return D * G / (4.0 * NdL * NdV + 1e-4) * NdL;
}

fn linearDepth(p: vec3f) -> f32 {
  return dot(p - u.camPos.xyz, u.camFwd.xyz);
}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) rest: vec3f,
  @location(3) mat: f32,
};

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) q: vec3f,
  @location(3) @interpolate(flat) mat: f32,
};

@vertex fn vsMesh(v: VIn) -> VOut {
  var o: VOut;
  o.clip = u.viewProj * vec4f(v.pos, 1.0);
  o.wp = v.pos;
  o.n = v.nrm;
  o.q = v.rest;
  o.mat = v.mat;
  return o;
}

struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FOut {
  var o: FOut;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;

// Depth-only (key shadow + height map). Its own tiny uniform: one matrix.
export const WGSL_DEPTH = /* wgsl */ `
@group(0) @binding(0) var<uniform> vp: mat4x4f;
@vertex fn vsDepth(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return vp * vec4f(pos, 1.0);
}
`;

export const WGSL_SCENE = WGSL_COMMON + /* wgsl */ `
const POISSON = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464), vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790)
);

// PCSS-lite: blocker search, then rotated Poisson PCF with a variable penumbra.
fn keyShadow(P: vec3f) -> f32 {
  let lc = u.lightVP * vec4f(P, 1.0);
  let ndc = lc.xyz / lc.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { return 1.0; }
  let z = ndc.z;
  let dims = vec2f(textureDimensions(shadowTex));
  let ang = hash3(P * 91.7) * 6.2831;
  let cs = cos(ang);
  let sn = sin(ang);
  var blk = 0.0;
  var cnt = 0.0;
  for (var i = 0; i < 16; i++) {
    let o = POISSON[i];
    let ro = vec2f(o.x * cs - o.y * sn, o.x * sn + o.y * cs) * 0.02;
    let tc = clamp(vec2i((uv + ro) * dims), vec2i(0), vec2i(dims) - 1);
    let d = textureLoad(shadowTex, tc, 0);
    if (d < z - 0.0015) { blk += d; cnt += 1.0; }
  }
  if (cnt < 0.5) { return 1.0; }
  blk /= cnt;
  let pen = clamp((z - blk) * 0.45, 0.003, 0.022);
  var s = 0.0;
  for (var i = 0; i < 16; i++) {
    let o = POISSON[i];
    let ro = vec2f(o.x * cs - o.y * sn, o.x * sn + o.y * cs) * pen;
    s += textureSampleCompareLevel(shadowTex, shadowSmp, uv + ro, z - 0.0015);
  }
  return s / 16.0;
}

// Contact occlusion from a height map rendered from under the floor, looking up.
fn contactAO(P: vec3f) -> f32 {
  let dims = vec2f(textureDimensions(topTex));
  var occ = 0.0;
  var tot = 0.0;
  let radii = array<f32, 3>(0.05, 0.12, 0.24);
  for (var r = 0; r < 3; r++) {
    for (var k = 0; k < 8; k++) {
      let a = f32(k) * 0.7853982 + f32(r) * 0.39;
      let S = P + vec3f(cos(a), 0.0, sin(a)) * radii[r];
      let c = u.topVP * vec4f(S, 1.0);
      let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { tot += 1.0; continue; }
      let tc = clamp(vec2i(uv * dims), vec2i(0), vec2i(dims) - 1);
      let h = textureLoad(topTex, tc, 0) * 5.0 - 1.0;   // underside height above this floor point
      let w = 1.0 / (1.0 + f32(r));
      occ += (1.0 - smoothstep(0.0, 0.1 + radii[r] * 1.4, h - u.misc.z)) * w;
      tot += w;
    }
  }
  return 1.0 - occ / max(tot, 1e-3);
}

@fragment fn fsBackground(in: FOut) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let a = u.invViewProj * vec4f(ndc, 0.0, 1.0);
  let b = u.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = normalize(b.xyz / b.w - ro);
  let bg = u.bg.rgb;
  var col = bg * (1.0 - 0.08 * smoothstep(0.0, 0.6, rd.y));
  var depth = 1.0e4;
  if (rd.y < 0.0) {
    let t = (u.misc.z - ro.y) / rd.y;
    let P = ro + rd * t;
    let sh = keyShadow(P);
    let ao = contactAO(P);
    let tint = mix(vec3f(1.0), u.shadowTint.rgb, 1.0 - sh);
    let fc = bg * tint * (1.0 - 0.72 * (1.0 - ao));
    col = mix(fc, col, smoothstep(7.0, 22.0, t));
    depth = linearDepth(P);
  }
  return vec4f(col, depth);
}

@fragment fn fsProps(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(in.n);
  if (!ff) { N = -N; }
  let V = normalize(u.camPos.xyz - in.wp);
  let L = u.keyDir.xyz;
  let I = u.keyDir.w;
  let bg = u.bg.rgb;
  let NdV = max(dot(N, V), 0.0);
  let NdL = dot(N, L);
  let R = reflect(-V, N);
  let q = in.q;
  var col = vec3f(0.0);

  if (in.mat < 1.5) {
    // seed: dark lacquer, warm brown rim, tiny env reflection (the jelly above is the gloss)
    let nz = fbm(q * 60.0);
    let base = u.seed.rgb * (0.7 + 0.6 * nz);
    let wrap = max((NdL + 0.4) / 1.4, 0.0);
    let rim = pow(1.0 - NdV, 3.0) * vec3f(0.09, 0.04, 0.015);
    col = base * (wrap * I * 0.9 + 0.5) + rim + studioEnv(R, 0.25, bg) * 0.06;
  } else if (in.mat < 2.5) {
    // bubble: a pale pocket with a darker rim and a pin-point highlight
    let pocket = mix(vec3f(0.85, 0.84, 0.8), u.flesh.rgb * 0.35 + vec3f(0.3), pow(1.0 - NdV, 1.5));
    col = pocket * (0.55 + 0.35 * max(NdL, 0.0)) + ggx(N, V, L, 0.05) * I * 0.6;
  } else if (in.mat < 4.5) {
    // knife steel, shaded like a product shot
    let bevel = in.mat < 3.2;
    let bolster = in.mat > 3.6;
    var rough = 0.12;
    if (bevel) { rough = 0.22; }
    if (bolster) { rough = 0.06; }
    let brushed = 0.88 + 0.12 * vnoise(vec3f(q.x * 5.0, q.y * 420.0, q.z * 30.0));
    let sweep = mix(0.1, 1.05, smoothstep(-0.35, 0.8, R.y)) * mix(0.8, 1.15, clamp(q.y / 0.63, 0.0, 1.0));
    let F0 = 0.56;
    let fres = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
    let env = studioEnv(R, rough, bg);
    var steel = vec3f(0.6, 0.61, 0.63) * sweep * brushed * 0.42 * fres;
    if (bevel) { steel *= 1.25; }
    steel += max(env - bg * 1.15, vec3f(0.0)) * fres * brushed;
    steel += vec3f(ggx(N, V, L, max(rough, 0.08)) * I * fres * 0.5);
    col = steel;
  } else {
    // walnut handle with oiled satin finish and three steel rivets
    let grain = fbm(vec3f(q.x * 3.0, q.y * 38.0 + fbm(q * 9.0) * 2.0, q.z * 38.0));
    var base = mix(vec3f(0.045, 0.02, 0.009), vec3f(0.15, 0.07, 0.028), grain);
    var rough = 0.35;
    var F0 = 0.04;
    let rx = array<f32, 3>(-0.24, -0.49, -0.74);
    for (var k = 0; k < 3; k++) {
      let p = -rx[k] / 0.84;
      let cy = 0.56 - 0.028 * p * p;
      if (length(vec2f(q.x - rx[k], q.y - cy)) < 0.022 && abs(q.z) > 0.02) {
        base = vec3f(0.35, 0.35, 0.36);
        rough = 0.12;
        F0 = 0.6;
      }
    }
    let wrap = max((NdL + 0.3) / 1.3, 0.0);
    let fres = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
    col = base * (wrap * I * 0.8 + 0.35) + studioEnv(R, rough, bg) * fres * 0.8 + vec3f(ggx(N, V, L, rough) * I * fres);
  }
  return vec4f(col, linearDepth(in.wp));
}
`;

// Farthest back face → linear depth (r32float).
export const WGSL_BACK = WGSL_COMMON + /* wgsl */ `
@fragment fn fsBack(in: VOut) -> @location(0) vec4f {
  return vec4f(linearDepth(in.wp), 0.0, 0.0, 1.0);
}
`;

export const WGSL_MAIN = WGSL_COMMON + /* wgsl */ `
@group(1) @binding(0) var sceneTex: texture_2d<f32>;
@group(1) @binding(1) var backTex: texture_2d<f32>;

@fragment fn fsCopy(in: FOut) -> @location(0) vec4f {
  return textureLoad(sceneTex, vec2i(in.pos.xy), 0);
}

@fragment fn fsJelly(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(in.n);
  if (!ff) { N = -N; }
  let V = normalize(u.camPos.xyz - in.wp);
  let L = u.keyDir.xyz;
  let I = u.keyDir.w;
  let bg = u.bg.rgb;
  let Q = in.q;

  // ---- material regions from the REST position (colours deform with the body)
  let r = length(Q.xz);
  let th = atan2(Q.x, Q.z);
  let wob = (fbm(Q * 7.0) - 0.5) * 0.036;
  let depth = u.shape.y - r + wob;
  let skinW = 1.0 - smoothstep(u.shape.z - 0.012, u.shape.z + 0.012, depth);
  let paleEdge = u.shape.w + (fbm(Q * 11.0 + 3.0) - 0.5) * 0.06;
  let paleW = (1.0 - smoothstep(paleEdge - 0.05, paleEdge + 0.05, depth)) * (1.0 - skinW);
  let fleshW = max(1.0 - skinW - paleW, 0.0);
  let stripe = smoothstep(0.05, 0.75, sin(th * 34.0 + (fbm(Q * vec3f(3.0, 6.0, 3.0)) - 0.5) * 6.0));
  let speck = step(0.93, hash3(floor(Q * 90.0))) * 0.5;
  let skinT = clamp(mix(u.skin.rgb, u.stripe.rgb, stripe * 0.9) * (1.0 - speck * 0.6), vec3f(0.002), vec3f(0.999));
  let nearPale = 1.0 - smoothstep(u.shape.w, u.shape.w + 0.35, depth);

  // ---- thickness along the view ray
  let pix = vec2i(in.clip.xy);
  let fz = linearDepth(in.wp);
  let bz = textureLoad(backTex, pix, 0).r;
  let sz = textureLoad(sceneTex, pix, 0).a;
  let cosv = max(dot(-V, u.camFwd.xyz), 0.35);
  let thick = clamp((min(bz, sz) - fz) / cosv, 0.0, 3.0);
  let thickBack = clamp((bz - fz) / cosv, 0.0, 3.0);

  // ---- absorption (Beer–Lambert, σ = −ln T) and scattering
  let dens = 1.0 + (fbm(vec3f(r * 14.0, th * 6.0, Q.y * 4.0)) - 0.5) * 0.6;
  let fleshT = clamp(u.flesh.rgb, vec3f(0.002), vec3f(0.999));
  let paleT = clamp(u.pale.rgb, vec3f(0.002), vec3f(0.999));
  let sigF = -log(fleshT) * 3.4 * dens;
  let sigP = -log(paleT) * 2.0 + vec3f(0.5);
  let sigS = -log(skinT) * 3.5 + vec3f(2.0);
  let sigma = sigF * fleshW + sigP * paleW + sigS * skinW;
  let scatK = 1.7 * fleshW + 4.5 * paleW + 26.0 * skinW;

  // ---- refraction: aim at where the refracted ray exits
  let Rr = refract(-V, N, 1.0 / 1.42);
  let exitP = in.wp + Rr * min(thickBack, 0.9) * 0.55;
  let ec = u.viewProj * vec4f(exitP, 1.0);
  let euv = vec2f(ec.x / ec.w * 0.5 + 0.5, 0.5 - ec.y / ec.w * 0.5);
  let suv = in.clip.xy * u.screen.zw;
  let ruv = mix(suv, euv, 0.85);

  // ---- 7-tap diffusion; each tap absorbed over its own path length
  let rad = min((0.0015 + 0.006 * min(thick, 1.0) * (0.35 + scatK * 0.06)), 0.022) * vec2f(u.screen.y * u.screen.z, 1.0);
  let rot = hash3(vec3f(in.clip.xy, 0.0)) * 6.2831;
  var transmitted = vec3f(0.0);
  for (var k = 0; k < 7; k++) {
    var o = vec2f(0.0);
    if (k > 0) {
      let a = f32(k) * 1.0471976 + rot;
      o = vec2f(cos(a), sin(a)) * rad;
    }
    let s = textureSampleLevel(sceneTex, linSmp, clamp(ruv + o, vec2f(0.0), vec2f(1.0)), 0.0);
    let pl = clamp(min(thickBack, max(s.a - fz, 0.0) / cosv + 0.03), 0.0, 3.0);
    transmitted += s.rgb * exp(-sigma * pl);
  }
  transmitted /= 7.0;

  let pathL = thick;
  let scat = 1.0 - exp(-scatK * pathL * 0.5 - scatK * 0.02);

  // ---- inner lighting
  let NdL = dot(N, L);
  let wrap = max((NdL + 0.6) / 1.6, 0.0);
  let hemi = mix(bg * 0.3, bg * 0.85, N.y * 0.5 + 0.5);
  let albedoF = mix(u.fleshDeep.rgb, u.flesh.rgb * 0.75, nearPale * 0.6);
  let albedo = albedoF * fleshW + u.pale.rgb * 0.9 * paleW + skinT * 0.7 * skinW;
  let inner = albedo * (wrap * I * vec3f(1.0, 0.97, 0.93) * 0.55 + hemi);

  // ---- back-lit glow at thin edges
  let bl = pow(max(dot(V, -L), 0.0), 3.0) * 1.4 + 0.25;
  let glowT = exp(-sigma * (pathL * 0.6 + 0.05));
  let tint = u.flesh.rgb * fleshW + u.pale.rgb * paleW + skinT * skinW;
  let glow = bl * glowT * tint * I * 0.22;

  var body = transmitted * (1.0 - scat) + inner * scat + glow;

  // ---- sugar sparkles in the flesh
  let R = reflect(-V, N);
  let cell = floor(Q * 70.0);
  if (hash3(cell) > 0.985) {
    body += vec3f(pow(max(dot(R, L), 0.0), 40.0) * fleshW * 1.5 * I);
  }

  // ---- surface: Fresnel studio reflections + GGX
  let NdV = max(dot(N, V), 0.0);
  let F0 = mix(0.034, 0.045, skinW);
  let fres = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);
  let env = studioEnv(R, 0.04, bg);
  let spec = ggx(N, V, L, 0.07) * I * 0.9;
  let col = body * (1.0 - fres) + env * fres + vec3f(spec) * fres * 4.0;
  return vec4f(col, 1.0);
}

struct LOut {
  @builtin(position) clip: vec4f,
  @location(0) dist: f32,
};

@vertex fn vsLine(@location(0) p: vec3f) -> LOut {
  var o: LOut;
  o.clip = u.viewProj * vec4f(p, 1.0);
  o.dist = length(p - u.camPos.xyz);
  return o;
}

@fragment fn fsLine(in: LOut) -> @location(0) vec4f {
  let a = u.misc.y * (1.0 - smoothstep(4.0, 12.0, in.dist));
  return vec4f(vec3f(0.11, 0.105, 0.1) * a, a);
}
`;

export const WGSL_POST = WGSL_COMMON + /* wgsl */ `
@group(1) @binding(0) var hdrTex: texture_2d<f32>;

// Khronos PBR Neutral
fn pbrNeutral(c: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(c.r, min(c.g, c.b));
  var offset = 0.04;
  if (x < 0.08) { offset = x - 6.25 * x * x; }
  var col = c - offset;
  let peak = max(col.r, max(col.g, col.b));
  if (peak < startCompression) { return col; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  col *= newPeak / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(col, vec3f(newPeak), g);
}

fn oetf(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment fn fsPost(in: FOut) -> @location(0) vec4f {
  let pix = vec2i(in.pos.xy);
  let hdr = textureLoad(hdrTex, pix, 0).rgb * u.misc.x;
  var c = oetf(clamp(pbrNeutral(max(hdr, vec3f(0.0))), vec3f(0.0), vec3f(1.0)));
  c += (hash3(vec3f(in.pos.xy, fract(u.camPos.w) * 61.0)) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;
