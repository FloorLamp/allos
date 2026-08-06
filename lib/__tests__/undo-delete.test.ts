import { describe, it, expect } from "vitest";
import {
  UNDO_KINDS,
  getKindSpec,
  serializePayload,
  parsePayload,
  remapRow,
  capturedPhotoFiles,
  capturedVideoFiles,
  PHOTO_FILE_TABLES,
  VIDEO_FILE_TABLES,
  type IdMaps,
  type Row,
} from "@/lib/undo-delete";
import { OWNED_TABLES } from "@/lib/owned-tables";

// PURE tests for the undo-delete registry + serialize/restore transforms (issue
// #30). The DB round-trip (real delete → undo) is exercised separately in the
// db-integration tier: lib/__db_tests__/undo-delete.test.ts.

describe("undo-delete registry", () => {
  it("every kind's root table is a profile-owned table", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      const root = spec.entities[0];
      expect(root.table).toBe(spec.ownedTable);
      expect(OWNED_TABLES as readonly string[]).toContain(spec.ownedTable);
    }
  });

  it("entities are in dependency order (every row/key ref appears earlier)", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      const seen = new Set<string>();
      for (const e of spec.entities) {
        for (const fk of e.fks) {
          // A ref must be an entity defined at or before this one (self-ref for the
          // root is fine; children reference an already-inserted parent).
          expect(seen.has(fk.ref) || fk.ref === e.entity).toBe(true);
        }
        for (const keyRef of e.keyRefs ?? [])
          expect(seen.has(keyRef.ref) || keyRef.ref === e.entity).toBe(true);
        seen.add(e.entity);
      }
    }
  });

  it("only the root entity lacks a child capture clause", () => {
    for (const spec of Object.values(UNDO_KINDS)) {
      spec.entities.forEach((e, i) => {
        if (i === 0) {
          expect(e.childWhere).toBeUndefined();
          expect(e.fks).toEqual([]);
        } else {
          expect(typeof e.childWhere).toBe("string");
        }
      });
    }
  });

  it("getKindSpec throws on an unknown kind", () => {
    expect(() => getKindSpec("nope")).toThrow(/unknown undo kind/);
  });

  // #202: the captured FK columns that point OUTSIDE a capture (and can dangle if
  // their target is deleted before undo) are declared as externalRefs so restore
  // can null / drop them instead of throwing on a verbatim re-insert.
  it("declares the dangling external FK links (equipment, pair endpoints)", () => {
    const sets = getKindSpec("activity").entities.find(
      (e) => e.entity === "sets"
    )!;
    expect(sets.externalRefs).toEqual([
      { column: "equipment_id", table: "equipment", onMissing: "null" },
    ]);

    const pairs = getKindSpec("intake-item").entities.find(
      (e) => e.entity === "pairs"
    )!;
    expect(pairs.externalRefs).toEqual([
      { column: "a_id", table: "intake_items", onMissing: "drop" },
      { column: "b_id", table: "intake_items", onMissing: "drop" },
    ]);

    // #375: the biomarker record's document_id / provider_id are real enforced FKs
    // (migration 006) that dangle when the document is deleted or the provider is
    // merged/deleted after capture — both null on restore. providers is a GLOBAL
    // (no-profile_id) table, so its ref carries global: true.
    const record = getKindSpec("biomarker-record").entities.find(
      (e) => e.entity === "record"
    )!;
    expect(record.externalRefs).toEqual([
      { column: "document_id", table: "medical_documents", onMissing: "null" },
      {
        column: "provider_id",
        table: "providers",
        onMissing: "null",
        global: true,
      },
      // #1050: the visit link nulls on restore when its encounter is gone.
      { column: "encounter_id", table: "encounters", onMissing: "null" },
      // #1404: the ORDERING provider link is the same enforced global FK as
      // provider_id, so it nulls on restore the same way.
      {
        column: "ordering_provider_id",
        table: "providers",
        onMissing: "null",
        global: true,
      },
    ]);

    // #455: intake_items.provider_id is the SAME real enforced FK (migration 006),
    // so a captured supplement/medication whose prescriber was merged/deleted after
    // capture must null its provider link on restore too — the #375 class for
    // intake_items. Also a GLOBAL ref. #598 adds the two remaining captured FKs on the
    // root: document_id (an extracted med's source document) and situation_id — both
    // profile-owned (probed WITH profile_id), nulled when their target is gone.
    const item = getKindSpec("intake-item").entities.find(
      (e) => e.entity === "item"
    )!;
    expect(item.externalRefs).toEqual([
      {
        column: "provider_id",
        table: "providers",
        onMissing: "null",
        global: true,
      },
      { column: "document_id", table: "medical_documents", onMissing: "null" },
      { column: "situation_id", table: "situations", onMissing: "null" },
      // #1296: the INVERSE situational link (pause_situation_id, migration 108) is the
      // mirror of situation_id — the same nullable-FK-to-situations shape, nulled on
      // restore when its target situation is gone. Profile-owned, probed WITH scope.
      {
        column: "pause_situation_id",
        table: "situations",
        onMissing: "null",
      },
      // #1050: the "prescribed at" visit link nulls on restore when its encounter
      // is gone.
      { column: "encounter_id", table: "encounters", onMissing: "null" },
      // #1374: the shared supply pool link. Deleting a bottle nulls only LIVE links,
      // so a captured copy can still hold a since-deleted supply_id — restore with the
      // link NULLed (the item comes back untracked). shared_supplies is GLOBAL (no
      // profile_id, the providers precedent), so the probe is by id alone.
      {
        column: "supply_id",
        table: "shared_supplies",
        onMissing: "null",
        global: true,
      },
      // #1051 provenance link + #1052 indication link: the source prescription
      // medical_records row and the treated condition both null on restore when
      // their target is gone. Profile-owned, probed WITH the profile_id scope.
      {
        column: "source_record_id",
        table: "medical_records",
        onMissing: "null",
      },
      {
        column: "indication_condition_id",
        table: "conditions",
        onMissing: "null",
      },
    ]);

    // Every externalRef target is a real table name and its onMissing is one of the
    // two supported actions.
    for (const spec of Object.values(UNDO_KINDS))
      for (const e of spec.entities)
        for (const ref of e.externalRefs ?? [])
          expect(["null", "drop"]).toContain(ref.onMissing);
  });

  // #1847: every clinical root carries the SAME three outward links (source document,
  // visit, provider), and all three must be reconciled — a captured allergy whose
  // encounter was deleted inside the window would otherwise abort its own undo on the
  // FK, which is the #202/#375 class landing in the passport.
  it("reconciles the source document / visit / provider link on every clinical kind", () => {
    const rootOf = (kind: string) => getKindSpec(kind).entities[0];
    const doc = {
      column: "document_id",
      table: "medical_documents",
      onMissing: "null",
    };
    const visit = {
      column: "encounter_id",
      table: "encounters",
      onMissing: "null",
    };
    const provider = {
      column: "provider_id",
      table: "providers",
      onMissing: "null",
      global: true,
    };
    expect(rootOf("allergy").externalRefs).toEqual([doc, visit, provider]);
    // Conditions carry no provider column at all, so declaring one would be a lie.
    expect(rootOf("condition").externalRefs).toEqual([doc, visit]);
    // Immunizations carry no document link (the importer records `source` only).
    expect(rootOf("immunization").externalRefs).toEqual([visit, provider]);
    expect(rootOf("skin-lesion").externalRefs).toEqual([doc, visit, provider]);
  });

  // #1847: the clinical roots sit under a partial UNIQUE(profile_id, external_id) and
  // their importer re-inserts with OR IGNORE, so a document reprocess inside the undo
  // window can re-take a deleted imported row's key. Declaring it lets restore ADOPT
  // the live row instead of aborting on the index.
  it("declares the UNIQUE natural key on every clinical root, and only on roots", () => {
    for (const kind of ["allergy", "condition", "immunization", "skin-lesion"])
      expect(getKindSpec(kind).entities[0].uniqueKey, kind).toEqual([
        "external_id",
      ]);
    // A child's key is its parent's FK, which the remap already handles — a uniqueKey
    // there would probe the wrong row.
    for (const spec of Object.values(UNDO_KINDS))
      for (const e of spec.entities.slice(1))
        expect(e.uniqueKey, `${spec.kind}.${e.entity}`).toBeUndefined();
  });

  // #1847: `lesion_photos.lesion_id` is a plain REFERENCES (no ON DELETE), so the
  // photos must be removed explicitly for the lesion DELETE to land — and captured
  // first, or the series would be the one thing a restore could not reproduce.
  it("captures the lesion photo series as an explicitly-deleted child", () => {
    const photos = getKindSpec("skin-lesion").entities.find(
      (e) => e.entity === "photos"
    )!;
    expect(photos.table).toBe("lesion_photos");
    expect(photos.deleteExplicitly).toBe(true);
    expect(photos.fks).toEqual([{ column: "lesion_id", ref: "lesion" }]);
  });
});

