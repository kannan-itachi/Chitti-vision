import { useStore } from '../store';
import { pickFile, removeDoc } from '../lib/actions';
import Panel from './Panel';

const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const ext = (n) => (n.split('.').pop() || '').slice(0, 4).toUpperCase();

export default function KnowledgePanel() {
  const docs = useStore((s) => s.docs);
  const activeDocId = useStore((s) => s.activeDocId);
  const online = useStore((s) => s.backend.online);
  const set = useStore((s) => s.set);

  return (
    <Panel id="knowledge" title="KNOWLEDGE BANK" className="knowledge" delay={200}
      actions={<button className="icon-btn" onClick={pickFile} disabled={!online} title="Upload a document">＋</button>}>
      <div className="doc-list">
        {!docs.length && (
          <button className="empty drop-hint" onClick={pickFile} disabled={!online}>
            {online ? <>Drop or add <b>TXT · MD · JSON · CSV · PDF · DOCX</b><br />then ask <b>“question: …”</b></> : 'Server offline — documents unavailable'}
          </button>
        )}
        {docs.length > 1 && (
          <button className={`doc all${!activeDocId ? ' active' : ''}`} onClick={() => set({ activeDocId: null })}>
            <span className="doc-ext">ALL</span>
            <span className="doc-name">Search every document</span>
          </button>
        )}
        {docs.map((d) => (
          <div key={d.id} className={`doc${d.id === activeDocId ? ' active' : ''}`} onClick={() => set({ activeDocId: d.id })} role="button" tabIndex={0}>
            <span className="doc-ext">{ext(d.name)}</span>
            <span className="doc-name" title={d.name}>{d.name}</span>
            <span className="doc-meta">{d.chunks} blk · {size(d.size)}</span>
            <button className="doc-x" title="Forget document" onClick={(e) => { e.stopPropagation(); removeDoc(d.id); }}>×</button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
