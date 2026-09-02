import Link from "next/link";
import SubjectChip from "@/components/SubjectChip";
import { subjectChipVisible } from "@/lib/multi-view";
import { formatDateWithYear, type DisplayFormatPrefs } from "@/lib/format-date";
import type { SubjectInfo } from "@/lib/scope";
import type { SpecialtyLensEntry } from "@/lib/queries/specialty-lens";
import {
  SPECIALTY_LINE_HISTORY_TITLE,
  type SpecialtyLine,
} from "@/lib/specialty-lens";

// The care-history strip every anatomical Specialty pane carries below its
// structured table (#2921). The pane's own records stay on top — this is the
// service line's VISITS and coded CONDITIONS, grouped by the read-side lens
// (lib/specialty-lens.ts) and each row deep-linked to the surface that owns it.
//
// INFORMATIONAL GROUPING, the #662 posture: the rows are here because a visit was
// with an eye clinician or a diagnosis is coded to the eye, not because the app
// claims one caused the other. Nothing here is editable and nothing writes — a
// record gains a real link only through #1050's suggest-and-accept.
//
// Renders NOTHING when the lens is empty, so an ungated pane (Skin, Hearing) is
// unchanged for a profile with no classified care.

// A strip row: a lens entry plus the profile it belongs to, and — on the two panes
// that read the whole view set — the stamped subject. Skin and Hearing list the
// ACTING profile only (their structured records do too), so they carry no subject
// and the chip rule never fires for them.
export type SpecialtyStripEntry = SpecialtyLensEntry & {
  profileId: number;
  subject?: SubjectInfo;
};

export default function SpecialtyHistoryStrip({
  line,
  entries,
  formatPrefs,
  actingProfileId,
}: {
  line: SpecialtyLine;
  entries: SpecialtyStripEntry[];
  formatPrefs?: DisplayFormatPrefs;
  // Present only in a multi-profile view — the chip rule's `multi` half.
  actingProfileId?: number;
}) {
  if (entries.length === 0) return null;

  return (
    <section
      className="border-t border-black/5 pt-5 dark:border-white/5"
      data-testid={`specialty-history-${line}`}
    >
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {SPECIALTY_LINE_HISTORY_TITLE[line]}
      </h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Visits and diagnoses in this area of care.
      </p>
      <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
        {entries.map((e) => (
          <li
            key={`${e.kind}-${e.profileId}-${e.id}`}
            className="flex items-start justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="section-label mb-1 block">
                {e.kind === "visit" ? "Visit" : "Diagnosis"}
              </span>
              <Link
                href={e.href}
                className="text-slate-800 hover:underline dark:text-slate-100"
              >
                {e.label}
              </Link>
              {e.detail ? (
                <span className="ml-2 text-slate-500 dark:text-slate-400">
                  {e.detail}
                </span>
              ) : null}
              {actingProfileId != null &&
              e.subject &&
              subjectChipVisible({
                multi: true,
                isActing: e.profileId === actingProfileId,
              }) ? (
                <span className="ml-2 align-middle">
                  <SubjectChip subject={e.subject} />
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {e.date ? formatDateWithYear(e.date, formatPrefs) : "Undated"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
