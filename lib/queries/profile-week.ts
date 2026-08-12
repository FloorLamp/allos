import { today } from "../db";
import { getWeekMode, getWeekStart } from "../settings";
import { weekWindow } from "../week-window";

// The profile's weekly window, resolved from its stored settings. Domain-neutral:
// training routines, frequency targets, substance-use caps, and the weekly recap
// all ask the same question, so they must all get the same answer.
//
// It lived in lib/queries/training/common.ts until #1637 — which was both a naming
// lie (three of its consumers aren't training) and a load-order hazard: the neutral
// frequency-target reads had to import a training submodule, and training/common
// pulls in the settings→notifications→sleep→activities chain.

// Inclusive start date (YYYY-MM-DD) of a profile's "this week" window: either the
// current calendar week (from the configured week-start day) or a rolling 7-day
// window, per the profile's week_mode. Delegates to the shared `weekWindow`
// computation (lib/week-window.ts) so the weekly-routine counters, the training log
// week summary, and the weekly recap all agree on which days count (issue #223).
export function weekWindowStart(profileId: number): string {
  return weekWindowStartOn(profileId, today(profileId));
}

// The same window resolved around an ARBITRARY day rather than today (#1632). A
// windowed analytics surface can end its range in the past, and "which week does
// this day belong to" is the profile's own question either way — calendar mode
// answers with the week containing it, rolling mode with the trailing 7 days that
// end on it. `weekWindowStart` is this with `today`.
export function weekWindowStartOn(profileId: number, date: string): string {
  return weekWindow(date, getWeekMode(profileId), getWeekStart(profileId))
    .start;
}
