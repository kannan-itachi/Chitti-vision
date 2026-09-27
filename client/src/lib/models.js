// Model loaders. Each model is served from /models (downloaded by `npm run models`)
// so vision works with no internet; the public CDN is only a fallback.
let tfPromise = null;
export function loadTf() {
  tfPromise ??= import('@tensorflow/tfjs').then(async (tf) => {
    await tf.ready();
    return tf;
  });
  return tfPromise;
}

async function localFirst(local, remote) {
  try {
    return { model: await local(), offline: true };
  } catch {
    return { model: await remote(), offline: false };
  }
}

const detectors = {};
export function loadDetector(quality = 'accurate') {
  detectors[quality] ??= (async () => {
    await loadTf();
    const coco = await import('@tensorflow-models/coco-ssd');
    const base = quality === 'fast' ? 'lite_mobilenet_v2' : 'mobilenet_v2';
    const dir = quality === 'fast' ? 'ssdlite_mobilenet_v2' : 'ssd_mobilenet_v2';
    return localFirst(
      () => coco.load({ base, modelUrl: `/models/${dir}/model.json` }),
      () => coco.load({ base }),
    );
  })().catch((e) => {
    delete detectors[quality];
    throw e;
  });
  return detectors[quality];
}

let facePromise = null;
export function loadFaceDetector() {
  facePromise ??= (async () => {
    await loadTf();
    const blazeface = await import('@tensorflow-models/blazeface');
    const opts = { maxFaces: 5, scoreThreshold: 0.8 };
    return localFirst(
      () => blazeface.load({ ...opts, modelUrl: '/models/blazeface/model.json' }),
      () => blazeface.load(opts),
    );
  })().catch((e) => {
    facePromise = null;
    throw e;
  });
  return facePromise;
}

let classifierPromise = null;
export function loadClassifier() {
  classifierPromise ??= (async () => {
    await loadTf();
    const mobilenet = await import('@tensorflow-models/mobilenet');
    return localFirst(
      () => mobilenet.load({ version: 2, alpha: 1.0, modelUrl: '/models/mobilenet_v2/model.json', inputRange: [0, 1] }),
      () => mobilenet.load({ version: 2, alpha: 1.0 }),
    );
  })().catch((e) => {
    classifierPromise = null;
    throw e;
  });
  return classifierPromise;
}
