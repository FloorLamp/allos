import Link from "next/link";
import type { Insight } from "@/lib/types";
import WidgetHeader from "./WidgetHeader";

// Today's AI insight (thin wrapper; markup preserved from page.tsx).
export default function TodaysInsightWidget({
  insight,
}: {
  insight: Insight | null;
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Today's insight"
        href="/trends?tab=insights"
        linkLabel="More"
      />
      {insight ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {insight.summary.slice(0, 420)}
          {insight.summary.length > 420 ? "…" : ""}
        </p>
      ) : (
        <div className="text-sm text-slate-400 dark:text-slate-500">
          No insight generated for today yet.{" "}
          <Link
            href="/trends?tab=insights"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            Generate one
          </Link>
          .
        </div>
      )}
    </div>
  );
}
