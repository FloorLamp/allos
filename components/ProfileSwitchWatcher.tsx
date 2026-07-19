"use client";

import { useEffect, useRef } from "react";
import { clearEmergencyPayload } from "@/components/emergency-offline";

// Device-local cleanup on a profile switch (issue #600). Mounted ONCE in the (app)
// layout, it watches the session's active profile id and wipes the profile-specific
// device-local state whenever that id changes — so EVERY switch affordance (the
// header switcher, the household card, the household strip, and any future one) is
// covered by construction, instead of each having to hand-mirror the wipe. That
// hand-mirroring is exactly what drifted: the wipe lived only in UserMenu's
// per-button onClick, so switching via a household chip left the previous profile's
// emergency card readable session-free at /offline.
//
// SCOPE — only the emergency card is wiped. The offline write QUEUE is no longer
// wiped on switch: its intents are profile-stamped (issue #599) and replay onto the
// profile they were captured under regardless of the active profile, so wiping them
// would only throw away pending writes for no safety gain. Logout still wipes both
// (UserMenu), since the device is being handed back to the login screen.
//
// The wipe fires only on a CHANGE (never on first mount): a fresh mount already
// reflects the current profile, and the emergency card is re-cached on the next
// Passport (/profile#emergency) visit for whoever is now active.
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
  }, [activeProfileId]);
  return null;
}
