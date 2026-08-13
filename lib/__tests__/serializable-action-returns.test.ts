// THE SERVER ACTION SERIALIZATION CENSUS (#2149 item 3).
//
// "Server Action records pass serializable data only. Do not return a
// `better-sqlite3` row proxy to a client component." (AGENTS.md) — review-only
// until this file. `lib/serializable.ts` states the rule as a type; this file is
// where it is APPLIED to every action the app ships, and where it is proven.
//
// Three parts, in the shape `canonical-unit-brands.test.ts` established:
//
//   • the CENSUS — every `"use server"` module in `app/` asserted at once, as
//     type-argument constraints that `npm run typecheck` and `npm run build` both
//     evaluate. A module whose action grows an unserializable return fails on its
//     OWN ROW, so the compiler's error names the module rather than the census.
//   • the COMPILE-TIME negatives — a deliberate `@ts-expect-error` per shape the
//     rule is about. `@ts-expect-error` asserts in both directions: the line must
//     error, and tsc reports an unused directive if it stops erroring. That is the
//     compile-time equivalent of a proven-on-the-defect test, and it is why these
//     cases live in a real spec file rather than in prose.
//   • the RUNTIME backstop — the census is a hand-listed set of imports, and a
//     type census cannot notice a module nobody added to it. The scan below walks
//     `app/` and fails when a new action module is missing, so the list cannot rot
//     into a guard that passes because it stopped looking.
//
// Why this is worth a census rather than review: React serializes an action's
// resolved value to send it back to the browser, so an unserializable value throws
// AT RUNTIME, in production, on whichever branch of the action happened to produce
// it. The action's own module compiles perfectly either way.
//
// The census is CLEAN as of its introduction — all 95 modules pass. It is a
// ratchet, not a cleanup: it exists so that the next one has to.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionsAreSerializable,
  AssertSerializable,
  Serializable,
} from "@/lib/serializable";

