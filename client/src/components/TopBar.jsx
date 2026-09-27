import { useEffect, useState } from 'react';
import { useStore, MODES } from '../store';
import { cycleMode } from '../lib/actions';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="clock">
      <b>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>
      <small>{now.toLocaleTimeString([], { second: '2-digit' }).slice(-2)}</small>
    </div>
  );
}

function Battery() {
  const { level, charging } = useStore((s) => s.battery);
  if (level == null) return <span className="bat na">BAT N/A</span>;
  const pct = Math.round(level * 100);
  return (
    <span className={`bat${pct <= 20 ? ' crit' : ''}`} title={charging ? 'Charging' : 'On battery'}>
      <i className="bat-body"><i style={{ width: `${pct}%` }} /></i>
      {pct}%{charging ? ' ⚡' : ''}
    </span>
  );
}

const Led = ({ on, label, title }) => (
  <span className={`led${on ? ' on' : ''}`} title={title}><i />{label}</span>
);

export default function TopBar() {
  const mode = useStore((s) => s.mode);
  const lowPower = useStore((s) => s.lowPower);
  const vision = useStore((s) => s.vision);
  const threat = useStore((s) => s.threat);
  const count = useStore((s) => s.tracks.length);
  const backend = useStore((s) => s.backend);
  const brain = useStore((s) => s.brain);
  const setOpen = useStore((s) => s.set);
  const autoMode = useStore((s) => s.settings.autoMode);
  const known = useStore((s) => s.faces.filter((f) => f.name).map((f) => f.name).join(', '));

  const status =
    brain !== 'idle' ? 'PROCESSING'
    : vision.status === 'live' ? `${known ? `${known.toUpperCase()} IDENTIFIED · ` : ''}THREAT ${threat.toUpperCase()} · ${count} TARGET${count === 1 ? '' : 'S'}`
    : vision.status === 'loading-model' ? 'LOADING NEURAL VISION'
    : vision.status === 'starting' ? 'OPTICS STARTING'
    : 'ONLINE · OPTICS IDLE';

  return (
    <header className="topbar panel-in" style={{ '--d': '0ms' }}>
      <div className="brand">
        <span className="brand-mark" />
        CHITTI<b>VISION</b><small>3.0</small>
      </div>
      <div className={`status-line threat-${vision.status === 'live' ? threat : 'none'}`}>
        <span className="blink">●</span> {status}
      </div>
      <div className="top-right">
        <button className="mode-chip" key={mode} onClick={cycleMode} title={autoMode ? 'Auto mode on — click to switch manually' : 'Switch protocol'}>
          <span>{MODES[mode].label}{autoMode && <i className="auto-tag">AUTO</i>}</span><small>{lowPower ? 'LOW POWER' : MODES[mode].sub}</small>
        </button>
        <Led on={backend.online} label="LINK" title={backend.online ? 'Server connected' : 'Server offline — run npm run dev'} />
        <Led on={backend.ai} label={backend.provider === 'claude' ? 'CLAUDE' : backend.provider === 'ollama' ? 'LOCAL AI' : 'MIND'}
          title={backend.ai ? `Language core: ${backend.model}` : `Offline mind only. ${backend.reason || ''}`} />
        <Led on={vision.classifier === 'ready'} label="ID" title={`Smart identify: ${vision.classifier}`} />
        {vision.status === 'live' && <span className="fps">{vision.fps}<small>FPS</small></span>}
        <Battery />
        <Clock />
        <button className="gear" onClick={() => setOpen({ settingsOpen: true })} title="Settings">⚙</button>
      </div>
    </header>
  );
}
