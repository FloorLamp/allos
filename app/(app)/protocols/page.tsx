import Link from "next/link";
import { redirect } from "next/navigation";
import { IconSparkles } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import {
  getDisplayFormatPrefs,
  getProfileAge,
  getSituations,
  getWeekStart,
} from "@/lib/settings";
import {
  getProtocols,
  getProtocolHeatmaps,
  getProtocolOutcomeOptions,
  getProtocolIntakeOptions,
} from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { mergedSituationOptions } from "@/lib/situations";
import { SituationOptionsProvider } from "@/components/SituationOptionsContext";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import ProtocolFormModal from "./ProtocolFormModal";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import { isLongevityRelevant } from "@/lib/life-stage";
import ProtocolList from "./ProtocolList";
import { createProtocol } from "./actions";
import { protocolTemplateById } from "@/lib/protocol-templates";
import { today } from "@/lib/db";

export const dynamic = "force-dynamic";

// The protocol hub (#161): lists the profile's N-of-1 experiments and creates new
// ones; each row links to its before/during detail page. Adult-only content, like
// the actions behind it.
export default async function ProtocolsPage({
  searchParams,
}: {
  // A durable starter-template link (#571) expands and seeds the add form.
  searchParams: Promise<{ template?: string }>;
}) {
  const { login, profile } = await requireSession();
  if (!isLongevityRelevant(getProfileAge(profile.id))) redirect("/");
  const template = protocolTemplateById((await searchParams).template);
  const protocols = getProtocols(profile.id);
  const todayStr = today(profile.id);
  const weekStart = getWeekStart(profile.id);
  // ONE bounded gather for the whole list (#1655) — each ledger is read once over the
  // union of the protocol windows and sliced per protocol, instead of two queries per
  // protocol the profile has ever created. An ended experiment's heatmap is the point
  // of keeping it in the list, so nothing is dropped; only the query count stops
  // scaling with how long someone has used the feature.
  const heatmaps = getProtocolHeatmaps(
    profile.id,
    protocols,
    todayStr,
    weekStart
  );
  const options = getProtocolOutcomeOptions(profile.id, todayStr);
  // "Recovery gear" (issue #592): the picker studies a recovery device, so filter
  // the inventory to recovery + uncategorized gear (kindOf) instead of offering
  // every barbell/bike. Add mode has no linked row, so no selectedMissing fallback.
  const equipment = recoveryGearOptions(getEquipment(profile.id));
  // The profile's supplements + medications for the direct intervention link (#660).
  const intakeItems = getProtocolIntakeOptions(profile.id);
  // The SAME merged situation vocabulary the supplement and medication forms read
  // (#1676) — the protocol's "Activate situation" names the same thing they do.
  const situationOptions = mergedSituationOptions(
    getSituations(profile.id)
  ).map((o) => o.name);

  return (
    <PageContainer width="wide">
      <SituationOptionsProvider options={situationOptions}>
        <PageHeader
          title="Protocols"
          subtitle="Test a change by comparing the health data you already track before and during it."
          action={
            <Link
              href="/wellness"
              className="btn-ghost btn-sm"
              data-testid="longevity-wellness-link"
            >
              <IconSparkles className="h-4 w-4" aria-hidden />
              Wellness practices
            </Link>
          }
          createAction={{
            kind: "protocol",
            control: (
              <ProtocolFormModal
                // A ?template= navigation remounts the modal and opens it with
                // the linked template. In-form template changes use ProtocolForm's
                // keyed field seed instead.
                key={template?.id ?? "blank"}
                action={createProtocol}
                options={options}
                equipment={equipment}
                intakeItems={intakeItems}
                template={template}
              />
            ),
          }}
        />
      </SituationOptionsProvider>

      <section className="card" data-testid="protocols-index">
        <ProtocolList
          items={protocols}
          heatmaps={heatmaps}
          formatPrefs={getDisplayFormatPrefs(login.id)}
        />
      </section>
    </PageContainer>
  );
}
