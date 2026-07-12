"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveInstanceTimezone } from "./actions";
import SaveStatus from "@/components/SaveStatus";

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
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);

  const [tzList, setTzList] = useState<string[]>([]);
  useEffect(() => {
    if (typeof (Intl as any).supportedValuesOf === "function") {
      setTzList((Intl as any).supportedValuesOf("timeZone"));
    }
  }, []);
  const zones = tzList.includes(timezone) ? tzList : [timezone, ...tzList];

  function save(tz: string) {
    const fd = new FormData();
    fd.set("timezone", tz);
    startTransition(async () => {
      await saveInstanceTimezone(fd);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Instance-default timezone
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        The timezone a newly created profile starts with, and the fallback for
        any profile that hasn’t set its own. Changing it does not alter existing
        profiles — each has its own timezone on Settings → Profile.
      </p>

      <select
        value={timezone}
        onChange={(e) => {
          const v = e.target.value;
          setTimezone(v);
          save(v);
        }}
        className="input"
      >
        {zones.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    </div>
  );
}
