import { useEffect, useState } from 'react';
import { useStore } from '../store';

const GLYPHS = '01<>/\\{}[]#$%&*+=?ABCDEFXYZ';

// Decode effect: preview text resolves out of random glyphs, left to right.
function useDecode(text) {
  const [out, setOut] = useState('');
  useEffect(() => {
    if (!text) return setOut('');
    let frame = 0;
    const t = setInterval(() => {
      frame += 6;
      const done = text.slice(0, frame);
      const noise = Array.from({ length: Math.min(24, text.length - frame) }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join('');
      setOut(done + noise);
      if (frame >= text.length) clearInterval(t);
    }, 30);
    return () => clearInterval(t);
  }, [text]);
  return out;
}

export default function UploadScanner() {
  const up = useStore((s) => s.upload);
  const decoded = useDecode(up?.preview);
  if (!up) return null;

  const title = up.phase === 'error' ? 'SCAN FAILED' : up.phase === 'done' ? 'CONTENT RETRIEVED' : 'RETRIEVING CONTENT';
  return (
    <div className={`scanner ${up.phase}`}>
      <div className="scanner-noise" />
      <div className="scanner-title">{title}</div>
      <div className="scanner-bar"><i style={{ width: `${up.phase === 'uploading' ? up.progress : 100}%` }} /></div>
      <dl className="scanner-meta">
        <dt>NAME</dt><dd title={up.name}>{up.name}</dd>
        <dt>SIZE</dt><dd>{(up.size / 1024).toFixed(1)} KB</dd>
        <dt>TYPE</dt><dd>{up.type}</dd>
        {up.chunks != null && <><dt>BLOCKS</dt><dd>{up.chunks} indexed</dd></>}
      </dl>
      <div className="scanner-preview">
        {up.phase === 'uploading' && 'Initializing scan…'}
        {up.phase === 'done' && decoded}
        {up.phase === 'error' && up.error}
      </div>
    </div>
  );
}
