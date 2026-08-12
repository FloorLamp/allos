import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// Issue #1847 — the medical passport's deletes are undoable. Deleting a weigh-in has
// offered an Undo toast since #30 while deleting a penicillin allergy was permanent;
// these two journeys drive the visible half of the fix end to end.
//
// Both cover the thing a re-typed row cannot reproduce:
//   • an allergy's graded MANIFESTATIONS (an ON DELETE CASCADE child), which are what
//     the criticality and the drug screen read, and
//   • a lesion's PHOTO SERIES, the serial comparison a dermatologist looks at.
//
// Fixture ownership (docs/internals/e2e-hygiene.md): every row this spec touches is
// one it created under a collision-free marker, seeded and swept through a raw
// connection, so it never counts or mutates shared seed rows and is idempotent across
// CI retries and --repeat-each.
const DB_PATH = workerDbPath();
const ALLERGEN = "E2EUndoPenicillinMarker";
const LESION = "E2EUndoLesionMarker";
const VISIT_REASON = "E2EUndoVisitMarker";

function withDb<T>(fn: (handle: Database.Database) => T): T {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

function cleanup() {
  withDb((db) => {
    db.prepare(
      `DELETE FROM allergy_reactions
        WHERE allergy_id IN (SELECT id FROM allergies WHERE substance = ?)`
    ).run(ALLERGEN);
    db.prepare("DELETE FROM allergies WHERE substance = ?").run(ALLERGEN);
    db.prepare(
      `DELETE FROM lesion_photos
        WHERE lesion_id IN (SELECT id FROM skin_lesions WHERE label = ?)`
    ).run(LESION);
    db.prepare("DELETE FROM skin_lesions WHERE label = ?").run(LESION);
    // The visit probe and the reading recorded at it (the inbound link the delete has
    // to detach before the row can go).
    db.prepare(
      `UPDATE medical_records SET encounter_id = NULL
        WHERE encounter_id IN (SELECT id FROM encounters WHERE reason = ?)`
    ).run(VISIT_REASON);
    db.prepare("DELETE FROM medical_records WHERE name = ?").run(VISIT_REASON);
    db.prepare("DELETE FROM encounters WHERE reason = ?").run(VISIT_REASON);
    // The holding rows this spec's deletes minted, so a failed run leaves no capture
    // behind for Data → Trash specs to trip over.
    db.prepare(
      "DELETE FROM deleted_rows WHERE payload LIKE ? OR payload LIKE ?"
    ).run(`%${ALLERGEN}%`, `%${LESION}%`);
    db.prepare("DELETE FROM deleted_rows WHERE payload LIKE ?").run(
      `%${VISIT_REASON}%`
    );
  });
}

test.describe("Clinical deletes are undoable (#1847)", () => {
  test.beforeEach(cleanup);
  test.afterAll(cleanup);

  test("an allergy delete restores the row AND its graded reactions", async ({
    page,
  }) => {
    test.slow();
    const allergyId = withDb((db) => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO allergies
               (profile_id, substance, status, criticality, verification_status, notes)
             VALUES (1, ?, 'active', 'high', 'confirmed', 'ER visit 2019')`
          )
          .run(ALLERGEN).lastInsertRowid
      );
      for (const [manifestation, severity] of [
        ["Hives", "moderate"],
        ["Anaphylaxis", "severe"],
      ])
        db.prepare(
          `INSERT INTO allergy_reactions (allergy_id, manifestation, severity)
           VALUES (?, ?, ?)`
        ).run(id, manifestation, severity);
      return id;
    });

    await page.goto("/records/problems/allergies");
    const row = page.getByRole("row").filter({ hasText: ALLERGEN });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Anaphylaxis (severe)");

    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );

    // Gone from the manager, and the shared Undo toast is offered.
    await expect(
      page.getByRole("row").filter({ hasText: ALLERGEN })
    ).toHaveCount(0);
    await expect(page.getByText("Allergy deleted.")).toBeVisible();

    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible();

    // Back on the manager under a NEW id (restore re-inserts), with the manifestation
    // that decides its criticality intact — restoring a quieter allergy than the one
    // deleted would be the safety regression this issue is about.
    const restored = page.getByRole("row").filter({ hasText: ALLERGEN });
    await expect(restored).toHaveCount(1);
    await expect(restored).toContainText("Anaphylaxis (severe)");
    await expect(restored).toContainText("High criticality");

    withDb((db) => {
      const back = db
        .prepare("SELECT id FROM allergies WHERE substance = ?")
        .get(ALLERGEN) as { id: number };
      expect(back.id).not.toBe(allergyId);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM allergy_reactions WHERE allergy_id = ?"
          )
          .get(back.id)
      ).toEqual({ c: 2 });
    });
  });

  test("a lesion delete restores the observation AND its photo series", async ({
    page,
  }) => {
    test.slow();
    withDb((db) => {
      const lesionId = Number(
        db
          .prepare(
            `INSERT INTO skin_lesions
               (profile_id, label, body_region, observed_date, status, finding)
             VALUES (1, ?, 'shoulder', '2026-04-01', 'watch', 'Even brown, watching.')`
          )
          .run(LESION).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO lesion_photos
           (profile_id, lesion_id, date, stored_path, content_hash, mime_type, caption)
         VALUES (1, ?, '2026-04-02', ?, 'e2eundohash', 'image/jpeg', 'baseline')`
      ).run(lesionId, `data/uploads/lesion-photos/1/e2eundohash.jpg`);
    });

    await page.goto("/records/specialty/skin");
    const card = page.getByTestId("lesion-card").filter({ hasText: LESION });
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(
      page.getByTestId("lesion-card").filter({ hasText: LESION })
    ).toHaveCount(0);
    await expect(page.getByText("Lesion record deleted.")).toBeVisible();

    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible();
    await expect(
      page.getByTestId("lesion-card").filter({ hasText: LESION })
    ).toHaveCount(1);

    // The photo row is back and re-parented onto the lesion's NEW id — the series,
    // not just the observation.
    withDb((db) => {
      const back = db
        .prepare("SELECT id FROM skin_lesions WHERE label = ?")
        .get(LESION) as { id: number };
      expect(
        db
          .prepare("SELECT caption FROM lesion_photos WHERE lesion_id = ?")
          .get(back.id)
      ).toEqual({ caption: "baseline" });
    });
  });
  test("a visit delete restores the visit, and the reading it detached stays detached", async ({
    page,
  }) => {
    test.slow();
    withDb((db) => {
      const encounterId = Number(
        db
          .prepare(
            `INSERT INTO encounters (profile_id, date, type, reason)
             VALUES (1, '2026-04-08', 'office', ?)`
          )
          .run(VISIT_REASON).lastInsertRowid
      );
      // A reading recorded AT the visit: a real REFERENCES with no ON DELETE, so this
      // link is what the delete has to detach first. It is also the half undo
      // deliberately does not put back.
      db.prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit, canonical_name, encounter_id)
         VALUES (1, '2026-04-08', 'lab', ?, '84', 84, 'ng/mL', 'Ferritin', ?)`
      ).run(VISIT_REASON, encounterId);
    });

    await page.goto("/records");
    const row = page.getByRole("row").filter({ hasText: VISIT_REASON });
    await expect(row).toHaveCount(1);

    await row.getByLabel("Record actions").click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(
      page.getByRole("row").filter({ hasText: VISIT_REASON })
    ).toHaveCount(0);
    await expect(page.getByText("Visit deleted.")).toBeVisible();

    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: VISIT_REASON })
    ).toHaveCount(1);

    withDb((db) => {
      // The visit is back (under a new id), and the reading survived the whole trip
      // with its "recorded at" link honestly cleared — the documented posture for an
      // inbound null-out, not a bug.
      expect(
        db
          .prepare("SELECT COUNT(*) AS c FROM encounters WHERE reason = ?")
          .get(VISIT_REASON)
      ).toEqual({ c: 1 });
      expect(
        db
          .prepare("SELECT encounter_id FROM medical_records WHERE name = ?")
          .get(VISIT_REASON)
      ).toEqual({ encounter_id: null });
    });
  });
});
