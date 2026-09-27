import { useStore, store } from '../store';

// HUD panel with a clickable title that collapses it (remembered per browser).
export default function Panel({ id, title, meta, actions, className = '', delay = 0, children }) {
  const collapsed = useStore((s) => !!s.collapsed[id]);
  const toggle = () => {
    const next = { ...store().collapsed, [id]: !collapsed };
    store().set({ collapsed: next });
    try { localStorage.setItem('chitti.collapsed', JSON.stringify(next)); } catch { /* private mode */ }
  };
  return (
    <div className={`panel panel-in ${className}${collapsed ? ' collapsed' : ''}`} style={{ '--d': `${delay}ms` }}>
      <div className="panel-head">
        <button className="ph-title" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? 'Expand' : 'Collapse'}>
          <i className="chev" />{title}
        </button>
        {meta != null && <em>{meta}</em>}
        {actions}
      </div>
      {!collapsed && children}
    </div>
  );
}
