// SERVER-ACTION TIER — supplement/intake write path.
//
// Covers addSupplement (manual source), the refill invariant on toggleTaken
// (decrement on confirm / re-increment on untoggle), toggleActive, a
// kind='medication' create, and the updateSupplement dose reconcile —
// specifically that a schedule edit can never destroy or rewrite adherence
// history (removed-but-logged doses are retired, not cascaded; confirmed
// amounts are snapshotted onto the log).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
  toggleTaken,
  setDoseStatus,
  toggleActive,
  dismissIntakeFinding,
} from "@/app/(app)/nutrition/supplement-actions";
import {
  stopMedication,
  restartMedication,
} from "@/app/(app)/medications/actions";
import { deleteDatasetRows } from "@/app/(app)/data/manage-actions";
import {
  getSupplements,
  getSupplementDoses,
  getInteractionWarnings,
  getFindingSuppressions,
} from "@/lib/queries";
import { getProfileSetting, setProfileSetting } from "@/lib/settings";
import { refillMarkerKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function itemRow(id: number) {
  return db
    .prepare(
      "SELECT id, name, kind, source, active, quantity_on_hand, qty_per_dose, prescriber FROM intake_items WHERE id = ?"
    )
    .get(id) as {
    id: number;
    name: string;
    kind: string;
    source: string;
    active: number;
    quantity_on_hand: number | null;
    qty_per_dose: number;
    prescriber: string | null;
  };
}

function logCount(doseId: number, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { c: number }
  ).c;
}

function logStatus(doseId: number, date: string): string | undefined {
  return (
    db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: string } | undefined
  )?.status;
}

beforeEach(() => revalidate.mockClear());

describe("addSupplement", () => {
  it("creates a manual-source supplement with a dose", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Creatine", condition: "daily", priority: "high" })
    );

    const items = getSupplements(profile.id);
    expect(items).toHaveLength(1);
    const row = itemRow(items[0].id);
    expect(row.name).toBe("Creatine");
    expect(row.kind).toBe("supplement");
    expect(row.source).toBe("manual");
    // parseDoses always yields at least one dose row.
    expect(getSupplementDoses(profile.id)).toHaveLength(1);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("blank name is rejected (no row)", async () => {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "   " }));
    expect(getSupplements(profile.id)).toHaveLength(0);
  });

  it("creates a kind='medication' row with prescriber", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Lisinopril", kind: "medication", prescriber: "Dr House" })
    );
    const items = getSupplements(profile.id);
    const row = itemRow(items[0].id);
    expect(row.kind).toBe("medication");
    expect(row.prescriber).toBe("Dr House");
  });
});

