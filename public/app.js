// Exam Desk front end: a small hash-routed app. All marking happens on the server.
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k !== null && k !== undefined && k !== false)); return e; };
const when = iso => { try { return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };

let me = null;

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/setup")) { me = null; location.hash = "#/login"; }
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Check the internet connection and try again."), { status: res.status });
  return data;
}

// ---------- shell ----------
function renderNav(route) {
  const top = $("#top"), nav = $("#nav");
  top.hidden = !me;
  nav.innerHTML = "";
  if (!me) return;
  const links = [["#/", "Exams"], ["#/results", "Results"]];
  if (me.role === "admin") links.push(["#/accounts", "Accounts"]);
  for (const [href, label] of links) {
    const a = el("a", { href, textContent: label });
    const cur = href === "#/" ? route === "" || route === "exam" : route === href.slice(2) || (href === "#/results" && (route === "result" || route === "review"));
    if (cur) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
  const out = el("button", { className: "linkbtn", type: "button", textContent: `Log out (${me.name})` });
  out.onclick = async () => { await api("/logout", { method: "POST" }).catch(() => {}); me = null; location.hash = "#/login"; };
  nav.append(out);
}

function setBar(show) { $("#bar").hidden = !show; }
function page(eyebrow, title, meta) {
  main.innerHTML = "";
  const head = el("section", { className: "paperhead" });
  head.innerHTML = `${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ""}<h1>${title}</h1>${meta ? `<div class="meta">${meta}</div>` : ""}`;
  main.append(head);
  return head;
}
function showError(e) {
  main.innerHTML = "";
  main.append(el("div", { className: "notice", textContent: e.message || String(e) }));
}

// ---------- login and first-time setup ----------
function viewLogin() {
  setBar(false);
  page("Weekly exams · Year 8", "Exam Desk");
  const f = el("form", { className: "form card" });
  f.innerHTML = `<label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <div class="err" id="err" role="alert"></div>
    <button class="btn" type="submit">Log in</button>`;
  f.onsubmit = async ev => {
    ev.preventDefault();
    const b = f.querySelector("button"); b.disabled = true; $("#err", f).textContent = "";
    try {
      await api("/login", { method: "POST", body: { username: f.username.value, password: f.password.value } });
      await loadMe(); location.hash = "#/";
    } catch (e) { $("#err", f).textContent = e.message; b.disabled = false; }
  };
  main.append(f);
  f.username.focus();
}

function viewSetup() {
  setBar(false);
  page("First time here", "Set up Exam Desk", "<span>Create the parent account. You'll add the boys' logins next.</span>");
  const f = el("form", { className: "form card" });
  f.innerHTML = `<label>Your name<input type="text" name="name" required placeholder="e.g. Dad"></label>
    <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label>Password<input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
    <label>Password again<input type="password" name="password2" autocomplete="new-password" minlength="6" required></label>
    <div class="err" id="err" role="alert"></div>
    <button class="btn" type="submit">Create account</button>`;
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (f.password.value !== f.password2.value) { $("#err", f).textContent = "The two passwords don't match."; return; }
    try {
      await api("/setup", { method: "POST", body: { displayName: f.name.value, username: f.username.value, password: f.password.value } });
      await loadMe(); location.hash = "#/accounts";
    } catch (e) { $("#err", f).textContent = e.message; }
  };
  main.append(f);
}

// ---------- exam list ----------
function statusPill(x) {
  if (x.status === "marked") return `<span class="pill good">Marked ${x.score} / ${x.total}</span>`;
  if (x.status === "sent") return `<span class="pill wait">Sent · ${x.auto} / ${x.autoMax} so far</span>`;
  if (x.status === "started") return `<span class="pill new">In progress</span>`;
  return `<span class="pill new">New</span>`;
}

