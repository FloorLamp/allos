// DB INTEGRATION TIER — condition → intake-item lifecycle convergence (#3648).
//
// Every literal condition delete uses the same scoped detach. These tests exercise
// the undo substrate and all four non-undo paths that existed when the invariant
// landed: episode unpromote, episode delete, merge, and import smoking supersession.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteEpisodeRow,
  mergeEpisodeRows,
} from "@/lib/illness-episode-store";
import {
  promoteEpisodeToConditionCore,
  unpromoteEpisodeConditionCore,
} from "@/lib/illness-episode-write";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import { captureDelete, restoreDeletedRow } from "@/lib/undo-delete-db";

function profile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function episode(profileId: number, situation: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes
           (profile_id, situation, start_date, end_date)
         VALUES (?, ?, '2026-08-01', '2026-08-03')`
      )
      .run(profileId, situation).lastInsertRowid
  );
}

function condition(
  profileId: number,
  name: string,
  externalId: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO conditions (profile_id, name, status, external_id)
         VALUES (?, ?, 'active', ?)`
      )
      .run(profileId, name, externalId).lastInsertRowid
  );
}

function promotedCondition(profileId: number, episodeId: number): number {
  const outcome = promoteEpisodeToConditionCore(profileId, episodeId);
  if (outcome.kind === "invalid") throw new Error("promotion fixture failed");
  return outcome.conditionId;
}

function item(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

function linkIndication(itemId: number, conditionId: number): void {
  db.prepare(
    "UPDATE intake_items SET indication_condition_id = ? WHERE id = ?"
  ).run(conditionId, itemId);
}

function conditionPurpose(itemId: number, conditionId: number): void {
  db.prepare(
    `INSERT INTO intake_item_purposes (item_id, kind, condition_id)
     VALUES (?, 'condition', ?)`
  ).run(itemId, conditionId);
}

function goalPurpose(itemId: number): void {
  db.prepare(
    `INSERT INTO intake_item_purposes (item_id, kind, goal_key)
     VALUES (?, 'goal', 'general-wellbeing')`
  ).run(itemId);
}

function indication(itemId: number): number | null {
  return (
    db
      .prepare(
        "SELECT indication_condition_id AS id FROM intake_items WHERE id = ?"
      )
      .get(itemId) as { id: number | null }
  ).id;
}

function purposeTargets(itemId: number): (number | string)[] {
  return (
    db
      .prepare(
        `SELECT COALESCE(condition_id, goal_key) AS target
           FROM intake_item_purposes WHERE item_id = ? ORDER BY id`
      )
      .all(itemId) as { target: number | string }[]
  ).map((row) => row.target);
}

function exists(
  table: "conditions" | "illness_episodes" | "intake_items",
  id: number
) {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as {
      n: number;
    }
  ).n;
}