describe("serialize / parse round-trip", () => {
  it("preserves kind and rows", () => {
    const rows: Record<string, Row[]> = {
      activity: [{ id: 5, title: "Squats", profile_id: 2 }],
      sets: [
        { id: 9, activity_id: 5, exercise: "Back Squat", set_number: 1 },
        { id: 10, activity_id: 5, exercise: "Back Squat", set_number: 2 },
      ],
    };
    const json = serializePayload("activity", rows);
    const back = parsePayload(json);
    expect(back.kind).toBe("activity");
    expect(back.rows).toEqual(rows);
  });

  // Issue #200: an activity-merge delete rides an optional MergeUndoContext in the
  // payload so its undo can invert the merge. A plain delete omits it entirely.
  it("carries an optional merge-undo context through the round-trip", () => {
    const rows: Record<string, Row[]> = {
      activity: [{ id: 5, title: "Drop", profile_id: 2 }],
      sets: [],
    };
    const merge = {
      keeperId: 4,
      domain: "activity",
      signature: "id:4|id:5",
      keeperBefore: { components: null, distance_km: null, edited: 0 },
      movedSetIds: [9, 10],
      movedRouteId: null,
    };
    const back = parsePayload(serializePayload("activity", rows, merge));
    expect(back.merge).toEqual(merge);
    // Omitting it leaves the field absent (a plain delete is unchanged).
    expect(
      parsePayload(serializePayload("activity", rows)).merge
    ).toBeUndefined();
  });

  it("rejects an invalid payload version / unknown kind", () => {
    expect(() =>
      parsePayload(JSON.stringify({ v: 2, kind: "activity" }))
    ).toThrow();
    expect(() =>
      parsePayload(JSON.stringify({ v: 1, kind: "bogus", rows: {} }))
    ).toThrow();
    expect(() =>
      parsePayload(JSON.stringify({ v: 1, kind: "activity" }))
    ).toThrow(/rows/);
  });
});

