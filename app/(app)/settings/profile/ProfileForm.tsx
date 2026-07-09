"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveProfileSettings } from "../actions";
import { ageFromBirthdate, dateStrInTz, isRealIsoDate } from "@/lib/date";
import DateField from "@/components/DateField";
import SaveStatus from "@/components/SaveStatus";
import type { ReproductiveStatus, Sex } from "@/lib/types";

// Biological sex, birthdate/age, and timezone — all PROFILE-scoped (properties of
// the tracked person). Follows the active profile.
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export default function ProfileForm({
  fullName: initialFullName,
  sex: initialSex,
  reproductiveStatus: initialReproductiveStatus,
  birthdate: initialBirthdate,
  age: initialAge,
  timezone: initialTimezone,
  weekStart: initialWeekStart,
  weekMode: initialWeekMode,
}: {
  fullName: string | null;
  sex: Sex | null;
  reproductiveStatus: ReproductiveStatus | null;
  birthdate: string | null;
  age: number | null;
  timezone: string;
  weekStart: number;
  weekMode: string;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState(initialFullName ?? "");
  const [sex, setSex] = useState<Sex | "">(initialSex ?? "");
  // Reproductive (menopausal) status — shown for female profiles only. Cleared when
  // the sex switches away from female (the server also forces it null in that case).
  const [reproductiveStatus, setReproductiveStatus] = useState<
    ReproductiveStatus | ""
  >(initialReproductiveStatus ?? "");
  const [birthdate, setBirthdate] = useState(initialBirthdate ?? "");
  // Manual age fallback, editable only when no birthdate is set (a birthdate
  // always derives the age and supersedes this). Seeded from a document-supplied
  // age when present.
  const [ageFallback, setAgeFallback] = useState(
    initialBirthdate || initialAge == null ? "" : String(initialAge)
  );
  const [timezone, setTimezone] = useState(initialTimezone);
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [weekMode, setWeekMode] = useState(initialWeekMode);

  // With a birthdate set, the age is derived from it; otherwise the age field
  // below holds the manual/document fallback.
  const derivedAge = birthdate
    ? ageFromBirthdate(birthdate, dateStrInTz(timezone))
    : null;
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);

  // Populate the IANA zone list on the client only. The list from
  // Intl.supportedValuesOf can differ between the server's ICU and the browser's,
  // so building it during SSR would cause a <select> hydration mismatch; instead
  // SSR renders just the current value and the full list fills in after mount.
  const [tzList, setTzList] = useState<string[]>([]);
  useEffect(() => {
    if (typeof (Intl as any).supportedValuesOf === "function") {
      setTzList((Intl as any).supportedValuesOf("timeZone"));
    }
  }, []);

  // Ensure the current value is always selectable (even before the list loads, or
  // if it's an alias the list omits).
  const zones = tzList.includes(timezone) ? tzList : [timezone, ...tzList];

  function save(next: {
    fullName?: string;
    sex: Sex | "";
    reproductiveStatus?: ReproductiveStatus | "";
    birthdate: string;
    age: string;
    timezone: string;
    weekStart: number;
    weekMode: string;
  }) {
    const fd = new FormData();
    fd.set("full_name", next.fullName ?? fullName);
    fd.set("sex", next.sex);
    // "" clears it; undefined (caller didn't touch it) falls back to current state.
    fd.set(
      "reproductive_status",
      next.reproductiveStatus ?? reproductiveStatus
    );
    fd.set("birthdate", next.birthdate);
    fd.set("age", next.age);
    fd.set("timezone", next.timezone);
    fd.set("week_start", String(next.weekStart));
    fd.set("week_mode", next.weekMode);
    startTransition(async () => {
      await saveProfileSettings(fd);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Personal
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <div>
        <label className="label">Full name</label>
        <input
          type="text"
          value={fullName}
          placeholder="e.g. Jane Q. Doe"
          onChange={(e) => setFullName(e.target.value)}
          onBlur={() => {
            if (fullName !== (initialFullName ?? ""))
              save({
                fullName,
                sex,
                birthdate,
                age: ageFallback,
                timezone,
                weekStart,
                weekMode,
              });
          }}
          className="input"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          The tracked person&rsquo;s full name, separate from the short profile
          label. Filled in from an uploaded health record when not already set.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Biological sex</label>
        <select
          value={sex}
          onChange={(e) => {
            const v = e.target.value as Sex | "";
            setSex(v);
            // Reproductive status applies to female physiology only — clear it when
            // the sex is anything else so it can't linger as stale data.
            const nextRs = v === "female" ? reproductiveStatus : "";
            setReproductiveStatus(nextRs);
            save({
              sex: v,
              reproductiveStatus: nextRs,
              birthdate,
              age: ageFallback,
              timezone,
              weekStart,
              weekMode,
            });
          }}
          className="input"
        >
          <option value="">Not set</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Used to pick sex-specific optimal biomarker ranges (e.g. uric acid).
          Other biomarkers use their general optimal range until a sex-specific
          one is added.
        </p>

        {sex === "female" && (
          <div className="mt-5">
            <label className="label">Reproductive status</label>
            <select
              value={reproductiveStatus}
              onChange={(e) => {
                const v = e.target.value as ReproductiveStatus | "";
                setReproductiveStatus(v);
                save({
                  sex,
                  reproductiveStatus: v,
                  birthdate,
                  age: ageFallback,
                  timezone,
                  weekStart,
                  weekMode,
                });
              }}
              className="input mt-1"
            >
              <option value="">Not specified</option>
              <option value="premenopausal">Premenopausal</option>
              <option value="postmenopausal">Postmenopausal</option>
            </select>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Refines the reference ranges for the reproductive hormones
              (estradiol, FSH, LH). When set, it takes precedence over the
              age-based estimate — so a post-menopausal high estradiol is
              flagged, while a still-cycling reproductive-age value is not.
              Leave as &ldquo;Not specified&rdquo; to use the age-based
              estimate.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Birthdate</label>
            <DateField
              value={birthdate}
              max={dateStrInTz(timezone)}
              onChange={(v) => {
                // DateField emits the raw text on every keystroke, so mirror the
                // stored value locally but only PERSIST a real, in-range date (or
                // an explicit clear). Otherwise a partial/invalid intermediate —
                // or a friendly-formatted display string — would reach the server
                // and null out the stored birthdate, and a typed future date would
                // bypass the `max` guard. (Same ISO gate ActivityForm uses.)
                setBirthdate(v);
                const today = dateStrInTz(timezone);
                if (v !== "" && !(isRealIsoDate(v) && v <= today)) return;
                // A birthdate supersedes the manual age; clear it so the two
                // never disagree.
                if (v) setAgeFallback("");
                save({
                  sex,
                  birthdate: v,
                  age: v ? "" : ageFallback,
                  timezone,
                  weekStart,
                  weekMode,
                });
              }}
            />
          </div>
          <div>
            <label className="label">Age</label>
            <input
              type="number"
              min={1}
              max={150}
              // Derived (read-only) when a birthdate is set; editable otherwise.
              value={birthdate ? (derivedAge ?? "") : ageFallback}
              disabled={!!birthdate}
              title={birthdate ? "Derived from the birthdate" : "Age in years"}
              onChange={(e) => {
                const v = e.target.value;
                setAgeFallback(v);
                save({
                  sex,
                  birthdate,
                  age: v,
                  timezone,
                  weekStart,
                  weekMode,
                });
              }}
              className="input disabled:opacity-60"
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {birthdate
            ? "Age is derived from the birthdate."
            : "Set a birthdate for an exact age, or enter an age directly."}{" "}
          Either is also captured from uploaded documents when available.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <div className="flex items-center justify-between">
          <label className="label mb-0">Timezone</label>
          <button
            type="button"
            onClick={() => {
              const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
              if (detected) {
                setTimezone(detected);
                save({
                  sex,
                  birthdate,
                  age: ageFallback,
                  timezone: detected,
                  weekStart,
                  weekMode,
                });
              }
            }}
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Detect from browser
          </button>
        </div>
        <select
          value={timezone}
          onChange={(e) => {
            const v = e.target.value;
            setTimezone(v);
            save({
              sex,
              birthdate,
              age: ageFallback,
              timezone: v,
              weekStart,
              weekMode,
            });
          }}
          className="input mt-1"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Decides when each day rolls over — today/yesterday labels, streaks,
          the weekly summary, and notification timing.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Week starts on</label>
        <select
          value={weekStart}
          onChange={(e) => {
            const v = Number(e.target.value);
            setWeekStart(v);
            save({
              sex,
              birthdate,
              age: ageFallback,
              timezone,
              weekStart: v,
              weekMode,
            });
          }}
          className="input mt-1"
        >
          {WEEKDAYS.map((name, i) => (
            <option key={i} value={i}>
              {name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          The first day of the week for calendars and the weekly cardio chart —
          and, on a calendar week (below), where the weekly routine resets.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Weekly routine counts</label>
        <select
          value={weekMode}
          onChange={(e) => {
            const v = e.target.value;
            setWeekMode(v);
            save({
              sex,
              birthdate,
              age: ageFallback,
              timezone,
              weekStart,
              weekMode: v,
            });
          }}
          className="input mt-1"
        >
          <option value="calendar">The current calendar week</option>
          <option value="rolling">A rolling 7-day window</option>
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {weekMode === "rolling"
            ? "Your weekly routine and week summary count the last 7 days, so they never reset to empty — the window always ends today."
            : "Your weekly routine and week summary reset on your week-start day, so a fresh week begins with empty counters."}
        </p>
      </div>
    </div>
  );
}
