"use server";
// Active-profile settings actions — the Profile tab (Settings → Profile). Split
// out of app/(app)/settings/actions.ts by auth tier (#319): every action here
// gates on requireWriteAccess() (properties of the tracked person, editable by any
// login with write access to the active profile). Re-exported from ../actions for
// back-compat import paths.
import { requireWriteAccess, requireAdmin } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import {
  getProfileSex,
  setProfileSex,
  getProfileBirthdate,
  setProfileBirthdate,
  getProfileFullName,
  setProfileFullName,
  getProfileReproductiveStatus,
  setProfileReproductiveStatus,
  getStoredAge,
  setStoredAge,
  getTimezone,
  setProfileFoodTelegram,
  setProfileMoodCheckin,
  setProfileMoodRecap,
  resetMoodCheckinIgnored,
  setProfileSleepDigest,
  setProfileWearReminder,
  setNotifySchedule,
  getProfileHomeAssistant,
  setProfileHomeAssistant,
  setExcludedFoodGroups,
  setProteinGoalLevel,
  isValidTimezone,
  setTimezone,
  setHomeLocation,
  setSkinType,
  isValidWeekStart,
  setWeekStart,
  isValidWeekMode,
  setWeekMode,
  setFreeDays,
  setMaxHrOverride,
  setZone2WeeklyTargetMin,
  setStepsDailyTarget,
  STEPS_TARGET_MAX,
  setRecommendationCadence,
  setMentalHealthShareFull,
  setProfileCrisisResourcesOverride,
  setAnxietyScaleOptIn,
  setProfileHouseholdRound,
  setDigestMinute,
  setDigestMode,
} from "@/lib/settings";
import { getDigestTimeSuggestion } from "@/lib/queries/digest-time-suggestion";
import { dismissFinding } from "@/lib/queries/upcoming/suppressions";
import type { DigestTimeExitResult } from "@/lib/digest-time-suggestion";
import { householdRoundOfferableMembers } from "@/lib/notifications/household-round-access";
import { buildHouseholdRound } from "@/lib/notifications/household-round";
import { dispatch } from "@/lib/notifications";
import { parseCrisisResourcesText } from "@/lib/crisis-resources";
import { parseCadence } from "@/lib/recommendation-run";
import { withFindingClosure, formatClosureToast } from "@/lib/finding-closure";
import { closureFindingSnapshot } from "@/lib/rule-findings";
import { DATA_QUALITY_PREFIX } from "@/lib/data-quality";
import { parseHome } from "@/lib/home-location";
import { parseSkinType } from "@/lib/uv-dose";
import { parseProteinGoalLevel } from "@/lib/protein";
import { reconcileFlags } from "@/lib/queries";
import { sweepIngestWindowForTimezoneChange } from "@/lib/integrations/ingest-timezone-sweep";
import {
  WAKING_START_HOUR,
  WAKING_END_HOUR,
  parseNotifyTime,
} from "@/lib/notifications/schedule";
import { parseDigestMode } from "@/lib/notifications/digest-schedule";
import { parseRecapScale } from "@/lib/recap-scale";
import { sendHomeAssistantTest } from "@/lib/notifications/home-assistant";
import {
  isValidWebhookUrl,
  parseDisabledKinds,
} from "@/lib/notifications/home-assistant-core";
import type { ReproductiveStatus, Sex } from "@/lib/types";

// ---- Profile scope (follows the active profile) ----

// Biological sex, birthdate/age, and timezone are properties of the tracked
// person, so they're keyed by profile.id. Any login acting as the profile may
// edit them (members included).
export async function saveProfileSettings(
  formData: FormData
): Promise<{ closureToast: string | null }> {
  const { profile } = await requireWriteAccess();

  // Close the findings loop (#1305): a birthdate/sex/reproductive-status fill here can
  // satisfy a structural data-quality gap ("Set a birthdate"), so bracket the write and
  // report which gap finding it cleared. The prefix is scoped to data-quality — other
  // fields (timezone, home location, …) diff nothing and toast nothing (the common case).
  const { cleared } = withFindingClosure(
    profile.id,
    [DATA_QUALITY_PREFIX],
    (pid, todayISO) =>
      closureFindingSnapshot(pid, [DATA_QUALITY_PREFIX], todayISO),
    () => saveProfileSettingsCore(profile.id, formData)
  );
  return { closureToast: formatClosureToast(cleared) };
}

