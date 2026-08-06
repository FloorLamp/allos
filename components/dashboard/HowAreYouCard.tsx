"use client";

import { useState, useTransition, type ReactNode } from "react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import CheckInSection from "@/components/dashboard/CheckInSection";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { activateIllnessForSymptoms } from "@/app/(app)/symptom-actions";
import {
  toggleSituation,
  dismissDerivedPoorSleep,
} from "@/app/(app)/nutrition/supplement-actions";
import { logMood, resumeMoodCheckins } from "@/app/(app)/mood-actions";
import {
  MOOD_CHECKIN_PAUSED_LABEL,
  MOOD_FACTORS,
  ANXIETY_CALM_LOW_LABEL,
  ANXIETY_CALM_HIGH_LABEL,
  anxietyDisplaySlot,
  anxietyStoredValue,
  moodBackfillLabel,
} from "@/lib/mood";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  rateSummary,
  contextGroup,
  contextGroupHasChips,
  contextSummary,
  reportSummary,
  actSummary,
} from "@/lib/checkin-sections";
import MoodValencePicker from "@/components/MoodValencePicker";

// The recomposed daily check-in card (issue #1314, over #992). The card's four
// intents ARE its structure now, in fixed order under ONE CheckInSection grammar
// (components/dashboard/CheckInSection.tsx) — each section renders a glanceable
// one-liner at rest and opens only for input:
//
//   1. Rate    — the hero face row (one tap still completes the check-in) plus the
//                expansion: Energy, the relevance-gated Calm (#1313), and a note.
//   2. Context — the merged "What's going on?" chip group (#1311): sticky situations
//                (setActiveSituations) ∪ today-only work/social day-factors (the mood
//                -factor path). ONE rendering, two write paths correctly routed by
//                chip variant; the #662 activation line survives.
//   3. Report  — the illness door ("Not feeling well?" is a report, not a card-level
//                sibling). Defers to the hero cockpit while an episode is active (the
//                #858 hero owns the lifecycle — one lifecycle, one door).
//   4. Act     — the PRN meds quick-log slot (#1221 fold-in), server-rendered.
//
// The engines are unchanged — this is composition + gating, not new machinery: mood
// writes still go through the ONE logMood → upsertMoodLog core (idempotent per
// profile+date; an offline tap rides the quick-log queue), situations through the
// shared toggleSituation, illness through activateIllnessForSymptoms. Mood keeps its
// no-gamification / never-flagged / calm-observation-only contract.

export interface TodayMood {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
}

// One backfill-window day the card can log instead of today (#2128): the
// profile-local date and its already-logged check-in, if any, so switching the
// chip re-mirrors the face row to what that day holds.
export interface MoodBackfillDay {
  date: string;
  mood: TodayMood | null;
}

function ScaleRow({
  name,
  value,
  onPick,
  testPrefix,
  lowLabel,
  highLabel,
}: {
  name: string;
  value: number | null;
  onPick: (n: number) => void;
  testPrefix: string;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-xs text-slate-500 dark:text-slate-400">
        {name}
      </span>
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-400">{lowLabel}</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`${testPrefix}-${n}`}
            aria-pressed={value === n}
            onClick={() => onPick(n)}
            className={`h-7 w-7 rounded-full border text-xs ${
              value === n
                ? "border-brand-500 bg-brand-100 font-semibold text-brand-700 dark:bg-brand-900 dark:text-brand-300"
                : "border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
            }`}
          >
            {n}
          </button>
        ))}
        <span className="text-xs text-slate-400">{highLabel}</span>
      </div>
    </div>
  );
}

