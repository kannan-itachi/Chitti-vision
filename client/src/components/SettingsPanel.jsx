import { useStore, DEFAULT_SETTINGS } from '../store';
import { speech } from '../lib/speech';

function Toggle({ k, label, hint }) {
  const v = useStore((s) => s.settings[k]);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <label className="toggle set-row">
      <input type="checkbox" checked={v} onChange={(e) => setSetting({ [k]: e.target.checked })} />
      <i />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

function Slider({ k, label, min, max, step }) {
  const v = useStore((s) => s.settings[k]);
  const setSetting = useStore((s) => s.setSetting);
  return (
    <label className="slider set-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setSetting({ [k]: Number(e.target.value) })} />
      <b>{Math.round(v * 100)}%</b>
    </label>
  );
}

export default function SettingsPanel() {
  const s = useStore((st) => st.settings);
  const voices = useStore((st) => st.voice.voices);
  const localStt = useStore((st) => st.voice.local);
  const backend = useStore((st) => st.backend);
  const vision = useStore((st) => st.vision);
  const learned = useStore((st) => st.learned);
  const set = useStore((st) => st.set);
  const setSetting = useStore((st) => st.setSetting);
  const close = () => set({ settingsOpen: false });

  const brain = backend.provider === 'claude' ? `Claude · ${backend.model}`
    : backend.provider === 'ollama' ? `Local · ${backend.model} (offline)`
    : 'Built-in offline mind';

  return (
    <div className="settings-backdrop" onClick={close}>
      <div className="settings panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="panel-head">
          <span>SYSTEM CONFIGURATION</span>
          <button className="link" onClick={close}>✕ CLOSE</button>
        </div>

        <section>
          <h3>VOICE OUTPUT</h3>
          <label className="set-row select">
            <span>Voice</span>
            <select value={s.voiceURI} onChange={(e) => setSetting({ voiceURI: e.target.value })}>
              <option value="">Auto (best offline English voice)</option>
              {voices.map((v) => (
                <option key={v.uri} value={v.uri}>{v.name} · {v.lang}{v.local ? ' · offline' : ' · online'}</option>
              ))}
            </select>
          </label>
          <Slider k="volume" label="Volume" min={0.1} max={1} step={0.05} />
          <Slider k="rate" label="Speed" min={0.6} max={1.6} step={0.05} />
          <Slider k="pitch" label="Pitch" min={0.5} max={1.6} step={0.05} />
          <div className="set-actions">
            <button className="btn" onClick={() => speech.say('Hello. I am Chitti, the robot. Speed one terahertz, memory one zettabyte.', { interrupt: true })}>▶ TEST VOICE</button>
            <button className="btn" onClick={() => setSetting({ voiceURI: '', volume: 1, rate: 1, pitch: 1 })}>RESET</button>
          </div>
          <p className="set-note">
            Still quiet? Windows lowers other sounds when a mic is in use. Open <b>Sound settings → More sound settings → Communications</b> and choose <b>Do nothing</b>.
          </p>
        </section>

        <section>
          <h3>VOICE INPUT</h3>
          <label className="set-row select">
            <span>Accent</span>
            <select value={s.lang} onChange={(e) => setSetting({ lang: e.target.value })}>
              <option value="en-US">English (US)</option>
              <option value="en-IN">English (India)</option>
              <option value="en-GB">English (UK)</option>
            </select>
          </label>
          <Toggle k="wakeWord" label="Require a wake word" hint='Start with "Chitti", "hey", "ok" or "hello". Follow-ups within 8 s need none.' />
          <Toggle k="offlineSpeech" label="On-device speech recognition" hint={localStt ? 'Active — works without internet' : 'Used when your browser supports it'} />
        </section>

        <section>
          <h3>VISION</h3>
          <label className="set-row select">
            <span>Detector</span>
            <select value={s.detectQuality} onChange={(e) => setSetting({ detectQuality: e.target.value })}>
              <option value="accurate">Accurate — SSD MobileNet v2</option>
              <option value="fast">Fast — SSDLite (older PCs)</option>
            </select>
          </label>
          <Toggle k="smartIdentify" label="Smart identify (1000 objects + learned)" hint={`Classifier: ${vision.classifier}${vision.classifierOffline ? ' · offline' : ''} · ${learned.length} learned`} />
          <Toggle k="callouts" label="Voice callouts for new targets" />
        </section>

        <section>
          <h3>MIND</h3>
          <Toggle k="thinking" label="Self-thinking" hint="Observe, infer and decide on its own" />
          <Toggle k="speakThoughts" label="Speak important thoughts" />
          <Toggle k="autoMode" label="Automatic mode switching" hint="Research for questions, red chip on threats, calm when clear" />
          <Toggle k="sfx" label="HUD sound effects" />
          <div className="set-row info"><span>Language core</span><b>{brain}</b></div>
          {!backend.ai && backend.reason && <p className="set-note">{backend.reason}</p>}
        </section>

        <div className="set-actions">
          <button className="btn danger" onClick={() => setSetting(DEFAULT_SETTINGS)}>RESTORE DEFAULTS</button>
        </div>
      </div>
    </div>
  );
}
