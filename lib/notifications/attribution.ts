// Multi-profile message attribution — the "[Name] " title prefix a shared/family
// channel needs so two profiles' otherwise-identical reminders ("💊 Morning
// supplements") stay distinguishable. This is the SINGLE derivation (issue #429)
// the send site and the callback rebuild both draw from, so a rebuild can never
// silently drop the label a shared-chat message was sent with (#377). It lives in
// its own module (not index.ts) so the Telegram channel chokepoint (telegram.ts)
// can own applying it at the edit/rebuild boundary without importing index.ts,
// which would form a cycle (index → telegram → index).

import { db } from "../db";
import { profileMessagePrefix } from "./types";

// The "[Name] " title prefix for a profile's outbound message: label the title
// with the profile's name when the instance tracks more than one profile, else "".
// `profiles` is a global (non-profile-scoped) table, so the count/name reads aren't
// profile-filtered — the same basis as the tick's allProfiles() count.
export function prefixForProfile(profileId: number): string {
  const row = db
    .prepare("SELECT name FROM profiles WHERE id = ?")
    .get(profileId) as { name: string } | undefined;
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM profiles").get() as {
    c: number;
  };
  return profileMessagePrefix(row?.name ?? "", c);
}
