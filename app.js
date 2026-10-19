// Math Check — static app. Embedded Desmos + per-line AI checks. The AI key lives only in this browser.
(function () {
  const $ = (s) => document.querySelector(s);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: still works this session */ } },
  };
  const DEFAULT_MODEL = 'gemini-3.8-flash'; // setup, chat, new questions
  const DEFAULT_CHECK = 'gemini-3.5-flash-lite'; // per-line checks: lighter model = faster and less often overloaded
  const cfg = Object.assign({ key: '', model: DEFAULT_MODEL, checkModel: DEFAULT_CHECK }, store.get('mc.cfg', {}));
  // models Google has retired for new accounts: move saved settings to the current default
  ['model', 'checkModel'].forEach((k) => { if (/^gemini-(1\.|2\.0|2\.5)/.test(cfg[k])) cfg[k] = k === 'model' ? DEFAULT_MODEL : DEFAULT_CHECK; });
  if (cfg.v !== 4) { cfg.checkModel = DEFAULT_CHECK; cfg.v = 4; store.set('mc.cfg', cfg); }
  const isMock = () => !cfg.key;

  // ---------- Gemini ----------
  const SYS_BASE = 'You are an expert, careful math tutor and checker for all college-level math and math-heavy courses: arithmetic and algebra, precalculus, calculus, linear algebra, differential equations, probability and statistics, discrete math, and the math in physics and engineering (e.g. statics, circuits). FIRST work out what kind of problem this is, which course level it is from, and what method(s) a student at that level is expected to use; then tailor everything to that. The problem statement is the source of truth: use exactly what it says. Never assume it is a different type of problem, and never add terms, derivatives, conditions or numbers that are not written. If the problem as written does not make sense or is ambiguous, say so plainly instead of guessing. Double-check every arithmetic and algebra step before you state it, and verify answers by substituting back or differentiating when that is possible; if you are not sure, say you are not sure.';

  // When one model is overloaded or retired, try the others in turn. Remember what worked this session.
  const FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const working = {};
  let lastModelUsed = '';

  async function pickModels() {
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': cfg.key } });
      const data = await res.json();
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .map((n) => ({ n, v: /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/.exec(n) }))
        .filter((x) => x.v)
        .sort((a, b) => parseFloat(b.v[1]) - parseFloat(a.v[1]) || (a.v[2] ? 1 : -1))
        .map((x) => x.n);
    } catch (e) {
      return [];
    }
  }

  const isTransient = (status, msg) => status === 429 || status >= 500 || /high demand|overloaded|unavailable|try again later|quota|exhausted|timed out/i.test(msg);
  const isMissing = (status, msg) => status === 404 || /no longer available|no longer supported|not found|not supported/i.test(msg);

  async function callOnce(model, { system, prompt, history, json, thinking }) {
    const contents = history || [{ role: 'user', parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }];
    const generationConfig = { temperature: 0.2 };
    if (json) generationConfig.responseMimeType = 'application/json';
    if (!thinking && /2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, status: 0, msg: e.name === 'AbortError' ? 'Request timed out after 30 seconds' : e.message };
    }
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, msg: (data.error && data.error.message) || 'Gemini error ' + res.status };
    const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
    return { ok: true, text };
  }

  async function gemini({ model, system, prompt, history, json = true, thinking = true }) {
    const args = { system, prompt, history, json, thinking };
    const tried = new Set();
    const order = [working[model], model, ...FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
    let last = null;
    let listed = false;
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      if (tried.has(m)) continue;
      tried.add(m);
      const r = await callOnce(m, args);
      if (r.ok) {
        lastModelUsed = m;
        if (m !== model) working[model] = m;
        if (!json) return r.text;
        return JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      }
      last = r;
      if (!(isTransient(r.status, r.msg) || isMissing(r.status, r.msg))) break; // bad key, API disabled, bad request: more models won't help
      if (i === order.length - 1 && !listed) {
        listed = true; // nothing worked: ask Google what this key can use and try those
        (await pickModels()).forEach((n) => { if (!tried.has(n)) order.push(n); });
      }
    }
    throw new Error(last ? last.msg : 'No response from Gemini');
  }

  function hash(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h;
  }

  // ---------- state ----------
  const state = {
    problem: store.get('mc.problem', ''),
    rubric: null,
    rubricPromise: null,
    lines: {}, // desmos id -> {latex, status, matched}
    chat: [],
    more: store.get('mc.more', []),
    set: store.get('mc.set', { title: '', problems: [], index: 0 }),
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

  function currentLines() {
    if (!calc) return [];
    return calc.getExpressions()
      .filter((e) => e.type === 'expression' && e.latex && e.latex.trim())
      .map((e) => ({ id: e.id, latex: e.latex.trim() }));
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
        result = await judge(line.latex, previous);
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
    }
    running = false;
  }

  async function judge(latex, previous) {
    // 1. unfinished typing or broken notation: never red, just gray
    if (!balanced(latex)) return { status: 'unsure', matched: [] };
    // 2. same as the previous line algebraically: it gets that line's mark
    const prev = previous[previous.length - 1];
    if (prev && ['right', 'slip', 'wrong'].includes(prev.status) && window.MathCheck && MathCheck.equivalent(prev.latex, latex) === true) {
      return { status: prev.status, matched: [] };
    }
    // 3. test mode
    if (isMock()) {
      const h = hash(latex);
      const status = ['right', 'slip', 'wrong', 'unsure', 'right'][h % 5];
      const matched = state.rubric && state.rubric.firstSteps && state.rubric.firstSteps.length && status === 'right'
        ? [state.rubric.firstSteps[h % state.rubric.firstSteps.length].id] : [];
      await new Promise((r) => setTimeout(r, 350));
      return { status, matched };
    }
    // 4. the AI
    if (state.rubricPromise) { try { await state.rubricPromise; } catch (e) { /* check without a rubric */ } }
    const prevText = previous.map((p, i) => `${i + 1}. ${p.latex}  [${p.status}]`).join('\n') || '(none)';
    const out = await gemini({
      model: cfg.checkModel || cfg.model,
      thinking: false,
      system: SYS_BASE + ' You judge ONE new line of a student\'s written work in Desmos. Skipped steps are fine if the line is a true, valid consequence of earlier correct lines or a correct setup. Do not require a specific method.',
      prompt: `Problem:\n${state.problem}\n\nReference rubric (may be incomplete; a correct but different method is still right):\n${JSON.stringify(state.rubric || {})}\n\nStudent's earlier lines with marks:\n${prevText}\n\nNEW LINE (LaTeX from Desmos):\n${latex}\n\nChoose exactly one verdict:\n- "right": the line is correct and valid.\n- "slip": the method and idea are right but there is a small human error, like a wrong digit, a dropped sign or a typo (e.g. 2 instead of 3). One tiny fix would make it right.\n- "wrong": really incorrect (wrong method, wrong setup, a real algebra or calculus error beyond a typo).\n- "unsure": you cannot tell, or the line is mostly Desmos syntax or notation trouble (e.g. derivative or other notation typed as plain letters, missing parentheses, stray symbols). NEVER say "wrong" because of Desmos notation.\n\nReturn JSON: {"verdict":"right"|"slip"|"wrong"|"unsure","matched":[ids of rubric firstSteps this line correctly establishes, else []]}`,
    });
    const status = ['right', 'slip', 'wrong', 'unsure'].includes(out.verdict) ? out.verdict : 'unsure';
    return { status, matched: Array.isArray(out.matched) ? out.matched : [] };
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
      try { katex.render(l.latex, tex, { throwOnError: false, errorColor: '#8a93a3' }); } catch (e) { tex.textContent = l.latex; }
      li.append(mark, tex);
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

  async function makeRubric(problem) {
    if (isMock()) {
      const wordy = /tank|rate|gallon|liter|litre|per |pond|room|account|interest|population/i.test(problem);
      return { type: 'test mode', firstSteps: wordy ? [{ id: 's1' }, { id: 's2' }, { id: 's3' }] : [], solutionSteps: [], finalAnswer: '' };
    }
    return gemini({
      model: cfg.model,
      system: SYS_BASE,
      prompt: `Problem:\n${problem}\n\nSolve it carefully, then return JSON:
{"type": short label for the problem type and course level (e.g. "linear equation", "quadratic word problem", "u-substitution integral", "matrix row reduction", "separable differential equation", "mixing word problem", "free-body diagram / equilibrium"),
 "firstSteps": [ {"id":"s1","description":"one setup item the student must establish","acceptable":["LaTeX of the correct equation and equivalent forms"]} ],
 "solutionSteps": ["each key step of a full correct solution, in LaTeX"],
 "finalAnswer": "LaTeX or short text"}
Rules: firstSteps is non-empty ONLY for word/modeling problems where the student must write equations from the story (list EVERY separate setup equation or quantity needed, e.g. each equilibrium equation or each rate equation; include time/unit conversions if asked). For pure math problems use [].`,
    });
  }

  async function setProblem(text, keepWork) {
    state.problem = text.trim();
    store.set('mc.problem', state.problem);
    state.rubric = null;
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
        reply = 'Test mode: add your Gemini key in Settings to talk to the tutor.';
      } else {
        const lines = currentLines().map((l, i) => `${i + 1}. ${l.latex} [${(state.lines[l.id] || {}).status || '?'}]`).join('\n') || '(none yet)';
        reply = await gemini({
          model: cfg.model,
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
        out = await gemini({
          model: cfg.model,
          system: SYS_BASE,
          prompt: `Original problem:\n${src}\n\nWrite ${n} NEW problems of the same type, structure and difficulty, with different numbers, signs and (where applicable) different functions or contexts. If it is a word problem, write new word problems with new scenarios and quantities that need the same kind of setup. Check each one is solvable and has a clean closed-form answer (no ugly numbers). Use plain text with LaTeX inside $...$. Do not include solutions.\nReturn JSON: {"problems":[{"text":"...","topic":"short label"}]}`,
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
    let parts = text.split(/\n\s*(?=(?:problem\s*)?\(?\d{1,3}[.)]\s)/i).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) parts = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    else if (!/^(?:problem\s*)?\(?\d{1,3}[.)]/i.test(parts[0])) parts.shift(); // a title line before problem 1
    return parts;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read that file'));
      r.readAsDataURL(file);
    });
  }

  async function splitWall() {
    const text = $('#wallInput').value.trim();
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
        problems = file ? [] : mockSplit(text);
        if (file) throw new Error('PDF reading needs your Gemini key (test mode can only split pasted text).');
      } else {
        const instr = 'Below is homework, a worksheet or an exam (pasted text or a PDF). Count and extract EVERY separate problem, in order. Drop interface junk (e.g. "Press Space or Enter to edit this math answer", "DETAILS", "MY NOTES", "ASK YOUR TEACHER", "PRACTICE ANOTHER", point values, answers the student already typed, page headers and footers). Keep all parts (a), (b), (c)... of one numbered problem together as ONE problem. Copy each statement faithfully, do not change any numbers, and do NOT solve anything. Write math in LaTeX inside $...$.\nReturn JSON: {"title":"short name for the set","problems":[{"text":"full problem statement"}]}';
        const parts = [{ text: instr }];
        if (file) parts.push({ inlineData: { mimeType: 'application/pdf', data: await fileToBase64(file) } });
        else parts.push({ text: '\n\n' + text });
        const out = await gemini({ model: cfg.model, system: SYS_BASE, prompt: parts });
        problems = (out.problems || []).map((x) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
        if (out.title) title = out.title;
      }
      if (!problems.length) throw new Error('I could not find any problems in that.');
      state.set = { title, problems, index: 0 };
      store.set('mc.set', state.set);
      status.textContent = 'Found ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + '.';
      $('#importBox').open = false;
      gotoProblem(0);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
    }
    btn.disabled = false;
  }

  // ---------- tabs, settings, wiring ----------
  function selectTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    ['check', 'chat', 'more'].forEach((n) => { $('#pane-' + n).hidden = n !== name; });
  }

  function updateBanner() {
    $('#banner').hidden = !isMock();
    $('#bannerText').textContent = 'Test mode: marks are fake until you add your Gemini key.';
  }

  function openSettings() {
    $('#keyInput').value = cfg.key;
    $('#modelInput').value = cfg.model;
    $('#checkModelInput').value = cfg.checkModel;
    $('#testResult').textContent = '';
    $('#settings').showModal();
    $('#keyInput').focus();
  }

  function wire() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    $('#setProblem').addEventListener('click', () => { clearSet(); setProblem($('#problemInput').value); });
    $('#problemInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { clearSet(); setProblem($('#problemInput').value); } });
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
    $('#prevP').addEventListener('click', () => gotoProblem(state.set.index - 1));
    $('#nextP').addEventListener('click', () => gotoProblem(state.set.index + 1));

    $('#openSettings').addEventListener('click', openSettings);
    $('#bannerKey').addEventListener('click', openSettings);
    $('#settingsForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'save') {
        cfg.key = $('#keyInput').value.trim();
        cfg.model = $('#modelInput').value.trim() || DEFAULT_MODEL;
        cfg.checkModel = $('#checkModelInput').value.trim() || cfg.model;
        store.set('mc.cfg', cfg);
        updateBanner();
        if (state.problem) setProblem(state.problem, true);
      }
    });
    $('#testKey').addEventListener('click', async () => {
      const out = $('#testResult');
      const saved = cfg.key;
      cfg.key = $('#keyInput').value.trim();
      out.textContent = 'Testing...';
      try {
        const r = await gemini({ model: $('#modelInput').value.trim() || cfg.model, system: 'Reply with the single word ok.', prompt: 'ping', json: false, thinking: false });
        out.textContent = 'Works (model: ' + lastModelUsed + ')';
      } catch (e) {
        out.textContent = 'Failed: ' + e.message;
      }
      cfg.key = saved;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    startDesmos();
    updateBanner();
    renderMore();
    renderLines();
    renderChat();
    renderCounter();
    if (state.problem) {
      $('#problemInput').value = state.problem;
      setProblem(state.problem);
    }
  });
})();
