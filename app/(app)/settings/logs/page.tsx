import { readAiEvents } from "@/lib/ai-log";
import { rollupAiUsage } from "@/lib/ai-usage-rollup";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import SettingsGroupLayout from "../SettingsGroupLayout";
import LogsStream from "./LogsStream";
import UsageRollup from "./UsageRollup";
import { clearAiLogAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AiLogsPage() {
  // The AI log mixes extraction content (names, biomarkers) across every
  // profile, so it's admin-only — a member is redirected out by requireAdmin().
  const { login, profile } = await requireAdmin();
  // ONE bounded read shared by both consumers (#1842): the rollup wants a wider
  // horizon than the live table (up to the log's 2000-line cap) so the 7-day
  // window is complete; the table seeds from the newest 200 of the same
  // newest-first snapshot. It aggregates in-memory (issue #410).
  const events = readAiEvents(2000);
  const initial = events.slice(0, 200);
  const rollup = rollupAiUsage(events, new Date().toISOString());
  // Map profile ids → display names so the rollup names who spent the tokens.
  const profileNames = Object.fromEntries(
    (
      db.prepare("SELECT id, name FROM profiles").all() as {
        id: number;
        name: string;
      }[]
    ).map((p) => [p.id, p.name])
  );
  return (
    <SettingsGroupLayout group="logs" login={login} profile={profile}>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Every extraction, suggestion, and insight call, with token usage.
      </p>
      <UsageRollup rows={rollup} profileNames={profileNames} />
      <LogsStream initial={initial} clearAction={clearAiLogAction} />
    </SettingsGroupLayout>
  );
}