export default function HowAreYouCard({
  date,
  mood,
  activeEpisode,
  earlierDays = [],
  medsSlot = null,
  medsCount = 0,
  situations = null,
  anxietyRelevant = false,
  symptomSlot = null,
  symptomCount = 0,
  checkinsPaused = false,
}: {
  // The profile-local capture date — a queued offline tap lands on THIS day.
  date: string;
  // Today's already-logged check-in (null when unlogged). The upsert is per-day,
  // so a re-tap updates it.
  mood: TodayMood | null;
  // The #2128 backfill window, nearest day first (yesterday, then the day
  // before): the days the "yesterday" chips offer, each with its logged
  // check-in so the face row mirrors the selected day. Empty hides the chips.
  earlierDays?: MoodBackfillDay[];
  // Whether the acting profile has an open illness episode (the hero is up).
  activeEpisode: boolean;
  // Whether the evening reminder is currently AUTO-PAUSED after quiet days (#1668).
  // Derived state, never a stored flag — the card presents it and offers a one-tap
  // resume, so the pause stops reading as "notifications broke".
  checkinsPaused?: boolean;
  // The server-rendered PRN quick-log control (issue #1221), or null — passed ONLY on
  // a well day with active PRN meds. Rendered on the server (so lib/clock's frozen
  // clock applies) and threaded through this client boundary as an RSC node.
  medsSlot?: ReactNode;
  // The count of active PRN meds behind `medsSlot`, for the Act section summary.
  medsCount?: number;
  // The merged Context group's sticky half (issue #1311): the NON-clinical situation
  // chips (illness types excluded — that lifecycle is the illness door's) with each
  // chip's active state, plus the shared #662 activation line. The day-factor half
  // (work/social) is derived from MOOD_FACTORS + today's mood.factors below.
  situations?: {
    options: { name: string; active: boolean }[];
    activationLine: string | null;
    // The DERIVED-context state lines (#1292 Poor sleep, #1298 Period) — computed, not
    // toggled: rendered distinctly, non-toggleable, with a one-tap "Not today" that
    // rides the shared override action (poor-sleep only, and only when derived).
    derivedLines?: string[];
    poorSleepOverridable?: boolean;
  } | null;
  // Whether the Calm (anxiety) scale is relevant for this profile (issue #1313's
  // relevance gate). SILENT: the scale renders or doesn't — no copy names the trigger.
  anxietyRelevant?: boolean;
  // The server-rendered well-day symptom quick-log (issue #1300) — a compact SymptomLogBar,
  // passed ONLY on a well day (no open episode). Rendered on the server so its data reads
  // apply, and revealed behind the Report section's "Log a symptom" toggle so logging a
  // symptom never requires, implies, or activates any illness/situation. Null while an
  // episode is active (the hero cockpit owns symptom logging then).
  symptomSlot?: ReactNode;
  // The count of symptoms already logged today, for the Report summary line (#1300).
  symptomCount?: number;
}) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const [pending, start] = useTransition();
  const [sickPending, startSick] = useTransition();
  const [sitPending, startSit] = useTransition();
  const [rateExpanded, setRateExpanded] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [actExpanded, setActExpanded] = useState(false);
  // Well-day symptom quick-log reveal (#1300) — closed by default so a well day gains no
  // permanent footprint and the symptom bar is absent from the DOM until asked for.
  const [symptomExpanded, setSymptomExpanded] = useState(false);

  // Which day the Rate section is logging (#2128) — today by default; the chips
  // below switch it within the backfill window.
  const [selectedDate, setSelectedDate] = useState(date);

  // Local mirrors of the SELECTED day's entry for instant feedback; the server
  // row is the source of truth on the next render (the save action revalidates).
  const [valence, setValence] = useState<number | null>(mood?.valence ?? null);
  const [energy, setEnergy] = useState<number | null>(mood?.energy ?? null);
  const [anxiety, setAnxiety] = useState<number | null>(mood?.anxiety ?? null);
  const [factors, setFactors] = useState<string[]>(mood?.factors ?? []);
  const [note, setNote] = useState(mood?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  // The one-tap valence write, declared (#2130): an idempotent per-(profile, date)
  // upsert whose optimistic value — the selected face — adopts the server row on
  // revalidation. The ledger absorbs the second half of a double-tap (#2007 layer
  // 1); the key is (day, face), so a quick correction onto a different face — or
  // the same face for a different backfill day — is a new write, never an
  // absorbed one.
  const ledger = useOptimisticLedger<number | null>("mood-valence");

  const days: MoodBackfillDay[] = [{ date, mood }, ...earlierDays];

  // Switch which day the Rate section edits (#2128): re-mirror every expand field
  // to what that day already holds, so the faces never show one day's rating over
  // another day's chip.
  function pickDay(day: MoodBackfillDay) {
    if (day.date === selectedDate) return;
    setSelectedDate(day.date);
    setValence(day.mood?.valence ?? null);
    setEnergy(day.mood?.energy ?? null);
    setAnxiety(day.mood?.anxiety ?? null);
    setFactors(day.mood?.factors ?? []);
    setNote(day.mood?.notes ?? "");
    setError(null);
  }

  interface MoodDraft {
    valence: number;
    energy: number | null;
    anxiety: number | null;
    factors: string[];
    note: string;
  }

  function buildForm(next: MoodDraft): FormData {
    const fd = new FormData();
    fd.set("date", selectedDate);
    fd.set("valence", String(next.valence));
    if (next.energy != null) fd.set("energy", String(next.energy));
    if (next.anxiety != null) fd.set("anxiety", String(next.anxiety));
    for (const f of next.factors) fd.append("factors", f);
    if (next.note.trim()) fd.set("note", next.note.trim());
    return fd;
  }

  // Offline (or a dropped connection): queue the captured fields to replay on
  // reconnect — idempotent per day, so a double flush can't duplicate. Lands on
  // the SELECTED day (#2128), which is the day the user was logging.
  async function queueIfOffline(
    err: unknown,
    next: MoodDraft
  ): Promise<boolean> {
    if (
      !shouldQueueOffline(
        typeof navigator === "undefined" ? true : navigator.onLine,
        err
      )
    ) {
      return false;
    }
    await enqueue("mood", selectedDate, {
      valence: next.valence,
      energy: next.energy,
      anxiety: next.anxiety,
      factors: next.factors,
      note: next.note.trim() ? next.note.trim() : null,
    });
    toast("Saved offline — will sync when you reconnect.");
    return true;
  }

  // Persist an expanded save or a day-factor toggle while a mood is logged. The
  // one-tap face path is `tap` below, through the declared ledger.
  function save(next: MoodDraft) {
    setError(null);
    start(async () => {
      try {
        const res = await logMood(buildForm(next));
        if (!res.ok) setError(res.error);
      } catch (err) {
        if (await queueIfOffline(err, next)) return;
        setError("Couldn't save that check-in — try again.");
      }
    });
  }

  function tap(n: number) {
    setError(null);
    const next: MoodDraft = { valence: n, energy, anxiety, factors, note };
    void ledger.tap({
      key: `${selectedDate}:${n}`,
      from: valence,
      optimistic: n,
      commit: setValence,
      write: () => logMood(buildForm(next)),
      settle: (res) => {
        // The action revalidates, so the server prop re-renders the truth; the
        // optimistic face stands in until then.
        if (res.ok) return { kind: "keep" };
        setError(res.error);
        return { kind: "rollback" };
      },
      onError: async (err) => {
        if (await queueIfOffline(err, next)) return { kind: "keep" };
        setError("Couldn't save that check-in — try again.");
        return undefined; // rollback
      },
    });
  }

  // Toggle a today-only day-factor (work/social — the surviving mood factors). Updates
  // local state, and — when a mood is already logged — persists immediately through
  // the SAME logMood core (carrying the existing valence). When no mood is logged yet
  // the toggle stays local and rides the next mood save (valence is required to write
  // a mood row); the visible "Just today" grouping tells the user it's a today-only tag.
  function toggleDayFactor(slug: string) {
    const nextFactors = factors.includes(slug)
      ? factors.filter((f) => f !== slug)
      : [...factors, slug];
    setFactors(nextFactors);
    if (valence != null) {
      save({ valence, energy, anxiety, factors: nextFactors, note });
    }
  }

  // Toggle a sticky non-clinical situation (issue #1311's sticky half). Reuses the
  // SAME setActiveSituations path as the Supplements bar via the shared toggleSituation
  // action (transition events → chart annotations come free), then refreshes so the
  // active chips + activation line update from the server (the dueness/bus truth).
  function toggleSit(name: string) {
    setError(null);
    startSit(async () => {
      const fd = new FormData();
      fd.set("situation", name);
      const res = await toggleSituation(fd);
      if (!res.ok) setError(res.error);
    });
  }

  // The poor-sleep "Not today" override (#1292): suppress the DERIVED contribution for
  // today only, through the SAME shared action the Supplements bar uses (dismiss once,
  // silence both). Independent of the coaching card's own snooze (#449).
  function overridePoorSleep() {
    startSit(async () => {
      await dismissDerivedPoorSleep();
    });
  }

  // The Calm scale's on-screen value is the RELABELED display slot (#1313 axis fix:
  // high = calm/good, matching Energy); stored `anxiety` semantics are unchanged.
  const calmDisplay =
    anxietyRelevant && anxiety != null ? anxietyDisplaySlot(anxiety) : null;

  // The merged Context group model (#1311): sticky situations ∪ today-only day factors.
  const group = contextGroup({
    situations: situations?.options ?? [],
    dayFactors: MOOD_FACTORS.map((f) => ({
      slug: f.slug,
      label: f.label,
      active: factors.includes(f.slug),
    })),
  });
  const showContext = contextGroupHasChips(group);

  return (
    <div className="card" data-testid="how-are-you-card">
      <WidgetHeader title="How are you today?" href="/trends#body" />

      {/* The AUTO-PAUSED reminder, made visible (#1668). The check-in itself is
          unaffected — the card logs a mood exactly as always; what paused is the
          evening nudge. Resuming is the same streak reset a logged mood performs.
          Tone follows the #992/#716 contract: no guilt, no streak language. */}
      {checkinsPaused && (
        <div
          data-testid="mood-checkins-paused"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-600 dark:bg-ink-800 dark:text-slate-300"
        >
          <span>{MOOD_CHECKIN_PAUSED_LABEL}</span>
          <button
            type="button"
            data-testid="mood-checkins-resume"
            className="link"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await resumeMoodCheckins();
                toast(res.ok ? "Daily check-ins resumed" : res.error);
              })
            }
          >
            Resume
          </button>
        </div>
      )}

      {/* RATE — the hero face row stays first in DOM; one tap completes the check-in,
          and "More detail" reveals Energy, the gated Calm, and a note. */}
      <CheckInSection
        id="rate"
        first
        expanded={rateExpanded}
        onToggle={() => setRateExpanded((e) => !e)}
        toggleLabel="More detail"
        header={
          <div className="min-w-0 flex-1">
            {/* The #2128 backfill chips — the #2019 now/earlier pattern, a day at
                a time: pick WHICH day before the tap, bounded by the dose-log-window
                convention (lib/mood.ts). Rendered only when the server passed the
                window, so other mounts of the card are unchanged. */}
            {earlierDays.length > 0 ? (
              <div
                className="mb-1.5 flex flex-wrap items-center gap-1.5"
                data-testid="mood-day-chips"
              >
                {days.map((day, offset) => (
                  <button
                    key={day.date}
                    type="button"
                    data-testid={`mood-day-${offset}`}
                    data-date={day.date}
                    aria-pressed={day.date === selectedDate}
                    onClick={() => pickDay(day)}
                    className={`badge cursor-pointer border ${
                      day.date === selectedDate
                        ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                        : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
                    }`}
                  >
                    {moodBackfillLabel(offset)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MoodValencePicker
                value={valence}
                onChange={tap}
                disabled={pending}
              />
              <span
                className="text-xs text-slate-500 dark:text-slate-400"
                data-testid="mood-status"
              >
                {rateSummary({ valence, energy, calmDisplay })}
              </span>
              {/* Server-truth marker (from the SERVER prop, not local state): appears/
                  updates only once the write committed and the refresh round-tripped —
                  the e2e settle hook on this action-POST-heavy page (see e2e/helpers.ts). */}
              {mood ? (
                <span
                  hidden
                  data-testid="mood-server-logged"
                  data-valence={mood.valence}
                  data-energy={mood.energy ?? ""}
                  data-anxiety={mood.anxiety ?? ""}
                  data-factors={mood.factors.join(",")}
                  data-note={mood.notes ?? ""}
                />
              ) : null}
              {/* The same server-truth markers for the backfill days (#2128), one
                  per logged earlier day, so a dated write has a settle hook too. */}
              {earlierDays.map((day, i) =>
                day.mood ? (
                  <span
                    key={day.date}
                    hidden
                    data-testid={`mood-server-logged-${i + 1}`}
                    data-date={day.date}
                    data-valence={day.mood.valence}
                  />
                ) : null
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-2" data-testid="mood-detail">
          <ScaleRow
            name="Energy"
            value={energy}
            onPick={(n) => setEnergy((prev) => (prev === n ? null : n))}
            testPrefix="mood-energy"
            lowLabel="drained"
            highLabel="energized"
          />
          {/* The relevance-gated Calm scale (#1313) — rendered only when the anxiety
              domain is relevant to this profile. SILENT gate: no copy explains its
              absence. Axis relabeled so high = calm (the good end), like Energy. */}
          {anxietyRelevant ? (
            <ScaleRow
              name="Calm"
              value={anxiety != null ? anxietyDisplaySlot(anxiety) : null}
              onPick={(n) =>
                setAnxiety((prev) =>
                  prev === anxietyStoredValue(n) ? null : anxietyStoredValue(n)
                )
              }
              testPrefix="mood-anxiety"
              lowLabel={ANXIETY_CALM_LOW_LABEL}
              highLabel={ANXIETY_CALM_HIGH_LABEL}
            />
          ) : null}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              data-testid="mood-note"
              className="input flex-1 text-sm"
              maxLength={500}
            />
            <button
              type="button"
              data-testid="mood-save"
              disabled={pending || valence == null}
              onClick={() =>
                valence != null &&
                save({ valence, energy, anxiety, factors, note })
              }
              className="btn btn-sm"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </CheckInSection>

      {error ? (
        <p className="mt-2 text-xs text-rose-600" data-testid="mood-error">
          {error}
        </p>
      ) : null}

      {/* CONTEXT — the merged "What's going on?" chip group (#1311): ONE group, two
          write paths (sticky situations vs today-only day factors), the stickiness
          difference made VISIBLE by the "Ongoing / Just today" split. */}
      {showContext ? (
        <CheckInSection
          id="context"
          label="What's going on?"
          summary={contextSummary(group)}
          expanded={contextExpanded}
          onToggle={() => setContextExpanded((e) => !e)}
        >
          <div className="space-y-3">
            {group.sticky.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Ongoing
                </p>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="checkin-context-sticky"
                >
                  {group.sticky.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      data-testid={`checkin-situation-${c.key}`}
                      aria-pressed={c.active}
                      disabled={sitPending}
                      onClick={() => toggleSit(c.key)}
                      className={`badge cursor-pointer disabled:opacity-60 ${
                        c.active
                          ? "bg-brand-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300 dark:hover:bg-ink-700"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {situations?.activationLine ? (
                  <p
                    className="mt-2 text-xs text-slate-500 dark:text-slate-400"
                    data-testid="checkin-situation-activation"
                  >
                    {situations.activationLine}
                  </p>
                ) : null}
              </div>
            ) : null}
            {/* DERIVED context (#1292/#1298): computed, non-toggleable state lines with
                a distinct "Auto" tag, plus the poor-sleep "Not today" override. */}
            {situations?.derivedLines && situations.derivedLines.length > 0 ? (
              <div
                className="space-y-1"
                data-testid="checkin-derived-situations"
              >
                {situations.derivedLines.map((line, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                  >
                    <span className="badge bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      Auto
                    </span>
                    <span>{line}</span>
                  </div>
                ))}
                {situations.poorSleepOverridable ? (
                  <button
                    type="button"
                    data-testid="checkin-poor-sleep-override"
                    disabled={sitPending}
                    onClick={overridePoorSleep}
                    className="badge cursor-pointer border border-slate-300 bg-transparent text-slate-500 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-ink-800"
                  >
                    Not today
                  </button>
                ) : null}
              </div>
            ) : null}
            {group.day.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  Just today
                </p>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="checkin-context-day"
                >
                  {group.day.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      data-testid={`checkin-day-factor-${c.key}`}
                      aria-pressed={c.active}
                      onClick={() => toggleDayFactor(c.key)}
                      className={`badge cursor-pointer border ${
                        c.active
                          ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                          : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </CheckInSection>
      ) : null}

      {/* REPORT — the illness door as this section's escalation, PLUS the well-day symptom
          quick-log (#1300). Non-expandable: the door (or the defer-to-hero note) renders
          inline at rest. The well-day symptom log sits behind its own "Log a symptom"
          reveal so the symptom bar is absent from the DOM until asked for — logging a
          symptom never requires, implies, or activates any illness/situation. */}
      <CheckInSection
        id="report"
        label="Report"
        summary={reportSummary(activeEpisode, symptomCount)}
        expandable={false}
      >
        {activeEpisode ? (
          <p
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="mood-episode-note"
          >
            Illness episode active — symptoms and temperature are tracked above.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Not feeling well? Start tracking symptoms and temperature.
              </p>
              <button
                type="button"
                data-testid="feeling-sick-activate"
                disabled={sickPending}
                onClick={() =>
                  startSick(async () => {
                    await activateIllnessForSymptoms();
                  })
                }
                className="badge cursor-pointer border border-dashed border-brand-400 bg-transparent text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
              >
                {sickPending ? "Starting…" : "I'm feeling sick"}
              </button>
            </div>
            {/* Well-day symptom quick-log (#1300): a symptom (cramps, a headache) with no
                illness required. Behind a reveal so the everyday well card stays calm; the
                bar's own suggest-only "Mark as illness" bridge renders after a log. */}
            {symptomSlot ? (
              <div>
                <button
                  type="button"
                  data-testid="checkin-symptom-toggle"
                  aria-expanded={symptomExpanded}
                  onClick={() => setSymptomExpanded((e) => !e)}
                  className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                >
                  {symptomExpanded
                    ? "Hide symptom log"
                    : symptomCount > 0
                      ? "Edit symptoms"
                      : "Log a symptom"}
                </button>
                {symptomExpanded ? (
                  <div className="mt-2" data-testid="checkin-symptom-log">
                    {symptomSlot}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </CheckInSection>

      {/* ACT — the folded PRN quick-log (issue #1221). Shown only on a well day with
          active PRN meds; a calm expandable keeps the everyday check-in uncluttered. */}
      {medsSlot ? (
        <CheckInSection
          id="act"
          label="Meds"
          summary={actSummary(medsCount)}
          expanded={actExpanded}
          onToggle={() => setActExpanded((e) => !e)}
        >
          {medsSlot}
        </CheckInSection>
      ) : null}
    </div>
  );
}
