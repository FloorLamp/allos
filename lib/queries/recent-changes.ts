// The recent-changes COLLECTOR (#1463 §2, consumed at 24h by #1713).
//
// ONE auth-blind, profileId-first gather composing EXISTING per-profile readers —
// the #1009 household-history pattern generalized. No new cross-profile SQL, so the
// profile-scoping rule holds with no new allowlist entry; every statement this calls
// through already filters by profile_id, and the two statements it owns do too.
//
// Two windows, one definition:
//   • the Household member card (#1463) asks for 7 days;
//   • the morning digest (#1713) asks for 24 hours.
// Both format the SAME result. A second per-category set of digest fields would be a
// second definition of "what changed" and would drift (#221).
//
// The ranking, floors, cap and demotion live in lib/recent-changes.ts (pure). This
// module only resolves the readers and the subject context, then hands over.

import { today as todayFor } from "../db";
import { db } from "../db";
import {
  applyRecentChangeDemotion,
  RECENT_CHANGE_CATEGORIES,
  rankRecentChanges,
  recentChangeWindowStart,
  renderRecentChanges,
  type RecentChange,
  type RecentChangeCategory,
  type RecentChangeRender,
} from "../recent-changes";
import { lifeStage } from "../life-stage";
import { getUserAge } from "../settings";
import {
  getCurrentFlaggedBiomarkers,
  getCurrentFlaggedVitals,
} from "./medical";
import { getEncounters } from "./medical/encounters";
import { getMoodLogs } from "./mood";
import { getSymptomDaysInRange } from "./symptoms";
import { getIntegration } from "../integrations/registry";
import type { IntegrationId } from "../types/integrations";
import { currentEpisodeForProfile } from "../illness-episode";
import { sharedSurfaceDetail } from "../appointment-sensitivity";
import { biomarkerFamily } from "../canonical-name";
import type { AppRoute } from "../hrefs";
import { getIntakeDeltas } from "../intake-history";

export interface RecentChangesOptions {
  // The window length in days, ending at (and including) `today`.
  sinceDays: number;
  // The profile-local date the window ends at. Resolved by the caller in the
  // SUBJECT's timezone (#1463 §3) — never the viewer's.
  today?: string;
  // Categories to leave out entirely. The digest excludes `labs` because it already
  // renders newly-flagged LAB results from its own send cursor (a different window,
  // the same underlying getCurrentFlaggedBiomarkers computation) — collecting them
  // twice would double-report one finding, not add one.
  exclude?: readonly RecentChangeCategory[];
  // Categories the reader has demoted (#1714) — only their notable entries survive.
  demoted?: readonly RecentChangeCategory[];
  // A SHARED surface (the household card) masks behavioral-health visits. A profile's
  // own surfaces (its digest) pass false and see full detail.
  shared?: boolean;
  // Line cap and overflow copy.
  max?: number;
  overflowLabel?: string;
  overflowHref?: AppRoute | null;
}

export interface RecentChangesResult extends RecentChangeRender {
  // The ranked changes behind `lines`, uncapped — so a caller that renders its own
  // chrome (chips, links) has the structured form without re-deriving the order.
  changes: RecentChange[];
  // Every category that produced at least one change BEFORE demotion (#1714). The
  // ⚙️ Tune control offers "the categories present in today's message", which is this
  // set — computed pre-filter, so a category the reader has already demoted is still
  // reported as present and its toggle stays reachable.
  presentCategories: RecentChangeCategory[];
}

// The behavioral-health visit test. Encounters carry no AppointmentKind column, so
// the kind is derived from the free-text type/reason and then routed through the ONE
// shared decision (`sharedSurfaceDetail`) rather than a second privacy rule here.
function encounterLooksBehavioralHealth(
  type: string | null,
  reason: string | null
): boolean {
  const t = `${type ?? ""} ${reason ?? ""}`.toLowerCase();
  return /\b(psychiatr|psycholog|mental health|behavioral health|therapy|therapist|counsel)/.test(
    t
  );
}

// "Tue" — the compact weekday a visit/vitals line ends with.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? dateStr;
}

// Successful syncs in the window that actually WROTE something — "what arrived
// overnight", the half of #1713's data category nothing reports today.
//
// STALENESS IS NOT RE-DERIVED HERE. #1685 already owns "a source has gone quiet"
// end to end (staleSyncIssues → getIntegrationAttention → the digest's Today lines,
// the Upcoming page and the Data → Review badge). Computing a second staleness
// notion in the collector would be exactly the #221 drift these issues are about, so
// this category reports ARRIVAL only and defers the quiet-source line to the engine
// that already renders it in this same message.
function arrivalChanges(profileId: number, sinceTs: string): RecentChange[] {
  const rows = db
    .prepare(
      `SELECT provider,
              SUM(COALESCE(inserted, 0)) AS inserted,
              MAX(at) AS at
         FROM integration_sync_events
        WHERE profile_id = ? AND ok = 1 AND at > ?
        GROUP BY provider
        HAVING SUM(COALESCE(inserted, 0)) > 0
        ORDER BY inserted DESC, provider`
    )
    .all(profileId, sinceTs) as {
    provider: string;
    inserted: number;
    at: string;
  }[];
  return rows.map((r) => {
    const name =
      getIntegration(r.provider as IntegrationId)?.name ?? r.provider;
    return {
      id: `data:${r.provider}`,
      category: "data" as const,
      // Dateless: arrival is about NOW, not about a logged day.
      date: null,
      text: `📥 ${name}: ${r.inserted} new record${r.inserted === 1 ? "" : "s"}`,
    };
  });
}

