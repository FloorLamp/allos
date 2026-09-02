"use client";

import { useRef, useState } from "react";
import { saveProfileSettings } from "./actions";
import { ageFromBirthdate, dateStrInTz, isRealIsoDate } from "@/lib/date";
import DateField from "@/components/DateField";
import SaveStatus from "@/components/SaveStatus";
import SettingsAdvanced from "../SettingsAdvanced";
import TimezoneSelect from "@/components/TimezoneSelect";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";
import { useToast } from "@/components/Toast";
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
  const toast = useToast();
  // ONE draft for the whole card, owned by the hook. Every control saves the entire
  // form, so a save of one field can never wipe another (issue #570's home
  // coordinates were the case that used to need remembering), and a refused save
  // puts every field back at once.
  const {
    pending,
    savedAt,
    error,
    value: draft,
    edit,
    save: runSave,
  } = useSaveStatus({
    fullName: initialFullName ?? "",
    sex: (initialSex ?? "") as Sex | "",
    // Reproductive (menopausal) status — shown for female profiles only. Cleared when
    // the sex switches away from female (the server also forces it null in that case).
    reproductiveStatus: (initialReproductiveStatus ?? "") as
      ReproductiveStatus | "",
    birthdate: initialBirthdate ?? "",
    // Manual age fallback, editable only when no birthdate is set (a birthdate
    // always derives the age and supersedes this). Seeded from a document-supplied
    // age when present.
    ageFallback:
      initialBirthdate || initialAge == null ? "" : String(initialAge),
    timezone: initialTimezone,
    weekStart: initialWeekStart,
    weekMode: initialWeekMode,
    // Home location (issue #570) — coarse coordinates driving sun/daylight features.
    homeLat: initialHomeLat == null ? "" : String(initialHomeLat),
    homeLng: initialHomeLng == null ? "" : String(initialHomeLng),
    // Fitzpatrick skin type I–VI (#1172), stored "1".."6" — the burn (MED) threshold
    // for the overexposure side of the two-sided UV-dose sun model. "" = unset.
    skinType: initialSkinType == null ? "" : String(initialSkinType),
  });
  const {
    fullName,
    sex,
    reproductiveStatus,
    birthdate,
    ageFallback,
    timezone,
    weekStart,
    weekMode,
    homeLat,
    homeLng,
    skinType,
  } = draft;
  const [geoError, setGeoError] = useState<string | null>(null);

  // With a birthdate set, the age is derived from it; otherwise the age field
  // below holds the manual/document fallback.
  const derivedAge = birthdate
    ? ageFromBirthdate(birthdate, dateStrInTz(timezone))
    : null;
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  function save(next: typeof draft) {
    const fd = new FormData();
    fd.set("full_name", next.fullName);
    fd.set("sex", next.sex);
    fd.set("reproductive_status", next.reproductiveStatus);
    fd.set("birthdate", next.birthdate);
    fd.set("age", next.ageFallback);
    fd.set("timezone", next.timezone);
    fd.set("week_start", String(next.weekStart));
    fd.set("week_mode", next.weekMode);
    fd.set("home_lat", next.homeLat);
    fd.set("home_lng", next.homeLng);
    fd.set("skin_type", next.skinType);
    runSave(next, async () => {
      const res = await saveProfileSettings(fd);
      // Close the findings loop (#1305): if this save satisfied a structural data-quality
      // gap, acknowledge it via the shared toast — the settings autosave path (#794).
      if (res?.closureToast) toast(res.closureToast);
    });
  }

  return (
    <div ref={formRef} className="card space-y-5">
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
          onChange={(e) => edit({ ...draft, fullName: e.target.value })}
          onBlur={() => {
            if (fullName !== (initialFullName ?? "")) save(draft);
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
            save({
              ...draft,
              sex: v,
              // Reproductive status applies to female physiology only — clear it
              // when the sex is anything else so it can't linger as stale data.
              reproductiveStatus: v === "female" ? reproductiveStatus : "",
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
              onChange={(e) =>
                save({
                  ...draft,
                  reproductiveStatus: e.target.value as ReproductiveStatus | "",
                })
              }
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
              data-testid="profile-birthdate"
              value={birthdate}
              max={dateStrInTz(timezone)}
              onChange={(v) => {
                // DateField emits the raw text on every keystroke, so mirror the
                // stored value locally but only PERSIST a real, in-range date (or
                // an explicit clear). Otherwise a partial/invalid intermediate —
                // or a friendly-formatted display string — would reach the server
                // and null out the stored birthdate, and a typed future date would
                // bypass the `max` guard. (Same ISO gate ActivityForm uses.)
                const today = dateStrInTz(timezone);
                if (v !== "" && !(isRealIsoDate(v) && v <= today)) {
                  edit({ ...draft, birthdate: v });
                  return;
                }
                save({
                  ...draft,
                  birthdate: v,
                  // A birthdate supersedes the manual age; clear it so the two
                  // never disagree.
                  ageFallback: v ? "" : ageFallback,
                });
              }}
            />
          </div>
          <div>
            <label className="label">Age</label>
            <input
              type="number"
              // 0 is enterable (issue #2992): an infant's age in whole years is
              // zero. "Unknown" is the blank field, not a floor on the number.
              min={0}
              max={150}
              // Derived (read-only) when a birthdate is set; editable otherwise.
              value={birthdate ? (derivedAge ?? "") : ageFallback}
              disabled={!!birthdate}
              onChange={(e) => save({ ...draft, ageFallback: e.target.value })}
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
          onTimezoneChange={(nextTimezone) =>
            save({ ...draft, timezone: nextTimezone })
          }
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Decides when each day rolls over — today/yesterday labels, streaks,
          the weekly summary, and notification timing.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Week starts on</label>
        <select
          value={weekStart}
          onChange={(e) =>
            save({ ...draft, weekStart: Number(e.target.value) })
          }
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
          and, on a calendar week (below), where the weekly targets reset.
        </p>
      </div>

      <div className="border-t border-black/5 pt-5 dark:border-white/10">
        <label className="label">Weekly targets count</label>
        <select
          value={weekMode}
          onChange={(e) => save({ ...draft, weekMode: e.target.value })}
          className="input mt-1"
        >
          <option value="calendar">The current calendar week</option>
          <option value="rolling">A rolling 7-day window</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {weekMode === "rolling"
            ? "Your weekly targets and week summary count the last 7 days, so they never reset to empty — the window always ends today."
            : "Your weekly targets and week summary reset on your week-start day, so a fresh week begins with empty counters."}
        </p>
      </div>

      {/* Advanced (#1462 §3): a home location you set once and a Fitzpatrick
          skin type are one-time setup, not settings anyone revisits — they sat
          at equal rank with the birthdate and helped make this page a scroll
          wall. Same form, same single save; just folded away by default. */}
      <SettingsAdvanced
        testId="health-advanced"
        hint="home location, skin type"
      >
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
                    save({ ...draft, homeLat: lat, homeLng: lng });
                  },
                  () => setGeoError("Couldn’t get your location.")
                );
              }}
              className="text-xs text-link"
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
              onChange={(e) => edit({ ...draft, homeLat: e.target.value })}
              onBlur={() => save(draft)}
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
              onChange={(e) => edit({ ...draft, homeLng: e.target.value })}
              onBlur={() => save(draft)}
              className="input"
            />
          </div>
          {geoError ? (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
              {geoError}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Optional. Stored coarse (~11 km) and used only for sunrise/sunset
            and daylight features — never sent anywhere. Clear both fields to
            remove it.
          </p>
        </div>

        <div className="border-t border-black/5 pt-5 dark:border-white/10">
          <label className="label">Skin type (Fitzpatrick)</label>
          <select
            value={skinType}
            data-testid="skin-type"
            onChange={(e) => save({ ...draft, skinType: e.target.value })}
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
            sun-exposure model. Left unset, only the &ldquo;enough sun&rdquo;
            side is shown — the overexposure heads-up stays silent rather than
            guessing.
          </p>
        </div>
      </SettingsAdvanced>
    </div>
  );
}
