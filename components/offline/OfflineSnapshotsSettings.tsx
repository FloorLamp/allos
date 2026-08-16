"use client";

import { useState } from "react";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import { clearSnapshots } from "@/lib/offline/snapshot-db";
import { saveOfflineSnapshotsEnabled } from "@/app/(app)/settings/profile/actions";

// The per-profile OFF switch for offline reads (#2908, owner decision 1).
//
// It is an off switch rather than an opt-in, unlike the emergency card's, and the
// asymmetry is deliberate: the card is for a stranger who can be told where to look,
// while these are for the person holding their own phone in a clinic waiting room with
// no bars — someone who set nothing up in advance, so an opt-in would serve nobody at
// the moment it matters.
//
// Turning it off WIPES THIS DEVICE IMMEDIATELY (not at the next visit) and stops the
// server building payloads, so nothing re-materializes until it is turned back on.
export default function OfflineSnapshotsSettings({
  enabled: initialEnabled,
}: {
  enabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: boolean) {
    const fd = new FormData();
    fd.set("offline_snapshots", next ? "1" : "0");
    // Wipe first, then persist: if the action fails the device is still clean, which is
    // the safe direction to fail in.
    if (!next) void clearSnapshots();
    runSave(async () => {
      await saveOfflineSnapshotsEnabled(fd);
    });
  }

  return (
    <div className="card space-y-3" data-testid="offline-snapshots-settings">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Offline reading
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          data-testid="offline-snapshots-toggle"
          onChange={(e) => {
            setEnabled(e.target.checked);
            save(e.target.checked);
          }}
        />
        <span>
          Keep today&rsquo;s doses, your medication list, recent training, the
          day&rsquo;s food and this week&rsquo;s practices readable with no
          network.
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            On by default. These are kept on this device so you can read them in
            a dead zone — which also means anyone holding the unlocked phone can
            read them. They&rsquo;re erased when you log out or switch profile.
            Turning this off erases them now.
          </span>
        </span>
      </label>
    </div>
  );
}
