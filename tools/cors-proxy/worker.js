// Minimal download proxy for the web version of Project Sunburn (Cloudflare Worker).
//
// Browsers only let a web page download from sites that allow it (CORS). archive.org does; most
// abandonware sites don't. Deploy this worker (free plan is enough), then enter
//     https://<your-worker>.workers.dev/?url=
// under Settings → "Download proxy" in the launcher. The desktop app does not need it.
//
// Only allow it for your own use: set ALLOWED_ORIGINS to the address you play on.
const ALLOWED_ORIGINS = ['https://emil007.github.io', 'http://localhost:8080'];

export default {
  async fetch(req) {
    const origin = req.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'access-control-allow-headers': 'x-referer',
      'access-control-expose-headers': 'content-length, content-disposition, content-type, x-final-url',
      'cross-origin-resource-policy': 'cross-origin',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403, headers: cors });
    const target = new URL(req.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return new Response('missing ?url=', { status: 400, headers: cors });
    const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', accept: '*/*' };
    const ref = req.headers.get('x-referer'); if (ref) headers.referer = ref;
    const r = await fetch(target, { headers, redirect: 'follow' });
    const h = new Headers(cors); h.set('x-final-url', r.url || target);
    for (const k of ['content-type', 'content-length', 'content-disposition']) { const v = r.headers.get(k); if (v) h.set(k, v); }
    return new Response(r.body, { status: r.status, headers: h });
  },
};
