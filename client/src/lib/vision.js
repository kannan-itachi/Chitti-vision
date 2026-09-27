// Chitti's optical system: camera + COCO-SSD detector + tracker + HUD renderer,
// plus a perception loop (faces, second-opinion classifier, learned objects/people,
// focus, motion and light). Detection, perception and rendering run on separate loops.
import { store } from '../store';
import { Tracker, rangeOf, threatOf } from './tracker';
import { loadDetector } from './models';
import { perception, isPersonish } from './perception';
import { hazardOf, KIND_LABEL } from './hazards';

const HAZARD_CONFIRM_MS = 900; // must be seen this long before Chitti raises an alarm
const overlaps = ([ax, ay, aw, ah], [bx, by, bw, bh], pad = 0.2) =>
  ax - aw * pad < bx + bw && ax + aw * (1 + pad) > bx && ay - ah * pad < by + bh && ay + ah * (1 + pad) > by;

const COLORS = {
  calm: { main: '#3ee8ff', alt: '#ff8a3d' },
  combat: { main: '#ff3b4e', alt: '#ffb020' },
  research: { main: '#3dffb0', alt: '#7aa8ff' },
};
const LOCK = '#ff2d55';
const LEARNED = '#c78bff';
const INTERVAL = { calm: 110, combat: 60, research: 85 };
const TOP_SAFE = 96; // keep canvas labels below the top bar
const MONO = '"Share Tech Mono", ui-monospace, monospace';

// COCO classes the detector often hallucinates on household objects get a higher bar.
const STRICT = new Set(['toilet', 'sink', 'refrigerator', 'oven', 'microwave', 'toaster', 'bed', 'dining table', 'kite', 'umbrella',
  'parking meter', 'fire hydrant', 'stop sign', 'hair drier', 'vase', 'tie', 'frisbee', 'surfboard', 'skis', 'snowboard', 'train', 'airplane', 'boat']);
const minScore = (cls) => (cls === 'person' ? 0.5 : STRICT.has(cls) ? 0.72 : 0.55);

export const nameOf = (t) => t.alias || t.cls;
const inside = ([x, y, w, h], [px, py]) => px >= x && px <= x + w && py >= y && py <= y + h;
const center = ([x, y, w, h]) => [x + w / 2, y + h / 2];

