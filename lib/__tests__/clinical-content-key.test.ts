import { describe, expect, it } from "vitest";
import {
  CLINICAL_KEY_MIN_IDS,
  clinicalContentKey,
  clinicalDuplicateMessage,
  clinicalKeyForInput,
  collectClinicalEntryIds,
} from "@/lib/clinical-content-key";
import {
  healthRecordToPersistInput,
  type PersistInput,
} from "@/lib/import-shape";
import { parseCcda } from "@/lib/cda";

// PURE TIER — the clinical identity of a health-record file (issue #1780).
//
// One person reachable through two portal logins imports their records twice: the portal
// regenerates its export container per request, so the two archives never share a content
// hash, while every clinical entry inside carries the same source-minted id. These pin the
// key that closes that gap — what goes into it, what must NOT change it, and the guard
// that keeps a near-empty parse from claiming an identity.

// An empty PersistInput with the shape the collector walks. Only the entity lists matter.
function emptyInput(): PersistInput {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
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
      docType: null,
      source: "ccda",
      documentDate: null,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  } as unknown as PersistInput;
}

// A PersistInput carrying just external_ids, per entity list.
function withIds(
  over: Partial<Record<keyof PersistInput, string[]>>
): PersistInput {
  const input = emptyInput();
  for (const [list, ids] of Object.entries(over)) {
    (input as unknown as Record<string, { external_id: string | null }[]>)[
      list
    ] = (ids as string[]).map((external_id) => ({ external_id }));
  }
  return input;
}

describe("collectClinicalEntryIds", () => {
  it("collects every entity list's source-minted ids, kind-prefixed", () => {
    const ids = collectClinicalEntryIds(
      withIds({
        encounters: ["ccda:encounter:900001"],
        records: ["ccda:obs:2093-3:2019-04-02:188"],
        conditions: ["ccda:condition:hypertension"],
      })
    );
    expect(ids).toEqual([
      "cnd:ccda:condition:hypertension",
      "enc:ccda:encounter:900001",
      "rec:ccda:obs:2093-3:2019-04-02:188",
    ]);
  });

  it("is order-independent and de-duplicating — a reshuffled or repeated export agrees", () => {
    const a = withIds({
      records: ["ccda:obs:a", "ccda:obs:b", "ccda:obs:c"],
    });
    const b = withIds({
      // Same three entries, walked in another order, with one repeated across sections.
      records: ["ccda:obs:c", "ccda:obs:a", "ccda:obs:b", "ccda:obs:c"],
    });
    expect(collectClinicalEntryIds(a)).toEqual(collectClinicalEntryIds(b));
    expect(clinicalKeyForInput(a)).toBe(clinicalKeyForInput(b));
  });

  it("prefixes by KIND so two different entity kinds sharing a raw id never collide", () => {
    const asEncounters = withIds({ encounters: ["x1", "x2", "x3"] });
    const asConditions = withIds({ conditions: ["x1", "x2", "x3"] });
    expect(clinicalKeyForInput(asEncounters)).not.toBe(
      clinicalKeyForInput(asConditions)
    );
  });

  it("ignores rows with no external_id — the AI path mints none", () => {
    const input = emptyInput();
    input.records = [
      { external_id: null },
      { external_id: "" },
    ] as unknown as PersistInput["records"];
    expect(collectClinicalEntryIds(input)).toEqual([]);
  });
});

describe("clinicalContentKey", () => {
  it("is NULL below the minimum-id floor — a near-empty parse claims no identity", () => {
    const tooFew = Array.from(
      { length: CLINICAL_KEY_MIN_IDS - 1 },
      (_, i) => `x${i}`
    );
    expect(clinicalContentKey(tooFew)).toBeNull();
    expect(clinicalContentKey([])).toBeNull();
  });

  it("is a stable digest at and above the floor", () => {
    const ids = Array.from({ length: CLINICAL_KEY_MIN_IDS }, (_, i) => `x${i}`);
    const key = clinicalContentKey(ids);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(clinicalContentKey([...ids])).toBe(key);
  });

  it("changes when the entry SET changes — a superset export is not the same records", () => {
    const four = ["a", "b", "c", "d"];
    expect(clinicalContentKey(four)).not.toBe(
      clinicalContentKey(["a", "b", "c"])
    );
  });
});

// The headline: two archives of the same visits, regenerated per request, differing in
// packaging and in a rendered narrative — different bytes, one clinical identity.
describe("two portal exports of one visit list", () => {
  const encounters = `
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="900001"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190402"/></effectiveTime>
      </encounter></entry>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="900002"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190815"/></effectiveTime>
      </encounter></entry>
    </section></component>`;
  const results = `
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"/>
          <effectiveTime value="20190402"/>
          <value type="PQ" value="188" unit="mg/dL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2085-9" codeSystem="2.16.840.1.113883.6.1" displayName="HDL Cholesterol"/>
          <effectiveTime value="20190402"/>
          <value type="PQ" value="61" unit="mg/dL"/>
        </observation></component>
      </organizer></entry>
    </section></component>`;

  // Same clinical sections; the packaging around them differs, exactly as a regenerated
  // container does. Synthetic throughout — fictional names, low-entropy values.
  function archive(stamp: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${encounters}
    ${results}
  </structuredBody></component>
</ClinicalDocument>`;
  }

  function keyOf(xml: string): string | null {
    return clinicalKeyForInput(
      healthRecordToPersistInput(parseCcda(xml), "ccda", "Health record")
    );
  }

  it("agrees on the clinical key while the bytes differ", () => {
    const first = archive("20260101090000");
    const second = archive("20260714113000");
    expect(second).not.toBe(first);
    const key = keyOf(first);
    expect(key).not.toBeNull();
    expect(keyOf(second)).toBe(key);
  });

  it("disagrees once one export carries an entry the other does not", () => {
    const base = archive("20260101090000");
    const extra = base.replace(
      "</structuredBody>",
      `<component><section>
        <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
        <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
        <title>Problems</title>
        <entry><act classCode="ACT" moodCode="EVN">
          <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
            <code code="55607006" codeSystem="2.16.840.1.113883.6.96"/>
            <statusCode code="completed"/>
            <effectiveTime><low value="20190402"/></effectiveTime>
            <value xsi:type="CD" code="59621000" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/>
          </observation></entryRelationship>
        </act></entry>
      </section></component></structuredBody>`
    );
    expect(keyOf(extra)).not.toBe(keyOf(base));
  });
});

describe("clinicalDuplicateMessage", () => {
  it("names the document that already holds the records", () => {
    expect(clinicalDuplicateMessage("export-june.zip")).toContain(
      '"export-june.zip"'
    );
    expect(clinicalDuplicateMessage("export-june.zip")).toMatch(
      /nothing new was stored/i
    );
  });
});
