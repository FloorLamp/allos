import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getProtocols,
  getProtocolOutcomeOptions,
  getProtocolIntakeOptions,
} from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import ProtocolForm from "@/app/(app)/protocols/ProtocolForm";
import ProtocolList from "@/app/(app)/protocols/ProtocolList";
import { createProtocol } from "@/app/(app)/protocols/actions";
import {
  PROTOCOL_TEMPLATES,
  type ProtocolTemplate,
} from "@/lib/protocol-templates";

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
  // The starter template (issue #571) selected from the templates strip
  // (?template= on /longevity), seeding the add form. Null when none requested.
  template: ProtocolTemplate | null;
}) {
  const { login, profile } = await requireSession();
  const protocols = getProtocols(profile.id);
  const options = getProtocolOutcomeOptions(profile.id);
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
      className="scroll-mt-20"
    >
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Protocols &amp; experiments
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Run an N-of-1 experiment: pick an intervention, declare the outcomes
          you care about, and Allos compares the baseline window against the
          intervention window — no p-value theater, just the honest shift.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <ProtocolList
            items={protocols}
            formatPrefs={getDisplayFormatPrefs(login.id)}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <div className="card space-y-2" data-testid="protocol-templates">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Start from a template
            </h2>
            <div className="flex flex-wrap gap-2">
              {PROTOCOL_TEMPLATES.map((t) => (
                <Link
                  key={t.id}
                  href={`/longevity?template=${t.id}#protocols`}
                  data-testid={`protocol-template-${t.id}`}
                  className={`badge transition ${
                    template?.id === t.id
                      ? "bg-brand-600 text-white"
                      : "bg-brand-50 text-brand-700 hover:ring-1 hover:ring-current dark:bg-brand-500/15 dark:text-brand-300"
                  }`}
                  title={t.blurb}
                >
                  {t.label}
                </Link>
              ))}
              {template ? (
                <Link
                  href="/longevity#protocols"
                  className="badge bg-slate-100 text-slate-600 hover:ring-1 hover:ring-current dark:bg-ink-800 dark:text-slate-300"
                >
                  Clear
                </Link>
              ) : null}
            </div>
            {template ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {template.blurb} The form below is prefilled — review and edit,
                then save. Informational only, not medical advice.
              </p>
            ) : null}
          </div>
          <ProtocolForm
            // Remount the form when the template changes so its uncontrolled
            // defaults re-seed.
            key={template?.id ?? "blank"}
            action={createProtocol}
            options={options}
            equipment={equipment}
            intakeItems={intakeItems}
            template={template}
          />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. Comparisons are descriptive
            (mean/median shift with n per window), not statistical inference.
          </p>
        </div>
      </div>
    </section>
  );
}
