import { getPracticeLedgerPage } from "./queries/wellness";

type Thing = { id: string; url: string };

async function habitatThings(): Promise<Map<string, Thing>> {
  const things = new Map<string, Thing>();
  const { HABITAT_URL, HABITAT_TOKEN } = process.env;
  if (!HABITAT_URL || !HABITAT_TOKEN) return things;
  try {
    const response = await fetch(
      `${HABITAT_URL.replace(/\/$/, "")}/v1/entities`,
      {
        headers: { Authorization: `Bearer ${HABITAT_TOKEN}` },
        signal: AbortSignal.timeout(3000),
        cache: "no-store",
      }
    );
    if (!response.ok) return things;
    const entities: unknown = await response.json();
    if (!Array.isArray(entities)) return things;
    for (const entity of entities) {
      const id = entity?.attributes?.thing_id;
      if (
        typeof entity?.id === "string" &&
        typeof id === "string" &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
      )
        things.set(entity.id, { id, url: `/things#${id}` });
    }
  } catch {
    // Habitat is optional; its outage must not hide the practice ledger.
  }
  return things;
}

export async function devicePractices(profileId: number) {
  const { rows } = getPracticeLedgerPage(
    profileId,
    "0001-01-01",
    {},
    1,
    2147483647
  );
  const entityFor = (key: string) => /^habitat:([^:]+):.+$/.exec(key)?.[1];
  const things = rows.some(
    (row) => row.external_id && entityFor(row.external_id)
  )
    ? await habitatThings()
    : new Map<string, Thing>();
  return rows.map((row) => {
    const key = row.external_id ?? `practice:${row.id}`;
    const entity = entityFor(key);
    const thing = entity ? things.get(entity) : undefined;
    return {
      key,
      name: row.practice,
      logged: row.date,
      ...(thing ? { thing } : {}),
    };
  });
}
