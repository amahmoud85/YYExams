// Exam Desk: a small exam site on Cloudflare Workers + D1.
// Static pages live in public/; everything under /api/ is handled here.
import EXAMS from "./exams-data.js";
import { mark, totalMarks, finalScore } from "./marking.js";

const SESSION_DAYS = 60;
const PBKDF2_ITERATIONS = 100000; // the Workers maximum

// ---------- schema (created on first request, so deploys need no migration step) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','student')), pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS drafts (user_id INTEGER NOT NULL, exam_id TEXT NOT NULL, answers TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (user_id, exam_id))`,
  `CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, exam_id TEXT NOT NULL, answers TEXT NOT NULL,
     per TEXT NOT NULL, pts TEXT NOT NULL, auto INTEGER NOT NULL, auto_max INTEGER NOT NULL, to_review INTEGER NOT NULL, total INTEGER NOT NULL,
     manual TEXT, score INTEGER, review TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE (user_id, exam_id))`,
  `CREATE TABLE IF NOT EXISTS exam_state (exam_id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (username TEXT NOT NULL, at INTEGER NOT NULL)`,
];
let schemaReady = null;
const ensureSchema = env => (schemaReady ??= env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; }));

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const now = () => new Date().toISOString();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randomToken = (n = 32) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
const sha256 = async s => b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function hashPassword(password, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: b64(bits), salt };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "That request wasn't valid."); }
}
function cleanUsername(u) {
  u = String(u ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,30}$/.test(u)) throw new HttpError(400, "Usernames are 2 to 30 letters or numbers, with no spaces.");
  return u;
}
function checkPassword(p) {
  if (typeof p !== "string" || p.length < 6) throw new HttpError(400, "Passwords need at least 6 characters.");
  if (p.length > 200) throw new HttpError(400, "That password is too long.");
  return p;
}

