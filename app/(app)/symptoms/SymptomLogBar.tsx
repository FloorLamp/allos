"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconX, IconPlus, IconNote } from "@tabler/icons-react";
import {
  type Symptom,
  resolveSymptomKey,
  symptomLabel,
  symptomBySlug,
  severityLabel,
  SYMPTOM_SEVERITY_LEVELS,
  MAX_SYMPTOM_SEVERITY,
} from "@/lib/symptoms";
import type { TemperatureUnit } from "@/lib/settings";
import { useToast } from "@/components/Toast";
import { round, fmtTemp } from "@/lib/units";
import { toCanonicalTempF, temperatureRangeError } from "@/lib/vitals-input";
import {
  logSymptom,
  lowerSymptom,
  setSymptomNote,
  removeSymptom,
  logTemperature,
  activateIllnessForSymptoms,
} from "./actions";

// One-tap symptom logger (issue #799/#857), modeled on the FoodLogBar one-tap pattern:
// optimistic local severities, a Server Action per tap, and reconciliation to the
// server's authoritative value (#748 item 2). A symptom-day keeps its WORST severity — a
// tap only RAISES it (server-enforced); lowering is an explicit inline confirm (#857); the
// × clears the day's row.
//
// Active-first layout (#857): the LOGGED symptoms render expanded (label + labeled
// severity chips + note + ×) — the working set. Everything else (the ~20-symptom catalog +
// previously-used customs + a free-text add) collapses into ONE "＋ add symptom" picker,
// ranked by the profile's symptom history (rankedKeys) and FROZEN while mounted so a row
// never jumps mid-tap. On the dashboard this renders with a today/yesterday toggle; on the
// Timeline day view it renders for a single day. When no illness-type situation is active
// it offers a suggest-only "Mark as illness" bridge.

type Row = { key: string; label: string; icon?: string };

