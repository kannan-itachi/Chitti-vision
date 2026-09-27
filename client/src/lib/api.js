async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const getHealth = () => fetch('/api/health', { signal: AbortSignal.timeout(4000) }).then(json);
export const listDocs = () => fetch('/api/docs').then(json);
export const deleteDoc = (id) => fetch(`/api/docs/${id}`, { method: 'DELETE' });
export const getMemory = () => fetch('/api/memory').then(json);
export const patchMemory = (body) =>
  fetch('/api/memory', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);

export async function wiki(q, { full = false, search = false } = {}) {
  try {
    return await fetch(`/api/wiki?q=${encodeURIComponent(q)}${full ? '&full=1' : ''}${search ? '&search=1' : ''}`).then(json);
  } catch (e) {
    // Backend down? Fall back to calling Wikipedia straight from the browser.
    if (!/No Wikipedia article/.test(e.message)) {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.replace(/ /g, '_'))}`);
      if (r.ok) {
        const d = await r.json();
        if (d.extract) return { title: d.title, extract: d.extract, image: d.thumbnail?.source, url: d.content_urls?.desktop?.page };
      }
    }
    throw e;
  }
}

// Retries once if the connection drops (e.g. the dev server restarted mid-upload).
export async function uploadDoc(file, onProgress) {
  try {
    return await uploadOnce(file, onProgress);
  } catch (e) {
    if (!e.network) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return uploadOnce(file, onProgress);
  }
}

// XHR (not fetch) so we get real upload progress for the scan animation.
function uploadOnce(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', '/api/docs');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* empty */ }
      xhr.status < 300 ? resolve(body) : reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(Object.assign(new Error('The upload connection dropped. Check that the server is running and try again.'), { network: true }));
    xhr.send(form);
  });
}

// POST + Server-Sent Events parsed from a fetch stream.
export async function streamChat(body, onEvent, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Neural link error (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
      buf = buf.slice(i + 2);
      if (line) onEvent(JSON.parse(line.slice(5)));
    }
  }
}
