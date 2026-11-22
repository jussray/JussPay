// Stamp the exact Git commit into the Cloudflare production Worker at build time.
// No credentials or runtime bindings are read or changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function stampReleaseConfig(raw, sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('WORKERS_CI_COMMIT_SHA must be a full lowercase Git SHA');
  }
  const cfg = JSON.parse(raw);
  if (!cfg?.vars || cfg.name !== 'jusspay' ||
      cfg.vars.JBH_LIVE_CHARGES_APPROVED !== 'false' || cfg.vars.STRIPE_LIVE !== 'false') {
    throw new Error('Refusing to stamp unsafe production payment settings');
  }
  const preview = cfg.previews;
  if (!preview?.vars || preview.services ||
      ['STRIPE_LIVE', 'JBH_ORDERS_ENABLED', 'JBH_STRIPE_LIVE',
       'JBH_LIVE_CHARGES_APPROVED', 'JBH_PRIVATE_RECEIPTS_ENABLED']
        .some(key => preview.vars[key] !== 'false')) {
    throw new Error('Refusing to stamp unsafe preview configuration');
  }
  cfg.vars.RELEASE_SHA = sha;
  return JSON.stringify(cfg, null, 2) + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.WORKERS_CI_BRANCH !== 'main' || process.env.WORKERS_CI !== '1') {
    throw new Error('Only the Cloudflare Workers Builds main release can stamp production');
  }
  const configPath = new URL('../wrangler.jsonc', import.meta.url);
  const stamped = stampReleaseConfig(readFileSync(configPath, 'utf8'), process.env.WORKERS_CI_COMMIT_SHA);
  writeFileSync(configPath, stamped);
  console.log('Stamped JussPay production release at', process.env.WORKERS_CI_COMMIT_SHA);
}