// The auth-blind write core (profileId-first) — every persisted field + the reconcile/
// revalidate side effects. Extracted so the finding-closure wrapper can bracket it (#1305).
function saveProfileSettingsCore(profileId: number, formData: FormData): void {
  const profile = { id: profileId };

  // Biological sex: drives sex-specific optimal biomarker bands. When it
  // changes, re-derive the stored non-optimal flags so the records table and
  // range filters reflect the new optimal ranges.
  const raw = formData.get("sex");
  const sex: Sex | null =
    raw === "male" ? "male" : raw === "female" ? "female" : null;
  const sexChanged = sex !== getProfileSex(profile.id);
  if (sexChanged) setProfileSex(profile.id, sex);

  // Reproductive (menopausal) status — female physiology only. Only accept a value
  // when the sex is female; otherwise force null so switching away from female
  // clears any stale status. Like sex, a change re-derives the stored hormone flags.
  const rsRaw = formData.get("reproductive_status");
  const reproductiveStatus: ReproductiveStatus | null =
    sex === "female" &&
    (rsRaw === "premenopausal" || rsRaw === "postmenopausal")
      ? rsRaw
      : null;
  const rsChanged =
    reproductiveStatus !== getProfileReproductiveStatus(profile.id);
  if (rsChanged) setProfileReproductiveStatus(profile.id, reproductiveStatus);

  // Birthdate (ISO YYYY-MM-DD); the profile's age is derived from it. An <input
  // type="date"> emits either a valid date or "". Setting a birthdate also
  // clears any stored age fallback (handled in setProfileBirthdate).
  const bdRaw = String(formData.get("birthdate") ?? "").trim();
  const birthdate = /^\d{4}-\d{2}-\d{2}$/.test(bdRaw) ? bdRaw : null;
  const birthdateChanged = birthdate !== getProfileBirthdate(profile.id);
  if (birthdateChanged) setProfileBirthdate(profile.id, birthdate);

  // Manual age is editable only while no birthdate is set (a birthdate always
  // derives the age and clears this). Blank clears the fallback; an invalid
  // number is ignored so a fat-fingered entry can't wipe a good value.
  let ageChanged = false;
  if (!birthdate) {
    const ageRaw = String(formData.get("age") ?? "").trim();
    if (ageRaw === "") {
      if (getStoredAge(profile.id) !== null) {
        setStoredAge(profile.id, null);
        ageChanged = true;
      }
    } else {
      const age = Number(ageRaw);
      if (
        Number.isInteger(age) &&
        age > 0 &&
        age < 150 &&
        age !== getStoredAge(profile.id)
      ) {
        setStoredAge(profile.id, age);
        ageChanged = true;
      }
    }
  }

  // Sex, reproductive status, AND age all feed the age-banded / sex-specific
  // reference-range selection, so a change to ANY of them re-reconciles the stored
  // flags and refreshes the biomarker views (#628). Age matters because 26 analytes
  // carry ranges_by_age: filling in a child's birthdate later must recompute a
  // reading flagged against the adult fallback band to its correct pediatric band —
  // reconcileFlags recomputes each historical reading against its own reading-date
  // age (ageForRecord), so the trigger is all that's needed. Runs after birthdate/
  // age are persisted so the reconcile reads the new demographics.
  if (sexChanged || rsChanged || birthdateChanged || ageChanged) {
    reconcileFlags(profile.id);
    revalidateRoute("/results");
    revalidateRoute("/results/readings/view", "page");
  }

  // Full/legal name of the tracked person — distinct from the profile's display
  // name. Blank clears it. (Only save when the field was submitted, so callers
  // that don't render it can't wipe an adopted value.)
  if (formData.has("full_name")) {
    const fullName = String(formData.get("full_name") ?? "").trim();
    if (fullName !== (getProfileFullName(profile.id) ?? ""))
      setProfileFullName(profile.id, fullName || null);
  }

  // Timezone defines "today" for this profile (day-window queries, streaks,
  // reminders). Ignore an invalid value rather than throwing — keep the prior
  // setting.
  const tz = String(formData.get("timezone") ?? "").trim();
  if (tz && isValidTimezone(tz)) {
    const prevTz = getTimezone(profile.id);
    if (tz !== prevTz) {
      setTimezone(profile.id, tz);
      // The ingest tables that store profile-LOCAL time computed at ingest
      // (hr_minutes.ts and Health Connect body_metrics.date) re-key on a timezone
      // change, so the next rolling-window push would duplicate ~48h of data under the
      // shifted keys (#608). Sweep the current window's push-sourced rows so the next
      // push repopulates them cleanly under the new keys.
      sweepIngestWindowForTimezoneChange(profile.id);
    }
  }

  // Home location (issue #570): the coarse "where am I" coordinates that drive sun /
  // daylight features. Gated on the field's presence so a form that doesn't render it
  // never wipes an adopted value. Both blank → CLEAR; a valid pair → stored coarse
  // (setHomeLocation rounds to ~11 km); an invalid/partial pair is ignored (prior
  // value kept). Home location is PHI-adjacent — never logged.
  if (formData.has("home_lat") || formData.has("home_lng")) {
    const latRaw = String(formData.get("home_lat") ?? "").trim();
    const lngRaw = String(formData.get("home_lng") ?? "").trim();
    if (latRaw === "" && lngRaw === "") {
      setHomeLocation(profile.id, null);
    } else {
      const home = parseHome(latRaw, lngRaw);
      if (home) setHomeLocation(profile.id, home);
    }
  }

  // Fitzpatrick skin type (#1172): the burn (MED) threshold for the UV-dose
  // overexposure side. "" → CLEAR (unset → overexposure stays silent); "1".."6" →
  // stored. parseSkinType rejects anything else, so a bad value clears rather than
  // persists garbage.
  if (formData.has("skin_type")) {
    const raw = String(formData.get("skin_type") ?? "").trim();
    setSkinType(profile.id, raw === "" ? null : parseSkinType(raw));
  }

  // Week start (0=Sun … 6=Sat): where calendars break and, in calendar mode, when
  // the weekly-routine counters reset. Ignore a missing/empty/out-of-range value
  // rather than letting Number(null)===0 silently force Sunday.
  const wsRaw = String(formData.get("week_start") ?? "").trim();
  const ws = Number(wsRaw);
  if (wsRaw !== "" && isValidWeekStart(ws)) setWeekStart(profile.id, ws);

  // Weekly counting mode: calendar week vs rolling 7 days for the routine
  // counters and the training log week summary. Ignore an unrecognized value.
  const wm = String(formData.get("week_mode") ?? "").trim();
  if (isValidWeekMode(wm)) setWeekMode(profile.id, wm);

  // These affect display across the whole app.
  revalidateRoute("/", "layout");
}

