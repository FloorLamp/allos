// One-time, dismissible discoverability HINTS, stored per LOGIN (login_settings) —
// issue #1327 fix 7. A hint is shown until the login dismisses it, then never again;
// it's login-scoped (not per-profile) because it teaches a login-level capability
// (multi-profile viewing), not a fact about one tracked person. Each hint is a single
// "seen" flag ("1" once dismissed, absent otherwise) — no schema change (login_settings
// is a generic KV store), so #1328's adopters add a hint by adding a key here.

import { getLoginSetting, setLoginSetting } from "./kv";

// The multi-profile viewing hint on Upcoming (#1096/#1327): points a multi-profile
// login at the profile-menu eye toggles. Dismissed once, gone forever.
export const MULTIVIEW_HINT_KEY = "hint_multiview_seen";

export function isMultiviewHintDismissed(loginId: number): boolean {
  return getLoginSetting(loginId, MULTIVIEW_HINT_KEY) === "1";
}

export function dismissMultiviewHint(loginId: number): void {
  setLoginSetting(loginId, MULTIVIEW_HINT_KEY, "1");
}
