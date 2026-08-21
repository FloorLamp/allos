import {
  IconActivityHeartbeat,
  IconBolt,
  IconGauge,
  IconMessage,
} from "@tabler/icons-react";
import type { DashboardCandidateKind } from "@/lib/dashboard-relevance";

// THE KIND GLYPH — on CARDS only, never on readings (#3253 decision 3).
//
// A Now or Ahead card carries one small glyph naming what KIND of thing it is: an
// action asks you to do something, a statement tells you something, a state says a
// situation is running. A Standing reading LINE gets none, and that asymmetry is the
// design rather than an oversight: a line that earned a glyph would be halfway to a
// card, and cards-act / lines-report is the whole grammar of the placement manifest
// (#3077). Zone headers stay bare text for the same reason.
//
// It renders in the PLACER (NowStrip's card wrapper, DashboardAhead's member row),
// not inside the cards themselves. The kind is a property of the CANDIDATE — the same
// thing the wrapper already publishes as `data-kind` — so the placer is where it is
// known once for every card, and no card component has to grow a prop it would then
// be free to render differently. It also means the glyph can never collide with a
// card's own header controls: it sits in a gutter beside the card, not on top of it.
//
// `reading` has a glyph because a PROMOTED reading is a card: a reading whose value
// just changed is ranked into Now and rendered as a card there (#3077's closed
// promotion registry), and the acceptance criterion is that every Now/Ahead card
// shows exactly one. The rule is about the ELEMENT — a card — not about the kind.

// DECORATIVE, deliberately. The glyph repeats what the card's own words already say
// — it is a shape for the eye scanning a column, not a fact — so it is aria-hidden and
// carries no title. What a TEST reads is `data-kind-glyph`, and what a screen reader
// reads is the card.
const GLYPHS: Record<DashboardCandidateKind, typeof IconBolt> = {
  // A bolt: something for you to do.
  action: IconBolt,
  // A speech bubble: something the app is telling you.
  statement: IconMessage,
  // A pulse: a situation that is running right now.
  state: IconActivityHeartbeat,
  // A gauge: a measurement. Only ever seen on a promoted reading's card.
  reading: IconGauge,
};

export default function CandidateKindGlyph({
  kind,
  className = "mt-1 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400",
}: {
  kind: DashboardCandidateKind;
  className?: string;
}) {
  const Icon = GLYPHS[kind];
  return (
    <Icon
      data-testid="candidate-kind-glyph"
      data-kind-glyph={kind}
      className={className}
      // The app's Tabler stroke convention, matching every other inline glyph on
      // this surface (the cockpit's virus, the standing chevrons).
      stroke={1.75}
      aria-hidden="true"
    />
  );
}
