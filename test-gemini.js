import './src/bootEnv.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const modelId = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

async function testGemini() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY is missing (.env at repo root or backend/.env)');
    process.exit(1);
  }

  console.log('Using model:', modelId);

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
