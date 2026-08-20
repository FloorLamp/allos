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

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlaneTilt, IconX } from "@tabler/icons-react";
import {
  travelOfferText,
  travelPrompt,
  travelReturnText,
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
  const router = useRouter();
  // Read on the CLIENT only. The server has no device zone to render, and painting
  // a guess would make the first frame disagree with the second.
  const [deviceZone, setDeviceZone] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(dismissedZone);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One revert in flight at a time. The effect below re-runs on every resume and on
  // the refresh the revert itself triggers, and a second call would move a day the
  // first one already moved.
  const reverting = useRef(false);

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

  // The return leg runs ITSELF and tells afterwards (#2471): the switch is lossless
  // and it reverses a state the person explicitly entered, so a confirmation would
  // protect nothing and cost them a tap on the day they get home.
  useEffect(() => {
    if (prompt.kind !== "return" || reverting.current) return;
    reverting.current = true;
    void (async () => {
      const result = await revertTravelTimezone();
      if (result.ok && result.homeZone && result.awayZone) {
        setNotice(travelReturnText(result.homeZone, result.awayZone));
        router.refresh();
      }
      reverting.current = false;
    })();
  }, [prompt, router]);

  const accept = useCallback(async () => {
    if (prompt.kind !== "offer") return;
    setBusy(true);
    const result = await acceptTravelTimezone(prompt.deviceZone);
    setBusy(false);
    if (result.ok) router.refresh();
  }, [prompt, router]);

  const dismiss = useCallback(async () => {
    if (prompt.kind !== "offer") return;
    const zone = prompt.deviceZone;
    // Optimistic: the banner is a suggestion, and the one thing "Not now" must
    // always do instantly is go away.
    setDismissed(zone);
    await dismissTravelTimezone(zone);
  }, [prompt]);

  if (notice) {
    return (
      <div
        data-testid="travel-timezone-notice"
        className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/10 bg-(--card) px-4 py-3 text-sm dark:border-white/10"
      >
        <span className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
          <IconPlaneTilt className="h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </span>
        <button
          type="button"
          onClick={() => setNotice(null)}
          className="inline-flex items-center gap-1 font-medium text-slate-600 hover:underline dark:text-slate-300"
          aria-label="Dismiss"
        >
          <IconX className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (prompt.kind !== "offer") return null;

  return (
    <div
      data-testid="travel-timezone-banner"
      data-device-zone={prompt.deviceZone}
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm dark:border-brand-500/25 dark:bg-brand-500/10"
    >
      <span className="inline-flex items-center gap-2 text-brand-800 dark:text-brand-200">
        <IconPlaneTilt className="h-4 w-4 shrink-0" aria-hidden="true" />
        {travelOfferText(prompt.deviceZone)}
      </span>
      <span className="inline-flex items-center gap-3">
        <button
          type="button"
          data-testid="travel-timezone-accept"
          disabled={busy}
          onClick={() => void accept()}
          className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60 dark:bg-brand-500 dark:hover:bg-brand-400 dark:text-brand-950"
        >
          Move my day
        </button>
        <button
          type="button"
          data-testid="travel-timezone-dismiss"
          onClick={() => void dismiss()}
          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Not now
        </button>
      </span>
    </div>
  );
}
