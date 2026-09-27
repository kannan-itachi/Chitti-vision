// Tiny synthesized HUD sound effects — no audio files needed.
let ctx = null;
let enabled = true;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { dur = 0.08, type = 'sine', gain = 0.035, at = 0, to = null } = {}) {
  if (!enabled) return;
  try {
    const c = ac();
    const t = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    /* audio unavailable */
  }
}

export const sfx = {
  setEnabled: (v) => (enabled = v),
  click: () => tone(1400, { dur: 0.03, type: 'square', gain: 0.015 }),
  blip: () => { tone(880, { dur: 0.06 }); tone(1320, { dur: 0.08, at: 0.07 }); },
  lock: () => { tone(600, { dur: 0.05, type: 'square', gain: 0.02 }); tone(600, { dur: 0.05, type: 'square', gain: 0.02, at: 0.09 }); tone(1200, { dur: 0.18, type: 'square', gain: 0.02, at: 0.18 }); },
  alert: () => { tone(420, { dur: 0.18, type: 'sawtooth', gain: 0.03 }); tone(420, { dur: 0.18, type: 'sawtooth', gain: 0.03, at: 0.25 }); },
  done: () => { tone(660, { dur: 0.07 }); tone(990, { dur: 0.07, at: 0.08 }); tone(1320, { dur: 0.12, at: 0.16 }); },
  think: () => tone(300, { dur: 0.25, to: 900, gain: 0.02 }),
  boot: () => {
    tone(110, { dur: 1.2, type: 'sawtooth', gain: 0.02, to: 440 });
    [523, 659, 784, 1046].forEach((f, i) => tone(f, { dur: 0.12, at: 0.9 + i * 0.12, gain: 0.03 }));
  },
  online: () => { tone(392, { dur: 0.1 }); tone(784, { dur: 0.25, at: 0.1, gain: 0.04 }); },
};