// Smoking history (#83) and health risk factors (#517) moved to the Medical
// surface (/medical/background) with the emergency card (#928 — data about the
// person, not configuration; the #343 equipment precedent). Their write cores live
// in app/(app)/medical/background/actions.ts, still profile-scoped + requireWriteAccess.

// ---- Training HR zones (profile scope, issue #159) ----

// The manual max-HR override (bpm) and the weekly Zone 2 minutes target that drive
// the Trends → Fitness intensity-distribution view. Both profile-scoped properties
// of the tracked person; any login with write access may edit them. A blank/zero
// max-HR clears the override (falls back to the age formula); a blank Zone 2 target
// leaves the stored value untouched (its getter supplies the default).
export async function saveTrainingZones(formData: FormData) {
  const { profile } = await requireWriteAccess();

  const maxHrRaw = String(formData.get("max_hr_override") ?? "").trim();
  if (maxHrRaw === "") {
    setMaxHrOverride(profile.id, null);
  } else {
    const bpm = Number(maxHrRaw);
    // Guard an implausible entry rather than storing junk; a real max HR sits well
    // inside this band. Out-of-range input is ignored (keeps the prior value).
    if (Number.isFinite(bpm) && bpm >= 100 && bpm <= 240) {
      setMaxHrOverride(profile.id, Math.round(bpm));
    }
  }

  const targetRaw = String(
    formData.get("zone2_weekly_target_min") ?? ""
  ).trim();
  if (targetRaw !== "") {
    const min = Number(targetRaw);
    if (Number.isFinite(min) && min >= 0 && min <= 5000) {
      setZone2WeeklyTargetMin(profile.id, Math.round(min));
    }
  }

  // The DECLARED daily step target (#1723 part 2). Blank or 0 CLEARS it — a
  // first-class state, not an error: obligation is declared only, so the absence of a
  // number must be expressible. Out-of-band input is ignored rather than stored.
  const stepsRaw = String(formData.get("steps_daily_target") ?? "").trim();
  if (stepsRaw === "") {
    setStepsDailyTarget(profile.id, null);
  } else {
    const steps = Number(stepsRaw);
    if (Number.isFinite(steps) && steps >= 0 && steps <= STEPS_TARGET_MAX) {
      setStepsDailyTarget(profile.id, steps === 0 ? null : steps);
    }
  }

  revalidateRoute("/settings/training");
  revalidateRoute("/trends");
}

