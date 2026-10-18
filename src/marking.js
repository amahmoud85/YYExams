// Auto-marking. Runs on the server so the answer keys never reach the browser.
// Question types: mc, num, text, factors, expr, work (num/text/pairs key), written.

const SUP = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-" };
const supToCaret = s => s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, m => "^" + [...m].map(c => SUP[c]).join(""));

export function norm(s) {
  s = supToCaret(String(s ?? "").toLowerCase().trim());
  s = s.replace(/[−–—]/g, "-").replace(/[×*✕]/g, "x").replace(/·/g, ".");
  s = s.replace(/sqrt|root/g, "√").replace(/\s+/g, "").replace(/,/g, "");
  s = s.replace(/^([a-z]+|answer)?=/, "");
  s = s.replace(/(cm\^2|cm2|cm|km\/h|m\/s|nm|n|pa|°c|s|m)$/, "");
  return s;
}

export function asNum(s) {
  const n = norm(s).replace(/^£/, "");
  const f = n.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (f) return parseFloat(f[1]) / parseFloat(f[2]);
  const m = n.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

// Algebra: compare expressions by evaluating both at a few sample values.
function exprText(s) {
  s = supToCaret(String(s ?? "").toLowerCase());
  s = s.replace(/[−–—]/g, "-").replace(/[×✕·]/g, "*").replace(/÷/g, "/").replace(/\s+/g, "");
  return s.replace(/^[a-z]+=/, "");
}

function parseExpr(src) {
  const toks = src.match(/\d+(?:\.\d+)?|[a-z]|[-+*/^()]/g) || [];
  if (toks.join("") !== src) return null;
  const t = [];
  for (const k of toks) {
    const p = t[t.length - 1];
    if (p !== undefined && /^[\d.a-z)]+$/.test(p) && /^[\d.a-z(]/.test(k) && !(/^\d/.test(p) && /^\d/.test(k))) t.push("*");
    t.push(k);
  }
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  function expr() { let f = term(); while (peek() === "+" || peek() === "-") { const o = next(), g = term(); const a = f; f = o === "+" ? v => a(v) + g(v) : v => a(v) - g(v); } return f; }
  function term() { let f = unary(); while (peek() === "*" || peek() === "/") { const o = next(), g = unary(); const a = f; f = o === "*" ? v => a(v) * g(v) : v => a(v) / g(v); } return f; }
  function unary() { if (peek() === "-") { next(); const g = unary(); return v => -g(v); } if (peek() === "+") { next(); return unary(); } return power(); }
  function power() { const b = primary(); if (peek() === "^") { next(); const e = unary(); return v => Math.pow(b(v), e(v)); } return b; }
  function primary() {
    const k = next();
    if (k === undefined) throw 0;
    if (k === "(") { const f = expr(); if (next() !== ")") throw 0; return f; }
    if (/^\d/.test(k)) { const n = parseFloat(k); return () => n; }
    if (/^[a-z]$/.test(k)) return v => v[k];
    throw 0;
  }
  try { const f = expr(); return i === t.length ? f : null; } catch { return null; }
}

function sameExpr(ans, k) {
  const a = exprText(ans), b = exprText(k.expr);
  if (!a) return false;
  if (k.noParen && /[()]/.test(a)) return false;
  if (k.maxLen && a.length > k.maxLen) return false;
  const fa = parseExpr(a), fb = parseExpr(b);
  if (!fa || !fb) return false;
  const vars = new Set((a + b).match(/[a-z]/g) || []);
  const bv = new Set(b.match(/[a-z]/g) || []);
  for (const x of vars) if (!bv.has(x)) return false;
  const samples = [1.37, -2.11, 0.73, 3.29, -0.58];
  for (let s = 0; s < 4; s++) {
    const v = {}; let j = s;
    for (const x of vars) v[x] = samples[(j++) % samples.length] + s * 0.17;
    const ya = fa(v), yb = fb(v);
    if (!isFinite(ya) || !isFinite(yb) || Math.abs(ya - yb) > 1e-6 * Math.max(1, Math.abs(yb))) return false;
  }
  return true;
}

function samePairs(ans, want) {
  const got = {};
  const s = String(ans ?? "").toLowerCase().replace(/[−–—]/g, "-").replace(/£/g, "");
  for (const m of s.matchAll(/([a-z])\s*=\s*(-?\d+(?:\.\d+)?)/g)) got[m[1]] = parseFloat(m[2]);
  return Object.keys(want).every(k => got[k] !== undefined && Math.abs(got[k] - want[k]) < 1e-9);
}

function asFactors(s) {
  const out = {};
  for (const t of norm(s).split("x")) {
    const m = t.match(/^(\d+)(\^(\d+))?$/);
    if (!m) return null;
    out[m[1]] = (out[m[1]] || 0) + (m[3] ? +m[3] : 1);
  }
  return out;
}

function sameFactors(a, b) {
  if (!a) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && kb.every(k => a[k] === b[k]);
}

// true = right, false = wrong, null = needs a person to mark.
export function check(q, a) {
  const k = q.key;
  const val = a && a.answer;
  if (val === undefined || val === null || val === "") return k === undefined ? null : false;
  if (k === undefined) return null;
  if (q.type === "mc") return Number(val) === k;
  if (q.type === "num") return Math.abs(asNum(val) - k) < 1e-9;
  if (q.type === "text") return k.includes(norm(val));
  if (q.type === "factors") return sameFactors(asFactors(val), k);
  if (q.type === "expr") return sameExpr(val, k);
  if (q.type === "work") {
    if (k.num !== undefined) return Math.abs(asNum(val) - k.num) < 1e-9;
    if (k.text) return k.text.includes(norm(val));
    if (k.pairs) return samePairs(val, k.pairs);
  }
  return null;
}

const AUTO_ONLY = ["mc", "num", "text", "factors", "expr"];

// pts[qid] is the marks given straight away, or null when the question waits for review.
// A worked question with the right final answer gets full marks; otherwise its working is reviewed.
// A blank question gets 0 straight away.
export function mark(exam, answers) {
  let auto = 0, autoMax = 0, review = 0;
  const per = {}, pts = {};
  for (const q of exam.questions) {
    const a = (answers || {})[q.id];
    const r = check(q, a);
    per[q.id] = r;
    const blank = !a || ((a.answer === undefined || a.answer === "") && !a.working);
    if (blank && !AUTO_ONLY.includes(q.type)) { per[q.id] = false; autoMax += q.marks; pts[q.id] = 0; }
    else if (AUTO_ONLY.includes(q.type)) { autoMax += q.marks; pts[q.id] = r ? q.marks : 0; if (r) auto += q.marks; }
    else if (q.type === "work" && r === true) { autoMax += q.marks; auto += q.marks; pts[q.id] = q.marks; }
    else { review += q.marks; pts[q.id] = null; }
  }
  return { auto, autoMax, review, per, pts };
}

export const totalMarks = exam => exam.questions.reduce((s, q) => s + q.marks, 0);

// Final marks: a reviewer's mark for a question wins over the automatic one.
export function finalScore(exam, pts, manual) {
  let score = 0, pending = 0;
  for (const q of exam.questions) {
    const m = manual && manual[q.id] !== undefined && manual[q.id] !== null && manual[q.id] !== "" ? Number(manual[q.id]) : pts[q.id];
    if (m === null || m === undefined || Number.isNaN(m)) pending++;
    else score += Math.max(0, Math.min(q.marks, m));
  }
  return { score, pending };
}
