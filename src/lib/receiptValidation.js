/**
 * Shared receipt / expense validation (upload + save flows).
 */

export function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    if (!item || typeof item.name !== 'string') return false;
    const name = item.name.trim();
    if (name.length < 3) return false;
    if (/^[^a-z]*$/i.test(name)) return false;
    return true;  
  });
}

const TOLERANCE = 0.5;

/**
 * Roll-up rows (SUBTOTAL, duplicate TOTAL line) must not be summed with product + fee
 * lines when checking against the receipt grand total.
 */
export function isRollupReceiptLine(name, price, receiptTotal) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (/^\s*subtotal\b/i.test(n) || /^\s*sub-total\b/i.test(n)) return true;
  const looksLikeTotalLabel =
    /^\s*(grand\s*)?total\b/i.test(n) ||
    /^\s*amount\s*due\b/i.test(n) ||
    /^\s*balance\s*due\b/i.test(n);
  if (!looksLikeTotalLabel) return false;
  const p = typeof price === 'number' && !Number.isNaN(price) ? price : null;
  const rt =
    typeof receiptTotal === 'number' && !Number.isNaN(receiptTotal)
      ? receiptTotal
      : null;
  if (p !== null && rt !== null && Math.abs(p - rt) < TOLERANCE) return true;
  return false;
}

function sumPricedLines(items, { skipRollups, receiptTotal }) {
  return items.reduce((acc, item) => {
    if (!item || typeof item.price !== 'number' || Number.isNaN(item.price)) {
      return acc;
    }
    if (
      skipRollups &&
      typeof item.name === 'string' &&
      isRollupReceiptLine(item.name, item.price, receiptTotal)
    ) {
      return acc;
    }
    return acc + item.price;
  }, 0);
}

/**
 * Checks that line items (excluding SUBTOTAL / duplicate TOTAL rows) reconcile with
 * `total`, optionally adding top-level `tax` when product lines are pre-tax only.
 */
export function validateTotals(items, total, tax = null) {
  const t = typeof total === 'number' && !Number.isNaN(total) ? total : Number(total);
  if (typeof t !== 'number' || Number.isNaN(t)) {
    return { sum: 0, isValid: false };
  }
  const hasPricedLine = items.some(
    (item) =>
      item &&
      typeof item.price === 'number' &&
      !Number.isNaN(item.price),
  );
  if (!hasPricedLine) {
    return { sum: 0, isValid: true };
  }

  let taxAdj = null;
  if (tax !== null && tax !== undefined && tax !== '') {
    const n = Number(tax);
    if (!Number.isNaN(n)) taxAdj = n;
  }

  const rawSum = sumPricedLines(items, { skipRollups: false, receiptTotal: t });
  const sumExclRollups = sumPricedLines(items, { skipRollups: true, receiptTotal: t });

  const checks = [
    () => Math.abs(sumExclRollups - t) < TOLERANCE,
    () =>
      taxAdj !== null && Math.abs(sumExclRollups + taxAdj - t) < TOLERANCE,
    () => Math.abs(rawSum - t) < TOLERANCE,
    () => taxAdj !== null && Math.abs(rawSum + taxAdj - t) < TOLERANCE,
  ];
  for (const ok of checks) {
    if (ok()) {
      return { sum: sumExclRollups, isValid: true };
    }
  }

  return {
    sum: sumExclRollups,
    isValid: false,
  };
}

export function normalizeCurrency(currency) {
  if (currency === undefined || currency === null || currency === '') {
    return 'USD';
  }
  const s = String(currency).trim();
  const map = {
    $: 'USD',
    USD: 'USD',
    usd: 'USD',
  };
  if (map[s] !== undefined) return map[s];
  const lower = s.toLowerCase();
  if (lower === 'usd') return 'USD';
  return s;
}

export function sanitizeItemPrices(items) {
  return items.map((item) => {
    const price = item?.price;
    if (
      typeof price === 'number' &&
      !Number.isNaN(price) &&
      (price <= 0 || price > 500)
    ) {
      return { ...item, price: null };
    }
    return { ...item };
  });
}

function hasMeaningfulVendor(vendor) {
  return typeof vendor === 'string' && vendor.trim().length >= 2;
}

function hasMeaningfulDate(date) {
  if (date === undefined || date === null || date === '') return false;
  const s = String(date).trim();
  if (!s || s === '1970-01-01') return false;
  return true;
}

function hasMeaningfulTotal(total) {
  if (total === undefined || total === null || total === '') return false;
  const n = Number(total);
  if (Number.isNaN(n) || !Number.isFinite(n)) return false;
  /** Zero is not a real receipt total for scoring — avoids +40 when UI shows $0.00 with no data. */
  return n > 0;
}

/**
 * MVP confidence: +30 vendor, +30 date, +40 total (max 100). Optional +5 when
 * priced line items reconcile with total (same rules as validateTotals).
 */
export function guidelineReceiptConfidence(aiData) {
  if (!aiData || typeof aiData !== 'object') return 0;
  let score = 0;
  if (hasMeaningfulVendor(aiData.vendor)) score += 30;
  if (hasMeaningfulDate(aiData.date)) score += 30;
  if (hasMeaningfulTotal(aiData.total)) score += 40;
  return Math.min(100, score);
}

/**
 * Mutates aiData: clean items, sane prices, currency, then sets confidence + flag
 * from guideline scoring (adjusted when totals/items disagree).
 */
export function applyReceiptValidation(aiData) {
  if (!aiData || typeof aiData !== 'object') return aiData;
  if (!Array.isArray(aiData.items)) {
    aiData.items = [];
  }
  aiData.items = cleanItems(aiData.items);
  aiData.items = sanitizeItemPrices(aiData.items);
  aiData.currency = normalizeCurrency(aiData.currency);

  const validation = validateTotals(aiData.items, aiData.total, aiData.tax);
  const noItems = !aiData.items || aiData.items.length === 0;
  const hasPricedLine = aiData.items.some(
    (item) =>
      item &&
      typeof item.price === 'number' &&
      !Number.isNaN(item.price),
  );

  let score = guidelineReceiptConfidence(aiData);
  if (validation.isValid && hasPricedLine) {
    score = Math.min(100, score + 5);
  }
  if (!validation.isValid) {
    score = Math.min(score, 70);
  }
  if (noItems) {
    score = Math.min(score, 60);
  }

  aiData.confidence = Math.max(0, Math.min(100, Math.round(score)));
  const autoOk =
    aiData.confidence >= 80 && validation.isValid && !noItems;
  aiData.confidence_flag = autoOk ? 'auto' : 'review';

  return aiData;
}