// Type-only: every one of these pulls in `@/lib/db`, `@/lib/auth` and the rest of
// the server at runtime, and this is the pure tier. `import type` is erased
// entirely, so the whole action boundary is checked here without a database ever
// being opened.
import type * as M0 from "@/app/(app)/actions";
import type * as M1 from "@/app/(app)/data/actions";
import type * as M2 from "@/app/(app)/data/bulk-correction-actions";
import type * as M3 from "@/app/(app)/data/coverage-actions";
import type * as M4 from "@/app/(app)/data/manage-actions";
import type * as M5 from "@/app/(app)/data/review-actions";
import type * as M6 from "@/app/(app)/data/trash-actions";
import type * as M7 from "@/app/(app)/encounters/actions";
import type * as M8 from "@/app/(app)/encounters/appointment-actions";
import type * as M9 from "@/app/(app)/equipment/actions";
import type * as M10 from "@/app/(app)/household/actions";
import type * as M11 from "@/app/(app)/immunizations/actions";
import type * as M12 from "@/app/(app)/integrations/calendar-feed/actions";
import type * as M13 from "@/app/(app)/integrations/health-connect/actions";
import type * as M14 from "@/app/(app)/integrations/oura/actions";
import type * as M15 from "@/app/(app)/integrations/patient-portals/actions";
import type * as M16 from "@/app/(app)/integrations/strava/actions";
import type * as M17 from "@/app/(app)/integrations/sync-actions";
import type * as M18 from "@/app/(app)/integrations/weather/actions";
import type * as M19 from "@/app/(app)/integrations/withings/actions";
import type * as M20 from "@/app/(app)/medical/background/actions";
import type * as M21 from "@/app/(app)/medical/cycles/actions";
import type * as M22 from "@/app/(app)/medical/cycles/ttc-actions";
import type * as M23 from "@/app/(app)/medical/document-actions";
import type * as M24 from "@/app/(app)/medical/episodes/actions";
import type * as M25 from "@/app/(app)/medical/instruments/actions";
import type * as M26 from "@/app/(app)/medical/substance-use/actions";
import type * as M27 from "@/app/(app)/medications/actions";
import type * as M28 from "@/app/(app)/mood-actions";
import type * as M29 from "@/app/(app)/nutrition/actions";
import type * as M30 from "@/app/(app)/nutrition/intake-actions";
import type * as M31 from "@/app/(app)/onboarding/actions";
import type * as M32 from "@/app/(app)/palette-actions";
import type * as M33 from "@/app/(app)/profile-context-actions";
import type * as M34 from "@/app/(app)/profile/actions";
import type * as M35 from "@/app/(app)/progress/actions";
import type * as M36 from "@/app/(app)/protocols/actions";
import type * as M37 from "@/app/(app)/providers/actions";
import type * as M38 from "@/app/(app)/quick-entry-actions";
import type * as M39 from "@/app/(app)/records/care/overview/care-goal-actions";
import type * as M40 from "@/app/(app)/records/care/overview/care-plan-actions";
import type * as M41 from "@/app/(app)/records/care/overview/family-history-actions";
import type * as M42 from "@/app/(app)/records/history/procedures/actions";
import type * as M43 from "@/app/(app)/records/problems/allergies/actions";
import type * as M44 from "@/app/(app)/records/problems/conditions/actions";
import type * as M45 from "@/app/(app)/records/specialty/dental/actions";
import type * as M46 from "@/app/(app)/records/specialty/hearing/actions";
import type * as M47 from "@/app/(app)/records/specialty/skin/actions";
import type * as M48 from "@/app/(app)/records/specialty/vision/actions";
import type * as M49 from "@/app/(app)/results/actions";
import type * as M50 from "@/app/(app)/results/genomics/actions";
import type * as M51 from "@/app/(app)/results/imaging/actions";
import type * as M52 from "@/app/(app)/results/reading-actions";
import type * as M53 from "@/app/(app)/results/readings/biomarker-actions";
import type * as M54 from "@/app/(app)/rightsize-actions";
import type * as M55 from "@/app/(app)/saved-actions";
import type * as M56 from "@/app/(app)/search-actions";
import type * as M57 from "@/app/(app)/session-actions";
import type * as M58 from "@/app/(app)/settings/actions";
import type * as M59 from "@/app/(app)/settings/ai/actions";
import type * as M60 from "@/app/(app)/settings/errors/actions";
import type * as M61 from "@/app/(app)/settings/family/actions";
import type * as M62 from "@/app/(app)/settings/logs/actions";
import type * as M63 from "@/app/(app)/settings/notify-log/actions";
import type * as M64 from "@/app/(app)/settings/photo-actions";
import type * as M65 from "@/app/(app)/settings/profile/actions";
import type * as M66 from "@/app/(app)/settings/server/actions";
import type * as M67 from "@/app/(app)/settings/token-actions";
import type * as M68 from "@/app/(app)/sleep/actions";
import type * as M69 from "@/app/(app)/stream-lifecycle-actions";
import type * as M70 from "@/app/(app)/supplies/actions";
import type * as M71 from "@/app/(app)/symptom-actions";
import type * as M72 from "@/app/(app)/training/actions";
import type * as M73 from "@/app/(app)/training/activity-actions";
import type * as M74 from "@/app/(app)/training/endurance-actions";
import type * as M75 from "@/app/(app)/training/fitness-actions";
import type * as M76 from "@/app/(app)/training/frequency-actions";
import type * as M77 from "@/app/(app)/training/goal-actions";
import type * as M78 from "@/app/(app)/training/injury-actions";
import type * as M79 from "@/app/(app)/training/mobility-actions";
import type * as M80 from "@/app/(app)/training/video-actions";
import type * as M81 from "@/app/(app)/trends/actions";
import type * as M82 from "@/app/(app)/trends/body-actions";
import type * as M83 from "@/app/(app)/trends/measurement-actions";
import type * as M84 from "@/app/(app)/trends/peak-flow-actions";
import type * as M85 from "@/app/(app)/trends/reading-actions";
import type * as M86 from "@/app/(app)/trends/source-actions";
import type * as M87 from "@/app/(app)/undo-actions";
import type * as M88 from "@/app/(app)/upcoming/actions";
import type * as M89 from "@/app/(app)/visit-link-actions";
import type * as M90 from "@/app/(app)/wellness/actions";
import type * as M91 from "@/app/(app)/whats-new/actions";
import type * as M92 from "@/app/(auth)/forgot-password/actions";
import type * as M93 from "@/app/(auth)/login/actions";
import type * as M94 from "@/app/(auth)/set-password/actions";
import type * as M95 from "@/app/(app)/log-sheet-actions";

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * The assertion itself. A constraint rather than an assignment, so it is erased
 * at runtime and evaluated by tsc where it is written: `false` does not satisfy
 * `true`, and the error points at the row.
 */
