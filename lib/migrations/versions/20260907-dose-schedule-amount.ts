import type Database from "better-sqlite3";
import type { Migration } from "../runner";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rewriteIntakeItemPayload(json: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.v !== 1 || payload.kind !== "intake-item") {
    return null;
  }
  const rows = payload.rows;
  if (!isRecord(rows)) return null;
  const doses = rows.doses;
  const versions = rows.doseVersions;
  if (!Array.isArray(doses) || !Array.isArray(versions)) return null;

  const capturedAmounts = new Map<number, string | null>();
  for (const dose of doses) {
    if (
      !isRecord(dose) ||
      !Number.isInteger(dose.id) ||
      !Object.hasOwn(dose, "amount") ||
      (typeof dose.amount !== "string" && dose.amount !== null)
    ) {
      continue;
    }
    capturedAmounts.set(dose.id as number, dose.amount);
  }

  let changed = false;
  for (const version of versions) {
    if (
      !isRecord(version) ||
      !Number.isInteger(version.dose_id) ||
      Object.hasOwn(version, "amount") ||
      Object.hasOwn(version, "amount_captured") ||
      !capturedAmounts.has(version.dose_id as number)
    ) {
      continue;
    }
    version.amount = capturedAmounts.get(version.dose_id as number) ?? null;
    version.amount_captured = 0;
    changed = true;
  }
  return changed ? JSON.stringify(payload) : null;
}

function upgradeDeletedIntakeItems(db: Database.Database): void {
  const captures = db
    .prepare(
      "SELECT id, payload FROM deleted_rows WHERE kind = 'intake-item' ORDER BY id"
    )
    .all() as { id: number; payload: string }[];
  const update = db.prepare("UPDATE deleted_rows SET payload = ? WHERE id = ?");
  for (const capture of captures) {
    const payload = rewriteIntakeItemPayload(capture.payload);
    if (payload !== null) update.run(payload, capture.id);
  }
}

function hasColumn(db: Database.Database, name: string): boolean {
  return (
    db.prepare("PRAGMA table_info(intake_dose_schedule_versions)").all() as {
      name: string;
    }[]
  ).some((column) => column.name === name);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, "amount")) {
    db.exec("ALTER TABLE intake_dose_schedule_versions ADD COLUMN amount TEXT");
    db.exec(`
      UPDATE intake_dose_schedule_versions
         SET amount = (
           SELECT d.amount
             FROM intake_item_doses d
            WHERE d.id = intake_dose_schedule_versions.dose_id
         )
    `);
  }
  if (!hasColumn(db, "amount_captured")) {
    db.exec(`
      ALTER TABLE intake_dose_schedule_versions
        ADD COLUMN amount_captured INTEGER NOT NULL DEFAULT 0
        CHECK (amount_captured IN (0, 1))
    `);
  }
  // Trash snapshots are raw captured rows, and restore inserts only their stored
  // keys. Give a legacy version the amount from its captured dose in the same payload;
  // a live dose with a recycled old id is not evidence about this deleted history.
  upgradeDeletedIntakeItems(db);
}

export const migration: Migration = {
  name: "20260907-dose-schedule-amount",
  up,
};
