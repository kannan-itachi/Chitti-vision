import { useStore } from '../store';

// Blips are real: bearing comes from the target's horizontal position in view,
// distance from how much of the frame it fills.
export default function Radar() {
  const tracks = useStore((s) => s.tracks);
  const lockId = useStore((s) => s.lockId);
  const live = useStore((s) => s.vision.status === 'live');
  const R = 46;

  return (
    <div className={`radar${live ? ' live' : ''}`}>
      <svg viewBox="-50 -50 100 100">
        <defs>
          <radialGradient id="rg">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle r={R} fill="url(#rg)" />
        {[R, R * 0.66, R * 0.33].map((r) => <circle key={r} r={r} className="ring" />)}
        <line x1={-R} x2={R} y1="0" y2="0" className="axis" />
        <line y1={-R} y2={R} x1="0" x2="0" className="axis" />
        <path d={`M0 0 L${-R * Math.sin(0.61)} ${-R * Math.cos(0.61)} A${R} ${R} 0 0 1 ${R * Math.sin(0.61)} ${-R * Math.cos(0.61)} Z`} className="fov" />
        <g className="sweep"><path d={`M0 0 L0 ${-R} A${R} ${R} 0 0 1 ${R * Math.sin(0.7)} ${-R * Math.cos(0.7)} Z`} /></g>
        {live && tracks.map((t) => {
          const bearing = (t.nx - 0.5) * 1.22; // ±35°
          const dist = R * Math.max(0.12, Math.min(0.95, 1 - Math.sqrt(t.area) * 1.4));
          const x = Math.sin(bearing) * dist;
          const y = -Math.cos(bearing) * dist;
          return (
            <g key={t.id} className={`blip${t.id === lockId ? ' locked' : ''}${t.cls === 'person' ? ' person' : ''}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
              <circle r="2.4" />
              <circle r="2.4" className="ping" />
            </g>
          );
        })}
        <circle r="1.6" className="self" />
      </svg>
    </div>
  );
}
