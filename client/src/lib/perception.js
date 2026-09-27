// Offline perception beyond the 80-class detector:
//  • MobileNet v2 (1000 ImageNet classes) gives a second opinion on each box and on
//    whatever is in the centre of the view — this is what turns "toilet" into "electric fan".
//  • BlazeFace finds faces (with eye/nose/mouth landmarks) for the face-scan HUD and
//    for recognising people the user has introduced ("my name is Kanna").
//  • Learned objects and faces: MobileNet embeddings + cosine k-NN, taught by voice and
//    saved in this browser. No server, no internet.
//  • Colour naming, motion and light sensing from tiny downscaled frames.
import { store } from '../store';
import { loadClassifier, loadFaceDetector } from './models';

const KEYS = { object: 'chitti.learned.v1', face: 'chitti.faces.v1' };
// Cosine similarity needed to recognise something, and the lead it needs over the runner-up.
// Faces all look alike to a general-purpose network, so they need a stricter match.
const MATCH = { object: { sim: 0.8, margin: 0.025 }, face: { sim: 0.87, margin: 0.02 } };
const MAX_PER_LABEL = 40;

// ImageNet has no "person" class, so on people it guesses clothing and accessories.
const PERSONISH = new Set(['shower cap', 'wig', 'band aid', 'jersey', 'sweatshirt', 'suit', 'bow tie', 'windsor tie', 'neck brace',
  'ski mask', 'mask', 'gasmask', 'lab coat', 'cardigan', 'bulletproof vest', 'bib', 'abaya', 'kimono', 'poncho', 'stole', 'fur coat',
  'trench coat', 'military uniform', 'pajama', 'swimming trunks', 'bikini', 'maillot', 'brassiere', 'lipstick', 'hair spray',
  'face powder', 'sunglasses', 'sunglass', 'dark glasses', 'spectacles', 'hair slide', 'cowboy hat', 'sombrero', 'mortarboard',
  'bonnet', 'crash helmet', 'football helmet', 'hoopskirt', 'miniskirt', 'overskirt', 'sarong', 'vestment', 'academic gown',
  'wool', 'velvet', 'apron', 'chain mail', 'breastplate', 'cuirass', 'oxygen mask', 'hand blower', 'hook', 'whistle']);
export const isPersonish = (label) => PERSONISH.has(label);

const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = 224;
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

const tiny = document.createElement('canvas');
tiny.width = 48;
tiny.height = 27;
const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });

export const cleanLabel = (l) => l.split(',')[0].trim().toLowerCase();

// ---------- learned memory (objects + faces) ----------

function b64(f32) {
  const bytes = new Uint8Array(f32.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const memory = { object: {}, face: {} }; // kind -> label -> Float32Array[]
for (const kind of Object.keys(KEYS)) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS[kind]) || '{}');
    for (const [label, list] of Object.entries(raw)) memory[kind][label] = list.map(unb64);
  } catch { /* corrupted or blocked storage */ }
}

function saveMemory(kind) {
  const raw = Object.fromEntries(Object.entries(memory[kind]).map(([k, v]) => [k, v.map(b64)]));
  try {
    localStorage.setItem(KEYS[kind], JSON.stringify(raw));
  } catch {
    store().toast('Browser storage is full — could not save what I learned.', 'warn');
  }
  publishLearned();
}

function publishLearned() {
  store().set({
    learned: Object.entries(memory).flatMap(([kind, m]) => Object.entries(m).map(([label, v]) => ({ label, kind, count: v.length }))),
  });
}
publishLearned();

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function recognize(vec, kind = 'object') {
  let best = null;
  let second = 0;
  for (const [label, list] of Object.entries(memory[kind])) {
    const sims = list.map((e) => dot(e, vec)).sort((a, b) => b - a).slice(0, 3);
    const score = sims.reduce((a, b) => a + b, 0) / sims.length;
    if (!best || score > best.sim) {
      second = best?.sim ?? second;
      best = { label, sim: score };
    } else if (score > second) second = score;
  }
  const { sim, margin } = MATCH[kind];
  if (best && best.sim >= sim && best.sim - second >= margin) return best;
  return null;
}

export function forget(label) {
  for (const kind of Object.keys(memory)) {
    const key = Object.keys(memory[kind]).find((k) => k.toLowerCase() === label.toLowerCase() || k.toLowerCase().includes(label.toLowerCase()));
    if (key) {
      delete memory[kind][key];
      saveMemory(kind);
      return key;
    }
  }
  return null;
}

export const learnedLabels = (kind) => (kind ? Object.keys(memory[kind]) : [...Object.keys(memory.object), ...Object.keys(memory.face)]);

// ---------- perception engine ----------

class Perception {
  constructor() {
    this.model = null;
    this.faceModel = null;
    this.prevGray = null;
  }

  async init() {
    if (this.model) return this.model;
    store().merge('vision', { classifier: 'loading' });
    try {
      const { model, offline } = await loadClassifier();
      this.model = model;
      store().merge('vision', { classifier: 'ready', classifierOffline: offline });
    } catch {
      store().merge('vision', { classifier: 'error' });
    }
    return this.model;
  }

  async initFaces() {
    if (this.faceModel) return this.faceModel;
    try {
      const { model } = await loadFaceDetector();
      this.faceModel = model;
      store().merge('vision', { faces: 'ready' });
    } catch {
      store().merge('vision', { faces: 'error' });
    }
    return this.faceModel;
  }

