// Wikipedia lookup for Chitti's knowledge core.
//  • lookup("india")                 → article summary (exact title, then search fallback)
//  • lookup("why is the sky blue", { search: true }) → best article for a natural question
//  • { full: true }                  → also the article's whole introduction, for "explain more"
const UA = 'ChittiVision/3.0 (educational BCA student project)';
const headers = { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' };
const API = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2';
const cache = new Map();

export class RateLimited extends Error {}

async function get(url) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
  if (res.status === 429) throw new RateLimited('Wikipedia is rate-limiting requests. Try again in a minute.');
  return res;
}

// "taj mahal" → "Taj_mahal" (titles are case-sensitive after the first letter; redirect=true resolves the rest).
const toTitle = (q) => {
  const t = q.trim().replace(/\s+/g, '_');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

async function summary(title) {
  const res = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(toTitle(title))}?redirect=true`);
  if (!res.ok) return null;
  const d = await res.json();
  if (!d.extract || d.type === 'disambiguation') return null;
  return {
    title: d.title,
    description: d.description || '',
    extract: d.extract,
    image: d.thumbnail?.source || null,
    url: d.content_urls?.desktop?.page || null,
  };
}

async function searchTitles(q, limit = 3) {
  const res = await get(`${API}&action=query&list=search&srlimit=${limit}&srsearch=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const d = await res.json();
  return (d?.query?.search || []).map((s) => s.title);
}

// The full lead section as plain text (several paragraphs) for deeper explanations.
async function intro(title) {
  const res = await get(`${API}&action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d?.query?.pages?.[0]?.extract?.trim() || null;
}

export async function lookup(q, { full = false, search = false } = {}) {
  const key = `${q.trim().toLowerCase()}|${full}|${search}`;
  if (cache.has(key)) return cache.get(key);

  let hit = search ? null : await summary(q);
  if (!hit) {
    for (const title of await searchTitles(q, search ? 3 : 1)) {
      hit = await summary(title);
      if (hit) break;
    }
  }
  if (hit && full) hit = { ...hit, full: (await intro(hit.title)) || hit.extract };
  if (hit) cache.set(key, hit);
  return hit;
}
