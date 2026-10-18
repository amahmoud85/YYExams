import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { check, mark, finalScore } from "../src/marking.js";

const exams = readdirSync("exams").map(f => JSON.parse(readFileSync("exams/" + f, "utf8")));

test("every exam marks full answers as full marks on auto questions", () => {
  for (const e of exams) {
    const ans = {};
    for (const q of e.questions) {
      if (q.key === undefined) continue;
      const k = q.key;
      ans[q.id] = { answer: q.type === "mc" ? k : typeof k === "number" ? String(k) : Array.isArray(k) ? k[0]
        : k.num !== undefined ? String(k.num) : k.text ? k.text[0] : k.expr ? k.expr
        : k.pairs ? Object.entries(k.pairs).map(([a, b]) => `${a}=${b}`).join(", ")
        : Object.entries(k).map(([p, n]) => n > 1 ? `${p}^${n}` : p).join("×") };
    }
    const r = mark(e, ans);
    const wrong = e.questions.filter(q => q.key !== undefined && r.per[q.id] !== true).map(q => q.id);
    assert.deepEqual(wrong, [], e.id);
  }
});

test("typical answer formats", () => {
  assert.equal(check({ type: "num", key: -16 }, { answer: "−16" }), true);
  assert.equal(check({ type: "num", key: 1200 }, { answer: "1,200" }), true);
  assert.equal(check({ type: "expr", key: { expr: "3n+2", noParen: true } }, { answer: "2 + 3n" }), true);
  assert.equal(check({ type: "expr", key: { expr: "3n+2", noParen: true } }, { answer: "3(n+1)-1" }), false);
  assert.equal(check({ type: "factors", key: { 2: 3, 5: 1 } }, { answer: "2³ × 5" }), true);
  assert.equal(check({ type: "written" }, { answer: "anything" }), null);
  assert.equal(check({ type: "mc", key: 2 }, {}), false);
});

test("final score uses reviewer marks over auto marks", () => {
  const e = { questions: [{ id: "1", marks: 2 }, { id: "2", marks: 3 }] };
  assert.deepEqual(finalScore(e, { 1: 2, 2: null }, {}), { score: 2, pending: 1 });
  assert.deepEqual(finalScore(e, { 1: 2, 2: null }, { 2: 1 }), { score: 3, pending: 0 });
  assert.deepEqual(finalScore(e, { 1: 2, 2: null }, { 1: 0, 2: 3 }), { score: 3, pending: 0 });
});

test("blank worked and written questions score 0 without review", () => {
  const e = { questions: [{ id: "1", type: "work", marks: 3, key: { num: 5 } }, { id: "2", type: "written", marks: 4 }, { id: "3", type: "written", marks: 2 }] };
  const r = mark(e, { 3: { answer: "Because…" } });
  assert.deepEqual(r.pts, { 1: 0, 2: 0, 3: null });
  assert.equal(r.review, 2);
});