type Expect<T extends true> = T;

type Census = {
  "app/(app)/actions.ts": Expect<ActionsAreSerializable<typeof M0>>;
  "app/(app)/data/actions.ts": Expect<ActionsAreSerializable<typeof M1>>;
  "app/(app)/data/bulk-correction-actions.ts": Expect<
    ActionsAreSerializable<typeof M2>
  >;
  "app/(app)/data/coverage-actions.ts": Expect<
    ActionsAreSerializable<typeof M3>
  >;
  "app/(app)/data/manage-actions.ts": Expect<ActionsAreSerializable<typeof M4>>;
  "app/(app)/data/review-actions.ts": Expect<ActionsAreSerializable<typeof M5>>;
  "app/(app)/data/trash-actions.ts": Expect<ActionsAreSerializable<typeof M6>>;
  "app/(app)/encounters/actions.ts": Expect<ActionsAreSerializable<typeof M7>>;
  "app/(app)/encounters/appointment-actions.ts": Expect<
    ActionsAreSerializable<typeof M8>
  >;
  "app/(app)/equipment/actions.ts": Expect<ActionsAreSerializable<typeof M9>>;
  "app/(app)/household/actions.ts": Expect<ActionsAreSerializable<typeof M10>>;
  "app/(app)/immunizations/actions.ts": Expect<
    ActionsAreSerializable<typeof M11>
  >;
  "app/(app)/integrations/calendar-feed/actions.ts": Expect<
    ActionsAreSerializable<typeof M12>
  >;
  "app/(app)/integrations/health-connect/actions.ts": Expect<
    ActionsAreSerializable<typeof M13>
  >;
  "app/(app)/integrations/oura/actions.ts": Expect<
    ActionsAreSerializable<typeof M14>
  >;
  "app/(app)/integrations/patient-portals/actions.ts": Expect<
    ActionsAreSerializable<typeof M15>
  >;
  "app/(app)/integrations/strava/actions.ts": Expect<
    ActionsAreSerializable<typeof M16>
  >;
  "app/(app)/integrations/sync-actions.ts": Expect<
    ActionsAreSerializable<typeof M17>
  >;
  "app/(app)/integrations/weather/actions.ts": Expect<
    ActionsAreSerializable<typeof M18>
  >;
  "app/(app)/integrations/withings/actions.ts": Expect<
    ActionsAreSerializable<typeof M19>
  >;
  "app/(app)/log-sheet-actions.ts": Expect<ActionsAreSerializable<typeof M95>>;
  "app/(app)/medical/background/actions.ts": Expect<
    ActionsAreSerializable<typeof M20>
  >;
  "app/(app)/medical/cycles/actions.ts": Expect<
    ActionsAreSerializable<typeof M21>
  >;
  "app/(app)/medical/cycles/ttc-actions.ts": Expect<
    ActionsAreSerializable<typeof M22>
  >;
  "app/(app)/medical/document-actions.ts": Expect<
    ActionsAreSerializable<typeof M23>
  >;
  "app/(app)/medical/episodes/actions.ts": Expect<
    ActionsAreSerializable<typeof M24>
  >;
  "app/(app)/medical/instruments/actions.ts": Expect<
    ActionsAreSerializable<typeof M25>
  >;
  "app/(app)/medical/substance-use/actions.ts": Expect<
    ActionsAreSerializable<typeof M26>
  >;
  "app/(app)/medications/actions.ts": Expect<
    ActionsAreSerializable<typeof M27>
  >;
  "app/(app)/mood-actions.ts": Expect<ActionsAreSerializable<typeof M28>>;
  "app/(app)/nutrition/actions.ts": Expect<ActionsAreSerializable<typeof M29>>;
  "app/(app)/nutrition/intake-actions.ts": Expect<
    ActionsAreSerializable<typeof M30>
  >;
  "app/(app)/onboarding/actions.ts": Expect<ActionsAreSerializable<typeof M31>>;
  "app/(app)/palette-actions.ts": Expect<ActionsAreSerializable<typeof M32>>;
  "app/(app)/profile-context-actions.ts": Expect<
    ActionsAreSerializable<typeof M33>
  >;
  "app/(app)/profile/actions.ts": Expect<ActionsAreSerializable<typeof M34>>;
  "app/(app)/progress/actions.ts": Expect<ActionsAreSerializable<typeof M35>>;
  "app/(app)/protocols/actions.ts": Expect<ActionsAreSerializable<typeof M36>>;
  "app/(app)/providers/actions.ts": Expect<ActionsAreSerializable<typeof M37>>;
  "app/(app)/quick-entry-actions.ts": Expect<
    ActionsAreSerializable<typeof M38>
  >;
  "app/(app)/records/care/overview/care-goal-actions.ts": Expect<
    ActionsAreSerializable<typeof M39>
  >;
  "app/(app)/records/care/overview/care-plan-actions.ts": Expect<
    ActionsAreSerializable<typeof M40>
  >;
  "app/(app)/records/care/overview/family-history-actions.ts": Expect<
    ActionsAreSerializable<typeof M41>
  >;
  "app/(app)/records/history/procedures/actions.ts": Expect<
    ActionsAreSerializable<typeof M42>
  >;
  "app/(app)/records/problems/allergies/actions.ts": Expect<
    ActionsAreSerializable<typeof M43>
  >;
  "app/(app)/records/problems/conditions/actions.ts": Expect<
    ActionsAreSerializable<typeof M44>
  >;
  "app/(app)/records/specialty/dental/actions.ts": Expect<
    ActionsAreSerializable<typeof M45>
  >;
  "app/(app)/records/specialty/hearing/actions.ts": Expect<
    ActionsAreSerializable<typeof M46>
  >;
  "app/(app)/records/specialty/skin/actions.ts": Expect<
    ActionsAreSerializable<typeof M47>
  >;
  "app/(app)/records/specialty/vision/actions.ts": Expect<
    ActionsAreSerializable<typeof M48>
  >;
  "app/(app)/results/actions.ts": Expect<ActionsAreSerializable<typeof M49>>;
  "app/(app)/results/genomics/actions.ts": Expect<
    ActionsAreSerializable<typeof M50>
  >;
  "app/(app)/results/imaging/actions.ts": Expect<
    ActionsAreSerializable<typeof M51>
  >;
  "app/(app)/results/reading-actions.ts": Expect<
    ActionsAreSerializable<typeof M52>
  >;
  "app/(app)/results/readings/biomarker-actions.ts": Expect<
    ActionsAreSerializable<typeof M53>
  >;
  "app/(app)/rightsize-actions.ts": Expect<ActionsAreSerializable<typeof M54>>;
  "app/(app)/saved-actions.ts": Expect<ActionsAreSerializable<typeof M55>>;
  "app/(app)/search-actions.ts": Expect<ActionsAreSerializable<typeof M56>>;
  "app/(app)/session-actions.ts": Expect<ActionsAreSerializable<typeof M57>>;
  "app/(app)/settings/actions.ts": Expect<ActionsAreSerializable<typeof M58>>;
  "app/(app)/settings/ai/actions.ts": Expect<
    ActionsAreSerializable<typeof M59>
  >;
  "app/(app)/settings/errors/actions.ts": Expect<
    ActionsAreSerializable<typeof M60>
  >;
  "app/(app)/settings/family/actions.ts": Expect<
    ActionsAreSerializable<typeof M61>
  >;
  "app/(app)/settings/logs/actions.ts": Expect<
    ActionsAreSerializable<typeof M62>
  >;
  "app/(app)/settings/notify-log/actions.ts": Expect<
    ActionsAreSerializable<typeof M63>
  >;
  "app/(app)/settings/photo-actions.ts": Expect<
    ActionsAreSerializable<typeof M64>
  >;
  "app/(app)/settings/profile/actions.ts": Expect<
    ActionsAreSerializable<typeof M65>
  >;
  "app/(app)/settings/server/actions.ts": Expect<
    ActionsAreSerializable<typeof M66>
  >;
  "app/(app)/settings/token-actions.ts": Expect<
    ActionsAreSerializable<typeof M67>
  >;
  "app/(app)/sleep/actions.ts": Expect<ActionsAreSerializable<typeof M68>>;
  "app/(app)/stream-lifecycle-actions.ts": Expect<
    ActionsAreSerializable<typeof M69>
  >;
  "app/(app)/supplies/actions.ts": Expect<ActionsAreSerializable<typeof M70>>;
  "app/(app)/symptom-actions.ts": Expect<ActionsAreSerializable<typeof M71>>;
  "app/(app)/training/actions.ts": Expect<ActionsAreSerializable<typeof M72>>;
  "app/(app)/training/activity-actions.ts": Expect<
    ActionsAreSerializable<typeof M73>
  >;
  "app/(app)/training/endurance-actions.ts": Expect<
    ActionsAreSerializable<typeof M74>
  >;
  "app/(app)/training/fitness-actions.ts": Expect<
    ActionsAreSerializable<typeof M75>
  >;
  "app/(app)/training/frequency-actions.ts": Expect<
    ActionsAreSerializable<typeof M76>
  >;
  "app/(app)/training/goal-actions.ts": Expect<
    ActionsAreSerializable<typeof M77>
  >;
  "app/(app)/training/injury-actions.ts": Expect<
    ActionsAreSerializable<typeof M78>
  >;
  "app/(app)/training/mobility-actions.ts": Expect<
    ActionsAreSerializable<typeof M79>
  >;
  "app/(app)/training/video-actions.ts": Expect<
    ActionsAreSerializable<typeof M80>
  >;
  "app/(app)/trends/actions.ts": Expect<ActionsAreSerializable<typeof M81>>;
  "app/(app)/trends/body-actions.ts": Expect<
    ActionsAreSerializable<typeof M82>
  >;
  "app/(app)/trends/measurement-actions.ts": Expect<
    ActionsAreSerializable<typeof M83>
  >;
  "app/(app)/trends/peak-flow-actions.ts": Expect<
    ActionsAreSerializable<typeof M84>
  >;
  "app/(app)/trends/reading-actions.ts": Expect<
    ActionsAreSerializable<typeof M85>
  >;
  "app/(app)/trends/source-actions.ts": Expect<
    ActionsAreSerializable<typeof M86>
  >;
  "app/(app)/undo-actions.ts": Expect<ActionsAreSerializable<typeof M87>>;
  "app/(app)/upcoming/actions.ts": Expect<ActionsAreSerializable<typeof M88>>;
  "app/(app)/visit-link-actions.ts": Expect<ActionsAreSerializable<typeof M89>>;
  "app/(app)/wellness/actions.ts": Expect<ActionsAreSerializable<typeof M90>>;
  "app/(app)/whats-new/actions.ts": Expect<ActionsAreSerializable<typeof M91>>;
  "app/(auth)/forgot-password/actions.ts": Expect<
    ActionsAreSerializable<typeof M92>
  >;
  "app/(auth)/login/actions.ts": Expect<ActionsAreSerializable<typeof M93>>;
  "app/(auth)/set-password/actions.ts": Expect<
    ActionsAreSerializable<typeof M94>
  >;
};

