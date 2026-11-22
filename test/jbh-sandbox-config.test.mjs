import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(new URL('../wrangler.sandbox.jsonc', import.meta.url), 'utf8');
const previewVars = config.split('"previews"')[1]?.split('"durable_objects"')[0] ?? '';
const productionVars = config.split('"vars"').at(-1) ?? '';

test('JussPay sandbox Worker is not publicly routable', () => {
  assert.match(config, /^\s*"name":\s*"jusspay-jbh-sandbox"/m);
  assert.match(config, /^\s*"workers_dev":\s*false\s*,?$/m);
  assert.match(config, /^\s*"preview_urls":\s*false\s*,?$/m);
});

test('sandbox preview cannot enable payment or live checkout', () => {
  for (const [key, value] of [
    ['STRIPE_LIVE', 'false'],
    ['PAYMENTS_ENABLED', 'false'],
    ['JBH_ORDERS_ENABLED', 'false'],
    ['JBH_STRIPE_LIVE', 'false'],
  ]) {
    assert.match(previewVars, new RegExp('"' + key + '"\\s*:\\s*"' + value + '"'));
  }
});

test('sandbox has no verified merchant identity until a distinct test account is approved', () => {
  assert.match(previewVars, /"JBH_TEST_ACCOUNT_ID"\s*:\s*""/);
  assert.doesNotMatch(config, /acct_[A-Za-z0-9]+/);
  assert.match(productionVars, /"JBH_ORDERS_ENABLED"\s*:\s*"false"/);
  assert.match(productionVars, /"JBH_STRIPE_LIVE"\s*:\s*"false"/);
});

test('preview Durable Objects are bound to isolated sandbox namespaces', () => {
  assert.match(config, /"previews"[\\s\\S]*?"durable_objects"\\s*:\\s*\\{/);
  const previewDurableObjects = config.split('"previews"')[1]?.split('"durable_objects"')[1]?.split('"vars"')[0] ?? '';
  assert.match(previewDurableObjects, /"name"\\s*:\\s*"BILLING"/);
  assert.match(previewDurableObjects, /"name"\\s*:\\s*"JBH_ORDERS"/);
});
