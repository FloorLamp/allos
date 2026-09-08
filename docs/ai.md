# AI configuration, extraction, and privacy

Status: shipped.

AI is optional. This guide describes provider selection, feature behavior, and
stored diagnostics. See the [README](../README.md#optional-services) for setup
and the [development guide](development.md) for code ownership and checks.

## Providers and data flow

Admins configure providers under **Settings → Server → AI → AI providers**.
Each tier has an API shape (`anthropic` or `openai-compatible`), base URL,
write-only API key, and model. A key or custom base URL makes a tier configured.
The key field shows whether a key is set; submitting it blank preserves the key.
Use the separate removal control to clear it.

| Tier  | Tasks                                                                                                | Fallback                          |
| ----- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| Heavy | Medical-document and workout extraction.                                                             | No fallback to Light.             |
| Light | Insights, recaps, suggestions, coverage text, symptom mapping, finding explanations, and record Q&A. | Heavy when Light is unconfigured. |

[ai-tiers.ts](../lib/ai-tiers.ts) owns the mapping and defaults;
[ai-resolve.ts](../lib/ai-resolve.ts) resolves clients. Each tier's **Test
connection** button tests that tier directly. Heavy also gets an image-acceptance
probe, because extraction needs a model that accepts images.

`ANTHROPIC_API_KEY`, `AI_BASE_URL`, and `HEALTH_AI_MODEL` seed Heavy on first
boot and remain per-field fallbacks until a database value exists. Stored values,
including an explicitly cleared key, take precedence. Light has no environment
fallback of its own. [settings/ai-tiers.ts](../lib/settings/ai-tiers.ts) owns
persistence and these precedence rules.

AI requests go to the resolved provider. Heavy receives uploaded records; Light
also receives profile context for its tasks. Configure both tiers, including the
Light-to-Heavy fallback, when choosing where that data is processed. A local
inference endpoint can serve either tier; the endpoint's own configuration
controls any onward processing.

## Features and limits

Daily insights and weekly/monthly recaps are generated on demand under
**Trends → Insights**. They use profile facts and have deterministic offline
summaries when AI is unavailable. Uploads remain stored without a configured
extraction tier, but AI extraction is skipped. Features that require a model,
such as free-text symptom mapping and finding explanations, are hidden when their
task cannot resolve a provider.

Recommendation runs combine supplement suggestions with a refreshed daily
insight. Per-profile cadence lives under **Settings → Coaching & AI**: off,
on document upload only (the default), daily, weekly, or monthly. Scheduled runs
are evaluated lazily on page views in the web app. Unchanged inputs skip the run
and produce a diagnostic event; the notification tick does not run recommendations.
Admins set the per-profile daily run ceiling in AI settings.
[recommendation-engine.ts](../lib/recommendation-engine.ts) owns orchestration;
[recommendation-run.ts](../lib/recommendation-run.ts) owns the cadence decision.

Per-profile daily AI limits are separate from that run ceiling:

| Environment variable        | Default | Counts                                         |
| --------------------------- | ------- | ---------------------------------------------- |
| `AI_DAILY_EXTRACTION_LIMIT` | 50      | Document extractions.                          |
| `AI_DAILY_INSIGHT_LIMIT`    | 100     | Insights and generated supplement suggestions. |
| `AI_DAILY_NARRATIVE_LIMIT`  | 30      | Recaps and lab-trend narratives.               |

[ai-usage-limits.ts](../lib/ai-usage-limits.ts) owns these defaults. A valid zero
disables that operation; a recommendation run's inner calls still consume their
feature limits.

### Supplement suggestions

Curated suggestions use a committed map and deterministic engine, without a
model or network call. Generated suggestions cover readings and feedback the
curated route does not answer. Both use `screenSuggestionSafety` against the
profile's allergies, medications, and conditions.

[Supplement suggestion ownership](../lib/supplement-suggest-curated.ts) includes
which readings the map answers: both the biomarker name and its flag side matter.
The [generated route](../lib/supplement-suggest.ts) receives those answered
readings to avoid duplicates and stores drafts in `intake_item_suggestions` for
review. Cards distinguish **Curated** evidence and sources from **Generated**
model rationales. Curated suggestions still work without AI; uncovered readings
do not gain generated suggestions in that state. The map does not prescribe doses.

## Extraction and human review

Medical-document extraction covers results, prescriptions, immunizations, and
clinical narrative such as conditions, allergies, procedures, visits, family
history, and care plans. **Data → Review** shows each import's results, errors,
and reprocessing controls. Its detail tabs link to the records created by that
import.

The [extraction prompt](../lib/medical-extract/prompt.ts) requests only stated
attributes: result status, fasting state, specimen, condition laterality/severity/
stage, and family-history details remain unknown when the document is silent.

Canonical identity may recover structural evidence from the document layout,
such as a specimen or panel heading. It must not invent patient preparation,
such as fasting or morning collection. After unit resolution,
`stateAwareCanonical` checks the printed name and panel heading and removes
unsupported patient-state qualifiers. The model's own fasting answer is not
independent evidence. The printed name and separately extracted attributes are
retained. See [patient-state-qualifiers.ts](../lib/patient-state-qualifiers.ts)
and [normalize.ts](../lib/medical-extract/normalize.ts).

The normalizer accepts current medical categories, defaults an unknown model
category to `lab`, and lets a resolved canonical registry category override the
model's guess. The [clinical-results guide](internals/clinical-result-terminology.md)
owns category, identity, and catalog semantics, including the separate review
state for unresolved legacy rows.

Extraction confidence (`high`, `medium`, or `low`, with a reason when needed)
orders human review. It does not accept, reject, hide, or reweight records.
[extraction-confidence.ts](../lib/extraction-confidence.ts) owns the vocabulary
and import-report summary. Missing confidence is unknown; deterministic imports
and older reports need not have it.

**Check these first** links are resolved against the current import's
profile-scoped rows by [confidence-triage.ts](../lib/confidence-triage.ts).
One exact normalized match links and highlights; multiple matches filter the
owning tab; no match is reported as missing. Reprocessing therefore does not leave
the confidence report dependent on old row IDs.

## Logs and raw payloads

The central logger writes to stdout/stderr using `LOG_LEVEL` and `LOG_FORMAT`.
**Settings → Logs & audit** provides admin-only viewers and Clear controls:

| File under `data/logs/` | Contents                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.jsonl`              | AI events, outcomes, provider/model tags, login/profile context when available, and input/output token usage. The viewer includes today and seven-day usage rollups by feature and profile. |
| `errors.jsonl`          | Unexpected server errors with scope, redacted message/detail, and request context when available.                                                                                           |
| `notify.jsonl`          | Notification decisions, including declines and quiet runs, grouped by run ID and profile. Reads are paginated over a bounded file window.                                                   |

AI events also echo through the central logger. Secret-looking values are masked
before persistence and console output. Diagnostic details can still contain
health information: prompt/response logging is enabled by default at supporting
call sites; `AI_LOG_PROMPTS=0` omits those optional details. It does not disable
logging or anonymize all event text. Token rollups report usage, not monetary cost.

[jsonl-log-file.ts](../lib/jsonl-log-file.ts) owns shared append, clear, and
bounded trimming. Advisory locking and atomic replacement coordinate the web app
and notification sidecar; logging remains best-effort. Notification scope/level
selection belongs to [notify-log.ts](../lib/notify-log.ts), rather than persisting
every application info or debug message.

Integration debugging can retain raw provider payloads under
`data/integration-payloads/<profileId>/`, byte-capped and limited to the newest
payloads per source. **View raw** in Data → Review uses an admin-only,
profile-scoped route. [raw-log.ts](../lib/integrations/raw-log.ts) owns storage.

## Interaction-checker network boundary

Interaction detection uses the bundled dataset locally. The optional **Find
RxNorm code** lookup sends the entered drug/supplement name to NLM RxNav; resolving
an accepted product's active ingredients sends its RxCUI. These requests do not
include the profile ID or other profile context. [rxnorm.ts](../lib/rxnorm.ts)
owns the requests and timeouts. If lookup is unavailable, name-based interaction
matching remains available.
