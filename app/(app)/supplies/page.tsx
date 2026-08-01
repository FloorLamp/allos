import { requireScope, stampSubjects } from "@/lib/scope";
import { listVisiblePoolViews } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import { addItemFromPoolHref, intakeHref, medicationHref } from "@/lib/hrefs";
import { poolSurfaceKind } from "@/lib/supply-product";
import { sharedSupplyMemberLabels } from "@/lib/shared-supply-member-labels";
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
  // The visibility rule itself lives in lib/refill.ts (isPoolVisibleTo) and is applied
  // here through listVisiblePoolViews — the SAME computation the "N shared bottles"
  // doors on Medications / Supplements / Household count with (#1522), so a door can
  // never promise a bottle this page won't list.
  const pools = listVisiblePoolViews(scope.ids);

  const visiblePools = pools.map((pool) => {
    const visible = pool.members.filter((m) => accessible.has(m.profileId));
    const stamped = stampSubjects(
      scope,
      visible.map((m) => ({ ...m, profileId: m.profileId }))
    );
    return { pool, visible, stamped };
  });
  // Disambiguate across the WHOLE cabinet, not one bottle at a time: two
  // same-named records owned by one profile may draw from different bottles and
  // still need distinct action labels in the page/AT link list.
  const memberLabels = sharedSupplyMemberLabels(
    visiblePools.flatMap(({ stamped }) => stamped)
  );

  // "Add for another person" (#1705). A bottle has no kind of its own, so the surface
  // its next item lands on is read off the membership (poolSurfaceKind). Offered only
  // for profiles this caller may WRITE — a read-only grant gets no add affordance —
  // and the write itself still happens under that profile's own gate: the chip switches
  // the active profile first, then the ordinary add form runs requireWriteAccess().
  const addTargetProfiles = scope.profiles
    .filter((p) => scope.access.get(p.id) === "write")
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) =>
      a.id === scope.actingProfileId
        ? -1
        : b.id === scope.actingProfileId
          ? 1
          : 0
    );

  const cards: SharedSupplyCardData[] = visiblePools.map(
    ({ pool, visible, stamped }) => ({
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
        label: memberLabels.get(m.itemId) ?? m.name,
        canWrite: m.subject.access === "write",
        profile: {
          id: m.subject.profileId,
          name: m.subject.name,
          photo_path: m.subject.photoPath,
          photo_version: m.subject.photoVersion,
        },
        acting: m.profileId === scope.actingProfileId,
        // Match search's established item-link rule: medications have an
        // accessible cross-profile detail page; supplements return to their
        // kind-level Nutrition tab because no supplement-detail route exists.
        href:
          m.kind === "medication"
            ? medicationHref(m.itemId)
            : intakeHref(m.kind),
      })),
      addHref: addItemFromPoolHref(poolSurfaceKind(pool.members), pool.id),
      addTargets: addTargetProfiles,
      canWrite:
        pool.members.length === 0
          ? scope.access.get(scope.actingProfileId) === "write"
          : pool.members.some((m) => scope.access.get(m.profileId) === "write"),
    })
  );

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="supplies-page"
    >
      <PageHeader
        title="Medicine Cabinet"
        subtitle="Shared bottles with pooled counts and refill estimates."
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
