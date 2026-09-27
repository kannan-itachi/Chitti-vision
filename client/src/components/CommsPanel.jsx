import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { handleInput } from '../lib/actions';
import { runTool } from '../lib/tools';

const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Message({ m }) {
  if (m.role === 'system') return <div className="msg sys">// {m.text}</div>;
  return (
    <div className={`msg ${m.role}${m.kind === 'thought' ? ' msg-thought' : ''}${m.error ? ' error' : ''}${m.streaming ? ' streaming' : ''}`}>
      <div className="msg-meta">
        <b>{m.role === 'user' ? (m.channel === 'voice' ? 'YOU · VOICE' : 'YOU') : 'CHITTI'}</b>
        <span>{time(m.at)}</span>
      </div>
      {m.image && <img className="msg-img" src={m.image} alt="Captured camera frame" />}
      {m.text && <div className="msg-text">{m.text}{m.streaming && <i className="caret" />}</div>}
      {!m.text && m.streaming && <div className="msg-text thinking"><i /><i /><i /></div>}
      {m.help && (
        <div className="help-grid">
          {m.help.map(([cmd, desc]) => (
            <button key={cmd} className="help-row" onClick={() => !cmd.includes('…') && !cmd.includes('<') && cmd !== 'anything else' && !cmd.startsWith('learn') && handleInput(cmd.split(' / ')[0].split(' · ')[0].replace(/\s*\[.*\]/, ''))}>
              <code>{cmd}</code><span>{desc}</span>
            </button>
          ))}
        </div>
      )}
      {m.sources?.length > 0 && (
        <div className="sources">
          {m.sources.slice(0, 4).map((s, i) => <span key={i}>{s.doc} · #{s.block}</span>)}
        </div>
      )}
      {m.links?.length > 0 && (
        <div className="msg-links">
          {m.links.slice(0, 5).map((l, i) => (
            <a key={i} href={l.url} target="_blank" rel="noreferrer" title={l.url}><b>{l.site}</b> {l.title}</a>
          ))}
        </div>
      )}
      {m.files?.length > 0 && (
        <div className="msg-files">
          {m.files.slice(0, 5).map((f, i) => (
            <button key={f.path} onClick={() => runTool('open_file', { path: f.path })} title={f.path}>
              <b>{i + 1}</b> {f.name} <em>{f.folder?.split(/[\\/]/).pop()}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommsPanel() {
  const messages = useStore((s) => s.messages);
  const interim = useStore((s) => s.voice.interim);
  const set = useStore((s) => s.set);
  const body = useRef(null);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [messages, interim]);

  return (
    <div className="panel comms panel-in" style={{ '--d': '120ms' }}>
      <div className="panel-head">
        <span>COMMS LINK</span>
        {messages.length > 0 && <button className="link" onClick={() => set({ messages: [] })}>CLEAR</button>}
      </div>
      <div className="comms-body" ref={body}>
        {!messages.length && (
          <div className="empty comms-empty">
            Speak or type to talk to Chitti.<br />
            Try <b>“what do you see?”</b> or <b>“help”</b>.
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} />)}
        {interim && <div className="msg user interim"><div className="msg-text">{interim}<i className="caret" /></div></div>}
      </div>
    </div>
  );
}
