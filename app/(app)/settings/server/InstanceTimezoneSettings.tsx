"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveInstanceTimezone } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import TimezoneSelect from "@/components/TimezoneSelect";
import { useSaveStatus } from "@/components/useSaveStatus";

// The GLOBAL instance-default timezone: seeds newly created profiles and backs
// up any profile without its own timezone. Admin-only. Per-person timezones are
// set on Settings → Profile.
export default function InstanceTimezoneSettings({
  timezone: initialTimezone,
}: {
  timezone: string;
}) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initialTimezone);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(tz: string) {
    const fd = new FormData();
    fd.set("timezone", tz);
    runSave(async () => {
      await saveInstanceTimezone(fd);
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Instance-default timezone
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The timezone a newly created profile starts with, and the fallback for
        any profile that hasn’t set its own. Changing it does not alter existing
        profiles — each has its own timezone on Settings → Profile.
      </p>

      <TimezoneSelect
        id="instance-timezone"
        value={timezone}
        onTimezoneChange={(nextTimezone) => {
          setTimezone(nextTimezone);
          save(nextTimezone);
        }}
      />
    </div>
  );
}
