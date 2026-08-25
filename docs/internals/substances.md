# Substances

The cross-domain Timeline browses alcohol, nicotine, cannabis, and custom
substances as one per-day `substance` rollup. Alcohol is counted from its shared
food serving events; the other substances are counted from their current daily
totals. This is browse-only. #3295 owns the later event-row schema and writers,
and its row ledger must mount `components/ledger/EventLedgerFrame.tsx` as
recorded in `docs/internals/event-ledger.md` rather than creating a substance
shell beside it.

Status: vocabulary shipped (#3279); the surfaces that consume it are in flight

This is the file to read before adding anything to the substance domain. It records
what the words mean, which store owns which shape, and where the opt-in boundary sits.
The rulings are the repo owner's, 2026-08-19, recorded on #3279.

## The doctrine

**Consumption is observation.** Substance consumption is data like food or mood. A
person logging two drinks is recording a fact, not confessing one. Screening
instruments (AUDIT-C, AUDIT, DAST-10) and weekly reduction caps are **opt-in tools** a
person reaches for — never the page's default framing. This is #2380's
"an observation, never a target" applied to the one domain that never got it.

The app records; it never advises. No dosage guidance, no titration suggestions, no
benefit claims, no legality modelling. A custom substance gets a ledger and honest
unknowns, and nothing more.

## The vocabulary

| term                     | meaning                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **substance key**        | The stored identity of a substance: `substance_daily_totals.substance`, and `frequency_targets.scope_value` for the `substance` scope. `SubstanceKey` in `lib/substance-use.ts`. |
| **curated key**          | One of the app's authored substances (`alcohol`, `nicotine`, `cannabis`). A closed set that may grow modestly where good defaults exist. `Substance` / `isCuratedSubstance()`.   |
| **custom key**           | A profile's own substance, stored as its normalized name. Not registered anywhere before use. `isCustomSubstanceKey()`.                                                          |
| **unit**                 | One countable use: a standard drink, a cigarette, a session. Custom substances always count in generic uses.                                                                     |
| **episodic consumption** | Countable uses aggregated to one per-day total. What a substance key names.                                                                                                      |
| **dosed regimen**        | A named substance taken at an amount on a cadence. **Not a substance key** — see the boundary below.                                                                             |
| **reduction cap**        | An opt-in weekly ceiling on units. A `frequency_targets` row with `scope_kind = 'substance'`.                                                                                    |
| **screener**             | An opt-in screening instrument administered or entered on the substance page.                                                                                                    |

`SubstanceDef` is the per-key display and ledger record. `substanceDef()` is **total**
over the key space: authored fields for a curated key, derived fields for a custom one.
An unknown key renders as itself rather than throwing, so a ledger row always has a card
to live in (the #203 name-keyed discipline).

## Curated plus custom is borrowed, not invented

The substance vocabulary is `lib/symptoms.ts` re-instantiated. Both answer one question
— "which entries exist for this profile, and what is each one called?" — so both use the
same four functions, and `docs/internals/identity-registry.md` lists them side by side:

| symptoms                 | substances                 |
| ------------------------ | -------------------------- |
| `normalizeSymptomName()` | `normalizeSubstanceName()` |
| `resolveSymptomKey()`    | `resolveSubstanceKey()`    |
| `isCuratedSymptom()`     | `isCuratedSubstance()`     |
| `isCustomSymptomKey()`   | `isCustomSubstanceKey()`   |
| `symptomLabel()`         | `substanceLabel()`         |

A second normalization rule for the same shape of user text would be the
"one question, one computation" disease at the identity layer.

**Case folds for matching, never for display (#3325).** Case is stored verbatim, because
"MDMA" must not read as "Mdma" on a card heading; what #3325 removed was case DECIDING
identity, which had made `"Kratom"` and `"kratom"` two substances with two cards and two
ledgers, each looking correct. This is the one part of the model that is not
re-instantiated but genuinely **shared**: both resolvers call `matchFoldedVocabulary()`
from `lib/vocabulary-fold.ts`, and both are handed this profile's own spellings by
`resolveProfileVocabularyKey()` in `lib/vocabulary-store.ts`. Two copies of a fold would
drift the moment one domain's rule changed, which is why #3279's lane left the defect
alone rather than fixing one half of it.

The fold is **compared, never stored**: no code path leads from a fold to a key, so no
normalizer can hand back a lower-cased label. It is also **not re-spellable in SQL** —
SQLite's `LOWER(...)` / `COLLATE NOCASE` fold ASCII only, so a case-insensitive match written
in SQL would disagree with the write boundary and quietly re-create the duplicate;
`lib/__tests__/vocabulary-sql-fold-census.test.ts` fails the day anyone reaches for it. The spelling that wins is the **first seen**
— the oldest ledger row's — so a card is never re-titled behind somebody's back, and the
surface says which one took the log ("Kratom: 1 logged today" for a typed "kratom").

It applies where a person **types** a name: `trackSubstanceUseAction` here,
`logSymptomCore` on the symptom side. A key a surface hands back — correcting a day,
setting a cap, renaming, deleting — resolves bare, because it came from a row the app
just rendered and folding it could redirect the edit onto a neighbour.

**Rows that already differ only by case are left alone**, deliberately. Merging them is an
irreversible edit to a health record that nothing at migration time can ask about, and the
merge rule already exists as a USER action (`renameCustomSymptom` for symptoms; the day
rows are editable and undoable for substances) — re-implementing it in raw migration SQL,
where the write cores are unreachable, would fork the collision semantics. So new writes
join the first-seen card and the other spelling keeps its own history, readable and
editable; it simply stops being the target of new logs.

**No new table, and no migration.** A custom substance's identity _is_ its normalized
name in the ledger, exactly as a custom symptom's is in `symptom_logs.symptom`. Migration
096 declared this on day one: `substance` carries no `CHECK`, "so a future substance needs
no rebuild". The catalog is what widened; the column never had to.

**The ledger is the register.** A custom substance exists for a profile because there is a
row. `getProfileSubstanceKeys()` is the curated catalog plus every custom key with data —
ruling 3's read half. Undo the last unit and the row is dropped, so the substance quietly
leaves the vocabulary; that is why there is no delete-a-substance affordance to build.

**Which ledger a custom substance rides is not a choice.** It is `substance_daily_totals`,
with count semantics, always. The food-log ledger is a curated fact about alcohol
specifically — a standard drink _is_ one serving of the curated `alcohol` food group
(#860/#944) — and nothing a person types can be shown to be a food, so nothing typed may
pollute the nutrition ledger.

## The episodic / regimen boundary

Two shapes, two existing stores, no third engine.

- **Episodic consumption** — sessions, drinks, uses — is a substance key on the substance
  ledger. Alcohol on `food_daily_totals`/`food_log_events`, everything else on
  `substance_daily_totals`.
- **A dosed regimen** — 10 µg every 3 days — is an **intake item**: free-text name,
  µg-capable amount, interval cadence, situational holds, linked to a protocol through the
  shipped intake-linked N-of-1 tally (#3144), with outcome metrics like any protocol. This
  path works mechanically today; #3279 blesses it rather than building anything.

The practical test, for anyone tempted to widen `lib/substance-use.ts`: **if the thing
being logged carries an amount per administration, it is an intake item; if it carries a
count per day, it is a substance key.** A dose column on `substance_daily_totals` is the
mistake this boundary exists to prevent.

## Where the opt-in boundary is

Opt-in has to be structural, not a flag every read path remembers to check.

There is no cap-shaped value to render unless a target row exists. `substanceCapStatus()`
is the only producer of a `SubstanceCapStatus`, `capProgressLine()` is the only consumer,
and `lib/queries/substance.ts` calls the producer only when `getSubstanceTarget()` returned
a row — one line, `status: target ? … : null`. A surface cannot render cap framing for a
profile that never opted in, because it holds nothing to render. A helper that manufactured
a status from a count and a default cap would make the opt-in cosmetic again; do not add one.

**`cap: 0` is not "no cap".** A zero cap is an opted-in target — a substance-free week,
"Dry January", a quit target — and it renders its own line. The absence of a target is a
different state that renders nothing. The two are `status === null` versus
`status.cap === 0`, and conflating them produces reduction framing for someone who asked
for none.

Screeners sit behind their own affordance for the same reason: an unadministered
instrument has no reading, so there is nothing for the ledger-led page to show.

## Naming your own, and where it can be reached from

**Logging it is creating it (#3326).** A custom substance has no registration row, so
the surface has no create step: one field on Health record › Specialty › Substance use
takes a name and logs the first use, and the card that appears underneath is the same
`ConsumptionSection` a curated substance gets. There is nothing else to build, because
a custom substance is not a lesser kind of substance.

**The 60-character cap is refused, not trimmed.** `resolveSubstanceKey` normalizes and
truncates, which is right for a stored key and wrong for a person typing — 61 characters
would silently become a different substance. `validateSubstanceName()` asks "usable
exactly as typed?" first and then resolves through the same one normalizer, and
`substanceNameError()` is the single wording both the form and the Server Action use.
Deliberately no `maxLength` on the input either: the browser would clip a paste without
a word, which is the same defect in nicer clothes.

**The quick-log sheet's substance row (#3327).** `QUICK_LOG_DOMAIN_CENSUS` argued this
domain out for years: substance logging lived beside its cap verdict, and a sheet row
would detach the tap from the context that made it honest. #3279 ruling 1 narrowed that
to its premise — it presumes a cap exists. The row now ships with both halves answered:

- it is offered **only to a profile that has a substance ledger row**, never for the
  vocabulary at large, and a profile that tracks none gets **no row at all** — an empty
  offer is worse than no offer. `hasLoggedSubstance()` gates the row; the list itself is
  `getLoggedSubstanceKeys()`, gathered on open. Both are distinct from
  `getProfileSubstanceKeys()`, which answers the _vocabulary_ question and therefore
  always opens with the curated three;
- the overlay renders `capProgressLine` beside the tap for any substance whose target
  exists, and nothing for one whose target does not — so a tap is never detached from a
  verdict there is one to detach from, and reduction framing never reaches somebody who
  opted into none.

The gate defaults **closed** wherever it is threaded (`quickLogMenu`, `logSheetSegments`,
`shortcutAction`), which is the opposite of the cycle gate's default and deliberately so:
an unthreaded caller must not over-SHOW here, because the unconditional offer is the
defect. The same two facts are re-checked server-side in `loadQuickEntry`, so a
hand-written `?quick=log-substance` cannot reach the offer either.

A substance tap is also one hand-entered row of logging evidence, so `LOG_DAY_SOURCES`
declares `substance_daily_totals` for the Consume segment. Alcohol is deliberately **not**
declared there: its taps land on `food_daily_totals`, which the Consume arm already counts,
and naming that store twice would make one tap evidence for two segments.

## Reach

Substance data stays out of share links, the emergency card, print surfaces, and every
send, by default. The neutral stance changes what the **owner** can do, not what the app
broadcasts. No substance ever generates a finding-driven send. Telegram carries substance
buttons only after an explicit per-profile opt-in, the same consent shape as food buttons
(`getProfileFoodTelegram`).

Reduction targets are excluded from `getFrequencyTargetProgress` and always will be: a cap
is a ceiling and every other frequency scope is a floor, so a floor-semantics reader would
nag toward more consumption.

## Never

- No gamification. No streaks, no badges, no "X days sober" milestones, no celebratory
  copy. The write paths never touch `activities`, so the milestone machinery is
  structurally blind to this domain.
- No crisis wiring. A severe screener score gets the calm "worth discussing with a
  clinician" note, never a notification and never the crisis surface.
- No editorial-policy language. "What your intake is", never "you drink too much".

## Refs

#998 and #1078 built the ledger and the curated three. #2380 is the doctrine.
#3144 is the protocol tally the regimen path rides. #3279 records the rulings above.
#3326 built the naming surface and #3327 the quick-log row. #3325 folded case for matching
in this vocabulary and the symptom one at once. #3324 (whether a substance should survive
going to zero) is still open and no surface pre-empts it.
