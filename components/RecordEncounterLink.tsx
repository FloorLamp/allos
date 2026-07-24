"use client";

import Link from "next/link";
import { encounterHref } from "@/lib/hrefs";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { LinkedEncounterRef } from "@/lib/queries";

// Shared per-row "Performed at / Diagnosed at: <visit>" sub-line (issue #1355): the
// records-surface reflection of a row's linked encounter (encounterForRecord /
// encountersForRecords). One component so procedures, conditions, and imaging render
// the visit reference identically — a deep-link to the visit detail whose label is the
// visit type, its provider (context, inside the visit link), and its date. Absent-pillar:
// the caller omits it entirely when the row carries no linked encounter.
export default function RecordEncounterLink({
  label,
  encounter,
  testid,
}: {
  label: string;
  encounter: LinkedEncounterRef;
  testid?: string;
}) {
  const fmt = useFormatPrefs();
  const parts = [
    encounter.type?.trim() || "Visit",
    encounter.providerName?.trim() || null,
    formatRecordDate(encounter.date, "", fmt) || null,
  ].filter(Boolean);
  return (
    <div
      className="mt-0.5 text-xs font-normal text-slate-500 dark:text-slate-400"
      data-testid={testid}
    >
      {label}:{" "}
      <Link
        href={encounterHref(encounter.id)}
        className="underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:decoration-slate-600 dark:hover:text-slate-200"
      >
        {parts.join(" · ")}
      </Link>
    </div>
  );
}
