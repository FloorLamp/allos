import type {
  DashboardCandidate,
  DashboardObligation,
} from "../dashboard-relevance";
import {
  actionCandidate,
  readingCandidate,
  stateCandidate,
  statementCandidate,
  type CandidateBaseInput,
} from "./candidate";

export type DashboardCandidateInput =
  | ({ kind: "action"; obligation: DashboardObligation } & CandidateBaseInput)
  | ({ kind: "reading" } & CandidateBaseInput)
  | ({ kind: "statement" } & CandidateBaseInput)
  | ({ kind: "state" } & CandidateBaseInput);

/**
 * The single React-free boundary from candidate descriptions to the permanent
 * dashboard model. Domain modules can return descriptions without importing the
 * ranker constructors, and the page can keep its node map separate by candidateId.
 */
export function buildDashboardCandidate(
  input: DashboardCandidateInput
): DashboardCandidate {
  switch (input.kind) {
    case "action": {
      const { kind: _kind, ...candidate } = input;
      return actionCandidate(candidate);
    }
    case "reading": {
      const { kind: _kind, ...candidate } = input;
      return readingCandidate(candidate);
    }
    case "statement": {
      const { kind: _kind, ...candidate } = input;
      return statementCandidate(candidate);
    }
    case "state": {
      const { kind: _kind, ...candidate } = input;
      return stateCandidate(candidate);
    }
  }
}

export function buildDashboardCandidates(
  inputs: readonly DashboardCandidateInput[]
): DashboardCandidate[] {
  return inputs.map(buildDashboardCandidate);
}
