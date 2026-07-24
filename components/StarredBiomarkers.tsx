import Link from "next/link";
import { getStarredBiomarkers } from "@/lib/queries";
import {
  rangeBadge,
  RANGE_BADGE_META,
  parseLooseValue,
  isBiomarkerStale,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { convertToCanonical } from "@/lib/unit-conversions";
import {
  getStoredAge,
  getUserBirthdate,
  getUserReproductiveStatus,
  getUserSex,
} from "@/lib/settings";
import { ageFromBirthdate } from "@/lib/date";
import { today } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import BiomarkerScale from "./BiomarkerScale";

// Pinned card of the user's starred biomarkers, shown at the top of /biomarkers
// and on the dashboard. Each tile links to the biomarker detail page and shows
// the latest value, an optimal-status chip (when known), and a sparkline.
// Renders nothing when no biomarkers are starred.
//
// Multi-view (#1331): the starred lens is PER PROFILE (starred_biomarkers is
// name-keyed per profile), so a caregiver viewing several members sees one labeled
// card per member — pass that member's `profileId` + `subjectLabel`. Every range /
// flag / staleness judgment then resolves in THAT member's own demographic context
// (its sex, birthdate/age, reproductive status), never the acting profile's. Default
// (no props) reads the acting profile via requireSession — single-view unchanged.
export default async function StarredBiomarkers({
  title = "Starred biomarkers",
  profileId,
  subjectLabel,
}: {
  title?: string;
  profileId?: number;
  subjectLabel?: string;
}) {
  const pid = profileId ?? (await requireSession()).profile.id;
  const starred = getStarredBiomarkers(pid);
  if (starred.length === 0) return null;
  const sex = getUserSex(pid);
  // Reproductive status (female physiology only) overrides the age proxy for the
  // reproductive-hormone ranges; a profile-level attribute, read once.
  const reproductiveStatus = getUserReproductiveStatus(pid);
  // Age-banded ranges are judged against the subject's age on each reading's own
  // date (not today). Read the birthdate/stored-age once; derive per-tile age.
  const birthdate = getUserBirthdate(pid);
  const storedAge = getStoredAge(pid);
  const ageOn = (date: string | null) =>
    (birthdate && date ? ageFromBirthdate(birthdate, date) : null) ??
    storedAge ??
    null;

  return (
    <div
      className="card mb-6"
      data-testid={
        profileId != null
          ? `starred-biomarkers-${profileId}`
          : "starred-biomarkers"
      }
    >
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        ★ {title}
        {subjectLabel ? (
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {" · "}
            {subjectLabel}
          </span>
        ) : null}{" "}
        <span className="font-normal text-slate-500 dark:text-slate-400">
          ({starred.length})
        </span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {starred.map((b) => {
          // Status from the latest value — exact, or an inexact-but-bounded
          // reading ("<0.10") judged at its limit.
          const latestNum =
            b.latest_value_num ??
            parseLooseValue(b.latest_value)?.value ??
            null;
          const age = ageOn(b.latest_date);
          const badge = rangeBadge(
            convertToCanonical(latestNum, b.latest_unit, b.canonical),
            b.canonical,
            sex,
            age,
            reproductiveStatus
          );
          const meta = RANGE_BADGE_META[badge];
          // Judge staleness on the latest RECORD's category (not the canonical
          // entry's), matching the detail page and table — so a genomics result
          // fires the never-stale rule here too (#381), and an immune-positive
          // durable-immunity titer is exempt on the tile too (#516).
          const stale = isBiomarkerStale(
            b.latest_date,
            b.latest_category,
            today(pid),
            undefined,
            {
              name: b.canonical_name,
              flag: b.latest_flag,
              value: b.latest_value,
              notes: b.latest_notes,
              reference: b.latest_reference_range,
            }
          );
          const ageDays = b.latest_date
            ? daysBetween(b.latest_date, today(pid))
            : null;
          const relative =
            ageDays == null
              ? "no readings"
              : ageDays <= 0
                ? "today"
                : `${humanizeAge(ageDays)} ago`;
          return (
            <Link
              key={b.canonical_name}
              href={`/biomarkers/view?name=${encodeURIComponent(b.canonical_name)}`}
              className="rounded-lg border border-black/5 p-3 transition hover:border-brand-200 hover:shadow-sm dark:border-white/10"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                  {b.canonical_name}
                </span>
                {badge !== "unknown" && (
                  <span className={`badge shrink-0 ${meta.chip}`}>
                    {meta.label}
                  </span>
                )}
              </div>
              <div className="mt-2">
                <BiomarkerScale
                  b={b}
                  sex={sex}
                  age={age}
                  status={reproductiveStatus}
                />
              </div>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {relative}
                {stale && (
                  <span
                    className="ml-1.5 text-amber-600 dark:text-amber-400"
                    title="Over a year old — consider retesting"
                  >
                    · ⏳ stale
                  </span>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