// The module paths the census covers, as data the runtime scan below can read.
// Kept beside the census rather than derived from it: `keyof Census` is erased,
// and a guard that cannot be read at runtime cannot notice its own gaps.
const CENSUSED_MODULES = [
  "app/(app)/actions.ts",
  "app/(app)/data/actions.ts",
  "app/(app)/data/bulk-correction-actions.ts",
  "app/(app)/data/coverage-actions.ts",
  "app/(app)/data/manage-actions.ts",
  "app/(app)/data/review-actions.ts",
  "app/(app)/data/trash-actions.ts",
  "app/(app)/encounters/actions.ts",
  "app/(app)/encounters/appointment-actions.ts",
  "app/(app)/equipment/actions.ts",
  "app/(app)/household/actions.ts",
  "app/(app)/immunizations/actions.ts",
  "app/(app)/integrations/calendar-feed/actions.ts",
  "app/(app)/integrations/health-connect/actions.ts",
  "app/(app)/integrations/oura/actions.ts",
  "app/(app)/integrations/patient-portals/actions.ts",
  "app/(app)/integrations/strava/actions.ts",
  "app/(app)/integrations/sync-actions.ts",
  "app/(app)/integrations/weather/actions.ts",
  "app/(app)/integrations/withings/actions.ts",
  "app/(app)/log-sheet-actions.ts",
  "app/(app)/medical/background/actions.ts",
  "app/(app)/medical/cycles/actions.ts",
  "app/(app)/medical/cycles/ttc-actions.ts",
  "app/(app)/medical/document-actions.ts",
  "app/(app)/medical/episodes/actions.ts",
  "app/(app)/medical/instruments/actions.ts",
  "app/(app)/medical/substance-use/actions.ts",
  "app/(app)/medications/actions.ts",
  "app/(app)/mood-actions.ts",
  "app/(app)/nutrition/actions.ts",
  "app/(app)/nutrition/intake-actions.ts",
  "app/(app)/onboarding/actions.ts",
  "app/(app)/palette-actions.ts",
  "app/(app)/profile-context-actions.ts",
  "app/(app)/profile/actions.ts",
  "app/(app)/progress/actions.ts",
  "app/(app)/protocols/actions.ts",
  "app/(app)/providers/actions.ts",
  "app/(app)/quick-entry-actions.ts",
  "app/(app)/records/care/overview/care-goal-actions.ts",
  "app/(app)/records/care/overview/care-plan-actions.ts",
  "app/(app)/records/care/overview/family-history-actions.ts",
  "app/(app)/records/history/procedures/actions.ts",
  "app/(app)/records/problems/allergies/actions.ts",
  "app/(app)/records/problems/conditions/actions.ts",
  "app/(app)/records/specialty/dental/actions.ts",
  "app/(app)/records/specialty/hearing/actions.ts",
  "app/(app)/records/specialty/skin/actions.ts",
  "app/(app)/records/specialty/vision/actions.ts",
  "app/(app)/results/actions.ts",
  "app/(app)/results/genomics/actions.ts",
  "app/(app)/results/imaging/actions.ts",
  "app/(app)/results/reading-actions.ts",
  "app/(app)/results/readings/biomarker-actions.ts",
  "app/(app)/rightsize-actions.ts",
  "app/(app)/saved-actions.ts",
  "app/(app)/search-actions.ts",
  "app/(app)/session-actions.ts",
  "app/(app)/settings/actions.ts",
  "app/(app)/settings/ai/actions.ts",
  "app/(app)/settings/errors/actions.ts",
  "app/(app)/settings/family/actions.ts",
  "app/(app)/settings/logs/actions.ts",
  "app/(app)/settings/notify-log/actions.ts",
  "app/(app)/settings/photo-actions.ts",
  "app/(app)/settings/profile/actions.ts",
  "app/(app)/settings/server/actions.ts",
  "app/(app)/settings/token-actions.ts",
  "app/(app)/sleep/actions.ts",
  "app/(app)/stream-lifecycle-actions.ts",
  "app/(app)/supplies/actions.ts",
  "app/(app)/symptom-actions.ts",
  "app/(app)/training/actions.ts",
  "app/(app)/training/activity-actions.ts",
  "app/(app)/training/endurance-actions.ts",
  "app/(app)/training/fitness-actions.ts",
  "app/(app)/training/frequency-actions.ts",
  "app/(app)/training/goal-actions.ts",
  "app/(app)/training/injury-actions.ts",
  "app/(app)/training/mobility-actions.ts",
  "app/(app)/training/video-actions.ts",
  "app/(app)/trends/actions.ts",
  "app/(app)/trends/body-actions.ts",
  "app/(app)/trends/measurement-actions.ts",
  "app/(app)/trends/peak-flow-actions.ts",
  "app/(app)/trends/reading-actions.ts",
  "app/(app)/trends/source-actions.ts",
  "app/(app)/undo-actions.ts",
  "app/(app)/upcoming/actions.ts",
  "app/(app)/visit-link-actions.ts",
  "app/(app)/wellness/actions.ts",
  "app/(app)/whats-new/actions.ts",
  "app/(auth)/forgot-password/actions.ts",
  "app/(auth)/login/actions.ts",
  "app/(auth)/set-password/actions.ts",
] as const;

