// SERVER-ACTION TIER — the RxNorm RE-CHECK inside the imported-name adoption
// (#3480), which is the step that makes the write trustworthy rather than merely
// authenticated.
//
// WHY THIS FILE EXISTS AT ALL. Nothing observed that block. The whole
// `lookupRxNormCandidates` guard could be deleted from
// app/(app)/import/name-actions.ts and every other tier stayed green, because the
// only other file that names the module imports it as a TYPE. The behaviour was
// correct and nothing held it there — one mechanism and a comment, not a guard.
//
// The re-check is the answer to a forged or stale payload: the form carries a name
// and a code side by side, and before a medicine is renamed the action asks RxNorm
// whether that code really does answer to that name FOR THE STORED STRING. So the
// cases below drive the real action with a real FormData payload and assert the two
// things that matter — the refusal, and the row afterwards. A refusal that still
// wrote would satisfy an assertion about the message alone.
//
// RXNAV IS STUBBED AT `fetch`, NOT AT THE MODULE, and that is the better seam twice
// over. It keeps the REAL `lookupRxNormCandidates` in the picture — its non-OK
// branch, its catch, its `parseApproximateTerm` — so a malformed body is refused by
// the code that actually ships rather than by a stand-in; and `fetch` is a global
// rather than a module-registry entry, so this file shares the tier's module graph
// instead of buying a private one (lib/__tests__/vitest-isolation-budget.test.ts).
//
// All fixtures synthetic. The medication string is a product label, not anybody's
// data, and the response bodies are hand-written.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { seedActor, fd } from "./harness";
import { adoptImportedMedicationName } from "@/app/(app)/import/name-actions";

const PORTAL_NAME = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";
const CLEAN_NAME = "Calcium Carbonate / Cholecalciferol";
const CLEAN_RXCUI = "904458";

// One RxNav approximateTerm body, in the shape the real endpoint returns.
function approximateTerm(
  concepts: { rxcui: string; name: string }[]
): Record<string, unknown> {
  return {
    approximateGroup: {
      candidate: concepts.map((c, i) => ({
        ...c,
        score: 100 - i,
        rank: i + 1,
      })),
    },
  };
}

const CONFIRMING = approximateTerm([{ rxcui: CLEAN_RXCUI, name: CLEAN_NAME }]);

// What RxNav does this run. `body` is returned as JSON; `status`, `throws` and
// `unparseable` are the three ways the network says no. `asked` records the URLs, so
// a case can assert the lookup was made about the stored string — or never made.
const rxnav: {
  body: unknown;
  status: number;
  throws: boolean;
  unparseable: boolean;
  asked: string[];
} = {
  body: CONFIRMING,
  status: 200,
  throws: false,
  unparseable: false,
  asked: [],
};

const realFetch = globalThis.fetch;

let profileId = 0;
let documentId = 0;
let itemId = 0;
let seq = 0;

