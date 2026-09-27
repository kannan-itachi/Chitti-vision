// Downloads Chitti's vision models into client/public/models so vision works fully offline.
// Run once with internet:  npm run models
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'client', 'public', 'models');

const MODELS = [
  { dir: 'ssd_mobilenet_v2', url: 'https://storage.googleapis.com/tfjs-models/savedmodel/ssd_mobilenet_v2/model.json' },
  { dir: 'ssdlite_mobilenet_v2', url: 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json' },
  { dir: 'mobilenet_v2', url: 'https://tfhub.dev/google/imagenet/mobilenet_v2_100_224/classification/2/model.json?tfjs-format=file' },
  { dir: 'blazeface', url: 'https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1/model.json?tfjs-format=file' },
];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

for (const m of MODELS) {
  const dir = path.join(OUT, m.dir);
  if (await fs.access(path.join(dir, 'done')).then(() => true, () => false)) {
    console.log(`✓ ${m.dir.padEnd(22)} already downloaded`);
    continue;
  }
  await fs.mkdir(dir, { recursive: true });
  const res = await get(m.url);
  const base = new URL('.', m.url); // shards resolve next to model.json (each redirect is signed separately)
  const json = await res.json();
  await fs.writeFile(path.join(dir, 'model.json'), JSON.stringify(json));
  const shards = json.weightsManifest.flatMap((g) => g.paths);
  let bytes = 0;
  for (const p of shards) {
    const u = new URL(p, base);
    u.search = new URL(m.url).search;
    const buf = Buffer.from(await (await get(u.href)).arrayBuffer());
    bytes += buf.length;
    await fs.writeFile(path.join(dir, p), buf);
  }
  await fs.writeFile(path.join(dir, 'done'), '');
  console.log(`✓ ${m.dir.padEnd(22)} ${shards.length} shards, ${(bytes / 1048576).toFixed(1)} MB`);
}
// Offline OCR for screen analysis: tesseract.js downloads English data once into server/models.
{
  const cachePath = path.join(root, 'server', 'models', 'tesseract');
  await fs.mkdir(cachePath, { recursive: true });
  if (await fs.access(path.join(cachePath, 'eng.traineddata')).then(() => true, () => false)) {
    console.log('✓ tesseract (OCR)         already downloaded');
  } else {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, { cachePath, errorHandler: () => {} });
    await worker.terminate();
    console.log('✓ tesseract (OCR)         English data cached');
  }
}
console.log(`\nModels saved to ${path.relative(root, OUT)} and server/models — vision and OCR now work offline.`);