// Dietary preferences (#975) — the profile's excluded food-group set. Profile-scoped,
// member-editable (a property of the tracked person). The write core normalizes to
// canonical catalog slugs (dropping any unknown slug), so a forged post can't store junk;
// an empty set clears the row (Omnivore). Revalidates the nutrition surfaces the set
// filters/demotes.
// Free days (#1241): the per-profile off-day set that drives the social-jetlag
// split in the Sleep Regularity card. A 7-checkbox row on Settings → Profile
// autosaves through this action; the submitted `free_days` values are the checked
// weekday indices (0=Sun … 6=Sat). An empty submission is an explicit "no free
// days" (honored, not defaulted) — the form always renders all seven checkboxes,
// so a present submission can never accidentally wipe an intended value.
export async function saveFreeDays(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const days = formData
    .getAll("free_days")
    .map((v) => Number(String(v)))
    .filter((n) => Number.isInteger(n));
  setFreeDays(profile.id, days);
  revalidateRoute("/settings/health");
  revalidateRoute("/trends");
  return { ok: true };
}

export async function saveDietaryPreferences(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const slugs = formData.getAll("excluded").map((v) => String(v));
  setExcludedFoodGroups(profile.id, slugs);
  revalidateRoute("/settings/nutrition");
  revalidateRoute("/nutrition");
  return { ok: true };
}

// Protein goal level (#1503) — the training goal that picks the protein g/kg band.
// The band engine has read `training_goal` since #767 but nothing ever WROTE it, so
// every profile silently sat on the "active" band; this is the write half. Profile
// tier (a fact about the tracked person), so the same requireWriteAccess gate as the
// dietary preferences it sits beside. The submitted value is validated against the
// accepted vocabulary — an unknown string is refused, never stored to read back as
// the default.
export async function saveProteinGoal(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const level = parseProteinGoalLevel(
    String(formData.get("protein_goal") ?? "")
  );
  if (!level) return { ok: false as const, error: "Choose a protein goal." };
  setProteinGoalLevel(profile.id, level);
  revalidateRoute("/settings/nutrition");
  revalidateRoute("/nutrition");
  revalidateRoute("/");
  return { ok: true as const };
}

// Emergency card settings (#42) moved to the Medical surface (/medical/background)
// with smoking history + risk factors (#928). Write core in
// app/(app)/medical/background/actions.ts, still profile-scoped + requireWriteAccess.

// ---- Notifications: per-profile schedule + per-subject toggles (profile scope) ----

