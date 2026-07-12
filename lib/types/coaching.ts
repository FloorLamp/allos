// Coaching / AI-narrative domain types (insights, weekly/monthly narratives,
// N-of-1 protocols). Split out of lib/types.ts (#319); the `@/lib/types` barrel
// re-exports everything here, so import paths are unchanged.

export interface Insight {
  id: number;
  date: string;
  summary: string;
  model: string | null;
  created_at: string;
}

// A stored AI narrative (issue #20): a weekly/monthly period recap or a lab-trend
// interpretation. kind selects which; period_end anchors it (recap end date or
// latest lab date), period_start is the recap window start (null for lab-trend).
export type NarrativeKind = "week" | "month" | "labs";

export interface Narrative {
  id: number;
  kind: NarrativeKind;
  period_start: string | null;
  period_end: string;
  summary: string;
  model: string | null;
  created_at: string;
}

// An N-of-1 protocol (issue #161): a dated self-experiment with a declared set of
// outcome-metric keys the app compares before vs. during. `end_date` NULL = the
// protocol is still running ("ongoing"). `outcome_keys` is stored as a JSON array
// of namespaced metric keys (see lib/protocol-metrics); `outcomeKeys` is the
// parsed form the query layer returns. `situation` is the optional situational-
// intake label the protocol activates on start.
export interface Protocol {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  situation: string | null;
  outcomeKeys: string[];
  created_at: string;
}