async function viewHome() {
  setBar(false);
  const { exams } = await api("/exams");
  const admin = me.role === "admin";
  page("Weekly exams · Year 8", `Hi ${esc(me.name)}`, `<span>${admin ? "Every exam is listed here. Hidden ones don't show for the boys." : "Pick an exam to start. Your answers save as you go."}</span>`);
  const subjects = [...new Set(exams.map(e => e.subject))];
  if (!exams.length) main.append(el("div", { className: "empty", textContent: "No exams yet." }));
  for (const s of subjects) {
    const sec = el("section", { className: "subject" }, el("h2", { textContent: s }));
    const list = el("div", { className: "examlist" });
    for (const x of exams.filter(e => e.subject === s).reverse()) {
      const a = el("a", { className: "examcard", href: "#/exam/" + x.id });
      a.innerHTML = `<div class="t"><b>${esc(x.title)}</b><span class="hint">${esc(x.topic)} · ${x.questions} questions · ${x.total} marks</span></div>
        <div class="row">${x.hidden ? `<span class="pill muted">Hidden</span>` : ""}${statusPill(x)}</div>`;
      if (admin) {
        const t = el("button", { className: "linkbtn", type: "button", textContent: x.hidden ? "Show to boys" : "Hide from boys" });
        t.onclick = async ev => { ev.preventDefault(); ev.stopPropagation(); await api("/admin/exams/" + x.id, { method: "PUT", body: { hidden: !x.hidden } }); route(); };
        a.querySelector(".row").append(t);
      }
      list.append(a);
    }
    sec.append(list); main.append(sec);
  }
}

// ---------- taking an exam ----------
const MATH_SYMS = ["√", "²", "³", "^", "×", "÷", "−", "π"];
const isAnswered = (q, a) => !!a && a.answer !== undefined && a.answer !== null && a.answer !== "";

function symbolBar(target) {
  const bar = el("div", { className: "syms" });
  for (const s of MATH_SYMS) {
    const b = el("button", { type: "button", className: "sym", textContent: s });
    b.setAttribute("aria-label", "Insert " + s);
    b.onmousedown = ev => ev.preventDefault();
    b.onclick = () => {
      const t = target(); const st = t.selectionStart ?? t.value.length, en = t.selectionEnd ?? st;
      t.value = t.value.slice(0, st) + s + t.value.slice(en);
      t.focus(); t.setSelectionRange(st + s.length, st + s.length);
      t.dispatchEvent(new Event("input", { bubbles: true }));
    };
    bar.append(b);
  }
  return bar;
}

function renderQuestion(exam, q, a, locked, onChange) {
  const li = el("li", { className: "q", id: "q-" + q.id });
  if (isAnswered(q, a)) li.classList.add("answered");
  const top = el("div", { className: "qtop" });
  top.innerHTML = `<div class="qnum">${esc(q.id)}</div><div class="qtext">${q.q}</div><span class="marks">${q.marks} mark${q.marks > 1 ? "s" : ""}</span>`;
  li.append(top);
  const isMaths = exam.subject === "Maths";
  const set = (field, v) => { onChange(q, field, v); li.classList.toggle("answered", isAnswered(q, Object.assign({}, a, { [field]: v }))); a = Object.assign({}, a, { [field]: v }); };
  const base = exam.id + "-" + q.id;

  if (q.type === "mc") {
    const box = el("div", { className: "opts", role: "radiogroup" });
    q.options.forEach((o, i) => {
      const r = el("input", { type: "radio", name: base, id: base + "-" + i, value: i, checked: a && String(a.answer) === String(i), disabled: locked });
      r.onchange = () => set("answer", i);
      box.append(el("label", { className: "opt" }, r, el("span", { textContent: String.fromCharCode(65 + i) + "   " + o })));
    });
    li.append(box);
  }
  let work = null;
  if (q.type === "work") {
    work = el("textarea", { id: base + "-work", className: isMaths ? "mathin" : "", value: (a && a.working) || "", disabled: locked, placeholder: "Write each step on a new line" });
    work.oninput = () => set("working", work.value);
    li.append(el("label", { className: "field" }, el("span", { textContent: "Working" }), work));
  }
  if (["num", "text", "factors", "expr", "work"].includes(q.type)) {
    const inp = el("input", { type: "text", id: base + "-ans", className: "mathin", value: (a && a.answer) ?? "", disabled: locked, autocomplete: "off", spellcheck: false });
    inp.oninput = () => set("answer", inp.value);
    li.append(el("label", { className: "field" }, el("span", { textContent: q.type === "work" ? (q.conclusion ? "Conclusion" : "Final answer") : "Answer" }), inp));
    if (q.hint) li.append(el("div", { className: "hint", textContent: q.hint }));
    if (q.type === "factors") li.append(el("div", { className: "hint", textContent: "Type it like 2^3 × 5 (use ^ for powers)" }));
    if (isMaths && !locked) {
      let last = inp;
      if (work) work.addEventListener("focus", () => last = work);
      inp.addEventListener("focus", () => last = inp);
      li.append(symbolBar(() => last));
    }
  }
  if (q.type === "written") {
    const ta = el("textarea", { id: base + "-ans", value: (a && a.answer) || "", disabled: locked, placeholder: "Write in full sentences" });
    ta.oninput = () => set("answer", ta.value);
    li.append(el("label", { className: "field" }, el("span", { textContent: "Your answer" }), ta));
  }
  return li;
}

