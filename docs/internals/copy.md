# Copy standard — the house voice for user-facing text

Status: **shipped** (the standard is documented, the measured drift patterns are
swept, and the copy-lint source-scan test enforces the mechanical rules in CI —
issue #945)

The source of truth for tone, punctuation, and phrasing of every **user-facing**
string in the app — page subtitles, buttons, labels, empty states, toasts, error
messages, and notification copy (Telegram / Web Push / Home Assistant). It is
the verbal twin of the #794 visual-consistency sweep and the "one moment, one
register" sibling of #221's "one question, one computation".

This is a single-language app; there is no string catalog or i18n layer — **this
document is the source of truth**, and the mechanical rules below are enforced
by `lib/__tests__/copy-lint.test.ts` (the profile-scoping / telegram-chokepoint
/ notes-text source-scan pattern). The lint is deliberately narrow: it catches
the _measured_ drift patterns, not tone in general — **review still owns tone.**

Scope: `app/**` (except `app/api/**`), `components/**`, and
`lib/notifications/**`. `app/api/**` returned bodies follow the #478
generic-error rule (`"internal error"`), not this standard. Model-facing prompt
text in `lib/ai*.ts` is out of scope (it's not user-facing).

## The eight rules

### 1. Errors: `"Couldn't <verb> <object>."`

Always the contraction — **never** "Could not", "Failed to", or "Unable to" in a
user-facing string. Name the object: `"Couldn't save the provider."`, not
`"Couldn't save."` where the object is knowable.

Append **`"Try again."` only where retrying can plausibly succeed** — a network,
busy, or otherwise transient failure (a save that hit a locked DB, a sync that
lost its connection). **Never** append it to a validation error
(`"Enter a name."`) or a not-found error (`"Couldn't find that dose."`) —
retrying an invalid form or a deleted row changes nothing.

No `"please"` anywhere. The generic `"internal error"` stays the API-layer rule
(#478); this standard governs the human surfaces, where the specific cause is
either safe to name (`"Couldn't reach the RxNorm lookup. You can still save."`)
or logged server-side while the user sees the generic-but-shaped
`"Couldn't merge those providers."`.

```
Couldn't save this appointment. Try again.      // transient — retry advice
Couldn't find that dose.                         // not-found — no retry advice
Enter a valid date (YYYY-MM-DD).                 // validation — imperative, no retry
```

### 2. Voice: "you/your" = the active profile

"you" and "your" always address the **active profile** — the person the header
switcher currently points at. This is a rule, not an accident: on a per-profile
surface (Clinical results, Trends, the dashboard) `"Explore your results…"` is correct
because "your" resolves to whoever is active.

**Cross-profile surfaces never say "your".** The Household page, Family
settings, and other-profile chips show data for people who are _not_ the active
profile, so they use the profile's name or neutral phrasing:
`"Everyone at a glance — confirm what's due…"`, not "your household". An admin
viewing a child's profile must never read "your" and see the child's data.

### 3. Punctuation: sentences get periods, fragments don't

A **complete sentence** ends with terminal punctuation — subtitles, empty
states, toasts, and error strings all included. A **fragment used as a label**
(a chip, a table cell, a delta indicator, an `aria-label`) takes no period.

One rule resolves the `"No change"` / `"No changes."` split that looked like a
bug: `"No change"` is a delta **label** (fragment, no period); `"No changes."`
is a save **outcome** (sentence, period). Both are correct — and knowably so.
The copy-lint test enforces the terminal period on the `"Couldn't …"` error
family.

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
are Title Case as proper nouns** — "Supplements & Meds", "Show everything" — but
a mid-sentence reference to the _concept_ stays lowercase. The
Telegram `"supplements & meds"` pairing in `intake-format.ts` is the
documented example of a correct lowercase concept reference, not a bug.

### 6. House voice: short, declarative, calm

Em-dash connectors, short declaratives, no exclamation marks, no gamified cheer.
The page-subtitle voice (a calm informative sentence with a terminal period) is
the model — it's already consistent across ~all pages and is codified here
as-is.

`"🎉"` and celebration stay **out of medical surfaces** (#716's no-gamification
rule is the anchor). Training is the one domain where a small cheer is allowed
at all — a 100th logged workout is worth a quiet word and a lab result is not —
but the licence is narrow and does not extend to a RUN.
#1935/#1936/#1937/#1939, finished by #1966's Practices "N-week streak",
retired every streak the app showed a user: a figure with a cliff turns the
cheer into a loss to avoid, on the same screens that recommend rest days,
deload weeks and deliberate skips. Celebrate a total or a declared goal met;
never a run maintained.

### 7. Notifications are user-facing copy

Telegram, Web Push, Home Assistant, and email messages follow every rule above — one
message, one register. All Telegram writes already route through the one
chokepoint (`lib/notifications/telegram.ts`); the copy inside them is held to
this standard (`"…hasn't been confirmed yet. Check in."`, not "Please check
in.").

### 8. Clinical register: colloquial-first

Write like a family member, not a chart. Everyday household language leads:
"meds" over "medications" in headlines and buttons, conversational prompts over
clinical labels (the PRN quick-log content says `"Log a dose"`, not "Log a PRN
dose").

Two bounded exceptions:

- **(a) Safety surfaces keep the object precise.** A dose confirm or reminder
  still names the medication and the amount — colloquial tone never drops the
  WHICH or the HOW MUCH. `"Took your ibuprofen 200 mg?"` is both casual and
  exact.
- **(b) Clinical vocabulary where it IS the data.** Coded record labels (ICD-10
  / LOINC / RxNorm names), extraction views, and form fields that map to
  pharmacy or lab language keep their terms, bridged with the parenthetical
  teach-pattern where the user will meet the term at the pharmacy:
  `"As needed (PRN) — no scheduled reminders"`. Training keeps the vocabulary
  its users own (`"Est. 1RM"` stays).

Term table (colloquial form / clinical form / where each leads):

| Colloquial (headlines, buttons, prompts) | Clinical (coded data, forms, teach-pattern) | Where clinical leads                                 |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Meds                                     | Medications                                 | Coded RxNorm record labels, the Medications nav name |
| Log a dose / Took a med?                 | Administer / PRN dose                       | Safety confirm names the drug + amount               |
| As needed                                | PRN                                         | `"As needed (PRN)"` on the dose-schedule form        |
| Clinical results                         | Biomarkers / analytes                       | Quantity-specific charts, LOINC views, extraction    |
| Shots                                    | Immunizations / vaccines                    | CVX-coded immunization records                       |

## Ruled additions, 2026-08-21 (implementation pending in the cited issues)

Four rules joined the standard from the phone-review consolidation; each is
owner-ruled and ships with its guard (the guards-mandatory ruling recorded on
#3459–#3501). They are indexed from `design-system.md` §6 and owned here.

### 9. Machine text renders at the display boundary

Stored machine forms never reach user-facing copy verbatim: dates render
through the profile's display format prefs (never raw ISO — #3492, shipped),
units display-normalized (UCUM bracket stripping per #1018's equivalence —
#3493), enum-ish values through label maps with the raw value as fallback
(#3493). List joins never use a separator the joined names can contain
(`summarizeNames` and template joins — #3496), and clinical names are never
title-cased (`lib/allergen-vocabulary.ts`'s recorded doctrine; imported
ALL-CAPS names are cleaned at the import boundary with the person confirming,
never by a display casing pass — #3480).

**Dates, as shipped (#3492).** There is one date boundary and it already
existed: the display vocabulary in `lib/format-date.ts` — `formatLongDate`,
`formatMonthDay`, `formatDateWithYear`, `formatTimestamp` — each taking the
login's `DisplayFormatPrefs`. A new surface inherits it by asking for the prefs
where prefs are resolved: `useFormatPrefs()` in a client component,
`getDisplayFormatPrefs(login.id)` once at a server page's request boundary. A
pure model that builds a sentence containing a day takes prefs as an argument
and formats there (`lib/reading-date-line.ts`, `lib/glance-age.ts`); it never
formats with a hardcoded locale and never prints `reading.date` as stored.

The rule a day is rendered under is the profile-local DAY, not the instant it
came from — an instant is projected to a day first (`zonedDateParts`), then
formatted. Getting that backwards shifts dates by one for anyone off UTC, which
is worse than an ugly ISO string.

`iso` is one of the three `dateFormat` prefs a login may choose. A rendered
`YYYY-MM-DD` is therefore a defect only when the reader did not ask for it —
which is why the guard's premise is the default prefs, asserted rather than
assumed.

**Guards.** Two, over one rule (`lib/machine-date-census.ts`):

- `lib/__tests__/machine-date-census.test.ts` — the rule can SEE every shape a
  storage date reaches copy in (including the date half of a raw instant, which
  the obvious `\b…\b` pattern cannot match at all), and stays QUIET on the
  display vocabulary's own output and on 4-2-2 digit runs that are not dates.
- `e2e/machine-date-census.spec.ts` — the same rule over RENDERED TEXT NODES on
  six routes. Not a source scan: every offending site is computed (`{r.date}`),
  so a source grep finds none of them while flagging comments, fixtures and
  `<time datetime>` attributes that are the boundary working correctly. A text
  node cannot be an attribute, so `<time datetime>`, `input[type=date]` values
  and download filenames need no allowlist — they are excluded by mechanism.
  Because it is an ABSENCE assertion it fails open, so it carries a census floor
  per route, a named subject that must have rendered a date in the display
  shape, and a synthetic offender planted in the live DOM that it must catch.
  The one exemption (the import page's Debug disclosure, whose subject IS the
  machine payload) is asserted together with the premise licensing it — that it
  is a closed `<details>` a reader opts into.

`lib/__tests__/date-locale-guard.test.ts` is the older, narrower sibling: it
catches a call to a pref-taking formatter that omits the prefs, and an
implicit-locale `toLocale*`. It cannot see a surface that calls no formatter at
all — which is the whole of what #3492 found, and what the census probe adds.

### 10. Lead + fold

An intro is one sentence; formats, mechanisms, vendor lists, and source
citations sit behind a disclosure ("What can I import?", "Why this works").
Provenance stays findable, never leading. (#3488, #3490, #3497.)

### 11. State honesty at low n

A stat block never asserts more structure than its n supports: below its
model's threshold it renders one quiet line in the insufficiency voice, not
tiles or repeated figures ("Variability 0 d" from one cycle, one dose stated
three ways — #3482, #3498). The threshold is the model's, stated once.

### 12. Tone semantics in text

Emerald/amber carry direction verdicts; slate is neutral context; sky is not a
text tone for static copy, and the link tone (`text-link`, #2719) is never
worn by non-interactive text (#3474, #3487, #3500). A card's tone is not
repeated as CAPS in its copy (#3497).

## Enforcement — the copy-lint scan

`lib/__tests__/copy-lint.test.ts` is a pure source-scan (no DB, no browser) over
the scope directories. It fails CI on:

1. **Banned error verbs / "please"** — `could not`, `failed to`, `unable to`,
   `please` (all case-insensitive, word-boundary) in a user-facing string.
2. **Terminal period on the `"Couldn't …"` error family** — a complete-sentence
   error string missing its period.
3. **Second-person voice on cross-profile surfaces** — `you` / `your` in the
   Household and Family homes, shared profile/subject chips, and TSX components
   carrying `ProfileScope`, `SubjectInfo`, or `viewIds`. Login-scoped control copy
   requires an exact, justified entry in the shrinking allowlist.

It structurally **excludes** non-user-facing contexts so they can't trip it:
comments, `import`/`export … from` lines, `console.*` and `log.<level>(…)`
logging calls, and `throw new Error(…)` (internal, masked to a generic message
per #478). A genuinely-legitimate remaining hit goes on the test's frozen
`ALLOW` list, keyed by `(file, exact substring)` with a per-entry justification
— the same immutable-manifest discipline as the migration hash manifest and the
e2e-hygiene allowlist: **the list only ever shrinks.**

The scan is intentionally narrow — it catches the measured drift patterns, not
tone. Cross-profile voice (rule 2) is mechanical; active-profile voice remains a
review gate. Case (rule 5), empty-state formula (rule 4), and clinical register
(rule 8) remain review-and-convention gates that live in this document, not the
linter.
