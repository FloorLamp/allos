"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  IconX,
  IconPlus,
  IconNote,
  IconChevronDown,
} from "@tabler/icons-react";
import {
  type Symptom,
  resolveSymptomKey,
  symptomLabel,
  symptomBySlug,
  SYMPTOM_SEVERITY_LEVELS,
  MAX_SYMPTOM_SEVERITY,
} from "@/lib/symptoms";
import type { TemperatureUnit } from "@/lib/settings";
import { useToast } from "@/components/Toast";
import NotesText from "@/components/NotesText";
import { round, fmtTemp } from "@/lib/units";
import { zonedDateParts } from "@/lib/date";
import {
  resolveTemperatureUnit,
  toCanonicalTempF,
  temperatureRangeError,
} from "@/lib/vitals-input";
import { useTemperatureUnitDetection } from "@/components/useTemperatureUnitDetection";
import {
  logSymptom,
  lowerSymptom,
  setSymptomNote,
  removeSymptom,
  logTemperature,
  activateIllnessForSymptoms,
  suggestSymptomsFromText,
} from "./actions";
import type { SymptomTextMapping } from "@/lib/symptom-text-map";

// One-tap symptom logger (issue #799/#857), modeled on the FoodLogBar one-tap pattern:
// optimistic local severities, a Server Action per tap, and reconciliation to the
// server's authoritative value (#748 item 2). A symptom-day keeps its WORST severity — a
// normal tap raises it (server-enforced); selecting a lower labeled chip uses the narrow
// lower action directly; the × clears the day's row.
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
  timeZone,
  profileId,
  showTitle = true,
  textIntakeEnabled = false,
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
  // Profile-local zone used to seed the reading-time field when temperature entry opens.
  // Important for household logging, where the target's zone may differ from the browser.
  timeZone?: string;
  // The profile this bar writes to (issue #858). Set ONLY on the illness-hero cockpit,
  // where a caregiver logs for a household member without switching — every action posts
  // this so the server gates on the TARGET (requireProfileWriteAccess). Absent on the
  // default dashboard/Timeline mounts, which write the session's active profile.
  profileId?: number;
  // Composed surfaces may already provide a section heading; keep the count/toggle row
  // without repeating "Daily symptoms" in that case.
  showTitle?: boolean;
  // Whether to render the free-text intake field (issue #877) — true only when a Light
  // AI tier is configured. Absent/false hides it entirely (taps stay the whole story;
  // offline-first, unchanged).
  textIntakeEnabled?: boolean;
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
  // The logged row whose note input is open, or null.
  const [noteEditing, setNoteEditing] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  // Body-temperature quick entry (issue #800) — collapsed by default (#857) to one line.
  const [tempOpen, setTempOpen] = useState(false);
  const [tempValue, setTempValue] = useState("");
  const tempUnitDetection = useTemperatureUnitDetection(temperatureUnit);
  const tempUnit = tempUnitDetection.unit;
  // Reading time (#800/#843): seeded to the target profile's current local minute when
  // the disclosure opens; the user can still adjust it for an earlier reading.
  const [tempTime, setTempTime] = useState("");
  const [tempError, setTempError] = useState<string | null>(null);
  const [tempPending, setTempPending] = useState(false);

  // Free-text intake (issue #877): a typed sentence → staged, editable suggestions the
  // user confirms with one tap. Suggest-only — nothing writes until confirm, which goes
  // through the same logSymptom / logTemperature actions a tap uses.
  const [intakeText, setIntakeText] = useState("");
  const [intakeStaged, setIntakeStaged] = useState<SymptomTextMapping | null>(
    null
  );
  const [intakePending, setIntakePending] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  async function suggestFromText() {
    if (intakeText.trim() === "") return;
    setIntakePending(true);
    setIntakeError(null);
    const fd = new FormData();
    fd.set("text", intakeText);
    const res = await suggestSymptomsFromText(withTarget(fd));
    setIntakePending(false);
    if (res.ok) {
      setIntakeStaged(res.mapping);
    } else if (res.reason === "empty") {
      setIntakeError("Couldn't find any symptoms in that. Add them below.");
    } else if (res.reason === "not-configured") {
      setIntakeError("AI intake isn't configured.");
    } else {
      setIntakeError(res.error || "Couldn't read that. Try again.");
    }
  }

  function setStagedSeverity(idx: number, sev: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      const symptoms = m.symptoms.map((s, i) =>
        i === idx ? { ...s, severity: sev } : s
      );
      return { ...m, symptoms };
    });
  }

  function dropStaged(idx: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      return { ...m, symptoms: m.symptoms.filter((_, i) => i !== idx) };
    });
  }

  function dropUnmapped(idx: number) {
    setIntakeStaged((m) => {
      if (!m) return m;
      return { ...m, unmapped: m.unmapped.filter((_, i) => i !== idx) };
    });
  }

  // Confirm (#877): commit every staged suggestion through the EXISTING actions — one
  // logSymptom per row (+ its note), then a logTemperature for a staged reading — so a
  // confirmed sentence lands rows identical to tapping them.
  async function confirmIntake() {
    if (!intakeStaged) return;
    setIntakePending(true);
    // A "since yesterday" hint targets the alt day when the toggle offers one.
    const targetDate =
      intakeStaged.dayOffset === -1 && altDate ? altDate : date;
    for (const s of intakeStaged.symptoms) {
      const fd = new FormData();
      fd.set("symptom", s.slug);
      fd.set("severity", String(s.severity));
      fd.set("date", targetDate);
      if (s.note) fd.set("note", s.note);
      await logSymptom(withTarget(fd));
    }
    if (intakeStaged.temperature) {
      const fd = new FormData();
      fd.set("temperature", String(intakeStaged.temperature.value));
      fd.set("temp_unit", intakeStaged.temperature.unit);
      fd.set("date", date);
      await logTemperature(withTarget(fd));
    }
    const count = intakeStaged.symptoms.length;
    setIntakeStaged(null);
    setIntakeText("");
    setIntakePending(false);
    toast(
      count > 0
        ? `Logged ${count} symptom${count === 1 ? "" : "s"}.`
        : "Logged."
    );
    startTransition(() => router.refresh());
  }

  function toggleSymptomPicker() {
    const opening = !pickerOpen;
    setPickerOpen(opening);
    if (opening) setTempOpen(false);
  }

  function toggleTemperatureEntry() {
    const opening = !tempOpen;
    setTempOpen(opening);
    if (opening) {
      setPickerOpen(false);
      if (tempTime === "") {
        const zone =
          timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        setTempTime(zonedDateParts(zone, new Date()).hhmm);
      }
    }
  }

  async function logTemp() {
    const raw = Number(tempValue);
    if (tempValue.trim() === "" || !Number.isFinite(raw)) {
      setTempError("Enter a temperature.");
      return;
    }
    const resolvedUnit = resolveTemperatureUnit(raw, tempUnit);
    const rangeErr = temperatureRangeError(
      round(toCanonicalTempF(raw, resolvedUnit), 1)
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
      tempUnitDetection.reset();
      setTempTime("");
      setTempOpen(false);
      toast(
        `Temperature logged: ${fmtTemp(res.degF, temperatureUnit)}${
          res.flag === "high" ? " — fever" : ""
        }`,
        { tone: res.flag === "high" ? "error" : undefined }
      );
      // Single-reading red flag (#859 item 3): the source's own cited instruction,
      // shown as a distinct, longer-lived error toast at the moment of logging.
      if (res.redFlag) {
        toast(res.redFlag, { tone: "error" });
      }
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

  // Explicit LOWER — selecting a labeled lower chip is sufficient intent. Optimistically
  // lowers, calls the narrow lower action, and reconciles. Preserves the day's note.
  async function lower(key: string, severity: number) {
    const prev = severities[key] ?? 0;
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
      {(showTitle || hasToggle) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {showTitle && (
            <p className="section-label">
              Daily symptoms
              <span
                data-testid="symptom-logged-count"
                className="ml-2 font-normal normal-case tracking-normal"
              >
                {loggedCount} logged
              </span>
            </p>
          )}
          {hasToggle && (
            <div
              data-testid="symptom-day-toggle"
              className="ml-auto inline-flex overflow-hidden rounded-md border border-black/10 text-xs dark:border-white/15"
            >
              <button
                type="button"
                data-testid="symptom-day-primary"
                aria-pressed={mode === "primary"}
                onClick={() => setMode("primary")}
                className={`px-2 py-1 ${mode === "primary" ? "bg-slate-100 font-medium text-slate-700 dark:bg-ink-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
              >
                {dateLabel}
              </button>
              <button
                type="button"
                data-testid="symptom-day-alt"
                aria-pressed={mode === "alt"}
                onClick={() => setMode("alt")}
                className={`px-2 py-1 ${mode === "alt" ? "bg-slate-100 font-medium text-slate-700 dark:bg-ink-800 dark:text-slate-100" : "text-slate-500 dark:text-slate-400"}`}
              >
                {altDateLabel}
              </button>
            </div>
          )}
        </div>
      )}

      <div
        data-testid="symptom-log-actions"
        className="mb-3 flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          data-testid="symptom-add-picker-toggle"
          aria-expanded={pickerOpen}
          aria-controls="symptom-add-picker"
          onClick={toggleSymptomPicker}
          className="btn-ghost btn-sm"
        >
          <IconChevronDown
            className={`h-3.5 w-3.5 transition-transform ${pickerOpen ? "rotate-180" : ""}`}
          />
          Add symptom
        </button>
        {showTemperature && (
          <button
            type="button"
            data-testid="temp-quick-toggle"
            aria-expanded={tempOpen}
            aria-controls="temp-quick-entry"
            onClick={toggleTemperatureEntry}
            className="btn-ghost btn-sm"
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 transition-transform ${tempOpen ? "rotate-180" : ""}`}
            />
            <span>Log temperature</span>
          </button>
        )}
      </div>

      {pickerOpen && (
        <div
          id="symptom-add-picker"
          data-testid="symptom-add-picker"
          className="mb-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
        >
          {textIntakeEnabled && (
            <div
              data-testid="symptom-text-intake"
              className="mb-3 border-b border-black/5 pb-3 dark:border-white/5"
            >
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void suggestFromText();
                }}
              >
                <input
                  data-testid="symptom-text-input"
                  value={intakeText}
                  onChange={(e) => {
                    setIntakeText(e.target.value);
                    if (intakeError) setIntakeError(null);
                  }}
                  placeholder="Describe it: “fever since lunch, croupy cough”…"
                  maxLength={500}
                  className="input h-8 flex-1 text-sm"
                />
                <button
                  type="submit"
                  data-testid="symptom-text-suggest"
                  disabled={intakePending || intakeText.trim() === ""}
                  className="badge cursor-pointer bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {intakePending ? "Reading…" : "Suggest"}
                </button>
              </form>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Review the suggestions and confirm — nothing is logged until you
                do.
              </p>

              {intakeError && (
                <p
                  role="alert"
                  data-testid="symptom-text-error"
                  className="mt-1 text-xs text-rose-600 dark:text-rose-400"
                >
                  {intakeError}
                </p>
              )}

              {intakeStaged && (
                <div
                  data-testid="symptom-text-staged"
                  className="mt-2 space-y-1.5"
                >
                  {intakeStaged.symptoms.map((s, idx) => (
                    <div
                      key={`${s.slug}-${idx}`}
                      data-testid={`symptom-text-staged-${idx}`}
                      className="flex items-center gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                        {s.label}
                        {s.isCustom && (
                          <span className="ml-1 text-xs text-slate-400">
                            (new)
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1">
                        {SYMPTOM_SEVERITY_LEVELS.map((lvl) => (
                          <button
                            key={lvl.value}
                            type="button"
                            aria-pressed={s.severity === lvl.value}
                            aria-label={`${s.label} — severity ${lvl.value} of ${MAX_SYMPTOM_SEVERITY} (${lvl.label})`}
                            title={lvl.label}
                            onClick={() => setStagedSeverity(idx, lvl.value)}
                            className={`h-5 w-5 rounded text-xs font-semibold ${
                              s.severity >= lvl.value
                                ? "bg-brand-600 text-white"
                                : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-400"
                            }`}
                          >
                            {lvl.value}
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-label={`Remove ${s.label} suggestion`}
                          onClick={() => dropStaged(idx)}
                          className="rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        >
                          <IconX className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {intakeStaged.temperature && (
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      🌡 Temperature {intakeStaged.temperature.value}°
                      {intakeStaged.temperature.unit} — will be logged
                    </div>
                  )}

                  {intakeStaged.unmapped.map((u, idx) => (
                    <div
                      key={`unmapped-${idx}`}
                      className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        Couldn&apos;t map: “{u}”
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void tap(u, 1);
                          dropUnmapped(idx);
                        }}
                        className="btn-ghost btn-sm border-dashed"
                      >
                        + Add as custom
                      </button>
                    </div>
                  ))}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      data-testid="symptom-text-confirm"
                      disabled={
                        intakePending ||
                        (intakeStaged.symptoms.length === 0 &&
                          !intakeStaged.temperature)
                      }
                      onClick={() => void confirmIntake()}
                      className="badge cursor-pointer bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                    >
                      {intakePending ? "Logging…" : "Confirm & log"}
                    </button>
                    <button
                      type="button"
                      data-testid="symptom-text-cancel"
                      onClick={() => setIntakeStaged(null)}
                      className="badge cursor-pointer bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

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
              className="input h-8 flex-1 text-sm"
            />
            <button
              type="submit"
              data-testid="symptom-custom-add"
              aria-label="Add symptom"
              className="btn-ghost h-8 w-8 p-0"
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}

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
            className="btn-ghost btn-sm border-dashed"
          >
            + Mark as illness
          </button>
        </div>
      )}

      {showTemperature && tempOpen && (
        <div
          id="temp-quick-entry"
          data-testid="temp-quick-entry"
          className="mb-3 rounded-lg border border-black/5 p-3 dark:border-white/5"
        >
          <label className="label mb-1 block" htmlFor="temp-quick-input">
            Temperature
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="col-span-2 flex min-w-0 gap-2 sm:col-span-1">
              <input
                id="temp-quick-input"
                data-testid="temp-quick-input"
                type="number"
                step="0.1"
                inputMode="decimal"
                autoFocus
                value={tempValue}
                onChange={(e) => {
                  const value = e.target.value;
                  setTempValue(value);
                  tempUnitDetection.readValue(value);
                  if (tempError) setTempError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void logTemp();
                  }
                }}
                placeholder="Thermometer reading"
                className="input min-w-0 flex-1"
              />
              <select
                data-testid="temp-quick-unit"
                aria-label="Temperature unit"
                value={tempUnit}
                onChange={(e) =>
                  tempUnitDetection.chooseUnit(
                    e.target.value === "C" ? "C" : "F"
                  )
                }
                className="input w-auto"
              >
                <option value="F">°F</option>
                <option value="C">°C</option>
              </select>
            </div>
            <input
              data-testid="temp-quick-time"
              type="time"
              aria-label="Reading time"
              value={tempTime}
              onChange={(e) => setTempTime(e.target.value)}
              className="input min-w-0 w-full"
            />
            <button
              type="button"
              data-testid="temp-quick-save"
              disabled={tempPending}
              onClick={() => void logTemp()}
              className="btn btn-sm"
            >
              {tempPending ? "Logging…" : "Log temp"}
            </button>
          </div>
          {tempUnitDetection.detectedUnit && (
            <p
              data-testid="temp-unit-detected"
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            >
              Detected °{tempUnitDetection.detectedUnit} from the reading.
            </p>
          )}
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
      )}

      {/* Picker guidance stays with the expanded picker instead of occupying the
          collapsed logger (#857). */}
      {pickerOpen && (
        <p
          data-testid="symptom-severity-legend"
          className="mb-3 text-xs text-slate-500 dark:text-slate-400"
        >
          Choose 1 (mild) to {MAX_SYMPTOM_SEVERITY} (very severe). The highest
          level logged for the day is kept.
        </p>
      )}

      {loggedCount === 0 ? (
        <p
          data-testid="symptom-none-logged"
          className="mb-3 text-xs text-slate-500 dark:text-slate-400"
        >
          No symptoms logged{hasToggle ? " for this day" : ""}.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="symptom-logged-list">
          {loggedKeys.map((key) => {
            const r = rowMap.get(key);
            if (!r) return null;
            const sev = severities[key] ?? 0;
            const note = notes[key] ?? "";
            const editingNote = noteEditing === key;
            return (
              <li
                key={key}
                data-testid={`symptom-${key}`}
                className="rounded-lg border border-black/5 p-3 dark:border-white/5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
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
                          if (lvl.value < sev) void lower(key, lvl.value);
                          else void tap(key, lvl.value);
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
                      className="input h-8 flex-1 text-sm"
                    />
                    <button
                      type="submit"
                      data-testid={`symptom-${key}-note-save`}
                      className="btn-ghost btn-sm"
                    >
                      Save
                    </button>
                  </form>
                )}

                {!editingNote && note && (
                  <NotesText
                    data-testid={`symptom-${key}-note`}
                    as="p"
                    notes={note}
                    className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
