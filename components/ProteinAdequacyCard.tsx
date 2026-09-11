import type { ProteinAdequacy, ProteinToday } from "@/lib/protein";
import AdequacyRow from "./AdequacyRow";
import ProteinGauge from "./ProteinGauge";

// The protein ROW of the "Today's nutrients" card (issues #767, #824, #974, #980). A pure
// formatter over the ONE computation (getProteinToday + getProteinAdequacy → the pure
// protein engine), shared with the coaching-tier adequacy finding so the surfaces can't
// disagree — the FINDING copy is untouched, this is one more formatter (#980 item 1). The
// row's accent, heading and verdict word are AdequacyRow's, shared with fiber (#4485);
// the band gauge (#974) leads beneath them. The gram quick-add lives in the food logging
// flow, leaving this analysis row read-only. Coaching tier only — never a push.

const STATUS_LABEL: Record<string, string> = {
  below: "Below goal",
  within: "In range",
  above: "Above goal",
};

export default function ProteinAdequacyCard({
  today,
  adequacy,
  periodLabel,
}: {
  // The band-gauge model (#974) — today so far + weekly average + goal band.
  today: ProteinToday | null;
  // The weekly adequacy verdict (#767) — the caption copy + status accent.
  adequacy: ProteinAdequacy | null;
  // "Today" by default; historical date views pass "Yesterday" / the formatted
  // weekday so the gauge never labels an older estimate as today's.
  periodLabel?: string;
}) {
  if (!today && !adequacy) return null;
  // The accent follows the WEEKLY verdict, never today's in-progress figure.
  const status = adequacy?.status;
  return (
    <AdequacyRow
      testId="protein-adequacy"
      title="Protein"
      status={status}
      basis={adequacy?.intake.basis ?? today?.todayIntake?.basis ?? ""}
      statusLabel={status && STATUS_LABEL[status]}
    >
      {today && <ProteinGauge today={today} periodLabel={periodLabel} />}
    </AdequacyRow>
  );
}
