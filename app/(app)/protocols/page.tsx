import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getProtocols, getProtocolOutcomeOptions } from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import { PageHeader } from "@/components/ui";
import ProtocolForm from "./ProtocolForm";
import ProtocolList from "./ProtocolList";
import { createProtocol } from "./actions";
import {
  PROTOCOL_TEMPLATES,
  protocolTemplateById,
} from "@/lib/protocol-templates";

export const dynamic = "force-dynamic";

// N-of-1 protocols (issue #161): dated self-experiments (creatine, sauna blocks,
// Zone 2 emphasis, TRE) with declared outcome metrics the app compares before vs.
// during. This hub lists protocols and creates new ones; each row links to its
// before/during detail page.
export default async function ProtocolsPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { profile } = await requireSession();
  const protocols = getProtocols(profile.id);
  const options = getProtocolOutcomeOptions(profile.id);
  // "Recovery gear" (issue #592): the picker studies a recovery device, so filter
  // the inventory to recovery + uncategorized gear (kindOf) instead of offering
  // every barbell/bike. Add mode has no linked row, so no selectedMissing fallback.
  const equipment = recoveryGearOptions(getEquipment(profile.id));
  // A starter template (issue #571) selected from the templates strip, seeding the
  // add form. Null when no/unknown template is requested.
  const template = protocolTemplateById((await searchParams).template);

  return (
    <div>
      <PageHeader
        title="Protocols"
        subtitle="Run an N-of-1 experiment: pick an intervention, declare the outcomes you care about, and Allos compares the baseline window against the intervention window — no p-value theater, just the honest shift."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <ProtocolList items={protocols} />
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
                  href={`/protocols?template=${t.id}`}
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
                  href="/protocols"
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
            template={template}
          />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. Comparisons are descriptive
            (mean/median shift with n per window), not statistical inference.
          </p>
        </div>
      </div>
    </div>
  );
}
