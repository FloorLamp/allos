"use client";

import { useEffect } from "react";
import type { EmergencyCard } from "@/lib/emergency-card";
import {
  writeEmergencyPayload,
  clearEmergencyPayload,
} from "@/components/emergency-offline";

// Refreshes (or clears) the offline localStorage copy of the Emergency Card on
// each authenticated visit to /emergency (issue #42). Rendered by the server page
// with the freshly-assembled card when the opt-in is ON, and with a null payload
// when it's OFF — so toggling the feature off, then reopening the card, purges the
// cached copy. Renders nothing.
export default function EmergencyCardCacher({
  profileId,
  card,
}: {
  profileId: number;
  // null = opt-in disabled; clear any previously-cached copy.
  card: EmergencyCard | null;
}) {
  useEffect(() => {
    if (card) writeEmergencyPayload(profileId, card);
    else clearEmergencyPayload();
  }, [profileId, card]);
  return null;
}
