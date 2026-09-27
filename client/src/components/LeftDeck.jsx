import { useStore } from '../store';
import { startVision, stopVision, handleInput, lockById } from '../lib/actions';
import Panel from './Panel';
import Radar from './Radar';

function Controls() {
  const status = useStore((s) => s.vision.status);
  const lockId = useStore((s) => s.lockId);
  const callouts = useStore((s) => s.settings.callouts);
  const setSetting = useStore((s) => s.setSetting);
  const live = status === 'live';
  const busy = status === 'starting' || status === 'loading-model';

  const learn = () => {
    const name = window.prompt('Name this object or person (hold it / look at the camera):');
    if (name?.trim()) handleInput(`learn this as ${name.trim()}`);
  };

  return (
    <Panel id="optics" title="OPTICS" meta={<span className={live ? 'ok' : ''}>{status.toUpperCase()}</span>} className="controls" delay={80}>
      <div className="btn-grid">
        {live ? (
          <button className="btn danger" onClick={stopVision}>■ STOP</button>
        ) : (
          <button className="btn primary" onClick={startVision} disabled={busy}>▶ {busy ? 'STARTING' : 'START'}</button>
        )}
        <button className="btn" onClick={() => handleInput('what do you see?')}>◉ DESCRIBE</button>
        <button className="btn" onClick={() => handleInput('what is this?')} disabled={!live}>⌕ IDENTIFY</button>
        <button className="btn learn" onClick={learn} disabled={!live}>★ LEARN</button>
        <button className="btn" onClick={() => handleInput('scan')} disabled={!live}>⟲ SCAN</button>
        <button className={`btn${lockId ? ' active' : ''}`} onClick={() => handleInput(lockId ? 'release target' : 'lock target')} disabled={!live}>
          ⌖ {lockId ? 'RELEASE' : 'LOCK'}
        </button>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={callouts} onChange={(e) => setSetting({ callouts: e.target.checked })} />
        <i /> Voice callouts for new targets
      </label>
    </Panel>
  );
}

