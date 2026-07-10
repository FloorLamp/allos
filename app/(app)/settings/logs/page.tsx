import { readAiEvents } from "@/lib/ai-log";
import { requireAdmin } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import LogsStream from "./LogsStream";

export const dynamic = "force-dynamic";

export default async function AiLogsPage() {
  // The AI log mixes extraction content (names, biomarkers) across every
  // profile, so it's admin-only — a member is redirected out by requireAdmin().
  const { profile } = await requireAdmin();
  const initial = readAiEvents(200);
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="AI activity log — every extraction, suggestion, and insight call. Streams live; also written to data/logs/ai.jsonl."
      />
      <SettingsTabs isAdmin hideEquipment={isTrainingRestricted(profile.id)} />
      <LogsStream initial={initial} />
    </div>
  );
}
