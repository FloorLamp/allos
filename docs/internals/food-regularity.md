# Food regularity

Food regularity supplies the food members of a usual-routine logging shortcut and
food-habit sentences in the monthly recap. It describes logged behavior; it does
not create targets, streaks, deviation notices, or additional notifications.

Use the [change and test policy](../change-policy.md) when changing this contract.

## Measures and thresholds

[food-regularity.ts](../../lib/food-regularity.ts) is pure: callers provide dated
events and the reference day or period. Repeated servings on one day count once.

| Measure                | Denominator                                                                                | Result                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `foodRegularity`       | Days with any eligible entry in each meal window, within the trailing span including today | Per-window `observedDays` and each group's distinct days and share |
| `foodPeriodRegularity` | Days with any food-group entry in the inclusive `[from, to]` period                        | One day-grain measure across all windows                           |

An unlogged window contributes to neither numerator nor denominator. It provides
no evidence about what someone ate. Do not sum window measures to produce the
period measure: a group logged in several windows on one day is still one day.

| Constant                          | Value | Purpose                                                   |
| --------------------------------- | ----- | --------------------------------------------------------- |
| `FOOD_REGULARITY_SPAN_DAYS`       | 21    | Three complete weeks of window evidence                   |
| `FOOD_REGULARITY_MIN_WINDOW_DAYS` | 7     | Minimum observed days for either measure                  |
| `FOOD_REGULARITY_HABITUAL_SHARE`  | 0.6   | Window share needed for a shortcut member                 |
| `FOOD_USUAL_MIN_GROUPS`           | 2     | Minimum remaining members for a food offer                |
| `FOOD_PERIOD_HABIT_MIN_SHARE`     | 0.25  | Period share needed for a recap habit                     |
| `USUAL_BACKFILL_WINDOW_DAYS`      | 6     | Maximum days before the profile's today for a usual write |

Below the observation gate, the measure is `null`. Consumers render no expectation
or insufficient-data notice. The shortcut's higher share threshold reflects its
role in preparing a write; the recap only reports recorded frequency.

## Evidence and exclusions

The profile-scoped readers live in
[nutrition.ts](../../lib/queries/nutrition.ts):

- `getFoodRegularity` reads recent `food_log_events`. `foodEventWindow` in
  [food-slot-count.ts](../../lib/food-slot-count.ts) resolves declared windows,
  stated eating times, and legacy capture stamps consistently with other readers.
  Catalog food groups and the reserved protein key can be window evidence.
- `getFoodPeriodHabits` reads `food_daily_totals` over the requested period. It
  includes actual food groups; protein is not a food-group recap habit.
- `getCapDirectionFoodGroups` excludes alcohol unconditionally and groups named by
  cap-direction targets from both offers and recap observations. The catalog's
  `limit` tier alone does not exclude a group. Cap reporting belongs to the
  [cadence ledger](cadence-ledger.md) and requires the user's target.

The window reader excludes `USUAL_BACKFILL` provenance so bulk backfills cannot
manufacture evidence for their next offer. Its SQL uses `logged_via IS NOT ?` to
retain legacy rows with null provenance. Other readers retain these recorded
servings, including day totals, rankings, and period food-habit reporting.

## The standing offer

The food shortcut offers one serving of each remaining food group.
`habitualFoodGroups` applies the window share threshold and exclusions.
`usualFoodOffer` subtracts members already logged in the selected window and day;
fewer than two remaining members produces `[]` and no food offer. Undoing entries
can restore the offer without dismissal state.

`getUsualFoodOffer(profileId, window, date)` assembles that rule's inputs from
current server state. Its habit evidence remains anchored on the profile's today;
its already-logged check uses the selected day. Protein already logged in that
window also removes the reserved protein member.

The Nutrition bar and dashboard use the shared usual-routine composition. Its
rendered phrase names the promised food, protein, and dose members. The user's tap
initiates the write. Telegram can attach the same composition to a message already
being sent; the measure does not originate that contact. Window shares and span
lengths are not a separate insight card.

[usual-routine.ts](../../lib/usual-routine.ts),
[queries/usual-routine.ts](../../lib/queries/usual-routine.ts), and
[usual-routine-write.ts](../../lib/usual-routine-write.ts) own composition and
member outcomes. Keep dose and protein write rules there. The food core skips the
reserved protein key; the composed writer uses the existing protein-grams path.

## Dates and writes

The web entry point is `logUsualRoutine` in
[app actions](<../../app/(app)/actions.ts>). It requires write access, validates the
submission, and passes the authorized profile to the auth-blind core. The core's
`date` argument is required. `isUsualBackfillDateAccepted` accepts today through six
days earlier, inclusive; future dates and older dates return `invalid-date`.

The core chooses provenance from the requested day. Today's entries retain their
surface provenance; earlier entries receive `USUAL_BACKFILL`, regardless of the
submitted surface. Each food serving declares its meal window and leaves the
eating instant unstated. Do not invent an eating time from the tap time.

[logUsualFoodCore](../../lib/food-usual-write.ts) re-derives the standing offer in
an immediate write transaction. Submitted group names are an upper bound: it
writes their intersection with the fresh offer, in submitted order. It logs food
through `logFoodServingCore`, preserving the shared counter and event-ledger path.
A stale offer with no remaining intersection returns `nothing-to-log`.

Atomicity applies to the food group set. A serving refusal after writing begins
must throw `UsualFoodRefused` so the transaction rolls back; returning an outcome
would commit earlier servings. The sentinel becomes `nothing-to-log` outside the
transaction. Unexpected faults propagate. An empty-set return before any write is
safe. Do not extend this food transaction guarantee to the composed dose and
protein operations, which have their own outcomes.

`food-usual` and `routine-usual` are idempotent, outcome-toast affordances in
[one-tap.ts](../../lib/one-tap.ts). Their shortcuts are excluded from the
[offline queue](../../lib/offline/queue.ts): a saved member list lacks a current
server offer, and the underlying serving counter is additive. Individual serving
and dose controls retain their own queue behavior.

## Monthly observation

[food-habit-observation.ts](../../lib/food-habit-observation.ts) names up to three
eligible groups, with up to two curated nutrient labels per group. Groups without
a nutrient rationale are omitted. An observation contains a group, recorded day
count, logged-day denominator, and nutrient rationale; it has no biomarker,
reading, flag, or direction field.

Use the food catalog's nutrient links and the nutrient map's labels. Do not join a
person's food pattern to their biomarkers or infer a diagnosis. State the logged
denominator, such as “12 of 26 logged days.” This is a share, not a consecutive run
or comparison with a previous period.

[recap-data.ts](../../lib/notifications/recap-data.ts) gathers these observations;
[recap.ts](../../lib/recap.ts) renders the `food-habits` line within an already
configured periodic send. Regularity adds no send, finding, duty, or missed-habit
warning.

## Verification

Existing coverage owns the relevant failures:

- `lib/__tests__/food-regularity.test.ts` and
  `food-habit-observation.test.ts`: measures, thresholds, date bounds, exclusions,
  and observation wording.
- `lib/__db_tests__/food-regularity.test.ts`: real gathers, offer reduction,
  backfill evidence exclusion, and rollback of both counters and events.
- `lib/__db_tests__/recap-targets-and-habits.test.ts`: recap integration.
- `lib/__action_tests__/food-usual.actions.test.ts` and
  `usual-routine.actions.test.ts`: authorized action and composition behavior.
- `e2e/food-slot-ranking.spec.ts`: the rendered food-window flow.
