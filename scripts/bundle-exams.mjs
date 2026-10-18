// Collects exams/*.json into src/exams-data.js, which the Worker imports.
// Runs automatically before every `wrangler dev` / `wrangler deploy`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "exams");
const ids = new Set();
const exams = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
  const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const k of ["id", "year", "subject", "title", "questions"]) if (!e[k]) throw new Error(`${f}: missing "${k}"`);
  if (!Number.isInteger(e.year)) throw new Error(`${f}: "year" must be a whole number like 8`);
  if (ids.has(e.id)) throw new Error(`${f}: duplicate exam id ${e.id}`);
  ids.add(e.id);
  const qids = new Set();
  for (const q of e.questions) {
    if (!q.id || !q.type || !q.marks || !q.q) throw new Error(`${f}: question ${q.id} needs id, type, marks and q`);
    if (qids.has(q.id)) throw new Error(`${f}: duplicate question ${q.id}`);
    qids.add(q.id);
    if (q.type === "mc" && !Array.isArray(q.options)) throw new Error(`${f}: question ${q.id} needs options`);
  }
  return e;
}).sort((a, b) => a.year - b.year || (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id));
writeFileSync(join(root, "src", "exams-data.js"), "// Generated from exams/*.json by scripts/bundle-exams.mjs. Do not edit.\nexport default " + JSON.stringify(exams) + ";\n");
console.log(`bundled ${exams.length} exams`);
