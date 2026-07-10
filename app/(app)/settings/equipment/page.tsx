import { redirect } from "next/navigation";
import { getEquipment } from "@/lib/equipment";
import { getUnitPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import EquipmentManager from "@/components/EquipmentManager";

export const dynamic = "force-dynamic";

export default async function EquipmentSettingsPage() {
  const { login, profile } = await requireSession();
  // Age-restricted profiles can't reach Equipment even by direct URL — the tab
  // is hidden for them; bounce them back to Preferences (see lib/age-gate.ts).
  if (isTrainingRestricted(profile.id)) redirect("/settings");
  const equipment = getEquipment(profile.id);
  const units = getUnitPrefs(login.id);
  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Define your own bars and implements — name lift variants the catalog doesn't cover, and optionally record each implement's own weight."
      />
      <SettingsTabs isAdmin={login.role === "admin"} />
      <EquipmentManager equipment={equipment} unit={units.weightUnit} />
    </div>
  );
}
