"use client";

import { saveInstanceTimezone } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import TimezoneSelect from "@/components/TimezoneSelect";
import { useSaveStatus } from "@/components/useSaveStatus";
import SectionHeading from "@/components/SectionHeading";

// The GLOBAL instance-default timezone: seeds newly created profiles and backs
// up any profile without its own timezone. Admin-only. Per-person timezones are
// set on Settings → Health profile.
export default function InstanceTimezoneSettings({
  timezone: initialTimezone,
}: {
  timezone: string;
}) {
  const {
    status,
    value: timezone,
    save: runSave,
  } = useSaveStatus(initialTimezone);

  function save(tz: string) {
    const fd = new FormData();
    fd.set("timezone", tz);
    runSave(tz, async () => {
      await saveInstanceTimezone(fd);
    });
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeading level={2}>Instance-default timezone</SectionHeading>
        <SaveStatus {...status} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The timezone a newly created profile starts with, and the fallback for
        any profile that hasn’t set its own. Changing it does not alter existing
        profiles — each has its own timezone on Settings → Health profile.
      </p>

      <TimezoneSelect
        id="instance-timezone"
        value={timezone}
        onTimezoneChange={save}
      />
    </div>
  );
}
