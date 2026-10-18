# Exam Desk

A small website where Yassin and his brother sit their weekly Maths and Science exams.
Each boy logs in, answers on the page (answers autosave), and submits. Multiple choice,
number and algebra answers are marked straight away on the server; working and written
answers are marked by a parent on the review page. Answer keys never reach the browser.

Runs on Cloudflare Workers with a D1 database (both on the free plan).

## First-time setup (once)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, pick this
   repository, and keep the defaults (deploy command `npx wrangler deploy`). The database is
   created automatically on the first deploy.
2. Open the site's `*.workers.dev` link. The first visit asks you to create the parent account.
3. On **Accounts**, add a student account for each boy.

From then on every push to `main` redeploys the site.

Alternative without the Cloudflare GitHub app: add repository secrets `CLOUDFLARE_API_TOKEN`
(a token with Workers Scripts: Edit and D1: Edit) and `CLOUDFLARE_ACCOUNT_ID`; the workflow in
`.github/workflows/deploy.yml` then deploys on every push to `main`.

## Adding an exam

Add one file to `exams/`, for example `exams/maths-6.json`, and push. See `CLAUDE.md` for the
format. To take an exam off the boys' list without deleting it, use **Hide from boys** on the
Exams page while logged in as a parent.

## Marking

- **Results** lists every submission. Open one to see each answer, the mark scheme note and a
  marks box per question. Questions marked automatically are already filled in; change any
  of them if needed.
- **Review notes** take one line per mistake (`Q4 = 80. Dividing by a number less than 1 makes
  it bigger.`). The boys see these on their result page.
- **Let them take it again** deletes that submission.

### Marking from a script

Set a secret `ADMIN_API_TOKEN` on the Worker (Settings → Variables and Secrets). Requests with
`Authorization: Bearer <token>` then act as a parent:

- `GET /api/results?answers=1` all submissions with answers
- `GET /api/results/<id>` one submission plus the full exam, keys and mark scheme
- `PUT /api/results/<id>` with `{"manual": {"<qid>": marks}, "review": ["Q3 = ...", ...]}`

## Local development

```
npm install
npm test          # marking tests against every exam's answer key
npm run dev       # http://localhost:8787 with a local database
```
