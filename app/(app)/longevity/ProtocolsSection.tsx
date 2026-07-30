import Link from "next/link";
import { IconFlask2, IconSparkles } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getProtocols,
  getProtocolHeatmap,
  getProtocolOutcomeOptions,
  getProtocolIntakeOptions,
} from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import ProtocolFormModal from "@/app/(app)/protocols/ProtocolFormModal";
import ProtocolList from "@/app/(app)/protocols/ProtocolList";
import { createProtocol } from "@/app/(app)/protocols/actions";
import type { ProtocolTemplate } from "@/lib/protocol-templates";
import { today } from "@/lib/db";
import { getWeekStart } from "@/lib/settings";

// Longevity §5 — Protocols / N-of-1 experiments (#1042 phase 4): the absorbed
// /protocols hub (issue #161), now the page's INTERVENTIONS section — the
// membership test's second arm ("…or an intervention against a pillar"), which
// is why it is the one section that renders unconditionally: it's also the
// creation surface for a first experiment. The Server Actions and the per-
// protocol detail route (/protocols/[id]) did NOT move — actions are route-
// independent modules, and the old /protocols hub URL 308-redirects here
// (next.config.js → /longevity#protocols). This section lists protocols and
// creates new ones; each row links to its before/during detail page.
export default async function ProtocolsSection({
  template,
}: {
  // The starter template selected by a durable ?template= link. It expands and
  // seeds the otherwise-collapsed form; the picker itself now lives in that form.
  template: ProtocolTemplate | null;
}) {
  const { login, profile } = await requireSession();
  const protocols = getProtocols(profile.id);
  const todayStr = today(profile.id);
  const weekStart = getWeekStart(profile.id);
  const heatmaps = Object.fromEntries(
    protocols.map((protocol) => [
      protocol.id,
      getProtocolHeatmap(profile.id, protocol, todayStr, weekStart),
    ])
  );
  const options = getProtocolOutcomeOptions(profile.id, todayStr);
  // "Recovery gear" (issue #592): the picker studies a recovery device, so filter
  // the inventory to recovery + uncategorized gear (kindOf) instead of offering
  // every barbell/bike. Add mode has no linked row, so no selectedMissing fallback.
  const equipment = recoveryGearOptions(getEquipment(profile.id));
  // The profile's supplements + medications for the direct intervention link (#660).
  const intakeItems = getProtocolIntakeOptions(profile.id);

  return (
    <section
      id="protocols"
      data-testid="longevity-protocols"
      className="card scroll-mt-20"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-brand-50 p-2.5 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
            <IconFlask2 className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Protocols
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
              Test a change by comparing the health data you already track
              before and during it.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/wellness"
            className="btn-ghost btn-sm"
            data-testid="longevity-wellness-link"
          >
            <IconSparkles className="h-4 w-4" aria-hidden />
            Wellness practices
          </Link>
          <ProtocolFormModal
            // A legacy ?template= navigation remounts the modal and opens it with
            // the linked template. In-form template changes use ProtocolForm's
            // keyed field seed instead.
            key={template?.id ?? "blank"}
            action={createProtocol}
            options={options}
            equipment={equipment}
            intakeItems={intakeItems}
            template={template}
          />
        </div>
      </div>

      <ProtocolList
        items={protocols}
        heatmaps={heatmaps}
        formatPrefs={getDisplayFormatPrefs(login.id)}
      />
    </section>
  );
}
