# AI — insights, extraction, logging & privacy

Status: **shipped** · descriptive documentation of current behavior, extracted from the README (#597)

The README's [AI](../README.md#ai) section is the short version.

## Logging & the AI activity log

The app logs to stdout/stderr via a small leveled logger (`LOG_LEVEL`,
`LOG_FORMAT`), so `docker logs` captures everything. Every AI call (extraction,
suggestions, insights) and its outcome is also appended to
`data/logs/ai.jsonl` — readable directly on the host and streamed live in
**Settings → AI logs**, now with **token usage** (input / output) per call and a
**today / 7-day rollup by feature × profile** so the admin whose API key everyone
spends can see where it goes (tokens only — no dollar math; the model is recorded,
so compute cost from your provider's prices). Failures surface there (and inline
where you triggered them), not just in the console.

For debugging integration syncs, each sync can capture the raw provider payload
(the Health Connect POST body, the Strava activity JSON, the Oura sleep/workout JSON) under
`data/integration-payloads/<profileId>/`. These are byte-capped, retained
newest-N per provider, and gitignored (part of `/data`). They're **admin-only**
and profile-scoped: expand **View raw** on a sync in **Data → Review** to fetch
one through an admin-gated route — members never see the affordance or the data.

## AI Insights

Insight generation works out of the box with a built-in offline summary. Set
`ANTHROPIC_API_KEY` (see the README's **Configuration** table) to enable **Claude-powered**
coaching analysis, then use **Trends → Insights → Generate analysis**.

Beyond the single-day insight, two AI **narratives** read across your history:

- **Weekly / monthly recap** (**Trends → Insights**) — a narrative of your
  training, adherence, and body-metric trends over the last week or month,
  grounded in the same recap facts the dashboard **Weekly recap** card shows.
- **Lab-trend interpretation** (**Trends → Biomarkers**) — an optional read of
  your recent biomarker movements _in context_ (medication start/stop dates and
  conditions), so a change reads as "LDL up since the statin was stopped" rather
  than a bare number. Observations, not diagnoses — it points you at what to
  raise with a clinician.

Both are stored (like daily insights) and regenerate on demand. Without a key
they fall back to a deterministic offline summary. Their per-profile daily cap is
`AI_DAILY_NARRATIVE_LIMIT` (default 30).

**Recommendation runs.** Instead of hitting Generate by hand, you can put the
proactive AI features (supplement suggestions + a refreshed daily insight) on a
**cadence** per profile — **off**, **on document upload only** (the default),
**daily**, **weekly**, or **monthly** — under **Settings → Profile → AI
recommendations** (admin-editable; the admin owns the API key). A scheduled run
fires lazily on a page view once the period has elapsed, and only when the
underlying data actually changed (an unchanged input signature skips the run,
logged in **Settings → AI logs**). The admin sets a per-profile **max runs per
day** ceiling on **Settings → Server**. Runs happen only in the web app, never the
notification tick.

Uploaded medical documents (**Data → Import**) are extracted into
structured records by the same API — not just labs, vitals, and immunizations but
the full clinical narrative a scanned/photographed summary carries: **conditions,
allergies, procedures, visits, family history, and care-plan items & goals**, the
same domains the MyChart/FHIR importer produces (a discharge or after-visit summary
with no numeric analytes no longer imports as "0 records"). Without a key the file
is still stored but extraction is skipped. Each upload then appears in the **Data →
Review** feed —
click through to verify what it produced, reprocess it, or see the extraction
error. The detail view browses everything the import produced in one tabbed
strip — one tab per type (labs, vitals, prescriptions, visits, conditions,
allergies, immunizations, procedures, family history, care plan/goals,
medications, body metrics), each row linking to where it now lives.

### Local / self-hosted inference (zero external egress)

For a fully private setup, point the app at a **local inference server** that
exposes an Anthropic-compatible API (Ollama and others, or a translating proxy)
by setting `AI_BASE_URL` (e.g. `http://localhost:11434`). Then **no request ever
leaves your machine beyond that endpoint** — the SDK talks only to the configured
base URL. Local servers usually ignore the API key, so `ANTHROPIC_API_KEY` is
optional when `AI_BASE_URL` is set (a placeholder is sent to satisfy the SDK);
AI counts as configured when **either** is present.

The endpoint and model are **environment-driven only** — the active endpoint,
model, and configured/offline status are shown read-only under **Settings →
Server → AI** (not editable in the UI, so no endpoint or credential is stored in
the database). Each entry in the AI activity log is tagged with the backend host
so you can tell which endpoint produced it.

Quality trade-off: coaching **insights** and supplement **suggestions** work
well on capable local models, but **medical-document extraction** is demanding
(long documents, structured tool output) — a small local model may extract less
reliably than Claude. Everything still degrades gracefully: with neither
`ANTHROPIC_API_KEY` nor `AI_BASE_URL` set, insights fall back to the offline
summary and uploads are stored but not extracted.

### Privacy — the RxNorm lookup is the only interaction-checker egress

Drug-interaction checking runs entirely **on-box** against the bundled
`lib/drug-interactions.json` dataset — no interaction API is called at request
time, and detection works with **no network at all**. The single, optional
exception is the **name → RxNorm** normalization: when you press **Find RxNorm
code** on an item's edit form, the app sends **just that drug/supplement name**
(no profile id, no other PHI) to NLM's public **RxNav `approximateTerm`** service
to fetch candidate codes for you to confirm, and when you confirm one it sends
**just that code** back to RxNav (`/rxcui/{id}/related`) to resolve the product's
active-ingredient codes (how combination medications get matched). Those are the
**only** things the feature ever sends off the box. The lookup has a short timeout and **degrades silently** —
if it's unreachable (or you never use it), the item simply has no RxCUI and
interactions still match by name. Nothing about interaction detection, the
`/medicine` warnings, or the Upcoming finding contacts the network.
