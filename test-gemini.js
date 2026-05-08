import './src/bootEnv.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiApiKeys } from './src/lib/geminiApiKeyPool.js';

const modelId = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

async function testGemini() {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    console.error(
      '❌ No Gemini keys (set GEMINI_API_KEY comma-separated or GEMINI_API_KEYS in .env)',
    );
    process.exit(1);
  }
  const apiKey = keys[0];
  console.log(`Using first of ${keys.length} key(s), model:`, modelId);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelId });
    const result = await model.generateContent('Reply with one word: ok');
    console.log('✅ Gemini response:', result.response.text());
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testGemini();
