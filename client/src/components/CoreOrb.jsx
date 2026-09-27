import { useEffect, useRef } from 'react';
import { useStore, store } from '../store';
import { speech } from '../lib/speech';
import { interrupt } from '../lib/actions';

const LABEL = { idle: 'STANDBY', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', muted: 'MIC OFF' };

function orbState(s) {
  if (s.voice.speaking) return 'speaking';
  if (s.brain !== 'idle') return 'thinking';
  if (s.voice.listening) return 'listening';
  if (!s.voice.micOn) return 'muted';
  return 'idle';
}

// Chitti's "eye": concentric rotating rings + a radial waveform driven by the
// live mic level (listening) or synthesized speech envelope (speaking).
export default function CoreOrb() {
  const ref = useRef(null);
  const state = useStore(orbState);

  useEffect(() => {
    const c = ref.current;
    const g = c.getContext('2d');
    let raf;
    let smooth = 0;
    const hist = new Array(64).fill(0);

    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const S = c.clientWidth;
      if (c.width !== S * dpr) { c.width = c.height = S * dpr; }
      g.setTransform(dpr, 0, 0, dpr, S / 2 * dpr, S / 2 * dpr);
      g.clearRect(-S / 2, -S / 2, S, S);

      const st = orbState(store());
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue('--accent').trim() || '#3ee8ff';
      const alt = css.getPropertyValue('--accent-2').trim() || '#ff8a3d';
      const color = st === 'thinking' ? alt : st === 'speaking' ? '#ffffff' : accent;

      const lvl = speech.level();
      smooth += (lvl - smooth) * 0.25;
      hist.push(smooth);
      hist.shift();

      const R = S * 0.3;
      const t = now / 1000;
      g.lineCap = 'round';

      // outer segmented ring
      g.strokeStyle = accent;
      g.globalAlpha = 0.55;
      g.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const a = t * 0.6 + (i * Math.PI) / 3;
        g.beginPath();
        g.arc(0, 0, R * 1.52, a, a + 0.7);
        g.stroke();
      }
      // counter ring with ticks
      g.globalAlpha = 0.35;
      g.lineWidth = 1;
      for (let i = 0; i < 48; i++) {
        const a = -t * 0.35 + (i / 48) * Math.PI * 2;
        const r1 = R * 1.28;
        const r2 = R * (i % 4 === 0 ? 1.38 : 1.33);
        g.beginPath();
        g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        g.stroke();
      }

      // thinking arc
      if (st === 'thinking') {
        g.globalAlpha = 0.95;
        g.strokeStyle = alt;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(0, 0, R * 1.15, t * 5, t * 5 + 1.6);
        g.stroke();
        g.beginPath();
        g.arc(0, 0, R * 1.15, t * 5 + Math.PI, t * 5 + Math.PI + 1.6);
        g.stroke();
      }

      // radial waveform
      g.globalAlpha = 0.9;
      g.strokeStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 16;
      g.lineWidth = 2;
      g.beginPath();
      const N = 96;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const h = hist[(i * 7) % hist.length];
        const wob = st === 'idle' || st === 'muted' ? Math.sin(a * 3 + t * 2) * 1.2 : Math.sin(a * 6 + t * 8) * h * R * 0.35 + h * R * 0.25;
        const r = R + wob;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();

      // core
      g.shadowBlur = 30;
      const pulse = 0.55 + smooth * 0.6 + (st === 'idle' ? Math.sin(t * 2) * 0.05 : 0);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.8);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, color);
      grad.addColorStop(1, 'transparent');
      g.globalAlpha = Math.min(1, pulse);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, R * 0.8, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onClick = () => {
    const s = store();
    if (s.voice.speaking || s.brain !== 'idle') return interrupt();
    speech.listen(!s.voice.micOn);
  };

  return (
    <button className={`orb orb-${state}`} onClick={onClick} title={state === 'speaking' || state === 'thinking' ? 'Click to interrupt (Esc)' : 'Click to toggle microphone'}>
      <canvas ref={ref} />
      <span className="orb-label">{LABEL[state]}</span>
    </button>
  );
}
