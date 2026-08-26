"use client";

// The travel banner (issue #3263) — the ONE surface that notices you have moved.
//
// SHOWN, NEVER SENT (#3084's sibling). Landing somewhere new is a page surface: the
// banner is here when you open the app and nowhere else. No notification fires about
// a timezone, because nothing about a timezone is urgent enough to reach for
// somebody, and a reminder that arrived to say "your clock changed" would be the
// contact this doctrine exists to refuse.
//
// The detection primitive is the browser's own zone — the same read the Settings
// picker's "Detect from browser" button already makes (components/TimezoneSelect) —
// so there is one answer to "where is this device", not two.

import { useCallback, useEffect, useState } from "react";
import { IconPlaneTilt } from "@tabler/icons-react";
import {
  travelOfferText,
  travelPrompt,
  travelReturnOfferText,
} from "@/lib/travel-timezone";
import {
  acceptTravelTimezone,
  dismissTravelTimezone,
  revertTravelTimezone,
} from "@/app/(app)/travel-actions";

function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export default function TravelTimezoneBanner({
  ownProfile,
  profileZone,
  homeZone,
  dismissedZone,
}: {
  ownProfile: boolean;
  profileZone: string;
  homeZone: string | null;
  dismissedZone: string | null;
}) {
  // Read on the CLIENT only. The server has no device zone to render, and painting
  // a guess would make the first frame disagree with the second.
  const [deviceZone, setDeviceZone] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(dismissedZone);
  const [busy, setBusy] = useState(false);

  // Load AND resume (#3263): a PWA that was backgrounded on the plane is resumed on
  // the ground, and that is the moment the zone has changed.
  useEffect(() => {
    const read = () => setDeviceZone(deviceTimezone());
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", read);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", read);
    };
  }, []);

  const prompt = travelPrompt({
    ownProfile,
    deviceZone,
    profileZone,
    homeZone,
    dismissedZone: dismissed,
  });

  // NO router.refresh() on either path. Both actions end in
  // revalidateRoute("/", "layout"), and a Server Action's response carries the
  // freshly rendered tree — the same way the Settings timezone form has always
  // repainted the app after a zone change. Adding one here would also force this
  // file to declare itself chrome or user in the #1878 registry for a repaint it
  // does not need.
  const accept = useCallback(async () => {
    if (prompt.kind === "none") return;
    setBusy(true);
    const result =
      prompt.kind === "return"
        ? await revertTravelTimezone()
        : await acceptTravelTimezone(prompt.deviceZone);
    // Dismissal is optimistic client state as well as a server setting. The
    // action spends the server copy when a switch lands; spend this mounted copy
    // too, because an RSC update preserves client state across the new props.
    if (result.ok) setDismissed(null);
    setBusy(false);
  }, [prompt]);

  const dismiss = useCallback(async () => {
    if (prompt.kind === "none") return;
    const zone = prompt.kind === "return" ? prompt.homeZone : prompt.deviceZone;
    // Optimistic: the banner is a suggestion, and the one thing "Not now" must
    // always do instantly is go away.
    setDismissed(zone);
    await dismissTravelTimezone(zone);
  }, [prompt]);

  if (prompt.kind === "none") return null;

  const offeredZone =
    prompt.kind === "return" ? prompt.homeZone : prompt.deviceZone;
  const copy =
    prompt.kind === "return"
      ? travelReturnOfferText(prompt.homeZone)
      : travelOfferText(prompt.deviceZone);

  return (
    <div
      data-testid="travel-timezone-banner"
      data-device-zone={offeredZone}
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm dark:border-brand-500/25 dark:bg-brand-500/10"
    >
      <span className="inline-flex items-center gap-2 text-brand-800 dark:text-brand-200">
        <IconPlaneTilt className="h-4 w-4 shrink-0" aria-hidden="true" />
        {copy}
      </span>
      <span className="inline-flex items-center gap-3">
        <button
          type="button"
          data-testid="travel-timezone-accept"
          disabled={busy}
          onClick={() => void accept()}
          className="btn btn-sm"
        >
          {prompt.kind === "return" ? "Move my day back" : "Move my day"}
        </button>
        <button
          type="button"
          data-testid="travel-timezone-dismiss"
          onClick={() => void dismiss()}
          className="inline-flex min-h-11 items-center font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
