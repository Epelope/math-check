// Math Check — static app. Embedded Desmos + per-line AI checks. The AI key lives only in this browser.
(function () {
  const $ = (s) => document.querySelector(s);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: still works this session */ } },
  };
  const cfg = Object.assign({ key: '', model: 'gemini-2.5-flash', checkModel: 'gemini-2.5-flash' }, store.get('mc.cfg', {}));
  const isMock = () => !cfg.key;

  // ---------- Gemini ----------
  const SYS_BASE = 'You are a precise college differential-equations (Math 207) assistant. Be mathematically careful: verify by differentiating or substituting when unsure.';

  async function gemini({ model, system, prompt, history, json = true, thinking = true }, attempt = 0) {
    const contents = history || [{ role: 'user', parts: [{ text: prompt }] }];
    const generationConfig = { temperature: 0.2 };
    if (json) generationConfig.responseMimeType = 'application/json';
    if (!thinking && /2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
    });
    if (res.status === 429 && attempt < 1) {
      await new Promise((r) => setTimeout(r, 4000));
      return gemini({ model, system, prompt, history, json, thinking }, attempt + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Gemini error ' + res.status);
    const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
    if (!json) return text;
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
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
      prompt: `Problem:\n${state.problem}\n\nReference rubric (may be incomplete; a correct but different method is still right):\n${JSON.stringify(state.rubric || {})}\n\nStudent's earlier lines with marks:\n${prevText}\n\nNEW LINE (LaTeX from Desmos):\n${latex}\n\nChoose exactly one verdict:\n- "right": the line is correct and valid.\n- "slip": the method and idea are right but there is a small human error, like a wrong digit, a dropped sign or a typo (e.g. 2 instead of 3). One tiny fix would make it right.\n- "wrong": really incorrect (wrong method, wrong setup, a real algebra or calculus error beyond a typo).\n- "unsure": you cannot tell, or the line is mostly Desmos syntax or notation trouble (e.g. dy/dx or y' typed as plain letters, missing parentheses, stray symbols). NEVER say "wrong" because of Desmos notation.\n\nReturn JSON: {"verdict":"right"|"slip"|"wrong"|"unsure","matched":[ids of rubric firstSteps this line correctly establishes, else []]}`,
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
{"type": short label (e.g. "separable IVP", "first-order linear", "exact equation", "mixing word problem", "Euler's method"),
 "firstSteps": [ {"id":"s1","description":"one setup item the student must establish","acceptable":["LaTeX of the correct equation and equivalent forms"]} ],
 "solutionSteps": ["each key step of a full correct solution, in LaTeX"],
 "finalAnswer": "LaTeX or short text"}
Rules: firstSteps is non-empty ONLY for word/modeling problems where the student must write equations from the story (list EVERY separate setup equation or quantity needed, e.g. both dV/dt and dQ/dt; include time/unit conversions if asked). For pure math problems use [].`,
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
          system: SYS_BASE + ' You are tutoring a student who learns by doing homework. When they are stuck, explain the next step fully with the reasoning behind it, but do NOT solve the whole problem or hand over the final answer unless they explicitly ask for it. Answer only what they asked. Keep it focused; write math in LaTeX inside $...$.\n\nProblem:\n' + state.problem + '\n\nPrivate rubric (do not dump it): ' + JSON.stringify(state.rubric || {}) + '\n\nStudent\'s lines so far (LaTeX, with marks):\n' + lines,
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
      use.addEventListener('click', () => { $('#problemInput').value = q.text; selectTab('check'); setProblem(q.text); });
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
    $('#setProblem').addEventListener('click', () => setProblem($('#problemInput').value));
    $('#problemInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) setProblem($('#problemInput').value); });
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = $('#chatInput').value.trim();
      if (!t) return;
      $('#chatInput').value = '';
      sendChat(t);
    });
    $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
    $('#makeMore').addEventListener('click', makeMore);

    $('#openSettings').addEventListener('click', openSettings);
    $('#bannerKey').addEventListener('click', openSettings);
    $('#settingsForm').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'save') {
        cfg.key = $('#keyInput').value.trim();
        cfg.model = $('#modelInput').value.trim() || 'gemini-2.5-flash';
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
        out.textContent = 'Works: ' + r.trim().slice(0, 20);
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
    if (state.problem) {
      $('#problemInput').value = state.problem;
      setProblem(state.problem);
    }
  });
})();
