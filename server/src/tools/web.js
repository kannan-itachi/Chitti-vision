// Web search (DuckDuckGo HTML endpoint, no API key) and page reading. Results are only ever
// what the search engine returned — titles, links and snippets are passed through, never made up.
import { define, ToolError } from './registry.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ChittiVision/3.0';
const cache = new Map();

const decode = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();

function realUrl(href) {
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith('duckduckgo.com') && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
    return u.href;
  } catch {
    return null;
  }
}

export async function search(query, limit = 6) {
  const key = `${query.toLowerCase()}|${limit}`;
  if (cache.has(key) && Date.now() - cache.get(key).at < 10 * 60e3) return cache.get(key).results;
  let html;
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: `q=${encodeURIComponent(query)}&kl=in-en`,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new ToolError(`The search engine returned an error (${res.status}).`);
    html = await res.text();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('I cannot reach the internet to search right now.');
  }
  if (/anomaly-modal|challenge-form/i.test(html)) throw new ToolError('The search engine is temporarily blocking automated searches. Try again in a few minutes.');
  const results = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const b of blocks) {
    if (/result--ad/.test(b.slice(0, 200))) continue;
    const a = b.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = realUrl(a[1].replace(/&amp;/g, '&'));
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: decode(a[2]), url, site: new URL(url).hostname.replace(/^www\./, ''), snippet: sn ? decode(sn[1]) : '' });
    if (results.length >= limit) break;
  }
  cache.set(key, { at: Date.now(), results });
  return results;
}

// Main readable text of a web page (scripts, styles, navigation removed).
export async function readPage(url, maxChars = 6000) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError('That is not a valid web address.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new ToolError('I only read http and https pages.');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) throw new ToolError('I do not read local network pages.');
  let res;
  try {
    res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
  } catch {
    throw new ToolError(`I could not open ${u.hostname}.`);
  }
  if (!res.ok) throw new ToolError(`${u.hostname} returned an error (${res.status}).`);
  if (!/html|text/.test(res.headers.get('content-type') || '')) throw new ToolError('That page is not a readable web page.');
  const html = (await res.text()).slice(0, 2_000_000);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || u.hostname);
  const body = (html.match(/<(article|main)[\s\S]*?<\/\1>/i)?.[0] || html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n');
  const text = decode(body.replace(/\n/g, ' ¶ ')).split(' ¶ ').map((l) => l.trim()).filter((l) => l.split(' ').length > 5).join('\n').slice(0, maxChars);
  return { title, url: res.url, site: new URL(res.url).hostname.replace(/^www\./, ''), text };
}

define({
  name: 'web_search',
  category: 'WEB_SEARCH',
  description: 'Search the internet. Returns real result titles, links and snippets. Use for current information, news, prices, anything not in local memory.',
  params: {
    query: { type: 'string', required: true, max: 300, description: 'search terms' },
    read_top: { type: 'boolean', description: 'also read the top result page for a detailed answer' },
  },
  async run({ query, read_top = true }) {
    const results = await search(query);
    if (!results.length) return { say: `I searched for "${query}" but found no results.`, data: { query, results: [] } };
    let page = null;
    if (read_top) {
      for (const r of results.slice(0, 3)) {
        if (/youtube\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com/.test(r.url)) continue;
        try {
          page = await readPage(r.url, 5000);
          if (page.text.length > 300) break;
        } catch { page = null; }
      }
    }
    const say = `Top result for "${query}": ${results[0].title} from ${results[0].site}. ${results[0].snippet.slice(0, 220)}`;
    return { say, data: { query, results, page } };
  },
});

define({
  name: 'read_webpage',
  category: 'WEB_SEARCH',
  description: 'Read the main text of a web page so it can be summarised.',
  params: { url: { type: 'string', required: true, max: 2000, description: 'page URL' } },
  async run({ url }) {
    const p = await readPage(url, 8000);
    return { say: `I read "${p.title}" from ${p.site}.`, data: p };
  },
});

define({
  name: 'youtube_search',
  category: 'MEDIA',
  description: 'Build a YouTube search link for a topic (open it to see videos).',
  params: { query: { type: 'string', required: true, max: 200, description: 'what to search on YouTube' } },
  async run({ query }) {
    return { say: `Searching YouTube for ${query}.`, data: { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, query } };
  },
});

define({
  name: 'official_website',
  category: 'WEB_SEARCH',
  description: 'Find the official website of an organisation, product or service.',
  params: { name: { type: 'string', required: true, max: 200, description: 'e.g. ISRO, Python, Indian Railways' } },
  async run({ name }) {
    const results = await search(`${name} official website`, 8);
    const skip = /wikipedia\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|reddit\.com|quora\.com/;
    const best = results.find((r) => !skip.test(r.url));
    if (!best) throw new ToolError(`I could not identify an official website for ${name}.`);
    return { say: `The official website for ${name} looks like ${best.site}.`, data: { url: best.url, site: best.site, title: best.title, alternatives: results.slice(0, 4) } };
  },
});