export default function SymptomLogBar({
  date,
  altDate,
  dateLabel = "Today",
  altDateLabel = "Yesterday",
  initial,
  initialAlt,
  initialNotes,
  initialAltNotes,
  symptoms,
  customNames,
  rankedKeys,
  suggestActivateIllness,
  showTemperature = false,
  temperatureUnit = "F",
  profileId,
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
  // symptom key → note already logged, for the primary and alt dates (#857). Optional —
  // absent leaves every note blank until edited.
  initialNotes?: Record<string, string>;
  initialAltNotes?: Record<string, string>;
  // The curated catalog (shortcut chips).
  symptoms: Symptom[];
  // Custom symptom keys this profile has logged before (rendered in the add picker).
  customNames: string[];
  // The picker order — stored keys (curated slugs + customs) ranked by this profile's
  // symptom history (#857, getSymptomLogOrder). Absent → catalog order then customs.
  rankedKeys?: string[];
  // Whether to offer the "Mark as illness" bridge (no illness-type situation active).
  suggestActivateIllness: boolean;
  // Whether to render the body-temperature quick entry (issue #800).
  showTemperature?: boolean;
  // The viewer's login temperature-unit preference (#857) — seeds the entry unit and the
  // fever toast. Canonical storage stays °F; this only changes display. Default "F".
  temperatureUnit?: TemperatureUnit;
  // The profile this bar writes to (issue #858). Set ONLY on the illness-hero cockpit,
  // where a caregiver logs for a household member without switching — every action posts
  // this so the server gates on the TARGET (requireProfileWriteAccess). Absent on the
  // default dashboard/Timeline mounts, which write the session's active profile.
  profileId?: number;
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
  // Per-symptom notes, kept per day like the severities.
  const [notesByDate, setNotesByDate] = useState<
    Record<string, Record<string, string>>
  >(() => ({
    [date]: initialNotes ?? {},
    ...(altDate ? { [altDate]: initialAltNotes ?? {} } : {}),
  }));
  const [customDraft, setCustomDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // The logged row whose lower-severity confirm is open ({ key, level }), or null.
  const [lowerConfirm, setLowerConfirm] = useState<{
    key: string;
    level: number;
  } | null>(null);
  // The logged row whose note input is open, or null.
  const [noteEditing, setNoteEditing] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  // Body-temperature quick entry (issue #800) — collapsed by default (#857) to one line.
  const [tempOpen, setTempOpen] = useState(false);
  const [tempValue, setTempValue] = useState("");
  const [tempUnit, setTempUnit] = useState<TemperatureUnit>(temperatureUnit);
  // Optional reading time (#800/#843): defaults to "now" (blank).
  const [tempTime, setTempTime] = useState("");
  const [tempError, setTempError] = useState<string | null>(null);
  const [tempPending, setTempPending] = useState(false);

  async function logTemp() {
    const raw = Number(tempValue);
    if (tempValue.trim() === "" || !Number.isFinite(raw)) {
      setTempError("Enter a temperature.");
      return;
    }
    const rangeErr = temperatureRangeError(
      round(toCanonicalTempF(raw, tempUnit), 1)
    );
    if (rangeErr) {
      setTempError(rangeErr);
      return;
    }
    setTempError(null);
    setTempPending(true);
    const fd = new FormData();
    fd.set("temperature", tempValue);
    fd.set("temp_unit", tempUnit);
    // The reading is "now" for today (the card's primary date), never the alt day.
    fd.set("date", date);
    if (tempTime.trim() !== "") fd.set("time", tempTime);
    const res = await logTemperature(withTarget(fd));
    setTempPending(false);
    if (res.ok) {
      setTempValue("");
      setTempTime("");
      toast(
        `Temperature logged: ${fmtTemp(res.degF, temperatureUnit)}${
          res.flag === "high" ? " — fever" : ""
        }`,
        { tone: res.flag === "high" ? "error" : undefined }
      );
      startTransition(() => router.refresh());
    } else {
      setTempError(res.error);
      toast(res.error, { tone: "error" });
    }
  }

  const severities = severitiesByDate[activeDate] ?? {};
  const notes = notesByDate[activeDate] ?? {};

  // Stamp the cross-profile target (issue #858) onto every write, when this bar is a
  // hero cockpit for a non-active profile. A no-op on the default mounts (profileId
  // undefined), which write the session's active profile.
  const withTarget = (fd: FormData): FormData => {
    if (profileId != null) fd.set("profileId", String(profileId));
    return fd;
  };

  // The full universe of rows (curated catalog + any custom keys already logged, either
  // day). Labels/icons only — order comes from `orderedKeys`.
  const rows = useMemo<Row[]>(() => {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const s of symptoms) {
      seen.add(s.slug);
      out.push({ key: s.slug, label: s.label, icon: s.icon });
    }
    const customs = [
      ...customNames,
      ...Object.keys(severitiesByDate[date] ?? {}),
      ...(altDate ? Object.keys(severitiesByDate[altDate] ?? {}) : []),
    ];
    for (const key of customs) {
      if (seen.has(key) || symptomBySlug(key)) continue;
      seen.add(key);
      out.push({ key, label: symptomLabel(key) });
    }
    return out;
  }, [symptoms, customNames, severitiesByDate, date, altDate]);

  const rowMap = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  // Freeze the picker order for the life of this mount: the server re-ranks on every
  // read, so a router.refresh() after a tap must not reorder rows under the finger (the
  // FoodLogBar #591 discipline). The order only changes on remount (navigate away + back).
  const frozenOrder = useRef<string[] | null>(null);
  if (frozenOrder.current === null) {
    frozenOrder.current = rankedKeys ?? [
      ...symptoms.map((s) => s.slug),
      ...customNames,
    ];
  }
  const orderedKeys = useMemo(() => {
    const idx = new Map(frozenOrder.current!.map((k, i) => [k, i]));
    return rows
      .map((r, i) => ({ k: r.key, i }))
      .sort((a, b) => {
        const ai = idx.get(a.k) ?? Number.MAX_SAFE_INTEGER;
        const bi = idx.get(b.k) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || a.i - b.i;
      })
      .map((x) => x.k);
  }, [rows]);

  const loggedKeys = orderedKeys.filter((k) => (severities[k] ?? 0) > 0);
  const pickerKeys = orderedKeys.filter((k) => (severities[k] ?? 0) <= 0);

  function setSeverity(key: string, value: number) {
    setSeveritiesByDate((m) => {
      const day = { ...(m[activeDate] ?? {}) };
      if (value <= 0) delete day[key];
      else day[key] = value;
      return { ...m, [activeDate]: day };
    });
  }

  function setNote(key: string, value: string) {
    setNotesByDate((m) => {
      const day = { ...(m[activeDate] ?? {}) };
      if (value.trim() === "") delete day[key];
      else day[key] = value;
      return { ...m, [activeDate]: day };
    });
  }

  // Tap RAISES (worst-severity), matching the server. Adding from the picker taps at 1.
  async function tap(key: string, severity: number) {
    const prev = severities[key] ?? 0;
    setSeverity(key, Math.max(prev, severity));
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("severity", String(severity));
    fd.set("date", activeDate);
    const res = await logSymptom(withTarget(fd));
    if (res.ok) setSeverity(key, res.severity);
    else {
      setSeverity(key, prev);
      toast(res.error || "Couldn't log that symptom — try again.", {
        tone: "error",
      });
    }
    startTransition(() => router.refresh());
  }

  // Explicit LOWER — the inline confirm's action (#857). Optimistically lowers, calls the
  // narrow lower action, reconciles. Preserves the day's note (the note isn't sent).
  async function lower(key: string, severity: number) {
    const prev = severities[key] ?? 0;
    setLowerConfirm(null);
    if (severity >= prev) return;
    setSeverity(key, severity);
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("severity", String(severity));
    fd.set("date", activeDate);
    const res = await lowerSymptom(withTarget(fd));
    if (res.ok) setSeverity(key, res.severity);
    else {
      setSeverity(key, prev);
      toast(res.error || "Couldn't lower that symptom.", { tone: "error" });
    }
    startTransition(() => router.refresh());
  }

  async function saveNote(key: string, value: string) {
    const prev = notes[key] ?? "";
    setNote(key, value);
    setNoteEditing(null);
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("date", activeDate);
    fd.set("note", value);
    const res = await setSymptomNote(withTarget(fd));
    if (!res.ok) {
      setNote(key, prev);
      toast(res.error || "Couldn't save that note.", { tone: "error" });
    }
    startTransition(() => router.refresh());
  }

  async function clear(key: string) {
    const prev = severities[key] ?? 0;
    const prevNote = notes[key] ?? "";
    setSeverity(key, 0);
    setNote(key, "");
    if (noteEditing === key) setNoteEditing(null);
    const fd = new FormData();
    fd.set("symptom", key);
    fd.set("date", activeDate);
    const res = await removeSymptom(withTarget(fd));
    if (!res.ok) {
      setSeverity(key, prev);
      if (prevNote) setNote(key, prevNote);
      toast(res.error || "Couldn't remove that symptom.", { tone: "error" });
    }
    startTransition(() => router.refresh());
  }

  function addCustom() {
    const key = resolveSymptomKey(customDraft);
    setCustomDraft("");
    if (!key) return;
    // One add path (#857): a typed name logs at severity 1, becoming a logged row.
    void tap(key, 1);
  }

  const loggedCount = loggedKeys.length;

  return (
    <div data-testid="symptom-log-bar">
      <div className="mb-2 flex items-center justify-between gap-2">
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

      {/* First-use legend (#857): what the levels mean + the worst-only rule made visible. */}
      <p
        data-testid="symptom-severity-legend"
        className="mb-3 text-xs text-slate-500 dark:text-slate-400"
      >
        Severity 1 (mild) → {MAX_SYMPTOM_SEVERITY} (very severe). Tapping raises
        the day&apos;s worst; tap a lower level to lower it.
      </p>

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

      {showTemperature &&
        (tempOpen ? (
          <div
            data-testid="temp-quick-entry"
            className="mb-3 rounded-md border border-black/10 p-2.5 dark:border-white/15"
          >
            <label className="label mb-1 block" htmlFor="temp-quick-input">
              Temperature
            </label>
            <div className="flex items-center gap-2">
              <input
                id="temp-quick-input"
                data-testid="temp-quick-input"
                type="number"
                step="0.1"
                inputMode="decimal"
                autoFocus
                value={tempValue}
                onChange={(e) => {
                  setTempValue(e.target.value);
                  if (tempError) setTempError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void logTemp();
                  }
                }}
                placeholder="Thermometer reading"
                className="input flex-1"
              />
              <select
                data-testid="temp-quick-unit"
                aria-label="Temperature unit"
                value={tempUnit}
                onChange={(e) =>
                  setTempUnit(e.target.value === "C" ? "C" : "F")
                }
                className="input w-auto"
              >
                <option value="F">°F</option>
                <option value="C">°C</option>
              </select>
              <input
                data-testid="temp-quick-time"
                type="time"
                aria-label="Reading time (optional)"
                value={tempTime}
                onChange={(e) => setTempTime(e.target.value)}
                className="input w-auto"
              />
              <button
                type="button"
                data-testid="temp-quick-save"
                disabled={tempPending}
                onClick={() => void logTemp()}
                className="badge cursor-pointer bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {tempPending ? "Logging…" : "Log temp"}
              </button>
            </div>
            {tempError && (
              <p
                role="alert"
                data-testid="temp-quick-error"
                className="mt-1 text-xs text-rose-600 dark:text-rose-400"
              >
                {tempError}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-testid="temp-quick-toggle"
            onClick={() => setTempOpen(true)}
            className="badge mb-3 cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
          >
            🌡 Log temp
          </button>
        ))}

      {loggedCount === 0 ? (
        <p
          data-testid="symptom-none-logged"
          className="mb-3 text-xs text-slate-500 dark:text-slate-400"
        >
          No symptoms logged{hasToggle ? " for this day" : ""}. Add one below.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="symptom-logged-list">
          {loggedKeys.map((key) => {
            const r = rowMap.get(key);
            if (!r) return null;
            const sev = severities[key] ?? 0;
            const note = notes[key] ?? "";
            const confirming = lowerConfirm?.key === key;
            const editingNote = noteEditing === key;
            return (
              <li
                key={key}
                data-testid={`symptom-${key}`}
                className="rounded-md"
              >
                <div className="flex items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200">
                    {r.icon && <span aria-hidden>{r.icon}</span>}
                    <span className="truncate">{r.label}</span>
                  </span>
                  <div className="flex items-center gap-1">
                    {SYMPTOM_SEVERITY_LEVELS.map((lvl) => (
                      <button
                        key={lvl.value}
                        type="button"
                        data-testid={`symptom-${key}-sev-${lvl.value}`}
                        aria-pressed={sev === lvl.value}
                        aria-label={`${r.label} — severity ${lvl.value} of ${MAX_SYMPTOM_SEVERITY} (${lvl.label})`}
                        title={lvl.label}
                        onClick={() => {
                          if (lvl.value < sev)
                            setLowerConfirm({ key, level: lvl.value });
                          else {
                            setLowerConfirm(null);
                            void tap(key, lvl.value);
                          }
                        }}
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
                      data-testid={`symptom-${key}-note-toggle`}
                      aria-label={`${note ? "Edit" : "Add"} note for ${r.label}`}
                      aria-pressed={editingNote}
                      onClick={() => {
                        if (editingNote) setNoteEditing(null);
                        else {
                          setNoteDraft(note);
                          setNoteEditing(key);
                        }
                      }}
                      className={`ml-1 rounded p-1 hover:text-slate-600 dark:hover:text-slate-200 ${
                        note
                          ? "text-brand-600 dark:text-brand-400"
                          : "text-slate-400"
                      }`}
                    >
                      <IconNote className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid={`symptom-${key}-clear`}
                      aria-label={`Clear ${r.label}`}
                      disabled={sev <= 0}
                      onClick={() => clear(key)}
                      className="rounded p-1 text-slate-400 hover:text-slate-600 disabled:opacity-30 dark:hover:text-slate-200"
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {confirming && (
                  <div
                    data-testid={`symptom-${key}-lower-confirm`}
                    className="mt-1 flex items-center justify-end gap-2 text-xs text-slate-600 dark:text-slate-300"
                  >
                    <span>
                      Lower to{" "}
                      {severityLabel(lowerConfirm!.level).toLowerCase()}? —
                      replaces today&apos;s worst
                    </span>
                    <button
                      type="button"
                      data-testid={`symptom-${key}-lower-confirm-yes`}
                      onClick={() => lower(key, lowerConfirm!.level)}
                      className="badge cursor-pointer bg-brand-600 text-white hover:bg-brand-700"
                    >
                      Lower
                    </button>
                    <button
                      type="button"
                      data-testid={`symptom-${key}-lower-confirm-no`}
                      onClick={() => setLowerConfirm(null)}
                      className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {editingNote && (
                  <form
                    className="mt-1 flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveNote(key, noteDraft);
                    }}
                  >
                    <input
                      data-testid={`symptom-${key}-note-input`}
                      autoFocus
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      onBlur={() => {
                        if (noteDraft !== (notes[key] ?? ""))
                          void saveNote(key, noteDraft);
                        else setNoteEditing(null);
                      }}
                      placeholder="Note (e.g. worse at night)…"
                      maxLength={500}
                      className="flex-1 rounded-md border border-black/10 bg-white px-2 py-1 text-xs dark:border-white/15 dark:bg-ink-900"
                    />
                    <button
                      type="submit"
                      data-testid={`symptom-${key}-note-save`}
                      className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
                    >
                      Save
                    </button>
                  </form>
                )}

                {!editingNote && note && (
                  <p
                    data-testid={`symptom-${key}-note`}
                    className="mt-0.5 whitespace-pre-wrap break-words text-xs italic text-slate-500 dark:text-slate-400"
                  >
                    {note}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add picker (#857): the catalog + customs + free-text add, one collapsed path. */}
      <div className="mt-3">
        <button
          type="button"
          data-testid="symptom-add-picker-toggle"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((o) => !o)}
          className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
        >
          <IconPlus className="mr-1 inline h-3.5 w-3.5" />
          Add symptom
        </button>
        {pickerOpen && (
          <div
            data-testid="symptom-add-picker"
            className="mt-2 rounded-md border border-black/10 p-2.5 dark:border-white/15"
          >
            <div className="flex flex-wrap gap-1.5">
              {pickerKeys.map((key) => {
                const r = rowMap.get(key);
                if (!r) return null;
                return (
                  <button
                    key={key}
                    type="button"
                    data-testid={`symptom-pick-${key}`}
                    onClick={() => void tap(key, 1)}
                    className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-brand-950 dark:hover:text-brand-300"
                  >
                    {r.icon && <span aria-hidden>{r.icon} </span>}
                    {r.label}
                  </button>
                );
              })}
            </div>
            <form
              className="mt-2 flex items-center gap-2"
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
        )}
      </div>
    </div>
  );
}
