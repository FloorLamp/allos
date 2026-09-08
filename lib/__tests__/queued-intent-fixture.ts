import { dayContextKey } from "@/lib/day-context-key";
import {
  buildIntent as buildStampedIntent,
  type FlowKind,
  type IntentPayload,
} from "@/lib/offline/queue";
import { DATED_REACH, TAP_REACH, type TapReach } from "@/lib/log-manifest";

function reachForFlow(flow: FlowKind): TapReach {
  switch (flow) {
    case "dose":
    case "skip-dose":
      return TAP_REACH["dose-status"];
    case "mobility":
      return TAP_REACH["mobility-move"];
    case "practice":
      return TAP_REACH["practice-session"];
    case "mood":
      return TAP_REACH["mood-valence"];
    case "stool":
      return TAP_REACH["stool-form"];
    case "food":
      return TAP_REACH["food-serving"];
    default:
      return DATED_REACH;
  }
}

// Existing DB fixtures use the pre-context argument order. Keep that terse spelling
// in tests while constructing the complete stamp every new production intent carries.
export function buildIntent(
  flow: FlowKind,
  date: string,
  payload: IntentPayload,
  profileId: number,
  isPrimaryDay: boolean,
  now?: Date
): ReturnType<typeof buildStampedIntent> {
  const parts = { profileId, day: date, reach: reachForFlow(flow) };
  return buildStampedIntent(
    flow,
    payload,
    { parts, key: dayContextKey(parts), isPrimaryDay },
    now
  );
}
