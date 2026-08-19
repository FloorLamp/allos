"use client";

import { useEffect, useRef } from "react";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { clearSnapshots } from "@/lib/offline/snapshot-db";

// Device-local cleanup on a profile switch (issue #600). Mounted ONCE in the (app)
// layout, it watches the session's active profile id and wipes the profile-specific
// device-local state whenever that id changes — so EVERY switch affordance (the
// header switcher, the household card, and any future one) is
// covered by construction, instead of each having to hand-mirror the wipe. That
// hand-mirroring is exactly what drifted: the wipe lived only in the profile menu's
// per-button onClick, so switching outside the profile menu left the previous profile's
// emergency card readable session-free at /offline.
//
// SCOPE — the emergency card and the offline READ SNAPSHOTS (#2908). Both are
// profile-owned reads that outlive the request and render session-free at /offline, so
// both must go the instant the active profile changes: a snapshot surviving a switch
// would put one person's med list and dose schedule under another person's name, which
// is the worst defect this feature can have. The offline write QUEUE is deliberately
// NOT wiped on switch: its intents are profile-stamped (issue #599) and replay onto the
// profile they were captured under regardless of the active profile, so wiping them
// would only throw away pending writes for no safety gain. That asymmetry is the point
// — a queued WRITE carries its own attribution to the server, while a cached READ is
// only as safe as the moment it is shown. Logout wipes all three (the sidebar logout),
// since the device is being handed back to the login screen.
//
// The wipe fires only on a CHANGE (never on first mount): a fresh mount already
// reflects the current profile, and both the emergency card and the snapshots are
// re-captured on the next authenticated visit for whoever is now active.
//
// WHY THIS WIPE NEEDS NO RACE WITH THE REFRESHER, AND LOGOUT'S DOES — the asymmetry is
// load-bearing, and it is WHEN each wipe fires relative to the identity change:
//
//   • HERE the wipe fires at the END of the transition. `activeProfileId` is the
//     session's already-switched profile, re-rendered from the server, so every write
//     the previous profile's refresh could still have in flight was fetched BEFORE this
//     ran and is a write this wipe lands on top of. Last writer wins, and this is last.
//   • AT LOGOUT the wipe fires at the BEGINNING. components/SidebarContent wipes and
//     THEN submits the logout, and the page stays mounted and alive for the entire
//     round trip — so a refresh in flight when the button was pressed resolves AFTER
//     the wipe and re-writes the payload into the cleared store. First writer wipes,
//     second writer restores.
//
// That is why the fence in lib/offline/snapshot-db.ts exists, and why "the wipe is
// covered by construction" is true of this component in a way it was not of logout.
// The fence covers both regardless: `clearSnapshots` bumps the generation, so a
// pre-switch refresh that somehow outlived the transition is dropped here too.
export default function ProfileSwitchWatcher({
  activeProfileId,
}: {
  activeProfileId: number;
}) {
  const previous = useRef(activeProfileId);
  useEffect(() => {
    if (previous.current === activeProfileId) return;
    previous.current = activeProfileId;
    clearEmergencyPayload();
    void clearSnapshots();
  }, [activeProfileId]);
  return null;
}