  // Faces in video pixel coords (unmirrored): { box:[x,y,w,h], landmarks:[[x,y]…], score }.
  async detectFaces(video) {
    if (!this.faceModel) return [];
    const raw = await this.faceModel.estimateFaces(video, false);
    return raw.map((f) => {
      const [x1, y1] = f.topLeft;
      const [x2, y2] = f.bottomRight;
      return { box: [x1, y1, x2 - x1, y2 - y1], landmarks: f.landmarks, score: Array.isArray(f.probability) ? f.probability[0] : f.probability };
    });
  }

  // Draw a region of the video (video pixel coords, unmirrored) into the 224×224 crop canvas.
  crop(video, [x, y, w, h], pad = 0.08) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const side = Math.min(Math.max(w, h) * (1 + pad * 2), vw, vh);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const sx = Math.max(0, Math.min(vw - side, cx - side / 2));
    const sy = Math.max(0, Math.min(vh - side, cy - side / 2));
    cropCtx.drawImage(video, sx, sy, side, side, 0, 0, 224, 224);
    return cropCanvas;
  }

  centerBox(video, frac = 0.5) {
    const s = Math.min(video.videoWidth, video.videoHeight) * frac;
    return [(video.videoWidth - s) / 2, (video.videoHeight - s) / 2, s, s];
  }

  async embed(canvas) {
    const emb = this.model.infer(canvas, true);
    const vec = await emb.data();
    emb.dispose();
    return normalize(Float32Array.from(vec));
  }

  // Classify + embed one crop. Pixels are read synchronously when each call starts.
  async analyze(canvas, topk = 3) {
    if (!this.model) return null;
    const emb = this.model.infer(canvas, true);
    const [vec, top] = await Promise.all([emb.data(), this.model.classify(canvas, topk)]);
    emb.dispose();
    return {
      labels: top.map((c) => ({ label: cleanLabel(c.className), prob: c.probability })),
      vec: normalize(Float32Array.from(vec)),
    };
  }

  async identifyRegion(video, box) {
    if (!this.model) return null;
    const canvas = this.crop(video, box);
    // The crop canvas is shared: read everything from it before the first await.
    const color = dominantColor(cropCtx);
    const r = await this.analyze(canvas);
    return r && { labels: r.labels, learned: recognize(r.vec, 'object'), color };
  }

  async identifyFace(video, faceBox) {
    if (!this.model) return null;
    return recognize(await this.embed(this.crop(video, faceBox, 0.22)), 'face');
  }

  // Take several slightly jittered views of the region and remember them under `label`.
  async learn(video, box, label, { kind = 'object', samples = 8 } = {}) {
    if (!(await this.init())) throw new Error('Recognition model is not available');
    const list = (memory[kind][label] ||= []);
    const pad = kind === 'face' ? 0.22 : 0.08;
    for (let i = 0; i < samples; i++) {
      const j = 0.08 * (Math.random() - 0.5);
      const [x, y, w, h] = box;
      list.push(await this.embed(this.crop(video, [x + w * j, y + h * j, w * (1 + j), h * (1 + j)], pad + Math.random() * 0.08)));
      await new Promise((res) => setTimeout(res, 120));
    }
    memory[kind][label] = list.slice(-MAX_PER_LABEL);
    saveMemory(kind);
    return memory[kind][label].length;
  }

  // Motion + brightness from a 48×27 grayscale frame. Side is as the user sees it (mirrored).
  sense(video) {
    tinyCtx.drawImage(video, 0, 0, tiny.width, tiny.height);
    const px = tinyCtx.getImageData(0, 0, tiny.width, tiny.height).data;
    const gray = new Uint8Array(tiny.width * tiny.height);
    let lum = 0;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
      lum += gray[i];
    }
    let changed = 0;
    let sumX = 0;
    if (this.prevGray) {
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - this.prevGray[i]) > 28) {
          changed++;
          sumX += i % tiny.width;
        }
      }
    }
    this.prevGray = gray;
    const motion = changed / gray.length;
    const cx = changed ? 1 - sumX / changed / tiny.width : 0.5;
    return {
      motion,
      motionSide: motion > 0.02 ? (cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'centre') : null,
      brightness: Math.round(lum / gray.length),
    };
  }
}

export const perception = new Perception();

// ---------- colour naming ----------

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

function colorName(h, s, v) {
  if (v < 0.18) return 'black';
  if (s < 0.14) return v > 0.8 ? 'white' : v > 0.45 ? 'grey' : 'dark grey';
  if (h < 15 || h >= 345) return v < 0.45 ? 'maroon' : s < 0.45 ? 'pink' : 'red';
  if (h < 40) return v < 0.55 ? 'brown' : 'orange';
  if (h < 65) return v < 0.5 ? 'olive' : 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'cyan';
  if (h < 255) return v < 0.4 ? 'navy blue' : 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

// Dominant colour of the middle of the crop canvas (ignores the background edges).
export function dominantColor(ctx) {
  const d = ctx.getImageData(56, 56, 112, 112).data;
  const votes = {};
  for (let i = 0; i < d.length; i += 16) {
    const name = colorName(...rgbToHsv(d[i], d[i + 1], d[i + 2]));
    votes[name] = (votes[name] || 0) + 1;
  }
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}
