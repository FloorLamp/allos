import { requireScope, stampSubjects } from "@/lib/scope";
import { listPoolViews } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import SharedSupplyCard, {
  type SharedSupplyCardData,
} from "./SharedSupplyCard";

export const dynamic = "force-dynamic";

// The household medicine cabinet (#1374) — the shared supply pools registry.
//
// A pool is household-shared (no profile_id, the `providers` precedent), so this page
// resolves its access ONCE at the boundary through requireScope() and shows the pools
// the caller's accessible profiles actually draw from, plus ORPHANED pools (nothing
// links them — they name nobody, so nothing is disclosed and someone has to be able to
// clear them).
//
// CROSS-GRANT VISIBILITY (a stated judgment call): a member granted only ONE of a pool's
// linked profiles sees that member by name and the others only as a COUNT ("+2 other
// household members"). The pooled days-left is shown in full — it is a property of the
// bottle, and hiding it would make the number the whole feature exists to produce
// unreadable — but WHO ELSE takes it is per-profile medical information and stays behind
// the grant. Admins, who may act as every profile, see every name.
export default async function SuppliesPage() {
  const scope = await requireScope();
  const accessible = new Set(scope.ids);
  const pools = listPoolViews().filter(
    (p) =>
      p.members.length === 0 ||
      p.members.some((m) => accessible.has(m.profileId))
  );

  const cards: SharedSupplyCardData[] = pools.map((pool) => {
    const visible = pool.members.filter((m) => accessible.has(m.profileId));
    const stamped = stampSubjects(
      scope,
      visible.map((m) => ({ ...m, profileId: m.profileId }))
    );
    return {
      id: pool.id,
      name: pool.name,
      strength: pool.strength,
      form: pool.form,
      notes: pool.notes,
      quantityOnHand: pool.quantity_on_hand,
      lowSupplyDays: pool.low_supply_days,
      thresholdDays: pool.thresholdDays,
      daysLeft: pool.daysLeft,
      low: pool.low,
      orphaned: pool.orphaned,
      memberCount: pool.members.length,
      hiddenMemberCount: pool.members.length - visible.length,
      members: stamped.map((m) => ({
        itemId: m.itemId,
        label: `${m.name} · ${m.subject.name}`,
        canWrite: m.subject.access === "write",
      })),
      canWrite:
        pool.members.length === 0
          ? scope.access.get(scope.actingProfileId) === "write"
          : pool.members.some((m) => scope.access.get(m.profileId) === "write"),
    };
  });

  return (
    <PageContainer width="reading" data-testid="supplies-page">
      <PageHeader
        title="Medicine cabinet"
        subtitle="Bottles the household shares. Every linked person's confirmed doses decrement one count, the days-left estimate sums everyone's use, and a low bottle raises one alert — not one per person."
      />
      {cards.length === 0 ? (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="supplies-empty"
        >
          No shared bottles yet. Open a supplement or medication, expand its
          refill section, and link it to a new shared bottle.
        </p>
      ) : (
        <div className="space-y-4">
          {cards.map((c) => (
            <SharedSupplyCard key={c.id} pool={c} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
