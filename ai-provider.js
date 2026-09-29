const PROVIDERS = new Set(['openai', 'openrouter']);

function providerSettings() {
  const provider = String(process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  if (!PROVIDERS.has(provider)) throw Object.assign(new Error('AI provider is not supported.'), { code: 'configuration' });
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
  const model = process.env.AI_MODEL || (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.OPENROUTER_MODEL);
  if (!key || !model) throw Object.assign(new Error('AI reasoning is not configured.'), { code: 'configuration' });
  return { provider, key, model, url: provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions' };
}

export async function generateCopilotResponse({ system, history, message, timeoutMs = 15_000 }) {
  const settings = providerSettings();
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json' };
      if (settings.provider === 'openrouter') { if (process.env.APP_URL) headers['HTTP-Referer'] = process.env.APP_URL; headers['X-Title'] = 'Nexora AI'; }
      const response = await fetch(settings.url, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify({ model: settings.model, temperature: 0.3, max_tokens: 350, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: message }] }) });
      if (!response.ok) {
        const status = response.status, code = status === 401 || status === 403 ? 'configuration' : status === 429 ? 'rate_limit' : 'provider';
        if (attempt === 0 && (status === 429 || status >= 500)) { await new Promise(resolve => setTimeout(resolve, 350)); continue; }
        throw Object.assign(new Error('AI provider request failed.'), { code, status });
      }
      let payload;
      try { payload = await response.json(); } catch { throw Object.assign(new Error('AI provider returned invalid JSON.'), { code: 'invalid_response' }); }
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('AI provider returned an empty response.'), { code: 'invalid_response' });
      return { text: text.trim().slice(0, 1800), provider: settings.provider, model: settings.model, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (error.name === 'AbortError') {
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 350)); continue; }
        throw Object.assign(new Error('AI provider timed out.'), { code: 'timeout' });
      }
      if (attempt === 0 && error instanceof TypeError) { await new Promise(resolve => setTimeout(resolve, 350)); continue; }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  throw Object.assign(new Error('AI provider request failed.'), { code: 'provider' });
}

export function currentProvider() {
  const provider = String(process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY;
  const model = process.env.AI_MODEL || (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.OPENROUTER_MODEL);
  return { provider: PROVIDERS.has(provider) ? provider : 'unavailable', configured: Boolean(key && model) };
}
