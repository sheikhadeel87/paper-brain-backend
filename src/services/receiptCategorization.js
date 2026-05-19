import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  DEFAULT_RECEIPT_CATEGORY,
  RECEIPT_CATEGORIES,
  normalizeReceiptCategory,
} from '../lib/receiptCategories.js';
import {
  advanceGeminiKeyIndexAfterQuota,
  advanceGeminiKeyIndexAfterSuccess,
  getGeminiApiKeys,
  isGeminiQuotaLikeError,
  peekGeminiKeyIndex,
} from '../lib/geminiApiKeyPool.js';

const categoryModelId = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

function itemText(items) {
  if (!Array.isArray(items) || items.length === 0) return 'None';
  return items
    .slice(0, 25)
    .map((item) => {
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      const price =
        item?.price === null || item?.price === undefined ? '' : ` (${item.price})`;
      return `${name}${price}`.trim();
    })
    .filter(Boolean)
    .join(', ');
}

export async function categorizeReceipt({ merchant, items, total }) {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) return DEFAULT_RECEIPT_CATEGORY;

  const prompt = `You are a receipt categorization assistant.

Categorize the receipt into exactly ONE category.

Allowed categories:
${RECEIPT_CATEGORIES.join('\n')}

Receipt:
Merchant: ${merchant || 'Unknown'}
Items: ${itemText(items)}
Total: ${total ?? ''}

Rules:
- Restaurants, cafes, fast food = Food
- Petrol pumps, gas stations = Fuel
- Supermarkets, grocery stores = Grocery
- Clothing, electronics, general retail = Shopping
- Electricity, internet, phone, utility payments = Bills
- Pharmacy, clinic, hospital = Medical
- Uber, Careem, bus, train, airline, hotel = Travel
- Cinema, games, events = Entertainment
- If unclear, return Other

Return only the category name. No explanation.`;

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const keyIdx = peekGeminiKeyIndex(keys.length);
    const apiKey = keys[keyIdx];
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: categoryModelId });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      advanceGeminiKeyIndexAfterSuccess(keys.length, keyIdx);
      return normalizeReceiptCategory(text);
    } catch (err) {
      if (isGeminiQuotaLikeError(err)) {
        advanceGeminiKeyIndexAfterQuota(keys.length);
        continue;
      }
      console.warn(
        '[receipt] categorization failed:',
        err instanceof Error ? err.message : err,
      );
      return DEFAULT_RECEIPT_CATEGORY;
    }
  }

  return DEFAULT_RECEIPT_CATEGORY;
}
