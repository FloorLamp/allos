import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { INTEGRATIONS } from "@/lib/integrations/registry";
import { integrationDetailHref } from "@/lib/hrefs";
import { getIntegrationState } from "@/lib/queries";
import type { IntegrationState } from "@/lib/queries/integrations";
import type { IntegrationDef } from "@/lib/types";
import {
  formatSyncOutcome,
  standingBadge,
  standingEscalates,
  standingHeadline,
  standingUnconfigured,
  syncRunNounForKind,
} from "@/lib/integrations/source-state";
import StatusBadge from "./integrations/StatusBadge";
import SyncTimestamp from "./integrations/SyncTimestamp";

// The connect-card grid on Data → Import. It reads the SAME state model as the
// setup pages and Review's inbox (#1772) — one badge vocabulary, one timestamp
// treatment — so the three surfaces can never disagree about a provider's health.
//
// Since #1880 (items 7 + 8) a card has TWO states matching its two jobs:
//   • a CONNECTED card's job is status — name, standing chip, one fact, Manage →.
//     Its owner already knows what the provider does; the blurb and sixteen
//     data-type chips it used to show forever were a pitch aimed at someone who
//     already bought.
//   • an UNCONNECTED card keeps the pitch — short blurb, a few representative
//     chips, Set up →.
// And the grid orders by state instead of interleaving failures, connected
// sources, and adverts in registry order: attention first (red border,
// Reconnect →), then healthy connected, then an "Available" group for the
// pitches, planned cards dimmed last.

// How many representative data-type chips a pitch card shows (#1880 item 7) — a
// taste of the catalog, not the whole sixteen-chip inventory.
const PITCH_CHIP_CAP = 4;

interface GridEntry {
  def: IntegrationDef;
  state: IntegrationState | null; // null for planned providers
}

// The ONE fact a connected card states, per standing: the thing its owner would
// ask first. All projections of the shared state model — no second accounting.
function StatusFact({ state }: { state: IntegrationState }) {
  const { latest, standing } = state;
  // OUTBOUND states nothing about runs (#2301). "No syncs yet" is a promise that a
  // sync is coming, and for a feed the calendar client pulls, none ever is — the
  // calendar card had been making that promise permanently since it shipped.
  if (state.delivery === "outbound") return null;
  if (standing === "attempt-failed") {
    // Caution, not alarm: the run that failed is the one the person started, and
    // whether there is another is theirs to decide.
    //
    // The fallback comes from `standingHeadline`, which already writes this exact
    // sentence in the noun's own dialect (#2301 review). It used to be the hardcoded
    // literal "The last import failed" — the ARCHIVE dialect — so a patient-portals
    // run that failed carrying no error string read "import" directly under a badge
    // reading "Last upload failed": two dialects in one card about one event.
    return (
      <p className="mt-2 wrap-break-word text-sm text-amber-700 dark:text-amber-300">
        {latest?.error ??
          standingHeadline(standing, syncRunNounForKind(state.kind))}
      </p>
    );
  }
  // An attended provider with nothing in yet says so in its BADGE ("Nothing imported
  // yet"), so there is no second sentence to write — and "No syncs yet" would be the
  // wrong word for it anyway.
  if (state.delivery === "attended" && !latest) return null;
  if (standing === "intermittent") {
    return (
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {state.lastSuccessAt ? (
          <>
            Last success{" "}
            <SyncTimestamp value={state.lastSuccessAt} relativeOnly />
          </>
        ) : (
          "No successful run yet"
        )}
      </p>
    );
  }
  if (standing === "failing" || standing === "needs-reauth") {
    // The quiet stop states the observation; a recorded failure names its cause.
    const reason =
      state.stale && latest?.ok
        ? `No data since ${state.stale.since}`
        : (latest?.error ?? "Sync failing");
    return (
      <p className="mt-2 wrap-break-word text-sm text-rose-700 dark:text-rose-300">
        {reason}
      </p>
    );
  }
  if (!latest) {
    return (
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        No syncs yet
      </p>
    );
  }
  const outcome = formatSyncOutcome(latest, state.vocabulary);
  return (
    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
      {outcome.primary} · <SyncTimestamp value={latest.at} relativeOnly />
    </p>
  );
}