// Neither list may name a module the other does not.
type CensusKey = keyof Census;
type ListedKey = (typeof CENSUSED_MODULES)[number];
type _ListedAreCensused = Expect<ListedKey extends CensusKey ? true : false>;
type _CensusedAreListed = Expect<CensusKey extends ListedKey ? true : false>;

// ---------------------------------------------------------------------------
// The compile-time negatives
// ---------------------------------------------------------------------------

// Stand-ins for the shapes the rule is about. Declared rather than constructed:
// the assertion is about the TYPE reaching the boundary, and none of these values
// has to exist for that to be checked.
declare namespace RowProxyAction {
  // The named defect. A `better-sqlite3` `Statement` handed back instead of the
  // rows it would produce — the shape AGENTS.md calls out by name.
  function loadRows(): Promise<{
    stmt: { all: () => unknown[]; run: (id: number) => void };
  }>;
}

declare namespace CallbackAction {
  // A callback smuggled through an otherwise ordinary record. The most survivable
  // version of the defect: everything around it serializes, so nothing looks wrong.
  function save(): Promise<{ ok: true; onUndo: () => void }>;
}

declare namespace ClassInstanceAction {
  // A class instance is rejected BECAUSE its prototype carries methods, which is
  // also why a plain object carrying one function is rejected in the same breath.
  function readFile(): Promise<{ handle: fs.ReadStream }>;
}

