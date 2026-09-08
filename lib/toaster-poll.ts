// Background actors observe job state through JSON route handlers and request
// page updates separately through useChromeRefresh. Polling continues while the
// dirty-form registry defers the update. A read Server Action is not equivalent:
// session-cookie writes can cause its response to include updated page data.
// See docs/internals/server-action-refresh.md for refresh and cookie policy.
//
// HTTP, shape, and profile failures preserve the caller's previous job state.
// Treating a failed observation as an empty list would lose that seed and could
// announce completed jobs again on the next successful poll.

/** The endpoints the two completion toasters poll. Route handlers, never actions. */
export const IMPORT_JOB_STATES_ENDPOINT = "/api/jobs/imports";
export const EXTRACTION_STATES_ENDPOINT = "/api/jobs/extractions";

/**
 * Lightweight per-job status snapshot for the import toaster — enough to detect a
 * processing → ready/failed transition and to word the toast, and nothing more
 * (no `result_json`, no filenames beyond the summary the user already saw).
 */
export interface ImportJobState {
  id: number;
  status: string;
  summary: string | null;
  error: string | null;
}

/** Per-document extraction status snapshot for the medical-document toaster. */
export interface ExtractionState {
  id: number;
  filename: string;
  status: string;
  count: number;
  error: string | null;
}

/**
 * What one poll saw. A refusal is NOT an empty result: the caller must keep its
 * seed untouched and retry, or it will re-announce every finished job.
 */
export type PollObservation<T> =
  | { ok: true; states: T[] }
  /** `profile` — the answer belongs to a different active profile. */
  | { ok: false; reason: "http" | "shape" | "profile" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

export function isImportJobState(v: unknown): v is ImportJobState {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "number" &&
    typeof v.status === "string" &&
    isNullableString(v.summary) &&
    isNullableString(v.error)
  );
}

export function isExtractionState(v: unknown): v is ExtractionState {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "number" &&
    typeof v.filename === "string" &&
    typeof v.status === "string" &&
    typeof v.count === "number" &&
    isNullableString(v.error)
  );
}

/**
 * THE decision, pure: turn an HTTP status plus an already-parsed body into an
 * observation. Anything that is not a 200 carrying
 * `{ ok: true, profileId, states: [...] }` for the expected profile and with
 * well-formed rows is a refusal — including a 200 whose body failed to parse as
 * JSON at all, which the caller passes in as `undefined`.
 */
export function readStatesEnvelope<T>(
  status: number,
  body: unknown,
  expectedProfileId: number,
  isState: (v: unknown) => v is T
): PollObservation<T> {
  if (status !== 200) return { ok: false, reason: "http" };
  if (!isRecord(body) || body.ok !== true)
    return { ok: false, reason: "shape" };
  if (typeof body.profileId !== "number") return { ok: false, reason: "shape" };
  if (body.profileId !== expectedProfileId)
    return { ok: false, reason: "profile" };
  const { states } = body;
  if (!Array.isArray(states)) return { ok: false, reason: "shape" };
  if (!states.every(isState)) return { ok: false, reason: "shape" };
  return { ok: true, states: states as T[] };
}

/**
 * The thin impure wrapper the toasters call: one fetch, one `readStatesEnvelope`.
 * Every way this can go wrong — offline, 401 after a session lapsed, a body that
 * is not the envelope — comes back as the same typed refusal, so a poll loop has
 * exactly one failure branch to write.
 */
export async function observeStates<T>(
  endpoint: string,
  expectedProfileId: number,
  isState: (v: unknown) => v is T
): Promise<PollObservation<T>> {
  let status: number;
  let body: unknown;
  try {
    // `no-store`: this is a liveness question, and a cached answer is a wrong one.
    const res = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    status = res.status;
    body = await res.json().catch(() => undefined);
  } catch {
    return { ok: false, reason: "http" };
  }
  return readStatesEnvelope(status, body, expectedProfileId, isState);
}
