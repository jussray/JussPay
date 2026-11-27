import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';

const env = {
  ASSETS: {
    fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/index.html');
      return new Response('<!doctype html><title>JussPay preview</title>', {
        status: 200, headers: { 'content-type': 'text/html' }
      });
    }
  }
};

test('root serves safe public HTML only', async () => {
  const response = await worker.fetch(new Request('https://jusspay.jussco.company/'), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /JussPay preview/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('HEAD serves headers but no body', async () => {
  const response = await worker.fetch(new Request('https://jusspay.jussco.company/', { method: 'HEAD' }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('public worker rejects protected payment routes', async () => {
  for (const path of ['/checkout', '/webhook', '/jbh/checkout', '/health', '/version', '/subscriptions/orders']) {
    const response = await worker.fetch(new Request('https://jusspay.jussco.company' + path), env);
    assert.equal(response.status, 404, path);
  }
});

test('public worker never accepts POST requests', async () => {
  const response = await worker.fetch(new Request('https://jusspay.jussco.company/', { method: 'POST' }), env);
  assert.equal(response.status, 405);
});
