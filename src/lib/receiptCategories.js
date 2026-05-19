export const RECEIPT_CATEGORIES = [
  'Food',
  'Fuel',
  'Grocery',
  'Shopping',
  'Bills',
  'Medical',
  'Travel',
  'Entertainment',
  'Other',
];

export const DEFAULT_RECEIPT_CATEGORY = 'Other';

export const RECEIPT_CATEGORY_SOURCES = ['AI', 'MANUAL', 'RULE'];

export function normalizeReceiptCategory(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = RECEIPT_CATEGORIES.find(
    (category) => category.toLowerCase() === raw.toLowerCase(),
  );
  return match || DEFAULT_RECEIPT_CATEGORY;
}

export function isReceiptCategory(value) {
  return RECEIPT_CATEGORIES.includes(value);
}
