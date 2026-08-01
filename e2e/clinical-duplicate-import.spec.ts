import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// Issue #1780: one person reachable through TWO portal logins imported their records
// twice. The portal regenerates its export container on every request, so the two
// archives differ byte for byte and by content hash while every clinical entry inside
// carries the same source-minted id — both uploaded as `stored`, both extracted, and the
// profile ended up with every encounter attested twice.
//
// This drives the real upload form with two such archives and asserts the three things a
// person actually experiences: their records did not double, the second upload is
// accounted for rather than silently swallowed, and Data → Review says so in words that
// do not read as a failure.
//
// FIXTURE OWNERSHIP (#868): the spec owns both documents and every row they import,
// keyed on entry ids no seed uses, and tears them down afterwards — so a --repeat-each
// iteration starts from the same empty state and the shared Review feed / badge counts
// other specs assert are left as they were.

const DB_PATH = workerDbPath();

const FIRST_NAME = "e2e-1780-portal-login-a.xml";
const SECOND_NAME = "e2e-1780-portal-login-b.xml";

// Entry ids no seed mints, so the rows this spec creates are unambiguously its own.
const VISIT_A = "770001780";
const VISIT_B = "770002780";

// One portal collection. `stamp` stands in for the per-request packaging a portal
// regenerates every time, so two calls differ byte for byte with identical clinical
// content — exactly what defeats the content hash. Synthetic throughout: no patient
// element at all, low-entropy values, deep-past dates.
function archive(stamp: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="${VISIT_A}"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190402"/></effectiveTime>
      </encounter></entry>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="${VISIT_B}"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190815"/></effectiveTime>
      </encounter></entry>
    </section></component>
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
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`);
}

interface DocRow {
  id: number;
  filename: string;
  status: string;
  error: string | null;
  stored_path: string | null;
  content_hash: string | null;
  clinical_key: string | null;
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function specDocs(): DocRow[] {
  return withDb(
    (db) =>
      db
        .prepare(
          `SELECT id, filename, extraction_status AS status, extraction_error AS error,
                  stored_path, content_hash, clinical_key
             FROM medical_documents WHERE filename IN (?, ?) ORDER BY id`
        )
        .all(FIRST_NAME, SECOND_NAME) as DocRow[]
  );
}

// The rows this spec's entry ids back, counted across the two tables its sections write.
// Keyed on the entry ids, never on a profile-wide total, so the seeded world's own
// encounters and labs are irrelevant to the assertion.
function specRowCounts(): { encounters: number; records: number } {
  return withDb((db) => ({
    encounters: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM encounters
            WHERE external_id LIKE '%ccda:encounter:' || ?
               OR external_id LIKE '%ccda:encounter:' || ?`
        )
        .get(VISIT_A, VISIT_B) as { n: number }
    ).n,
    records: (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM medical_records
             WHERE document_id IN (
               SELECT id FROM medical_documents WHERE filename IN (?, ?)
             )`
        )
        .get(FIRST_NAME, SECOND_NAME) as { n: number }
    ).n,
  }));
}

function cleanup(): void {
  withDb((db) => {
    const ids = (
      db
        .prepare("SELECT id FROM medical_documents WHERE filename IN (?, ?)")
        .all(FIRST_NAME, SECOND_NAME) as { id: number }[]
    ).map((r) => r.id);
    for (const id of ids) {
      db.prepare("DELETE FROM encounters WHERE document_id = ?").run(id);
      db.prepare("DELETE FROM medical_records WHERE document_id = ?").run(id);
    }
    db.prepare("DELETE FROM medical_documents WHERE filename IN (?, ?)").run(
      FIRST_NAME,
      SECOND_NAME
    );
  });
}

async function uploadArchive(
  page: import("@playwright/test").Page,
  name: string,
  buffer: Buffer
): Promise<void> {
  await page.goto("/data?section=import");
  const input = page.getByTestId("medical-upload-input");
  await input.setInputFiles({
    name,
    mimeType: "application/xml",
    buffer,
  });
  const submit = page.getByTestId("medical-upload-submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText("Upload received")).toBeVisible();
}

test.describe("two portal collections of one person's records (#1780)", () => {
  test.beforeEach(() => cleanup());
  test.afterAll(() => cleanup());

  test("the second archive does not double the records, and Review says why", async ({
    page,
  }) => {
    const first = archive("20260101090000");
    const second = archive("20260714113000");
    // The premise: a portal never hands back the same bytes twice.
    expect(second.equals(first)).toBe(false);

    await uploadArchive(page, FIRST_NAME, first);
    // A CCD is parsed deterministically and inline, so the row settles without an
    // extractor — poll the DB rather than the clock.
    await expect
      .poll(() => specDocs().find((d) => d.filename === FIRST_NAME)?.status)
      .toBe("done");
    expect(specRowCounts()).toEqual({ encounters: 2, records: 2 });

    await uploadArchive(page, SECOND_NAME, second);
    await expect.poll(() => specDocs().length).toBe(2);

    // 1. The records did NOT double — the whole point of the issue.
    expect(specRowCounts()).toEqual({ encounters: 2, records: 2 });

    // 2. The accounting says what happened: a file-less 'skipped' marker whose reason
    //    names the document that already holds the records, recognized by the CLINICAL
    //    key while the byte hashes genuinely differ.
    const [held, marker] = specDocs();
    expect(marker.status).toBe("skipped");
    expect(marker.stored_path).toBe("");
    expect(marker.error).toContain("Duplicate records");
    expect(marker.error).toContain(FIRST_NAME);
    expect(marker.clinical_key).toBe(held.clinical_key);
    expect(marker.content_hash).not.toBe(held.content_hash);

    // 3. Review shows it honestly — as a duplicate that stored nothing, not as a bare
    //    "skipped" that reads like a failure. Scoped to this spec's own row.
    await page.goto("/data?section=review");
    const feed = page.getByTestId("import-feed");
    const row = feed.locator("li").filter({ hasText: SECOND_NAME });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("duplicate — nothing imported");

    // The document that DOES hold the records still reads as a real import beside it.
    await expect(
      feed.locator("li").filter({ hasText: FIRST_NAME })
    ).toContainText("items");
  });
});