// The per-SUBJECT parts of notifications: the send schedule (slot hours, digest,
// recap, quiet hours) and the per-subject content opt-ins (food logging, mood,
// sleep). The DELIVERY CHANNEL (Telegram chat id + enable) is login-scoped as of
// issue #1072 — see saveLoginTelegram in ../actions — because the chat belongs to a
// person, not a data subject. The global bot credentials are admin-only
// (saveTelegramBotConfig).
export async function saveNotificationPrefs(formData: FormData) {
  const { profile } = await requireWriteAccess();

  // Food logging over Telegram (#682): the per-profile opt-in toggle. Gated on the
  // field's presence so a form that doesn't render it can't wipe the setting.
  if (formData.has("food_telegram_enabled")) {
    const v = formData.get("food_telegram_enabled");
    setProfileFoodTelegram(profile.id, v === "on" || v === "1");
  }

  // Daily mood check-in (#992): per-profile opt-in (off by default), plus the
  // weekly-recap mood-line opt-in. Same presence-gating as the food toggle.
  if (formData.has("mood_checkin_enabled")) {
    const v = formData.get("mood_checkin_enabled");
    const enable = v === "on" || v === "1";
    setProfileMoodCheckin(profile.id, enable);
    // Turning the check-in ON is an explicit re-engagement — clear any prior
    // ignored streak so an old auto-pause can't silently swallow the opt-in.
    if (enable) resetMoodCheckinIgnored(profile.id);
  }
  if (formData.has("mood_recap_enabled")) {
    const v = formData.get("mood_recap_enabled");
    setProfileMoodRecap(profile.id, v === "on" || v === "1");
  }

  // Bedtime wear reminder (#2161): per-profile OPT-IN, off by default. Presence-gated
  // like its neighbours so a form that doesn't render it can't wipe the setting — and
  // note what that gate also guarantees: this action is the ONLY writer, reached only
  // from the Settings checkbox the user ticked. Nothing in the tick, the gather, or
  // any detector may enable it on the user's behalf (the contact-consent rule: a
  // contact INCREASE needs the user's own declaration).
  if (formData.has("wear_reminder_enabled")) {
    const v = formData.get("wear_reminder_enabled");
    setProfileWearReminder(profile.id, v === "on" || v === "1");
  }

  // Morning-digest sleep summary (#1117): per-profile opt-in, presence-gated like
  // the mood toggle so a form that omits it can't wipe the setting.
  if (formData.has("digest_sleep_enabled")) {
    const v = formData.get("digest_sleep_enabled");
    setProfileSleepDigest(profile.id, v === "on" || v === "1");
  }

  // Per-slot send schedule at minute grain (#2121). "" / "off" → that window is
  // disabled; the form posts "HH:MM" (a legacy integer hour still parses, meaning
  // HH:00, so an old open tab can't corrupt a schedule mid-deploy).
  const time = (key: string): number | null => {
    const raw = String(formData.get(key) ?? "").trim();
    if (raw === "" || raw === "off") return null;
    return parseNotifyTime(raw, null, null);
  };
  // A required 0-23 hour with a fallback (the quiet-hours bounds are never "off" —
  // there is always a waking window; the widest is 0→23).
  const wakingHour = (key: string, fallback: number): number => {
    const raw = String(formData.get(key) ?? "").trim();
    const n = Number(raw);
    return raw !== "" && Number.isInteger(n) && n >= 0 && n <= 23
      ? n
      : fallback;
  };
  // Wake-aware "auto" state (#1117): the Morning intake slot can follow the
  // profile's wake time. "auto" is a distinct field value the reader
  // (getNotifySchedule) resolves — the write path just records the intent so an
  // unchanged re-save never freezes the resolved hour as a manual pick. The DIGEST
  // has no `auto` any more (#2211): it has a mode and a concrete time.
  const morningAuto =
    String(formData.get("supp_morning_hour") ?? "") === "auto";
  setNotifySchedule(profile.id, {
    supplementMinutes: {
      Morning: morningAuto ? null : time("supp_morning_hour"),
      Midday: time("supp_midday_hour"),
      Evening: time("supp_evening_hour"),
      Bedtime: time("supp_bedtime_hour"),
    },
    morningAuto,
    workoutEnabled:
      formData.get("workout_enabled") === "on" ||
      formData.get("workout_enabled") === "1",
    // Morning digest (#2211): "" / "off" → off; else the concrete time, which is the
    // send time in Static and the floor in Dynamic. The mode is user-owned and is
    // only ever written by a tap — an unrecognised value reads as Static rather than
    // silently enabling the mode that waits.
    digestMinute: time("digest_hour"),
    digestMode: parseDigestMode(String(formData.get("digest_mode") ?? "")),
    // Recap slot (#32): weekday 0-6, "" / "off" → off.
    weeklyRecapDay: (() => {
      const raw = String(formData.get("recap_day") ?? "").trim();
      if (raw === "" || raw === "off") return null;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
    })(),
    weeklyRecapMinute: time("recap_hour") ?? 9 * 60,
    // Recap cadence (#2178): the shortest period the slot may report on. An
    // unrecognised value parses to `week`, the default — a malformed submit must never
    // move someone to a quieter cadence they did not choose, because only the USER may
    // change how often they are contacted (contact-consent, docs/internals/findings.md).
    recapScale: parseRecapScale(String(formData.get("recap_scale") ?? "")),
    // Milestone alerts (#32): default on.
    milestonesEnabled:
      formData.get("milestones_enabled") === "on" ||
      formData.get("milestones_enabled") === "1",
    // Preventive-care reminders (#87): default on.
    preventiveEnabled:
      formData.get("preventive_enabled") === "on" ||
      formData.get("preventive_enabled") === "1",
    // Quiet hours (#450): the waking-window bounds for non-urgent episode nudges.
    // A blank/invalid field falls back to the default so a malformed submit can't
    // silence the profile; wrap-around (start > end) is allowed for night shifts.
    wakingStartHour: wakingHour("waking_start_hour", WAKING_START_HOUR),
    wakingEndHour: wakingHour("waking_end_hour", WAKING_END_HOUR),
  });
  revalidateRoute("/settings/notifications");
}

