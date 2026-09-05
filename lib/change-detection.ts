// Change-detection family registry (#3397).
//
// The five detectors do not share an input shape and this registry never dispatches
// them. It answers the cross-domain governance question only: which kind exists,
// which module owns it, and where can a person see it? LOGGABLE_DOMAINS is the
// existing domain axis; adding a new loggable domain makes this record fail tsc
// until change detection is declared or its absence is argued.

import {
  arguedExclusion,
  type ArguedExclusion,
  type LoggableDomain,
} from "./loggable-domains";

export const CHANGE_DETECTION_KINDS = [
  "series-magnitude",
  "versus-baseline",
  "streak-lapse",
  "verdict-transition",
  "pipeline-silence",
] as const;

export type ChangeDetectionKind = (typeof CHANGE_DETECTION_KINDS)[number];

export interface ChangeDetectionKindDeclaration {
  readonly ownerModule: `lib/${string}.ts`;
  readonly ownerSymbol: string;
  readonly surfaces: readonly string[];
}

export const CHANGE_DETECTION_KIND_REGISTRY = {
  "series-magnitude": {
    ownerModule: "lib/trends-digest.ts",
    ownerSymbol: "summarizeTrends",
    surfaces: ["Trends digest", "Trends tile badges"],
  },
  "versus-baseline": {
    ownerModule: "lib/sleep-summary.ts",
    ownerSymbol: "lastNightSummary",
    surfaces: [
      "Dashboard sleep row",
      "Morning digest",
      "Wear reminder",
      "Weekly recap",
    ],
  },
  "streak-lapse": {
    ownerModule: "lib/intake-deltas.ts",
    ownerSymbol: "classifyIntakeDeltas",
    surfaces: [
      "Telegram digest",
      "Weekly recap",
      "Dashboard recap",
      "Household card",
    ],
  },
  "verdict-transition": {
    ownerModule: "lib/dashboard-reading-promotions.ts",
    ownerSymbol: "DASHBOARD_READING_PROMOTIONS",
    surfaces: ["Dashboard Now"],
  },
  "pipeline-silence": {
    ownerModule: "lib/domain-dormancy.ts",
    ownerSymbol: "dormancyState",
    surfaces: ["Dashboard dormant-domain rows"],
  },
} as const satisfies Record<
  ChangeDetectionKind,
  ChangeDetectionKindDeclaration
>;

export interface DomainDetectorDeclaration {
  readonly kind: ChangeDetectionKind;
  readonly ownerModule: `lib/${string}.ts`;
  readonly ownerSymbol: string;
  // The exact subdomain this detector covers. A broad census row may not imply
  // that one narrow detector (for example BP dormancy) covers all of "vitals".
  readonly scope: string;
  readonly surfaces: readonly string[];
}

export interface DomainDetectorExclusion {
  readonly kind: ChangeDetectionKind;
  readonly scope: string;
  readonly reason: string;
}

export interface DomainChangeDetection {
  readonly detectors: readonly DomainDetectorDeclaration[];
  readonly exclusions?: readonly DomainDetectorExclusion[];
}

// A domain may use more than one of the five kinds. The row still describes rather
// than dispatches: detector modules remain independent and keep their own inputs.
export const CHANGE_DETECTION_DOMAIN_CENSUS = {
  activity: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Activity-derived numeric series represented in Trends",
        surfaces: ["Trends digest", "Trends tile badges"],
      },
    ],
  },
  food: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Protein, food-group servings, and food logging cadence",
        surfaces: ["Trends digest"],
      },
    ],
  },
  dose: {
    detectors: [
      {
        kind: "streak-lapse",
        ownerModule: "lib/intake-deltas.ts",
        ownerSymbol: "classifyIntakeDeltas",
        scope: "Confirmed-dose taken streaks and lapses",
        surfaces: ["Recap channels"],
      },
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Confirmed-dose logging cadence",
        surfaces: ["Trends digest"],
      },
    ],
  },
  weight: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Weight values and weighing cadence",
        surfaces: ["Trends digest", "Trends tile badges"],
      },
      {
        kind: "pipeline-silence",
        ownerModule: "lib/domain-dormancy.ts",
        ownerSymbol: "dormancyState",
        scope: "The weight DormancyDomain member",
        surfaces: ["Dashboard dormant-domain row"],
      },
    ],
  },
  vitals: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Vital numeric series represented in Trends",
        surfaces: ["Trends digest", "Trends tile badges"],
      },
      {
        kind: "verdict-transition",
        ownerModule: "lib/dashboard-reading-promotions.ts",
        ownerSymbol: "clinicalResultBecameNotable",
        scope: "Stored clinical-result flags for vital analytes",
        surfaces: ["Dashboard Now"],
      },
      {
        kind: "pipeline-silence",
        ownerModule: "lib/domain-dormancy.ts",
        ownerSymbol: "dormancyState",
        scope: "Blood pressure and resting heart rate only",
        surfaces: ["Dashboard dormant-domain rows"],
      },
    ],
    exclusions: [
      {
        kind: "pipeline-silence",
        scope: "All other vital quantities",
        reason:
          "domain-dormancy declares only blood-pressure and resting-hr; other vital rows keep their own presentation/freshness behavior.",
      },
    ],
  },
  temperature: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Temperature numeric series represented in Trends",
        surfaces: ["Trends digest", "Trends tile badges"],
      },
      {
        kind: "verdict-transition",
        ownerModule: "lib/dashboard-reading-promotions.ts",
        ownerSymbol: "clinicalResultBecameNotable",
        scope: "Stored clinical-result flags for temperature analytes",
        surfaces: ["Dashboard Now"],
      },
    ],
    exclusions: [
      {
        kind: "pipeline-silence",
        scope: "Temperature logging",
        reason:
          "Temperature is not a domain-dormancy member; no window-bounded temperature surface has declared a silence verdict.",
      },
    ],
  },
  practice: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Tracked-practice completed-week cadence",
        surfaces: ["Trends digest"],
      },
    ],
  },
  period: arguedExclusion(
    "Cycle logs have phase/status presentation, but no accepted change detector; this row keeps that absence explicit until the domain defines what change means."
  ),
  stool: arguedExclusion(
    "Stool logs are individual categorical observations; no cross-window change verdict has been owner-defined."
  ),
  mood: {
    detectors: [
      {
        kind: "series-magnitude",
        ownerModule: "lib/trends-digest.ts",
        ownerSymbol: "summarizeTrends",
        scope: "Mood numeric series represented in Trends",
        surfaces: ["Trends tile badges"],
      },
    ],
  },
  symptom: arguedExclusion(
    "Symptoms are presented in episode context; a generic cross-episode movement verdict would erase that context."
  ),
  substance: arguedExclusion(
    "Substance targets are cap-direction cadence tenants, while every weekly-target reading is built from the floor-direction progress rollup alone; no existing cap surface promotes a cross-window change."
  ),
  document: arguedExclusion(
    "A document is a container that produces domain records, not a measured series or arrival pipeline with its own change verdict."
  ),
} as const satisfies Record<
  LoggableDomain,
  DomainChangeDetection | ArguedExclusion
>;
