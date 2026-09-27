import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import Panel from './Panel';

const TAG = { observe: 'OBS', infer: 'INF', decide: 'DEC', alert: 'ALR', reflect: 'RFL' };
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// Chitti's internal monologue from the cognition loop.
export default function ThoughtsPanel() {
  const thoughts = useStore((s) => s.thoughts);
  const on = useStore((s) => s.settings.thinking);
  const setSetting = useStore((s) => s.setSetting);
  const list = useRef(null);

  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [thoughts]);

  return (
    <Panel id="thoughts" title="NEURAL STREAM" className="thoughts" delay={160} actions={
      <button className={`link${on ? ' on' : ''}`} onClick={() => setSetting({ thinking: !on })} title="Toggle self-thinking">
        {on ? '● THINKING' : '○ PAUSED'}
      </button>
    }>
      <div className="thought-list" ref={list}>
        {!thoughts.length && <div className="empty">{on ? 'Observing…' : 'Self-thinking paused.'}</div>}
        {thoughts.slice(-30).map((t) => (
          <div key={t.id} className={`neuron ${t.level}`}>
            <span className="tt">{time(t.at)}</span>
            <span className="tl">{TAG[t.level]}</span>
            <span className="tx">{t.text}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
