"use client";

import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import {
  CATALOG,
  expandToComponents,
  vaccineDisplayName,
  vaccineDescription,
  scheduleSummary,
  type VaccineEntry,
  type VaccineGroup,
} from "@/lib/immunization-catalog";
import {
  SEASONAL_MIN_MONTHS,
  type VaccineAssessment,
} from "@/lib/immunization-status";

// CDC-style schedule grid: vaccines down the side, life-stage age bands across
// the top. A cell is tinted when the vaccine has a recommended dose in that band
// and shows a check when a matching dose was recorded (combination shots expand
// to their components first, so one Vaxelis dose ticks four rows). The current-age
// column is highlighted, rows highlight on hover, and a custom tooltip shows the
// dose date/brand for recorded cells and the recommendation for recommended ones.
// Hand-rolled (no timeline lib) and horizontally scrollable on narrow screens.

interface Band {
  label: string;
  minM: number;
  maxM: number; // half-open [minM, maxM)
}

const BANDS: Band[] = [
  { label: "Birth", minM: 0, maxM: 1 },
  { label: "2m", minM: 1, maxM: 3 },
  { label: "4m", minM: 3, maxM: 5 },
  { label: "6m", minM: 5, maxM: 9 },
  { label: "12m", minM: 9, maxM: 14 },
  { label: "15–18m", minM: 14, maxM: 24 },
  { label: "2–3y", minM: 24, maxM: 48 },
  { label: "4–6y", minM: 48, maxM: 84 },
  { label: "7–10y", minM: 84, maxM: 132 },
  { label: "11–12y", minM: 132, maxM: 168 },
  { label: "13–15y", minM: 168, maxM: 192 },
  { label: "16–18y", minM: 192, maxM: 228 },
  { label: "19–49y", minM: 228, maxM: 600 },
  { label: "50–64y", minM: 600, maxM: 780 },
  { label: "65y+", minM: 780, maxM: 1_000_000 },
];

function bandIndex(months: number): number {
  const i = BANDS.findIndex((b) => months >= b.minM && months < b.maxM);
  return i === -1 ? BANDS.length - 1 : i;
}

// The age bands where this vaccine has a recommended dose (from its schedule).
function recommendedBands(entry: VaccineEntry): Set<number> {
  const s = entry.schedule;
  const out = new Set<number>();
  if (s.kind === "series")
    for (const d of s.doses) out.add(bandIndex(d.recommendedMonths));
  else if (s.kind === "booster") {
    const start = bandIndex(s.startAgeYears * 12);
    for (let i = start; i < BANDS.length; i++) out.add(i);
  } else if (s.kind === "one_time") {
    // Tint the whole routine window [startAgeYears, endAgeYears], matching the
    // engine's due-through-endAge assessment — not just the start band. An
    // open-ended window (no endAgeYears, e.g. Zoster ≥50) runs to the last band.
    const start = bandIndex(s.startAgeYears * 12);
    const end =
      s.endAgeYears != null ? bandIndex(s.endAgeYears * 12) : BANDS.length - 1;
    for (let i = start; i <= end; i++) out.add(i);
  } else if (s.kind === "annual") {
    // Recommended from SEASONAL_MIN_MONTHS onward (the engine flags flu/COVID
    // not-recommended below 6 months) — so don't tint the infant bands.
    for (let i = 0; i < BANDS.length; i++)
      if (BANDS[i].maxM > SEASONAL_MIN_MONTHS) out.add(i);
  }
  return out;
}

// Human recommendation for a given band, or null if none is recommended there.
function recommendationForBand(entry: VaccineEntry, i: number): string | null {
  const s = entry.schedule;
  if (!recommendedBands(entry).has(i)) return null;
  if (s.kind === "series") {
    const labels = s.doses
      .filter((d) => bandIndex(d.recommendedMonths) === i)
      .map((d) => d.label);
    return labels.length
      ? `Recommended dose: ${labels.join(", ")}`
      : "Recommended";
  }
  if (s.kind === "booster")
    return `Booster every ${s.intervalYears} y (from age ${s.startAgeYears})`;
  if (s.kind === "one_time")
    return `Recommended once, from age ${s.startAgeYears}${
      s.endAgeYears ? `–${s.endAgeYears}` : ""
    }`;
  if (s.kind === "annual") return "Recommended every year";
  return "Recommended";
}