declare namespace PlainDataAction {
  // The control. Records, unions, nulls, arrays and `void` — what actions really
  // return — must keep passing, or the census is only noise.
  function saveThing(): Promise<
    | { ok: false; error: string }
    | { ok: true; id: number; rows: { id: number; name: string | null }[] }
  >;
  function revalidateOnly(): Promise<void>;
  function countThings(): Promise<number>;
}

describe("the boundary type rejects what React cannot send", () => {
  it("a row-proxy-shaped return", () => {
    // @ts-expect-error a `Statement` is not data — its methods cannot be sent, so
    // this module's actions do not all serialize and its census entry is `false`.
    const rejected: ActionsAreSerializable<typeof RowProxyAction> = true;
    void rejected;
    // The directive above is the real assertion; this pins what it resolves to.
    const actual: ActionsAreSerializable<typeof RowProxyAction> = false;
    expect(actual).toBe(false);
  });

  it("a callback hidden inside an otherwise serializable record", () => {
    // @ts-expect-error `onUndo` is a function; the `{ ok: true }` around it does
    // not decide, because a record serializes only if all of it does.
    const rejected: ActionsAreSerializable<typeof CallbackAction> = true;
    void rejected;
    const actual: ActionsAreSerializable<typeof CallbackAction> = false;
    expect(actual).toBe(false);
  });

  it("a class instance", () => {
    // @ts-expect-error a `ReadStream` carries prototype methods, so it is a handle
    // ON data rather than data.
    const rejected: ActionsAreSerializable<typeof ClassInstanceAction> = true;
    void rejected;
    const actual: ActionsAreSerializable<typeof ClassInstanceAction> = false;
    expect(actual).toBe(false);
  });

  it("but passes the records actions actually return", () => {
    const accepted: ActionsAreSerializable<typeof PlainDataAction> = true;
    expect(accepted).toBe(true);
  });

  it("fails at the value's own declaration, not where it is sent", () => {
    type Row = { id: number; refresh: () => void };
    // `AssertSerializable` resolves to a nominal marker nothing assigns to, so an
    // action annotated with it fails at its SIGNATURE rather than at a call site
    // or, as today, at runtime in the browser.
    const marker = null as unknown as AssertSerializable<Row>;
    // @ts-expect-error the marker is not the record — which is the whole point.
    const back: Row = marker;
    void back;
    expect(marker).toBeNull();
  });
});