function seedImportedMedication(name = PORTAL_NAME): void {
  const { profile } = seedActor({ profileName: `imported_name_${++seq}` });
  profileId = profile.id;
  documentId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'meds.ccd', '', 'done', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
  itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
         VALUES (?, ?, 'medication', 'extracted', ?)`
      )
      .run(profileId, name, documentId).lastInsertRowid
  );
}

beforeEach(() => {
  rxnav.body = CONFIRMING;
  rxnav.status = 200;
  rxnav.throws = false;
  rxnav.unparseable = false;
  rxnav.asked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    rxnav.asked.push(url);
    // The ingredient decomposition is a second round trip and is not what these
    // cases are about; it degrades to [] by contract, so answer it emptily.
    if (url.includes("/related.json")) return Response.json({});
    if (rxnav.throws) throw new TypeError("fetch failed");
    if (rxnav.unparseable)
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    return Response.json(rxnav.body, { status: rxnav.status });
  }) as typeof fetch;
  seedImportedMedication();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function storedRow(): { name: string; source_name: string | null } {
  return db
    .prepare("SELECT name, source_name FROM intake_items WHERE id = ?")
    .get(itemId) as { name: string; source_name: string | null };
}

const payload = (over: Record<string, string | number> = {}) =>
  fd({
    item_id: itemId,
    document_id: documentId,
    rxcui: CLEAN_RXCUI,
    name: CLEAN_NAME,
    ...over,
  });

const UNCHANGED = { name: PORTAL_NAME, source_name: null };

describe("the RxNorm re-check", () => {
  it("renames when RxNorm confirms the code answers to that name", async () => {
    // The control. Without it every refusal below would also pass against an action
    // that refused everything.
    await expect(adoptImportedMedicationName(payload())).resolves.toEqual({
      ok: true,
    });
    expect(storedRow()).toEqual({ name: CLEAN_NAME, source_name: PORTAL_NAME });
  });

  it("asks RxNorm about the STORED string, not the one the form carried", async () => {
    // The offer is built from the stored name, so the re-check has to be too: a form
    // naming a different string could otherwise carry a confirmation from a lookup
    // nobody ever ran against this row.
    await adoptImportedMedicationName(payload());
    expect(rxnav.asked[0]).toContain(encodeURIComponent(PORTAL_NAME));
  });

  // The shapes a bad day actually produces. Each must REFUSE and leave the row as
  // the import wrote it — "the network was down" is not a reason to accept an
  // unverified name onto a medicine. (Everywhere else in this feature an absent
  // lookup degrades silently, because everywhere else it costs only a missing code.)
  const REFUSALS: [string, () => void][] = [
    [
      "a name that code does not answer to",
      () => {
        rxnav.body = approximateTerm([
          { rxcui: CLEAN_RXCUI, name: "Something else entirely" },
        ]);
      },
    ],
    [
      "the right name under a different code",
      () => {
        rxnav.body = approximateTerm([{ rxcui: "1234", name: CLEAN_NAME }]);
      },
    ],
    [
      "an empty concept list",
      () => {
        rxnav.body = approximateTerm([]);
      },
    ],
    [
      "an empty object",
      () => {
        rxnav.body = {};
      },
    ],
    [
      "a null body",
      () => {
        rxnav.body = null;
      },
    ],
    [
      "a body from some other endpoint",
      () => {
        rxnav.body = { relatedGroup: { conceptGroup: [] } };
      },
    ],
    [
      "a 503",
      () => {
        rxnav.status = 503;
      },
    ],
    [
      "a body that is not JSON at all",
      () => {
        rxnav.unparseable = true;
      },
    ],
    [
      "no network",
      () => {
        rxnav.throws = true;
      },
    ],
  ];

  for (const [what, arrange] of REFUSALS) {
    it(`refuses ${what}, and the row is untouched`, async () => {
      arrange();
      const res = await adoptImportedMedicationName(payload());
      expect(res.ok).toBe(false);
      expect(storedRow()).toEqual(UNCHANGED);
    });
  }
});

describe("what the action refuses before it looks anything up", () => {
  it("refuses a row this profile's document did not produce", async () => {
    // The document id is the offer's own provenance: an offer rendered on one
    // document can never rename another's row. Asserted here as well as in the DB
    // tier because the action is where a forged id would arrive.
    const otherDoc = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'other.ccd', '', 'done', 'ccd')`
        )
        .run(profileId).lastInsertRowid
    );
    const res = await adoptImportedMedicationName(
      payload({ document_id: otherDoc })
    );
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual(UNCHANGED);
    expect(rxnav.asked).toEqual([]);
  });

  it("refuses an rxcui that is not the shape a code takes", async () => {
    const res = await adoptImportedMedicationName(payload({ rxcui: "abc" }));
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual(UNCHANGED);
    expect(rxnav.asked).toEqual([]);
  });
});
