import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(new URL('../wrangler.sandbox.jsonc', import.meta.url), 'utf8');
const previewVars = config.split('"previews"')[1]?.split('"durable_objects"')[0] ?? '';
const runtimeVars = config.split('"vars"').at(-1) ?? '';

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

test('sandbox pins the verified Beauty Co account identity in test mode only', () => {
  const account = '"JBH_TEST_ACCOUNT_ID": "acct_1TfbELRp7J40bCrl"';
  assert.ok(previewVars.includes(account));
  assert.ok(runtimeVars.includes(account));
  assert.doesNotMatch(config, /sk_(?:test|live)_/);
  assert.match(runtimeVars, /"JBH_ORDERS_ENABLED"\s*:\s*"false"/);
  assert.match(runtimeVars, /"JBH_STRIPE_LIVE"\s*:\s*"false"/);
});

test('preview Durable Objects are bound to isolated sandbox namespaces', () => {
  const previewBlock = config.slice(config.indexOf('"previews"'), config.lastIndexOf('"vars"'));
  assert.ok(previewBlock.includes('"durable_objects"'));
  assert.ok(previewBlock.includes('"name":"BILLING"'));
  assert.ok(previewBlock.includes('"name":"JBH_ORDERS"'));
});

const productionConfig = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('production deployment config preserves the live webhook path without authorizing live checkout', () => {
  assert.match(productionConfig, /"binding":\s*"AUTH"\s*,\s*"service":\s*"jusspay-auth"/);
  assert.match(productionConfig, /"JBH_ORDERS_ENABLED":\s*"true"/);
  assert.match(productionConfig, /"JBH_STRIPE_LIVE":\s*"true"/);
  assert.match(productionConfig, /"JBH_LIVE_CHARGES_APPROVED":\s*"false"/);
  assert.match(productionConfig, /"JBH_STOREFRONT_ORIGIN":\s*"https:\/\/jussbeautifulhair\.com"/);
  assert.match(productionConfig, /"STRIPE_LIVE":\s*"false"/);
  assert.match(productionConfig, /"APPROVED_PLANS":\s*"\{\}"/);
});

test('JussPay production Worker Previews are isolated and incapable of taking real payments', () => {
  const runtime = JSON.parse(productionConfig);
  const preview = runtime.previews;
  assert.ok(preview, 'Wrangler preview requires its own configuration');
  for (const key of [
    'STRIPE_LIVE', 'PAYMENTS_ENABLED', 'SUBSCRIPTIONS_TEST_ENABLED',
    'JBH_ORDERS_ENABLED', 'JBH_STRIPE_LIVE',
    'JBH_LIVE_CHARGES_APPROVED', 'JBH_PRIVATE_RECEIPTS_ENABLED'
  ]) {
    assert.equal(preview.vars[key], 'false', key + ' must stay off in branch previews');
  }
  assert.equal(preview.vars.APPROVED_PLANS, '{}');
  assert.equal(preview.vars.JBH_STOREFRONT_ORIGIN, 'https://preview.invalid');
  assert.equal(preview.vars.RELEASE_SHA, 'preview-not-production');
  assert.ok(!Object.hasOwn(preview, 'services'),
    'Preview service bindings could call production; do not bind AUTH here');
  assert.deepEqual(preview.durable_objects.bindings, [
    { name: 'BILLING', class_name: 'BillingAccount' },
    { name: 'JBH_ORDERS', class_name: 'JbhOrderBook' },
  ]);
  assert.ok(preview.durable_objects.bindings.every(b => !Object.hasOwn(b, 'script_name')));
  assert.equal(runtime.vars.JBH_STRIPE_LIVE, 'true',
    'Production config must be preserved unchanged');
  assert.equal(runtime.vars.JBH_LIVE_CHARGES_APPROVED, 'false');
});
