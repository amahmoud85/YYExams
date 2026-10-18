# Exam Desk: notes for Claude

Cloudflare Worker (`src/worker.js`) + D1, static front end in `public/`. Exams are JSON files in
`exams/`; `scripts/bundle-exams.mjs` (run by wrangler's build step) validates them and writes
`src/exams-data.js`. Marking is `src/marking.js` (server side only). Schema is created by the
Worker on first request, so there are no migrations to run.

## Exam file format (`exams/<id>.json`)

```json
{
  "id": "maths-6", "subject": "Maths", "title": "Maths Exam 6", "short": "Exam 6",
  "topic": "Number · Non-calculator · Higher", "minutes": 45, "order": 7,
  "intro": "No calculator. Show your working...",
  "questions": [
    {"id": "1", "type": "mc", "marks": 1, "q": "HTML question", "options": ["A", "B"], "key": 0, "ms": "mark scheme note"}
  ]
}
```

- `subject` groups exams on the home page ("Maths", "Science"). `order` sorts them; newest last.
- `q` is HTML (`<sup>`, `<i>`, `<span class="frac"><span>top</span><span>bottom</span></span>`,
  `<svg class="graph">`, `<table class="data">`). `ms` is plain text shown only to parents.
- Question types and their `key`:
  - `mc`: `options` list, `key` = index of the right option.
  - `num`: `key` = number. Units and commas are ignored; fractions like 3/4 work.
  - `text`: `key` = list of accepted normalised strings (lowercase, no spaces, × → x, ² → ^2, − → -).
  - `factors`: `key` = {"2": 3, "5": 1} for 2³ × 5.
  - `expr`: `key` = {"expr": "3n+2", "noParen": true, "maxLen": 6}; checked by evaluation.
  - `work`: working box + final answer. `key` = {"num": 12} | {"text": [...]} | {"pairs": {"x": 2, "y": -1}};
    right final answer = full marks, otherwise the parent marks the working. Omit `key` for a
    conclusion-style question (set `"conclusion": true` to label the box "Conclusion").
  - `written`: extended writing, no key, always marked by a parent.
- `hint` (optional) shows under the answer box.

Run `npm test` after adding an exam: it checks every key marks itself as correct.
Exam style: Maths = Edexcel Higher, Science = AQA Higher with extended writing.
