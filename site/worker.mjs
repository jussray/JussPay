// JussPay public presentation only. Never proxy checkout or private APIs.
const HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'public, max-age=300'
});

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/' && path !== '/index.html')
      return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    const indexUrl = new URL('/index.html', request.url);
    const asset = await env.ASSETS.fetch(new Request(indexUrl, { method: 'GET' }));
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      status: asset.status,
      headers
    });
  }
};
