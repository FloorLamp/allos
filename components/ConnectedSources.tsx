import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import type { IntegrationId } from "@/lib/types/integrations";
import { integrationDetailHref } from "@/lib/hrefs";
import { getIntegration } from "@/lib/integrations/registry";
import type { ConnectedSource } from "@/lib/queries/integrations";
import {
  failureConsequence,
  formatSyncOutcome,
  intermittentReassurance,
  intermittentRunsLabel,
  successCadenceLabel,
  needsAttention,
  standingBadge,
  standingEscalates,
} from "@/lib/integrations/provider-state";
import SyncNowButton from "@/components/SyncNowButton";
import StatusBadge from "@/components/integrations/StatusBadge";
import SyncTimestamp from "@/components/integrations/SyncTimestamp";
import IntegrationStatusHeader from "@/components/integrations/IntegrationStatusHeader";

// Data → Review, "Connected sources" — an INBOX (#1772), not a second copy of every
// provider's page.
//
// #208 created this as the recurring-streams half of Review; #1212 then made it the
// ONE place sync history rendered and #1614 routed Weather in. What neither covered is
// that a provider's status and controls were still rendered twice in two visual
// languages — here and on its own setup page — with different badges, different
// timestamp formats, and (with the setup pages' raw `last_sync_summary` echo) a third
// accounting. The state model is now one computation (lib/integrations/provider-state
// over getIntegrationState) and the surfaces have deliberate, different ROLES:
//
//   • the setup page is the provider's HOME — status header, controls, full history;
//   • Review's "Needs attention" card IS the alert for a genuinely-broken source
//     (#1880 item 2) — EscalatedSources below, rendered by ReviewInbox: standing
//     chip, reason, consequence in user terms, and ALL the actions, once;
//   • this card is the calm rest — a provider with something unfinished (partial /
//     not-connected) expands with its reason, a flapping one states its pattern as
//     an amber one-liner, and a healthy one collapses to a single line linking home.
//
// History renders in exactly ONE place still (#1212's rule holds): it moved home.
// Server component — the page reads the sources via lib/queries (getConnectedSources).

// The way back to a provider's own page. `integrationDetailHref` only returns null
// for the planned Garmin, which never appears here.
function homeHref(source: ConnectedSource) {
  return integrationDetailHref(source.id as IntegrationId);
}

// The action a provider in the inbox offers. A pull source that is connected can be
// pulled on demand; one that was removed (#294) or whose token died (#326) gets a way
// back to reconnect; a push-only provider explains why there is no button.
function SourceAction({ source }: { source: ConnectedSource }) {
  const href = homeHref(source);
  // Push FIRST: a push-only provider (Health Connect) has nothing to pull and nothing
  // to "reconnect" from here — the phone exporter drives it, and its token lives on
  // its own page — so it explains itself whatever its connection row says.
  if (source.kind === "push") {
    return (
      <span className="text-xs text-slate-500 dark:text-slate-400">
        Push-only — your phone&apos;s exporter sends data on a schedule;
        there&apos;s nothing to sync by hand.
      </span>
    );
  }
  if (source.connected && source.canSyncNow) {
    return <SyncNowButton provider={source.id} />;
  }
  if (!source.connected && href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
      >
        Reconnect {source.name} →
      </Link>
    );
  }
  return href ? (
    <Link
      href={href}
      className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
    >
      Open {source.name} settings →
    </Link>
  ) : null;
}

// A provider that needs attention: the full shared status header (the same component
// its own page leads with), its action, and a link to the full history. `consequence`
// adds the user-terms cost of the breakage on the escalated card (#1880 item 2).
function AttentionCard({
  source,
  isAdmin,
  consequence = false,
}: {
  source: ConnectedSource;
  isAdmin: boolean;
  consequence?: boolean;
}) {
  const href = homeHref(source);
  return (
    <li
      className="rounded-lg border border-black/5 p-3 dark:border-white/5"
      data-testid={`source-${source.id}`}
    >
      <IntegrationStatusHeader
        state={source}
        showName
        isAdmin={isAdmin}
        controls={
          <>
            <SourceAction source={source} />
            {href && source.history.length > 0 && (
              <Link
                href={href}
                className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                data-testid={`source-history-link-${source.id}`}
              >
                Full sync history →
              </Link>
            )}
          </>
        }
      />
      {consequence && (
        <p
          className="mt-1 text-sm text-slate-600 dark:text-slate-300"
          data-testid={`source-consequence-${source.id}`}
        >
          {failureConsequence(
            source.name,
            getIntegration(source.id as IntegrationId)?.stoppedConsequence
          )}
        </p>
      )}
    </li>
  );
}

