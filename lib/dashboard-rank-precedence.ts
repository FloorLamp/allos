import type {
  DashboardCandidate,
  DashboardRankReasons,
} from "./dashboard-relevance";

type DashboardRankReason = keyof DashboardRankReasons;

interface ReasonDefinition {
  reason: DashboardRankReason;
  now: number;
  nowReads: "all" | "action";
  standing: number | null;
}

// One shared table preserves windowOpen-before-changed selection despite its lower Now score.
export const DASHBOARD_RANK_REASON_PRECEDENCE: readonly ReasonDefinition[] = [
  { reason: "safety", now: 5_000, nowReads: "all", standing: 3 },
  // #3548: owed readings lift in Standing but remain inert in Now.
  { reason: "owed", now: 4_000, nowReads: "action", standing: 2 },
  // #3245: an open moment is not a Standing claim.
  { reason: "windowOpen", now: 2_000, nowReads: "action", standing: null },
  { reason: "changed", now: 3_000, nowReads: "all", standing: 1 },
];

function leadingReason(
  reasons: DashboardRankReasons,
  surface: "now" | "standing",
  rankedAction = false
): ReasonDefinition | null {
  for (const definition of DASHBOARD_RANK_REASON_PRECEDENCE) {
    if (surface === "now" && definition.nowReads === "action" && !rankedAction)
      continue;
    if (surface === "standing" && definition.standing == null) continue;
    if (reasons[definition.reason]) return definition;
  }
  return null;
}

export function nowReasonScore(candidate: DashboardCandidate): number | null {
  const rankedAction =
    candidate.kind === "action" && candidate.obligation !== "may";
  const definition = leadingReason(candidate.rankReasons, "now", rankedAction);
  if (!definition) return null;
  if (candidate.kind === "action" && candidate.obligation === "may")
    return definition.reason === "changed" ? 2_000 : definition.now;
  const obligation =
    candidate.kind === "action"
      ? candidate.obligation === "must"
        ? 200
        : 100
      : 0;
  return (
    definition.now +
    (definition.reason === "owed" || definition.reason === "windowOpen"
      ? obligation
      : 0)
  );
}

export function standingReasonClaim(
  reasons: DashboardRankReasons
): number | null {
  return leadingReason(reasons, "standing")?.standing ?? null;
}