function Targets() {
  const tracks = useStore((s) => s.tracks);
  const lockId = useStore((s) => s.lockId);
  return (
    <Panel id="targets" title="TARGETS" meta={tracks.length} className="targets" delay={140}>
      <div className="target-list">
        {!tracks.length && <div className="empty">No detections.</div>}
        {tracks.slice(0, 8).map((t) => (
          <button key={t.id} className={`target${t.id === lockId ? ' locked' : ''}${t.source === 'learned' || t.source === 'face' ? ' learned' : ''}`} onClick={() => lockById(t.id)}
            title={t.name !== t.cls && t.source !== 'face' ? `Detector said "${t.cls}", classifier says "${t.name}". Click to lock.` : 'Click to lock / release'}>
            <span className="tid">T-{String(t.id).padStart(2, '0')}</span>
            <span className="tcls">{t.source === 'face' ? '◆ ' : t.source === 'learned' ? '★ ' : ''}{t.name}</span>
            <span className="trange">{t.range}</span>
            <span className="tconf"><i style={{ width: `${Math.round(t.score * 100)}%` }} /></span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

// What is in the centre of the view: a person (with face ID) or the object being shown.
function Focus() {
  const focus = useStore((s) => s.focus);
  const classifier = useStore((s) => s.vision.classifier);
  const smart = useStore((s) => s.settings.smartIdentify);
  const live = useStore((s) => s.vision.status === 'live');
  if (!smart || !live) return null;
  const fresh = focus && Date.now() - focus.at < 4000;
  const meta = classifier !== 'ready' ? classifier.toUpperCase() : !fresh ? '…' : focus.person ? 'HUMAN' : focus.color.toUpperCase();
  return (
    <Panel id="focus" title="FOCUS ID" meta={meta} className="focus" delay={200}>
      {classifier === 'loading' && <div className="empty">Loading recognition model…</div>}
      {classifier === 'error' && <div className="empty">Model unavailable — run <b>npm run models</b>.</div>}
      {fresh && focus.person && (
        <div className={`focus-person${focus.person.name ? ' known' : ''}`}>
          <div className="fp-icon">{focus.person.name ? '◆' : '?'}</div>
          <div>
            <b>{focus.person.name ? focus.person.name.toUpperCase() : focus.person.face ? 'UNKNOWN FACE' : 'PERSON'}</b>
            <small>{focus.person.name ? `face match ${Math.round(focus.person.sim * 100)}%` : 'Say “my name is …” to be remembered'}</small>
          </div>
        </div>
      )}
      {fresh && !focus.person && (
        <div className="focus-list">
          {focus.learned && (
            <div className="focus-row learned"><span>★ {focus.learned.label}</span><i><b style={{ width: `${Math.round(focus.learned.sim * 100)}%` }} /></i><em>LEARNED</em></div>
          )}
          {focus.labels.map((l) => (
            <div key={l.label} className="focus-row"><span>{l.label}</span><i><b style={{ width: `${Math.round(l.prob * 100)}%` }} /></i><em>{Math.round(l.prob * 100)}%</em></div>
          ))}
          {!focus.learned && !focus.labels.length && <div className="empty">Hold an object in the centre.</div>}
        </div>
      )}
    </Panel>
  );
}

function Telemetry() {
  const threat = useStore((s) => s.threat);
  const count = useStore((s) => s.tracks.length);
  const faces = useStore((s) => s.faces);
  const mission = useStore((s) => s.mission);
  const recordMode = useStore((s) => s.recordMode);
  const live = useStore((s) => s.vision.status === 'live');
  const scene = useStore((s) => s.scene);
  const energy = !live ? 6 : count >= 6 ? 96 : count >= 3 ? 72 : count >= 1 ? 38 : 14;
  const level = { low: 1, medium: 2, high: 3 }[threat];
  const light = scene.brightness == null ? '—' : scene.brightness < 40 ? 'DARK' : scene.brightness < 90 ? 'DIM' : 'GOOD';
  const known = faces.filter((f) => f.name).map((f) => f.name);

  return (
    <Panel id="telemetry" title="TELEMETRY" className="telemetry" delay={320}>
      <div className="tele-row">
        <label>THREAT</label>
        <div className={`threat-meter t-${live ? threat : 'none'}`}>
          {[1, 2, 3].map((i) => <i key={i} className={live && i <= level ? 'on' : ''} />)}
        </div>
        <b>{live ? threat.toUpperCase() : '—'}</b>
      </div>
      <div className="tele-row">
        <label>ENERGY</label>
        <div className="energy"><i style={{ width: `${energy}%` }} /></div>
        <b>{energy}%</b>
      </div>
      <div className="tele-row">
        <label>MOTION</label>
        <div className="energy motion"><i style={{ width: `${live ? Math.min(100, Math.round(scene.motion * 400)) : 0}%` }} /></div>
        <b>{live && scene.motionSide ? scene.motionSide.toUpperCase() : '—'}</b>
      </div>
      <div className="tele-row">
        <label>FACES</label>
        <span className={known.length ? 'known' : ''}>{live ? (known.length ? known.join(', ') : faces.length ? `${faces.length} unknown` : 'none') : '—'}</span>
        <b className={light === 'DARK' ? 'warn' : ''}>{live ? `LIGHT ${light}` : ''}</b>
      </div>
      <div className="tele-row mission">
        <label>MISSION</label>
        <span title={mission || ''}>{mission || 'NONE ASSIGNED'}</span>
      </div>
      <div className="tele-row">
        <label>RECORD</label>
        <span className={recordMode ? 'rec on' : 'rec'}>{recordMode ? '● REC' : 'OFF'}</span>
      </div>
    </Panel>
  );
}

export default function LeftDeck() {
  return (
    <aside className="deck deck-left">
      <Controls />
      <Targets />
      <Focus />
      <Panel id="radar" title="RADAR" meta="FOV 70°" className="radar-panel" delay={260}>
        <Radar />
      </Panel>
      <Telemetry />
    </aside>
  );
}
