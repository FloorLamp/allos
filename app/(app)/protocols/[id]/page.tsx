import { notFound } from "next/navigation";
import Link from "next/link";
import { IconChevronLeft, IconBarbell } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getProtocol,
  getProtocolComparison,
  getProtocolOutcomeOptions,
  getProtocolPractice,
  getProtocolUsage,
  getProtocolAdherence,
} from "@/lib/queries";
import { getEquipment, getEquipmentById } from "@/lib/equipment";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import { getUnitPrefs } from "@/lib/settings";
import { formatUsageSummary } from "@/lib/usage-format";
import { foodGroupName } from "@/lib/food-groups";
import ProtocolControls from "../ProtocolControls";
import ProtocolCompare from "../ProtocolCompare";
import { updateProtocol, endProtocol, deleteProtocol } from "../actions";

export const dynamic = "force-dynamic";

const PRACTICE_TYPE_LABELS: Record<string, string> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
};

// A single protocol's before/during detail. Scoped by (profile, id) so a guessed
// id from another profile 404s. The comparison is the pure engine's output
// (gathered per outcome metric in the query seam) rendered as panels. The
// practice/gear card (issue #344) shows the linked recovery gear, adherence (the
// SAME weekly-count computation the routine widget uses), and usage-during-window.
export default async function ProtocolDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const id = Number(params.id);
  const protocol = id ? getProtocol(profile.id, id) : null;
  if (!protocol) notFound();

  const units = getUnitPrefs(login.id);
  const todayStr = today(profile.id);
  const comparison = getProtocolComparison(
    profile.id,
    protocol,
    todayStr,
    units.weightUnit
  );
  const options = getProtocolOutcomeOptions(profile.id);
  const practice = getProtocolPractice(profile.id, protocol);
  const gear =
    protocol.equipment_id != null
      ? getEquipmentById(profile.id, protocol.equipment_id)
      : undefined;
  // "Recovery gear" (issue #592): offer recovery + uncategorized gear only (kindOf),
  // not the whole inventory. No blanket includeRetired — a retired device appears
  // solely as the currently-linked selectedMissing fallback (`gear`, resolved via
  // getEquipmentById which ignores the retired flag), never as a fresh choice, so an
  // edit keeps the existing link without resurfacing sold/broken gear for new picks.
  const equipment = recoveryGearOptions(getEquipment(profile.id), gear);
  const adherence = getProtocolAdherence(profile.id, protocol);
  const usage = getProtocolUsage(profile.id, protocol, todayStr);
  const hasPracticeCard = !!gear || !!practice;

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
            equipment={equipment}
            practice={practice}
            updateAction={updateProtocol}
            endAction={endProtocol}
            deleteAction={deleteProtocol}
          />

          {hasPracticeCard && (
            <div
              className="card space-y-3"
              data-testid="protocol-practice-card"
            >
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                Practice
              </h2>

              {gear && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Gear
                  </div>
                  <Link
                    href={`/equipment/${gear.id}`}
                    className="mt-0.5 inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline dark:text-brand-300"
                    data-testid="protocol-gear-link"
                  >
                    <IconBarbell
                      className="h-4 w-4"
                      stroke={1.75}
                      aria-hidden
                    />
                    {gear.name}
                    {gear.retired ? (
                      <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        Retired
                      </span>
                    ) : null}
                  </Link>
                </div>
              )}

              {practice && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Adherence this week
                  </div>
                  <div
                    className="mt-0.5 text-sm text-slate-700 dark:text-slate-200"
                    data-testid="protocol-adherence"
                  >
                    <span className="font-semibold tabular-nums">
                      {adherence?.count ?? 0} / {practice.perWeek}
                    </span>{" "}
                    {practice.scopeKind === "food_group"
                      ? `${foodGroupName(practice.value)} servings`
                      : `${PRACTICE_TYPE_LABELS[practice.value] ?? practice.value} sessions`}
                    {adherence?.met ? (
                      <span className="badge ml-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        On track
                      </span>
                    ) : (
                      <span className="badge ml-1.5 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        Behind
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  During this protocol
                </div>
                <div
                  className="mt-0.5 text-sm text-slate-700 dark:text-slate-200"
                  data-testid="protocol-usage"
                >
                  {formatUsageSummary(usage.sessions, usage.lastUsed, todayStr)}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0 lg:col-span-2">
          <ProtocolCompare comparison={comparison} />
        </div>
      </div>
    </div>
  );
}