// ---- The digest time suggestion's three exits (#2217) ----------------------
//
// The engine DETECTS and SUGGESTS; the tap is the write (#1505). Each of these is one
// tap and one explicit write, and none of them is reachable except from a tap.
//
// THE PROPOSED MINUTE IS NEVER READ OFF THE BUTTON. Each action re-resolves the live
// suggestion server-side and writes what the detector says NOW — the #1670 ride-along's
// rule, and the reason a stale tab, a replayed form post or a forged field cannot write
// a time the detector would not currently propose. A tap on a suggestion that has since
// stopped firing writes NOTHING and says so.

// "Use 07:40" — write exactly the digest's send time, and nothing else.
export async function applyDigestTimeSuggestion(): Promise<DigestTimeExitResult> {
  const { profile } = await requireWriteAccess();
  const suggestion = getDigestTimeSuggestion(profile.id);
  if (!suggestion) return { ok: false, reason: "stale" };
  setDigestMinute(profile.id, suggestion.proposedMinute);
  revalidateRoute("/settings/notifications");
  return { ok: true, minute: suggestion.proposedMinute };
}

// The other exit: #2211's Dynamic mode, which solves the same problem by WAITING for
// the arrival instead of by scheduling past it. Writes the mode and nothing else — the
// stored minute stays exactly where it is and becomes the floor.
export async function switchDigestToDynamic(): Promise<DigestTimeExitResult> {
  const { profile } = await requireWriteAccess();
  const suggestion = getDigestTimeSuggestion(profile.id);
  if (!suggestion) return { ok: false, reason: "stale" };
  setDigestMode(profile.id, "dynamic");
  revalidateRoute("/settings/notifications");
  return { ok: true, minute: suggestion.configuredMinute };
}

