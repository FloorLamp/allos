"use client";

import { useEffect, useRef } from "react";
import { markWhatsNewSeenAction } from "@/app/(app)/whats-new/actions";

// Fires the "seen" write once when the /whats-new page mounts (issue #1421) —
// visiting the page IS the dismissal, so there is no button to press.
//
// Why a client effect rather than the server component writing during render: the
// action revalidates the layout (that's how the unread dot clears), and revalidating
// during render is not allowed. Renders nothing.
//
// Only mounted when there is something unseen, so a repeat visit does no write at
// all; the ref makes it once-per-mount even if the tree re-renders after the
// revalidation lands.
export default function MarkWhatsNewSeen() {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // Fire-and-forget: the marker is a convenience, and a failed write just means
    // the dot survives until the next visit.
    void markWhatsNewSeenAction().catch(() => {});
  }, []);

  return null;
}
