# Copy standard — the house voice for user-facing text

Status: **shipped** (the standard is documented, the measured drift patterns are swept, and the copy-lint source-scan test enforces the mechanical rules in CI — issue #945)

The source of truth for tone, punctuation, and phrasing of every **user-facing**
string in the app — page subtitles, buttons, labels, empty states, toasts, error
messages, and notification copy (Telegram / Web Push / Home Assistant). It is the
verbal twin of the #794 visual-consistency sweep and the "one moment, one register"
sibling of #221's "one question, one computation".

This is a single-language app; there is no string catalog or i18n layer — **this
document is the source of truth**, and the mechanical rules below are enforced by
`lib/__tests__/copy-lint.test.ts` (the profile-scoping / telegram-chokepoint /
notes-text source-scan pattern). The lint is deliberately narrow: it catches the
_measured_ drift patterns, not tone in general — **review still owns tone.**

Scope: `app/**` (except `app/api/**`), `components/**`, and `lib/notifications/**`.
`app/api/**` returned bodies follow the #478 generic-error rule (`"internal error"`),
not this standard. Model-facing prompt text in `lib/ai*.ts` is out of scope (it's not
user-facing).

## The eight rules

### 1. Errors: `"Couldn't <verb> <object>."`

Always the contraction — **never** "Could not", "Failed to", or "Unable to" in a
user-facing string. Name the object: `"Couldn't save the provider."`, not
`"Couldn't save."` where the object is knowable.

Append **`"Try again."` only where retrying can plausibly succeed** — a network,
busy, or otherwise transient failure (a save that hit a locked DB, a sync that lost
its connection). **Never** append it to a validation error (`"Enter a name."`) or a
not-found error (`"Couldn't find that dose."`) — retrying an invalid form or a
deleted row changes nothing.

No `"please"` anywhere. The generic `"internal error"` stays the API-layer rule
(#478); this standard governs the human surfaces, where the specific cause is
either safe to name (`"Couldn't reach the RxNorm lookup. You can still save."`) or
logged server-side while the user sees the generic-but-shaped `"Couldn't merge
those providers."`.

```
Couldn't save this appointment. Try again.      // transient — retry advice
Couldn't find that dose.                         // not-found — no retry advice
Enter a valid date (YYYY-MM-DD).                 // validation — imperative, no retry
```

### 2. Voice: "you/your" = the active profile

"you" and "your" always address the **active profile** — the person the header
switcher currently points at. This is a rule, not an accident: on a per-profile
surface (Biomarkers, Trends, the dashboard) `"Explore your results…"` is correct
because "your" resolves to whoever is active.

**Cross-profile surfaces never say "your".** The household strip, Family settings,
and other-profile chips show data for people who are _not_ the active profile, so
they use the profile's name or neutral phrasing:
`"Everyone at a glance — confirm what's due…"`, not "your household". An admin
viewing a child's profile must never read "your" and see the child's data.

### 3. Punctuation: sentences get periods, fragments don't

A **complete sentence** ends with terminal punctuation — subtitles, empty states,
toasts, and error strings all included. A **fragment used as a label** (a chip, a
table cell, a delta indicator, an `aria-label`) takes no period.

One rule resolves the `"No change"` / `"No changes."` split that looked like a bug:
`"No change"` is a delta **label** (fragment, no period); `"No changes."` is a save
**outcome** (sentence, period). Both are correct — and knowably so. The copy-lint
test enforces the terminal period on the `"Couldn't …"` error family.

### 4. Empty states: `"No <things> <verb> yet."` + one next step

State what's absent, then give **one actionable next step matching an affordance
actually on screen**. The de-facto-good pattern is the standard:
`"No equipment defined yet. Add a trap bar, a bike, a pair of shoes, or a sauna."`

Verb standard, by what the data _is_:

| Data kind                                        | Verb         | Example                                 |
| ------------------------------------------------ | ------------ | --------------------------------------- |
| User entries (activities, weigh-ins, doses)      | **logged**   | `"No weigh-ins yet. …log your weight…"` |
| Medical data (labs, conditions, procedures)      | **recorded** | `"No procedures recorded yet."`         |
| Sync/import surfaces (Health Connect, CCD, FHIR) | **imported** | `"No activities imported yet."`         |

Range-scoped empties say what to change:
`"No sessions in this range. Widen the range or log one."`

### 5. Case: sentence case, proper nouns Title Case

Sentence case for buttons, labels, headings, and toasts. **Feature and nav names
are Title Case as proper nouns** — "Supplements & Meds", the "Needs attention"
hero — but a mid-sentence reference to the _concept_ stays lowercase. The Telegram
`"supplements & meds"` pairing in `supplement-format.ts` is the documented example
of a correct lowercase concept reference, not a bug.

### 6. House voice: short, declarative, calm

Em-dash connectors, short declaratives, no exclamation marks, no gamified cheer.
The page-subtitle voice (a calm informative sentence with a terminal period) is the
model — it's already consistent across ~all pages and is codified here as-is.

`"🎉"` and celebration stay **out of medical surfaces** (#716's no-gamification
rule is the anchor). Training is the one domain where a celebratory recap line is
allowed — a workout streak is the kind of thing worth a small cheer, and a lab
result is not.

### 7. Notifications are user-facing copy

Telegram, Web Push, and Home Assistant messages follow every rule above — one
message, one register. All Telegram writes already route through the one chokepoint
(`lib/notifications/telegram.ts`); the copy inside them is held to this standard
(`"…hasn't been confirmed yet. Check in."`, not "Please check in.").

### 8. Clinical register: colloquial-first

Write like a family member, not a chart. Everyday household language leads: "meds"
over "medications" in headlines and buttons, conversational prompts over clinical
labels (the dashboard PRN widget is `"Log a dose"`, not "Log a PRN dose").

Two bounded exceptions:

- **(a) Safety surfaces keep the object precise.** A dose confirm or reminder still
  names the medication and the amount — colloquial tone never drops the WHICH or
  the HOW MUCH. `"Took your ibuprofen 200 mg?"` is both casual and exact.
- **(b) Clinical vocabulary where it IS the data.** Coded record labels
  (ICD-10 / LOINC / RxNorm names), extraction views, and form fields that map to
  pharmacy or lab language keep their terms, bridged with the parenthetical
  teach-pattern where the user will meet the term at the pharmacy:
  `"As needed (PRN) — no scheduled reminders"`. Training keeps the vocabulary its
  users own (`"Est. 1RM"` stays).

Term table (colloquial form / clinical form / where each leads):

| Colloquial (headlines, buttons, prompts) | Clinical (coded data, forms, teach-pattern) | Where clinical leads                                 |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Meds                                     | Medications                                 | Coded RxNorm record labels, the Medications nav name |
| Log a dose / Took a med?                 | Administer / PRN dose                       | Safety confirm names the drug + amount               |
| As needed                                | PRN                                         | `"As needed (PRN)"` on the dose-schedule form        |
| Results / readings                       | Biomarkers / analytes                       | LOINC-coded lab views, extraction                    |
| Shots                                    | Immunizations / vaccines                    | CVX-coded immunization records                       |

## Enforcement — the copy-lint scan

`lib/__tests__/copy-lint.test.ts` is a pure source-scan (no DB, no browser) over the
scope directories. It fails CI on:

1. **Banned error verbs / "please"** — `could not`, `failed to`, `unable to`,
   `please` (all case-insensitive, word-boundary) in a user-facing string.
2. **Terminal period on the `"Couldn't …"` error family** — a complete-sentence
   error string missing its period.

It structurally **excludes** non-user-facing contexts so they can't trip it:
comments, `import`/`export … from` lines, `console.*` and `log.<level>(…)` logging
calls, and `throw new Error(…)` (internal, masked to a generic message per #478).
A genuinely-legitimate remaining hit goes on the test's frozen `ALLOW` list, keyed
by `(file, exact substring)` with a per-entry justification — the same
immutable-manifest discipline as the migration hash manifest and the e2e-hygiene
allowlist: **the list only ever shrinks.**

The scan is intentionally narrow — it catches the measured drift patterns, not tone.
Voice (rule 2), case (rule 5), empty-state formula (rule 4), and clinical register
(rule 8) are review-and-convention gates that live in this document, not the linter.
