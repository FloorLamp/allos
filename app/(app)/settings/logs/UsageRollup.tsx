import type { UsageRollupRow, UsageStat } from "@/lib/ai-usage-rollup";
import { totalStat } from "@/lib/ai-usage-rollup";
import ScrollFade from "@/components/ScrollFade";

// The AI token-usage rollup (issue #410): calls + tokens by feature × profile over
// today and the trailing 7 days, so the admin whose API key every member spends can
// see WHERE it goes. Tokens are labeled as tokens — no dollar math (the model is in
// the log; prices drift). Server-rendered from the parsed AI log; static, no stream.

function fmt(n: number): string {
  return n.toLocaleString();
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

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/10 bg-white p-6 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400">
          No AI usage recorded in the last 7 days.
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <ScrollFade>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-400">
                  <th className="th">Feature</th>
                  <th className="th">Profile</th>
                  <th className="th text-right">Today calls</th>
                  <th className="th text-right">Today tokens (in / out)</th>
                  <th className="th text-right">7-day calls</th>
                  <th className="th text-right">7-day tokens (in / out)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.feature}-${r.profileId ?? "null"}`}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="td">{r.feature}</td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {r.profileId == null
                        ? "— (background)"
                        : (profileNames[r.profileId] ??
                          `Profile ${r.profileId}`)}
                    </td>
                    {statCells(r.today)}
                    {statCells(r.week)}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFade>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Tokens as reported by the model API (input / output). No dollar figures
        — the model is recorded per event; compute cost from your provider’s
        current prices. Windows use the server’s date.
      </p>
    </div>
  );
}
