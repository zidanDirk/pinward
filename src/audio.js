export class ArcadeAudio {
  constructor(muted = false) {
    this.muted = muted;
    this.context = null;
    this.last = 0;
    this.beat = 0;
    this.themeTime = 0;
  }
  unlock() {
    try {
      this.context ??= new (window.AudioContext || window.webkitAudioContext)();
      if (this.context.state === "suspended")
        this.context.resume().catch(() => {});
    } catch {
      /* The game remains fully playable without audio. */
    }
  }
  tone(frequency, duration, type = "sine", gain = 0.06, end = frequency / 2) {
    if (this.muted || !this.context || this.context.state !== "running") return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator(),
      volume = this.context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, end),
      now + duration,
    );
    volume.gain.setValueAtTime(0, now);
    volume.gain.linearRampToValueAtTime(gain, now + 0.005);
    volume.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(volume);
    volume.connect(this.context.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      volume.disconnect();
    };
  }
  event(event) {
    if (!this.context || this.muted) return;
    const now = this.context.currentTime;
    if (
      ["hit", "bounce", "kill"].includes(event.type) &&
      now - this.last < 0.08
    )
      return;
    this.last = now;
    if (event.type === "bounce") {
      const sounds = {
        standard: [180, 0.1, "sine"],
        wide: [140, 0.13, "sine"],
        electric: [850, 0.13, "sawtooth"],
        frost: [1500, 0.2, "triangle"],
        heavy: [90, 0.2, "square"],
        split: [640, 0.13, "triangle"],
      };
      this.tone(...sounds[event.power], 0.035);
    } else if (event.type === "hit")
      this.tone(
        420 + (this.beat++ % 6) * 90,
        0.13,
        event.power === "heavy" ? "square" : "triangle",
        0.035,
        900,
      );
    else if (event.type === "launch")
      this.tone(100, 0.18, "triangle", 0.05, 600);
    else if (event.type === "leak") this.tone(130, 0.35, "sawtooth", 0.05, 35);
    else if (["place", "rotate", "card"].includes(event.type))
      this.tone(540, 0.1, "sine", 0.05, 720);
    else if (event.type === "bossStage")
      this.tone(75, 0.7, "sawtooth", 0.05, 150);
    else if (event.type === "over")
      this.tone(
        event.won ? 880 : 180,
        0.8,
        "triangle",
        0.08,
        event.won ? 1320 : 45,
      );
  }
  update(dt, stage) {
    if (stage == null) {
      this.themeTime = 0;
      return;
    }
    this.themeTime -= dt;
    if (this.themeTime > 0) return;
    this.themeTime = [0.42, 0.32, 0.24][stage];
    const notes = [
      [110, 165, 130.81, 146.83],
      [130.81, 196, 155.56, 174.61],
      [146.83, 220, 174.61, 261.63],
    ][stage];
    this.tone(notes[this.beat++ % 4], 0.16, "triangle", 0.018);
  }
}