let leaveGuard = null;
async function viewExam(id) {
  const { exam, submission, draft } = await api("/exams/" + encodeURIComponent(id));
  const localKey = `draft:${me.username}:${exam.id}`;
  const local = store.get(localKey);
  // Use whichever copy of the draft is newer: this device's or the server's.
  let answers = submission ? submission.answers
    : local && (!draft || local.savedAt > draft.updatedAt) ? local.answers : (draft ? draft.answers : {});
  answers = answers || {};
  let dirty = false, saveTimer = null, saving = false;

  page(esc(exam.topic), esc(exam.title), `<span>${exam.questions.length} questions</span><span>${exam.total} marks</span>${exam.minutes ? `<span>About ${exam.minutes} minutes</span>` : ""}`);
  if (exam.intro) main.append(el("div", { className: "intro", innerHTML: exam.intro }));
  if (submission) {
    const d = el("div", { className: "done" });
    d.innerHTML = `<b>You sent this exam on ${when(submission.submittedAt)}.</b><div>${submission.score !== null ? `Final mark: ${submission.score} / ${submission.total}.` : `${submission.auto} / ${submission.autoMax} on the questions checked straight away.`} <a href="#/result/${submission.id}">See your result</a></div>`;
    main.append(d);
  }

  const progress = () => {
    const n = exam.questions.filter(q => isAnswered(q, answers[q.id])).length;
    $("#progtxt").textContent = `${n} of ${exam.questions.length} answered`;
    $("#progfill").style.width = (100 * n / exam.questions.length) + "%";
  };
  const saveState = t => { $("#savestate").textContent = t; };
  async function saveDraft() {
    if (!dirty || saving) return;
    saving = true; dirty = false; saveState("Saving…");
    try { await api(`/exams/${exam.id}/draft`, { method: "PUT", body: { answers } }); saveState("Saved"); }
    catch (e) { dirty = true; saveState(e.status === 409 ? "" : "Not saved yet: check the internet"); }
    saving = false;
  }
  const onChange = (q, field, v) => {
    answers[q.id] = Object.assign({}, answers[q.id], { [field]: v });
    store.set(localKey, { answers, savedAt: new Date().toISOString() });
    dirty = true; saveState("");
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 1200);
    progress();
  };

  const ol = el("ol", { className: "qs" });
  for (const q of exam.questions) ol.append(renderQuestion(exam, q, answers[q.id], !!submission, onChange));
  main.append(ol);
  const confirmBox = el("div");
  main.append(confirmBox);

  if (submission) { setBar(false); return; }
  setBar(true); progress(); saveState(draft || local ? "Saved" : "");
  leaveGuard = () => { clearTimeout(saveTimer); saveDraft(); };
  const btn = $("#submitbtn");
  btn.disabled = false; btn.textContent = "Submit answers";
  btn.onclick = () => {
    const missing = exam.questions.filter(q => !isAnswered(q, answers[q.id])).map(q => q.id);
    confirmBox.innerHTML = "";
    const c = el("div", { className: "confirm", id: "confirm" });
    c.innerHTML = `<b>Send your answers now?</b>
      <div>${missing.length ? `You haven't answered ${missing.length === 1 ? "question" : "questions"} ${missing.join(", ")}. ` : "Every question has an answer. "}You can't change them after sending.</div>
      <div class="err" id="senderr" role="alert"></div>
      <div class="row"><button class="btn" id="send" type="button">Yes, send</button><button class="btn ghost" id="back" type="button">Keep working</button></div>`;
    confirmBox.append(c);
    $("#back", c).onclick = () => { confirmBox.innerHTML = ""; };
    $("#send", c).onclick = async () => {
      const s = $("#send", c); s.disabled = true; s.textContent = "Sending…";
      try {
        clearTimeout(saveTimer);
        const r = await api(`/exams/${exam.id}/submit`, { method: "POST", body: { answers } });
        store.del(localKey); leaveGuard = null;
        setBar(false);
        main.querySelectorAll("input,textarea").forEach(x => x.disabled = true);
        main.querySelectorAll(".syms").forEach(x => x.remove());
        confirmBox.innerHTML = "";
        const d = el("div", { className: "done" });
        d.innerHTML = `<b>Sent. Well done for finishing!</b><div class="score">${r.auto} / ${r.autoMax}</div>
          <div>marks on the questions checked straight away.${r.toReview ? ` Another ${r.toReview} marks for working and written answers get marked when you go through it together.` : ""}</div>
          <div><a href="#/results">Go to Results</a></div>`;
        confirmBox.append(d);
        d.scrollIntoView({ block: "center" });
      } catch (e) {
        $("#senderr", c).textContent = e.message; s.disabled = false; s.textContent = "Yes, send";
      }
    };
    c.scrollIntoView({ block: "center" });
  };
}

// ---------- results ----------
function tick(per, pts, manual, q) {
  const m = manual && manual[q.id] !== undefined ? manual[q.id] : null;
  if (m !== null) return [m === q.marks ? "y" : m === 0 ? "n" : "p", `${m}/${q.marks}`];
  const r = per[q.id];
  return r === true ? ["y", "✓"] : r === false && pts[q.id] === 0 ? ["n", "✗"] : ["p", "to mark"];
}
function answerText(q, a) {
  a = a || {};
  let v = a.answer ?? "";
  if (q.type === "mc" && v !== "") v = String.fromCharCode(65 + Number(v)) + "  " + q.options[v];
  if (a.working) v = (v !== "" ? v + "\n" : "") + "Working: " + a.working;
  return v === "" ? "(blank)" : String(v);
}
function scorePill(s) {
  return s.score !== null
    ? `<span class="pill good">Final ${s.score} / ${s.total}</span>`
    : `<span class="pill wait">Checked so far ${s.auto} / ${s.autoMax} · ${s.toReview} marks to review</span>`;
}

async function viewResults() {
  setBar(false);
  const { results } = await api("/results");
  const admin = me.role === "admin";
  page("Results", admin ? "Everyone's results" : "Your results", `<span>${admin ? "Open a result to mark the working and written answers and add review notes." : "Ticks show the questions checked straight away. Working and written answers get marked in the review."}</span>`);
  let shown = results;
  const list = el("div", { className: "subs" });
  const draw = () => {
    list.innerHTML = "";
    if (!shown.length) list.append(el("div", { className: "empty", textContent: "No exams sent yet." }));
    for (const s of shown) {
      const card = el("a", { className: "sub examcard", href: admin ? "#/review/" + s.id : "#/result/" + s.id });
      card.innerHTML = `<div class="t"><b>${admin ? esc(s.name) + " · " : ""}${esc(s.examTitle)}</b><span class="hint">Sent ${when(s.submittedAt)}</span></div><div>${scorePill(s)}</div>`;
      list.append(card);
    }
  };
  if (admin && results.length) {
    const names = [...new Set(results.map(r => r.name))];
    const sel = el("select", { id: "who", "aria-label": "Show results for" }, el("option", { value: "", textContent: "Everyone" }), ...names.map(n => el("option", { value: n, textContent: n })));
    sel.style.maxWidth = "240px";
    sel.onchange = () => { shown = sel.value ? results.filter(r => r.name === sel.value) : results; draw(); };
    main.append(sel);
  }
  draw(); main.append(list);
}

async function viewResult(id) {
  setBar(false);
  const { submission: s, exam } = await api("/results/" + id);
  page(esc(s.subject), esc(s.examTitle), `<span>Sent ${when(s.submittedAt)}</span>`);
  main.append(el("div", { innerHTML: scorePill(s) }));
  if (s.review.length) {
    const box = el("div", { className: "card" }, el("b", { textContent: "Things to remember" }));
    const ul = el("ul", { className: "review" });
    for (const line of s.review) ul.append(el("li", { textContent: line }));
    box.append(ul); main.append(box);
  }
  if (!exam) return;
  const grid = el("div", { className: "ans card" });
  for (const q of exam.questions) {
    const t = tick(s.per, s.pts, s.manual, q);
    grid.append(el("div", { className: "k", textContent: "Q" + q.id }), el("div", { className: "v", textContent: answerText(q, s.answers[q.id]) }), el("div", { className: "tick " + t[0], textContent: t[1] }));
  }
  main.append(el("h2", { textContent: "Your answers" }), grid);
}

// Parent: mark one submission.
async function viewReview(id) {
  setBar(false);
  const { submission: s, exam } = await api("/results/" + id);
  page(esc(s.name) + " · " + when(s.submittedAt), esc(s.examTitle));
  const head = el("div", { className: "row", innerHTML: scorePill(s) });
  main.append(head);
  if (!exam) { main.append(el("div", { className: "notice", textContent: "This exam has been removed from the site, so it can't be marked here." })); return; }
  const inputs = {};
  const box = el("div", { className: "card" });
  for (const q of exam.questions) {
    const a = s.answers[q.id];
    const auto = s.pts[q.id];
    const cur = s.manual[q.id] ?? auto;
    const r = el("div", { className: "rq" });
    const t = s.per[q.id] === true ? `<span class="tick y">✓ auto</span>` : s.per[q.id] === false && auto === 0 ? `<span class="tick n">✗ auto</span>` : `<span class="tick p">to mark</span>`;
    r.innerHTML = `<div class="qtop"><div class="qnum">${esc(q.id)}</div><div class="qtext">${q.q}</div>${t}</div>`;
    r.append(el("div", { className: "studans", textContent: answerText(q, a) }));
    if (q.ms) r.append(el("div", { className: "ms", innerHTML: "<b>Mark scheme:</b> " + esc(q.ms) }));
    const inp = el("input", { type: "number", min: 0, max: q.marks, step: 1, value: cur ?? "", id: "m-" + q.id });
    inputs[q.id] = { inp, auto };
    r.append(el("label", { className: "markin" }, "Marks", inp, ` / ${q.marks}`));
    box.append(r);
  }
  main.append(box);
  const rev = el("textarea", { id: "review", value: s.review.join("\n"), placeholder: "One line per mistake, e.g. Q4 = 80. Dividing by a number less than 1 makes it bigger." });
  main.append(el("label", { className: "field" }, el("span", { textContent: "Review notes (one line per mistake, the boys see these)" }), rev));
  const msg = el("div", { role: "status" });
  const save = el("button", { className: "btn", type: "button", textContent: "Save marks" });
  const retake = el("button", { className: "btn ghost", type: "button", textContent: "Let them take it again" });
  main.append(el("div", { className: "row", style: "margin-top:14px" }, save, retake), msg);
  save.onclick = async () => {
    const manual = {};
    for (const [qid, { inp, auto }] of Object.entries(inputs)) {
      const v = inp.value === "" ? null : Number(inp.value);
      if (v !== auto) manual[qid] = v;
      else if (s.manual[qid] !== undefined) manual[qid] = null;
    }
    save.disabled = true; msg.className = ""; msg.textContent = "Saving…";
    try {
      const r = await api("/results/" + id, { method: "PUT", body: { manual, review: rev.value.split("\n") } });
      msg.className = "ok";
      msg.textContent = r.score !== null ? `Saved. Final mark ${r.score} / ${s.total}.` : `Saved. ${r.pending} question${r.pending === 1 ? "" : "s"} still to mark (${r.provisional} marks so far).`;
      head.innerHTML = r.score !== null ? `<span class="pill good">Final ${r.score} / ${s.total}</span>` : `<span class="pill wait">${r.pending} to mark</span>`;
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
    save.disabled = false;
  };
  retake.onclick = async () => {
    if (!confirm(`Delete ${s.name}'s answers for ${s.examTitle} so they can take it again?`)) return;
    await api("/results/" + id, { method: "DELETE" });
    location.hash = "#/results";
  };
}

