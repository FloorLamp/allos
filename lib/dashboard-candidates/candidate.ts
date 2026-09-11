import type {
  DashboardCandidate,
  DashboardCandidateBase,
  DashboardObligation,
  DashboardRelevancePolicy,
} from "../dashboard-relevance";

type CandidateBaseInput = Omit<
  DashboardCandidateBase,
  "relevance" | "rankReasons" | "timing"
> & {
  relevance?: DashboardRelevancePolicy;
  rankReasons?: DashboardCandidateBase["rankReasons"];
  timing?: DashboardCandidateBase["timing"];
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
  return { ...base(input), kind: "reading" };
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
