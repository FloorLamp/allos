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

// A stored AI narrative (issue #20): a weekly/monthly period recap. kind selects the
// period; period_end anchors it (the recap end date), period_start is the window
// start. (The "labs" lab-trend kind was retired with the Trends → Biomarkers tab —
// #1164; any rows stored under it are inert, read by no surface.)
export type NarrativeKind = "week" | "month";

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
  // Optional recovery-gear reference (issue #344): the equipment row the protocol
  // studies ("which sauna"), Equipment.id or NULL. deleteEquipment nulls it.
  equipment_id: number | null;
  // Optional practice link (issue #344): the frequency_targets row that measures
  // adherence to the protocol's practice ("sauna 4×/week"), or NULL. Adherence
  // reuses the Weekly-widget weekly-count computation over this target.
  frequency_target_id: number | null;
  // 1 when the protocol CREATED its frequency target (so its delete cleans the
  // target up, unless a sibling protocol now references it); 0 when it merely
  // points at a pre-existing routine target it must not destroy.
  owns_frequency_target: number;
  // Optional direct intake-item link (issue #660): the supplement/medication row
  // this protocol studies as its intervention ("creatine 5 g/day"), intake_items.id
  // or NULL. First-class instead of routed through a situation. deleteIntakeItem/
  // deleteMedication null it in code (no ON DELETE action).
  intake_item_id: number | null;
  created_at: string;
}