describe("the type is erased, so nothing about the data moves", () => {
  it("passes an ordinary record through unchanged", () => {
    const row: Serializable<{ id: number; name: string | null }> = {
      id: 7,
      name: "row nine",
    };
    expect(JSON.stringify(row)).toBe('{"id":7,"name":"row nine"}');
  });

  it("says nothing about unknown, which is not evidence of anything", () => {
    // An action typed `unknown` is not a defect this type can see, and rejecting
    // it would teach a reviewer nothing. `true` here is the deliberate choice.
    const permissive: ActionsAreSerializable<{
      readAnything: () => Promise<unknown>;
    }> = true;
    expect(permissive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The runtime backstop
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function actionModules(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      actionModules(full, out);
    } else if (entry.isFile() && /actions.*\.ts$/.test(entry.name)) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  return out;
}

describe("the census covers the whole action boundary", () => {
  it("names every server-action module under app/", () => {
    const onDisk = actionModules(path.join(REPO_ROOT, "app"), []).sort();
    // A new action module must join the census. Adding the import and the row is
    // the whole cost, and skipping it is the one way this guard could keep passing
    // while no longer looking at everything.
    expect(onDisk).toEqual([...CENSUSED_MODULES]);
  });

  it("censuses modules that really are server actions", () => {
    for (const rel of CENSUSED_MODULES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text.slice(0, 200)).toContain("use server");
    }
  });
});
