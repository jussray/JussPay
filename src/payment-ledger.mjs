// Append-only, minimized payment ledger records shared by JussPay payment lanes.
// This is an internal audit primitive, not a payout or accounting general ledger.
const MODES = new Set(['sandbox','live']);
const STATUSES = new Set(['pending','paid','payment_failed','expired','refunded','partially_refunded','disputed','reconciliation_required']);
const REFERENCE_TYPES = new Set(['order','subscription','charge']);

export function buildPaymentLedgerEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_ledger_entry');
  const {merchantId,source,eventId,eventType,orderId,referenceType='order',status,amountMinor,currency,mode,paymentIntentId=null,recordedAt=Date.now()} = input;
  if (typeof merchantId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(merchantId) ||
      typeof source !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(source) ||
      typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(eventId) ||
      typeof eventType !== 'string' || !/^[a-z][a-z0-9_.-]{2,99}$/.test(eventType) ||
      typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(orderId) || !REFERENCE_TYPES.has(referenceType) ||
      !STATUSES.has(status) || !Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
      typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency) || !MODES.has(mode) ||
      (paymentIntentId !== null && (typeof paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId))) ||
      !Number.isSafeInteger(recordedAt) || recordedAt < 0) throw new TypeError('invalid_ledger_entry');
  return Object.freeze({merchantId,source,eventId,eventType,referenceType,orderId,status,amountMinor,currency,mode,paymentIntentId,recordedAt});
}

// Call only inside the owning Durable Object's serialized transaction. Existing keys
// are never overwritten, so duplicate delivery cannot rewrite financial history.
export async function appendPaymentLedgerEntry(transaction, entry) {
  const key = `ledger:${entry.merchantId}:${entry.eventId}`;
  if (await transaction.get(key)) return false;
  await transaction.put(key, entry);
  return true;
}
