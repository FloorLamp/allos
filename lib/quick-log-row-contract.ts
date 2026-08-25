// The quick-log sheet row contract (#3275).
//
// QUICK_LOG_ITEMS decides membership and routing. This companion record answers the
// three write-side questions that routing cannot: what happens without a connection,
// where a failed commit is announced, and which verb names the commit. Keeping the
// key type at QuickLogId means a new sheet row cannot arrive with any question silent.

import type { FlowKind } from "./offline/queue";
import type { QuickLogId } from "./quick-log";

export type QuickLogOfflineStory =
  | {
      status: "covered";
      flows: readonly FlowKind[];
      detail: string;
    }
  | {
      status: "excluded";
      argument: string;
    };

export type QuickLogFailureChannel =
  | { fields: "none"; channel: "toast" | "inline" | "inline-and-toast" }
  | {
      // A control row may carry an input that parameterizes an immediate action
      // (protein grams, practice duration) without becoming a submit form.
      fields: "action-parameter";
      channel: "toast" | "inline-and-toast";
      argument: string;
    }
  | { fields: "form"; channel: "inline-and-toast" }
  | {
      // Activity is a session dock, not a sheet form, and saves continuously.
      fields: "autosave";
      channel: "save-status";
      argument: string;
    };

export type QuickLogCommit =
  | { kind: "action"; verb: string }
  | { kind: "form"; verb: `Save${string}` }
  | { kind: "exception"; verb: string | null; argument: string };

export interface QuickLogRowContract {
  offline: QuickLogOfflineStory;
  failure: QuickLogFailureChannel;
  commit: QuickLogCommit;
}

export const QUICK_LOG_ROW_CONTRACT = {
  "log-activity": {
    offline: {
      status: "covered",
      flows: ["set"],
      detail:
        "A never-created session is captured on close; edits to an existing server row stay with the editor's retry and local draft.",
    },
    failure: {
      fields: "autosave",
      channel: "save-status",
      argument:
        "The activity editor is a session dock, not a sheet form. It autosaves, keeps a local draft, and has no submit event to pair with a toast.",
    },
    commit: {
      kind: "exception",
      verb: null,
      argument:
        "Activity is autosaved while it is edited; adding a Save button would create a second persistence contract.",
    },
  },
  "live-workout": {
    offline: {
      status: "covered",
      flows: ["set"],
      detail:
        "The live editor uses the same create-only close capture as one-off activity logging when the server never created a row.",
    },
    failure: {
      fields: "autosave",
      channel: "save-status",
      argument:
        "A live workout is the same session dock and autosave state machine as activity, not a sheet form.",
    },
    commit: {
      kind: "exception",
      verb: "Start workout / Resume workout",
      argument:
        "The row's verb opens or resumes a durable session; edits inside it autosave and finishing is a separate lifecycle action.",
    },
  },
  "log-food": {
    offline: {
      status: "covered",
      flows: ["food"],
      detail:
        "Additive servings and protein grams queue; removals and corrections stay online because they act on server state.",
    },
    failure: {
      fields: "action-parameter",
      channel: "toast",
      argument:
        "The optional protein amount and eating-time choice parameterize immediate add/remove buttons; there is no form commit.",
    },
    commit: { kind: "action", verb: "Add a serving / Add protein grams" },
  },
  "log-dose": {
    offline: {
      status: "covered",
      flows: ["dose"],
      detail:
        "The sheet lists scheduled doses only; each Mark taken intent queues with set-to-taken semantics.",
    },
    failure: { fields: "none", channel: "toast" },
    commit: { kind: "action", verb: "Mark taken" },
  },
  "log-measurements": {
    offline: {
      status: "covered",
      flows: ["body-metric", "vitals"],
      detail:
        "Body metrics and vitals queue as their existing write-core flows; fields without a queue flow refuse visibly.",
    },
    failure: { fields: "form", channel: "inline-and-toast" },
    commit: { kind: "form", verb: "Save measurements" },
  },
  "log-practice": {
    offline: {
      status: "covered",
      flows: ["practice"],
      detail:
        "A captured practice day replays with day-idempotent semantics, so another device cannot turn it into a duplicate session.",
    },
    failure: {
      fields: "action-parameter",
      channel: "toast",
      argument:
        "The optional duration stepper parameterizes the Log now action; the quick-entry mount intentionally omits the separate detail form.",
    },
    commit: { kind: "action", verb: "Log now / Log another" },
  },
  "log-mood": {
    offline: {
      status: "covered",
      flows: ["mood"],
      detail:
        "The selected day and valence queue as the existing per-day mood upsert.",
    },
    failure: { fields: "none", channel: "inline-and-toast" },
    commit: { kind: "action", verb: "Log mood" },
  },
  "log-period": {
    offline: {
      status: "excluded",
      argument:
        "Start, end, and reopen are lifecycle verbs derived from fresh server state; replaying a stale offer could apply the wrong transition.",
    },
    failure: { fields: "none", channel: "inline" },
    commit: {
      kind: "action",
      verb: "Start period / End period / Reopen period",
    },
  },
  "log-stool": {
    offline: {
      status: "covered",
      flows: ["stool"],
      detail:
        "Covered by the #3166 Q5 owner ruling: the additive Bristol type and captured instant queue for replay.",
    },
    failure: { fields: "none", channel: "toast" },
    commit: { kind: "action", verb: "Log type" },
  },
  "log-substance": {
    offline: {
      status: "excluded",
      argument:
        "The tap's safety-relevant weekly count and optional cap verdict are server-derived and would understate until replay.",
    },
    failure: { fields: "none", channel: "inline" },
    commit: { kind: "action", verb: "Log a use / Log a standard drink" },
  },
  "add-document": {
    offline: {
      status: "excluded",
      argument:
        "A file upload starts server-side ingest and extraction; retaining arbitrary document blobs is not an offline quick-log intent.",
    },
    failure: { fields: "form", channel: "inline-and-toast" },
    commit: {
      kind: "exception",
      verb: "Upload",
      argument:
        "Upload names the transfer that starts ingestion; Save would falsely imply a local record is complete before the bytes arrive.",
    },
  },
} as const satisfies Record<QuickLogId, QuickLogRowContract>;