// Mood / the daily check-in (#992). The #992/#716 sensitivity contract governs the
// copy: report the VALUE and any notable shift, never a judgment ("you seem low"),
// never a streak ("3 good days"). The shift is stated as a direction against the
// subject's OWN recent average, with no adjective attached.
const MOOD_BASELINE_DAYS = 14;
const MOOD_SHIFT_POINTS = 1;

function moodChanges(
  profileId: number,
  windowStart: string,
  today: string
): RecentChange[] {
  const baselineFrom = recentChangeWindowStart(today, MOOD_BASELINE_DAYS);
  const logs = getMoodLogs(profileId, baselineFrom);
  const inWindow = logs.filter((l) => l.date >= windowStart && l.date <= today);
  if (inWindow.length === 0) return [];
  const latest = inWindow[inWindow.length - 1];
  const priors = logs.filter((l) => l.date < windowStart);
  let shift = "";
  if (priors.length >= 3) {
    const mean =
      priors.reduce((s, l) => s + l.valence, 0) / Math.max(1, priors.length);
    const delta = latest.valence - mean;
    if (Math.abs(delta) >= MOOD_SHIFT_POINTS) {
      shift =
        delta > 0
          ? " · above your recent average"
          : " · below your recent average";
    }
  }
  const energy = latest.energy != null ? ` · energy ${latest.energy}/5` : "";
  return [
    {
      id: `mood:${latest.date}`,
      category: "mood",
      date: latest.date,
      text: `🙂 Check-in: mood ${latest.valence}/5${energy}${shift}`,
      // A notable SHIFT survives per-category demotion; a routine check-in does not.
      notable: shift !== "",
    },
  ];
}

