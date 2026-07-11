# Session handoff — architecture & audit arc (July 2026)

Working notes from an extended audit/planning session, written to seed the next
one. Everything actionable is filed as GitHub issues; this file carries the
_context_ that isn't in any single issue: the roadmap ordering, the process
facts that bite, the bug-class catalog, and the map of what has and hasn't been
audited. Delete this file when it stops being true.

## Recommended sequence for the open backlog

The logic: fix what's lying to users → make that lying class impossible →
split the files features will churn → run the two feature arcs down their
dependency chains → epics.

**Phase 0 — broken or blocking**

1. #323 — import-job commit throws on every Save (`'committing'` violates the
   status CHECK; proven with a SQL repro). Enum rebuild migration + action-tier
   test + `committing` reaper.
2. #13 / #125 — framework upgrade block. Do it early and alone: every later
   phase adds merge surface against it.

**Phase 1 — user-visible wrong answers (independent, small)**

- Trivial: #333 (`/trends` revalidation), #301 (low-supply widget →
  `getRefillRates`), #302 (current-weight source priority), #310 (export
  `profileAgeMonths`), #312 (shared snooze clamp)
- Small decision needed: #303 (one next-appointment policy), #297 (dose sort
  comparator), #325 (refill marker clear on pause/untrack), #327 (orphan
  retest-dismissal wiring), #324 (atomic claim on duplicate upload), #332
  (`saveActivity` typed outcome — protects user data)
- Paired: #304 + #326 (failing-provider window + Strava dead-token state; each
  references the other)

**Phase 2 — consolidation that prevents recurrence**

- #328's enforcement-parity test FIRST (CHECK lists vs TS unions — guards every
  enum change after it), then the rest of #328, #305 (medical enums), #306
  (biomarker flag helpers), #311 (axis domain), #307 (goalPct), #313 / #314
  (policy extraction from pages/components)

**Phase 3 — file splits (each when its area is quiet)**

- #316 (queries/upcoming — highest-churn live file) → #317 (settings.ts) →
  #318 (medical actions; land BEFORE SMART-on-FHIR work touches that file) →
  #319 (Tier-2: types.ts, settings actions by auth tier, intake queries,
  finish ActivityForm extraction)

**Phase 4 — training arc (strict chain)**

- #338 (warmup flag) → #331 (seed-builder unification) → #330 (session-level
  progression) → #335 (suggestion auto-consumption) → #336 / #337 (ergonomics
  bundles) → #334 (journal umbrella) → #340 (live workout mode; wants
  #335/#336)

**Phase 5 — equipment arc (interleaves with Phase 4)**

- #341 (lifecycle/enum) → #342 (activities-level link) → #339 / #343 / #344
  (cardio picker, /equipment routes, protocols) → #345 (equipment-aware recs)

**Phase 6 — product epics (specs exist; pick by appetite)**

- #288 (appointments+visits merge), #275 (provider page) — independent UI
  consolidations; #285 (typed links) ideally lands before them so new pages are
  born typed
- Integrations: #143 (SMART on FHIR — spec merged) · #141 → #174 (Apple Health
  exporter, then Capacitor shell) · #235 → #248 → #257 (Home Assistant chain —
  spec merged) · #45 (new rule domains)

## Process facts (will bite if forgotten)

- The repo merges in **hours**. Always
  `git fetch origin main && git checkout -B <branch> origin/main` before
  pushing; expect PR branches to be deleted on merge; check whether a filed
  issue was already fixed upstream before referencing it.
- Prettier must be the lockfile version: `npx -y prettier@3.9.1`. A bare
  `npx prettier` once resolved 3.8.1 and mangled markdown emphasis/underscores.
- Issues and PRs share one number sequence. **Never guess a sibling's number
  when filing a batch** — file first, then update cross-references.
- Upstream squash commits (committer `noreply@github.com`) flagged
  "unverified" by hooks are main's history — sync, never rewrite.
- When the GitHub MCP rate-limits, unauthenticated `curl api.github.com`
  works for reads (public repo).

## Bug-class catalog (what to look for in new code)

1. **Two computations of one question** — the dominant class (15+ instances
   found). A value on two surfaces must be one pure `lib/` function.
2. **Pattern-matched reuse with the wrong semantics** — reusing a computation
   whose _question_ differs (a "since last digest" window on a "what needs
   attention now" surface). Before reusing, ask what question it answers.
3. **A "parity" comment is a bug smell.** Three comments claiming parity with
   another code path were false (low-supply widget, current-weight stat,
   refill-marker contract). Comments asserting cross-file invariants rot
   fastest — verify, don't trust.
4. **States writable in TS but forbidden by the DB CHECK** (#323). TS unions,
   canonical arrays, and CHECK constraints are three copies of one enum —
   compare them mechanically (the #328 parity test).
5. **Transitions whose side-state lives in another file** — a marker not
   cleared on pause, dismissals not cleaned on reprocess, a claim guard used
   by one caller and skipped by its twin.
6. **Client state vs profile identity** — refs/`useRef` seeds surviving a
   profile switch; adapters silently dropping fields (`time_of_day`).
7. **Single-datapoint decisions on session-level questions** — progression
   judged from the best set (#330); prefer judging the whole session
   (`judgeTargets` existed all along).

## Audit map

**Sweeps completed** (findings all filed): duplication (#301–#307 + notes on
#283/#307), one-off policy centralization (#310–#314), file hotspots
(#316–#319), state machines (#323–#328), journal/activity conventions
(#330–#334), activity-form UX (#335–#340), equipment (#341–#345).

**Verified strong — do not re-audit:** the dose machine (`DoseTakenOutcome`
discipline, supply idempotency), the findings-suppression bus (key-hygiene
partition is exactly right), extraction's dual reapers (boot + lease), the
activity merge/undo machinery (the row-ops reference implementation), goal
liveness predicates (consistent across four surfaces), the preventive lattice
(one assessor for page + nudge).

**Where policy hides:** `app/(app)/page.tsx` and `app/(app)/medicine/page.tsx`
are the accretion points — check there first when a widget disagrees with
another surface.

**Hotspots by size × churn:** `lib/queries/upcoming.ts` (highest churn),
`lib/settings.ts` (largest, 110 exports), `app/(app)/medical/actions.ts`
(giant function bodies). Splits filed as #316–#318. `lib/db.ts` is the
precedent that splitting works: most-churned file overall, now 158 lines.

**Not yet audited (candidate next sweeps):** the medical/passport UI layer
(only its pipeline was audited), notification content quality (copy, timing
heuristics), e2e coverage gaps vs the "every UI feature ships a browser test"
rule, query performance (all-history scans behind `getStrengthByExercise` and
friends), and a dedicated security pass (auth boundaries were only
spot-checked).
