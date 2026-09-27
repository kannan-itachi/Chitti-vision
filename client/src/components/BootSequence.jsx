import { useEffect, useState } from 'react';
import { useStore, store } from '../store';
import { speech } from '../lib/speech';
import { sfx } from '../lib/sfx';
import { startVision } from '../lib/actions';
import * as api from '../lib/api';

const pad = (label) => label.padEnd(28, '.');

export default function BootSequence() {
  const phase = useStore((s) => s.phase);
  const [lines, setLines] = useState([]);
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);

  const boot = async () => {
    if (store().phase !== 'standby') return;
    store().set({ phase: 'booting' });
    sfx.boot();
    speech.prime(); // unlock speech synthesis inside the user gesture

    const [health, models] = await Promise.all([
      api.getHealth().catch(() => null),
      fetch('/models/ssd_mobilenet_v2/model.json', { method: 'HEAD' }).then((r) => r.ok && /json/.test(r.headers.get('content-type') || '')).catch(() => false),
    ]);
    const sup = speech.supported;
    const steps = [
      [pad('NEURO-CORE v3.0'), 'OK'],
      [pad('PROCESSOR SPEED'), '1 THz'],
      [pad('MEMORY'), '1 ZETTABYTE'],
      [pad('OPTICAL SENSORS'), navigator.mediaDevices ? 'READY' : 'MISSING'],
      [pad('SPEECH SYNTHESIS'), sup.tts ? 'OK' : 'UNAVAILABLE'],
      [pad('SPEECH RECOGNITION'), sup.stt ? 'OK' : 'UNAVAILABLE'],
      [pad('VISION MODELS (LOCAL)'), models ? 'OFFLINE READY' : 'CDN FALLBACK'],
      [pad('OFFLINE MIND'), 'OK'],
      [pad('NEURAL LINK (SERVER)'), health ? 'ONLINE' : 'OFFLINE'],
      [pad('LANGUAGE CORE'), health?.ai?.provider === 'claude' ? 'CLAUDE' : health?.ai?.provider === 'ollama' ? `LOCAL ${health.ai.model.split(':')[0].toUpperCase()}` : 'MIND ONLY'],
      [pad('KNOWLEDGE BANK'), health ? `${health.docs} DOCS` : '—'],
    ];
    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 170 + Math.random() * 120));
      setLines((l) => [...l, steps[i]]);
      setProgress(((i + 1) / steps.length) * 100);
    }
    await new Promise((r) => setTimeout(r, 450));
    setLeaving(true);
    await new Promise((r) => setTimeout(r, 650));

    store().set({ phase: 'online' });
    sfx.online();
    speech.say('Hello. I am Chitti, the robot. Speed one terahertz, memory one zettabyte. How can I help you?');
    if (sup.stt) speech.listen(true);
    startVision();
  };

  useEffect(() => {
    const onKey = (e) => e.key === 'Enter' && store().phase === 'standby' && boot();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`boot${leaving ? ' leaving' : ''}`}>
      <div className="boot-core">
        <div className="ring r1" /><div className="ring r2" /><div className="ring r3" /><div className="ring r4" />
        <div className="boot-eye" />
      </div>
      <h1 className="boot-title" data-text="CHITTI">CHITTI</h1>
      <div className="boot-sub">VISION · VOICE · KNOWLEDGE — v3.0</div>

      {phase === 'standby' ? (
        <button className="boot-btn" onClick={boot}>
          <span>INITIALIZE</span>
        </button>
      ) : (
        <div className="boot-log">
          {lines.map(([k, v], i) => (
            <div key={i} className="boot-line">
              <span className="k">&gt; {k}</span>
              <span className={`v ${/^OFFLINE$|UNAVAILABLE|MISSING|FALLBACK|MIND ONLY/.test(v) ? 'bad' : ''}`}>{v}</span>
            </div>
          ))}
          <div className="boot-bar"><i style={{ width: `${progress}%` }} /></div>
        </div>
      )}
      {phase === 'standby' && <div className="boot-hint">Click or press Enter · allows camera, microphone and voice</div>}
    </div>
  );
}
