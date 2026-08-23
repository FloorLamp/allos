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
  readonly surfaces: readonly string[];
}

export const CHANGE_DETECTION_KIND_REGISTRY = {
  "series-magnitude": {
    ownerModule: "lib/trends-digest.ts",
    surfaces: ["Trends digest", "Trends tile badges"],
  },
  "versus-baseline": {
    ownerModule: "lib/sleep-summary.ts",
    surfaces: [
      "Dashboard sleep row",
      "Morning digest",
      "Wear reminder",
      "Weekly recap",
    ],
  },
  "streak-lapse": {
    ownerModule: "lib/intake-deltas.ts",
    surfaces: [
      "Telegram digest",
      "Weekly recap",
      "Dashboard recap",
      "Household card",
    ],
  },
  "verdict-transition": {
    ownerModule: "lib/dashboard-reading-promotions.ts",
    surfaces: ["Dashboard Now"],
  },
  "pipeline-silence": {
    ownerModule: "lib/domain-dormancy.ts",
    surfaces: ["Dashboard dormant-domain rows"],
  },
} as const satisfies Record<
  ChangeDetectionKind,
  ChangeDetectionKindDeclaration
>;

export interface DomainChangeDetection {
  readonly kinds: readonly ChangeDetectionKind[];
  readonly ownerModules: readonly `lib/${string}.ts`[];
  readonly surfaces: readonly string[];
}

// A domain may use more than one of the five kinds. The row still describes rather
// than dispatches: detector modules remain independent and keep their own inputs.
export const CHANGE_DETECTION_DOMAIN_CENSUS = {
  activity: {
    kinds: ["series-magnitude"],
    ownerModules: ["lib/trends-digest.ts"],
    surfaces: ["Trends digest", "Trends tile badges"],
  },
  food: {
    kinds: ["series-magnitude"],
    ownerModules: ["lib/trends-digest-series.ts"],
    surfaces: ["Trends digest"],
  },
  dose: {
    kinds: ["streak-lapse", "series-magnitude"],
    ownerModules: ["lib/intake-deltas.ts", "lib/trends-digest-series.ts"],
    surfaces: ["Recap channels", "Trends digest"],
  },
  weight: {
    kinds: ["series-magnitude", "pipeline-silence"],
    ownerModules: ["lib/trends-digest.ts", "lib/domain-dormancy.ts"],
    surfaces: ["Trends digest", "Trends tile badges", "Dashboard"],
  },
  vitals: {
    kinds: ["series-magnitude", "verdict-transition", "pipeline-silence"],
    ownerModules: [
      "lib/trends-digest.ts",
      "lib/dashboard-reading-promotions.ts",
      "lib/domain-dormancy.ts",
    ],
    surfaces: ["Trends", "Dashboard Now", "Dashboard"],
  },
  temperature: {
    kinds: ["series-magnitude", "verdict-transition", "pipeline-silence"],
    ownerModules: [
      "lib/trends-digest.ts",
      "lib/dashboard-reading-promotions.ts",
      "lib/domain-dormancy.ts",
    ],
    surfaces: ["Trends", "Dashboard Now", "Dashboard"],
  },
  practice: {
    kinds: ["series-magnitude"],
    ownerModules: ["lib/trends-digest-series.ts"],
    surfaces: ["Trends digest"],
  },
  period: arguedExclusion(
    "Cycle logs have phase/status presentation, but no accepted change detector; this row keeps that absence explicit until the domain defines what change means."
  ),
  stool: arguedExclusion(
    "Stool logs are individual categorical observations; no cross-window change verdict has been owner-defined."
  ),
  mood: {
    kinds: ["series-magnitude"],
    ownerModules: ["lib/trends-digest.ts"],
    surfaces: ["Trends tile badges"],
  },
  symptom: arguedExclusion(
    "Symptoms are presented in episode context; a generic cross-episode movement verdict would erase that context."
  ),
  substance: {
    kinds: ["verdict-transition"],
    ownerModules: ["lib/frequency-targets.ts"],
    surfaces: ["Weekly cap status"],
  },
  document: arguedExclusion(
    "A document is a container that produces domain records, not a measured series or arrival pipeline with its own change verdict."
  ),
} as const satisfies Record<
  LoggableDomain,
  DomainChangeDetection | ArguedExclusion
>;
