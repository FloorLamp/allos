import type { ReactNode } from "react";
import CardGroup from "@/components/CardGroup";
import type { SessionComparison } from "@/lib/session-detail";

// The comparison math and chart are shared below this component; this owns the
// surrounding hierarchy and explanation so activity types cannot drift into
// different presentations of the same answer.
export default function SessionComparisonCard({
  comparison,
  children,
  testId = "session-comparison",
}: {
  comparison: Pick<
    SessionComparison,
    "sessionCount" | "tolerancePercent" | "basis"
  >;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <CardGroup
      title="Compared with similar sessions"
      description={`Median of ${comparison.sessionCount} similar ${
        comparison.sessionCount === 1 ? "session" : "sessions"
      } within ${comparison.tolerancePercent}% of this session’s ${comparison.basis}.`}
      className="mt-4"
      data-testid={testId}
    >
      {children}
    </CardGroup>
  );
}