// The series dose that falls in a given band, as "Dose 2 of 4". Only
// primary series have a numbered position; other schedule kinds return null.
function doseOfLabel(entry: VaccineEntry, i: number): string | null {
  const s = entry.schedule;
  if (s.kind !== "series") return null;
  const idx = s.doses.findIndex((d) => bandIndex(d.recommendedMonths) === i);
  if (idx === -1) return null;
  return `Dose ${idx + 1} of ${s.doses.length}`;
}

const GROUP_LABELS: Record<VaccineGroup, string> = {
  routine_child: "Childhood & adolescent",
  routine_adult: "Adult",
  seasonal: "Seasonal",
  risk_based: "Risk-based",
  travel: "Travel & other",
};
const GROUP_ORDER: VaccineGroup[] = [
  "routine_child",
  "routine_adult",
  "seasonal",
  "risk_based",
  "travel",
];

const STATUS_DOT: Record<string, string> = {
  complete: "bg-emerald-500",
  up_to_date: "bg-brand-500",
  due: "bg-amber-500",
  overdue: "bg-rose-500",
  unknown: "bg-slate-400",
  not_recommended: "bg-slate-300 dark:bg-slate-600",
};

interface DoseInfo {
  date: string;
  via: string | null; // combo brand, when the dose came from a combination shot
  notes: string | null;
  dose_label: string | null; // the recorded dose/label, when the user entered one
}
interface TipContent {
  title: string;
  lines: string[];
}
interface GridRecord {
  vaccine: string;
  date: string;
  dose_label: string | null;
  notes: string | null;
  source: string | null;
}