// THE collector. Auth-blind, profileId-first, composing existing readers only.
export function collectRecentChanges(
  profileId: number,
  opts: RecentChangesOptions
): RecentChangesResult {
  const today = opts.today ?? todayFor(profileId);
  const windowStart = recentChangeWindowStart(today, opts.sinceDays);
  // The import cursor for the two flagged-reading reads: midnight at the window's
  // first day, in the same "YYYY-MM-DD HH:MM:SS" shape created_at carries.
  const sinceTs = `${windowStart} 00:00:00`;
  const exclude = new Set(opts.exclude ?? []);
  const on = (c: RecentChangeCategory) => !exclude.has(c);

  const changes: RecentChange[] = [];
  const loopClosureIds = new Set<string>();

  // ── labs (#1463 base 1) ──────────────────────────────────────────────────────
  // The SAME getCurrentFlaggedBiomarkers every flagged surface reads, at this
  // window. Flagged ⇒ the floor class.
  if (on("labs")) {
    for (const r of getCurrentFlaggedBiomarkers(profileId, sinceTs)) {
      const id = `labs:${r.canonicalName ?? r.name}:${r.date}`;
      changes.push({
        id,
        category: "labs",
        date: r.date,
        text: `🚩 ${r.name}${r.value ? ` ${r.value}` : ""} (${r.flag})`,
        flagged: true,
      });
    }
  }

  // ── visits (#1463 base 2) ────────────────────────────────────────────────────
  if (on("visits")) {
    for (const e of getEncounters(profileId)) {
      if (e.date < windowStart || e.date > today) continue;
      // §3 masking INSIDE the collector, so no formatter can forget it. A profile's
      // own surface (shared:false) always sees full detail.
      const detail = opts.shared
        ? sharedSurfaceDetail(
            encounterLooksBehavioralHealth(e.type, e.reason)
              ? "mental_health"
              : null,
            "full"
          )
        : "full";
      const label =
        detail === "minimal"
          ? "Medical appointment"
          : (e.provider_name ?? e.type ?? e.reason ?? "Visit");
      changes.push({
        id: `visits:${e.id}`,
        category: "visits",
        date: e.date,
        text: `🏥 ${label} · ${weekdayLabel(e.date)}`,
      });
    }
  }

  // ── growth (#1463 base 3, minors only) ───────────────────────────────────────
  // Life-stage gated at the collector, not the formatter. Height is the growth
  // series every pediatric surface reads (`height_cm` metric samples).
  const stage = lifeStage(getUserAge(profileId));
  const minor =
    stage === "infant" || stage === "child" || stage === "adolescent";
  if (on("growth") && minor) {
    const rows = db
      .prepare(
        `SELECT date, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'height_cm'
            AND date >= ? AND date <= ?
          ORDER BY date DESC LIMIT 1`
      )
      .all(profileId, windowStart, today) as {
      date: string;
      value: number;
    }[];
    for (const r of rows) {
      changes.push({
        id: `growth:${r.date}`,
        category: "growth",
        date: r.date,
        text: `📏 Height ${Math.round(r.value * 10) / 10} cm · ${weekdayLabel(r.date)}`,
      });
    }
  }

  // ── intake changes (#1463 base 4) ────────────────────────────────────────────
  // v1 covers the lifecycle events that carry a real timestamp: an item STARTED in
  // the window (`intake_items.created_at`). Pause and retire are deliberately
  // OMITTED rather than approximated — neither carries a change timestamp today,
  // and #1463's implementer note is explicit that a missing timestamp means the
  // event kind waits for one rather than being guessed from row state.
  if (on("intake")) {
    const started = db
      .prepare(
        `SELECT id, name, kind, date(created_at) AS started
           FROM intake_items
          WHERE profile_id = ? AND date(created_at) >= ? AND date(created_at) <= ?
          ORDER BY created_at DESC`
      )
      .all(profileId, windowStart, today) as {
      id: number;
      name: string;
      kind: string;
      started: string;
    }[];
    for (const it of started) {
      changes.push({
        id: `intake:${it.id}`,
        category: "intake",
        date: it.started,
        text: `🔁 Started ${it.name}`,
      });
    }
  }

  // ── vitals (#1463 base 5, out-of-range widened by #1713) ─────────────────────
  // The missing half #1713 names: a BP spike or a low SpO₂ logged yesterday. It uses
  // the vitals twin of the flagged-lab read (same CTEs, `category = 'vitals'`), so
  // "out of range" means exactly what it means everywhere else — the reconciled
  // canonical flag — and never a threshold invented here.
  //
  // Resting HR and HRV are NOT reported as out-of-range in v1: neither has a
  // canonical reference range, and inventing a personal threshold would be the
  // system deciding on the user's behalf what counts as abnormal. They stay on the
  // Body surfaces until a declared expectation exists.
  if (on("vitals")) {
    const flaggedVitals = getCurrentFlaggedVitals(profileId, sinceTs);
    for (const r of flaggedVitals) {
      changes.push({
        id: `vitals:${r.canonicalName ?? r.name}:${r.date}`,
        category: "vitals",
        date: r.date,
        text: `🩺 ${r.name}${r.value ? ` ${r.value}` : ""} (${r.flag}) · ${weekdayLabel(r.date)}`,
        flagged: true,
      });
    }
    // Loop closure: a vital or lab whose FAMILY also carries an earlier flagged
    // reading is a recheck arriving, the strongest lab-relevance case (#1463 §2b).
    const flaggedFamilies = new Set(
      [...getCurrentFlaggedBiomarkers(profileId), ...flaggedVitals].map((r) =>
        biomarkerFamily(r.canonicalName ?? r.name)
      )
    );
    for (const c of changes) {
      if (c.category !== "labs" && c.category !== "vitals") continue;
      const name = c.id.split(":")[1] ?? "";
      if (flaggedFamilies.has(biomarkerFamily(name))) loopClosureIds.add(c.id);
    }
  }

  // ── symptoms (#1713) ─────────────────────────────────────────────────────────
  if (on("symptoms")) {
    for (const day of getSymptomDaysInRange(profileId, windowStart, today, 7)) {
      const names = day.symptoms.map((s) => s.symptom).join(", ");
      changes.push({
        id: `symptoms:${day.date}`,
        category: "symptoms",
        date: day.date,
        text: `🤕 ${names} · ${weekdayLabel(day.date)}`,
        // A severe symptom-day survives per-category demotion.
        notable: day.maxSeverity >= 4,
      });
    }
  }

  // ── mood / the daily check-in (#1713, #992 contract) ─────────────────────────
  if (on("mood")) changes.push(...moodChanges(profileId, windowStart, today));

  // ── data arrival (#1713) ─────────────────────────────────────────────────────
  if (on("data")) changes.push(...arrivalChanges(profileId, sinceTs));

  // Pre-demotion, so the Tune control (#1714) can offer a toggle for a category that
  // IS producing lines this reader has chosen not to see.
  const present = new Set(changes.map((c) => c.category));
  const kept = applyRecentChangeDemotion(changes, new Set(opts.demoted ?? []));
  const ranked = rankRecentChanges(kept, {
    lifeStage: stage,
    openEpisode: currentEpisodeForProfile(profileId) != null,
    loopClosureIds,
    // Member-relative regression, from the SAME intake-delta classifier the digest
    // headline and the weekly recap render (#221) — never an absolute threshold.
    adherenceRegression: getIntakeDeltas(profileId, today).missed.length > 0,
  });
  return {
    changes: ranked,
    presentCategories: RECENT_CHANGE_CATEGORIES.filter((c) => present.has(c)),
    ...renderRecentChanges(ranked, {
      max: opts.max,
      overflowLabel: opts.overflowLabel,
      overflowHref: opts.overflowHref,
    }),
  };
}