describe("toggleTaken refill invariant", () => {
  it("confirm decrements on-hand by qty_per_dose; untoggle re-increments", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Vitamin D", quantity_on_hand: 10, qty_per_dose: 2 })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;
    const date = today(profile.id);

    // Confirm: log inserted AND supply drops 10 → 8.
    await toggleTaken(fd({ dose_id: doseId }));
    expect(logCount(doseId, date)).toBe(1);
    expect(itemRow(suppId).quantity_on_hand).toBe(8);

    // Untoggle: log removed AND supply restored 8 → 10.
    await toggleTaken(fd({ dose_id: doseId }));
    expect(logCount(doseId, date)).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(10);
  });

  // Issue #467: the edit form writes quantity_on_hand as an absolute value, but a
  // dose confirm (incl. the poll sidecar) decrements it concurrently. The form now
  // submits the value it LOADED with, and updateSupplement compare-and-sets: an
  // untouched on-hand field must NOT clobber a decrement logged while the form was open.
  it("stale-form save preserves a concurrent dose decrement (compare-and-set)", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Metformin", quantity_on_hand: 30, qty_per_dose: 1 })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;

    // A dose is confirmed AFTER the caregiver's form loaded at 30 → supply 30 → 29.
    await toggleTaken(fd({ dose_id: doseId }));
    expect(itemRow(suppId).quantity_on_hand).toBe(29);

    // Caregiver saves an unrelated tweak (rename); the on-hand field is UNCHANGED
    // from the loaded 30, so the decrement to 29 must survive (not revert to 30).
    await updateSupplement(
      fd({
        id: suppId,
        name: "Metformin XR",
        quantity_on_hand: 30,
        quantity_on_hand_loaded: 30,
        qty_per_dose: 1,
      })
    );
    expect(itemRow(suppId).name).toBe("Metformin XR");
    expect(itemRow(suppId).quantity_on_hand).toBe(29);
  });

  it("an intentional refill (changed field) is still written absolutely", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Metformin", quantity_on_hand: 4, qty_per_dose: 1 })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;
    await toggleTaken(fd({ dose_id: doseId })); // 4 → 3 meanwhile

    // The user refills: form loaded at 4, they typed 90. The changed field wins
    // (the edit form IS the refill path) even over the concurrent decrement.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Metformin",
        quantity_on_hand: 90,
        quantity_on_hand_loaded: 4,
        qty_per_dose: 1,
      })
    );
    expect(itemRow(suppId).quantity_on_hand).toBe(90);
  });

  it("a dose belonging to another profile cannot be toggled", async () => {
    // Owner seeds a tracked supplement.
    const owner = seedActor();
    await addSupplement(
      fd({ name: "Zinc", quantity_on_hand: 5, qty_per_dose: 1 })
    );
    const suppId = getSupplements(owner.profile.id)[0].id;
    const foreignDoseId = getSupplementDoses(owner.profile.id)[0].id;

    // A different actor tries to toggle the owner's dose id.
    const attacker = seedActor();
    await toggleTaken(fd({ dose_id: foreignDoseId }));

    // No log created and the owner's supply is untouched.
    expect(logCount(foreignDoseId, today(owner.profile.id))).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(5);
    expect(getSupplements(attacker.profile.id)).toHaveLength(0);
  });
});

describe("setDoseStatus tri-state + skip supply invariant (#232)", () => {
  async function seedTracked(qty = 10) {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Vitamin D", quantity_on_hand: qty, qty_per_dose: 2 })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;
    return { profile, suppId, doseId, date: today(profile.id) };
  }

  it("skipping a dose logs status='skipped' and NEVER touches supply", async () => {
    const { suppId, doseId, date } = await seedTracked();
    await setDoseStatus(fd({ dose_id: doseId, status: "skipped" }));
    expect(logStatus(doseId, date)).toBe("skipped");
    // Supply is untouched — a skip consumes nothing.
    expect(itemRow(suppId).quantity_on_hand).toBe(10);
  });

  it("taken→skipped RESTORES supply; skipped→taken decrements it (symmetry)", async () => {
    const { suppId, doseId, date } = await seedTracked();

    // Take: 10 → 8.
    await setDoseStatus(fd({ dose_id: doseId, status: "taken" }));
    expect(logStatus(doseId, date)).toBe("taken");
    expect(itemRow(suppId).quantity_on_hand).toBe(8);

    // Flip taken → skipped: the dose gave nothing back before, so restore 8 → 10.
    await setDoseStatus(fd({ dose_id: doseId, status: "skipped" }));
    expect(logStatus(doseId, date)).toBe("skipped");
    expect(itemRow(suppId).quantity_on_hand).toBe(10);

    // Flip skipped → taken again: consume once more 10 → 8 (never double-counts).
    await setDoseStatus(fd({ dose_id: doseId, status: "taken" }));
    expect(logStatus(doseId, date)).toBe("taken");
    expect(itemRow(suppId).quantity_on_hand).toBe(8);
  });

  it("clear removes the log; clearing a skip leaves supply where it was", async () => {
    const { suppId, doseId, date } = await seedTracked();

    // skip → clear: no log, supply stays at 10 (skip never moved it).
    await setDoseStatus(fd({ dose_id: doseId, status: "skipped" }));
    await setDoseStatus(fd({ dose_id: doseId, status: "clear" }));
    expect(logCount(doseId, date)).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(10);

    // take → clear: log removed and the decrement is given back (8 → 10).
    await setDoseStatus(fd({ dose_id: doseId, status: "taken" }));
    expect(itemRow(suppId).quantity_on_hand).toBe(8);
    await setDoseStatus(fd({ dose_id: doseId, status: "clear" }));
    expect(logCount(doseId, date)).toBe(0);
    expect(itemRow(suppId).quantity_on_hand).toBe(10);
  });

  it("ignores an unknown target and a dose from another profile", async () => {
    const { doseId, date } = await seedTracked();
    await setDoseStatus(fd({ dose_id: doseId, status: "bogus" }));
    expect(logCount(doseId, date)).toBe(0);

    // A different actor cannot skip the owner's dose.
    const owner = await seedTracked();
    seedActor();
    await setDoseStatus(fd({ dose_id: owner.doseId, status: "skipped" }));
    expect(logCount(owner.doseId, owner.date)).toBe(0);
  });
});