// Declining is a FIRST-CLASS OUTCOME, not a deferral: a dismissed suggestion is
// dismissed. One row on the shared suppression bus, under the episode key BOTH surfaces
// resolve, so this silences the Settings row and the in-digest line together
// (constraint 5).
export async function dismissDigestTimeSuggestion(): Promise<DigestTimeExitResult> {
  const { profile } = await requireWriteAccess();
  const suggestion = getDigestTimeSuggestion(profile.id);
  if (!suggestion) return { ok: false, reason: "stale" };
  dismissFinding(profile.id, suggestion.dedupeKey);
  revalidateRoute("/settings/notifications");
  return { ok: true, minute: suggestion.configuredMinute };
}

// The Telegram "send test" is login-scoped as of #1072 (sendTestNotification in
// ../actions) — it verifies the login's OWN chat, not a profile fan-out.

// ---- Notifications: Home Assistant channel (profile scope, issue #248) ----

// The per-profile Home Assistant webhook TARGET: enable toggle, webhook URL, and the
// optional shared secret. Profile-scoped like the Telegram delivery target, so any
// login with write access to the profile may edit it. Rejects a malformed URL when
// enabling so a typo can't silently disable delivery.
//
// It does NOT own the per-kind routing (#1868 §1). That is `ha_notify_disabled_kinds`,
// edited by the matrix's HA column through saveHomeAssistantNotifyKinds below; this
// action carries the stored set through unchanged. (It used to DERIVE the set from
// `ha_kind_*` checkboxes on the card — the duplicate editor the issue removed — so
// preserving here is load-bearing: a form with no such fields would otherwise read as
// "every kind unchecked" and silence the whole channel on a URL edit.)
export async function saveHomeAssistantPrefs(
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { profile } = await requireWriteAccess();
  const enabled =
    formData.get("ha_enabled") === "on" || formData.get("ha_enabled") === "1";
  const webhookUrl = String(formData.get("ha_webhook_url") ?? "").trim();
  const secret = String(formData.get("ha_secret") ?? "").trim();

  if (enabled && !isValidWebhookUrl(webhookUrl)) {
    return {
      ok: false,
      error:
        "Enter a valid Home Assistant webhook URL (http(s)://host:8123/api/webhook/<id>).",
    };
  }

  setProfileHomeAssistant(profile.id, {
    enabled,
    webhookUrl,
    secret,
    disabledKinds: getProfileHomeAssistant(profile.id).disabledKinds,
  });
  revalidateRoute("/settings/notifications");
  return { ok: true };
}

// ---- Notification matrix columns (profile scope, issue #928) ----
// The kind × channel matrix on Settings → Notifications persists each column in its
// channel's tier store. The Telegram and Home Assistant columns are profile-scoped,
// so both gate on requireWriteAccess() like the rest of this module. The push column
// is login-scoped and lives in ../actions (savePushNotifyKinds). Each action takes
// the FULL disabled-kinds set for its column as a JSON `disabled_kinds` field,
// validated by the shared pure core (unknown kinds dropped). The HA action preserves
// the channel's enable/URL/secret and rewrites only the disabled set.

// The Telegram matrix column is login-scoped as of #1072
// (saveLoginTelegramNotifyKinds in ../actions).

export async function saveHomeAssistantNotifyKinds(
  formData: FormData
): Promise<{ ok: true }> {
  const { profile } = await requireWriteAccess();
  const disabled = parseDisabledKinds(
    String(formData.get("disabled_kinds") ?? "")
  );
  const cur = getProfileHomeAssistant(profile.id);
  setProfileHomeAssistant(profile.id, { ...cur, disabledKinds: disabled });
  revalidateRoute("/settings/notifications");
  return { ok: true };
}

// The AI recommendation-run cadence for the active profile (issue #424). Value is
// per-profile, but ADMIN-EDITABLE ONLY — the admin pays for the API key — so this
// gates on requireAdmin() (a member's Profile tab renders the control read-only).
export async function saveRecommendationCadence(formData: FormData) {
  const { profile } = await requireAdmin();
  const cadence = parseCadence(String(formData.get("recommendation_cadence")));
  setRecommendationCadence(profile.id, cadence);
  revalidateRoute("/settings/coaching");
  return { ok: true };
}

