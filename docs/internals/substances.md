# Substances

Consumption is an observation. Keep the ledger neutral; screening instruments
and weekly reduction caps are tools a person chooses. Do not add dosage,
titration, benefit, or legality guidance. No gamification, streaks, badges,
celebration, or crisis wiring: a severe screener result may show its calm
clinician-discussion note, never a notification.

## Event storage and correction

One countable use is one event. Daily totals support counts and caps; they are
not editable substitutes for events.

| Consumption                         | Event ledger                                    | Daily rollup             |
| ----------------------------------- | ----------------------------------------------- | ------------------------ |
| Alcohol                             | `food_log_events`, curated `alcohol` food group | `food_daily_totals`      |
| Nicotine, cannabis, or a custom key | `substance_log_events`                          | `substance_daily_totals` |

Every write updates the event and its counter in one transaction through the
existing ledger core. `substanceDef(key).ledger` chooses the store; custom keys
always use the substance ledger and cannot create nutrition records.

[History](history.md) renders one substance row per use. Alcohol stays a
substance for display and age gating, but carries the food event's correction
payload: `kind` identifies the record, `edit.kind` identifies its editor.
Correct, re-time, re-file, or delete the individual event using
`correctSubstanceEventCore`/`deleteSubstanceEventCore` or the food ledger's
corresponding cores. A substance card's daily row offers whole-day deletion,
not count replacement. The timeline gather's daily substance rollup is
browse-only; it is not the event correction surface.

The dedicated substance event and daily-total datasets are browse/export-only
in Data → Manage. A raw delete in either would split the event/counter pair.
Use the domain's undoable event or day deletion path.

`occurred_at` and `time_source` belong to the event. A stated minute applies to
every unit in one submitted entry; an unstated time remains unknown. Never turn
a counter's `recorded_at` filing stamp into a use instant. The add-history core
appends uses, including when that day already has data.

Notes belong to uses. A multi-unit entry puts its note on the first event only;
each event can later correct or clear its own note. Daily note columns remain
in storage and exports; entry forms and event displays use event notes.
Re-filing an event moves its note with it.

Legacy counters were reconciled by `20260905-substance-event-rows`: derive only
whole missing uses, never double existing taps or round fractions up. Their
instant stays null and their filing stamp comes from the day row, so they can
show “logged HH:MM” without creating a chart tick. `20260905-event-notes` copied
each day note once, preferring the first event with `logged_via IS NULL`, otherwise
the earliest event, and created a timeless event for a noted day with none. Read those shipped migrations
when interpreting legacy records; do not rewrite them.

## Vocabulary

`SubstanceKey` is a curated key (`alcohol`, `nicotine`, `cannabis`) or a profile's
normalized custom name. `lib/substance-use.ts` owns the catalog, units, labels,
normalization, and total `substanceDef()` lookup. Curated units have their own
nouns; custom entries count generic uses. An unknown custom key renders its
name rather than throwing.

A custom name needs no registration table: its ledger rows are its identity.
`getProfileSubstanceKeys()` returns curated defaults plus custom keys with data.
`getLoggedSubstanceKeys()` returns only keys with ledger data, and
`hasLoggedSubstance()` supplies the cheaper shell-level presence check. Removing
the final use and its day row removes a custom key from the offered vocabulary;
do not introduce an independent “delete substance” concept.

Reuse the [identity vocabulary](identity-registry.md): the substance and symptom
resolvers share `matchFoldedVocabulary` and `resolveProfileVocabularyKey`.
Normalize whitespace, preserve display case, and fold only for matching typed
names. The oldest stored spelling wins. Do not duplicate the fold with SQLite
`LOWER` or `NOCASE`, whose matching differs from the shared resolver.

Use `validateProfileSubstanceName` at a typed-name write boundary. The underlying
validation rejects empty or over-60-character normalized names instead of
silently truncating input; `substanceNameError` owns the wording. Avoid an input
`maxLength` that silently clips pasted names. Keys posted back by an existing
row use the bare resolver so an edit cannot move to a case-equivalent neighbor.
Existing differently cased rows retain their own history; do not merge them
implicitly in a migration.

## Episodic uses and regimens

Countable drinks, sessions, or uses belong to the substance event ledger. A
named amount per administration on a cadence belongs to an intake item, with
its existing amount units, interval cadence, and situational holds. Protocols
can use the existing intake-linked N-of-1 tally. Do not add dose columns to the
substance counter or build another regimen engine.

## Optional tools and quick logging

A reduction cap is a `frequency_targets` row with `scope_kind="substance"` and
ceiling semantics. `getSubstanceWeekState` produces `status: null` without a
target; otherwise `substanceCapStatus` supplies the status and `capProgressLine`
formats it. Zero is a real opted-in cap, not absence. Never manufacture a
default cap or send a ceiling through a frequency-floor reader that encourages
more consumption.

Screeners remain behind their own affordance. `lib/substance-use.ts` owns the
instrument definitions, capture modes, citations, and scoring; do not copy
those tables into another guide or surface.

Typing a name and logging its first use creates the same card used by curated
keys. The quick-log sheet offers substances only when the profile has ledger
data, and lists those logged keys rather than the whole vocabulary. It includes
cap progress only where the person set a cap. The gate defaults closed in menu,
segment, and shortcut construction; `loadQuickEntry` also checks data presence
and refuses known minors at the server boundary. The domain's write actions
retain their own subject authorization and age checks.

`LOG_DAY_SOURCES` declares the dedicated substance counter for Consume evidence.
Alcohol already belongs to the food writer's evidence; declaring it again would
give one store two owners.

## Reach

Keep substance records out of share links, emergency cards, and print surfaces
by default. Consent is profile-scoped even when one login's chat serves several
profiles. There is no substance slash-command vocabulary.

| Outbound content                                                         | Consent and owner                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Alcohol food-nudge buttons and tally                                     | `food_telegram_enabled` / `getProfileFoodTelegram`, like other food groups          |
| Non-alcohol substance cap lines in Telegram, Web Push, and Email recaps  | `substance_telegram_enabled`, off by default; `gatherRecapInput(..., forSend=true)` |
| One paired alcohol-observation line in an existing morning Sleep section | `substance_telegram_enabled`; digest gather checks consent before computing it      |

Alcohol caps follow the food-ledger exception in recap filtering. For other
substances, gate both the current-week cap verdict and the period's cap-weeks
line. Stored AI recap narratives gather with `forSend: true` because their prose
can leave the app. In-app deterministic recap cards and year retrospectives
retain the profile's own cap facts.

Remove withheld content rather than redacting it. `renderRecapMessage` sends
nothing when the recap is empty **or has no lines**; a gated cap can be the
only line even when other recorded evidence makes `isEmpty` false. Do not send
an empty shell.

The digest exception covers only the paired `alcohol-*` observations, at most
one line in registry order, above the pair's effect floor and honoring its
monthly dismissal. Use the existing verdict sentence with both sample counts
and no advice. It cannot create a digest or a standalone send. No other
substance or cap finding gains a finding-driven notification from this exception.

Consent controls what leaves the app, not the write core: correcting a food
burst must still update every event in that burst. Medication interaction copy
such as “avoid alcohol” describes a medication and is not disclosure of a
profile's drinking record.

## Verification

Reuse the substance-use and food/substance-correction tests for event/counter
writes, vocabulary-fold tests for identity, and the existing migration tests for
legacy rows. `food-nudge-substance-optin.test.ts` and
`recap-substance-optin.test.ts` exercise rendered outbound content and consent;
check the final message, not just one intermediate field. Follow the
[change and test policy](../change-policy.md).