describe("updateSupplement dose reconcile", () => {
  const dosesJson = (
    doses: {
      id?: number;
      amount: string;
      time_of_day: string;
    }[]
  ) => JSON.stringify(doses.map((d) => ({ ...d, food_timing: "any" })));

  async function seedSplitDose() {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Omega-3",
        doses: dosesJson([
          { amount: "500 mg", time_of_day: "08:00" },
          { amount: "500 mg", time_of_day: "20:00" },
        ]),
      })
    );
    const suppId = getSupplements(profile.id)[0].id;
    const [morning, evening] = getSupplementDoses(profile.id);
    return { profile, suppId, morning, evening };
  }

  function doseRow(id: number) {
    return db
      .prepare("SELECT amount, retired FROM intake_item_doses WHERE id = ?")
      .get(id) as { amount: string | null; retired: number } | undefined;
  }

  it("retires a removed dose that has logs; hard-deletes an unlogged one", async () => {
    const { profile, suppId, morning, evening } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));

    // Restructure 2×500 mg → 1×1000 mg: neither old dose is resubmitted.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );

    // The logged dose is RETIRED — its row and taken-history survive. Before
    // the retired flag this DELETE cascaded the log away (history destroyed).
    expect(doseRow(morning.id)?.retired).toBe(1);
    expect(logCount(morning.id, date)).toBe(1);
    // The never-logged dose is hard-deleted (nothing referenced it).
    expect(doseRow(evening.id)).toBeUndefined();
    // The current schedule shows only the new dose.
    const current = getSupplementDoses(profile.id);
    expect(current).toHaveLength(1);
    expect(current[0].amount).toBe("1000 mg");
  });

  it("a later edit leaves already-retired doses untouched", async () => {
    const { profile, suppId, morning } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );
    const keptId = getSupplementDoses(profile.id)[0].id;

    // Second edit resubmits only the live dose (as the form does) — the
    // retired row must not be swept up by the reconcile's delete.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([
          { id: keptId, amount: "1000 mg", time_of_day: "09:00" },
        ]),
      })
    );
    expect(doseRow(morning.id)?.retired).toBe(1);
    expect(logCount(morning.id, date)).toBe(1);
  });

  it("an in-place amount edit keeps the dose id but not the logged amount", async () => {
    const { profile, suppId, morning, evening } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));

    // Brand switch, same schedule shape: both doses resubmitted WITH ids.
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        brand: "NewBrand",
        doses: dosesJson([
          { id: morning.id, amount: "1000 mg", time_of_day: "08:00" },
          { id: evening.id, amount: "1000 mg", time_of_day: "20:00" },
        ]),
      })
    );

    // Same dose row (Telegram buttons carrying the id stay valid), log intact…
    expect(doseRow(morning.id)).toEqual({ amount: "1000 mg", retired: 0 });
    expect(logCount(morning.id, date)).toBe(1);
    // …and the log still records what was ACTUALLY taken (500 mg), not the
    // post-edit amount — history is snapshotted at confirm time.
    const log = db
      .prepare(
        "SELECT amount FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(morning.id, date) as { amount: string | null };
    expect(log.amount).toBe("500 mg");
  });

  it("toggleTaken refuses a retired dose", async () => {
    const { profile, suppId, morning } = await seedSplitDose();
    const date = today(profile.id);
    await toggleTaken(fd({ dose_id: morning.id }));
    await updateSupplement(
      fd({
        id: suppId,
        name: "Omega-3",
        doses: dosesJson([{ amount: "1000 mg", time_of_day: "08:00" }]),
      })
    );

    // A second toggle on the retired dose must be a no-op — NOT an untoggle
    // that deletes the historical log.
    await toggleTaken(fd({ dose_id: morning.id }));
    expect(logCount(morning.id, date)).toBe(1);
  });
});

