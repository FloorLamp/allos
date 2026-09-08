import { getEquipment } from "@/lib/equipment";
import { CATALOGS } from "@/components/catalog";
import PageContainer from "@/components/PageContainer";
import { getProfileAge, getUnitPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import EquipmentManager from "@/components/EquipmentManager";
import {
  isStrengthTrainingRelevant,
  isTrainingRelevant,
} from "@/lib/life-stage";
import { kindOf } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EquipmentPage() {
  const { login, profile } = await requireSession();
  const strengthTrainingAvailable = isStrengthTrainingRelevant(
    getProfileAge(profile.id)
  );
  const trainingRelevant = isTrainingRelevant(getProfileAge(profile.id));
  const equipment = getEquipment(profile.id, { includeRetired: true }).filter(
    (item) => strengthTrainingAvailable || kindOf(item.category) !== "strength"
  );
  const usageMap = CATALOGS.equipment.usage(profile.id);
  const units = getUnitPrefs(login.id);

  const usage: Record<number, { sessions: number }> = {};
  for (const [id, u] of usageMap) usage[id] = { sessions: u.sessions };

  return (
    <PageContainer width="reading" data-testid="equipment-index">
      <PageHeader
        title="Equipment"
        subtitle={
          !trainingRelevant
            ? "Equipment already linked to activity history stays available here."
            : strengthTrainingAvailable
              ? "Your bars, implements, cardio gear, and recovery devices — with how much each has been used. Tag sessions with them to build usage history."
              : "Your cardio gear and recovery devices — with how much each has been used. Tag activities with them to build usage history."
        }
      />
      <EquipmentManager
        equipment={equipment}
        unit={units.weightUnit}
        usage={usage}
        creationAvailable={trainingRelevant}
        strengthTrainingAvailable={strengthTrainingAvailable}
      />
    </PageContainer>
  );
}
