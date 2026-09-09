# User-facing copy

This guide owns voice, punctuation, and display wording for pages, controls,
empty states, toasts, errors, and notifications. API response bodies keep their
existing generic-error contract; model-facing prompts are outside this guide.
There is no string catalog or i18n layer. Layout and control selection belong
in the [design system](design-system.md).

## Voice and errors

Write short, calm sentences in everyday language. No “please,” exclamation
marks, gamified cheer, or explanations of internal policy. Medical surfaces do
not celebrate. Training may acknowledge a total or a declared goal met, never a
streak or run maintained.

“You” and “your” address the active profile. Cross-profile surfaces use names or
neutral wording. Login-scoped control copy must clearly refer to the login's
own setting.

Errors use `Couldn't <verb> <object>.`, naming the object when known. Avoid
“Could not,” “Failed to,” and “Unable to.” Add “Try again.” only for a plausibly
transient failure. Validation tells the person what to enter; a missing row
gets no retry advice. Log sensitive causes server-side.

- Transient: “Couldn't save this appointment. Try again.”
- Missing: “Couldn't find that dose.”
- Validation: “Enter a valid date (YYYY-MM-DD).”

Complete sentences take terminal punctuation. Labels and fragments do not:
“No change” is a delta label; “No changes.” is a save outcome. Use sentence case;
feature/nav proper names retain their canonical spelling.

## Empty states and clinical terms

State what is absent, then offer one next step available on screen. Use
“logged” for user entries, “recorded” for clinical data, and “imported” for sync
or import results. Range-scoped empties identify the range and how to change it.

Everyday language leads: “meds,” “Log a dose,” “shots.” Keep clinical terms when
they are the data: coded records, extraction views, and pharmacy/lab form
fields. Bridge unfamiliar terms where useful: “As needed (PRN) — no scheduled
reminders.” Training retains terms its users know, such as “Est. 1RM.”

Safety confirms and reminders always identify the medication and amount.
Colloquial wording must preserve which drug and how much.

## Display boundaries

Stored machine forms are formatted when displayed:

- Dates use `lib/format-date.ts` and the login's `DisplayFormatPrefs`, obtained
  through `useFormatPrefs()` or `getDisplayFormatPrefs(login.id)` at the server
  boundary. Pure sentence builders receive prefs. Project an instant to the
  profile-local day before formatting that day. ISO output is correct when the
  login selected it; raw storage output is not a substitute for preferences.
- Lab units use display normalization: strip UCUM brackets and render ASCII
  micro tokens with `µ`. Dose vocabulary deliberately retains `mcg`.
- Enum values use label maps with the raw value as fallback.
- Name lists use `joinNames` or `joinNamesForSentence` from
  `lib/summarize-names.ts`. `NAME_JOIN_SEPARATOR` is `·`; a comma can already
  occur inside one clinical name.
- Clinical names render as stored, without display-time title-casing,
  capitalization classes, or case transforms.

Imported medication names may be cleaned through a user-confirmed import offer.
`lib/imported-name.ts` detects portal-label shapes;
`getDocumentImportedNameOffers` scopes candidates to extracted document rows;
`lib/imported-name-write.ts` owns the rename. It scopes by profile, document,
extracted source, and nonblank name, not the person's changeable intake kind.
Preserve the original label once in `source_name` with `COALESCE`. Acceptance
rechecks RxNorm; failed or disagreeing lookups refuse the rename. Ignoring the
offer keeps the name. Do not add caution copy explaining matching machinery to
this card.

## Lead and detail

An intro has one lead sentence. Put formats, mechanisms, vendor lists, and
citations in an optional disclosure with a useful question as its summary.
Use `components/LeadFold.tsx` (`lead`, `detail`, `summary`) for the shared native
`details` presentation; callers supply content, not a new type scale or tone.
Registry copy splits at its source (`IntegrationDef.lead` and `.detail`) so
compact cards can show only the lead. Keep useful claims in the lead or detail;
remove redundant prose rather than hiding it.

## Explainers on rows

A constant explanation states itself once, at the structural level that owns
it: a column header, group header, or legend. A per-row fact moves to the row's
detail surface where one exists. A fact with no other home, and a rare warning
such as a fault or mismatch, keeps its icon; a row carries at most one (#3970).
Relocate rather than delete: `title=`-only content is unreachable for touch,
keyboard, and screen readers (#3375).

## Honest states and repetition

A stat block follows the model's evidence threshold. Below it, show one quiet
insufficiency line instead of tiles or repeated figures. The model owns the
threshold; copy must not derive another.

State a fact once per view, in one format, at the surface that owns it. A body
normally does not repeat its header or a notification's title. Preserve explicit
approved designs: the illness cockpit header intentionally repeats the person's
name and `Illness · Day N`. A change to that design needs its own scope.

Where an approved surface and an unapproved one state the same fact, the approved
half is raised and the other gives way. Owner ruling 2026-09-07: the cockpit's
accordion row goes quiet when it is expanded — no situation, day, trend arrow,
temperature, last dose or fever clock — because the header below states all six.
It keeps the name and avatar, which identify whose card a control writes to.

Use `hoursLabel` in `lib/redose-format.ts` for durations such as `1h 12m`, not
`~1.2h`. `lib/format-date.ts` retains two clock conventions: `11:39 AM` for
records and `11:39am` for administrations. Their meeting in the cockpit is an
unresolved consistency issue, not permission to invent a third spelling.

## Existing checks

`lib/__tests__/copy-lint.test.ts` checks banned error verbs/“please,” punctuation
on “Couldn't” errors, and cross-profile second-person copy. It excludes internal
logs, exceptions, imports, and comments. Tone, case, clinical register, and
active-profile voice still need review.

Existing date/unit census, name-join, imported-name, and lead/fold tests cover
those display boundaries. Follow the [change and test policy](../change-policy.md)
when deciding whether a change leaves a meaningful coverage gap; do not add
source-wording assertions for this guide.

`lib/disclaimers.ts` owns shared disclaimer wording. Its import boundary,
canonical page, datasets/generators, and runtime stripping have focused checks;
there is no global inline-disclaimer scan.
