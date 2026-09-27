// Multi-object tracker: gives each detection a stable ID across frames and
// smooths boxes between detector ticks, so the HUD glides instead of jittering.
const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};

export const CONFIRM_HITS = 3;
const TTL_MS = 900;

export class Tracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  // preds: coco-ssd output [{ bbox:[x,y,w,h], class, score }]. Returns newly confirmed tracks.
  update(preds, now) {
    const free = new Set(this.tracks);
    const confirmed = [];

    for (const p of [...preds].sort((a, b) => b.score - a.score)) {
      let best = null;
      let bestIou = 0.2;
      for (const t of free) {
        if (t.cls !== p.class) continue;
        const v = iou(t.target, p.bbox);
        if (v > bestIou) { best = t; bestIou = v; }
      }
      if (best) {
        free.delete(best);
        best.target = p.bbox;
        best.score = best.score * 0.6 + p.score * 0.4;
        best.lastSeen = now;
        best.hits++;
        if (best.hits === CONFIRM_HITS) confirmed.push(best);
      } else {
        this.tracks.push({
          id: this.nextId++, cls: p.class, score: p.score,
          box: [...p.bbox], target: p.bbox, born: now, lastSeen: now, hits: 1,
        });
      }
    }
    this.tracks = this.tracks.filter((t) => now - t.lastSeen < TTL_MS);
    return confirmed;
  }

  // Ease rendered boxes toward their latest detection.
  step(dt) {
    const k = 1 - Math.exp(-dt * 14);
    for (const t of this.tracks) {
      for (let i = 0; i < 4; i++) t.box[i] += (t.target[i] - t.box[i]) * k;
    }
  }

  get visible() {
    return this.tracks.filter((t) => t.hits >= CONFIRM_HITS);
  }
}

export function rangeOf(t, vw, vh) {
  const r = (t.box[2] * t.box[3]) / (vw * vh || 1);
  if (r > 0.3) return 'VERY CLOSE';
  if (r > 0.12) return 'CLOSE';
  if (r > 0.04) return 'MEDIUM';
  return 'LONG';
}

// hazards: confirmed hazards from the vision engine ([{ kind }]).
export function threatOf(tracks, hazards = []) {
  if (hazards.some((h) => h.kind === 'sharp' || h.kind === 'weapon')) return 'high';
  const people = tracks.filter((t) => t.cls === 'person').length;
  if (people >= 3) return 'high';
  if (hazards.length || people >= 1) return 'medium';
  return 'low';
}