describe("remapRow", () => {
  it("drops the id and remaps a captured FK to the new parent id", () => {
    const idMaps: IdMaps = { activity: new Map([[5, 77]]) };
    const out = remapRow(
      { id: 9, activity_id: 5, exercise: "Back Squat" },
      idMaps,
      [{ column: "activity_id", ref: "activity" }]
    );
    expect(out).toEqual({ activity_id: 77, exercise: "Back Squat" });
    expect("id" in out).toBe(false);
  });

  it("remaps an id embedded in a captured suppression key (#1621)", () => {
    const idMaps: IdMaps = { target: new Map([[42, 91]]) };
    expect(
      remapRow(
        {
          id: 7,
          profile_id: 2,
          signal_key: "practice:42",
          dismissed_at: "2026-07-29 12:00:00",
        },
        idMaps,
        [],
        [{ column: "signal_key", prefix: "practice:", ref: "target" }]
      )
    ).toEqual({
      profile_id: 2,
      signal_key: "practice:91",
      dismissed_at: "2026-07-29 12:00:00",
    });
  });

  it("leaves a far-endpoint FK (target not in this capture) untouched", () => {
    // A "take together" pair: a_id was the deleted+restored item, b_id points at a
    // still-existing item that was NOT part of the capture.
    const idMaps: IdMaps = { item: new Map([[3, 42]]) };
    const out = remapRow(
      { id: 1, a_id: 3, b_id: 8, relation: "with" },
      idMaps,
      [
        { column: "a_id", ref: "item" },
        { column: "b_id", ref: "item" },
      ]
    );
    expect(out).toEqual({ a_id: 42, b_id: 8, relation: "with" });
  });

  it("keeps a null FK null", () => {
    const idMaps: IdMaps = { courses: new Map([[1, 2]]) };
    const out = remapRow({ id: 4, item_id: 3, course_id: null }, idMaps, [
      { column: "course_id", ref: "courses" },
    ]);
    expect(out.course_id).toBeNull();
  });
});