// Shared-surface detail for this profile's MENTAL-HEALTH visits (#997). Off by
// default (minimal on the household strip + family calendar); the owner may opt in
// to show them in full detail on those shared surfaces.
export async function saveMentalHealthShareFull(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const on =
    formData.get("mental_health_share_full") === "1" ||
    formData.get("mental_health_share_full") === "on";
  setMentalHealthShareFull(profile.id, on);
  revalidateRoute("/settings/privacy");
  revalidateRoute("/");
}

// The check-in Calm (anxiety) scale opt-in (issue #1313, signal 6). Flipping it on is
// the escape hatch that reveals the daily anxiety rating for a profile with no
// inferable mental-health signal; the dashboard check-in card re-derives the gate on
// its next render, so revalidate it.
export async function saveAnxietyScaleOptIn(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const on =
    formData.get("anxiety_scale_enabled") === "1" ||
    formData.get("anxiety_scale_enabled") === "on";
  setAnxietyScaleOptIn(profile.id, on);
  revalidateRoute("/settings/coaching");
  revalidateRoute("/");
}

// Per-profile crisis-resources OVERRIDE (#996) for a mixed-region household. Empty
// clears the override (inherit the instance default). Private to the profile.
export async function saveProfileCrisisResources(formData: FormData) {
  const { profile } = await requireWriteAccess();
  setProfileCrisisResourcesOverride(
    profile.id,
    parseCrisisResourcesText(String(formData.get("crisis_resources") ?? ""))
  );
  revalidateRoute("/settings/privacy");
  revalidateRoute("/crisis-resources");
}

// Send a test announcement to the profile's HA webhook, independent of the
// Telegram/push test (a household may run only HA). Reports the failure verbatim so
// a wrong URL / unreachable HA is visible.
export async function sendTestHomeAssistant(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { profile } = await requireWriteAccess();
  try {
    const result = await sendHomeAssistantTest(profile.id);
    if (result === "not-configured")
      return {
        ok: false,
        message:
          "No Home Assistant webhook configured — enable it and paste your HA webhook URL first.",
      };
    return { ok: true, message: "Sent ✅ — check Home Assistant." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---- Household dose round (issue #1459) ----
//
// The caregiver-subscribed cross-profile reminder: at this profile's schedule slots,
// the doses due for the OTHER household members it names. Profile-scoped like the rest
// of this module (requireWriteAccess on the RECEIVING profile — the person subscribing),
// and the member list it stores is DATA, never a grant: the submitted ids are narrowed
// here to what is currently offerable, and narrowed AGAIN at send and at button-tap
// time against live grants. A caregiver therefore cannot widen their reach by editing
// the form — a forged id is dropped on write and would be refused twice more anyway.
export async function saveHouseholdRound(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const enabled =
    formData.get("household_round_enabled") === "on" ||
    formData.get("household_round_enabled") === "1";
  const submitted = formData
    .getAll("household_round_members")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  const offerable = new Set(
    householdRoundOfferableMembers(profile.id).map((m) => m.profileId)
  );
  setProfileHouseholdRound(profile.id, {
    enabled,
    memberIds: submitted.filter((id) => offerable.has(id)),
  });
  revalidateRoute("/settings/notifications");
}

// Send the round as it stands RIGHT NOW to the receiving profile's channels — the §5
// send-test. Deliberately built over the SAME builder the tick uses (all four slots,
// so a test outside a slot hour still shows something), so what a caregiver sees here
// is what the tick would send, not a mock. An empty round reports why rather than
// sending an empty message.
export async function sendTestHouseholdRound(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { profile } = await requireWriteAccess();
  const round = buildHouseholdRound(profile.id, [
    "Morning",
    "Midday",
    "Evening",
    "Bedtime",
  ]);
  if (!round) {
    return {
      ok: false,
      message:
        "Nothing to send — no selected member has an unconfirmed scheduled dose right now. (An empty round never sends.)",
    };
  }
  try {
    const results = await dispatch(profile.id, round);
    return results.some((r) => r.ok)
      ? { ok: true, message: "Sent ✅ — check your Telegram." }
      : {
          ok: false,
          message:
            "No channel accepted it — check that Telegram is enabled for your login on this page.",
        };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
