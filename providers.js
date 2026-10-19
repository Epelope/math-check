// AI providers for Math Check. Each adapter takes normalized messages and returns {ok, text} or {ok:false, status, msg}.
// A message is {role: 'user' | 'assistant', parts: [{text} | {pdf: base64}]}.
// Keys are the user's own and are sent only to the provider they chose, straight from the browser.
(function () {
  const PROVIDERS = {
    gemini: { label: 'Gemini (Google)', keyUrl: 'https://aistudio.google.com/apikey', pdf: 'native', needsKey: true },
    anthropic: { label: 'Claude (Anthropic)', keyUrl: 'https://console.anthropic.com/settings/keys', pdf: 'native', needsKey: true },
    openai: { label: 'ChatGPT (OpenAI)', keyUrl: 'https://platform.openai.com/api-keys', pdf: 'native', needsKey: true },
    openrouter: { label: 'OpenRouter (many models)', keyUrl: 'https://openrouter.ai/keys', pdf: 'text', needsKey: true },
    custom: { label: 'Custom or local (OpenAI-compatible, e.g. Ollama)', keyUrl: '', pdf: 'text', needsKey: false },
  };

  const JSON_NOTE = ' Reply with ONLY one valid JSON object and nothing else (no code fences, no commentary).';

  async function send(url, init, label) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError' ? 'Request timed out after 60 seconds' : (e.message || 'Network error') + (label === 'custom' ? ' (is the server running, and does it allow this site? For Ollama set OLLAMA_ORIGINS)' : '');
      return { ok: false, status: 0, msg };
    }
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  const errMsg = (data, status, name) => (data && (data.error && (data.error.message || data.error))) || (data && data.message) || name + ' error ' + status;

  async function gemini(model, a, conn) {
    const contents = a.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.parts.map((p) => (p.pdf ? { inlineData: { mimeType: 'application/pdf', data: p.pdf } } : { text: p.text })),
    }));
    const generationConfig = { temperature: 0.2 };
    if (a.json) generationConfig.responseMimeType = 'application/json';
    if (a.thinking === false && /2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const r = await send(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': conn.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: a.system }] }, contents, generationConfig }),
    }, 'gemini');
    if (!r.res) return r;
    if (!r.res.ok) return { ok: false, status: r.res.status, msg: errMsg(r.data, r.res.status, 'Gemini') };
    const text = ((r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
    return { ok: true, text };
  }

  async function anthropic(model, a, conn) {
    const messages = a.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.parts.map((p) => (p.pdf ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.pdf } } : { type: 'text', text: p.text })),
    }));
    const r = await send('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': conn.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 8192, system: a.system + (a.json ? JSON_NOTE : ''), messages }),
    }, 'anthropic');
    if (!r.res) return r;
    if (!r.res.ok) return { ok: false, status: r.res.status, msg: errMsg(r.data, r.res.status, 'Claude') };
    return { ok: true, text: (r.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') };
  }

  const OPENAI_BASES = { openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1' };

  async function openaiLike(provider, model, a, conn) {
    const base = (provider === 'custom' ? conn.baseUrl : OPENAI_BASES[provider] || '').replace(/\/+$/, '');
    if (!base) return { ok: false, status: 0, msg: 'Add the server address in Settings first' };
    const messages = [{ role: 'system', content: a.system + (a.json && provider !== 'openai' ? JSON_NOTE : '') }].concat(
      a.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.parts.map((p) => (p.pdf
          ? { type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,' + p.pdf } }
          : { type: 'text', text: p.text })),
      }))
    );
    const body = { model, messages };
    if (a.json && provider === 'openai') body.response_format = { type: 'json_object' };
    const headers = { 'Content-Type': 'application/json' };
    if (conn.key) headers.Authorization = 'Bearer ' + conn.key;
    const r = await send(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }, provider);
    if (!r.res) return r;
    if (!r.res.ok) return { ok: false, status: r.res.status, msg: errMsg(r.data, r.res.status, PROVIDERS[provider].label) };
    const c = r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    const text = Array.isArray(c) ? c.map((x) => x.text || '').join('') : String(c || '');
    return { ok: true, text };
  }

  function call(provider, conn, model, a) {
    if (provider === 'gemini') return gemini(model, a, conn);
    if (provider === 'anthropic') return anthropic(model, a, conn);
    return openaiLike(provider, model, a, conn);
  }

  // ----- model lists: ask the provider what this key can use, so we never rely on model names from memory -----
  async function listModels(provider, conn) {
    let url;
    let init = { headers: {} };
    if (provider === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200'; init.headers['x-goog-api-key'] = conn.key; }
    else if (provider === 'anthropic') { url = 'https://api.anthropic.com/v1/models?limit=100'; init.headers = { 'x-api-key': conn.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }; }
    else if (provider === 'openai') { url = OPENAI_BASES.openai + '/models'; init.headers.Authorization = 'Bearer ' + conn.key; }
    else if (provider === 'openrouter') { url = OPENAI_BASES.openrouter + '/models'; }
    else { url = (conn.baseUrl || '').replace(/\/+$/, '') + '/models'; if (conn.key) init.headers.Authorization = 'Bearer ' + conn.key; }
    const r = await send(url, init, provider);
    if (!r.res) throw new Error(r.msg);
    if (!r.res.ok) throw new Error(errMsg(r.data, r.res.status, PROVIDERS[provider].label));
    const d = r.data;
    if (provider === 'gemini') {
      return (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => ({ id: m.name.replace(/^models\//, '') }));
    }
    const arr = d.data || d.models || [];
    return arr.map((m) => ({ id: m.id || m.name, created: m.created_at ? Date.parse(m.created_at) / 1000 : m.created || 0 })).filter((m) => m.id);
  }

  // Pick a strong model for setup/chat/keys and a fast, cheaper one for per-line checks.
  function autoPick(provider, list) {
    const ids = list.map((m) => m.id);
    const newest = (arr) => arr.slice().sort((a, b) => (b.created || 0) - (a.created || 0) || (a.id < b.id ? 1 : -1))[0];
    const only = (re, not) => list.filter((m) => re.test(m.id) && !(not && not.test(m.id)));
    if (provider === 'gemini') {
      const flash = list
        .map((m) => ({ id: m.id, v: /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(m.id) }))
        .filter((x) => x.v)
        .sort((a, b) => parseFloat(b.v[1]) - parseFloat(a.v[1]));
      const plain = flash.find((x) => !x.v[2]);
      const lite = flash.find((x) => x.v[2]);
      return { model: plain ? plain.id : ids[0], checkModel: lite ? lite.id : plain ? plain.id : ids[0] };
    }
    if (provider === 'anthropic') {
      const main = newest(only(/sonnet/i)) || newest(list);
      const fast = newest(only(/haiku/i)) || main;
      return { model: main && main.id, checkModel: fast && fast.id };
    }
    if (provider === 'openai') {
      const bad = /(mini|nano|audio|realtime|image|tts|transcribe|search|instruct|codex|embedding|moderation|whisper|dall|davinci|babbage)/i;
      const main = newest(only(/^gpt-/i, bad)) || newest(list);
      const fast = newest(only(/^gpt-.*mini/i, /(audio|realtime|image|tts|transcribe|search)/i)) || main;
      return { model: main && main.id, checkModel: fast && fast.id };
    }
    return { model: ids[0] || '', checkModel: ids[0] || '' };
  }

  window.MCProviders = { PROVIDERS, call, listModels, autoPick };
})();