// #1290: the purge sweep must unlink a captured clip's on-disk files when its undo
// buffer entry expires without a restore. This pure half extracts (domain, file)
// pairs from the payload; the live-reference dedup guard + unlink is the DB tier.
describe("capturedVideoFiles (#1290)", () => {
  it("extracts activity_videos clip + poster paths from an activity payload", () => {
    const payload = parsePayload(
      serializePayload("activity", {
        activity: [{ id: 1 }],
        sets: [],
        route: [],
        video: [
          {
            id: 7,
            activity_id: 1,
            stored_path: "data/uploads/activity-videos/3/abc.mp4",
            poster_path: "data/uploads/activity-videos/3/abc.poster.jpg",
          },
          {
            id: 8,
            activity_id: 1,
            stored_path: "data/uploads/activity-videos/3/def.mov",
            poster_path: null,
          },
        ],
      })
    );
    expect(capturedVideoFiles(payload)).toEqual([
      {
        domain: "activity",
        storedPath: "data/uploads/activity-videos/3/abc.mp4",
        posterPath: "data/uploads/activity-videos/3/abc.poster.jpg",
      },
      {
        domain: "activity",
        storedPath: "data/uploads/activity-videos/3/def.mov",
        posterPath: null,
      },
    ]);
  });

  it("returns nothing for a payload with no video child (a body-metric delete)", () => {
    const payload = parsePayload(
      serializePayload("body-metric", { metric: [{ id: 1 }] })
    );
    expect(capturedVideoFiles(payload)).toEqual([]);
  });

  it("maps the video-file tables to their domain (the store's DOMAIN_DIRS keys)", () => {
    expect(VIDEO_FILE_TABLES).toEqual({
      activity_videos: "activity",
      symptom_videos: "symptom",
    });
  });
});

// #1847: the same purge obligation one media core over. The clinical block is the
// first kind to capture a photo ROW, so a purge that reclaimed nothing would leave a
// deleted dermatology close-up — and its thumbnail — on disk forever.
describe("capturedPhotoFiles (#1847)", () => {
  it("extracts lesion_photos stored paths from a skin-lesion payload", () => {
    const payload = parsePayload(
      serializePayload("skin-lesion", {
        lesion: [{ id: 4 }],
        photos: [
          {
            id: 11,
            lesion_id: 4,
            stored_path: "data/uploads/lesion-photos/3/abc.jpg",
          },
          {
            id: 12,
            lesion_id: 4,
            stored_path: "data/uploads/lesion-photos/3/def.jpg",
          },
        ],
      })
    );
    // thumbPath is null because `lesion_photos` has NO thumb_path column: the
    // thumbnail is a derived sibling, and deriving it is the impure sweep's job (one
    // rule, lib/photo/store thumbSiblingPath) rather than a second copy here.
    expect(capturedPhotoFiles(payload)).toEqual([
      {
        domain: "lesion",
        storedPath: "data/uploads/lesion-photos/3/abc.jpg",
        thumbPath: null,
      },
      {
        domain: "lesion",
        storedPath: "data/uploads/lesion-photos/3/def.jpg",
        thumbPath: null,
      },
    ]);
  });

  it("returns nothing for a payload with no photo child (an allergy delete)", () => {
    const payload = parsePayload(
      serializePayload("allergy", { allergy: [{ id: 1 }], reactions: [] })
    );
    expect(capturedPhotoFiles(payload)).toEqual([]);
  });

  it("maps the photo-file tables to their domain (the store's DOMAIN_DIRS keys)", () => {
    expect(PHOTO_FILE_TABLES).toEqual({
      progress_photos: "progress",
      lesion_photos: "lesion",
      symptom_photos: "symptom",
    });
  });
});