describe("toggleActive", () => {
  it("flips the active flag for the acting profile's item", async () => {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "Magnesium" }));
    const id = getSupplements(profile.id)[0].id;
    expect(itemRow(id).active).toBe(1);

    await toggleActive(fd({ id }));
    expect(itemRow(id).active).toBe(0);
  });
});

// Refill-episode marker cleanup on state change (issue #325). A low-supply nudge
// leaves a `notify_last_refill_<id>` marker that must be CLEARED the moment the item
// leaves the refill-tracked set (paused, or quantity tracking turned off) — otherwise
// re-tracking a still-low item is silently silenced. The write seams clear eagerly,
// mirroring the delete seam; the tick self-heals the rest.
describe("refill episode marker cleanup on state change (#325)", () => {
  async function seedTrackedWithMarker() {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Vitamin D", quantity_on_hand: 30, qty_per_dose: 1 })
    );
    const id = getSupplements(profile.id)[0].id;
    // Simulate a prior low-supply nudge having fired.
    setProfileSetting(profile.id, refillMarkerKey(id), "2026-07-01");
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBe(
      "2026-07-01"
    );
    return { profile, id };
  }

  it("updateSupplement clears the marker when quantity tracking is turned off", async () => {
    const { profile, id } = await seedTrackedWithMarker();
    // Re-save with a blank quantity_on_hand → tracking off (null). The form loaded
    // at 30, so clearing the field is a real change (#467 compare-and-set writes it).
    await updateSupplement(
      fd({
        id,
        name: "Vitamin D",
        quantity_on_hand: "",
        quantity_on_hand_loaded: 30,
        qty_per_dose: 1,
      })
    );
    expect(itemRow(id).quantity_on_hand).toBeNull();
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });

  it("updateSupplement leaves the marker while the item stays tracked", async () => {
    const { profile, id } = await seedTrackedWithMarker();
    // Still tracked (a mere quantity edit) → marker must survive; the tick owns the
    // low→recovered clear, not the write seam.
    await updateSupplement(
      fd({ id, name: "Vitamin D", quantity_on_hand: 25, qty_per_dose: 1 })
    );
    expect(itemRow(id).quantity_on_hand).toBe(25);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBe(
      "2026-07-01"
    );
  });

  it("toggleActive clears the marker on pause and does not recreate it on resume", async () => {
    const { profile, id } = await seedTrackedWithMarker();
    // Pause: leaves the tracked set → marker cleared.
    await toggleActive(fd({ id }));
    expect(itemRow(id).active).toBe(0);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();

    // Resume: re-enters the tracked set but the write path never re-creates a marker
    // (a fresh nudge is the tick's job once it's low again).
    await toggleActive(fd({ id }));
    expect(itemRow(id).active).toBe(1);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });

  it("toggleActive on an UNtracked item leaves any unrelated marker untouched", async () => {
    const { profile } = seedActor();
    await addSupplement(fd({ name: "Magnesium" })); // no quantity tracking
    const id = getSupplements(profile.id)[0].id;
    // A stray marker on this untracked item is not this seam's concern; pausing an
    // item that was never in the tracked set is not a "left the set" transition.
    setProfileSetting(profile.id, refillMarkerKey(id), "2026-07-01");
    await toggleActive(fd({ id }));
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBe(
      "2026-07-01"
    );
  });

  it("pausing a tracked MEDICATION also clears its marker", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Lisinopril",
        kind: "medication",
        quantity_on_hand: 30,
        qty_per_dose: 1,
      })
    );
    const id = getSupplements(profile.id)[0].id;
    setProfileSetting(profile.id, refillMarkerKey(id), "2026-07-01");
    await toggleActive(fd({ id }));
    expect(itemRow(id).active).toBe(0);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });
});

