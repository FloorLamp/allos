// SERVER-ACTION TIER — bulk corrections (issue #1603). Proves the request
// boundary: requireWriteAccess gates every entry point (a read-only acting
// session is refused), preview → apply round-trips through the compare-and-set
// signature, apply refuses with the typed friendly-reload outcome when the run
// drifted after preview, units convert at the boundary (an lb login's offset is
// stored as kg), and undo reports restored/skipped honestly.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  applyBulkCorrectionAction,
  previewBulkCorrection,
  undoBulkCorrectionAction,
  type BulkCorrectionRequest,
} from "@/app/(app)/data/bulk-correction-actions";
import { LB_PER_KG } from "@/lib/units";
import { actAs, createLogin, createProfile, seedActor } from "./harness";

const FROM = "2026-03-01";
const TO = "2026-03-31";
const SRC = "withings";

function addWeight(
  profileId: number,
  date: string,
  kg: number,
  source: string | null = SRC
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, date, kg, source).lastInsertRowid
  );
}

function weightRow(id: number): { weight_kg: number; edited: number } {
  return db
    .prepare("SELECT weight_kg, edited FROM body_metrics WHERE id = ?")
    .get(id) as { weight_kg: number; edited: number };
}

function req(op: BulkCorrectionRequest["op"]): BulkCorrectionRequest {
  return { field: "weight", from: FROM, to: TO, source: SRC, op };
}

describe("previewBulkCorrection / applyBulkCorrectionAction", () => {
  it("previews with the lock warning, then applies exactly the previewed run", async () => {
    const { profile } = seedActor();
    const a = addWeight(profile.id, "2026-03-01", 176.4);
    const b = addWeight(profile.id, "2026-03-02", 170.2);

    const preview = await previewBulkCorrection(req({ kind: "unit-preset" }));
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("unreachable");
    expect(preview.count).toBe(2);
    // The #133 warning, said plainly, names the provider.
    expect(preview.lockNote).toContain("2 rows came from Withings");
    expect(preview.lockNote).toContain("stop receiving sync updates");
    expect(preview.sample).toHaveLength(2);

    const res = await applyBulkCorrectionAction({
      ...req({ kind: "unit-preset" }),
      signature: preview.signature,
    });
    expect(res).toMatchObject({ ok: true, applied: 2 });

    expect(weightRow(a).weight_kg).toBeCloseTo(176.4 / LB_PER_KG, 4);
    expect(weightRow(a).edited).toBe(1);
    expect(weightRow(b).edited).toBe(1);
  });

  it("refuses apply with the typed drift outcome when the run changed after preview", async () => {
    const { profile } = seedActor();
    const a = addWeight(profile.id, "2026-03-01", 176.4);

    const preview = await previewBulkCorrection(
      req({ kind: "multiply", value: 0.5 })
    );
    if (!preview.ok) throw new Error("unreachable");

    // A sync lands mid-preview.
    db.prepare("UPDATE body_metrics SET weight_kg = 177.0 WHERE id = ?").run(a);

    const res = await applyBulkCorrectionAction({
      ...req({ kind: "multiply", value: 0.5 }),
      signature: preview.signature,
    });
    expect(res).toMatchObject({ ok: false, error: "drift" });
    expect(weightRow(a).weight_kg).toBe(177); // nothing applied
  });

  it("converts add/set amounts from the login's display unit at the boundary", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lb login", login.id);
    actAs(login, profile);
    const id = addWeight(profile.id, "2026-03-01", 80);

    const preview = await previewBulkCorrection(req({ kind: "add", value: 2 }));
    if (!preview.ok) throw new Error("unreachable");
    const res = await applyBulkCorrectionAction({
      ...req({ kind: "add", value: 2 }),
      signature: preview.signature,
    });
    expect(res.ok).toBe(true);
    // +2 lb stored as +2/LB_PER_KG kg (canonical storage, converted once).
    expect(weightRow(id).weight_kg).toBeCloseTo(80 + 2 / LB_PER_KG, 4);
  });

  it("reports empty and invalid inputs as typed refusals", async () => {
    seedActor();
    expect(
      await previewBulkCorrection(req({ kind: "add", value: 1 }))
    ).toMatchObject({ ok: false, error: "empty" });
    expect(
      await previewBulkCorrection({ ...req({ kind: "add", value: 1 }), field: "sessions" })
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      await previewBulkCorrection({ ...req({ kind: "add", value: 1 }), from: "2026-04-01" })
    ).toMatchObject({ ok: false, error: "invalid" }); // from > to
    expect(
      await applyBulkCorrectionAction({
        ...req({ kind: "add", value: 1 }),
        signature: "",
      })
    ).toMatchObject({ ok: false, error: "invalid" });
  });

  it("refuses a read-only acting session (requireWriteAccess)", async () => {
    const login = createLogin({});
    const profile = createProfile("ro", login.id);
    actAs(login, profile, "read");
    addWeight(profile.id, "2026-03-01", 176.4);
    await expect(
      previewBulkCorrection(req({ kind: "unit-preset" }))
    ).rejects.toThrow();
    await expect(
      applyBulkCorrectionAction({
        ...req({ kind: "unit-preset" }),
        signature: "deadbeef",
      })
    ).rejects.toThrow();
    await expect(undoBulkCorrectionAction(1)).rejects.toThrow();
  });
});

describe("undoBulkCorrectionAction", () => {
  it("restores the run and reports rows changed since as left alone", async () => {
    const { profile } = seedActor();
    const a = addWeight(profile.id, "2026-03-01", 176.4);
    const b = addWeight(profile.id, "2026-03-02", 170.2);

    const preview = await previewBulkCorrection(
      req({ kind: "multiply", value: 0.5 })
    );
    if (!preview.ok) throw new Error("unreachable");
    const applied = await applyBulkCorrectionAction({
      ...req({ kind: "multiply", value: 0.5 }),
      signature: preview.signature,
    });
    if (!applied.ok) throw new Error("unreachable");

    // b is edited again after the correction — undo must not clobber it.
    db.prepare(
      "UPDATE body_metrics SET weight_kg = 86.0, edited = 1 WHERE id = ?"
    ).run(b);

    const undo = await undoBulkCorrectionAction(applied.undoId);
    expect(undo).toMatchObject({ ok: true, restored: 1, skipped: 1 });
    if (!undo.ok) throw new Error("unreachable");
    expect(undo.message).toContain("1 row changed since this correction");
    expect(weightRow(a)).toEqual({ weight_kg: 176.4, edited: 0 });
    expect(weightRow(b)).toEqual({ weight_kg: 86, edited: 1 });

    // The token is consumed — a second undo reports honestly.
    expect(await undoBulkCorrectionAction(applied.undoId)).toMatchObject({
      ok: false,
    });
  });
});