// ---------- sessions ----------
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
const sessionCookie = (token, maxAge) => `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function startSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

async function currentUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  if (env.ADMIN_API_TOKEN && auth.startsWith("Bearer ")) {
    if (timingSafeEqual(auth.slice(7), env.ADMIN_API_TOKEN)) return { id: 0, username: "api", display_name: "API", role: "admin" };
    throw new HttpError(401, "Bad API token.");
  }
  const token = getCookie(req, "sid");
  if (!token) return null;
  return env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(token), Date.now()).first();
}

// ---------- exams ----------
const examById = id => EXAMS.find(e => e.id === id);
// What the browser sees: no answer keys, no mark-scheme notes.
const publicExam = e => ({
  ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== "questions")),
  total: totalMarks(e),
  questions: e.questions.map(({ key, ms, ...q }) => q),
});
async function hiddenSet(env) {
  const { results } = await env.DB.prepare("SELECT exam_id FROM exam_state WHERE hidden = 1").all();
  return new Set(results.map(r => r.exam_id));
}

function subRow(r, withAnswers) {
  const exam = examById(r.exam_id);
  const out = {
    id: r.id, userId: r.user_id, name: r.display_name, username: r.username, examId: r.exam_id,
    examTitle: exam ? exam.title : r.exam_id, subject: exam ? exam.subject : "",
    auto: r.auto, autoMax: r.auto_max, toReview: r.to_review, total: r.total,
    score: r.score, review: r.review ? JSON.parse(r.review) : [], submittedAt: r.submitted_at, reviewedAt: r.reviewed_at,
    per: JSON.parse(r.per), pts: JSON.parse(r.pts), manual: r.manual ? JSON.parse(r.manual) : {},
  };
  if (withAnswers) out.answers = JSON.parse(r.answers);
  return out;
}
const SUB_SELECT = `SELECT s.*, u.display_name, u.username FROM submissions s JOIN users u ON u.id = s.user_id`;

// Keep only answer fields for real questions, as short strings.
function cleanAnswers(exam, answers) {
  const out = {};
  for (const q of exam.questions) {
    const a = answers && answers[q.id];
    if (!a || typeof a !== "object") continue;
    const o = {};
    if (a.answer !== undefined && a.answer !== null && a.answer !== "") o.answer = q.type === "mc" ? Number(a.answer) : String(a.answer).slice(0, 5000);
    if (a.working) o.working = String(a.working).slice(0, 10000);
    if (Object.keys(o).length) out[q.id] = o;
  }
  return out;
}

// ---------- routes ----------
async function route(req, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  const seg = path.split("/").slice(2); // after /api

  // Writes from a browser must come from this site.
  if (method !== "GET" && !req.headers.get("authorization")) {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Wrong origin.");
  }

  const userCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n;

  if (path === "/api/setup" && method === "GET") return json({ needsSetup: (await userCount()) === 0 });
  if (path === "/api/setup" && method === "POST") {
    if ((await userCount()) > 0) throw new HttpError(403, "This site is already set up. Log in instead.");
    const b = await body(req);
    if (env.SETUP_CODE && b.setupCode !== env.SETUP_CODE) throw new HttpError(403, "That setup code isn't right.");
    const username = cleanUsername(b.username), password = checkPassword(b.password);
    const name = String(b.displayName || username).trim().slice(0, 40);
    const { hash, salt } = await hashPassword(password);
    const r = await env.DB.prepare("INSERT INTO users (username, display_name, role, pw_hash, pw_salt, created_at) VALUES (?, ?, 'admin', ?, ?, ?)")
      .bind(username, name, hash, salt, now()).run();
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, r.meta.last_row_id) });
  }

  if (path === "/api/login" && method === "POST") {
    const b = await body(req);
    const username = String(b.username ?? "").trim().toLowerCase();
    const since = Date.now() - 15 * 60e3;
    const tries = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ?").bind(username, since).first();
    if (tries.n >= 10) throw new HttpError(429, "Too many tries. Wait 15 minutes and try again.");
    const u = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    const ok = u && timingSafeEqual((await hashPassword(String(b.password ?? ""), u.pw_salt)).hash, u.pw_hash);
    if (!ok) {
      await env.DB.prepare("INSERT INTO login_attempts (username, at) VALUES (?, ?)").bind(username, Date.now()).run();
      throw new HttpError(401, "That username or password isn't right.");
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_attempts WHERE username = ? OR at < ?").bind(username, since),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
    ]);
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, u.id) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = getCookie(req, "sid");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const me = await currentUser(req, env);
  if (path === "/api/me") return json({ user: me ? { username: me.username, name: me.display_name, role: me.role } : null });
  if (!me) throw new HttpError(401, "Please log in.");
  const admin = me.role === "admin";
  const needAdmin = () => { if (!admin) throw new HttpError(403, "Only a parent account can do that."); };

  // GET /api/exams: the exam list, with this user's status for each.
  if (path === "/api/exams" && method === "GET") {
    const hidden = await hiddenSet(env);
    const { results: mine } = await env.DB.prepare("SELECT exam_id, auto, auto_max, score, total FROM submissions WHERE user_id = ?").bind(me.id).all();
    const { results: drafts } = await env.DB.prepare("SELECT exam_id FROM drafts WHERE user_id = ?").bind(me.id).all();
    const byExam = Object.fromEntries(mine.map(r => [r.exam_id, r]));
    const started = new Set(drafts.map(r => r.exam_id));
    return json({
      exams: EXAMS.filter(e => admin || !hidden.has(e.id)).map(e => {
        const s = byExam[e.id];
        return {
          id: e.id, subject: e.subject, title: e.title, short: e.short, topic: e.topic, minutes: e.minutes,
          questions: e.questions.length, total: totalMarks(e), hidden: hidden.has(e.id),
          status: s ? (s.score !== null ? "marked" : "sent") : started.has(e.id) ? "started" : "new",
          score: s ? s.score : null, auto: s ? s.auto : null, autoMax: s ? s.auto_max : null,
        };
      }),
    });
  }

  // GET /api/exams/:id: one exam (no keys), plus this user's draft or submission.
  if (seg[0] === "exams" && seg.length === 2 && method === "GET") {
    const exam = examById(seg[1]);
    if (!exam || (!admin && (await hiddenSet(env)).has(exam.id))) throw new HttpError(404, "That exam isn't available.");
    const sub = await env.DB.prepare(SUB_SELECT + " WHERE s.user_id = ? AND s.exam_id = ?").bind(me.id, exam.id).first();
    const draft = sub ? null : await env.DB.prepare("SELECT answers, updated_at FROM drafts WHERE user_id = ? AND exam_id = ?").bind(me.id, exam.id).first();
    return json({
      exam: publicExam(exam),
      submission: sub ? subRow(sub, true) : null,
      draft: draft ? { answers: JSON.parse(draft.answers), updatedAt: draft.updated_at } : null,
    });
  }

  // PUT /api/exams/:id/draft: autosave.
  if (seg[0] === "exams" && seg[2] === "draft" && method === "PUT") {
    const exam = examById(seg[1]);
    if (!exam) throw new HttpError(404, "That exam isn't available.");
    const b = await body(req);
    const done = await env.DB.prepare("SELECT 1 FROM submissions WHERE user_id = ? AND exam_id = ?").bind(me.id, exam.id).first();
    if (done) throw new HttpError(409, "This exam has already been sent.");
    await env.DB.prepare(`INSERT INTO drafts (user_id, exam_id, answers, updated_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT (user_id, exam_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`)
      .bind(me.id, exam.id, JSON.stringify(cleanAnswers(exam, b.answers)), now()).run();
    return json({ ok: true, savedAt: now() });
  }

  // POST /api/exams/:id/submit: mark and store. One submission per person per exam.
  if (seg[0] === "exams" && seg[2] === "submit" && method === "POST") {
    if (me.id === 0) throw new HttpError(400, "The API token can't sit exams.");
    const exam = examById(seg[1]);
    if (!exam || (!admin && (await hiddenSet(env)).has(exam.id))) throw new HttpError(404, "That exam isn't available.");
    const answers = cleanAnswers(exam, (await body(req)).answers);
    const r = mark(exam, answers);
    const res = await env.DB.prepare(`INSERT INTO submissions (user_id, exam_id, answers, per, pts, auto, auto_max, to_review, total, submitted_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, exam_id) DO NOTHING`)
      .bind(me.id, exam.id, JSON.stringify(answers), JSON.stringify(r.per), JSON.stringify(r.pts), r.auto, r.autoMax, r.review, totalMarks(exam), now()).run();
    if (!res.meta.changes) throw new HttpError(409, "This exam has already been sent.");
    await env.DB.prepare("DELETE FROM drafts WHERE user_id = ? AND exam_id = ?").bind(me.id, exam.id).run();
    return json({ ok: true, auto: r.auto, autoMax: r.autoMax, toReview: r.review, per: r.per });
  }

  // GET /api/results: own results, or everyone's for a parent. ?answers=1 includes the answers.
  if (path === "/api/results" && method === "GET") {
    const withAnswers = url.searchParams.get("answers") === "1";
    const q = admin ? env.DB.prepare(SUB_SELECT + " ORDER BY s.submitted_at DESC")
                    : env.DB.prepare(SUB_SELECT + " WHERE s.user_id = ? ORDER BY s.submitted_at DESC").bind(me.id);
    return json({ results: (await q.all()).results.map(r => subRow(r, withAnswers)) });
  }

  // GET /api/results/:id: one submission. A parent also gets the full exam with keys and mark scheme.
  if (seg[0] === "results" && seg.length === 2 && method === "GET") {
    const r = await env.DB.prepare(SUB_SELECT + " WHERE s.id = ?").bind(Number(seg[1])).first();
    if (!r || (!admin && r.user_id !== me.id)) throw new HttpError(404, "Result not found.");
    const exam = examById(r.exam_id);
    return json({ submission: subRow(r, true), exam: exam ? (admin ? { ...exam, total: totalMarks(exam) } : publicExam(exam)) : null });
  }

  // PUT /api/results/:id (parent): marks per question and review lines. {manual:{qid:marks}, review:["Q3 = ...", ...]}
  if (seg[0] === "results" && seg.length === 2 && method === "PUT") {
    needAdmin();
    const r = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(Number(seg[1])).first();
    if (!r) throw new HttpError(404, "Result not found.");
    const exam = examById(r.exam_id);
    if (!exam) throw new HttpError(404, "That exam no longer exists.");
    const b = await body(req);
    const manual = { ...(r.manual ? JSON.parse(r.manual) : {}) };
    for (const q of exam.questions) {
      if (!b.manual || !(q.id in b.manual)) continue;
      const v = b.manual[q.id];
      if (v === null || v === "") delete manual[q.id];
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > q.marks) throw new HttpError(400, `Q${q.id} can have 0 to ${q.marks} marks.`);
        manual[q.id] = n;
      }
    }
    const review = Array.isArray(b.review) ? b.review.map(s => String(s).trim().slice(0, 500)).filter(Boolean) : (r.review ? JSON.parse(r.review) : []);
    const { score, pending } = finalScore(exam, JSON.parse(r.pts), manual);
    const final = pending === 0 ? score : null;
    await env.DB.prepare("UPDATE submissions SET manual = ?, review = ?, score = ?, reviewed_at = ? WHERE id = ?")
      .bind(JSON.stringify(manual), JSON.stringify(review), final, now(), r.id).run();
    return json({ ok: true, score: final, pending, provisional: score });
  }

  // DELETE /api/results/:id (parent): remove a submission so the exam can be taken again.
  if (seg[0] === "results" && seg.length === 2 && method === "DELETE") {
    needAdmin();
    await env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(Number(seg[1])).run();
    return json({ ok: true });
  }

  // PUT /api/admin/exams/:id {hidden}
  if (seg[0] === "admin" && seg[1] === "exams" && seg.length === 3 && method === "PUT") {
    needAdmin();
    if (!examById(seg[2])) throw new HttpError(404, "No such exam.");
    const b = await body(req);
    await env.DB.prepare("INSERT INTO exam_state (exam_id, hidden) VALUES (?, ?) ON CONFLICT (exam_id) DO UPDATE SET hidden = excluded.hidden")
      .bind(seg[2], b.hidden ? 1 : 0).run();
    return json({ ok: true });
  }

  // Accounts (parent only).
  if (seg[0] === "admin" && seg[1] === "users") {
    needAdmin();
    if (seg.length === 2 && method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, username, display_name AS name, role, created_at AS createdAt FROM users ORDER BY role, display_name").all();
      return json({ users: results });
    }
    if (seg.length === 2 && method === "POST") {
      const b = await body(req);
      const username = cleanUsername(b.username), password = checkPassword(b.password);
      const role = b.role === "admin" ? "admin" : "student";
      const name = String(b.name || username).trim().slice(0, 40);
      const { hash, salt } = await hashPassword(password);
      try {
        await env.DB.prepare("INSERT INTO users (username, display_name, role, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(username, name, role, hash, salt, now()).run();
      } catch (e) {
        if (/UNIQUE/.test(String(e))) throw new HttpError(409, "That username is taken.");
        throw e;
      }
      return json({ ok: true });
    }
    const id = Number(seg[2]);
    if (seg.length === 4 && seg[3] === "password" && method === "PUT") {
      const { hash, salt } = await hashPassword(checkPassword((await body(req)).password));
      const r = await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(hash, salt, id).run();
      if (!r.meta.changes) throw new HttpError(404, "No such account.");
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (seg.length === 3 && method === "DELETE") {
      if (id === me.id) throw new HttpError(400, "You can't delete your own account.");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM drafts WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM submissions WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      await ensureSchema(env);
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};
