import type { UsageRollupRow, UsageStat } from "@/lib/ai-usage-rollup";
import { totalStat } from "@/lib/ai-usage-rollup";
import LogTable from "@/components/LogTable";

// The AI token-usage rollup (issue #410): calls + tokens by feature × profile over
// today and the trailing 7 days, so the admin whose API key every member spends can
// see WHERE it goes. Tokens are labeled as tokens — no dollar math (the model is in
// the log; prices drift). Server-rendered from the parsed AI log; static, no stream.

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function statCells(s: UsageStat) {
  return (
    <>
      <td className="td whitespace-nowrap text-right tabular-nums">
        {fmt(s.calls)}
      </td>
      <td className="td whitespace-nowrap text-right tabular-nums text-slate-500 dark:text-slate-400">
        {s.tokensIn + s.tokensOut > 0
          ? `${fmt(s.tokensIn)} / ${fmt(s.tokensOut)}`
          : "—"}
      </td>
    </>
  );
}

export default function UsageRollup({
  rows,
  profileNames,
}: {
  rows: UsageRollupRow[];
  profileNames: Record<number, string>;
}) {
  const today = totalStat(rows, "today");
  const week = totalStat(rows, "week");

  return (
    <div className="mb-6" data-testid="ai-usage-rollup">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Token usage
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Today: {fmt(today.calls)} calls ·{" "}
          {fmt(today.tokensIn + today.tokensOut)} tokens · 7 days:{" "}
          {fmt(week.calls)} calls · {fmt(week.tokensIn + week.tokensOut)} tokens
        </span>
      </div>

      <LogTable
        columns={[
          { label: "Feature" },
          { label: "Profile" },
          { label: "Today calls", className: "text-right" },
          { label: "Today tokens (in / out)", className: "text-right" },
          { label: "7-day calls", className: "text-right" },
          { label: "7-day tokens (in / out)", className: "text-right" },
        ]}
        isEmpty={rows.length === 0}
        emptyMessage="No AI usage recorded in the last 7 days."
      >
        {rows.map((r) => (
          <tr
            key={`${r.feature}-${r.profileId ?? "null"}`}
            className="border-b border-black/5 dark:border-white/10"
          >
            <td className="td">{r.feature}</td>
            <td className="td text-slate-500 dark:text-slate-400">
              {r.profileId == null
                ? "— (background)"
                : (profileNames[r.profileId] ?? `Profile ${r.profileId}`)}
            </td>
            {statCells(r.today)}
            {statCells(r.week)}
          </tr>
        ))}
      </LogTable>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Tokens as reported by the model API (input / output). No dollar figures
        — the model is recorded per event; compute cost from your provider’s
        current prices. Windows use the server’s date.
      </p>
    </div>
  );
}
