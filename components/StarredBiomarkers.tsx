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
export default function StarredBiomarkers({
  title = "Starred biomarkers",
}: {
  title?: string;
}) {
  const { profile } = requireSession();
  const starred = getStarredBiomarkers(profile.id);
  if (starred.length === 0) return null;
  const sex = getUserSex(profile.id);
  // Reproductive status (female physiology only) overrides the age proxy for the
  // reproductive-hormone ranges (#202); a profile-level attribute, read once.
  const reproductiveStatus = getUserReproductiveStatus(profile.id);
  // Age-banded ranges are judged against the subject's age on each reading's own
  // date (not today). Read the birthdate/stored-age once; derive per-tile age.
  const birthdate = getUserBirthdate(profile.id);
  const storedAge = getStoredAge(profile.id);
  const ageOn = (date: string | null) =>
    (birthdate && date ? ageFromBirthdate(birthdate, date) : null) ??
    storedAge ??
    null;

  return (
    <div className="card mb-6">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        ★ {title}{" "}
        <span className="font-normal text-slate-400 dark:text-slate-500">
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
          const stale = isBiomarkerStale(
            b.latest_date,
            b.canonical?.category,
            today(profile.id)
          );
          const ageDays = b.latest_date
            ? daysBetween(b.latest_date, today(profile.id))
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
              <div className="mt-2 text-xs text-slate-400 dark:text-slate-500">
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
