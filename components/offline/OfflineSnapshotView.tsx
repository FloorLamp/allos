"use client";

import {
  SNAPSHOT_REGISTRY,
  isSnapshotStale,
  snapshotAgeDays,
  type AnySnapshot,
  type DoseScheduleData,
  type FoodTalliesData,
  type MedicationListData,
  type PracticeWeekData,
  type RecentTrainingData,
} from "@/lib/offline/snapshots";

// Renders ONE offline snapshot: its "as of" line, then its facts. Used only by
// app/offline/page.tsx — the live pages are untouched, and so is the overlay, which
// exists only where a snapshot renders (issue #2908).
//
// The staleness DECISION comes from lib/offline/snapshots (which asks lib/freshness's
// one question); only the PHRASING lives here, which is the freshness doctrine's own
// split — that module deliberately owns no copy.

function asOfLine(env: AnySnapshot, now: Date): string {
  const age = snapshotAgeDays(env, now);
  const when =
    age == null || age < 0
      ? env.capturedOn
      : age === 0
        ? "today"
        : age === 1
          ? "yesterday"
          : `${age} days ago`;
  const stale = isSnapshotStale(env, now);
  // Day-scoped kinds say what DAY they are about, because "as of yesterday" for a dose
  // schedule means the schedule shown is yesterday's — a different fact from a med list
  // being a day old, and the one a person acting on it has to know.
  return stale
    ? `As of ${when} (${env.capturedOn}) — not current.`
    : `As of ${when}.`;
}

function Row({
  label,
  detail,
  right,
  mark,
}: {
  label: string;
  detail?: string | null;
  right?: string | null;
  mark?: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-black/5 py-2 last:border-0 dark:border-white/5">
      <span className="min-w-0">
        <span className="block font-medium text-slate-800 dark:text-slate-100">
          {label}
        </span>
        {detail ? (
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {detail}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right text-sm text-slate-600 dark:text-slate-300">
        {right}
        {mark ? (
          <span
            data-testid="offline-queued-mark"
            className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            queued
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Empty({ what }: { what: string }) {
  // Degrades gracefully by construction: nothing stored says so, in a sentence. Never a
  // spinner (there is no network to wait for) and never an error (nothing failed).
  return (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      Nothing stored for {what}.
    </p>
  );
}

function DoseSchedule({ data }: { data: DoseScheduleData }) {
  if (data.entries.length === 0) return <Empty what="today's doses" />;
  return (
    <ul data-testid="offline-dose-schedule" className="text-sm">
      {data.entries.map((e) => (
        <Row
          key={e.doseId}
          label={e.name}
          detail={[e.detail, e.slot].filter(Boolean).join(" · ") || null}
          right={
            e.status === "taken"
              ? "Taken"
              : e.status === "skipped"
                ? "Skipped"
                : "Not yet"
          }
          mark={e.queued}
        />
      ))}
    </ul>
  );
}

function MedicationList({ data }: { data: MedicationListData }) {
  if (data.rows.length === 0) return <Empty what="medications" />;
  return (
    <ul data-testid="offline-medication-list" className="text-sm">
      {data.rows.map((r) => (
        <Row
          key={r.id}
          label={r.name}
          detail={[r.subtitle, r.dose].filter(Boolean).join(" · ") || null}
          right={r.schedule}
        />
      ))}
    </ul>
  );
}

function RecentTraining({ data }: { data: RecentTrainingData }) {
  if (data.activities.length === 0 && data.exercises.length === 0) {
    return <Empty what="recent training" />;
  }
  return (
    <div data-testid="offline-recent-training" className="space-y-4">
      {data.activities.length > 0 ? (
        <ul className="text-sm">
          {data.activities.map((a, i) => (
            <Row
              key={`${a.date}-${i}`}
              label={a.title}
              detail={a.detail}
              right={a.date}
              mark={a.queued}
            />
          ))}
        </ul>
      ) : null}
      {data.exercises.map((e) => (
        <div key={e.exercise}>
          <h3 className="text-sm font-semibold text-slate-700 capitalize dark:text-slate-200">
            {e.exercise}
          </h3>
          <ul className="text-sm">
            {e.sessions.map((s, i) => (
              <Row
                key={`${s.date}-${i}`}
                label={s.text}
                detail={s.equipment}
                right={s.date}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FoodTallies({ data }: { data: FoodTalliesData }) {
  if (data.groups.length === 0 && !data.proteinGrams) {
    return <Empty what="today's food" />;
  }
  return (
    <ul data-testid="offline-food-tallies" className="text-sm">
      {data.groups.map((g) => (
        <Row
          key={g.key}
          label={g.label}
          right={`${g.servings}`}
          mark={!!g.queued}
        />
      ))}
      {data.proteinGrams != null ? (
        <Row
          label="Protein"
          right={`${data.proteinGrams} g`}
          mark={!!data.queuedProteinGrams}
        />
      ) : null}
    </ul>
  );
}

function PracticeWeek({ data }: { data: PracticeWeekData }) {
  if (data.practices.length === 0) return <Empty what="practices" />;
  return (
    <ul data-testid="offline-practice-week" className="text-sm">
      {data.practices.map((p) => (
        <Row
          key={p.identity}
          label={p.name}
          detail={p.todayCount > 0 ? "Logged today" : null}
          right={`${p.countThisWeek} of ${p.perWeek} this week`}
          mark={!!p.queued}
        />
      ))}
    </ul>
  );
}

function Body({ env }: { env: AnySnapshot }) {
  switch (env.kind) {
    case "dose-schedule":
      return <DoseSchedule data={env.data} />;
    case "medication-list":
      return <MedicationList data={env.data} />;
    case "recent-training":
      return <RecentTraining data={env.data} />;
    case "food-tallies":
      return <FoodTallies data={env.data} />;
    case "practice-week":
      return <PracticeWeek data={env.data} />;
  }
}

export default function OfflineSnapshotView({
  env,
  now,
}: {
  env: AnySnapshot;
  now: Date;
}) {
  const decl = SNAPSHOT_REGISTRY[env.kind];
  return (
    <section data-testid={`offline-snapshot-${env.kind}`}>
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
        {decl.title}
      </h2>
      <p
        data-testid="offline-snapshot-asof"
        className="mb-3 text-xs text-slate-500 dark:text-slate-400"
      >
        {asOfLine(env, now)}
      </p>
      <Body env={env} />
    </section>
  );
}
