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

Separately, **unexpected** server errors — an unhandled exception in a Server
Action, a route 500, a crashed fire-and-forget task — are captured server-side to
`data/logs/errors.jsonl` and surfaced newest-first under **Settings → Errors**
(admin only). Every `error` that funnels through the central logger is persisted
there with its logger scope, message, and a redacted, size-capped detail (any
stack), tagged with the acting profile when a request context is in scope. Clients
still get a generic error (the real cause never leaves this log); the file
self-trims by size/line count so a crash loop can't fill the disk, and a Clear
button empties it. This generalizes the "failures surface in the UI" pattern (the
notification-delivery marker, backup health) to everything.

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

### Provider tiers (Heavy / Light) and local inference

AI config lives in the database under **Settings → Server → AI providers**
(admin-only), as **two independent tiers**:

- **Heavy** — document/workout extraction (vision + long context; it sees your
  uploaded records).
- **Light** — narratives, supplement suggestions, coverage blurbs, free-text
  symptom mapping, and the finding explainer. When Light is unset it **falls back
  to Heavy**; the resolver maps each task class → tier → client.

Each tier carries an **API shape** — `anthropic` (the Anthropic SDK) or
`openai-compatible` (the chat-completions shape for vLLM / Ollama / LM Studio /
OpenRouter / …) — a base URL, a **write-only API key** (stored like the Telegram
bot token; the UI shows only whether one is set), and a model. A per-tier **Test
connection** button pings the endpoint through the resolver; the Heavy test also
probes whether the endpoint **accepts an image**, warning when a blind model would
misroute extraction. A tier counts as configured when it has **either** a key or a
base URL. Each AI activity-log entry is tagged with the serving **tier** + model +
backend host.

For a fully private setup, point a tier's base URL at a **local inference server**
(e.g. `http://localhost:11434`) — then **no request leaves your machine beyond
that endpoint**. You can pin Heavy (which sees documents) to the local endpoint
specifically while leaving Light on a hosted model, or run everything local.

**Env → first-boot seed.** The legacy `ANTHROPIC_API_KEY` / `AI_BASE_URL` /
`HEALTH_AI_MODEL` env vars are **demoted to a first-boot seed** for the Heavy tier
(the `seedTimezoneFromEnv` pattern): on a fresh instance they populate Heavy once,
then the DB owns the config. Existing deployments are unaffected — no restart or
shell access is needed to change a key or model afterward.

Quality trade-off: coaching **insights** and supplement **suggestions** work well
on capable local models, but **medical-document extraction** is demanding (long
documents, structured tool output) — a small local model may extract less reliably
than Claude, which is exactly why extraction gets its own Heavy tier. Everything
still degrades gracefully: with no tier configured, insights fall back to the
offline summary, uploads are stored but not extracted, and the AI-only affordances
(symptom intake, the explainer) don't render.

### Privacy — the RxNorm lookup is the only interaction-checker egress

Drug-interaction checking runs entirely **on-box** against the bundled
`lib/datasets/data/drug-interactions.json` dataset — no interaction API is called at request
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
the Supplements/Medications warnings, or the Upcoming finding contacts the network.
