# Substances

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
