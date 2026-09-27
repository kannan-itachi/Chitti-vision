import { useEffect, useState } from 'react';
import { useStore } from '../store';

// The "DISPLAYING.." card from the original, now with real retrieval states,
// Wikipedia imagery and auto-dismiss.
export default function InfoCard() {
  const info = useStore((s) => s.info);
  const set = useStore((s) => s.set);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (!info) return;
    if (info.status !== 'retrieving') {
      setPct(100);
      const t = setTimeout(() => set((s) => (s.info?.id === info.id ? { info: null } : {})), 20000);
      return () => clearTimeout(t);
    }
    setPct(0);
    const t = setInterval(() => setPct((p) => Math.min(92, p + (92 - p) * 0.12 + 1)), 110);
    return () => clearInterval(t);
  }, [info?.id, info?.status]);

  if (!info) return null;
  const ready = info.status === 'ready';

  return (
    <div className={`info-card ${info.status}`} key={info.id}>
      <div className="info-head">
        <span>{ready ? 'DISPLAYING' : info.status === 'error' ? 'NO RESULT' : 'RETRIEVING'}<span className="dots" /></span>
        <button className="link" onClick={() => set({ info: null })}>✕</button>
      </div>
      <div className="info-meta">
        <div><label>TERM</label><b>{info.term}</b></div>
        <div><label>SOURCE</label><b>{info.source}</b></div>
        <div><label>MODE</label><b>{{ wiki: 'KNOWLEDGE QUERY', map: 'NAVIGATION', screen: 'SCREEN ANALYSIS' }[info.kind] || 'DOC ANALYSIS'}</b></div>
      </div>
      <div className="info-progress"><i style={{ width: `${pct}%` }} /></div>
      <div className="info-pct">{Math.round(pct)}%</div>
      {info.status !== 'retrieving' && (
        <div className="info-body">
          {info.image && <img src={info.image} alt={info.term} />}
          {info.description && <div className="info-desc">{info.description}</div>}
          <p>{info.text}</p>
          {info.url && <a href={info.url} target="_blank" rel="noreferrer">Open full article ↗</a>}
        </div>
      )}
    </div>
  );
}
