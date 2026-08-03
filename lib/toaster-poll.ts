// How a background poller OBSERVES (issue #1878) — over HTTP, never through a
// Server Action.
//
// ── THE RESIDUAL THIS CLOSES ────────────────────────────────────────────────
//
// #1925 made chrome-initiated `router.refresh()` defer while a record form holds
// unsaved input (lib/dirty-forms.ts). It did not — could not — gate the OTHER way
// a chrome tick repaints the page: the completion toasters observed by CALLING A
// SERVER ACTION, and a Server Action's response carries a freshly rendered tree
// that Next's router applies with no `router.refresh()` anywhere in it. Measured
// on the real app before this change: a row inserted behind the page appeared
// while the registry read `data-owed=1, data-refreshes=0` — the explicit refresh
// was correctly deferred and the repaint arrived anyway, through the poll.
//
// ── WHY EVERY ACTION IN THIS APP DOES THAT, INCLUDING A PURE READ ───────────
//
// Next skips the page re-render for an action that did not revalidate
// (`server/app-render/action-handler.js` → `skipPageRendering`), so "the poll
// calls a read action, and a read action does not revalidate" looked like
// protection. It is not, here: `middleware.ts` slides the session cookie on every
// request — action POSTs included — and Next records a cookie mutation as a
// revalidation (`spec-extension/adapters/request-cookies.js` sets
// `pathWasRevalidated`). So EVERY action response in this app carries a full page
// render, and every action call repaints. That is a property of the app, not of
// the action, which is exactly why the fix cannot be "make the action not
// revalidate".
//
// ── THE SEPARATION ─────────────────────────────────────────────────────────
//
// Observation and repaint are two different things and only the repaint may wait.
// A `fetch` of a route handler cannot carry an RSC tree, so the poll keeps
// observing at full cadence — the toast still says "your import finished" the
// moment it does — while the tree repaint is left to `useChromeRefresh()`, the
// ONE mechanism the dirty-form registry gates. There is deliberately no second
// "should I poll" flag: the owed/drain accounting in lib/dirty-forms.ts is the
// only place that knows a repaint is pending.
//
// ── WHY A PARSER, AND NOT JUST `await res.json()` ──────────────────────────
//
// Calling a Server Action gave the client a typed value or an exception. A fetch
// can also succeed at the HTTP level while returning something else entirely — a
// 401 envelope, a proxy's error page, a login redirect followed to HTML. Reading
// any of those as "the profile has no jobs" would replace the toaster's seed with
// an empty map, and the next successful poll would re-announce every finished job
// as freshly finished (#296, the same failure the transient-error path already
// guards). So a failed observation is a TYPED refusal the caller retries, never
// an empty result set.

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
  /** `http` — the response was not a 200. `shape` — a 200 that was not the envelope. */
  | { ok: false; reason: "http" | "shape" };

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
 * observation. Anything that is not a 200 carrying `{ ok: true, states: [...] }`
 * of well-formed rows is a refusal — including a 200 whose body failed to parse
 * as JSON at all, which the caller passes in as `undefined`.
 */
export function readStatesEnvelope<T>(
  status: number,
  body: unknown,
  isState: (v: unknown) => v is T
): PollObservation<T> {
  if (status !== 200) return { ok: false, reason: "http" };
  if (!isRecord(body) || body.ok !== true)
    return { ok: false, reason: "shape" };
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
  return readStatesEnvelope(status, body, isState);
}
