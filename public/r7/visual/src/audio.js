// Fixed Web Audio graph with looping generated noise. No downloaded audio, no per-frame node creation.
export class Ambience {
  constructor() {
    this.context = null;
    this.enabled = false;
    this.mode = 0;
    this.snow = 0.35;
    this.inside = 0;
  }
  async toggle() {
    if (!this.context) this.create();
    this.enabled = !this.enabled;
    if (this.enabled) await this.context.resume();
    this.master.gain.setTargetAtTime(
      this.enabled ? 0.48 : 0,
      this.context.currentTime,
      0.3,
    );
    return this.enabled;
  }
  create() {
    const ac = (this.context = new AudioContext()),
      sr = ac.sampleRate;
    const buffer = ac.createBuffer(2, sr * 12, sr);
    for (let ch = 0; ch < 2; ch++) {
      const a = buffer.getChannelData(ch);
      let brown = 0;
      let seed = 9281 + ch * 77;
      for (let i = 0; i < a.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const white = (seed >>> 0) / 2147483648 - 1;
        brown = (brown + 0.025 * white) / 1.025;
        a[i] = brown * 4;
      }
      const cross = 4096;
      for (let i = 0; i < cross; i++) {
        const t = i / cross;
        a[i] = a[i] * t + a[a.length - cross + i] * (1 - t);
      }
    }
    const gain = (value, to) => {
      const g = ac.createGain();
      g.gain.value = value;
      g.connect(to);
      return g;
    };
    const filter = (type, f, q, to) => {
      const n = ac.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      n.connect(to);
      return n;
    };
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    limiter.connect(ac.destination);
    this.master = gain(0, limiter);
    this.wind = gain(0.35, this.master);
    this.fire = gain(0, this.master);
    this.windFilter = filter("bandpass", 320, 0.6, this.wind);
    const noise = (rate, to) => {
      const s = ac.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
      s.connect(to);
      s.start();
    };
    noise(0.8, this.windFilter);
    noise(1.17, filter("lowpass", 120, 0.6, gain(0.18, this.master)));
    noise(1.6, filter("highpass", 900, 0.8, this.fire));
    noise(0.65, filter("lowpass", 200, 0.7, this.fire));
    const oscillator = (freq, level, type, to) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.connect(gain(level, to));
      o.start();
      return o;
    };
    oscillator(0.11, 0.13, "sine", this.wind.gain);
    oscillator(0.067, 0.1, "sine", this.wind.gain);
    oscillator(41, 0.028, "sine", this.master);
    oscillator(61.65, 0.012, "sine", this.master);
    // Gentle low wood resonance under gusts; no jump-scare or discrete scripted audio event.
    oscillator(0.19, 15, "sine", this.windFilter.frequency);
    this.timer = setInterval(() => this.update(), 100);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) ac.suspend();
      else if (this.enabled) ac.resume();
    });
  }
  update() {
    if (!this.context) return;
    const t = this.context.currentTime,
      indoor = this.inside;
    this.wind.gain.setTargetAtTime(
      (0.22 + this.snow * 0.5) * (1 - indoor * 0.85),
      t,
      0.6,
    );
    this.windFilter.frequency.setTargetAtTime(
      240 + this.snow * 390 - indoor * 180,
      t,
      0.7,
    );
    this.fire.gain.setTargetAtTime(0.012 + indoor * 0.2, t, 0.7);
  }
}
