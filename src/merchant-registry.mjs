// Canonical merchant identity registry for the JussPay Payment OS.
// Merchant accounts are deliberately separate. Sandbox account IDs remain runtime evidence,
// never guessed from or copied out of live account IDs.
export const MERCHANTS = Object.freeze({
  jussco: Object.freeze({
    id: 'jussco',
    displayName: 'Juss & Co.',
    liveStripeAccountId: 'acct_1U4xNyRs4gw4sfJH',
    domain: 'jussco.company',
    productFamilies: Object.freeze(['portfolio-subscriptions', 'protect-memberships', 'prepaid-api-credits']),
  }),
  jussRayBeautyCo: Object.freeze({
    id: 'juss-ray-beauty-co',
    displayName: 'Juss Ray Beauty Co.',
    liveStripeAccountId: 'acct_1TfbELRp7J40bCrl',
    domain: 'jussbeautifulhair.com',
    productFamilies: Object.freeze(['physical-hair-orders']),
  }),
});

export const JUSSCO_LIVE_ACCOUNT_ID = MERCHANTS.jussco.liveStripeAccountId;
export const JBH_LIVE_ACCOUNT_ID = MERCHANTS.jussRayBeautyCo.liveStripeAccountId;

export function merchantById(id) {
  return Object.values(MERCHANTS).find(merchant => merchant.id === id) || null;
}

export function liveAccountBelongsToMerchant(merchantId, accountId) {
  const merchant = merchantById(merchantId);
  return Boolean(merchant && accountId === merchant.liveStripeAccountId);
}

export function assertDistinctLiveMerchantAccounts() {
  const accounts = Object.values(MERCHANTS).map(merchant => merchant.liveStripeAccountId);
  return new Set(accounts).size === accounts.length;
}
