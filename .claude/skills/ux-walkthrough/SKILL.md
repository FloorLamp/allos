---
name: ux-walkthrough
description: Launch Allos against a scratch DB and drive the real UX journeys (fresh-install onboarding, email invite, all-pages census, common workflows) with a screenshot at every step. Use when asked to run the app, review UX end-to-end, or see what a flow actually looks like — not for assertions (those belong in e2e specs).
---

# UX walkthrough

Drive the real app and _look_ at it. The harness is `scripts/ux-walkthrough.mjs`
— a seeing tool, not a test tier. Journey assertions belong in `e2e/*.spec.ts`.

## 1. Launch the app on a scratch DB

NEVER point this at a real `data/allos.db`. Run from the repo root:

```bash
ALLOS_DB_PATH=/tmp/ux-walkthrough.db \
ADMIN_USERNAME=admin ADMIN_PASSWORD=first-boot-pw-1 \
EMAIL_TEST_CAPTURE=/tmp/ux-mail.jsonl \
PORT=3111 npm run dev
```

- `ALLOS_DB_PATH` at a fresh path = a true first-install (bootstrap admin from
  the env creds above, empty DB, onboarding wizard from scratch).
- `EMAIL_TEST_CAPTURE` (see `lib/email.ts`) appends every outbound email as a
  JSON line to that file instead of contacting SMTP — the invite journey reads
  the set-password link from it. SMTP host/port/from must still be _configured_
  (any fake values) plus the public URL; the harness does that itself on
  Settings → Server.
- **First-request patience:** after "Ready", the first hit still compiles
  middleware + page; on a slow filesystem that can take minutes. Poll until
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:3111/login` returns
  200 before driving.

## 2. Drive the journeys

Easiest: let the harness own the server lifecycle (`--serve` boots the dev
server on the scratch DB, polls readiness, and tears it down; `UX_SEED=1`
runs `scripts/seed.ts` first for a data-rich census):

```bash
node scripts/ux-walkthrough.mjs --serve onboarding invite pages workflows
```

Or run against an already-running server (section 1) without `--serve`.

Journeys: `onboarding`, `invite`, `pages` (all-routes census, both widths),
`workflows` (search + quick-logs), `live` (live workout mode), `dismiss`
(finding dismissal persistence), `dose` (dose confirm persistence),
`profiles` (acting-profile switch + read-only member), `upload` (medical
document, offline path). Every run writes an `index.html` contact sheet next
to the shots for fast human review.

- Run `onboarding` first on a fresh DB — it saves the admin session state the
  later journeys reuse.
- `pages` auto-enumerates every static `app/(app)` route from the filesystem and
  screenshots each at desktop (1280×900) and mobile (390×844) widths.
- Screenshots land in `data/ux-shots/` (gitignored) unless `UX_SHOTS` overrides.
- If Playwright can't find its browser build (version-pinned cache miss), set
  `UX_CHROMIUM` to a Chromium binary — in Claude Code's remote environment that
  is `/opt/pw-browsers/chromium`.
- Knobs: `UX_BASE` (default `http://localhost:3111`), `UX_ADMIN_USER`/
  `UX_ADMIN_PASS` (must match the dev-server env above).

## 3. Review

Read the screenshots in sequence — they are numbered in drive order. A blank
frame means a failed render, not a passed step. When a journey logs `FAILED` or
"check shots", look at that shot before concluding anything about the flow.

## Extending

Add a workflow by copying the shape in `workflowsJourney` (short, honest steps;
log loudly when a step can't complete — a blind spot must be visible). New
journeys register in the `journeys` map at the bottom of the script.
