"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconX, IconPlus } from "@tabler/icons-react";
import {
  type Symptom,
  resolveSymptomKey,
  symptomLabel,
  symptomBySlug,
  SYMPTOM_SEVERITY_LEVELS,
} from "@/lib/symptoms";
import { useToast } from "@/components/Toast";
import {
  logSymptom,
  removeSymptom,
  activateIllnessForSymptoms,
} from "./actions";

// One-tap symptom logger (issue #799), modeled on the FoodLogBar one-tap pattern:
// optimistic local severities, a Server Action per tap, and reconciliation to the
// server's authoritative value (#748 item 2). A symptom-day keeps its WORST severity — a
// tap only RAISES it (server-enforced); the × clears the day's row. On the dashboard this
// renders with a today/yesterday toggle; on the Timeline day view it renders for a single
// day (no toggle). When no illness-type situation is active it offers a suggest-only
// "Mark as illness" bridge (direction A of #799's two-way bridge).

type Row = { key: string; label: string; icon?: string };

export default function SymptomLogBar({
  date,
  altDate,
  dateLabel = "Today",
  altDateLabel = "Yesterday",
  initial,
  initialAlt,
  symptoms,
  customNames,
  suggestActivateIllness,
}: {
  // Primary date (YYYY-MM-DD). On the dashboard this is today; on the Timeline it's the
  // selected day.
  date: string;
  // Optional second date for the toggle (yesterday on the dashboard). Absent → single-day.
  altDate?: string;
  dateLabel?: string;
  altDateLabel?: string;
  // symptom key → severity already logged, for the primary and alt dates.
  initial: Record<string, number>;
  initialAlt?: Record<string, number>;
  // The curated catalog (shortcut chips).
  symptoms: Symptom[];
  // Custom symptom keys this profile has logged before (rendered alongside the catalog).
  customNames: string[];
  // Whether to offer the "Mark as illness" bridge (no illness-type situation active).
  suggestActivateIllness: boolean;
}) {
  const hasToggle = !!altDate;
  const [mode, setMode] = useState<"primary" | "alt">("primary");
  const activeDate = mode === "alt" && altDate ? altDate : date;

  const [severitiesByDate, setSeveritiesByDate] = useState<
    Record<string, Record<string, number>>
  >(() => ({
    [date]: initial,
    ...(altDate ? { [altDate]: initialAlt ?? {} } : {}),
  }));
  // Custom names added in this session (before a first refresh surfaces them from the
  // server list). Kept local so a just-typed symptom shows a row immediately.
  const [extraCustoms, setExtraCustoms] = useState<string[]>([]);
  const [customDraft, setCustomDraft] = useState("");
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const severities = severitiesByDate[activeDate] ?? {};

  // The rendered rows: curated catalog first (stable order), then any custom keys — the
  // server's known customs merged with locally-added ones and anything already logged.
  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const s of symptoms) {
      seen.add(s.slug);
      out.push({ key: s.slug, label: s.label, icon: s.icon });
    }
    const customs = [
      ...customNames,
      ...extraCustoms,
      ...Object.keys(severitiesByDate[date] ?? {}),
      ...(altDate ? Object.keys(severitiesByDate[altDate] ?? {}) : []),
    ];
    for (const key of customs) {
      if (seen.has(key) || symptomBySlug(key)) continue;
      seen.add(key);
      out.push({ key, label: symptomLabel(key) });
    }
    return out;
  }, [symptoms, customNames, extraCustoms, severitiesByDate, date, altDate]);

  function setSeverity(key: string, value: number) {
    setSeveritiesByDate((m) => {
      const day = { ...(m[activeDate] ?? {}) };
      if (value <= 0) delete day[key];
      else day[key] = value;
      return { ...m, [activeDate]: day };
    });
  }

  async function tap(key: string, severity: number) {
    const prev = severities[key] ?? 0;
    // Optimistic: a tap can only raise (worst-severity), matching the server.
    setSeverity(key, Math.max(prev, severity));
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("severity", String(severity));
    fd.set("date", activeDate);
    const res = await logSymptom(fd);
    if (res.ok) setSeverity(key, res.severity);
    else {
      setSeverity(key, prev);
      toast(res.error || "Couldn't log that symptom — try again.", {
        tone: "error",
      });
    }
    startTransition(() => router.refresh());
  }

  async function clear(key: string) {
    const prev = severities[key] ?? 0;
    setSeverity(key, 0);
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("date", activeDate);
    const res = await removeSymptom(fd);
    if (!res.ok) {
      setSeverity(key, prev);
      toast(res.error || "Couldn't remove that symptom.", { tone: "error" });
    }
    startTransition(() => router.refresh());
  }

  function addCustom() {
    const key = resolveSymptomKey(customDraft);
    setCustomDraft("");
    if (!key) return;
    if (!rows.some((r) => r.key === key)) {
      setExtraCustoms((c) => (c.includes(key) ? c : [...c, key]));
    }
  }

  const loggedCount = Object.values(severities).filter((v) => v > 0).length;

  return (
    <div data-testid="symptom-log-bar">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Symptoms
          <span
            data-testid="symptom-logged-count"
            className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400"
          >
            {loggedCount} logged
          </span>
        </h2>
        {hasToggle && (
          <div
            data-testid="symptom-day-toggle"
            className="inline-flex overflow-hidden rounded-md border border-black/10 text-xs dark:border-white/15"
          >
            <button
              type="button"
              data-testid="symptom-day-primary"
              aria-pressed={mode === "primary"}
              onClick={() => setMode("primary")}
              className={`px-2 py-1 ${mode === "primary" ? "bg-brand-600 text-white" : "text-slate-600 dark:text-slate-300"}`}
            >
              {dateLabel}
            </button>
            <button
              type="button"
              data-testid="symptom-day-alt"
              aria-pressed={mode === "alt"}
              onClick={() => setMode("alt")}
              className={`px-2 py-1 ${mode === "alt" ? "bg-brand-600 text-white" : "text-slate-600 dark:text-slate-300"}`}
            >
              {altDateLabel}
            </button>
          </div>
        )}
      </div>

      {suggestActivateIllness && (
        <div
          data-testid="symptom-illness-bridge"
          className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
        >
          <span>Tracking an illness?</span>
          <button
            type="button"
            data-testid="symptom-illness-bridge-activate"
            onClick={() =>
              startTransition(async () => {
                await activateIllnessForSymptoms();
                router.refresh();
              })
            }
            className="badge cursor-pointer border border-dashed border-brand-400 bg-transparent text-brand-700 hover:bg-brand-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
          >
            + Mark as illness
          </button>
        </div>
      )}

      <ul className="space-y-1.5">
        {rows.map((r) => {
          const sev = severities[r.key] ?? 0;
          return (
            <li
              key={r.key}
              data-testid={`symptom-${r.key}`}
              className="flex items-center gap-2"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                {r.icon && <span aria-hidden>{r.icon}</span>}
                <span className="truncate">{r.label}</span>
              </span>
              <div className="flex items-center gap-1">
                {SYMPTOM_SEVERITY_LEVELS.map((lvl) => (
                  <button
                    key={lvl.value}
                    type="button"
                    data-testid={`symptom-${r.key}-sev-${lvl.value}`}
                    aria-pressed={sev === lvl.value}
                    title={lvl.label}
                    onClick={() => tap(r.key, lvl.value)}
                    className={`h-6 w-6 rounded text-xs font-semibold ${
                      sev >= lvl.value
                        ? "bg-brand-600 text-white"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-400 dark:hover:bg-ink-700"
                    }`}
                  >
                    {lvl.value}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid={`symptom-${r.key}-clear`}
                  aria-label={`Clear ${r.label}`}
                  disabled={sev <= 0}
                  onClick={() => clear(r.key)}
                  className="ml-1 rounded p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 dark:hover:text-slate-200"
                >
                  <IconX className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addCustom();
        }}
      >
        <input
          data-testid="symptom-custom-input"
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          placeholder="Add another symptom…"
          maxLength={80}
          className="flex-1 rounded-md border border-black/10 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-ink-900"
        />
        <button
          type="submit"
          data-testid="symptom-custom-add"
          aria-label="Add symptom"
          className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
        >
          <IconPlus className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}
