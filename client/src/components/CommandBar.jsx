import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { handleInput, pickFile, interrupt } from '../lib/actions';
import { speech } from '../lib/speech';
import { QUICK } from '../lib/commands';
import TaskStatus from './TaskStatus';

const HINTS = ['what do you see?', 'wiki Rajinikanth', 'question: what is the main topic?', 'lock target person', 'set mission find my keys', 'red chip mode', 'system check'];

export default function CommandBar() {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [hint, setHint] = useState(0);
  const hist = useRef({ list: [], i: -1 });
  const voice = useStore((s) => s.voice);
  const busy = useStore((s) => s.brain !== 'idle');
  const taskActive = useStore((s) => !!(s.task || s.confirm));

  useEffect(() => {
    const t = setInterval(() => setHint((h) => (h + 1) % HINTS.length), 4000);
    return () => clearInterval(t);
  }, []);

  const submit = (text) => {
    const v = (text ?? value).trim();
    if (!v) return;
    hist.current.list = [v, ...hist.current.list.filter((x) => x !== v)].slice(0, 30);
    hist.current.i = -1;
    setValue('');
    handleInput(v);
  };

  const onKey = (e) => {
    const h = hist.current;
    if (e.key === 'Enter') submit();
    else if (e.key === 'ArrowUp' && h.list.length) {
      e.preventDefault();
      h.i = Math.min(h.list.length - 1, h.i + 1);
      setValue(h.list[h.i]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      h.i = Math.max(-1, h.i - 1);
      setValue(h.i < 0 ? '' : h.list[h.i]);
    } else if (e.key === 'Escape') {
      setValue('');
      e.currentTarget.blur();
    }
  };

  return (
    <div className="cmdbar-wrap panel-in" style={{ '--d': '400ms' }}>
      <TaskStatus />
      {focused && !value && !taskActive && (
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q} onMouseDown={(e) => { e.preventDefault(); submit(q); }}>{q}</button>
          ))}
        </div>
      )}
      <div className={`cmdbar${focused ? ' focused' : ''}`}>
        <span className="cmd-label">COMMAND&nbsp;&gt;</span>
        <input
          id="cmd-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={voice.interim ? `🎙 ${voice.interim}` : `${HINTS[hint]}   ( / to focus )`}
          autoComplete="off"
          spellCheck={false}
        />
        {(voice.speaking || busy) && (
          <button className="cmd-btn stop" onClick={interrupt} title="Interrupt (Esc)">■</button>
        )}
        <button className="cmd-btn" onClick={pickFile} title="Upload a document">＋</button>
        {voice.stt && (
          <button className={`cmd-btn mic${voice.micOn ? ' on' : ''}${voice.listening ? ' live' : ''}`} onClick={() => speech.listen(!voice.micOn)} title={voice.micOn ? 'Microphone on — click to mute' : 'Microphone off — click to listen'}>
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />{!voice.micOn && <path stroke="currentColor" strokeWidth="2" d="M4 4l16 16" />}</svg>
          </button>
        )}
        <button className="cmd-btn send" onClick={() => submit()} disabled={!value.trim()} title="Send (Enter)">➤</button>
      </div>
    </div>
  );
}
