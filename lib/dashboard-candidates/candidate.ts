import type {
  DashboardCandidate,
  DashboardCandidateBase,
  DashboardObligation,
  DashboardRelevancePolicy,
} from "../dashboard-relevance";

export type CandidateBaseInput = Omit<
  DashboardCandidateBase,
  "relevance" | "rankReasons" | "timing" | "defaultPlacement"
> & {
  relevance?: DashboardRelevancePolicy;
  rankReasons?: DashboardCandidateBase["rankReasons"];
  timing?: DashboardCandidateBase["timing"];
  defaultPlacement?: DashboardCandidateBase["defaultPlacement"];
};

const defaults = {
  relevance: { kind: "state" } as const,
  rankReasons: {
    safety: false,
    owed: false,
    windowOpen: false,
    changed: false,
  },
  timing: { kind: "always" } as const,
};

function base(input: CandidateBaseInput): DashboardCandidateBase {
  return {
    ...input,
    relevance: input.relevance ?? defaults.relevance,
    rankReasons: input.rankReasons ?? { ...defaults.rankReasons },
    timing: input.timing ?? defaults.timing,
    defaultPlacement: input.defaultPlacement ?? "everything",
  };
}

export function actionCandidate(
  input: CandidateBaseInput & { obligation: DashboardObligation }
): DashboardCandidate {
  return { ...base(input), kind: "action", obligation: input.obligation };
}

export function readingCandidate(
  input: CandidateBaseInput
): DashboardCandidate {
  return {
    ...base({
      ...input,
      defaultPlacement: input.defaultPlacement ?? "standing",
    }),
    kind: "reading",
  };
}

export function statementCandidate(
  input: CandidateBaseInput
): DashboardCandidate {
  return { ...base(input), kind: "statement" };
}

export function stateCandidate(input: CandidateBaseInput): DashboardCandidate {
  return { ...base(input), kind: "state" };
}

export function profileDataRelevance(
  presence: "never" | "current" | "dormant",
  engagement: "unknown" | "manual" | "external" = "unknown"
): DashboardRelevancePolicy {
  return { kind: "profile-data", presence, engagement };
}

export function engagementFromSource(
  source: string | null | undefined
): "unknown" | "manual" | "external" {
  if (source === undefined) return "unknown";
  // The existing body-metric and sleep stores use NULL for rows entered in
  // Allos. Named sources identify imports/integrations; an explicit "manual"
  // value is accepted for models that normalize provenance before this edge.
  return source === null || source === "manual" ? "manual" : "external";
}