const setVision = (patch) => store().merge('vision', patch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class VisionEngine {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tracker = new Tracker();
    this.faces = [];
    this.running = false;
    this.stream = null;
    this.onNewTarget = null;
    this.onTargetLost = null;
    this.onFaceRecognized = null;
    this.lockMissingSince = 0;
    this.fps = 0;
    this.lastSnapshot = 0;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.render);
  }

  destroy() {
    this.stop();
    cancelAnimationFrame(this.raf);
  }

  async start() {
    if (this.running || store().vision.status === 'starting') return;
    setVision({ status: 'starting', error: null });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      setVision({ status: 'loading-model' });
      await this.useDetector(store().settings.detectQuality);
      this.running = true;
      this.tracker.reset();
      setVision({ status: 'live' });
      this.detectLoop();
      this.perceiveLoop();
      perception.initFaces();
      if (store().settings.smartIdentify) perception.init();
    } catch (e) {
      this.stopStream();
      const msg = e.name === 'NotAllowedError' ? 'Camera permission denied'
        : e.name === 'NotFoundError' ? 'No camera found'
        : e.name === 'NotReadableError' ? 'Camera is in use by another app'
        : /fetch|network|load/i.test(e.message || '') ? 'Could not load the vision model. Run "npm run models" once with internet.'
        : e.message || String(e);
      setVision({ status: 'error', error: msg });
      throw new Error(msg);
    }
  }

  async useDetector(quality) {
    const { model, offline } = await loadDetector(quality);
    this.model = model;
    setVision({ model: quality === 'fast' ? 'SSDLite MobileNet v2' : 'SSD MobileNet v2', detectorOffline: offline });
  }

  stop() {
    this.running = false;
    this.stopStream();
    this.tracker.reset();
    this.faces = [];
    store().set({ tracks: [], faces: [], hazards: [], lockId: null, threat: 'low', focus: null });
    setVision({ status: 'off', fps: 0 });
  }

  stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  // ---------- loops ----------

  async detectLoop() {
    while (this.running) {
      const t0 = performance.now();
      if (this.video.readyState >= 2) {
        try {
          const raw = await this.model.detect(this.video, 20, 0.35);
          if (!this.running) break;
          const preds = raw.filter((p) => p.score >= minScore(p.class));
          const fresh = this.tracker.update(preds, performance.now());
          for (const t of fresh) {
            t.confirmedAt = performance.now();
            // Give the second-opinion classifier a moment so the callout uses the right name.
            this.refine(t).finally(() => this.running && this.onNewTarget?.(t));
          }
          this.checkLock();
        } catch {
          /* transient backend hiccup; keep looping */
        }
      }
      const dt = performance.now() - t0;
      this.fps = this.fps ? this.fps * 0.85 + (1000 / Math.max(dt, 16)) * 0.15 : 1000 / Math.max(dt, 16);
      const { mode, lowPower } = store();
      await sleep(Math.max(0, (lowPower ? 400 : INTERVAL[mode] ?? 100) - dt));
    }
  }

  async perceiveLoop() {
    while (this.running) {
      const t0 = performance.now();
      if (this.video.readyState >= 2) {
        store().set({ scene: perception.sense(this.video) });
        try {
          await this.updateFaces();
          if (store().settings.smartIdentify && perception.model) {
            await this.updateFocus();
            const stale = this.tracker.visible
              .filter((t) => t.cls !== 'person' && !t.refining && performance.now() - (t.refinedAt || 0) > 2500)
              .slice(0, 2);
            for (const t of stale) await this.refine(t);
          }
        } catch {
          /* model busy */
        }
      }
      const wait = store().lowPower ? 2000 : 450;
      await sleep(Math.max(60, wait - (performance.now() - t0)));
    }
  }

  // Faces: detect every tick, recognise each one about once a second, attach to person tracks.
  async updateFaces() {
    const now = performance.now();
    const found = await perception.detectFaces(this.video);
    const next = found.map((f) => {
      const c = center(f.box);
      const prev = this.faces.find((p) => Math.hypot(center(p.box)[0] - c[0], center(p.box)[1] - c[1]) < f.box[2] * 0.6);
      return { ...f, name: prev?.name ?? null, sim: prev?.sim ?? 0, recognizedAt: prev?.recognizedAt ?? 0, born: prev?.born ?? now, drawBox: prev?.drawBox ?? [...f.box] };
    });
    for (const f of next.filter((x) => now - x.recognizedAt > 1200).slice(0, 2)) {
      f.recognizedAt = now;
      if (!perception.model) continue;
      const r = await perception.identifyFace(this.video, f.box);
      const was = f.name;
      f.name = r?.label ?? (f.name && f.sim > 0.9 ? f.name : null); // brief dips don't drop a known name
      f.sim = r?.sim ?? f.sim * 0.9;
      if (f.name && f.name !== was) this.onFaceRecognized?.(f.name);
    }
    this.faces = next;
    for (const t of this.tracker.tracks) {
      if (t.cls !== 'person') continue;
      const face = next.find((f) => inside(t.target, center(f.box)));
      t.face = face || null;
      if (face?.name) { t.alias = face.name; t.source = 'face'; } else if (t.source === 'face') { t.alias = null; t.source = null; }
    }
    store().set({ faces: next.map((f) => ({ name: f.name, sim: f.sim, score: f.score })) });
  }

  // What is in the centre of the view: a person (face), something they're holding, or an object.
  async updateFocus() {
    const v = this.video;
    const c = [v.videoWidth / 2, v.videoHeight / 2];
    const f = await perception.identifyRegion(v, perception.centerBox(v));
    if (!f) return;
    const personAtCentre = this.tracker.visible.find((t) => t.cls === 'person' && inside(t.target, c));
    const face = this.faces.find((x) => inside(x.box, c)) || (personAtCentre && personAtCentre.face);
    const labels = f.labels.filter((l) => !isPersonish(l.label));
    const holding = labels[0] && labels[0].prob > (personAtCentre ? 0.35 : 0.2);
    store().set({
      focus: {
        at: Date.now(),
        color: f.color,
        learned: f.learned,
        labels: holding || !personAtCentre ? labels : [],
        person: !!personAtCentre && !f.learned && !holding ? { name: face?.name || null, sim: face?.sim || 0, face: !!face } : null,
      },
    });
  }

  // Second opinion on one non-person box: learned objects first, then the 1000-class classifier.
  async refine(t) {
    if (t.cls === 'person' || !store().settings.smartIdentify || !perception.model || t.refining) return;
    t.refining = true;
    try {
      const r = await perception.identifyRegion(this.video, t.target);
      if (!r) return;
      t.refinedAt = performance.now();
      t.color = r.color;
      const top = r.labels.find((l) => !isPersonish(l.label));
      if (r.learned) {
        t.alias = r.learned.label;
        t.source = 'learned';
        t.misses = 0;
      } else if (top && (top.prob >= 0.4 || (top.prob >= 0.2 && t.score < 0.62))) {
        t.alias = top.label;
        t.source = 'imagenet';
        t.aliasProb = top.prob;
        t.misses = 0;
      } else if ((t.misses = (t.misses || 0) + 1) >= 2) {
        t.alias = null; // only drop a name after two misses in a row, so labels don't flicker
        t.source = null;
      }
    } catch {
      /* classifier busy */
    } finally {
      t.refining = false;
    }
  }

  checkLock() {
    const { lockId } = store();
    if (!lockId) return;
    if (this.tracker.tracks.some((t) => t.id === lockId)) {
      this.lockMissingSince = 0;
    } else if (!this.lockMissingSince) {
      this.lockMissingSince = performance.now();
    } else if (performance.now() - this.lockMissingSince > 1500) {
      this.lockMissingSince = 0;
      store().set({ lockId: null });
      this.onTargetLost?.();
    }
  }

  // ---------- actions ----------

  pickTarget(name) {
    const vis = this.tracker.visible;
    const pool = name ? vis.filter((t) => [t.cls, t.alias].some((n) => n && (n === name || n.includes(name) || name.includes(n)))) : vis;
    return pool.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0] || null;
  }

  // What to learn/identify: the locked target, else a face at the centre, else the centre region.
  focusRegion() {
    const v = this.video;
    const c = [v.videoWidth / 2, v.videoHeight / 2];
    const locked = this.tracker.tracks.find((t) => t.id === store().lockId);
    if (locked) return locked.face ? { box: locked.face.box, kind: 'face', track: locked } : { box: locked.target, kind: 'object', track: locked };
    const face = this.faces.find((f) => inside(f.box, c)) || (this.faces.length === 1 ? this.faces[0] : null);
    if (face && !this.holdingSomething()) return { box: face.box, kind: 'face', track: null };
    return { box: perception.centerBox(v), kind: 'object', track: null };
  }

  holdingSomething() {
    const f = store().focus;
    return !!(f && Date.now() - f.at < 2000 && !f.person && (f.learned || f.labels[0]?.prob > 0.35));
  }

  largestFace() {
    return [...this.faces].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0] || null;
  }

  async identifyNow() {
    if (!(await perception.init())) return null;
    const { box, kind, track } = this.focusRegion();
    if (kind === 'face') {
      const r = await perception.identifyFace(this.video, box);
      return { person: true, name: r?.label || null, sim: r?.sim || 0, track };
    }
    const r = await perception.identifyRegion(this.video, box);
    return r && { ...r, labels: r.labels.filter((l) => !isPersonish(l.label)).concat(r.labels.filter((l) => isPersonish(l.label))), track };
  }

  async learn(label, { forceFace = false } = {}) {
    let region = this.focusRegion();
    if (forceFace) {
      const f = this.largestFace();
      if (!f) throw new Error('I cannot see a face');
      region = { box: f.box, kind: 'face', track: null };
    }
    const n = await perception.learn(this.video, region.box, label, { kind: region.kind });
    if (region.track) { region.track.alias = label; region.track.source = region.kind === 'face' ? 'face' : 'learned'; }
    const face = region.kind === 'face' && this.faces.find((f) => f.box === region.box);
    if (face) { face.name = label; face.sim = 1; }
    return { n, kind: region.kind };
  }

  // Current frame as base64 JPEG (mirrored, exactly as the user sees it).
  capture(maxW = 1024) {
    const v = this.video;
    if (!v.videoWidth) return null;
    const s = Math.min(1, maxW / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    const g = c.getContext('2d');
    g.translate(c.width, 0);
    g.scale(-1, 1);
    g.drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.82);
    return { base64: url.split(',')[1], dataUrl: url };
  }

  // ---------- rendering ----------

  mapper(cw, ch) {
    const vw = this.video.videoWidth || 1;
    const vh = this.video.videoHeight || 1;
    const s = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * s) / 2;
    const oy = (ch - vh * s) / 2;
    const box = ([x, y, w, h]) => [cw - (ox + (x + w) * s), oy + y * s, w * s, h * s];
    box.point = ([x, y]) => [cw - (ox + x * s), oy + y * s];
    return box;
  }

  render = (now) => {
    this.raf = requestAnimationFrame(this.render);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const { canvas, ctx } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!this.running) return;

    this.tracker.step(dt);
    const { mode, lockId, focus, settings } = store();
    const col = COLORS[mode] || COLORS.calm;
    const map = this.mapper(cw, ch);
    const vis = this.tracker.visible;

    if (settings.smartIdentify) this.drawFocus(focus, cw, ch, col, now);

    for (const t of vis) {
      const locked = t.id === lockId;
      const color = locked || t.hazard ? LOCK : t.source === 'learned' || t.source === 'face' ? LEARNED : col.main;
      const [x, y, w, h] = map(t.box);
      const intro = Math.min(1, (now - (t.confirmedAt || 0)) / 450);
      const stale = Math.max(0, Math.min(1, (performance.now() - t.lastSeen - 200) / 600));
      ctx.globalAlpha = (0.25 + 0.75 * intro) * (1 - stale);
      this.drawBrackets(x, y, w, h, color, intro, now, t.cls === 'person' ? 0.45 : 1);
      this.drawLabel(t, x, y, w, h, color, col.alt);
      if (t.hazard) this.drawHazard(t, x, y, w, h, now);
      if (locked) this.drawLock(x, y, w, h, now, cw, ch);
    }
    ctx.globalAlpha = 1;

    const k = 1 - Math.exp(-dt * 16);
    for (const f of this.faces) {
      for (let i = 0; i < 4; i++) f.drawBox[i] += (f.box[i] - f.drawBox[i]) * k;
      this.drawFace(f, map, col, now);
    }

    if (now - this.lastSnapshot > 250) {
      this.lastSnapshot = now;
      this.publish(vis, cw, ch, map);
    }
  };

  // Face scan: corner ticks, sweeping scan line, landmark points and an ID tag.
  drawFace(f, map, col, now) {
    const { ctx } = this;
    const [x, y, w, h] = map(f.drawBox);
    const known = !!f.name;
    const color = known ? LEARNED : col.main;
    const age = Math.min(1, (performance.now() - f.born) / 600);
    const L = w * 0.18;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(px + dx * L, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * L);
    }
    ctx.stroke();

    // scan line (fast while acquiring, slow once known)
    const period = known ? 2600 : 1100;
    const p = (now % period) / period;
    const sy = y + h * (p < 0.5 ? p * 2 : 2 - p * 2);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.35 * age;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'transparent');
    g.addColorStop(0.5, color);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(x, sy - 1, w, 2);

    // faint mesh
    ctx.globalAlpha = 0.12 * age;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo(x + (w * i) / 4, y); ctx.lineTo(x + (w * i) / 4, y + h);
      ctx.moveTo(x, y + (h * i) / 4); ctx.lineTo(x + w, y + (h * i) / 4);
    }
    ctx.stroke();

    // landmarks: eyes, nose, mouth, ears
    ctx.globalAlpha = 0.85 * age;
    ctx.fillStyle = color;
    const pts = (f.landmarks || []).map((pt) => map.point(pt));
    pts.slice(0, 4).forEach(([lx, ly], i) => {
      ctx.beginPath();
      ctx.arc(lx, ly, i < 2 ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    if (pts.length >= 2) {
      ctx.globalAlpha = 0.4 * age;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]);
      if (pts[2]) { ctx.moveTo(...pts[0]); ctx.lineTo(...pts[2]); ctx.lineTo(...pts[1]); }
      if (pts[3] && pts[2]) { ctx.moveTo(...pts[2]); ctx.lineTo(...pts[3]); }
      ctx.stroke();
    }

    // ID tag under the face
    ctx.globalAlpha = 1;
    ctx.font = `600 11px ${MONO}`;
    const tag = known ? `ID ▸ ${f.name.toUpperCase()} · ${Math.round(f.sim * 100)}%` : 'ID ▸ SCANNING…';
    const tw = ctx.measureText(tag).width + 12;
    const ty = y + h + 6;
    ctx.fillStyle = 'rgba(2,10,18,0.78)';
    ctx.fillRect(x + w / 2 - tw / 2, ty, tw, 17);
    ctx.fillStyle = color;
    ctx.fillText(tag, x + w / 2 - tw / 2 + 6, ty + 12);
    ctx.restore();
  }

  // Centre focus ring with the classifier's best guess for whatever is in front of Chitti.
  drawFocus(focus, cw, ch, col, now) {
    if (!focus || Date.now() - focus.at > 3000 || focus.person) return;
    const name = focus.learned?.label || (focus.labels[0]?.prob > 0.25 ? focus.labels[0].label : null);
    if (!name) return;
    const { ctx } = this;
    const r = Math.min(cw, ch) * 0.16;
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.strokeStyle = focus.learned ? LEARNED : col.alt;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, r, now / 2000, now / 2000 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.font = `600 12px ${MONO}`;
    const pct = focus.learned ? 'LEARNED' : `${Math.round(focus.labels[0].prob * 100)}%`;
    const text = `FOCUS ▸ ${name.toUpperCase()} · ${pct} · ${focus.color.toUpperCase()}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(2,10,18,0.7)';
    ctx.fillRect(-tw / 2 - 8, r + 10, tw + 16, 20);
    ctx.fillStyle = focus.learned ? LEARNED : col.alt;
    ctx.fillText(text, -tw / 2, r + 24);
    ctx.restore();
  }

  drawBrackets(x, y, w, h, color, intro, now, strength = 1) {
    const { ctx } = this;
    const grow = 1 + (1 - intro) * 0.35;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const W = w * grow;
    const H = h * grow;
    const X = cx - W / 2;
    const Y = cy - H / 2;
    const L = Math.max(10, Math.min(W, H) * 0.14);
    const base = ctx.globalAlpha;

    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    ctx.globalAlpha = base * (0.4 + 0.6 * strength);
    ctx.beginPath();
    for (const [px, py, dx, dy] of [[X, Y, 1, 1], [X + W, Y, -1, 1], [X, Y + H, 1, -1], [X + W, Y + H, -1, -1]]) {
      ctx.moveTo(px + dx * L, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * L);
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    ctx.lineDashOffset = -now / 40;
    ctx.globalAlpha = base * 0.3 * strength;
    ctx.strokeRect(X, Y, W, H);
    ctx.setLineDash([]);

    if (intro < 1) {
      ctx.fillStyle = color;
      ctx.globalAlpha = base * 0.5;
      ctx.fillRect(X, Y + H * intro, W, 2);
    }
    ctx.globalAlpha = base;
  }

  drawLabel(t, x, y, w, h, color, alt) {
    const { ctx } = this;
    const who = t.source === 'face' ? ' ◆' : t.source === 'learned' ? ' ★' : '';
    const title = `T-${String(t.id).padStart(2, '0')}  ${nameOf(t).toUpperCase()}${who}`;
    const parts = [`${Math.round((t.source === 'imagenet' ? t.aliasProb : t.score) * 100)}%`, rangeOf(t, this.video.videoWidth, this.video.videoHeight)];
    if (t.color && t.cls !== 'person') parts.push(t.color.toUpperCase());
    if (t.alias && t.alias !== t.cls && t.source !== 'face') parts.push(`det: ${t.cls}`);
    const sub = parts.join(' · ');
    ctx.font = `600 12px ${MONO}`;
    const tw = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width) + 16;
    const lx = Math.max(4, Math.min(x, this.canvas.clientWidth - tw - 4));
    // Above the box if there's room below the top bar, otherwise tucked inside its top edge.
    let ly = y - 40;
    if (ly < TOP_SAFE) ly = Math.min(Math.max(y + 6, TOP_SAFE), y + h - 40);
    ctx.fillStyle = 'rgba(2,10,18,0.78)';
    ctx.fillRect(lx, ly, tw, 34);
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, 3, 34);
    ctx.fillText(title, lx + 9, ly + 14);
    ctx.fillStyle = alt;
    ctx.font = `11px ${MONO}`;
    ctx.fillText(sub, lx + 9, ly + 28);
  }

  drawLock(x, y, w, h, now, cw, ch) {
    const { ctx } = this;
    const cx = x + w / 2;
    const cy = y + h / 2.4;
    const r = Math.max(26, Math.min(w, h) * 0.32);
    const a = now / 700;
    ctx.save();
    ctx.strokeStyle = LOCK;
    ctx.shadowColor = LOCK;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;

    ctx.beginPath();
    for (let i = 0; i < 4; i++) ctx.arc(cx, cy, r, a + (i * Math.PI) / 2, a + (i * Math.PI) / 2 + 1.0);
    ctx.stroke();

    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, -a * 1.6, -a * 1.6 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const pulse = r * (1.15 + 0.12 * Math.sin(now / 160));
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * r * 0.3, cy + dy * r * 0.3);
      ctx.lineTo(cx + dx * pulse, cy + dy * pulse);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.25;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(cx - pulse, cy);
    ctx.moveTo(cx + pulse, cy); ctx.lineTo(cw, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - pulse);
    ctx.moveTo(cx, cy + pulse); ctx.lineTo(cx, ch);
    ctx.stroke();

    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 120);
    ctx.fillStyle = LOCK;
    ctx.font = '700 12px Orbitron, sans-serif';
    ctx.fillText('◆ TARGET LOCKED', cx - r, cy + r + 20);
    ctx.restore();
  }

  // Hazards need confidence AND persistence, so a stick doesn't become a "baseball bat" alarm.
  // A classifier rename wins: a COCO "knife" that MobileNet calls "spoon" is not a hazard.
  assessHazards(vis, map) {
    const now = performance.now();
    const out = [];
    const cw = this.canvas.clientWidth;
    const people = vis.filter((t) => t.cls === 'person');
    for (const t of vis) {
      if (t.cls === 'person') continue;
      const h = t.source ? hazardOf(t.alias) : hazardOf(t.cls);
      const strong = t.source === 'imagenet' ? t.aliasProb >= 0.35 : t.score >= 0.6;
      if (!h || !strong) {
        t.hazardSince = null;
        t.hazard = null;
        continue;
      }
      t.hazardSince ??= now;
      if (now - t.hazardSince < HAZARD_CONFIRM_MS) continue;
      t.hazard = h;
      const [x, , w] = map(t.box);
      const nx = (x + w / 2) / cw;
      out.push({ ...h, id: t.id, source: 'track', side: nx < 0.36 ? 'left' : nx > 0.64 ? 'right' : 'centre', nearPerson: people.some((p) => overlaps(t.target, p.target)) });
    }
    // Something dangerous held up in the middle of the view (the classifier sees it, the detector may not).
    const f = store().focus;
    const top = f && Date.now() - f.at < 1500 && !f.person ? f.labels[0] : null;
    const fh = top && top.prob >= 0.45 ? hazardOf(top.label) : null;
    this.focusHazardHits = fh ? (this.focusHazardHits || 0) + 1 : 0;
    if (fh && this.focusHazardHits >= 3 && !out.some((o) => o.name === fh.name)) {
      out.push({ ...fh, id: null, source: 'focus', side: 'centre', nearPerson: people.length > 0 });
    }
    return out;
  }

  drawHazard(t, x, y, w, h, now) {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(now / 110);
    ctx.save();
    ctx.strokeStyle = LOCK;
    ctx.shadowColor = LOCK;
    ctx.shadowBlur = 18 * pulse;
    ctx.lineWidth = 2 + pulse * 1.5;
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
    // warning tag with hazard stripes, below the box
    const label = `⚠ ${KIND_LABEL[t.hazard.kind]}`;
    ctx.font = '700 12px Orbitron, sans-serif';
    const tw = ctx.measureText(label).width + 20;
    const tx = x + w / 2 - tw / 2;
    const ty = Math.min(y + h + 10, this.canvas.clientHeight - 30);
    ctx.globalAlpha = 0.92;
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#2a0006';
    ctx.fillRect(tx, ty, tw, 22);
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx, ty, tw, 4);
    ctx.clip();
    ctx.fillStyle = '#ffb020';
    for (let sx = tx - 10 + ((now / 30) % 10); sx < tx + tw; sx += 10) {
      ctx.beginPath();
      ctx.moveTo(sx, ty + 4); ctx.lineTo(sx + 4, ty); ctx.lineTo(sx + 8, ty); ctx.lineTo(sx + 4, ty + 4);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = LOCK;
    ctx.fillText(label, tx + 10, ty + 17);
    ctx.restore();
  }

  publish(vis, cw, ch, map) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const tracks = vis
      .map((t) => {
        const [x, y, w, h] = map(t.box);
        const nx = (x + w / 2) / cw;
        return {
          id: t.id, cls: t.cls, name: nameOf(t), source: t.source || null, color: t.color || null,
          score: t.source === 'imagenet' ? t.aliasProb : t.score, range: rangeOf(t, vw, vh),
          nx, ny: (y + h / 2) / ch, area: (t.box[2] * t.box[3]) / (vw * vh || 1),
          side: nx < 0.36 ? 'left' : nx > 0.64 ? 'right' : 'centre',
        };
      })
      .sort((a, b) => b.area - a.area);
    const hazards = this.assessHazards(vis, map);
    store().set({ tracks, hazards, threat: threatOf(vis, hazards) });
    setVision({ fps: Math.round(this.fps) });
  }
}

export const vision = { engine: null };
