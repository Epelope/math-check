// Local algebra checker: is one LaTeX line numerically equivalent to another?
// It can only ever say "yes, same as that line" (true) or "can't tell" (null/false) — it never marks anything wrong.
(function () {
  const FN = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'log10', 'log', 'exp', 'sqrt'];
  const MATHJS_NAME = { arcsin: 'asin', arccos: 'acos', arctan: 'atan' };
  const CONSTS = new Set(['e', 'pi', 'theta']);

  function toExpr(latex) {
    let s = latex;
    // anything we can't safely turn into plain algebra: bail out
    if (/\\int|\\sum|\\prod|\\lim|'|\\partial|\\text|\\mathrm|\\(le|ge|ne)(?![a-z])|\\approx|[<>,:;_|!]|\\frac\s*\{d|d[xyt]/.test(s)) return null;
    s = s.replace(/\\left|\\right/g, '').replace(/\\cdot|\\times/g, '*').replace(/\\[,;:! ]/g, ' ');
    let prev;
    let n = 0;
    do {
      prev = s;
      s = s
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, ' sqrt($1)')
        .replace(/\^\s*\{([^{}]*)\}/g, '^($1)');
      n++;
    } while (s !== prev && n < 20);
    s = s
      .replace(/\\(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|exp)(?![a-z])/g, ' $1 ')
      .replace(/\\ln(?![a-z])/g, ' log ')
      .replace(/\\log(?![a-z])/g, ' log10 ')
      .replace(/\\pi(?![a-z])/g, ' pi ')
      .replace(/\\theta(?![a-z])/g, ' theta ');
    if (/[\\{}]/.test(s)) return null;

    const re = new RegExp('\\s*(\\d+\\.?\\d*|\\.\\d+|' + FN.join('|') + '|pi|theta|[A-Za-z]|[()+\\-*/^=])', 'y');
    const toks = [];
    let m;
    let pos = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m) {
        if (/^\s*$/.test(s.slice(pos))) break;
        return null;
      }
      pos = re.lastIndex;
      const t = m[1];
      let type;
      if (/^[\d.]/.test(t)) type = 'num';
      else if (FN.includes(t)) type = 'fn';
      else if (t === 'pi' || t === 'theta' || /^[A-Za-z]$/.test(t)) type = 'id';
      else if (t === '(') type = 'lp';
      else if (t === ')') type = 'rp';
      else type = 'op';
      toks.push({ t: MATHJS_NAME[t] || t, type });
    }
    let out = '';
    for (let i = 0; i < toks.length; i++) {
      const p = toks[i - 1];
      const c = toks[i];
      if (c.type === 'fn' && !(toks[i + 1] && toks[i + 1].type === 'lp')) return null;
      if (p && ['num', 'id', 'rp'].includes(p.type) && ['id', 'fn', 'lp', 'num'].includes(c.type)) out += '*';
      out += c.t;
    }
    return out;
  }

  function parse(latex) {
    const e = toExpr(latex);
    if (e == null) return null;
    const parts = e.split('=');
    if (parts.length === 1) return { kind: 'expr', a: parts[0] };
    if (parts.length === 2 && parts[0] && parts[1]) return { kind: 'eq', a: parts[0], b: parts[1] };
    return null;
  }

  function vars(node) {
    const names = new Set();
    node.filter((n, path) => n.isSymbolNode && path !== 'fn').forEach((n) => {
      if (!CONSTS.has(n.name)) names.add(n.name);
    });
    return names;
  }

  function equivalent(latexA, latexB) {
    try {
      if (typeof math === 'undefined') return null;
      const A = parse(latexA);
      const B = parse(latexB);
      if (!A || !B || A.kind !== B.kind) return null;
      const exprs = A.kind === 'expr' ? [A.a, B.a] : [`(${A.a})-(${A.b})`, `(${B.a})-(${B.b})`];
      const nodes = exprs.map((x) => math.parse(x));
      const names = new Set();
      nodes.forEach((nd) => vars(nd).forEach((v) => names.add(v)));
      const codes = nodes.map((nd) => nd.compile());
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      let good = 0;
      let ratio = null;
      for (let k = 0; k < 12; k++) {
        const scope = {};
        names.forEach((v) => (scope[v] = 0.37 + rnd() * 2.44));
        const x = codes[0].evaluate({ ...scope });
        const y = codes[1].evaluate({ ...scope });
        if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) continue;
        if (A.kind === 'expr') {
          if (Math.abs(x - y) > 1e-7 * (1 + Math.abs(x))) return false;
        } else {
          if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) { good++; continue; }
          if (Math.abs(x) < 1e-9 || Math.abs(y) < 1e-9) return false;
          const r = y / x;
          if (ratio == null) ratio = r;
          else if (Math.abs(r - ratio) > 1e-6 * (1 + Math.abs(ratio))) return false;
        }
        good++;
      }
      return good >= 4 ? true : null;
    } catch (e) {
      return null;
    }
  }

  window.MathCheck = { equivalent, toExpr };
})();
