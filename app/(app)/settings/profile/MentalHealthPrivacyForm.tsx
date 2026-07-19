"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveMentalHealthShareFull } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Shared-surface detail for this profile's MENTAL-HEALTH visits (#997). By default a
// mental_health appointment shows only "Medical appointment" on the household strip
// and the family calendar feed — the one kind whose default flips toward privacy.
// This toggle lets the profile owner opt those visits into full shared detail. The
// profile's OWN pages always show full detail regardless. Saves on change.
export default function MentalHealthPrivacyForm({
  shareFull,
}: {
  shareFull: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(shareFull);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: boolean) {
    const fd = new FormData();
    fd.set("mental_health_share_full", next ? "1" : "0");
    runSave(async () => {
      await saveMentalHealthShareFull(fd);
      router.refresh();
    });
  }

  return (
    <div
      className="card max-w-lg space-y-3"
      data-testid="mental-health-privacy-form"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Mental-health visit privacy
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          data-testid="mental-health-share-full"
          onChange={(e) => {
            setOn(e.target.checked);
            save(e.target.checked);
          }}
        />
        <span>
          Show mental-health visits in full detail on shared surfaces (the
          household strip and the family calendar feed).
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Off by default: a mental-health visit shows only “Medical
            appointment” on those shared surfaces, even when other kinds show
            full detail. Your own pages always show the full detail.
          </span>
        </span>
      </label>
    </div>
  );
}