// Refill-marker cleanup on the medication Stop/Restart lifecycle (issue #603). The
// eager clear existed on Pause/Resume (toggleActive) but Stop/Restart cleared
// nothing — so a Stop then Restart within the same hour (before a notify tick's
// self-healing sweep) stranded a stale low-supply marker and no refill nudge
// re-fired until an actual refill. Stop now mirrors Pause (leaves the tracked set →
// clear); Restart is the enter-side twin and clears any lingering marker so a still-
// low resumed med re-nudges.
describe("refill marker cleanup on Stop/Restart (#603)", () => {
  async function seedTrackedMedWithMarker() {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Metformin",
        kind: "medication",
        quantity_on_hand: 30,
        qty_per_dose: 1,
      })
    );
    const id = getSupplements(profile.id)[0].id;
    setProfileSetting(profile.id, refillMarkerKey(id), "2026-07-01");
    return { profile, id };
  }

  it("stopMedication clears the low-supply marker (parity with Pause)", async () => {
    const { profile, id } = await seedTrackedMedWithMarker();
    await stopMedication(fd({ id }));
    expect(itemRow(id).active).toBe(0);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });

  it("stop → restart leaves no stale marker to silence the re-nudge", async () => {
    const { profile, id } = await seedTrackedMedWithMarker();
    await stopMedication(fd({ id }));
    await restartMedication(fd({ id }));
    expect(itemRow(id).active).toBe(1);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });

  it("restartMedication alone clears a lingering marker (enter-side twin)", async () => {
    const { profile, id } = await seedTrackedMedWithMarker();
    // A med left inactive with a stale marker (e.g. stopped by a path that predates
    // the sweep) must re-nudge on Restart — the tick can't self-heal it once it's a
    // candidate again.
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(id);
    await restartMedication(fd({ id }));
    expect(itemRow(id).active).toBe(1);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
  });
});

// The Data → Manage bulk delete of supplements must sweep the SAME notification
// markers deleteSupplement does (issue #603 / #328 parity): the item's low-supply
// refill marker AND each dose's missed-dose escalation marker. Before the shared
// cleanup helper, the undoable bulk-delete branch stranded both — permanently, for
// the id-keyed escalation markers.
describe("bulk delete sweeps intake markers (#603)", () => {
  const dosesJson = (doses: { amount: string; time_of_day: string }[]) =>
    JSON.stringify(doses.map((d) => ({ ...d, food_timing: "any" })));

  it("deleteDatasetRows('supplements') clears the refill + escalation markers", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Atorvastatin",
        kind: "medication",
        quantity_on_hand: 30,
        qty_per_dose: 1,
        doses: dosesJson([{ amount: "20 mg", time_of_day: "20:00" }]),
      })
    );
    const id = getSupplements(profile.id)[0].id;
    const doseId = getSupplementDoses(profile.id)[0].id;
    // Simulate a prior low-supply nudge + a prior missed-dose escalation.
    setProfileSetting(profile.id, refillMarkerKey(id), "2026-07-01");
    setProfileSetting(profile.id, escalationMarkerKey(doseId), "2026-07-01");

    const res = await deleteDatasetRows("supplements", [id]);
    expect(res.ok).toBe(true);
    expect(getSupplements(profile.id)).toHaveLength(0);
    expect(getProfileSetting(profile.id, refillMarkerKey(id))).toBeUndefined();
    expect(
      getProfileSetting(profile.id, escalationMarkerKey(doseId))
    ).toBeUndefined();
  });
});