// A CONNECTED provider's compact status card. `attention` adds the red border and
// the Reconnect CTA (#1880 item 8).
function StatusCard({
  def,
  state,
}: {
  def: IntegrationDef;
  state: IntegrationState;
}) {
  const attention = standingEscalates(state.standing);
  const badge = standingBadge(state.standing, syncRunNounForKind(state.kind));
  return (
    <div
      className={`card h-full transition hover:shadow-md ${
        attention ? "border-rose-300 dark:border-rose-900" : ""
      }`}
      data-testid={`integration-card-${def.id}`}
      data-card-state={attention ? "attention" : "connected"}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {def.name}
        </h2>
        <StatusBadge label={badge.label} tone={badge.tone} />
      </div>
      <StatusFact state={state} />
      <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-400">
        {attention ? "Reconnect" : "Manage"}
        <IconArrowRight className="h-4 w-4" />
      </div>
    </div>
  );
}

// An UNCONNECTED (or planned) provider's pitch card: what it brings, in brief.
function PitchCard({ def }: { def: IntegrationDef }) {
  const planned = def.status === "planned";
  return (
    <div
      className={`card h-full transition ${
        planned ? "opacity-60" : "hover:shadow-md"
      }`}
      data-testid={`integration-card-${def.id}`}
      data-card-state={planned ? "planned" : "available"}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {def.name}
        </h2>
        {planned && (
          <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
            Coming soon
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        {def.blurb}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {def.dataTypes.slice(0, PITCH_CHIP_CAP).map((d) => (
          <span
            key={d}
            className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
          >
            {d}
          </span>
        ))}
      </div>
      {!planned && (
        <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 dark:text-brand-400">
          Set up
          <IconArrowRight className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}

// Wrap a card in its setup-page link where one exists (planned providers have none).
function LinkedCard({
  def,
  children,
}: {
  def: IntegrationDef;
  children: React.ReactNode;
}) {
  const href = def.status === "planned" ? null : integrationDetailHref(def.id);
  return href ? (
    <Link key={def.id} href={href}>
      {children}
    </Link>
  ) : (
    <div key={def.id}>{children}</div>
  );
}

// Is this provider's card a compact STATUS card? Anything set up and still linked:
// escalated, flapping, partial, healthy, waiting on its first run, or — for the
// families allos does not drive — imported, failed, or publishing. A provider that was
// never set up or was later removed gets the pitch again; `standingUnconfigured` owns
// that decision across all three delivery families (#2301), so this component no
// longer names `not-connected` and misses its attended and outbound twins.
function isStatusCard(
  state: IntegrationState | null
): state is IntegrationState {
  return !!state && !standingUnconfigured(state.standing);
}

export default function IntegrationsGrid({ profileId }: { profileId: number }) {
  const entries: GridEntry[] = INTEGRATIONS.map((def) => ({
    def,
    state:
      def.status === "planned"
        ? null
        : getIntegrationState(profileId, def.id, 0),
  }));

  const status = entries.filter((e) => isStatusCard(e.state));
  // Attention leads (#1880 item 8), then the healthy connected rest — stable
  // registry order within each band.
  const ordered = [
    ...status.filter((e) => standingEscalates(e.state!.standing)),
    ...status.filter((e) => !standingEscalates(e.state!.standing)),
  ];
  const pitches = entries.filter((e) => !isStatusCard(e.state));
  // Planned cards dim to the end of the Available group.
  const available = [
    ...pitches.filter((e) => e.def.status !== "planned"),
    ...pitches.filter((e) => e.def.status === "planned"),
  ];

  return (
    <div className="space-y-4">
      {ordered.length > 0 && (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="grid-connected"
        >
          {ordered.map(({ def, state }) => (
            <LinkedCard key={def.id} def={def}>
              <StatusCard def={def} state={state!} />
            </LinkedCard>
          ))}
        </div>
      )}
      {available.length > 0 && (
        <div>
          {ordered.length > 0 && (
            <div className="section-label mb-2">Available</div>
          )}
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="grid-available"
          >
            {available.map(({ def }) => (
              <LinkedCard key={def.id} def={def}>
                <PitchCard def={def} />
              </LinkedCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
