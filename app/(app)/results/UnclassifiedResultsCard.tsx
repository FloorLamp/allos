"use client";

import Link from "next/link";
import { useState } from "react";
import { classifyResultCategory } from "./clinical-result-actions";
import { ASSIGNABLE_MEDICAL_CATEGORIES } from "@/lib/medical-categories";
import type { UnclassifiedClinicalObservation } from "@/lib/queries";
import { useToast } from "@/components/Toast";
import { displayUnit } from "@/lib/display-unit";
import SubmitButton from "@/components/SubmitButton";

export type UnclassifiedResultRow = UnclassifiedClinicalObservation & {
  subjectLabel?: string;
  canWrite: boolean;
};

function displayResultValue(row: UnclassifiedResultRow): string | null {
  if (!row.value) return null;
  const unit = displayUnit(row.unit);
  return `${row.value}${unit ? ` ${unit}` : ""}`;
}

export default function UnclassifiedResultsCard({
  rows,
}: {
  rows: UnclassifiedResultRow[];
}) {
  const toast = useToast();
  const [resolved, setResolved] = useState(() => new Set<number>());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const visible = rows.filter((row) => !resolved.has(row.id));
  if (visible.length === 0) return null;

  async function classify(row: UnclassifiedResultRow, formData: FormData) {
    const result = await classifyResultCategory(formData);
    if (!result.ok) {
      setErrors((current) => ({ ...current, [row.id]: result.error }));
      return;
    }
    setResolved((current) => new Set(current).add(row.id));
    toast("Category saved");
  }

  return (
    <section className="card" data-testid="unclassified-results-card">
      <h2 className="text-lg font-semibold">Choose a category</h2>
      <p className="mt-1 text-sm text-muted">
        These older results used a category that no longer exists. Choose what
        each result is; Allos won’t guess.
      </p>
      <div className="mt-4 divide-y divide-black/5 dark:divide-white/10">
        {visible.map((row) => (
          <div key={row.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <strong>{row.canonical_name?.trim() || row.name}</strong>
              <span className="text-sm text-muted">{row.date}</span>
              {row.subjectLabel && (
                <span className="text-sm text-muted">{row.subjectLabel}</span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {[displayResultValue(row), row.provider_name, row.source]
                .filter(Boolean)
                .join(" · ") || "No additional context"}
            </p>
            {row.document_id != null && (
              <Link
                className="mt-1 inline-block text-sm link"
                href={`/import/${row.document_id}`}
              >
                View source document
              </Link>
            )}
            {row.canWrite ? (
              <form
                action={(formData) => classify(row, formData)}
                className="mt-3 flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="id" value={row.id} />
                <input type="hidden" name="profile_id" value={row.profile_id} />
                <label className="min-w-48 text-sm">
                  <span className="label">Category</span>
                  <select
                    className="input"
                    name="category"
                    defaultValue=""
                    required
                  >
                    <option value="">Choose category</option>
                    {ASSIGNABLE_MEDICAL_CATEGORIES.map((category) => (
                      <option
                        key={category}
                        value={category}
                        className="capitalize"
                      >
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton>Save</SubmitButton>
              </form>
            ) : (
              <p className="mt-2 text-sm text-muted">
                You have read-only access to this profile.
              </p>
            )}
            {errors[row.id] && (
              <p className="mt-2 text-sm text-danger" role="alert">
                {errors[row.id]}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
