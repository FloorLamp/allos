import { requireSession } from "@/lib/auth";
import { getProtocols, getProtocolOutcomeOptions } from "@/lib/queries";
import { getEquipment } from "@/lib/equipment";
import { PageHeader } from "@/components/ui";
import ProtocolForm from "./ProtocolForm";
import ProtocolList from "./ProtocolList";
import { createProtocol } from "./actions";

export const dynamic = "force-dynamic";

// N-of-1 protocols (issue #161): dated self-experiments (creatine, sauna blocks,
// Zone 2 emphasis, TRE) with declared outcome metrics the app compares before vs.
// during. This hub lists protocols and creates new ones; each row links to its
// before/during detail page.
export default async function ProtocolsPage() {
  const { profile } = await requireSession();
  const protocols = getProtocols(profile.id);
  const options = getProtocolOutcomeOptions(profile.id);
  const equipment = getEquipment(profile.id);

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
          <ProtocolForm
            action={createProtocol}
            options={options}
            equipment={equipment}
          />
          <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
            Informational only, not medical advice. Comparisons are descriptive
            (mean/median shift with n per window), not statistical inference.
          </p>
        </div>
      </div>
    </div>
  );
}
