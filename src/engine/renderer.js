// WebGPU device, pipelines, textures and the six passes:
//   1 key shadow → 2 height map → 3 scene (alpha = linear depth) → 4 back-face depth
//   → 5 jelly (copy scene, jelly front faces, optional mesh lines) → 6 post (tone map)

import { WGSL_DEPTH, WGSL_SCENE, WGSL_BACK, WGSL_MAIN, WGSL_POST } from './shaders.js';

export const UNIFORM_FLOATS = 136; // 544 bytes
const MS = 4;
const HDR = 'rgba16float';
const DEPTH_MS = 'depth24plus';

const MESH_BUFFERS = [
  { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }, { shaderLocation: 3, offset: 12, format: 'float32' }] },
];
const DEPTH_BUFFERS = [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }];

export class Renderer {
  static async create(canvas, mesh, simEdges, nParticles) {
    if (!navigator.gpu) throw new Error('no-webgpu');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no-adapter');
    const device = await adapter.requestDevice();
    const r = new Renderer(canvas, device, mesh, simEdges, nParticles);
    Renderer.keep = { adapter, gpu: navigator.gpu }; // strong refs (avoids GC-related loss)
    await r.checkShaders();
    return r;
  }

  constructor(canvas, device, mesh, simEdges, nParticles) {
    this.canvas = canvas;
    this.device = device;
    this.lost = false;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({
      device,
      format: this.format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    device.lost.then((info) => {
      this.lost = true;
      this.onLost?.(info);
    });
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', e.error?.message || e.error));

    const mod = (code, label) => device.createShaderModule({ code, label });
    this.modules = {
      depth: mod(WGSL_DEPTH, 'depth'),
      scene: mod(WGSL_SCENE, 'scene'),
      back: mod(WGSL_BACK, 'back'),
      main: mod(WGSL_MAIN, 'main'),
      post: mod(WGSL_POST, 'post'),
    };

    // ---- buffers
    this.uniformData = new Float32Array(UNIFORM_FLOATS);
    this.ubo = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uLight = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uTop = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // ---- fixed-size textures
    this.shadowTex = device.createTexture({ size: [1024, 1024], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.topTex = device.createTexture({ size: [512, 512], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowView = this.shadowTex.createView();
    this.topView = this.topTex.createView();

    this.cmpSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.linSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // ---- layouts
    const F = GPUShaderStage.FRAGMENT, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.L0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: F, sampler: { type: 'comparison' } },
        { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: F, sampler: { type: 'filtering' } },
      ],
    });
    this.LJ = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.LT = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
    this.LD = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    const pl = (...l) => device.createPipelineLayout({ bindGroupLayouts: l });
    const P0 = pl(this.L0), PJ = pl(this.L0, this.LJ), PT = pl(this.L0, this.LT), PD = pl(this.LD);

    this.g0 = device.createBindGroup({
      layout: this.L0,
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.cmpSampler },
        { binding: 3, resource: this.topView },
        { binding: 4, resource: this.linSampler },
      ],
    });
    this.gLight = device.createBindGroup({ layout: this.LD, entries: [{ binding: 0, resource: { buffer: this.uLight } }] });
    this.gTop = device.createBindGroup({ layout: this.LD, entries: [{ binding: 0, resource: { buffer: this.uTop } }] });

    // ---- pipelines
    const M = this.modules;
    this.pDepth = device.createRenderPipeline({
      label: 'depth',
      layout: PD,
      vertex: { module: M.depth, entryPoint: 'vsDepth', buffers: DEPTH_BUFFERS },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    const msScene = { count: MS };
    const hdrTarget = [{ format: HDR }];
    this.pBackground = device.createRenderPipeline({
      label: 'background',
      layout: P0,
      vertex: { module: M.scene, entryPoint: 'vsFull' },
      fragment: { module: M.scene, entryPoint: 'fsBackground', targets: hdrTarget },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_MS, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: msScene,
    });
    this.pProps = device.createRenderPipeline({
      label: 'props',
      layout: P0,
      vertex: { module: M.scene, entryPoint: 'vsMesh', buffers: MESH_BUFFERS },
      fragment: { module: M.scene, entryPoint: 'fsProps', targets: hdrTarget },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_MS, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: msScene,
    });
    this.pBack = device.createRenderPipeline({
      label: 'back',
      layout: P0,
      vertex: { module: M.back, entryPoint: 'vsMesh', buffers: MESH_BUFFERS },
      fragment: { module: M.back, entryPoint: 'fsBack', targets: [{ format: 'r32float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'front', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    this.pCopy = device.createRenderPipeline({
      label: 'copy',
      layout: PJ,
      vertex: { module: M.main, entryPoint: 'vsFull' },
      fragment: { module: M.main, entryPoint: 'fsCopy', targets: hdrTarget },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_MS, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: msScene,
    });
    this.pJelly = device.createRenderPipeline({
      label: 'jelly',
      layout: PJ,
      vertex: { module: M.main, entryPoint: 'vsMesh', buffers: MESH_BUFFERS },
      fragment: { module: M.main, entryPoint: 'fsJelly', targets: hdrTarget },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_MS, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: msScene,
    });
    this.pLines = device.createRenderPipeline({
      label: 'lines',
      layout: PJ,
      vertex: { module: M.main, entryPoint: 'vsLine', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: {
        module: M.main,
        entryPoint: 'fsLine',
        targets: [{
          format: HDR,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
      depthStencil: { format: DEPTH_MS, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: msScene,
    });
    this.pPost = device.createRenderPipeline({
      label: 'post',
      layout: PT,
      vertex: { module: M.post, entryPoint: 'vsFull' },
      fragment: { module: M.post, entryPoint: 'fsPost', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.size = [0, 0];
    this.knife = null;
    this.setMesh(mesh, simEdges, nParticles);
  }

  async checkShaders() {
    const problems = [];
    for (const [name, m] of Object.entries(this.modules)) {
      const info = await m.getCompilationInfo();
      for (const msg of info.messages) {
        if (msg.type === 'error') problems.push(`${name}:${msg.lineNum}:${msg.linePos} ${msg.message}`);
      }
    }
    if (problems.length) throw new Error('WGSL compile error\n' + problems.join('\n'));
  }

  // ---- geometry

  // Destroys and recreates every mesh-sized buffer. Only at start and after a cut.
  setMesh(mesh, simEdges, nParticles) {
    const d = this.device;
    for (const b of [this.dynBuf, this.staticBuf, this.indexBuf, this.partBuf, this.edgeBuf]) b?.destroy();
    this.mesh = mesh;
    this.dyn = new Float32Array(6 * mesh.nV);
    this.dynBuf = d.createBuffer({ size: this.dyn.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.staticBuf = d.createBuffer({ size: mesh.statics.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.staticBuf, 0, mesh.statics);
    this.indexBuf = d.createBuffer({ size: align4(mesh.index.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.indexBuf, 0, mesh.index);
    this.partBuf = d.createBuffer({ size: Math.max(16, nParticles * 12), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.edgeCount = simEdges.length;
    this.edgeBuf = d.createBuffer({ size: Math.max(16, align4(simEdges.byteLength)), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.edgeBuf, 0, simEdges);
  }

  setKnife(knifeMesh) {
    const d = this.device;
    this.knifeDyn = new Float32Array(6 * knifeMesh.nV);
    this.knife = {
      count: knifeMesh.index.length,
      dynBuf: d.createBuffer({ size: this.knifeDyn.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
      staticBuf: d.createBuffer({ size: knifeMesh.statics.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
      indexBuf: d.createBuffer({ size: align4(knifeMesh.index.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }),
    };
    d.queue.writeBuffer(this.knife.staticBuf, 0, knifeMesh.statics);
    d.queue.writeBuffer(this.knife.indexBuf, 0, knifeMesh.index);
  }

  // ---- size-dependent textures

  resize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.size[0] && h === this.size[1]) return false;
    this.size = [w, h];
    this.canvas.width = w;
    this.canvas.height = h;
    const d = this.device;
    for (const t of [this.msScene, this.sceneTex, this.msDepth, this.backTex, this.backDepth, this.msHdr, this.hdrTex]) t?.destroy();
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.msScene = d.createTexture({ size: [w, h], format: HDR, sampleCount: MS, usage: RA });
    this.sceneTex = d.createTexture({ size: [w, h], format: HDR, usage: RA | TB });
    this.msDepth = d.createTexture({ size: [w, h], format: DEPTH_MS, sampleCount: MS, usage: RA });
    this.backTex = d.createTexture({ size: [w, h], format: 'r32float', usage: RA | TB });
    this.backDepth = d.createTexture({ size: [w, h], format: 'depth32float', usage: RA });
    this.msHdr = d.createTexture({ size: [w, h], format: HDR, sampleCount: MS, usage: RA });
    this.hdrTex = d.createTexture({ size: [w, h], format: HDR, usage: RA | TB });
    this.views = {
      msScene: this.msScene.createView(),
      sceneTex: this.sceneTex.createView(),
      msDepth: this.msDepth.createView(),
      backTex: this.backTex.createView(),
      backDepth: this.backDepth.createView(),
      msHdr: this.msHdr.createView(),
      hdrTex: this.hdrTex.createView(),
    };
    this.gJ = d.createBindGroup({ layout: this.LJ, entries: [{ binding: 0, resource: this.views.sceneTex }, { binding: 1, resource: this.views.backTex }] });
    this.gPost = d.createBindGroup({ layout: this.LT, entries: [{ binding: 0, resource: this.views.hdrTex }] });
    return true;
  }

  // ---- per frame

  setUniforms(data, lightVP, topVP) {
    const q = this.device.queue;
    q.writeBuffer(this.ubo, 0, data);
    q.writeBuffer(this.uLight, 0, lightVP);
    q.writeBuffer(this.uTop, 0, topVP);
  }

  uploadGeometry({ particles, knife } = {}) {
    const q = this.device.queue;
    q.writeBuffer(this.dynBuf, 0, this.dyn);
    if (particles) q.writeBuffer(this.partBuf, 0, particles);
    if (knife && this.knife) q.writeBuffer(this.knife.dynBuf, 0, this.knifeDyn);
  }

  draw({ showMesh = false, knifeVisible = false } = {}) {
    if (this.lost || !this.size[0]) return;
    const d = this.device, enc = d.createCommandEncoder(), R = this.mesh.ranges, V = this.views;
    const bodySeeds = R.body.count + R.seeds.count;

    const bindMesh = (pass) => {
      pass.setVertexBuffer(0, this.dynBuf);
      pass.setVertexBuffer(1, this.staticBuf);
      pass.setIndexBuffer(this.indexBuf, 'uint32');
    };
    const bindKnife = (pass) => {
      pass.setVertexBuffer(0, this.knife.dynBuf);
      pass.setVertexBuffer(1, this.knife.staticBuf);
      pass.setIndexBuffer(this.knife.indexBuf, 'uint32');
    };
    const depthOnly = (view) => ({ view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' });

    // 1 key shadow (body + seeds + knife)
    let p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: depthOnly(this.shadowView) });
    p.setPipeline(this.pDepth);
    p.setBindGroup(0, this.gLight);
    bindMesh(p);
    p.drawIndexed(bodySeeds, 1, 0);
    if (knifeVisible && this.knife) { bindKnife(p); p.drawIndexed(this.knife.count); }
    p.end();

    // 2 height map (body + seeds, NOT the knife)
    p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: depthOnly(this.topView) });
    p.setPipeline(this.pDepth);
    p.setBindGroup(0, this.gTop);
    bindMesh(p);
    p.drawIndexed(bodySeeds, 1, 0);
    p.end();

    // 3 scene: floor/background, seeds, bubbles, knife. Alpha = linear depth.
    p = enc.beginRenderPass({
      colorAttachments: [{ view: V.msScene, resolveTarget: V.sceneTex, clearValue: [0, 0, 0, 1e4], loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: V.msDepth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    p.setBindGroup(0, this.g0);
    p.setPipeline(this.pBackground);
    p.draw(3);
    p.setPipeline(this.pProps);
    bindMesh(p);
    if (R.seeds.count + R.bubbles.count) p.drawIndexed(R.seeds.count + R.bubbles.count, 1, R.seeds.first);
    if (knifeVisible && this.knife) { bindKnife(p); p.drawIndexed(this.knife.count); }
    p.end();

    // 4 back faces: farthest back-face linear depth
    p = enc.beginRenderPass({
      colorAttachments: [{ view: V.backTex, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: V.backDepth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p.setPipeline(this.pBack);
    p.setBindGroup(0, this.g0);
    bindMesh(p);
    p.drawIndexed(R.body.count, 1, 0);
    p.end();

    // 5 jelly: copy scene, then jelly front faces depth-tested against seeds/knife, then lines
    p = enc.beginRenderPass({
      colorAttachments: [{ view: V.msHdr, resolveTarget: V.hdrTex, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: V.msDepth, depthLoadOp: 'load', depthStoreOp: 'discard' },
    });
    p.setBindGroup(0, this.g0);
    p.setBindGroup(1, this.gJ);
    p.setPipeline(this.pCopy);
    p.draw(3);
    p.setPipeline(this.pJelly);
    bindMesh(p);
    p.drawIndexed(R.body.count, 1, 0);
    if (showMesh && this.edgeCount) {
      p.setPipeline(this.pLines);
      p.setVertexBuffer(0, this.partBuf);
      p.setIndexBuffer(this.edgeBuf, 'uint32');
      p.drawIndexed(this.edgeCount);
    }
    p.end();

    // 6 post → swap chain
    const out = this.ctx.getCurrentTexture();
    p = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
    p.setPipeline(this.pPost);
    p.setBindGroup(0, this.g0);
    p.setBindGroup(1, this.gPost);
    p.draw(3);
    p.end();

    let readback = null;
    if (this._capture) {
      const [w, h] = this.size, bpr = Math.ceil((w * 4) / 256) * 256;
      readback = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: out }, { buffer: readback, bytesPerRow: bpr }, [w, h]);
      const resolve = this._capture;
      this._capture = null;
      d.queue.submit([enc.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const src = new Uint8Array(readback.getMappedRange()), px = new Uint8ClampedArray(w * h * 4);
        const bgra = this.format.startsWith('bgra');
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const s = y * bpr + x * 4, t = (y * w + x) * 4;
            px[t] = src[s + (bgra ? 2 : 0)];
            px[t + 1] = src[s + 1];
            px[t + 2] = src[s + (bgra ? 0 : 2)];
            px[t + 3] = 255;
          }
        }
        readback.unmap();
        readback.destroy();
        resolve({ width: w, height: h, data: px });
      });
      return;
    }
    d.queue.submit([enc.finish()]);
  }

  // Pixels of the next rendered frame (RGBA), for screenshot checks.
  capture() {
    return new Promise((resolve) => { this._capture = resolve; });
  }

  destroy() {
    this.lost = true;
    this.onLost = null;
    try { this.device.destroy(); } catch { /* already gone */ }
  }
}

const align4 = (n) => Math.ceil(n / 4) * 4;
