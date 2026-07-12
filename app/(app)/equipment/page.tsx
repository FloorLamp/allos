import { redirect } from "next/navigation";
import { getEquipment } from "@/lib/equipment";
import { getEquipmentUsage } from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import EquipmentManager, {
  type EquipmentUsageBadge,
} from "@/components/EquipmentManager";

export const dynamic = "force-dynamic";

// The equipment registry index (issue #343): a per-profile inventory of bars,
// implements, cardio gear, and recovery devices, grouped by kind with an
// active/retired split and a per-item usage badge. Each row links to
// /equipment/[id] for the full usage payoff. Reached contextually (the activity
// form's "manage equipment" link, journal gear chips, protocol gear refs), not
// from top-level nav — it's an occasionally-visited registry.
export default async function EquipmentPage() {
  const { login, profile } = await requireSession();
  // Age-restricted profiles can't reach equipment even by direct URL (the fitness
  // surfaces are hidden for them); bounce to the dashboard. Mirrors /training.
  if (isTrainingRestricted(profile.id)) redirect("/");

  // includeRetired: the registry lists retired gear too (with an Unretire action).
  const equipment = getEquipment(profile.id, { includeRetired: true });
  const usageMap = getEquipmentUsage(profile.id);
  const units = getUnitPrefs(login.id);

  // The one usage read (getEquipmentUsage) feeds the index badges here and the
  // detail page alike — same computation, two formatters. Reduce it to the badge
  // shape the manager needs.
  const usage: Record<number, EquipmentUsageBadge> = {};
  for (const [id, u] of usageMap) usage[id] = { sessions: u.sessions };

  return (
    <div data-testid="equipment-index">
      <PageHeader
        title="Equipment"
        subtitle="Your bars, implements, cardio gear, and recovery devices — with how much each has been used. Tag sessions with them to build usage history."
      />
      <EquipmentManager
        equipment={equipment}
        unit={units.weightUnit}
        usage={usage}
      />
    </div>
  );
}
