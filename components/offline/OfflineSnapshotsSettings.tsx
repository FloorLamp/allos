"use client";

import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import {
  disableSnapshotWrites,
  enableSnapshotWrites,
} from "@/lib/offline/snapshot-db";
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
  const {
    status,
    value: enabled,
    save: runSave,
  } = useSaveStatus(initialEnabled);

  function save(next: boolean) {
    const fd = new FormData();
    fd.set("offline_snapshots", next ? "1" : "0");
    // Wipe first, then persist: if the action fails the device is still clean, which is
    // the safe direction to fail in.
    //
    // AND CLOSE THE LANE, which is the part a synchronous wipe cannot do. Turning the
    // switch off starts a Server Action; until it lands, the server still answers
    // `enabled: true`. A snapshot refresh starting anywhere in that window — a navigation
    // is one of its own triggers — read the empty store, concluded every kind was
    // missing, asked, and was told yes. Every payload came back. The close is persisted
    // in the database beside the data (lib/offline/write-gate.ts), so it also holds
    // across a reload and across a second tab, and it is what makes #2908's "nothing
    // re-materializes until toggled back on" true rather than intended.
    void (next ? enableSnapshotWrites() : disableSnapshotWrites());
    runSave(next, async () => {
      try {
        await saveOfflineSnapshotsEnabled(fd);
      } finally {
        // AND RELEASE IT ONCE THE SERVER IS THE OFF SWITCH. The close above covers one
        // window — this action's flight — and it must not outlive it. Persisted with no
        // path back except this device's own toggle being ticked ON again, it became a
        // one-way latch per device: the refresher asks the gate before it asks the
        // server, so a latched device could never hear `enabled: true` from a profile
        // turned back on ANYWHERE, including from this same account on the phone in the
        // other pocket. The checkbox is server-driven, so it rendered ON while the device
        // held nothing, permanently and silently — the same "silent, permanent death of
        // offline reads" the logout direction has a test named for.
        //
        // After this the server answers every refresh, and an `enabled: false` answer
        // wipes without re-latching, so nothing re-materialises and nothing is stranded.
        // `finally` rather than the success path: if the action FAILED the setting did
        // not change, the server still says on, and re-capturing is the truth — the save
        // error beside the checkbox is what tells the person their choice did not stick.
        await enableSnapshotWrites();
      }
    });
  }

  return (
    <div className="card space-y-3" data-testid="offline-snapshots-settings">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Offline reading
        </h2>
        <SaveStatus {...status} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          data-testid="offline-snapshots-toggle"
          onChange={(e) => save(e.target.checked)}
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