// Cached RxNorm ingredient CUIs (issue #279): the write path persists the form's
// resolved ingredient list through the shape-checking codec, couples it to the
// confirmed rxcui, and interaction detection reads it back so a combination
// product matches ingredient-keyed concepts. All codes are public-domain RxNorm
// vocabulary — no PHI.
describe("rxcui_ingredients write path (issue #279)", () => {
  function rxcuiRow(id: number) {
    return db
      .prepare("SELECT rxcui, rxcui_ingredients FROM intake_items WHERE id = ?")
      .get(id) as { rxcui: string | null; rxcui_ingredients: string | null };
  }

  it("addSupplement persists the confirmed rxcui + its ingredient CUIs", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Combination tablet B",
        kind: "medication",
        rxcui: "999999",
        rxcui_ingredients: '["52175","5487"]',
      })
    );
    const id = getSupplements(profile.id)[0].id;
    const row = rxcuiRow(id);
    expect(row.rxcui).toBe("999999");
    expect(JSON.parse(row.rxcui_ingredients!)).toEqual(["52175", "5487"]);

    // The stored ingredients drive interaction detection: adding potassium
    // chloride now flags the ace_arb × potassium rule even though the product
    // rxcui matches no concept and the name matches no synonym.
    await addSupplement(fd({ name: "Potassium chloride 10 mEq" }));
    const hits = getInteractionWarnings(profile.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("moderate");
  });

  it("normalizes a forged/garbage ingredients payload to NULL", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Tablet D",
        rxcui: "11289",
        rxcui_ingredients: '["DROP TABLE intake_items", {"x":1}]',
      })
    );
    const id = getSupplements(profile.id)[0].id;
    expect(rxcuiRow(id).rxcui_ingredients).toBeNull();
  });

  it("ingredients are coupled to the code: no rxcui ⇒ no cached ingredients", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({ name: "Tablet E", rxcui_ingredients: '["52175"]' })
    );
    const id = getSupplements(profile.id)[0].id;
    expect(rxcuiRow(id).rxcui_ingredients).toBeNull();

    // updateSupplement clearing the code also clears the stale ingredient cache.
    await updateSupplement(
      fd({
        id,
        name: "Tablet E",
        rxcui: "999999",
        rxcui_ingredients: '["52175"]',
      })
    );
    expect(rxcuiRow(id).rxcui_ingredients).toBe('["52175"]');
    await updateSupplement(fd({ id, name: "Tablet E" }));
    expect(rxcuiRow(id)).toEqual({ rxcui: null, rxcui_ingredients: null });
  });
});

// #435: the intake observation dismiss action writes to the shared findings bus
// for its four namespaces and refuses anything else.
describe("dismissIntakeFinding (#435)", () => {
  it("suppresses each medicine-surface namespace, rejecting foreign keys", async () => {
    const { profile } = seedActor();
    const suppressed = () => getFindingSuppressions(profile.id);

    for (const key of [
      "interaction:3-7",
      "dietary-limit:magnesium",
      "food-timing:12:grapefruit",
      "keep-apart:1-2",
    ]) {
      await dismissIntakeFinding(fd({ dedupe_key: key }));
      expect(suppressed().has(key)).toBe(true);
    }

    // A key outside the medicine namespaces is refused (the prefix guard), so this
    // action can never silence an arbitrary finding.
    await dismissIntakeFinding(fd({ dedupe_key: "biomarker:ldl" }));
    expect(suppressed().has("biomarker:ldl")).toBe(false);
  });
});
