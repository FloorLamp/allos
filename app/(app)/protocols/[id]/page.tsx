import { notFound } from "next/navigation";
import Link from "next/link";
import { IconChevronLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getProtocol,
  getProtocolComparison,
  getProtocolOutcomeOptions,
} from "@/lib/queries";
import { getUnitPrefs } from "@/lib/settings";
import ProtocolControls from "../ProtocolControls";
import ProtocolCompare from "../ProtocolCompare";
import { updateProtocol, endProtocol, deleteProtocol } from "../actions";

export const dynamic = "force-dynamic";

// A single protocol's before/during detail. Scoped by (profile, id) so a guessed
// id from another profile 404s. The comparison is the pure engine's output
// (gathered per outcome metric in the query seam) rendered as panels.
export default async function ProtocolDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const id = Number(params.id);
  const protocol = id ? getProtocol(profile.id, id) : null;
  if (!protocol) notFound();

  const units = getUnitPrefs(login.id);
  const comparison = getProtocolComparison(
    profile.id,
    protocol,
    today(profile.id),
    units.weightUnit
  );
  const options = getProtocolOutcomeOptions(profile.id);

  return (
    <div>
      <Link
        href="/protocols"
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <IconChevronLeft className="h-4 w-4" stroke={1.75} aria-hidden /> All
        protocols
      </Link>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-1">
          <ProtocolControls
            protocol={protocol}
            options={options}
            updateAction={updateProtocol}
            endAction={endProtocol}
            deleteAction={deleteProtocol}
          />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <ProtocolCompare comparison={comparison} />
        </div>
      </div>
    </div>
  );
}