function document(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

function smokingInput(name: string, code: string): PersistInput {
  return {
    observations: [],
    immunizations: [],
    allergies: [],
    conditions: [
      {
        name,
        code,
        code_system: "SNOMED CT",
        status: "active",
        onset_date: null,
        resolved_date: null,
        external_id: `ccda:social-smoking:${code}`,
      },
    ],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccda",
      documentDate: "2026-08-01",
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

describe("condition delete intake-link lifecycle (#3648)", () => {
  it("capture delete preserves items and unrelated purposes, and undo does not restore detached links", () => {
    const p = profile("3648-capture");
    const target = condition(p, "Migraine");
    const other = condition(p, "Insomnia");
    const supplement = item(p, "Magnesium");
    linkIndication(supplement, target);
    conditionPurpose(supplement, target);
    conditionPurpose(supplement, other);
    goalPurpose(supplement);

    const undoId = captureDelete("condition", p, target)!;
    expect(exists("intake_items", supplement)).toBe(1);
    expect(indication(supplement)).toBeNull();
    expect(purposeTargets(supplement)).toEqual([other, "general-wellbeing"]);

    expect(restoreDeletedRow(p, undoId)).toBe(true);
    expect(exists("conditions", target)).toBe(0); // restore receives a new row id
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ? AND name = 'Migraine'"
          )
          .get(p) as { n: number }
      ).n
    ).toBe(1);
    expect(indication(supplement)).toBeNull();
    expect(purposeTargets(supplement)).toEqual([other, "general-wellbeing"]);
  });

  it("unpromote is atomic and refuses to mutate through a corrupt cross-profile link", () => {
    const owner = profile("3648-unpromote-owner");
    const otherProfile = profile("3648-unpromote-other");
    const ep = episode(owner, "Flu");
    const target = promotedCondition(owner, ep);
    const sibling = condition(owner, "Asthma");
    const ownedItem = item(owner, "Electrolytes");
    const corruptItem = item(otherProfile, "Other profile item");
    linkIndication(ownedItem, target);
    conditionPurpose(ownedItem, target);
    conditionPurpose(ownedItem, sibling);
    goalPurpose(ownedItem);
    linkIndication(corruptItem, target);
    conditionPurpose(corruptItem, target);

    expect(() => unpromoteEpisodeConditionCore(owner, ep)).toThrow();
    // The failed root delete rolls the same-profile detaches back with it.
    expect(exists("conditions", target)).toBe(1);
    expect(indication(ownedItem)).toBe(target);
    expect(purposeTargets(ownedItem)).toEqual([
      target,
      sibling,
      "general-wellbeing",
    ]);
    // No authority over the corrupt other-profile facts was inferred.
    expect(indication(corruptItem)).toBe(target);
    expect(purposeTargets(corruptItem)).toEqual([target]);

    db.prepare(
      "UPDATE intake_items SET indication_condition_id = NULL WHERE id = ?"
    ).run(corruptItem);
    db.prepare("DELETE FROM intake_item_purposes WHERE item_id = ?").run(
      corruptItem
    );
    expect(unpromoteEpisodeConditionCore(owner, ep)).toBe(true);
    expect(exists("conditions", target)).toBe(0);
    expect(exists("intake_items", ownedItem)).toBe(1);
    expect(indication(ownedItem)).toBeNull();
    expect(purposeTargets(ownedItem)).toEqual([sibling, "general-wellbeing"]);
  });

  it("episode delete detaches the condition links before deleting the episode", () => {
    const p = profile("3648-episode-delete");
    const ep = episode(p, "Stomach bug");
    const target = promotedCondition(p, ep);
    const supplement = item(p, "Oral rehydration salts");
    linkIndication(supplement, target);
    conditionPurpose(supplement, target);
    goalPurpose(supplement);

    expect(deleteEpisodeRow(p, ep)).toBe(true);
    expect(exists("illness_episodes", ep)).toBe(0);
    expect(exists("conditions", target)).toBe(0);
    expect(exists("intake_items", supplement)).toBe(1);
    expect(indication(supplement)).toBeNull();
    expect(purposeTargets(supplement)).toEqual(["general-wellbeing"]);
  });

  it("merge detaches only the redundant deleted condition and preserves the keeper's links", () => {
    const p = profile("3648-merge-delete");
    const keep = episode(p, "Cold");
    const drop = episode(p, "Cold again");
    const keepCondition = promotedCondition(p, keep);
    const dropCondition = promotedCondition(p, drop);
    const keepItem = item(p, "Keep item");
    const dropItem = item(p, "Drop item");
    linkIndication(keepItem, keepCondition);
    conditionPurpose(keepItem, keepCondition);
    linkIndication(dropItem, dropCondition);
    conditionPurpose(dropItem, dropCondition);

    expect(mergeEpisodeRows(p, keep, drop)).toBe(keep);
    expect(exists("conditions", keepCondition)).toBe(1);
    expect(indication(keepItem)).toBe(keepCondition);
    expect(purposeTargets(keepItem)).toEqual([keepCondition]);
    expect(exists("conditions", dropCondition)).toBe(0);
    expect(indication(dropItem)).toBeNull();
    expect(purposeTargets(dropItem)).toEqual([]);
  });

  it("merge re-anchors a lone dropped condition without detaching its links", () => {
    const p = profile("3648-merge-reanchor");
    const keep = episode(p, "Cold");
    const drop = episode(p, "Cold again");
    const reanchoredCondition = promotedCondition(p, drop);
    const supplement = item(p, "Zinc");
    linkIndication(supplement, reanchoredCondition);
    conditionPurpose(supplement, reanchoredCondition);

    expect(mergeEpisodeRows(p, keep, drop)).toBe(keep);
    expect(exists("conditions", reanchoredCondition)).toBe(1);
    expect(indication(supplement)).toBe(reanchoredCondition);
    expect(purposeTargets(supplement)).toEqual([reanchoredCondition]);
    expect(
      (
        db
          .prepare("SELECT external_id FROM conditions WHERE id = ?")
          .get(reanchoredCondition) as { external_id: string }
      ).external_id
    ).toBe(`illness-episode:${keep}`);
  });

  it("smoking supersession detaches the prior status without disturbing other purposes", () => {
    const p = profile("3648-smoking");
    persistDocumentImport(
      p,
      document(p, "smoking-old.xml"),
      smokingInput("Current smoker", "449868002")
    );
    const oldCondition = (
      db
        .prepare(
          `SELECT id FROM conditions
            WHERE profile_id = ? AND external_id LIKE '%ccda:social-smoking:%'`
        )
        .get(p) as { id: number }
    ).id;
    const unrelated = condition(p, "Asthma");
    const medication = item(p, "Smoking cessation support");
    linkIndication(medication, oldCondition);
    conditionPurpose(medication, oldCondition);
    conditionPurpose(medication, unrelated);
    goalPurpose(medication);

    persistDocumentImport(
      p,
      document(p, "smoking-new.xml"),
      smokingInput("Former smoker", "8517006")
    );

    expect(exists("conditions", oldCondition)).toBe(0);
    expect(exists("intake_items", medication)).toBe(1);
    expect(indication(medication)).toBeNull();
    expect(purposeTargets(medication)).toEqual([
      unrelated,
      "general-wellbeing",
    ]);
    const smokingRows = db
      .prepare(
        `SELECT name FROM conditions
          WHERE profile_id = ? AND external_id LIKE '%ccda:social-smoking:%'`
      )
      .all(p) as { name: string }[];
    expect(smokingRows).toEqual([{ name: "Former smoker" }]);
  });
});
