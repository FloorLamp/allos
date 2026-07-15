"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  RECOMMENDATION_CADENCES,
  CADENCE_LABELS,
  type RecommendationCadence,
} from "@/lib/recommendation-run";
import { saveRecommendationCadence } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// AI recommendation-run cadence (issue #424) — PROFILE-scoped, following the active
// profile, but ADMIN-EDITABLE ONLY (the admin pays for the API key). A member sees
// the current value read-only. Saves on change, mirroring the other profile forms.
export default function RecommendationCadenceForm({
  cadence,
  isAdmin,
}: {
  cadence: RecommendationCadence;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<RecommendationCadence>(cadence);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: RecommendationCadence) {
    const fd = new FormData();
    fd.set("recommendation_cadence", next);
    runSave(async () => {
      await saveRecommendationCadence(fd);
      router.refresh();
    });
  }

  return (
    <div
      className="card max-w-lg space-y-3"
      data-testid="recommendation-cadence-form"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          AI recommendations
        </h2>
        {isAdmin && (
          <SaveStatus pending={pending} savedAt={savedAt} error={error} />
        )}
      </div>

      <div>
        <label className="label" htmlFor="recommendation-cadence">
          Recommendation cadence
        </label>
        <select
          id="recommendation-cadence"
          data-testid="recommendation-cadence"
          className="input"
          value={value}
          disabled={!isAdmin}
          onChange={(e) => {
            const next = e.target.value as RecommendationCadence;
            setValue(next);
            save(next);
          }}
        >
          {RECOMMENDATION_CADENCES.map((c) => (
            <option key={c} value={c}>
              {CADENCE_LABELS[c]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          How often to proactively run AI recommendations (supplement
          suggestions + a refreshed daily insight) for this profile. Scheduled
          runs fire lazily on a page view once the period has elapsed and only
          when the underlying data has changed.{" "}
          {isAdmin
            ? "The per-day ceiling is set on the Server tab."
            : "Admin-editable only — ask an admin to change it."}
        </p>
      </div>
    </div>
  );
}