// ---------- accounts (parent) ----------
async function viewAccounts() {
  setBar(false);
  const { users } = await api("/admin/users");
  page("Parent", "Accounts", "<span>Each boy logs in with his own username and password.</span>");
  const t = el("table", { className: "users card" });
  t.innerHTML = "<thead><tr><th>Name</th><th>Username</th><th>Type</th><th></th></tr></thead>";
  const tb = el("tbody");
  for (const u of users) {
    const tr = el("tr");
    tr.innerHTML = `<td>${esc(u.name)}</td><td class="mathin">${esc(u.username)}</td><td>${u.role === "admin" ? "Parent" : "Student"}</td>`;
    const td = el("td", { className: "row" });
    const pw = el("button", { className: "linkbtn", type: "button", textContent: "New password" });
    pw.onclick = async () => {
      const p = prompt(`New password for ${u.name} (at least 6 characters)`);
      if (!p) return;
      try { await api(`/admin/users/${u.id}/password`, { method: "PUT", body: { password: p } }); alert("Password changed."); } catch (e) { alert(e.message); }
    };
    td.append(pw);
    if (u.username !== me.username) {
      const del = el("button", { className: "linkbtn", type: "button", textContent: "Delete" });
      del.style.color = "var(--bad)";
      del.onclick = async () => {
        if (!confirm(`Delete ${u.name}'s account and all of their results?`)) return;
        await api(`/admin/users/${u.id}`, { method: "DELETE" }); route();
      };
      td.append(del);
    }
    tr.append(td); tb.append(tr);
  }
  t.append(tb); main.append(t);

  const f = el("form", { className: "form card", style: "margin-top:18px" });
  f.innerHTML = `<b>Add an account</b>
    <label>Name<input type="text" name="name" required placeholder="e.g. Yassin"></label>
    <label>Username<input type="text" name="username" required autocapitalize="none" spellcheck="false" placeholder="e.g. yassin"></label>
    <label>Password<input type="text" name="password" required minlength="6" autocomplete="off"></label>
    <label>Type<select name="role"><option value="student">Student</option><option value="admin">Parent</option></select></label>
    <div class="err" id="err" role="alert"></div>
    <button class="btn" type="submit">Add account</button>`;
  f.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await api("/admin/users", { method: "POST", body: { name: f.name.value, username: f.username.value, password: f.password.value, role: f.role.value } });
      route();
    } catch (e) { $("#err", f).textContent = e.message; }
  };
  main.append(f);
}

// ---------- router ----------
async function loadMe() { me = (await api("/me")).user; }

async function route() {
  if (leaveGuard) { leaveGuard(); leaveGuard = null; }
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!me) {
      const { needsSetup } = await api("/setup");
      renderNav(name);
      if (needsSetup) return viewSetup();
      if (name !== "login") { location.hash = "#/login"; return; }
      return viewLogin();
    }
    renderNav(name);
    if (name === "login") { location.hash = "#/"; return; }
    if (name === "exam" && arg) await viewExam(arg);
    else if (name === "results") await viewResults();
    else if (name === "result" && arg) await viewResult(arg);
    else if (name === "review" && arg && me.role === "admin") await viewReview(arg);
    else if (name === "accounts" && me.role === "admin") await viewAccounts();
    else await viewHome();
    scrollTo(0, 0);
  } catch (e) { if (e.status !== 401) showError(e); }
}

addEventListener("hashchange", route);
addEventListener("pagehide", () => { if (leaveGuard) leaveGuard(); });
loadMe().catch(() => {}).finally(route);
