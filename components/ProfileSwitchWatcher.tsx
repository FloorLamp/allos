"use client";

import { useEffect, useRef } from "react";
import { clearEmergencyPayload } from "@/components/emergency-offline";
import { clearSnapshots } from "@/lib/offline/snapshot-db";

// Device-local cleanup on a profile switch (issue #600). Mounted ONCE in the (app)
// layout, it watches the session's active profile id and wipes the profile-specific
// device-local state whenever that id changes — so EVERY switch affordance (the
// header switcher, the household card, the household strip, and any future one) is
// covered by construction, instead of each having to hand-mirror the wipe. That
// hand-mirroring is exactly what drifted: the wipe lived only in the profile menu's
// per-button onClick, so switching via a household chip left the previous profile's
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
