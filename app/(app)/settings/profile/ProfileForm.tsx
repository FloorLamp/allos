"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveProfileSettings } from "./actions";
import { ageFromBirthdate, dateStrInTz, isRealIsoDate } from "@/lib/date";
import DateField from "@/components/DateField";
import SaveStatus from "@/components/SaveStatus";
import TimezoneSelect from "@/components/TimezoneSelect";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";
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
  homeLat: initialHomeLat,
  homeLng: initialHomeLng,
  skinType: initialSkinType,
}: {
  fullName: string | null;
  sex: Sex | null;
  reproductiveStatus: ReproductiveStatus | null;
  birthdate: string | null;
  age: number | null;
  timezone: string;
  weekStart: number;
  weekMode: string;
  homeLat: number | null;
  homeLng: number | null;
  skinType: number | null;
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
  // Home location (issue #570) — coarse coordinates driving sun/daylight features.
  const [homeLat, setHomeLat] = useState(
    initialHomeLat == null ? "" : String(initialHomeLat)
  );
  const [homeLng, setHomeLng] = useState(
    initialHomeLng == null ? "" : String(initialHomeLng)
  );
  const [geoError, setGeoError] = useState<string | null>(null);
  // Fitzpatrick skin type I–VI (#1172), stored "1".."6" — the burn (MED) threshold
  // for the overexposure side of the two-sided UV-dose sun model. "" = unset.
  const [skinType, setSkinType] = useState(
    initialSkinType == null ? "" : String(initialSkinType)
  );

  // With a birthdate set, the age is derived from it; otherwise the age field
  // below holds the manual/document fallback.
  const derivedAge = birthdate
    ? ageFromBirthdate(birthdate, dateStrInTz(timezone))
    : null;
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  function save(next: {
    fullName?: string;
    sex: Sex | "";
    reproductiveStatus?: ReproductiveStatus | "";
    birthdate: string;
    age: string;
    timezone: string;
    weekStart: number;
    weekMode: string;
    homeLat?: string;
    homeLng?: string;
    skinType?: string;
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
    // Always carry the current home coordinates so a save of another field never
    // wipes them; both blank clears the location (issue #570).
    fd.set("home_lat", next.homeLat ?? homeLat);
    fd.set("home_lng", next.homeLng ?? homeLng);
    // Carry the current skin type so a save of another field never wipes it.
    fd.set("skin_type", next.skinType ?? skinType);
    runSave(async () => {
      await saveProfileSettings(fd);
      router.refresh();
    });
  }

  return (
    <div ref={formRef} className="card max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Personal
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
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
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {birthdate
            ? "Age is derived from the birthdate."
            : "Set a birthdate for an exact age, or enter an age directly."}{" "}
          Either is also captured from uploaded documents when available.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <TimezoneSelect
          id="profile-timezone"
          value={timezone}
          onTimezoneChange={(nextTimezone) => {
            setTimezone(nextTimezone);
            save({
              sex,
              birthdate,
              age: ageFallback,
              timezone: nextTimezone,
              weekStart,
              weekMode,
            });
          }}
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Decides when each day rolls over — today/yesterday labels, streaks,
          the weekly summary, and notification timing.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <div className="flex items-center justify-between">
          <label className="label mb-0">Home location</label>
          <button
            type="button"
            data-testid="home-location-detect"
            onClick={() => {
              setGeoError(null);
              if (!navigator.geolocation) {
                setGeoError("Geolocation isn’t available in this browser.");
                return;
              }
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  // Round to a coarse ~11 km before it ever leaves the input; the
                  // server rounds again, so no street-precise value is stored.
                  const lat = (
                    Math.round(pos.coords.latitude * 10) / 10
                  ).toString();
                  const lng = (
                    Math.round(pos.coords.longitude * 10) / 10
                  ).toString();
                  setHomeLat(lat);
                  setHomeLng(lng);
                  save({
                    sex,
                    birthdate,
                    age: ageFallback,
                    timezone,
                    weekStart,
                    weekMode,
                    homeLat: lat,
                    homeLng: lng,
                  });
                },
                () => setGeoError("Couldn’t get your location.")
              );
            }}
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Use my location
          </button>
        </div>
        <div className="mt-1 flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={homeLat}
            data-testid="home-lat"
            placeholder="Latitude"
            aria-label="Home latitude"
            onChange={(e) => setHomeLat(e.target.value)}
            onBlur={() =>
              save({
                sex,
                birthdate,
                age: ageFallback,
                timezone,
                weekStart,
                weekMode,
              })
            }
            className="input"
          />
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            value={homeLng}
            data-testid="home-lng"
            placeholder="Longitude"
            aria-label="Home longitude"
            onChange={(e) => setHomeLng(e.target.value)}
            onBlur={() =>
              save({
                sex,
                birthdate,
                age: ageFallback,
                timezone,
                weekStart,
                weekMode,
              })
            }
            className="input"
          />
        </div>
        {geoError ? (
          <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
            {geoError}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Optional. Stored coarse (~11 km) and used only for sunrise/sunset and
          daylight features — never sent anywhere. Clear both fields to remove
          it.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Skin type (Fitzpatrick)</label>
        <select
          value={skinType}
          data-testid="skin-type"
          onChange={(e) => {
            const v = e.target.value;
            setSkinType(v);
            save({
              sex,
              birthdate,
              age: ageFallback,
              timezone,
              weekStart,
              weekMode,
              skinType: v,
            });
          }}
          className="input"
        >
          <option value="">Not set</option>
          <option value="1">I — always burns, never tans</option>
          <option value="2">II — usually burns, tans minimally</option>
          <option value="3">III — sometimes burns, tans uniformly</option>
          <option value="4">IV — rarely burns, tans easily</option>
          <option value="5">V — very rarely burns, tans darkly</option>
          <option value="6">VI — never burns</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Optional. Sets the burn-risk (UV overexposure) threshold for the
          sun-exposure model. Left unset, only the &ldquo;enough sun&rdquo; side
          is shown — the overexposure heads-up stays silent rather than
          guessing.
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
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {weekMode === "rolling"
            ? "Your weekly routine and week summary count the last 7 days, so they never reset to empty — the window always ends today."
            : "Your weekly routine and week summary reset on your week-start day, so a fresh week begins with empty counters."}
        </p>
      </div>
    </div>
  );
}