// The escalated sources — standing `failing` or `needs-reauth` — rendered ONCE,
// fully, inside Review's "Needs attention" card (#1880 item 2). The alert IS the
// card: chip, reason, consequence, and every action together; nothing about these
// providers renders a second time further down the page.
export function EscalatedSources({
  sources,
  isAdmin = false,
}: {
  sources: ConnectedSource[];
  isAdmin?: boolean;
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="space-y-3" data-testid="sources-escalated">
      {sources.map((source) => (
        <AttentionCard
          key={source.id}
          source={source}
          isAdmin={isAdmin}
          consequence
        />
      ))}
    </ul>
  );
}

// Which sources belong on the escalated card. Exported so ReviewInbox splits with
// the same rule the badge and digest use (standingEscalates) — one decision.
export function isEscalatedSource(source: ConnectedSource): boolean {
  return standingEscalates(source.standing);
}

// A healthy or flapping provider: one line. Nothing here needs doing, so the inbox
// states it and gets out of the way — the same badge, the same outcome sentence, and
// the same timestamp treatment as everywhere else, just compact. A flapping source
// (#1880 item 1) states the honest pattern instead of its latest event's verdict:
// "2 of the last 8 runs failed · last success 1 hour ago" — calm amber, never an
// alert.
function HealthyRow({ source }: { source: ConnectedSource }) {
  const badge = standingBadge(source.standing);
  const href = homeHref(source);
  const intermittent = source.standing === "intermittent";
  const outcome = source.latest
    ? formatSyncOutcome(source.latest, source.vocabulary)
    : null;
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {source.name}
        </span>
        <StatusBadge
          label={badge.label}
          tone={badge.tone}
          testid={`sync-status-${source.id}`}
        />
        {intermittent ? (
          <span
            className="text-sm text-slate-500 dark:text-slate-400"
            data-testid={`intermittent-fact-${source.id}`}
          >
            {intermittentRunsLabel(
              source.recentRuns.failed,
              source.recentRuns.total
            )}
            {source.lastSuccessAt && (
              <>
                {" "}
                · last success{" "}
                <SyncTimestamp value={source.lastSuccessAt} relativeOnly />
              </>
            )}
            {/* The signal beside the noise (#2263 item 4): what the failure count
                does not say is that this source keeps succeeding. */}
            {successCadenceLabel(source.successCadenceMinutes) && (
              <> · {successCadenceLabel(source.successCadenceMinutes)}</>
            )}{" "}
            · {intermittentReassurance(source.vocabulary)}
          </span>
        ) : (
          <span
            className={`text-sm ${
              outcome && !outcome.muted
                ? "text-slate-700 dark:text-slate-200"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {outcome ? outcome.primary : "No syncs yet"}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        {source.latest && (
          <SyncTimestamp value={source.latest.at} relativeOnly />
        )}
        <IconArrowRight className="h-4 w-4 text-brand-600 dark:text-brand-400" />
      </span>
    </>
  );
  return (
    <li data-testid={`source-${source.id}`}>
      {href ? (
        <Link
          href={href}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/5 px-3 py-2 transition hover:border-brand-300 dark:border-white/5 dark:hover:border-brand-800"
        >
          {body}
        </Link>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/5 px-3 py-2 dark:border-white/5">
          {body}
        </div>
      )}
    </li>
  );
}

export default function ConnectedSources({
  sources,
  isAdmin = false,
}: {
  sources: ConnectedSource[];
  isAdmin?: boolean;
}) {
  // The escalated sources render ONCE, on Review's "Needs attention" card
  // (EscalatedSources) — never a second time here (#1880 item 2).
  const rest = sources.filter((s) => !isEscalatedSource(s));
  if (rest.length === 0) return null;
  const attention = rest.filter((s) => needsAttention(s.standing));
  const healthy = rest.filter((s) => !needsAttention(s.standing));
  return (
    <div className="card" data-testid="connected-sources">
      <div className="mb-1">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Connected sources
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Devices and services that sync automatically. Anything unfinished is
          expanded with the reason and what to do; the rest are one line each.
          Open a source for its controls and full sync history.
        </p>
      </div>
      {attention.length > 0 && (
        <ul className="mt-3 space-y-3" data-testid="sources-attention">
          {attention.map((source) => (
            <AttentionCard key={source.id} source={source} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
      {healthy.length > 0 && (
        <ul className="mt-3 space-y-1.5" data-testid="sources-healthy">
          {healthy.map((source) => (
            <HealthyRow key={source.id} source={source} />
          ))}
        </ul>
      )}
    </div>
  );
}