export default function ScheduleGrid({
  records,
  birthdate,
  ageMonths,
  assessments,
}: {
  records: GridRecord[];
  birthdate: string | null;
  ageMonths: number | null;
  assessments: VaccineAssessment[];
}) {
  const [tip, setTip] = useState<{
    c: TipContent;
    x: number;
    y: number;
  } | null>(null);
  const [hoverCode, setHoverCode] = useState<string | null>(null);

  const currentBand = ageMonths == null ? null : bandIndex(ageMonths);

  // Recorded doses per component code → band → the doses in it (with date/brand),
  // both for the ✓ marker and the tooltip.
  const bandDoses = new Map<string, Map<number, DoseInfo[]>>();
  if (birthdate) {
    for (const r of records) {
      const ageAt = ageInMonthsFromBirthdate(birthdate, r.date);
      if (ageAt == null) continue;
      const bi = bandIndex(ageAt);
      const comps = expandToComponents(r.vaccine);
      const via = comps.length > 1 ? vaccineDisplayName(r.vaccine) : null;
      for (const code of comps) {
        let m = bandDoses.get(code);
        if (!m) {
          m = new Map();
          bandDoses.set(code, m);
        }
        const arr = m.get(bi) ?? [];
        arr.push({
          date: r.date,
          via,
          notes: r.notes,
          dose_label: r.dose_label,
        });
        m.set(bi, arr);
      }
    }
  }

  const statusByCode = new Map(assessments.map((a) => [a.code, a]));

  function tipFor(entry: VaccineEntry, i: number): TipContent | null {
    // The dose number/label this band represents (e.g. "Dose 2 of 4"), shown on
    // both recorded and recommended cells so it's clear which dose a cell is.
    const doseOf = doseOfLabel(entry, i);
    const doses = bandDoses.get(entry.code)?.get(i);
    if (doses?.length) {
      const lines: string[] = [];
      for (const d of doses) {
        // Prefer the user's own dose label; fall back to the series position.
        const label = d.dose_label ?? doseOf;
        lines.push(
          (label ? `${label} · ` : "") +
            `Received ${d.date}` +
            (d.via ? ` · via ${d.via}` : "") +
            (d.notes ? ` · ${d.notes}` : "")
        );
      }
      return { title: entry.name, lines };
    }
    const rec = recommendationForBand(entry, i);
    if (!rec) return null;
    return {
      title: entry.name,
      lines: doseOf ? [`${doseOf} · ${rec}`] : [rec],
    };
  }

  // Tooltip for the vaccine name: what it protects against, the schedule
  // overview, and this profile's current status for it.
  function nameTip(entry: VaccineEntry): TipContent {
    const lines: string[] = [];
    const desc = vaccineDescription(entry.code);
    if (desc) lines.push(desc);
    lines.push(scheduleSummary(entry));
    const a = statusByCode.get(entry.code);
    if (a?.detail) lines.push(`Status: ${a.detail}`);
    return { title: entry.name, lines };
  }

  return (
    <div
      className="card overflow-x-auto p-0"
      onMouseLeave={() => {
        setTip(null);
        setHoverCode(null);
      }}
    >
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-semibold text-slate-600 dark:bg-ink-900 dark:text-slate-300">
              Vaccine
            </th>
            {BANDS.map((b, i) => (
              <th
                key={b.label}
                className={`px-1.5 py-2 text-center font-medium whitespace-nowrap ${
                  i === currentBand
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {b.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GROUP_ORDER.map((group) => {
            const rows = CATALOG.filter((v) => v.group === group);
            if (rows.length === 0) return null;
            return (
              <Fragment key={group}>
                <tr>
                  <td
                    colSpan={BANDS.length + 1}
                    className="sticky left-0 bg-slate-50 px-3 py-1.5 section-label dark:bg-ink-850"
                  >
                    {GROUP_LABELS[group]}
                  </td>
                </tr>
                {rows.map((entry) => {
                  const rec = recommendedBands(entry);
                  const doseMap = bandDoses.get(entry.code);
                  const a = statusByCode.get(entry.code);
                  const rowHover = hoverCode === entry.code;
                  return (
                    <tr
                      key={entry.code}
                      className={`border-t border-black/5 dark:border-white/5 ${
                        rowHover ? "bg-slate-50 dark:bg-ink-850" : ""
                      }`}
                      onMouseEnter={() => setHoverCode(entry.code)}
                    >
                      <td
                        className={`sticky left-0 z-10 cursor-help px-3 py-1.5 ${
                          rowHover
                            ? "bg-slate-50 dark:bg-ink-850"
                            : "bg-white dark:bg-ink-900"
                        }`}
                        onMouseEnter={(e) =>
                          setTip({
                            c: nameTip(entry),
                            x: e.clientX,
                            y: e.clientY,
                          })
                        }
                        onMouseMove={(e) =>
                          setTip((t) =>
                            t ? { ...t, x: e.clientX, y: e.clientY } : t
                          )
                        }
                      >
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              STATUS_DOT[a?.status ?? "not_recommended"]
                            }`}
                          />
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            {entry.abbrev}
                          </span>
                        </div>
                      </td>
                      {BANDS.map((b, i) => {
                        const isRec = rec.has(i);
                        const isGot = (doseMap?.get(i)?.length ?? 0) > 0;
                        const isCur = i === currentBand;
                        const content = tipFor(entry, i);
                        return (
                          <td
                            key={b.label}
                            className={`px-1.5 py-1.5 text-center ${
                              isCur
                                ? "bg-brand-100/70 dark:bg-brand-950/60"
                                : ""
                            } ${content ? "cursor-help" : ""}`}
                            onMouseEnter={(e) =>
                              setTip(
                                content
                                  ? { c: content, x: e.clientX, y: e.clientY }
                                  : null
                              )
                            }
                            onMouseMove={(e) =>
                              setTip((t) =>
                                t ? { ...t, x: e.clientX, y: e.clientY } : t
                              )
                            }
                          >
                            {isGot ? (
                              <span className="inline-block rounded bg-emerald-500 px-1 text-xs font-bold text-white">
                                ✓
                              </span>
                            ) : isRec ? (
                              <span className="inline-block h-3 w-full min-w-[1rem] rounded bg-brand-200 dark:bg-brand-800/70" />
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <Legend />
      {/* Portal to <body>: the .card ancestor sets backdrop-filter, which makes
          it the containing block for position:fixed, so a tooltip rendered in
          place would be offset by the card's origin. Escaping to <body> restores
          true viewport-relative fixed positioning against clientX/clientY. */}
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 max-w-xs rounded-lg border border-black/10 bg-white px-3 py-2 text-xs shadow-lg dark:border-white/10 dark:bg-ink-900"
            style={{
              left: Math.min(tip.x + 14, window.innerWidth - 250),
              top: tip.y + 14,
            }}
          >
            <div className="font-semibold text-slate-800 dark:text-slate-100">
              {tip.c.title}
            </div>
            <div className="mt-0.5 space-y-0.5 text-slate-500 dark:text-slate-400">
              {tip.c.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded bg-brand-200 dark:bg-brand-800/70" />
        Recommended
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block rounded bg-emerald-500 px-1 text-xs font-bold text-white">
          ✓
        </span>
        Recorded
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded bg-brand-50 ring-1 ring-brand-300 dark:bg-brand-950" />
        Current age
      </span>
    </div>
  );
}
