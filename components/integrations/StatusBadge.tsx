import { verdictBadge, type VerdictTone } from "@/lib/chart-colors";

// The integration status/outcome badge (#1772). Before it, the same three states
// wore different colours on the grid card, the setup-page status card, and Review's
// card. The pure layer decides the semantic tone; the shared verdict palette
// (#5187) turns that tone into classes, so the family cannot drift again — and no
// longer drifts against the pillar, pace and trend badges either, which used to
// keep their own copies of the same emerald/amber/rose steps.
export default function StatusBadge({
  label,
  tone,
  icon,
  testid,
}: {
  label: string;
  tone: VerdictTone;
  icon?: React.ReactNode;
  testid?: string;
}) {
  return (
    <span
      className={`badge inline-flex items-center gap-1 ${verdictBadge[tone].class}`}
      data-testid={testid}
    >
      {icon}
      {label}
    </span>
  );
}
