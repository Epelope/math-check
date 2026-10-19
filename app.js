// Math Check — static app. Embedded Desmos + per-line AI checks. Your AI key lives only in this browser.
(function () {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PROVS = window.MCProviders.PROVIDERS;

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: still works this session */ } },
  };

  // ---------- settings (any provider, any model) ----------
  const GEMINI_DEFAULT = { model: 'gemini-3.8-flash', checkModel: 'gemini-3.5-flash-lite' };
  const RETIRED = /^gemini-(1\.|2\.0|2\.5)/;
  const emptyProv = () => ({ key: '', model: '', checkModel: '', baseUrl: '' });
  const saved = store.get('mc.cfg', {});
  const cfg = {
    v: 5,
    provider: PROVS[saved.provider] ? saved.provider : 'gemini',
    providers: saved.providers || {},
    googleClientId: saved.googleClientId || '',
    autoNext: saved.autoNext !== false,
  };
  Object.keys(PROVS).forEach((p) => { cfg.providers[p] = Object.assign(emptyProv(), cfg.providers[p] || {}); });
  if (saved.key && !cfg.providers.gemini.key) { // settings saved by an older version (Gemini only)
    cfg.providers.gemini.key = saved.key;
    cfg.providers.gemini.model = saved.model || '';
    cfg.providers.gemini.checkModel = saved.checkModel || '';
  }
  (function fixGemini() {
    const g = cfg.providers.gemini;
    if (!g.model || RETIRED.test(g.model)) g.model = GEMINI_DEFAULT.model;
    if (!g.checkModel || RETIRED.test(g.checkModel)) g.checkModel = GEMINI_DEFAULT.checkModel;
  })();
  const saveCfg = () => store.set('mc.cfg', { v: cfg.v, provider: cfg.provider, providers: cfg.providers, googleClientId: cfg.googleClientId, autoNext: cfg.autoNext });
  saveCfg();

  const cur = () => cfg.providers[cfg.provider];
  const connOf = () => ({ key: cur().key, baseUrl: cur().baseUrl });
  const isMock = () => (PROVS[cfg.provider].needsKey ? !cur().key : !cur().baseUrl);
  const mainModel = () => cur().model;
  const checkModelOf = () => cur().checkModel || cur().model;
  let lastModelUsed = '';

  // ---------- the AI ----------
    const SYS_BASE = 'You are an expert, careful math tutor and checker for all college-level math and math-heavy courses: arithmetic and algebra, precalculus, calculus, linear algebra, differential equations, probability and statistics, discrete math, and the math in physics and engineering (e.g. statics, circuits). FIRST work out what kind of problem this is, which course level it is from, and what method(s) a student at that level is expected to use; then tailor everything to that. The problem statement is the source of truth: use exactly what it says. Never assume it is a different type of problem, and never add terms, derivatives, conditions or numbers that are not written. If the problem as written does not make sense or is ambiguous, say so plainly instead of guessing. Double-check every arithmetic and algebra step before you state it, and verify answers by substituting back or differentiating when that is possible; if you are not sure, say you are not sure. HOW THIS APP WORKS (you cannot see the screen, so rely on this): the student works inside a web app called Math Check. The problem is shown at the top. Below it is an embedded Desmos graphing calculator where the student types each step of their work as its own math line; you receive those lines as Desmos LaTeX, in order, never as pictures. The app puts a mark next to each line: green = right, yellow = minor slip, red = really wrong, gray = can\'t tell. If a problem has a table to fill in, the app builds that table in Desmos for the student (numbers only). Yes/No or True/False grids are built as editable text rows in Desmos, one row per item; the student replaces each blank ___ with Yes or No, and you receive each row as plain text such as: (i) y-prime plus xy equals x squared: Separable Yes, Linear Yes. Desmos has no text-answer boxes, no symbolic algebra and no indefinite integrals, so students write derivatives, integrals and words loosely as math lines (for example dy/dx, y\' or an integral sign without limits) and write answers as an equation or a number on their own line. Judge the mathematics and the intent, never Desmos formatting. Do not mention buttons, tabs or features that do not exist in this app, and do not tell the student to do something on paper or in a place the app does not have.';

  // Gemini only: when one model is overloaded or retired, try the others in turn and remember what worked.
  const FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const working = {};
  const isTransient = (status, msg) => status === 429 || status >= 500 || /high demand|overloaded|unavailable|try again later|quota|exhausted|timed out/i.test(msg);
  const isMissing = (status, msg) => status === 404 || /no longer available|no longer supported|not found|not supported/i.test(msg);

  // The AI often writes LaTeX like \frac or \int with single backslashes inside JSON strings, which breaks JSON
  // (or silently turns \frac into a form feed). Double those backslashes before parsing.
  function parseJsonLoose(raw) {
    const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
    const fixed = text.replace(
      /\\\\|\\(?!["\/]|u[0-9a-fA-F]{4}|[bfnrt](?!(?:rac|orall|eta|inom|ar|egin|mod|u|eq|e|abla|ot|otin|ho|ight|au|heta|an|ext|imes|o|ilde|op|frac|oldsymbol)(?![a-z])))/g,
      (m) => (m === '\\\\' ? m : '\\\\')
    );
    try { return JSON.parse(fixed); } catch (e) { return JSON.parse(text); }
  }

  function toMessages({ history, prompt }) {
    if (history) return history.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', parts: m.parts }));
    const parts = Array.isArray(prompt) ? prompt : [{ text: prompt }];
    return [{ role: 'user', parts: parts.map((p) => (p.inlineData ? { pdf: p.inlineData.data } : { text: p.text })) }];
  }

  // If no model is chosen yet, ask the provider what this key can use and pick sensible ones.
  async function ensureModels() {
    const c = cur();
    if (c.model && c.checkModel) return;
    if (c.model && !c.checkModel) { c.checkModel = c.model; return; }
    const list = await MCProviders.listModels(cfg.provider, connOf());
    const pick = MCProviders.autoPick(cfg.provider, list);
    if (!pick.model) throw new Error('Choose a model in Settings (click Load models).');
    c.model = pick.model;
    c.checkModel = c.checkModel || pick.checkModel || pick.model;
    saveCfg();
  }

  async function aiGemini(model, a) {
    const tried = new Set();
    const order = [working[model], model, ...FALLBACKS].filter((m, i, arr) => m && arr.indexOf(m) === i);
    let last = null;
    let listed = false;
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      if (tried.has(m)) continue;
      tried.add(m);
      const r = await MCProviders.call('gemini', connOf(), m, a);
      if (r.ok) {
        lastModelUsed = m;
        if (m !== model) working[model] = m;
        return r.text;
      }
      last = r;
      if (!(isTransient(r.status, r.msg) || isMissing(r.status, r.msg))) break; // bad key, API disabled, bad request
      if (i === order.length - 1 && !listed) {
        listed = true; // nothing worked: ask Google what this key can use and try those
        try {
          const list = await MCProviders.listModels('gemini', connOf());
          list.map((x) => x.id).filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n)).forEach((n) => { if (!tried.has(n)) order.push(n); });
        } catch (e) { /* keep the error we have */ }
      }
    }
    throw new Error(last ? last.msg : 'No response from Gemini');
  }

  // model: 'main' | 'check' | an explicit model id
  async function ai({ model = 'main', system, prompt, history, json = true, thinking = true }) {
    await ensureModels();
    const m = model === 'check' ? checkModelOf() : model === 'main' ? mainModel() : model;
    const a = { system, messages: toMessages({ history, prompt }), json, thinking };
    let text;
    if (cfg.provider === 'gemini') {
      text = await aiGemini(m, a);
    } else {
      let r = await MCProviders.call(cfg.provider, connOf(), m, a);
      if (!r.ok && isTransient(r.status, r.msg)) { await sleep(3000); r = await MCProviders.call(cfg.provider, connOf(), m, a); }
      if (!r.ok) throw new Error(r.msg);
      lastModelUsed = m;
      text = r.text;
    }
    return json ? parseJsonLoose(text) : text;
  }

  function hash(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
  }
  const keyId = (t) => String(hash(String(t).trim()));

  // ---------- state ----------
  const state = {
    problem: store.get('mc.problem', ''),
    rubric: null,
    rubricPromise: null,
    lines: {}, // desmos id -> {latex, status, matched}
    chat: [],
    more: store.get('mc.more', []),
    set: store.get('mc.set', { title: '', problems: [], index: 0 }),
    keys: store.get('mc.keys', {}),
    keyOpen: {},
    answers: store.get('mc.answers', {}),
    grid: null, // the Yes/No grid built in Desmos for the current problem
  };

  // ---------- math rendering ----------
  function renderMathIn(el) {
    if (window.renderMathInElement) {
      try {
        renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false });
      } catch (e) { /* leave as plain text */ }
    }
  }
  function setTextWithMath(el, text) {
    el.textContent = text;
    renderMathIn(el);
  }

  // ---------- small toast ----------
  let toastTimer = null;
  function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }
  function showToast(text, actions, ms) {
    clearTimeout(toastTimer);
    $('#toastText').textContent = text;
    [['#toastA', actions && actions[0]], ['#toastB', actions && actions[1]]].forEach(([sel, act]) => {
      const b = $(sel);
      b.textContent = act ? act.label : '';
      b.onclick = act ? act.fn : null;
    });
    $('#toast').hidden = false;
    if (ms) toastTimer = setTimeout(hideToast, ms);
  }

  // ---------- Desmos ----------
  let calc = null;
  function startDesmos() {
    if (!window.Desmos) {
      $('#calculator').textContent = 'Desmos could not load (check your internet connection and reload).';
      return;
    }
    calc = Desmos.GraphingCalculator($('#calculator'), { keypad: true, expressions: true, settingsMenu: true, zoomButtons: true });
    window.mcCalc = calc;
    calc.observeEvent('change', scheduleSync);
    window.addEventListener('resize', () => calc.resize());
  }

  // One grid row as plain text, e.g. "(i) y' + xy = x^2: Separable Yes, Linear Yes" (empty until a cell is answered).
  function rowSummary(text, id) {
    const g = state.grid;
    const row = g && g.rows.find((r) => r.id === id);
    if (!row) return '';
    const parts = [];
    g.columns.forEach((c) => {
      const m = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(yes|no|true|false)\\b', 'i').exec(text || '');
      if (m) parts.push(c + ' ' + m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
    });
    return parts.length ? row.label + ': ' + parts.join(', ') : '';
  }

  function currentLines() {
    if (!calc) return [];
    const out = [];
    calc.getExpressions().forEach((e) => {
      if (e.type === 'expression' && e.latex && e.latex.trim()) out.push({ id: e.id, latex: e.latex.trim() });
      else if (e.type === 'text' && String(e.id || '').startsWith('mc-row-')) {
        const sum = rowSummary(e.text, e.id);
        if (sum) out.push({ id: e.id, latex: sum, text: true });
      }
    });
    return out;
  }

  // ---------- per-line checks ----------
  let syncTimer = null;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 800);
  }

  function sync() {
    const lines = currentLines();
    const ids = new Set(lines.map((l) => l.id));
    Object.keys(state.lines).forEach((id) => { if (!ids.has(id)) delete state.lines[id]; });
    lines.forEach((l) => {
      const st = state.lines[l.id];
      if (!st || st.latex !== l.latex) {
        state.lines[l.id] = { latex: l.latex, status: 'pending', matched: [] };
        enqueue(l.id);
      }
    });
    renderLines();
  }

  const queue = [];
  let running = false;
  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    if (!running) runQueue();
  }

  function balanced(latex) {
    const pairs = [['(', ')'], ['{', '}'], ['[', ']']];
    return pairs.every(([a, b]) => (latex.split(a).length - 1) === (latex.split(b).length - 1)) && !/(\+|-|\*|\^|=)\s*$/.test(latex);
  }

  async function runQueue() {
    running = true;
    while (queue.length) {
      const id = queue.shift();
      const lines = currentLines();
      const idx = lines.findIndex((l) => l.id === id);
      const st = state.lines[id];
      if (idx < 0 || !st || st.latex !== lines[idx].latex) continue;
      const line = lines[idx];
      const previous = lines.slice(0, idx).map((p) => ({ latex: p.latex, status: (state.lines[p.id] || {}).status || 'unknown' }));
      let result;
      try {
        result = await judge(line.latex, previous, line.text);
      } catch (e) {
        result = { status: 'error', matched: [] };
        console.warn('check failed:', e.message);
        setPrep('Check failed: ' + e.message, true);
      }
      const now = state.lines[id];
      if (!now || now.latex !== line.latex) continue; // changed while we waited
      now.status = result.status;
      now.matched = result.matched || [];
      renderLines();
      if (result.status === 'right' && result.isFinal) recordAnswer(line.latex, false);
    }
    running = false;
  }

  // A line like "x = 6" or "y(t) = 2e^{3t}" looks like a finished answer: it needs the full check so we can spot final answers.
  function looksFinal(latex) {
    const m = /^\s*([A-Za-z])(?:_\{[^{}]*\})?(?:\\left\([A-Za-z]\\right\))?\s*=\s*(.+)$/.exec(latex);
    return !!m && !m[2].replace(/\\[A-Za-z]+/g, '').includes(m[1]);
  }

  async function judge(latex, previous, isText) {
    // 1. unfinished typing or broken notation: never red, just gray
    if (!isText && !balanced(latex)) return { status: 'unsure', matched: [] };
    // 2. same as the previous line algebraically: it gets that line's mark
    const prev = previous[previous.length - 1];
    if (prev && !isText && !looksFinal(latex) && ['right', 'slip', 'wrong'].includes(prev.status) && window.MathCheck && MathCheck.equivalent(prev.latex, latex) === true) {
      return { status: prev.status, matched: [] };
    }
    // 3. test mode
    if (isMock()) {
      const h = hash(latex);
      const status = ['right', 'slip', 'wrong', 'unsure', 'right'][h % 5];
      const matched = state.rubric && state.rubric.firstSteps && state.rubric.firstSteps.length && status === 'right'
        ? [state.rubric.firstSteps[h % state.rubric.firstSteps.length].id] : [];
      await sleep(350);
      return { status, matched, isFinal: status === 'right' && /^[a-zA-Z]\s*=\s*-?[\d.]+$/.test(latex.replace(/\\left|\\right/g, '').trim()) };
    }
    // 4. the AI
    if (state.rubricPromise) { try { await state.rubricPromise; } catch (e) { /* check without a rubric */ } }
    const prevText = previous.map((p, i) => `${i + 1}. ${p.latex}  [${p.status}]`).join('\n') || '(none)';
    const out = await ai({
      model: 'check',
      thinking: false,
      system: SYS_BASE + ' You judge ONE new line of a student\'s written work in Desmos. Skipped steps are fine if the line is a true, valid consequence of earlier correct lines or a correct setup. Do not require a specific method.',
      prompt: `Problem:\n${state.problem}\n\nReference rubric (may be incomplete; a correct but different method is still right):\n${JSON.stringify(state.rubric || {})}\n\nStudent's earlier lines with marks:\n${prevText}\n\nNEW LINE (LaTeX from Desmos):\n${latex}${isText ? '\n\nThis NEW LINE is one row of a Yes/No grid the student is filling in (plain text, not LaTeX): judge each answered cell against the correct answer for that row\'s item. \"right\" only if every answered cell is correct, \"wrong\" if any answered cell is wrong; blank cells are not errors.' : ''}\n\nChoose exactly one verdict:\n- "right": the line is correct and valid.\n- "slip": the method and idea are right but there is a small human error, like a wrong digit, a dropped sign or a typo (e.g. 2 instead of 3). One tiny fix would make it right.\n- "wrong": really incorrect (wrong method, wrong setup, a real algebra or calculus error beyond a typo).\n- "unsure": you cannot tell, or the line is mostly Desmos syntax or notation trouble (e.g. derivative or other notation typed as plain letters, missing parentheses, stray symbols). NEVER say "wrong" because of Desmos notation.\n\nAlso set "isFinal" to true ONLY if this line is correct AND is the complete final answer to the whole problem (every part answered); otherwise false.\n\nReturn JSON: {"verdict":"right"|"slip"|"wrong"|"unsure","matched":[ids of rubric firstSteps this line correctly establishes, else []],"isFinal":true|false}. Write every LaTeX backslash in the JSON as a double backslash.`,
    });
    const status = ['right', 'slip', 'wrong', 'unsure'].includes(out.verdict) ? out.verdict : 'unsure';
    return { status, matched: Array.isArray(out.matched) ? out.matched : [], isFinal: out.isFinal === true };
  }

  // ---------- rendering the checks ----------
  const MARKS = {
    right: { cls: 'green', ch: '✓', label: 'Right' },
    slip: { cls: 'yellow', ch: '✓', label: 'Minor slip' },
    wrong: { cls: 'red', ch: '✗', label: 'Wrong' },
    unsure: { cls: 'gray', ch: '?', label: 'Can\'t tell. Click to re-check.' },
    error: { cls: 'gray', ch: '!', label: 'Check failed. Click to try again.' },
    pending: { cls: 'pending', ch: '', label: 'Checking...' },
  };

  function renderLines() {
    const list = $('#lineList');
    list.textContent = '';
    const lines = currentLines();
    $('#lineEmpty').hidden = lines.length > 0;
    const savedAns = (state.answers[keyId(state.problem)] || {}).latex;
    lines.forEach((l) => {
      const st = state.lines[l.id] || { status: 'pending' };
      const m = MARKS[st.status] || MARKS.unsure;
      const li = document.createElement('li');
      const mark = document.createElement(st.status === 'unsure' || st.status === 'error' ? 'button' : 'span');
      mark.className = 'mark ' + m.cls;
      mark.textContent = m.ch;
      mark.title = m.label;
      mark.setAttribute('aria-label', m.label);
      if (mark.tagName === 'BUTTON') {
        mark.type = 'button';
        mark.addEventListener('click', () => {
          state.lines[l.id] = { latex: l.latex, status: 'pending', matched: [] };
          renderLines();
          enqueue(l.id);
        });
      }
      const tex = document.createElement('span');
      tex.className = 'tex';
      if (l.text) tex.textContent = l.latex;
      else { try { katex.render(l.latex, tex, { throwOnError: false, errorColor: '#8a93a3' }); } catch (e) { tex.textContent = l.latex; } }
      li.append(mark, tex);
      if (st.status === 'right') {
        const star = document.createElement('button');
        star.type = 'button';
        const on = savedAns === l.latex;
        star.className = 'star' + (on ? ' on' : '');
        star.textContent = on ? '★' : '☆';
        star.title = on ? 'Saved as your answer' : 'Save this line as your answer';
        star.addEventListener('click', () => recordAnswer(l.latex, true));
        li.append(star);
      }
      list.append(li);
    });
    renderSetup();
  }

  function renderSetup() {
    const box = $('#setupScore');
    const steps = (state.rubric && state.rubric.firstSteps) || [];
    if (!steps.length) { box.hidden = true; return; }
    const got = new Set();
    Object.values(state.lines).forEach((st) => { if (st.status === 'right') (st.matched || []).forEach((id) => got.add(id)); });
    const n = steps.filter((s) => got.has(s.id)).length;
    box.hidden = false;
    box.textContent = '';
    box.append('Setup: ' + n + ' / ' + steps.length + '  ');
    steps.forEach((s) => {
      const pip = document.createElement('span');
      pip.className = 'pip' + (got.has(s.id) ? ' on' : '');
      box.append(pip);
    });
  }

  // ---------- problem + rubric ----------
  function setPrep(text, bad) {
    const el = $('#prepStatus');
    el.textContent = text;
    el.style.color = bad ? 'var(--red)' : '';
  }

  const rubricPrompt = (problem) => `Problem:\n${problem}\n\nSolve it carefully, then return JSON:
{"type": short label for the problem type and course level (e.g. "linear equation", "quadratic word problem", "u-substitution integral", "matrix row reduction", "separable differential equation", "mixing word problem", "free-body diagram / equilibrium"),
 "firstSteps": [ {"id":"s1","description":"one setup item the student must establish","acceptable":["LaTeX of the correct equation and equivalent forms"]} ],
 "solutionSteps": ["each key step of a full correct solution, in LaTeX"],
 "finalAnswer": "LaTeX or short text",
 "table": null,
 "grid": null}
If the problem asks the student to fill in or complete a table (e.g. Euler's method values, a Yes/No classification grid), set "table" to {"note":"how to read it, e.g. 1 = Yes, 0 = No","columns":[{"name":"t","values":["1","1.25","1.5","1.75","2"]},{"name":"y","values":["1","","","",""]}]} using the given numbers as strings and "" for every cell the student must fill. Every column needs the same number of values. A column name is a single letter or a short label. NEVER put answers into the blank cells. Otherwise "table" must be null. If the problem asks for Yes/No or True/False answers in a grid or list (for example classifying each equation as separable, linear or exact), set "grid" to {"note":"how to fill it in","columns":["Separable","Linear","Exact"],"rows":[{"label":"(i) y' + xy = x^2"},{"label":"(ii) y' = x^2 + y^2"}]} with one row per item written exactly as the problem states it in plain text (no LaTeX commands), and NEVER include the answers. Otherwise "grid" must be null.
Rules: firstSteps is non-empty ONLY for word/modeling problems where the student must write equations from the story (list EVERY separate setup equation or quantity needed, e.g. each equilibrium equation or each rate equation; include time/unit conversions if asked). For pure math problems use [].`;

  async function makeRubric(problem) {
    if (isMock()) {
      const wordy = /tank|rate|gallon|liter|litre|per |pond|room|account|interest|population/i.test(problem);
      return { type: 'test mode', firstSteps: wordy ? [{ id: 's1' }, { id: 's2' }, { id: 's3' }] : [], solutionSteps: [], finalAnswer: '' };
    }
    return ai({ model: 'main', system: SYS_BASE, prompt: rubricPrompt(problem) });
  }

  // Put the problem's table into Desmos (numbers only; blank cells are for the student to fill in).
  function buildTable(t) {
    if (!calc || !t || !Array.isArray(t.columns) || !t.columns.length) return;
    const len = Math.max(...t.columns.map((c) => (c.values || []).length));
    if (!len || len > 40) return;
    const okNum = /^[-+0-9.\/()\s*^]+$/;
    const used = new Set();
    const legend = [];
    const cols = t.columns.slice(0, 8).map((c, i) => {
      const name = String(c.name == null ? '' : c.name).trim();
      let latex = /^[A-Za-z]$/.test(name) ? name + '_{n}' : 'c_{' + (i + 1) + '}';
      if (used.has(latex)) latex = 'c_{' + (i + 1) + '}';
      used.add(latex);
      legend.push(latex.replace(/[{}]/g, '') + ' = ' + (name || 'column ' + (i + 1)));
      const values = Array.from({ length: len }, (_, r) => {
        const v = (c.values || [])[r];
        const str = v == null ? '' : String(v).trim();
        return okNum.test(str) ? str : '';
      });
      return { latex, values };
    });
    const st = calc.getState();
    st.expressions.list = st.expressions.list.filter((e) => !String(e.id || '').startsWith('mc-'));
    st.expressions.list.unshift(
      { type: 'text', id: 'mc-note', text: (t.note ? t.note + '. ' : '') + 'Table columns: ' + legend.join(', ') },
      { type: 'table', id: 'mc-table', columns: cols }
    );
    calc.setState(st);
  }

  // Yes/No grids: one editable Desmos text row per item; the student types Yes or No after each colon.
  function buildGrid(g) {
    if (!calc || !g || !Array.isArray(g.columns) || !g.columns.length || !Array.isArray(g.rows) || !g.rows.length) return;
    const cols = g.columns.slice(0, 6).map((c) => String(c).trim()).filter(Boolean);
    const rows = g.rows.slice(0, 30).map((r, i) => ({ id: 'mc-row-' + (i + 1), label: String(typeof r === 'string' ? r : (r && r.label) || '').trim() }));
    if (!cols.length) return;
    state.grid = { columns: cols, rows };
    const st = calc.getState();
    st.expressions.list = st.expressions.list.filter((e) => !String(e.id || '').startsWith('mc-row-') && e.id !== 'mc-gridnote');
    const blanks = cols.map((c) => c + ': ___').join('     ');
    st.expressions.list.unshift(
      { type: 'text', id: 'mc-gridnote', text: (g.note ? String(g.note).replace(/\s+$/, '') + ' ' : '') + 'Click a row and replace each ___ with Yes or No.' },
      ...rows.map((r) => ({ type: 'text', id: r.id, text: r.label + '   -   ' + blanks }))
    );
    calc.setState(st);
  }

  async function setProblem(text, keepWork) {
    state.problem = text.trim();
    store.set('mc.problem', state.problem);
    state.rubric = null;
    state.grid = null;
    if (!keepWork) {
      state.lines = {};
      state.chat = [];
      renderChat();
      if (calc) calc.setBlank();
    }
    renderLines();
    setTextWithMath($('#problemView'), state.problem);
    if (!state.problem) { setPrep(''); return; }
    setPrep('Preparing the checker...');
    const mine = (state.rubricPromise = makeRubric(state.problem));
    try {
      const r = await mine;
      if (state.rubricPromise !== mine) return;
      state.rubric = r;
      try { buildTable(r.table); } catch (e) { console.warn('table failed:', e.message); }
      try { buildGrid(r.grid); } catch (e) { console.warn('grid failed:', e.message); }
      setPrep(isMock() ? 'Ready (test mode)' : 'Ready' + ((r.firstSteps || []).length ? ': word problem, ' + r.firstSteps.length + ' setup steps' : ''));
      renderSetup();
    } catch (e) {
      if (state.rubricPromise !== mine) return;
      setPrep('Could not prepare the checker: ' + e.message, true);
    }
  }

  // ---------- chat ----------
  function renderChat() {
    const log = $('#chatLog');
    log.textContent = '';
    state.chat.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
      setTextWithMath(d, m.text);
      log.append(d);
    });
    log.scrollTop = log.scrollHeight;
  }

  async function sendChat(text) {
    state.chat.push({ role: 'user', text });
    renderChat();
    let reply;
    try {
      if (isMock()) {
        reply = 'Test mode: add your key in Settings to talk to the tutor.';
      } else {
        const lines = currentLines().map((l, i) => `${i + 1}. ${l.latex} [${(state.lines[l.id] || {}).status || '?'}]`).join('\n') || '(none yet)';
        reply = await ai({
          model: 'main',
          json: false,
          system: SYS_BASE + ' A student is stuck on homework and is writing their steps in Desmos (the lines below are Desmos LaTeX; read them literally). Rules: (1) Directly answer the question they just asked, in plain words, before anything else. Never answer a question with only another question. (2) Explain the next step fully with the reason behind it, and show it worked on their own line, but do NOT solve the whole problem or give the final answer unless they explicitly ask. (3) Stay on the problem exactly as written; if their lines contradict the problem or the problem is unclear, say so and ask which they mean. (4) Keep it short and write math in LaTeX inside $...$.'
            + '\n\nProblem:\n' + state.problem
            + '\n\nPrivate rubric (do not dump it; may be wrong): ' + JSON.stringify(state.rubric || {})
            + '\n\nStudent\'s lines so far (LaTeX, with marks):\n' + lines,
          history: state.chat.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
        });
      }
    } catch (e) {
      reply = 'Sorry, that failed: ' + e.message;
    }
    state.chat.push({ role: 'ai', text: reply });
    renderChat();
  }

  // ---------- more questions ----------
  function renderMore() {
    const ul = $('#moreList');
    ul.textContent = '';
    state.more.forEach((q, i) => {
      const li = document.createElement('li');
      const topic = document.createElement('div');
      topic.className = 'topic';
      topic.textContent = q.topic || '';
      const text = document.createElement('div');
      text.className = 'text';
      setTextWithMath(text, q.text);
      const row = document.createElement('div');
      row.className = 'row';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'primary';
      use.textContent = 'Solve this';
      use.addEventListener('click', () => { clearSet(); $('#problemInput').value = q.text; selectTab('check'); setProblem(q.text); });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Remove';
      del.addEventListener('click', () => { state.more.splice(i, 1); store.set('mc.more', state.more); renderMore(); });
      row.append(use, del);
      li.append(topic, text, row);
      ul.append(li);
    });
  }

  async function makeMore() {
    const src = (state.problem || $('#problemInput').value).trim();
    if (!src) { $('#moreStatus').textContent = 'Set a problem first.'; return; }
    const n = Number($('#moreCount').value) || 3;
    const btn = $('#makeMore');
    btn.disabled = true;
    $('#moreStatus').textContent = 'Writing new questions...';
    try {
      let out;
      if (isMock()) {
        out = { problems: Array.from({ length: n }, (_, i) => ({ text: 'Test mode sample ' + (i + 1) + ' like: ' + src, topic: 'test mode' })) };
      } else {
        out = await ai({
          model: 'main',
          system: SYS_BASE,
          prompt: `Original problem:\n${src}\n\nWrite ${n} NEW problems of the same type, structure and difficulty, with different numbers, signs and (where applicable) different functions or contexts. If it is a word problem, write new word problems with new scenarios and quantities that need the same kind of setup. Check each one is solvable and has a clean closed-form answer (no ugly numbers). Use plain text with LaTeX inside $...$. Do not include solutions.\nReturn JSON: {"problems":[{"text":"...","topic":"short label"}]}. Write every LaTeX backslash in the JSON as a double backslash.`,
        });
      }
      state.more = (out.problems || []).concat(state.more).slice(0, 40);
      store.set('mc.more', state.more);
      renderMore();
      $('#moreStatus').textContent = 'Added ' + (out.problems || []).length + ' questions.';
    } catch (e) {
      $('#moreStatus').textContent = 'Failed: ' + e.message;
    }
    btn.disabled = false;
  }

  // ---------- files: PDFs ----------
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read that file'));
      r.readAsDataURL(file);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(s);
    });
  }

  // For AI providers that cannot read PDFs directly, pull the text out in the browser.
  async function pdfToText(file) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      out += content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
    if (out.replace(/\s/g, '').length < 20) throw new Error('That PDF has no readable text (it may be a scan). Use a PDF with selectable text, or paste the text.');
    return out;
  }

  async function pdfParts(file) {
    if (PROVS[cfg.provider].pdf === 'native') return [{ inlineData: { mimeType: 'application/pdf', data: await fileToBase64(file) } }];
    return [{ text: '\n\n' + (await pdfToText(file)) }];
  }

  // ---------- wall of problems / PDF import ----------
  function renderCounter() {
    const n = state.set.problems.length;
    $('#counterBar').hidden = n === 0;
    if (!n) return;
    $('#counter').textContent = 'Problem ' + (state.set.index + 1) + ' / ' + n;
    $('#setTitle').textContent = state.set.title || '';
    $('#prevP').disabled = state.set.index <= 0;
    $('#nextP').disabled = state.set.index >= n - 1;
  }

  function clearSet() {
    state.set = { title: '', problems: [], index: 0 };
    store.set('mc.set', state.set);
    renderCounter();
  }

  function gotoProblem(i) {
    const n = state.set.problems.length;
    if (!n) return;
    state.set.index = Math.min(Math.max(i, 0), n - 1);
    store.set('mc.set', state.set);
    const text = state.set.problems[state.set.index];
    $('#problemInput').value = text;
    renderCounter();
    selectTab('check');
    setProblem(text);
  }

  function mockSplit(text) {
    const start = /^(?:problem\s*)?\(?\d{1,3}\)?[.)]\s/i;
    let parts = text.split(/\n\s*(?=(?:problem\s*)?\(?\d{1,3}\)?[.)]\s)/i).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) parts = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    else if (!start.test(parts[0] + ' ')) parts.shift(); // a title/instructions block before problem 1
    return parts.map((x) => x.replace(/\n\s*\d{1,2}\s*$/, '').trim()); // drop stray page numbers at the end
  }

  function useSet(title, problems) {
    state.set = { title, problems, index: 0 };
    store.set('mc.set', state.set);
    gotoProblem(0);
    if (!isMock()) setTimeout(() => makeKeys(problemList(), false), 2500); // build the AI answer key in the background
  }

  async function splitWall() {
    const text = $('#problemInput').value.trim();
    const file = $('#pdfInput').files[0];
    const status = $('#splitStatus');
    if (!text && !file) { status.textContent = 'Paste problems or choose a PDF first.'; return; }
    const btn = $('#splitBtn');
    btn.disabled = true;
    status.textContent = 'Finding the problems...';
    try {
      let problems;
      let title = file ? file.name.replace(/\.pdf$/i, '') : 'Pasted problems';
      if (isMock()) {
        if (file) throw new Error('Reading a PDF needs your AI key (test mode can only split pasted text).');
        problems = mockSplit(text);
      } else {
        const instr = 'Below is homework, a worksheet or an exam (pasted text or a PDF). Count and extract EVERY separate problem, in order. Drop interface junk (e.g. "Press Space or Enter to edit this math answer", "DETAILS", "MY NOTES", "ASK YOUR TEACHER", "PRACTICE ANOTHER", point values, answers the student already typed, page headers and footers). Keep all parts (a), (b), (c)... of one numbered problem together as ONE problem. Copy each statement faithfully, do not change any numbers, and do NOT solve anything. Write math in LaTeX inside $...$.\nReturn JSON: {"title":"short name for the set","problems":[{"text":"full problem statement"}]}. Write every LaTeX backslash in the JSON as a double backslash.';
        const parts = [{ text: instr }];
        if (file) (await pdfParts(file)).forEach((p) => parts.push(p));
        else parts.push({ text: '\n\n' + text });
        const out = await ai({ model: 'main', system: SYS_BASE, prompt: parts });
        problems = (out.problems || []).map((x) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
        if (out.title) title = out.title;
      }
      if (!problems.length) throw new Error('I could not find any problems in that.');
      status.textContent = 'Found ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + '.';
      useSet(title, problems);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
    }
    btn.disabled = false;
  }

  async function oneProblem() {
    const text = $('#problemInput').value.trim();
    const file = $('#pdfInput').files[0];
    if (!text && file) {
      const status = $('#splitStatus');
      if (isMock()) { status.textContent = 'Reading a PDF needs your AI key (test mode cannot read PDFs).'; return; }
      status.textContent = 'Reading the PDF as one problem...';
      try {
        const parts = [{ text: 'Transcribe this document as ONE single problem, exactly as written, keeping every part and any table. Drop page headers, footers and interface junk. Write math in LaTeX inside $...$. Do not solve anything. Reply with only the problem text.' }];
        (await pdfParts(file)).forEach((p) => parts.push(p));
        const out = await ai({ model: 'main', system: SYS_BASE, json: false, prompt: parts });
        $('#problemInput').value = out.trim();
        status.textContent = '';
      } catch (e) {
        status.textContent = 'Failed: ' + e.message;
        return;
      }
    }
    clearSet();
    setProblem($('#problemInput').value);
  }

  async function pasteClipboard() {
    const status = $('#splitStatus');
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) { status.textContent = 'The clipboard is empty.'; return; }
      $('#problemInput').value = t;
      status.textContent = 'Pasted ' + t.length + ' characters. Now choose Break into problems or One problem.';
    } catch (e) {
      status.textContent = 'Your browser blocked clipboard access. Click in the box and press Ctrl+V instead.';
    }
  }

  // ---------- AI practice test ----------
  async function makePracticeTest() {
    const text = $('#pracInput').value.trim();
    const file = $('#pracPdf').files[0];
    const status = $('#pracStatus');
    if (!text && !file) { status.textContent = 'Paste an exam or choose a PDF first.'; return; }
    const btn = $('#pracBtn');
    btn.disabled = true;
    status.textContent = 'Writing your practice test...';
    try {
      let out;
      if (isMock()) {
        if (file) throw new Error('Reading a PDF needs your AI key (test mode can only use pasted text).');
        out = { title: 'Practice test (test mode)', problems: mockSplit(text).map((t, i) => ({ text: 'Test mode new version of question ' + (i + 1) + ': ' + t.slice(0, 160) })) };
      } else {
        const instr = 'Below is an exam (pasted text or a PDF). For EACH question on it, write one NEW question of the same type, structure, number of parts and difficulty, with different numbers, signs and (where applicable) different functions. Word problems get new scenarios that need the same kind of setup. Each must have a clean closed-form answer (no ugly numbers). Keep the same order and point weights if shown. If a question has a table to fill in, write a new table of the same shape with new given values. Use LaTeX inside $...$. Do NOT include solutions.\nReturn JSON: {"title":"Practice test: <course or exam name>","problems":[{"text":"...","topic":"short label"}]}. Write every LaTeX backslash in the JSON as a double backslash.';
        const parts = [{ text: instr }];
        if (file) (await pdfParts(file)).forEach((p) => parts.push(p));
        else parts.push({ text: '\n\n' + text });
        out = await ai({ model: 'main', system: SYS_BASE, prompt: parts });
      }
      const problems = (out.problems || []).map((x) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
      if (!problems.length) throw new Error('I could not find questions in that exam.');
      status.textContent = 'Made a ' + problems.length + '-question practice test and loaded it above.';
      clearSet();
      useSet(out.title || 'Practice test', problems);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
    }
    btn.disabled = false;
  }

  // ---------- AI answer key ----------
  let keyBusy = false;

  function problemList() {
    if (state.set.problems.length) return state.set.problems.map((t, i) => ({ n: i + 1, text: t }));
    return state.problem ? [{ n: 1, text: state.problem }] : [];
  }

  async function makeKey(text) {
    if (isMock()) return { answer: 'Test mode: add your key in Settings to make a real answer key.', steps: [] };
    const out = await ai({
      model: 'main',
      system: SYS_BASE,
      prompt: `Problem:\n${text}\n\nSolve it carefully, then verify the answer by substituting back or differentiating where possible. Return JSON:\n{"answer":"the final answer for EVERY part of the problem, one line per part, math in LaTeX inside $...$ (if the problem has a table, give the completed table values)","steps":["short key steps of the solution, math in LaTeX inside $...$"]}\nIf the problem as written is unclear or has no single answer, say so in "answer". Write every LaTeX backslash in the JSON as a double backslash.`,
    });
    const ans = Array.isArray(out.answer) ? out.answer.join('\n') : String(out.answer || '');
    return { answer: ans, steps: Array.isArray(out.steps) ? out.steps.map(String) : [] };
  }

  async function makeKeys(list, force) {
    if (keyBusy) return;
    keyBusy = true;
    const status = $('#keyStatus');
    const todo = list.filter((p) => force || !state.keys[keyId(p.text)]);
    let done = 0;
    let failed = 0;
    for (const p of todo) {
      status.textContent = 'Making answer key... ' + done + ' / ' + todo.length;
      try {
        state.keys[keyId(p.text)] = await makeKey(p.text);
        store.set('mc.keys', state.keys);
      } catch (e) {
        failed++;
        status.textContent = 'Problem ' + p.n + ' failed: ' + e.message;
        await sleep(1500);
      }
      done++;
      renderKey();
    }
    status.textContent = todo.length ? 'Done: ' + (todo.length - failed) + ' of ' + todo.length + ' made.' + (failed ? ' ' + failed + ' failed; click Make again to retry.' : '') : 'Everything already has a key.';
    keyBusy = false;
  }

  function renderKey() {
    const ul = $('#keyList');
    ul.textContent = '';
    const list = problemList();
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = 'Set a problem or import a set first.';
      ul.append(li);
      return;
    }
    list.forEach((p) => {
      const id = keyId(p.text);
      const k = state.keys[id];
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'key-head';
      const label = document.createElement('strong');
      label.textContent = 'Problem ' + p.n;
      const prev = document.createElement('span');
      prev.className = 'preview';
      prev.textContent = p.text.replace(/\s+/g, ' ').slice(0, 90);
      const btn = document.createElement('button');
      btn.type = 'button';
      if (!k) {
        btn.textContent = 'Make';
        btn.addEventListener('click', () => makeKeys([p], true));
      } else {
        btn.textContent = state.keyOpen[id] ? 'Hide' : 'Show';
        btn.addEventListener('click', () => { state.keyOpen[id] = !state.keyOpen[id]; renderKey(); });
      }
      head.append(label, prev, btn);
      li.append(head);
      if (k && state.keyOpen[id]) {
        const box = document.createElement('div');
        box.className = 'key-answer';
        const ans = document.createElement('div');
        setTextWithMath(ans, k.answer);
        box.append(ans);
        if (k.steps && k.steps.length) {
          const ol = document.createElement('ol');
          ol.className = 'steps';
          k.steps.forEach((st) => { const s2 = document.createElement('li'); setTextWithMath(s2, st); ol.append(s2); });
          box.append(ol);
        }
        li.append(box);
      }
      ul.append(li);
    });
  }

  // ---------- my answers + export ----------
  const plainMath = (latex) => {
    try { const e = window.MathCheck && MathCheck.toExpr(latex); if (e) return e.replace(/\*/g, '*'); } catch (err) { /* fall through */ }
    return latex;
  };

  function recordAnswer(latex, manual) {
    if (!state.problem) return;
    const id = keyId(state.problem);
    const prev = state.answers[id];
    if (prev && prev.latex === latex) {
      if (manual) showToast('That line is already saved as your answer.', null, 2500);
      return;
    }
    const n = state.set.problems.length ? state.set.index + 1 : 1;
    state.answers[id] = { n, set: state.set.title || '', problem: state.problem.slice(0, 300), latex, ts: Date.now() };
    store.set('mc.answers', state.answers);
    renderAnswers();
    renderLines();
    offerNext(n);
  }

  function offerNext(n) {
    const total = state.set.problems.length;
    if (!total) { showToast('Saved your answer (see My answers).', null, 3000); return; }
    if (state.set.index >= total - 1) { showToast('Saved your answer for problem ' + n + '. That was the last problem.', null, 5000); return; }
    if (!cfg.autoNext) { showToast('Saved your answer for problem ' + n + '.', [{ label: 'Next problem', fn: () => { hideToast(); gotoProblem(state.set.index + 1); } }], 8000); return; }
    const target = state.problem;
    let timer;
    const go = () => { clearTimeout(timer); hideToast(); if (state.problem === target) gotoProblem(state.set.index + 1); };
    showToast('Saved your answer for problem ' + n + '. Moving to the next problem in 3 seconds.', [
      { label: 'Stay', fn: () => { clearTimeout(timer); hideToast(); } },
      { label: 'Next now', fn: go },
    ]);
    timer = setTimeout(go, 3000);
  }

  function sortedAnswers() {
    return Object.entries(state.answers).map(([id, a]) => ({ id, ...a })).sort((x, y) => (x.set || '').localeCompare(y.set || '') || x.n - y.n || x.ts - y.ts);
  }

  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); showToast('Copied ' + label + '.', null, 2000); }
    catch (e) { showToast('Your browser blocked copying. Select the text and copy it yourself.', null, 4000); }
  }

  function renderAnswers() {
    const ul = $('#ansList');
    ul.textContent = '';
    const list = sortedAnswers();
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Nothing saved yet. Finish a problem with a green final line, or click ☆ on a green line.';
      ul.append(li);
      return;
    }
    list.forEach((a) => {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'key-head';
      const label = document.createElement('strong');
      label.textContent = 'Problem ' + a.n;
      const prev = document.createElement('span');
      prev.className = 'preview';
      prev.textContent = a.problem.replace(/\s+/g, ' ').slice(0, 80);
      head.append(label, prev);
      const tex = document.createElement('div');
      tex.className = 'ans-tex';
      try { katex.render(a.latex, tex, { throwOnError: false, errorColor: '#8a93a3' }); } catch (e) { tex.textContent = a.latex; }
      const row = document.createElement('div');
      row.className = 'row';
      const mk = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.addEventListener('click', fn); row.append(b); };
      mk('Copy', () => copyText(plainMath(a.latex), 'the answer'));
      mk('Copy LaTeX', () => copyText(a.latex, 'the LaTeX'));
      mk('Go to problem', () => {
        const i = state.set.problems.findIndex((t) => keyId(t) === a.id);
        if (i >= 0) gotoProblem(i);
        else { clearSet(); $('#problemInput').value = a.problem; selectTab('check'); setProblem(a.problem); }
      });
      mk('Remove', () => { delete state.answers[a.id]; store.set('mc.answers', state.answers); renderAnswers(); renderLines(); });
      li.append(head, tex, row);
      ul.append(li);
    });
  }

  function exportTitle() { const t = sortedAnswers().find((a) => a.set); return (t && t.set) || 'My answers'; }
  function exportText() {
    return exportTitle() + '\n\n' + sortedAnswers().map((a) => a.n + '. ' + a.problem.replace(/\s+/g, ' ').slice(0, 90) + '\n   Answer: ' + plainMath(a.latex)).join('\n\n') + '\n';
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function exportHtml() {
    return '<html><head><meta charset="utf-8"><title>' + esc(exportTitle()) + '</title><style>body{font-family:Calibri,Arial,sans-serif;max-width:720px;margin:24px auto}h1{font-size:20pt}li{margin-bottom:12pt}.q{color:#555;font-size:10pt}</style></head><body><h1>' + esc(exportTitle()) + '</h1><ol>' +
      sortedAnswers().map((a) => '<li value="' + a.n + '"><div class="q">' + esc(a.problem.replace(/\s+/g, ' ').slice(0, 140)) + '</div><div><b>Answer:</b> ' + esc(plainMath(a.latex)) + ' &nbsp;<span class="q">(LaTeX: ' + esc(a.latex) + ')</span></div></li>').join('') +
      '</ol></body></html>';
  }

  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function printHtml(html) {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.append(f);
    f.srcdoc = html;
    f.onload = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 5000); };
  }

  async function exportGoogle() {
    const status = $('#expStatus');
    if (!cfg.googleClientId) { status.textContent = 'Google Docs export needs a Google OAuth client ID. Add one in Settings (it needs a free Google Cloud project).'; return; }
    status.textContent = 'Opening Google sign-in...';
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      const token = await new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: cfg.googleClientId,
          scope: 'https://www.googleapis.com/auth/documents',
          callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
          error_callback: (e) => reject(new Error(e.message || e.type || 'Sign-in was closed')),
        });
        client.requestAccessToken();
      });
      const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
      const doc = await (await fetch('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: auth, body: JSON.stringify({ title: exportTitle() }) })).json();
      if (!doc.documentId) throw new Error((doc.error && doc.error.message) || 'Could not create the document');
      const up = await fetch('https://docs.googleapis.com/v1/documents/' + doc.documentId + ':batchUpdate', { method: 'POST', headers: auth, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: exportText() } }] }) });
      if (!up.ok) throw new Error('Could not write to the document');
      status.textContent = 'Created your Google Doc.';
      window.open('https://docs.google.com/document/d/' + doc.documentId + '/edit', '_blank');
    } catch (e) {
      status.textContent = 'Google Docs export failed: ' + e.message;
    }
  }

  function wireExport() {
    const need = () => { if (!sortedAnswers().length) { $('#expStatus').textContent = 'Nothing to export yet.'; return false; } $('#expStatus').textContent = ''; return true; };
    $('#expCopy').addEventListener('click', () => { if (need()) copyText(exportText(), 'all answers'); });
    $('#expWord').addEventListener('click', () => { if (need()) download('answers.doc', 'application/msword', exportHtml()); });
    $('#expPdf').addEventListener('click', () => { if (need()) printHtml(exportHtml()); });
    $('#expGoogle').addEventListener('click', () => { if (need()) exportGoogle(); });
    $('#autoNext').checked = cfg.autoNext;
    $('#autoNext').addEventListener('change', (e) => { cfg.autoNext = e.target.checked; saveCfg(); });
  }

  // ---------- tabs, settings, wiring ----------
  const TABS = ['check', 'chat', 'ans', 'key', 'more', 'prac'];
  function selectTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    TABS.forEach((n) => { $('#pane-' + n).hidden = n !== name; });
    if (name === 'key') renderKey();
    if (name === 'ans') renderAnswers();
  }

  function updateBanner() {
    $('#banner').hidden = !isMock();
    const p = PROVS[cfg.provider];
    $('#bannerText').textContent = 'Test mode: marks are fake until you ' + (p.needsKey ? 'add your ' + p.label.split(' (')[0] + ' key.' : 'add your server address.');
    $('#bannerKey').textContent = p.needsKey ? 'Add your key' : 'Set up';
  }

  // settings dialog: edit a copy, then save
  let form = null;
  function formFields() { return { key: $('#keyInput').value.trim(), model: $('#modelInput').value.trim(), checkModel: $('#checkModelInput').value.trim(), baseUrl: $('#baseInput').value.trim() }; }
  function fillForm(p) {
    const f = form[p];
    const pv = PROVS[p];
    $('#providerSel').value = p;
    $('#keyInput').value = f.key;
    $('#modelInput').value = f.model;
    $('#checkModelInput').value = f.checkModel;
    $('#baseInput').value = f.baseUrl;
    $('#baseRow').hidden = p !== 'custom';
    $('#keyLabel').textContent = pv.needsKey ? pv.label.split(' (')[0] + ' API key' : 'API key (leave empty if your server needs none)';
    const link = $('#keyLink');
    link.hidden = !pv.keyUrl;
    link.href = pv.keyUrl || '#';
    link.textContent = 'Get a ' + pv.label.split(' (')[0] + ' key';
    $('#modelList').textContent = '';
    $('#testResult').textContent = '';
    $('#keyHint').textContent = f.key ? 'A key is saved in this browser. It stays after you refresh or reopen the page. Only clearing the website data for this page, or a private window, removes it.' : '';
  }
  function openSettings() {
    form = JSON.parse(JSON.stringify(cfg.providers));
    const sel = $('#providerSel');
    if (!sel.options.length) Object.keys(PROVS).forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = PROVS[p].label; sel.append(o); });
    fillForm(cfg.provider);
    $('#gcidInput').value = cfg.googleClientId;
    $('#settings').showModal();
    $('#keyInput').focus();
  }
  async function withFormCfg(fn) { // run something using the settings currently typed in the dialog, then restore
    const p = $('#providerSel').value;
    form[p] = formFields();
    const keep = { provider: cfg.provider, prov: cfg.providers[p] };
    cfg.provider = p;
    cfg.providers[p] = Object.assign({}, form[p]);
    try { return await fn(p); } finally { cfg.provider = keep.provider; cfg.providers[p] = keep.prov; }
  }

  function wire() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    $('#setProblem').addEventListener('click', oneProblem);
    $('#problemInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) oneProblem(); });
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = $('#chatInput').value.trim();
      if (!t) return;
      $('#chatInput').value = '';
      sendChat(t);
    });
    $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
    $('#makeMore').addEventListener('click', makeMore);
    $('#splitBtn').addEventListener('click', splitWall);
    $('#pasteBtn').addEventListener('click', pasteClipboard);
    $('#pracBtn').addEventListener('click', makePracticeTest);
    $('#keyThis').addEventListener('click', () => makeKeys(state.problem ? [{ n: Math.max(state.set.index, 0) + 1, text: state.problem }] : [], true));
    $('#keyAll').addEventListener('click', () => makeKeys(problemList(), false));
    $('#prevP').addEventListener('click', () => gotoProblem(state.set.index - 1));
    $('#nextP').addEventListener('click', () => gotoProblem(state.set.index + 1));
    wireExport();

    // bookmarklet: copies a page's text so it can be pasted here
    const code = "(function(){var t=document.body.innerText;var ok=function(){alert('Copied the page text. Now press Paste from clipboard in Math Check.')};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();ok()})}else{var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();ok()}})();";
    $('#bookmarklet').setAttribute('href', 'javascript:' + code);
    $('#bookmarklet').addEventListener('click', (e) => { e.preventDefault(); showToast('Drag this link up to your bookmarks bar, then use it on the WebAssign page.', null, 5000); });

    // settings
    $('#openSettings').addEventListener('click', openSettings);
    $('#bannerKey').addEventListener('click', openSettings);
    let shownProv = null;
    $('#providerSel').addEventListener('focus', () => { shownProv = $('#providerSel').value; });
    $('#providerSel').addEventListener('change', () => {
      const next = $('#providerSel').value;
      if (shownProv && form[shownProv]) {
        // the inputs still hold the previous provider's values
        const f = { key: $('#keyInput').value.trim(), model: $('#modelInput').value.trim(), checkModel: $('#checkModelInput').value.trim(), baseUrl: $('#baseInput').value.trim() };
        form[shownProv] = f;
      }
      fillForm(next);
      shownProv = next;
    });
    $('#settingsForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'save') {
        const p = $('#providerSel').value;
        form[p] = formFields();
        Object.keys(PROVS).forEach((k) => { cfg.providers[k] = Object.assign(emptyProv(), form[k]); });
        cfg.provider = p;
        if (p === 'gemini') {
          if (!cfg.providers.gemini.model) cfg.providers.gemini.model = GEMINI_DEFAULT.model;
          if (!cfg.providers.gemini.checkModel) cfg.providers.gemini.checkModel = GEMINI_DEFAULT.checkModel;
        }
        cfg.googleClientId = $('#gcidInput').value.trim();
        saveCfg();
        updateBanner();
        if (state.problem) setProblem(state.problem, true);
      }
    });
    $('#loadModels').addEventListener('click', async () => {
      const out = $('#testResult');
      out.textContent = 'Loading models...';
      try {
        const p = $('#providerSel').value;
        const f = formFields();
        const list = await MCProviders.listModels(p, { key: f.key, baseUrl: f.baseUrl });
        const dl = $('#modelList');
        dl.textContent = '';
        list.forEach((m) => { const o = document.createElement('option'); o.value = m.id; dl.append(o); });
        const pick = MCProviders.autoPick(p, list);
        if (!$('#modelInput').value.trim() || (p === 'gemini' && RETIRED.test($('#modelInput').value))) $('#modelInput').value = pick.model || '';
        if (!$('#checkModelInput').value.trim() || (p === 'gemini' && RETIRED.test($('#checkModelInput').value))) $('#checkModelInput').value = pick.checkModel || '';
        out.textContent = 'Loaded ' + list.length + ' models. Pick any from the boxes below.';
      } catch (e) {
        out.textContent = 'Failed: ' + e.message;
      }
    });
    $('#testKey').addEventListener('click', async () => {
      const out = $('#testResult');
      out.textContent = 'Testing...';
      try {
        const r = await withFormCfg(async () => ai({ model: 'main', system: 'Reply with the single word ok.', prompt: 'ping', json: false, thinking: false }));
        out.textContent = 'Works (model: ' + lastModelUsed + ')';
        void r;
      } catch (e) {
        out.textContent = 'Failed: ' + e.message;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    startDesmos();
    updateBanner();
    renderMore();
    renderLines();
    renderChat();
    renderAnswers();
    renderCounter();
    if (state.problem) {
      $('#problemInput').value = state.problem;
      setProblem(state.problem);
    }
  });
})();
