// Curated-dataset framework — the ONE loader (issue #860 Track B).
//
// loadDataset() takes a raw parsed JSON value (a `import x from "./data/foo.json"`
// or any unknown) and returns a validated LoadedDataset, throwing DatasetError on any
// contract violation. This is the single place the envelope contract is enforced, so
// the linter and every consumer see the same guarantees. Pure — no DB, no fs.

import {
  DATASET_SCHEMA,
  DatasetError,
  type DatasetEnvelope,
  type LoadedDataset,
} from "./types";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validate + type a raw envelope. Checks, in order: object shape, the schema marker,
// a non-empty id/title, ≥1 citation each with a non-empty `source`, ≥1 identity key,
// an entries ARRAY, and — the load-bearing check — that EVERY entry actually carries
// EVERY declared identity key as a present, non-null value (an entry that can't be
// identified can't be matched or cited-to, so it's a hard error, not a warning).
export function loadDataset<E, M = undefined>(
  raw: unknown
): LoadedDataset<E, M> {
  if (!isObject(raw)) {
    throw new DatasetError("dataset must be a JSON object");
  }
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new DatasetError("dataset is missing a non-empty `id`");
  }
  const where = `dataset "${String(id)}"`;
  if (raw.$schema !== DATASET_SCHEMA) {
    throw new DatasetError(
      `${where} must set "$schema": "${DATASET_SCHEMA}" (got ${JSON.stringify(
        raw.$schema
      )})`
    );
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new DatasetError(`${where} is missing a non-empty \`title\``);
  }
  if (!Array.isArray(raw.citation) || raw.citation.length === 0) {
    throw new DatasetError(`${where} must carry at least one citation`);
  }
  for (const [i, c] of raw.citation.entries()) {
    if (
      !isObject(c) ||
      typeof c.source !== "string" ||
      c.source.trim() === ""
    ) {
      throw new DatasetError(
        `${where} citation[${i}] must have a non-empty \`source\``
      );
    }
  }
  if (
    !isObject(raw.identity) ||
    !Array.isArray(raw.identity.keys) ||
    raw.identity.keys.length === 0 ||
    !raw.identity.keys.every((k) => typeof k === "string" && k.trim() !== "")
  ) {
    throw new DatasetError(
      `${where} must declare \`identity.keys\` with at least one non-empty string`
    );
  }
  if (!Array.isArray(raw.entries)) {
    throw new DatasetError(`${where} must have an \`entries\` array`);
  }
  const keys = raw.identity.keys as string[];
  for (const [i, e] of raw.entries.entries()) {
    if (!isObject(e)) {
      throw new DatasetError(`${where} entry[${i}] must be an object`);
    }
    for (const k of keys) {
      const v = e[k];
      if (
        v === undefined ||
        v === null ||
        (typeof v === "string" && v === "")
      ) {
        throw new DatasetError(
          `${where} entry[${i}] is missing identity key \`${k}\``
        );
      }
    }
  }
  return raw as unknown as DatasetEnvelope<E, M>;
}
