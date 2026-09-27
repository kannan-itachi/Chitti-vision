import { useStore } from '../store';

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>
      ))}
    </div>
  );
}
