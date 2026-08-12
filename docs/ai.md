# AI — insights, extraction, logging & privacy

Status: **shipped** · descriptive documentation of current behavior, extracted
from the README (#597)

The README gives the [operator-level overview](../README.md#optional-services);
this document is the full AI behavior and privacy reference.

## Logging & the AI activity log

The app logs to stdout/stderr via a small leveled logger (`LOG_LEVEL`,
`LOG_FORMAT`), so `docker logs` captures everything. Every AI call (extraction,
suggestions, insights) and its outcome is also appended to `data/logs/ai.jsonl`
— readable directly on the host and streamed live in
**Settings → Logs & audit → AI logs**, with **token usage** (input / output) per
call and a **today / 7-day rollup by feature × profile** so the admin whose API
key everyone spends can see where it goes (tokens only — no dollar math; the
model is recorded, so compute cost from your provider's prices). Failures
surface there (and inline where you triggered them), not just in the console.
Like the error log, each event's free text is masked through the shared
secret-redaction chokepoint before it's persisted, the file self-trims to a
byte budget so it stays bounded, and an admin-only **Clear** button on the tab
empties it. The **stdout echo goes through that same chokepoint**: `docker logs`
is a broader audience than the admin-only viewer, so a field named
`authorization`/`token`/`password`/`cookie` is masked in the console line too,
not just in the file.

Separately, **unexpected** server errors — an unhandled exception in a Server
Action, a route 500, a crashed fire-and-forget task — are captured server-side
to `data/logs/errors.jsonl` and surfaced newest-first under **Settings →
Errors** (admin only). Every `error` that funnels through the central logger is
persisted there with its logger scope, message, and a redacted, size-capped
detail (any stack), tagged with the acting profile when a request context is in
scope. Clients still get a generic error (the real cause never leaves this log);
the file self-trims by size/line count so a crash loop can't fill the disk, and
a Clear button empties it. All three JSONL logs share one append + self-trim
chokepoint (`lib/jsonl-log-file.ts`), because the `allos-notify` sidecar is a
separate OS process writing to the same `DATA_DIR`: the trim holds an advisory
lock across the whole append-then-trim sequence and swaps the rewritten file in
with an atomic rename, so a concurrent append is never overwritten and a reader
never sees a half-written file. This generalizes the "failures surface in the UI"
pattern (the notification-delivery marker, backup health) to everything.

The **third** sink is the notification tick's own decision record (issue #2209),
`data/logs/notify.jsonl`, surfaced under **Settings → Logs & audit → Notify
tick** (admin only). It is filtered by **scope** rather than by level — the
`notify` and `notifications` scopes, at `info` and above — because the class it
exists to keep is the **decline**: a send writes a row (`notify_messages` plus a
`notify_last_*` marker), while a decision _not_ to send wrote nothing anywhere
and lived only in a container stdout the deploy timer deletes tens of times a
day. Persisting every `info` from the whole web app is a deliberately different
and larger decision; `debug` is never persisted.

The tick stamps a **run id** (`beginNotifyRun()`) so the viewer groups by
**(run, profile)** — one row per profile per run, expandable to its lines —
rather than bucketing by timestamp, which splits any run that straddles a
minute. A **quiet** run still renders as a row saying it decided nothing: an
empty screen would make "nothing was due" indistinguishable from "the sidecar is
wedged", which is the ambiguity the log exists to remove. The read is paginated
over runs and bounded to the newest window of the file, following the Audit
page's pattern rather than the Errors page's whole-file read. Redaction, the
size/line self-trim, and the admin-only Clear button are identical to
`errors.jsonl`, and the sink is best-effort throughout: a logging failure never
throws into the tick.

For debugging integration syncs, each sync can capture the raw provider payload
(the Health Connect POST body, the Strava activity JSON, the Oura sleep/workout
JSON) under `data/integration-payloads/<profileId>/`. These are byte-capped,
retained newest-N per provider, and gitignored (part of `/data`). They're
**admin-only** and profile-scoped: expand **View raw** on a sync in **Data →
Review** to fetch one through an admin-gated route — members never see the
affordance or the data.

## Supplement suggestions — the AI route is the FALLBACK (#2378)

Biomarker → supplement has **two** routes, and they are different claims:

1. **Curated (deterministic, no model).** A committed, human-reviewable map
   (`lib/datasets/data/biomarker-supplement-map.json`, regenerate with
   `npm run gen:biomarker-supplement-map`) links a biomarker family reading LOW
   to the supplement that repletes it. The pure engine
   (`lib/supplement-suggest-curated.ts`) screens every suggestion against the
   profile's allergies, medications and conditions through the **same**
   deterministic belt the AI route's output goes through
   (`screenSuggestionSafety`), and the DB gather
   (`getCuratedSupplementSuggestions`) is the ONE computation every surface
   formats. **No model call, no network, no clock** — the same flagged labs
   yield the same suggestions on every run. It is the supplement twin of the
   biomarker→food engine (#577) and is held to the same standard, because the
   half of the question that recommends a substance a user swallows should not
   be the less deterministic half. The map is **deliberately small**; the
   curation standard, and the pairs deliberately left out, are documented at the
   top of `scripts/gen-biomarker-supplement-map.ts`. **No entry states a dose.**
2. **Generated (AI).** `lib/supplement-suggest.ts` answers everything the map
   does **not** cover — free-text feedback, the long tail of flagged labs, the
   goal/training context a curated table can't hold. Its prompt is told which
   families already have a curated answer so it doesn't restate them, and its
   drafts land in `intake_item_suggestions` for review.

The two are **visibly distinguished** wherever they render: curated cards carry
a **Curated** badge with their evidence line and public source; generated cards
carry a **Generated** badge with the model's rationale. That distinction is also
what makes the map's coverage measurable over time.

With no AI tier configured, the curated half still works exactly as before (it
never calls a model) and an uncovered family is simply **silent** rather than
broken.

## AI Insights

Insight generation works out of the box with a built-in offline summary. Set
`ANTHROPIC_API_KEY` (see the README's **Configuration** table) to enable
**Claude-powered** coaching analysis, then use **Trends → Insights → Generate
analysis**.

Beyond the single-day insight, the AI can generate a stored
**weekly or monthly recap** under **Trends → Insights**: a narrative of your
training, adherence, and body-metric trends grounded in the same recap facts
the dashboard **Weekly recap** card shows.

Like daily insights, recaps regenerate on demand. Without a key they fall back
to a deterministic offline summary. Their per-profile daily cap is
`AI_DAILY_NARRATIVE_LIMIT` (default 30).

**Recommendation runs.** Instead of hitting Generate by hand, you can put the
proactive AI features (supplement suggestions + a refreshed daily insight) on a
**cadence** per profile — **off**, **on document upload only** (the default),
**daily**, **weekly**, or **monthly** — under
**Settings → Coaching & AI → AI recommendations**. A scheduled run fires lazily
on a page view once the period has elapsed, and only when the underlying data
actually changed (an unchanged input signature skips the run, logged in
**Settings → Logs & audit → AI logs**). The admin sets a per-profile
**max runs per day** ceiling under **Settings → Server**. Runs happen only in
the web app, never the notification tick.

Uploaded medical documents (**Data → Import**) are extracted into structured
records by the same API — not just labs, vitals, and immunizations but the full
clinical narrative a scanned/photographed summary carries: **conditions,
allergies, procedures, visits, family history, and care-plan items & goals**,
the same domains the MyChart/FHIR importer produces (a discharge or after-visit
summary with no numeric analytes no longer imports as "0 records"). Without a
key the file is still stored but extraction is skipped. Each upload then appears
in the **Data → Review** feed — click through to verify what it produced,
reprocess it, or see the extraction error. The detail view browses everything
the import produced in one tabbed strip — one tab per type (labs, vitals,
prescriptions, visits, conditions, allergies, immunizations, procedures, family
history, care plan/goals, medications, body metrics), each row linking to where
it now lives. A lab reading also captures what the report PRINTS about the draw
itself (#1404): its **result status** (a "CORRECTED REPORT" / "Preliminary"
banner), whether it was drawn **fasting**, and the **specimen**. The model is told
never to infer any of the three — an unstated attribute stays null rather than
becoming a "final", non-fasting claim the document never made. The same
never-infer discipline governs the clinical attributes added in #1403/#1407: a
condition's **laterality**, **severity** and **stage**, and a relative's **age /
cause of death** and **genetic relationship** (half / adopted / step) and
maternal-vs-paternal line are extracted only when the document states them — a
side is never read off a diagnosis name, and an ordinary relative is left
unqualified rather than labeled.

The same discipline governs the reading's **identity**, where getting it wrong is
not cosmetic (#2338). A canonical name may carry qualifiers the document encodes
**structurally** — the specimen, the panel/section a row sits under, laterality,
method — because inferring those RECOVERS what the layout says: a bare `GLUCOSE`
row inside a urinalysis section really is `Glucose, Urine`. It may not carry a
**patient-state** condition the document does not print — fasting/non-fasting,
post-prandial, pre-/post-dose, supine/standing, at-rest/post-exercise — because
those describe how the patient was _prepared_, and a report either states one or
it does not. The qualifier selects the reference band (normal glucose tops out at
99 fasting and around 140 otherwise), so an inferred one decides whether a
reading is flagged, and it forks the analyte's series across two canonical names
by document. Dropping back is safe as well as honest: since #2337 the unqualified
`Glucose` entry carries **no** band at all, so a row whose fasting state the
document never printed is shown and not judged, rather than judged against the
fasting frame it never claimed. The rule is in the system prompt and the `canonical_name` schema
field, and enforced in code by `stateAwareCanonical`
(`lib/patient-state-qualifiers.ts`), which `normalizeResults` applies after the
unit arbitration: a state qualifier the row's printed name and panel heading do
not carry is dropped back to the unqualified entry. Evidence is verbatim printed
text only — deliberately not the row's own `fasting` answer, which is the same
model judgment that over-qualified the name. Nothing is lost either way:
`medical_records.name` keeps the printed name and the `fasting` column keeps what
the report said about the draw. A document that genuinely prints the condition
("FBG (Glucose Fasting)") still lands on `Glucose, Fasting`.

The reading's **category** is held to the same standard, and there is **no
catch-all** (#2479 part 2). The prompt used to end its category list with
`"biomarker" only if nothing else fits` — a licence to make no decision, filing a
row in the pre-#1076 bucket that the flat Results catalog excludes and the retest
clock reaches only by falling through. That clause is gone; the prompt now names
`reference` for an immutable identity fact and states explicitly that when a
measurement fits none of the narrower classes it is `lab` if it came from a
specimen and `vitals` if it was measured on the body. The tool enum and the
normalizer's accept-list are both `ASSIGNABLE_MEDICAL_CATEGORIES`
(`lib/medical-categories.ts`) — the full enum minus the retired values — so the
model cannot emit the retired one at all, and a stray string falls through the
existing unknown-category default (`lab`). The model's answer is in any case only
a fallback: since #1076 a resolved canonical name's registry category **wins** over
it, which is the rule migration 185 applies retroactively to the rows that predate
it. See `docs/internals/clinical-result-terminology.md`.

Every extracted row also carries the extractor's own **confidence** — a coarse
`high` / `medium` / `low` plus a short reason for a non-high row (a smudged
figure, an ambiguous unit, a date read from context, a hedged diagnosis). It is
summarized per document and stored on the document's import report (no per-row
column), then used to **order human review**: the import detail page opens a
"Check these first" card listing the hedged rows lowest-confidence first, and
the **Data → Review** feed badges the document "· N to check". Nothing is gated
on it — no row is auto-accepted, auto-rejected, hidden, or re-weighted because
the extractor hedged, consistent with the review-everything posture. A document
with no signal at all (a deterministic MyChart/FHIR import, a keyless/offline
extraction, or anything imported before the field existed) simply shows neither
card nor badge — an absent answer is "unknown", never a synthetic "low". One
pure module (`lib/extraction-confidence.ts`) owns the vocabulary, the ranking,
and the "deserves a look" rule, so the card, the badge, and the stored total
cannot disagree.

Each flagged row in that card is a **link to the row it names** (#2339), and the
row it lands on wears the same confidence badge and reason. The flag stores no
row id — an id is stale the moment a row is edited or the document reprocessed —
so the link carries the LABEL and `lib/confidence-triage.ts` resolves it against
the rows that exist right then, kind-scoped and exact after normalization (a
medication compares on `medNameKey`, the identity its own domain already keys
on). It refuses to guess: one match links at the row and highlights it, several
matches filter the owning tab and select none, and no match is stated as "no
longer in this import". `getDocumentTriageRows` builds the candidates out of the
same profile-scoped, document-traced reads the tabs render from, so a link can
only ever land on a row that tab shows.

### Provider tiers (Heavy / Light) and local inference

AI config lives in the database under **Settings → Server → AI providers**
(admin-only), as **two independent tiers**:

- **Heavy** — document/workout extraction (vision + long context; it sees your
  uploaded records).
- **Light** — narratives, supplement suggestions, coverage blurbs, free-text
  symptom mapping, and the finding explainer. When Light is unset it **falls
  back to Heavy**; the resolver maps each task class → tier → client.

Each tier carries an **API shape** — `anthropic` (the Anthropic SDK) or
`openai-compatible` (the chat-completions shape for vLLM / Ollama / LM Studio /
OpenRouter / …) — a base URL, a **write-only API key** (stored like the Telegram
bot token; the UI shows only whether one is set), and a model. A per-tier **Test
connection** button pings the endpoint through the resolver; the Heavy test also
probes whether the endpoint **accepts an image**, warning when a blind model
would misroute extraction. A tier counts as configured when it has **either** a
key or a base URL. Each AI activity-log entry is tagged with the serving
**tier** + model + backend host.

For a fully private setup, point a tier's base URL at a **local inference
server** (e.g. `http://localhost:11434`) — then **no request leaves your machine
beyond that endpoint**. You can pin Heavy (which sees documents) to the local
endpoint specifically while leaving Light on a hosted model, or run everything
local.

**Env → first-boot seed.** The legacy `ANTHROPIC_API_KEY` / `AI_BASE_URL` /
`HEALTH_AI_MODEL` env vars are **demoted to a first-boot seed** for the Heavy
tier (the `seedTimezoneFromEnv` pattern): on a fresh instance they populate
Heavy once, then the DB owns the config. Existing deployments are unaffected —
no restart or shell access is needed to change a key or model afterward.

Quality trade-off: coaching **insights** and supplement **suggestions** work
well on capable local models, but **medical-document extraction** is demanding
(long documents, structured tool output) — a small local model may extract less
reliably than Claude, which is exactly why extraction gets its own Heavy tier.
Everything still degrades gracefully: with no tier configured, insights fall
back to the offline summary, uploads are stored but not extracted, and the
AI-only affordances (symptom intake, the explainer) don't render.

### Privacy — the RxNorm lookup is the only interaction-checker egress

Drug-interaction checking runs entirely **on-box** against the bundled
`lib/datasets/data/drug-interactions.json` dataset — no interaction API is
called at request time, and detection works with **no network at all**. The
single, optional exception is the **name → RxNorm** normalization: when you
press **Find RxNorm code** on an item's edit form, the app sends **just that
drug/supplement name** (no profile id, no other PHI) to NLM's public **RxNav
`approximateTerm`** service to fetch candidate codes for you to confirm, and
when you confirm one it sends **just that code** back to RxNav
(`/rxcui/{id}/related`) to resolve the product's active-ingredient codes (how
combination medications get matched). Those are the **only** things the feature
ever sends off the box. The lookup has a short timeout and **degrades silently**
— if it's unreachable (or you never use it), the item simply has no RxCUI and
interactions still match by name. Nothing about interaction detection, the the
Supplements/Medications warnings, or the Upcoming finding contacts the network.
