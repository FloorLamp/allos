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
lab units display-normalized (UCUM bracket stripping per #1018's equivalence —
#3493; ASCII micro tokens such as `ug`/`uL` render with `µ` — #3545), while the
dose vocabulary deliberately keeps `mcg`; enum-ish values use label maps with the raw value as fallback
(#3493). List joins never use a separator the joined names can contain
(`summarizeNames` and template joins — #3496, shipped), and clinical names are never
title-cased (`lib/allergen-vocabulary.ts`'s recorded doctrine; imported
ALL-CAPS names are cleaned at the import boundary with the person confirming,
never by a display casing pass — #3480, shipped).

**List joins, as shipped (#3496).** The separator is `NAME_JOIN_SEPARATOR`
(`" · "`) in `lib/summarize-names.ts`, with `joinNames` for a roster and
`joinNamesForSentence` for the two-name subject a headline reads aloud ("X and
Y are high"). A comma was the separator until a phone review counted five
analytes in a line naming three: "Lymphocytes, Relative" and "Neutrophils,
Absolute" are single lab names, so the list contradicted the count beside it.

Seven modules join names this way and all seven ask that module: the Results
trajectory roster (`lib/trajectory-rollup.ts`), the Training-watch muscle roster
(`lib/training-findings-rollup.ts`), the illness dose-lane roster
(`lib/illness-episode-format.ts`), the food-suggestion headline
(`lib/food-suggest.ts`), the curated-supplement headline
(`components/CuratedSupplementSuggestions.tsx`), the food-suggestion finding's
"Because your …" detail (`lib/rule-findings.ts`), and the food-limit tap note
(`lib/food-limit-note.ts`). `git grep "from \"./summarize-names\""` is the
census — membership is the IMPORT, not a spelling a source grep could miss.

**Guard.** `lib/__tests__/summarize-names.test.ts` asserts the PROPERTY, not the
string: splitting the rendered line on the separator must recover exactly the
names that went in, over the real comma-bearing LOINC names — so a future author
who tidies the join back to `", "` fails there rather than on a snapshot.

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

**Imported names, as shipped (#3480).** A portal-imported medication carries the
document's own label — `"Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)"` —
and every surface renders it as stored. The parenthetical is the portal's
ALL-CAPS sig-style label with a dose-form code (`"OR"` = oral).

The boundary is the IMPORT, and it is an OFFER rather than a transform. The
import review page's Medications tab lists this document's medications whose
stored name still reads as the document's label and offers RxNorm's preferred
name for each; accepting stores the clean name and moves the portal string onto
the record (`intake_items.source_name`, rendered as source detail under the
medication's name and never as a heading). Ignoring the offer is a complete
answer — the medication keeps the name it has.

The candidate list carries NO caution copy, deliberately (owner, 2026-08-22),
and the record is here because a caution is the obvious thing to add back. A
line reading `"Any warnings on this med follow its name — a new name can change
them."` shipped above the candidates and was retracted: it asserts a mechanism
this tree does not have. Matching is RxCUI-FIRST with the name as fallback
(`matchConceptKeysIn` `continue`s on a code hit; `lib/food-drug-interactions.ts`
writes `const byName = !byRxcui && …`), and the accept button WRITES an
authoritative rxcui — so pressing it takes the row from name-fallback to
code-first and strengthens those warnings rather than moving them. The sentence
was falsified by the control it sat above.

No shorter line, tooltip or help affordance replaces it. Rule 6 forbids
editorializing, and a person choosing between two names does not need a
paragraph about how matching works — the rename is visible in the act itself.
(`lib/dri.ts` matches nutrients by name substring and is the one name-keyed
vocabulary here; that is #3553's subject, not copy on this card.)

Three parts, and a new importer inherits the boundary by writing rows the same
way any importer already does:

- `lib/imported-name.ts` — the pure predicate. Does a stored name read as the
  document's label? Three shapes, each a different one rather than more of the
  same: a SHOUTED WORD (six or more upper-case letters in one token — no
  abbreviation anybody uses as a medicine's name is that long), a DISPENSING
  LABEL (two or more shouted tokens with one of four-plus letters, or three of
  any length — a name plus a strength unit plus a dose form), and TALL MAN
  LETTERING (`"amLODIPine"`, `"predniSONE"`, `"DOPamine"`, `"OXcarbazepine"`,
  `"ePHEDrine"` — the ISMP convention and standard Epic/Cerner output, in all
  three of its orders: the run after the stem, the run at the start, and a run
  with lower-case on both sides). Quiet on `"Vitamin D3 5000 IU"`, `"Metformin HCl ER"`,
  `"penicillin v potassium"`, and on the whole abbreviation shelf — `"NAC"`,
  `"DHEA"`, `"TUDCA"`, `"5-HTP"`, `"EPA/DHA"`, `"MCT oil"`. It deliberately
  UNDER-matches a short brand shouted alone (`"ASA 81 mg"`, `"HCTZ 25 mg"`),
  which is the same shape as `"DHEA 50 mg"` and cannot be separated from it
  without a vocabulary of drug names: a missed offer costs nothing, an offer on
  somebody's supplement shelf costs every future one.
- `lib/queries/imports.ts` `getDocumentImportedNameOffers` — the SCOPE GATE, and
  the reason the offer cannot drift into the display pass this rule rejects. The
  predicate is only ever asked about rows an import wrote (`source =
'extracted'`), so a name somebody typed is never examined. Any importer whose
  rows land in `intake_items` as `extracted` with a `document_id` is covered on
  the day it ships, with nothing to register.
- `lib/imported-name-write.ts` — the one write. Scoped to profile + document +
  extracted + a non-blank stored name — EXACTLY what the offer read lists, so
  there is no row the card can show and the button cannot reach. It is not scoped
  on `kind`: that is the person's classification and they may change it from the
  medication form at any time, while provenance is what the boundary is about.
  `source_name` is written with `COALESCE`, so what the DOCUMENT said is recorded
  once and never overwritten by a later rename.

Why not the cheap version: a casing pass at the display boundary cannot tell
whether `"OR"` is a route abbreviation or a word in a product name, and it
rewrites, on every render, text nobody agreed to change. That is the same ruling
`lib/allergen-vocabulary.ts` records for allergens, one layer further in.

**Guards.** Three, over one rule:

- `lib/__tests__/imported-name.test.ts` — the predicate SEES the observed string
  and the other portal shapes, off the words that actually shout, and stays QUIET
  on the names people write. The quiet half carries the weight: an offer that
  fires on ordinary names is dismissed by habit, and the real one goes with it.
- `lib/__tests__/imported-name-census.test.ts` over `lib/imported-name-census.ts`
  — no display surface casings a name, in any of its mechanisms: a transform in a
  JSX interpolation, an `uppercase`/`capitalize` class over a name render
  (including one reached through a ternary), or an inline `textTransform`. The
  element's child window is depth-aware, so a nested tag before the name no
  longer ends it and a sibling after it is correctly outside.
  Because it is an ABSENCE assertion it fails open, so it carries floors (800
  files, 220 name render sites, 45 casing-markup sites — measured 855 / 244 / 56),
  a NAMED SUBJECT that must still register a name render
  (`app/(app)/medications/MedicationRow.tsx`, the brand-coloured heading the
  issue was filed about), fifteen synthetic offenders in the JavaScript half and
  four in the markup half that it must flag, and fourteen shipped benign
  neighbours it must stay silent on — the 21 sites that lowercase a name to
  compare, sort or key a Map are correct, and a guard that flagged them would be
  deleted within the month. The bound-local half sees a template-literal
  right-hand side, an object right-hand side and a casing REASSIGNMENT with no
  declarator; it deliberately still stops at a callback body. What it cannot see
  is FOUR entries — a casing pass inside another component, a name that leaves
  the file and comes back, an alias made by a destructure, and that callback
  body — and both the module's header and the test's now carry all four, because
  the module listed three while the test listed four. Comments are blanked before the scan: that
  moves the count from 270 to 244, and `className` is excluded from the
  name-expression pattern because it ends in `Name` and was inflating the
  denominator by 118 sites that render no name at all.
- `lib/__db_tests__/imported-name-boundary.test.ts` — the boundary over the REAL
  pipeline (`extractFromCcda` → `healthRecordToPersistInput` →
  `persistDocumentImport`): the name lands VERBATIM, the offer fires on it, a
  hand-entered medication with the same shouting shape is never offered,
  accepting preserves the document's label through a second adoption, and the
  write refuses another profile's row, another document's row, and a manual row.
  Each half of the scoping is asserted BY A ROW THAT DIFFERS ONLY IN THAT HALF —
  the attack row shares the profile's document, the document's id and the
  extracted source, so the clause under test is the only thing that can reject
  it. A guard whose attack row is rejected by a neighbouring clause proves the
  neighbour, not the subject.
- `lib/__action_tests__/imported-name.actions.test.ts` — the RxNorm re-check.
  An unreachable or disagreeing lookup REFUSES rather than renaming, and the row
  is unchanged afterwards; nothing else in the tree observed that block.
- `lib/__action_tests__/imported-names-card.render.test.ts` — the import review
  page actually RENDERS the card. Deleting the render used to leave every tier
  green and `eslint` at exit 0, so the feature could disappear silently.
- `components/__tests__/imported-name-offer.test.tsx` — the offer's own DOM, and
  both ways the rename can fail. The accept handler had a `try … finally` with no
  `catch`: a Server Action that REJECTED left the button un-busied and said
  nothing at all, so a person was looking at a medicine they believed they had
  renamed. Both that and the returned-error branch are driven here; no other tier
  can see either. It also holds the retracted caution OUT — and because that is
  an absence, the same case first asserts the candidate list, the candidate's
  name, the stored name and the accept control are on screen, so a component
  that stopped rendering reds instead of passing.

### 10. Lead + fold

An intro is one sentence; formats, mechanisms, vendor lists, and source
citations sit behind a disclosure ("What can I import?", "Why this works").
Provenance stays findable, never leading. (#3488, #3490, #3497.)

**As shipped (#3488 + #3490, one change).** The two issues were filed
separately — one lands on a page, the other in the integrations registry — and
built together, because a convention expressed twice is two conventions by the
following month. There is ONE primitive:

`components/LeadFold.tsx` takes `lead`, `detail`, and the `summary` question the
closed disclosure answers, and owns everything else: a native `<details>` (no
client boundary, works pre-hydration, correct keyboard/AT semantics for free —
the same reasoning `app/(app)/upcoming/page.tsx`'s AggregateDisclosure recorded),
one type scale, one tone for both halves, one chevron. A caller brings copy and a
`testId`; it brings no styling decisions, so nine adopters cannot drift into nine
intros.

A THIRD SURFACE INHERITS IT by rendering `<LeadFold>` with its own summary label
and a `testId`, and by adding that route to `e2e/lead-fold-census.mobile.spec.ts`'s
`ROUTES` — which is also how the census's floor stays honest. Nothing else is a
decision. #3497's provenance blocks are the next queued adopter.

Where the split is STORED depends on where the copy lives. Page copy stays in the
page (`components/UploadForm.tsx`'s intro is JSX, because half its detail is
markup). Registry copy splits in the registry: `IntegrationDef` carries
`lead: string` and `detail?: string` instead of one `blurb`, so the #1880
connect-card grid can render the lead ALONE — which is the "short blurb" that
ruling asked for and a single 146-word field could not give it.

Nothing is deleted in a split. A claim that was in the old text is in the lead or
in the detail, and the census asserts the fold opens and holds real content.

**Guards.** Two, over one rule (`lib/lead-fold-census.ts`), because a character
budget is a proxy and a rendered box is the thing the reader meets:

- `lib/__tests__/lead-fold-census.test.ts` — the rule can SEE (it is run over the
  four walls this pair was filed about, verbatim as shipped, plus the subtler
  one-sentence-but-too-long and short-but-three-sentences cases) and stays QUIET
  on the benign neighbours (the period inside "Lose It!", a fragment with no
  terminator, a lead exactly on the budget). It carries a CENSUS FLOOR — the
  registry's size, asserted against a recorded number — because "no lead exceeds
  N" passes trivially over a list that quietly emptied.
- `e2e/lead-fold-census.mobile.spec.ts` — the same rule over RENDERED BOXES at
  390px, on all nine intros. It measures `boxHeight / lineHeight` from the live
  element (lines, not pixels: lines is the unit both acceptance criteria are
  written in), waits for the lead's own text before measuring anything, and
  plants the 72-word health-connect blurb back into the live DOM as a synthetic
  offender it must flag at six lines or more.

### 10a. A tab strip scrolls without painting a scrollbar

Registered in `design-system.md` §3 and closed by the same change: the
suppression pair (`scrollbar-none` + `[&::-webkit-scrollbar]:hidden`) lives on
the shared strip in `components/TabList.tsx`, never at a call site.

Its guard uses a computed-style cascade reading because headless Chromium's
overlay scrollbars consume no geometry. It compares each live, forcibly
overflowing strip with an unsuppressed control, proving both that suppression
reached the element and that scrolling remains possible.

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
per #478).

Disclaimer prose is not part of this source scan. `lib/disclaimers.ts` owns the
shared wording, and an import-boundary test prevents other `app/` and
`components/` modules from importing it. The canonical page has rendered E2E
coverage; curated datasets and generators have focused checks; runtime-generated
copy is stripped through the shared disclaimer helpers. There is no global
inline-disclaimer source scan.

The scan is intentionally narrow — it catches the measured drift patterns, not
tone. Cross-profile voice (rule 2) is mechanical; active-profile voice remains a
review gate. Case (rule 5), empty-state formula (rule 4), and clinical register
(rule 8) remain review-and-convention gates that live in this document, not the
linter.
