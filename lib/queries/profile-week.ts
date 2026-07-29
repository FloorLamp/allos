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
// computation (lib/week-window.ts) so the weekly-routine counters, the journal
// week summary, and the weekly recap all agree on which days count (issue #223).
export function weekWindowStart(profileId: number): string {
  return weekWindow(
    today(profileId),
    getWeekMode(profileId),
    getWeekStart(profileId)
  ).start;
}
