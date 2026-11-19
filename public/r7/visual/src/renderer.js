import { SOLID, SKY, PARTICLES, BLOOM, POST } from "./shaders.js";

const HDR = "rgba16float",
  DEPTH = "depth32float",
  AA = 4;
export class Renderer {
  static async create(canvas, world, onError) {
    if (!navigator.gpu)
      throw new Error(
        "当前浏览器未提供 WebGPU。请在支持 WebGPU 的 Edge / Chrome 中打开本地地址。",
      );
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter)
      throw new Error(
        "没有可用的 WebGPU 适配器。请检查浏览器硬件加速与显卡驱动。",
      );
    const timed = adapter.features.has("timestamp-query");
    const device = await adapter.requestDevice({
      requiredFeatures: timed ? ["timestamp-query"] : [],
    });
    const r = new Renderer(canvas, world, device, timed, onError);
    await r.init();
    return r;
  }
  constructor(canvas, world, device, timed, onError) {
    Object.assign(this, { canvas, world, device, timed, onError });
    this.ctx = canvas.getContext("webgpu");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.uniforms = new Float32Array(212);
    this.submit = [null];
    this.gpuMs = 0;
    this.drawCalls = 0;
    this.samples = 0;
    this.pixels = 1600 * 900;
    this.treeDetailDistance = 52;
    this.drawDistance = 240;
    this.scale = 1;
    this.width = 0;
    this.height = 0;
    this.targets = [];
    this.tuneTime = 0;
    this.gpuTotal = 0;
    this.gpuCount = 0;
    this.frames = 0;
    this.frameTotal = 0;
    this.frameLog = new Float32Array(18000);
    this.gpuLog = new Float32Array(18000);
    this.frameCount = 0;
    this.gpuCountAll = 0;
    device.addEventListener("uncapturederror", (e) => onError(e.error.message));
    device.lost.then((e) => onError("WebGPU 设备丢失：" + e.message));
  }
  buffer(data, usage) {
    const b = this.device.createBuffer({
      size: (data.byteLength + 3) & ~3,
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }
  texture(w, h, format, usage, samples = 1) {
    return this.device.createTexture({
      size: [w, h],
      format,
      usage,
      sampleCount: samples,
    });
  }
  async shader(code) {
    const m = this.device.createShaderModule({ code });
    const info = await m.getCompilationInfo();
    const errors = info.messages.filter((x) => x.type === "error");
    if (errors.length)
      throw new Error(
        errors
          .map((x) => `WGSL ${x.lineNum}:${x.linePos} ${x.message}`)
          .join("\n"),
      );
    return m;
  }
  async init() {
    const d = this.device,
      T = GPUTextureUsage,
      B = GPUBufferUsage,
      S = GPUShaderStage;
    this.uniformBuffer = d.createBuffer({
      size: this.uniforms.byteLength,
      usage: B.UNIFORM | B.COPY_DST,
    });
    this.shadowTexture = this.texture(
      2048,
      2048,
      DEPTH,
      T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
    );
    this.sampler = d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    const ground = this.world.groundMap;
    this.groundTexture = this.texture(
      ground.size,
      ground.size,
      "rgba8unorm",
      T.TEXTURE_BINDING | T.COPY_DST,
    );
    d.queue.writeTexture(
      { texture: this.groundTexture },
      ground.data,
      { bytesPerRow: ground.size * 4 },
      [ground.size, ground.size],
    );
    const shadowSampler = d.createSampler({
      compare: "less-equal",
      magFilter: "linear",
      minFilter: "linear",
    });
    this.globalLayout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} }],
    });
    this.solidLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: {} },
        {
          binding: 1,
          visibility: S.FRAGMENT,
          texture: { sampleType: "depth" },
        },
        { binding: 2, visibility: S.FRAGMENT, sampler: { type: "comparison" } },
        { binding: 3, visibility: S.FRAGMENT, texture: {} },
        { binding: 4, visibility: S.FRAGMENT, sampler: {} },
      ],
    });
    this.globals = d.createBindGroup({
      layout: this.globalLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.solids = d.createBindGroup({
      layout: this.solidLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.shadowTexture.createView() },
        { binding: 2, resource: shadowSampler },
        { binding: 3, resource: this.groundTexture.createView() },
        { binding: 4, resource: this.sampler },
      ],
    });
    const vertex = [
      {
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "snorm8x4" },
        ],
      },
      {
        arrayStride: 64,
        stepMode: "instance",
        attributes: [2, 3, 4, 5].map((n, i) => ({
          shaderLocation: n,
          offset: i * 16,
          format: "float32x4",
        })),
      },
    ];
    const [solid, sky, snow, bloom, post] = await Promise.all(
      [SOLID, SKY, PARTICLES, BLOOM, POST].map((s) => this.shader(s)),
    );
    const layout = (l) => d.createPipelineLayout({ bindGroupLayouts: [l] });
    this.pSolid = d.createRenderPipeline({
      layout: layout(this.solidLayout),
      vertex: { module: solid, entryPoint: "vs", buffers: vertex },
      fragment: { module: solid, entryPoint: "fs", targets: [{ format: HDR }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: true,
        depthCompare: "greater",
      },
      multisample: { count: AA, alphaToCoverageEnabled: true },
    });
    this.pShadow = d.createRenderPipeline({
      layout: layout(this.globalLayout),
      vertex: { module: solid, entryPoint: "vsShadow", buffers: vertex },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: true,
        depthCompare: "less",
        depthBias: 1,
        depthBiasSlopeScale: 1.4,
      },
    });
    this.pSky = d.createRenderPipeline({
      layout: layout(this.globalLayout),
      vertex: { module: sky, entryPoint: "vs" },
      fragment: { module: sky, entryPoint: "fs", targets: [{ format: HDR }] },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
      multisample: { count: AA },
    });
    this.pSnow = d.createRenderPipeline({
      layout: layout(this.globalLayout),
      vertex: {
        module: snow,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 16,
            stepMode: "instance",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
          },
        ],
      },
      fragment: {
        module: snow,
        entryPoint: "fs",
        targets: [
          {
            format: HDR,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: DEPTH,
        depthWriteEnabled: false,
        depthCompare: "greater",
      },
      multisample: { count: AA },
    });
    const bloomLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.FRAGMENT, texture: {} },
        { binding: 1, visibility: S.FRAGMENT, sampler: {} },
      ],
    });
    const bl = layout(bloomLayout);
    this.pDown = d.createRenderPipeline({
      layout: bl,
      vertex: { module: bloom, entryPoint: "vs" },
      fragment: {
        module: bloom,
        entryPoint: "down",
        targets: [{ format: HDR }],
      },
    });
    this.pBright = d.createRenderPipeline({
      layout: bl,
      vertex: { module: bloom, entryPoint: "vs" },
      fragment: {
        module: bloom,
        entryPoint: "bright",
        targets: [{ format: HDR }],
      },
    });
    this.pUp = d.createRenderPipeline({
      layout: bl,
      vertex: { module: bloom, entryPoint: "vs" },
      fragment: {
        module: bloom,
        entryPoint: "down",
        targets: [
          {
            format: HDR,
            blend: {
              color: { srcFactor: "one", dstFactor: "one" },
              alpha: { srcFactor: "one", dstFactor: "zero" },
            },
          },
        ],
      },
    });
    this.pPost = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: post, entryPoint: "vs" },
      fragment: {
        module: post,
        entryPoint: "fs",
        targets: [{ format: this.format }],
      },
    });
    this.meshes = new Map();
    for (const [id, m] of this.world.meshes)
      this.meshes.set(id, {
        v: this.buffer(new Uint8Array(m.vb), B.VERTEX),
        i: this.buffer(m.ib, B.INDEX),
        count: m.ib.length,
      });
    this.batches = this.world.batches.map((b) => ({
      ...b,
      buffer: this.buffer(b.data, B.VERTEX),
      geometry: this.meshes.get(b.mesh),
    }));
    const seeds = new Float32Array(10120 * 4);
    let seed = 91463;
    for (let i = 0; i < seeds.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      seeds[i] = (seed >>> 0) / 4294967296;
    }
    this.snowBuffer = this.buffer(seeds, B.VERTEX);
    if (this.timed) {
      this.queries = d.createQuerySet({ type: "timestamp", count: 2 });
      this.resolve = d.createBuffer({
        size: 16,
        usage: B.QUERY_RESOLVE | B.COPY_SRC,
      });
      this.slots = Array.from({ length: 4 }, () => {
        const buffer = d.createBuffer({
          size: 16,
          usage: B.MAP_READ | B.COPY_DST,
        });
        const slot = { buffer, busy: false, done: null };
        slot.done = () => {
          const a = new BigUint64Array(buffer.getMappedRange());
          const ms = Number(a[1] - a[0]) / 1e6;
          buffer.unmap();
          slot.busy = false;
          if (ms > 0 && ms < 1000) {
            this.gpuMs = ms;
            this.gpuTotal += ms;
            this.gpuCount++;
            if (this.gpuCountAll < this.gpuLog.length)
              this.gpuLog[this.gpuCountAll++] = ms;
          }
        };
        return slot;
      });
      this.beginTime = { querySet: this.queries, beginningOfPassWriteIndex: 0 };
      this.endTime = { querySet: this.queries, endOfPassWriteIndex: 1 };
    }
    this.resize();
  }
  resize() {
    const fullW = Math.max(
        2,
        Math.round(this.canvas.clientWidth * devicePixelRatio),
      ),
      fullH = Math.max(
        2,
        Math.round(this.canvas.clientHeight * devicePixelRatio),
      );
    this.scale = Math.min(1, Math.sqrt(this.pixels / (fullW * fullH)));
    const w = Math.max(2, Math.round(fullW * this.scale) & ~1),
      h = Math.max(2, Math.round(fullH * this.scale) & ~1);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });
    for (const t of this.targets) t.destroy();
    this.targets = [];
    const make = (w, h, format, usage, samples = 1) => {
      const t = this.texture(w, h, format, usage, samples);
      this.targets.push(t);
      return t.createView();
    };
    const T = GPUTextureUsage;
    const ms = make(w, h, HDR, T.RENDER_ATTACHMENT, AA),
      depth = make(w, h, DEPTH, T.RENDER_ATTACHMENT, AA),
      color = make(w, h, HDR, T.RENDER_ATTACHMENT | T.TEXTURE_BINDING);
    this.scenePass = {
      colorAttachments: [
        {
          view: ms,
          resolveTarget: color,
          loadOp: "clear",
          storeOp: "discard",
          clearValue: [0, 0, 0, 1],
        },
      ],
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    };
    const levels = [];
    for (let i = 0; i < 6; i++)
      levels.push(
        make(
          Math.max(1, w >> (i + 1)),
          Math.max(1, h >> (i + 1)),
          HDR,
          T.RENDER_ATTACHMENT | T.TEXTURE_BINDING,
        ),
      );
    const bind = (view) =>
      this.device.createBindGroup({
        layout: this.pDown.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: this.sampler },
        ],
      });
    const pass = (view, clear) => ({
      colorAttachments: [
        {
          view,
          loadOp: clear ? "clear" : "load",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    this.bloom = [];
    for (let i = 0; i < 6; i++)
      this.bloom.push({
        pass: pass(levels[i], true),
        bind: bind(i ? levels[i - 1] : color),
        pipeline: i ? this.pDown : this.pBright,
      });
    for (let i = 5; i > 0; i--)
      this.bloom.push({
        pass: pass(levels[i - 1], false),
        bind: bind(levels[i]),
        pipeline: this.pUp,
      });
    this.postBind = this.device.createBindGroup({
      layout: this.pPost.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: color },
        { binding: 2, resource: levels[0] },
        { binding: 3, resource: this.sampler },
      ],
    });
    this.postPass = {
      colorAttachments: [
        {
          view: null,
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    };
    this.tuneTime = -1;
    this.gpuTotal = 0;
    this.gpuCount = 0;
  }
  bakeShadow() {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms);
    const e = this.device.createCommandEncoder(),
      r = e.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowTexture.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
    r.setPipeline(this.pShadow);
    r.setBindGroup(0, this.globals);
    for (const b of this.batches) {
      if (b.mesh === "terrain" || Math.hypot(b.x, b.z) < 185) {
        const m = b.geometry;
        r.setVertexBuffer(0, m.v);
        r.setVertexBuffer(1, b.buffer);
        r.setIndexBuffer(m.i, "uint32");
        r.drawIndexed(m.count, b.n);
      }
    }
    r.end();
    this.device.queue.submit([e.finish()]);
  }
  frame(dt, camera, frameMs = dt * 1000) {
    this.frames++;
    this.frameTotal += frameMs / 1000;
    this.tuneTime += dt;
    if (this.frameCount < this.frameLog.length)
      this.frameLog[this.frameCount++] = frameMs;
    if (this.tuneTime > 1) {
      const gpu = this.gpuCount ? this.gpuTotal / this.gpuCount : 0,
        frame = (this.frameTotal / this.frames) * 1000;
      let k = 1;
      if (gpu > 13.6 || (gpu > 0 && gpu < 9.8)) k = 11.7 / gpu;
      else if (!gpu && frame > 20) k = 0.8;
      // Preserve readable geometry: if pixels reach the clarity floor, reduce distant detail instead.
      const clarityFloor = Math.min(
        960 * 720,
        this.canvas.clientWidth * this.canvas.clientHeight * 0.9,
      );
      if (k < 1 && this.pixels <= clarityFloor * 1.03) {
        this.treeDetailDistance = Math.max(25, this.treeDetailDistance * 0.88);
        if (this.uniforms[69] > 0.6)
          this.drawDistance = Math.max(155, this.drawDistance * 0.94);
      } else if (k > 1) {
        this.treeDetailDistance = Math.min(52, this.treeDetailDistance + 2);
        this.drawDistance = Math.min(240, this.drawDistance + 5);
      }
      this.pixels = Math.max(
        clarityFloor,
        Math.min(2560 * 1440, this.pixels * Math.max(0.75, Math.min(1.2, k))),
      );
      this.gpuTotal =
        this.gpuCount =
        this.frames =
        this.frameTotal =
        this.tuneTime =
          0;
      this.resize();
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms);
    const e = this.device.createCommandEncoder();
    let slot = null;
    if (this.timed)
      for (const s of this.slots)
        if (!s.busy) {
          slot = s;
          break;
        }
    this.scenePass.timestampWrites = slot ? this.beginTime : undefined;
    this.postPass.timestampWrites = slot ? this.endTime : undefined;
    let r = e.beginRenderPass(this.scenePass);
    r.setPipeline(this.pSky);
    r.setBindGroup(0, this.globals);
    r.draw(3);
    r.setPipeline(this.pSolid);
    r.setBindGroup(0, this.solids);
    this.drawCalls = 0;
    const u = this.uniforms,
      asp = this.width / this.height;
    for (const b of this.batches) {
      const dx = b.x - camera.x,
        dz = b.z - camera.z,
        dist = Math.hypot(dx, dz),
        f = dx * u[44] + dz * u[46];
      if (
        b.mesh !== "terrain" &&
        (dist - b.radius > this.drawDistance ||
          f < -b.radius ||
          Math.abs(dx * u[36] + dz * u[38]) >
            Math.max(f, 0) * asp * 0.65 + b.radius)
      )
        continue;
      const m =
        dist > this.treeDetailDistance &&
        (b.mesh === "pine" || b.mesh === "pineSnow")
          ? this.meshes.get(b.mesh + "Far")
          : b.geometry;
      r.setVertexBuffer(0, m.v);
      r.setVertexBuffer(1, b.buffer);
      r.setIndexBuffer(m.i, "uint32");
      r.drawIndexed(m.count, b.n);
      this.drawCalls++;
    }
    r.setPipeline(this.pSnow);
    r.setBindGroup(0, this.globals);
    r.setVertexBuffer(0, this.snowBuffer);
    r.draw(4, 10120);
    r.end();
    for (const b of this.bloom) {
      r = e.beginRenderPass(b.pass);
      r.setPipeline(b.pipeline);
      r.setBindGroup(0, b.bind);
      r.draw(3);
      r.end();
    }
    this.postPass.colorAttachments[0].view = this.ctx
      .getCurrentTexture()
      .createView();
    r = e.beginRenderPass(this.postPass);
    r.setPipeline(this.pPost);
    r.setBindGroup(0, this.postBind);
    r.draw(3);
    r.end();
    if (slot) {
      e.resolveQuerySet(this.queries, 0, 2, this.resolve, 0);
      e.copyBufferToBuffer(this.resolve, 0, slot.buffer, 0, 16);
    }
    this.submit[0] = e.finish();
    this.device.queue.submit(this.submit);
    if (slot) {
      slot.busy = true;
      slot.buffer
        .mapAsync(GPUMapMode.READ)
        .then(slot.done)
        .catch(() => {
          slot.busy = false;
        });
    }
  }
  stats() {
    const summary = (a, n) => {
      const v = Array.from(a.subarray(0, n)).sort((a, b) => a - b);
      return n
        ? {
            n,
            mean: v.reduce((a, b) => a + b, 0) / n,
            p99: v[Math.min(n - 1, Math.floor(n * 0.99))],
            max: v[n - 1],
          }
        : null;
    };
    return {
      width: this.width,
      height: this.height,
      gpuTimestamp: this.timed,
      gpuMs: this.gpuMs,
      drawCalls: this.drawCalls,
      frames: summary(this.frameLog, this.frameCount),
      gpu: summary(this.gpuLog, this.gpuCountAll),
    };
  }
}
