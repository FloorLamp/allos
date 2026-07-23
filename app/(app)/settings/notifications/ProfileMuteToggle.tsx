"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveProfileNotifyMute } from "../actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Per-(login, profile) mute (issue #1072): "don't notify ME about this profile".
// Login-scoped — muting affects only the signed-in login's own fan-out, never the
// other logins that manage the same profile. Safety-tier reminders are muted too
// when this is on, so it's off by default and clearly worded.
export default function ProfileMuteToggle({
  profileId,
  profileName,
  muted,
}: {
  profileId: number;
  profileName: string;
  muted: boolean;
}) {
  const router = useRouter();
  const [isMuted, setIsMuted] = useState(muted);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function toggle(next: boolean) {
    setIsMuted(next);
    runSave(async () => {
      const fd = new FormData();
      fd.set("profile_id", String(profileId));
      fd.set("muted", next ? "1" : "0");
      await saveProfileNotifyMute(fd);
      router.refresh();
    });
  }

  return (
    <div id="profile-mute" className="card mt-6 max-w-lg space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Mute {profileName} for me
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={isMuted}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4 accent-brand-600"
          data-testid="profile-notify-mute"
        />
        Don’t send me notifications about {profileName}
      </label>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Silences every channel you receive for this profile — including safety
        reminders like missed-dose escalation. Only affects your login; other
        caregivers still get their notifications.
      </p>
    </div>
  );
}
