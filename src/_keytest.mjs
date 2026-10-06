// Dev helper: diagnose what the ANTHROPIC key can do. Never prints the key.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const key = process.env.ANTHROPIC_API_KEY || '';
console.log('key prefix:', key.slice(0, 11), 'len', key.length);
try { const m = await c.models.list(); console.log('models:', m.data.map(x => x.id).slice(0, 15)); }
catch (e) { console.log('models.list ->', e.status, String(e.message).slice(0, 200)); }
for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']) {
  try {
    const r = await c.messages.create({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Say hi' }] });
    console.log(model, '-> ok:', r.content[0]?.text);
  } catch (e) { console.log(model, '->', e.status, String(e.message).slice(0, 160)); }
}
