// THE DEVICE WIPE, in one place, because more than one affordance signs this device out.
//
// Wiping this device's PHI is something only a DOCUMENT ON THIS DEVICE can do: the
// stores are IndexedDB and localStorage, and a Server Action that destroys a session row
// has no reach into either. So every affordance that ends this device's session has to
// perform the wipe itself, and this module is what they all call — components/SidebarContent
// (Log out) and app/(app)/settings/family/FamilyManager (delete your own login, sign your
// own login out of every device, reset your own password).
//
// WHAT IS NOT HERE, deliberately: any wipe triggered by a session that ended somewhere
// ELSE. An admin revoking a phone that is in a drawer, "Sign out everywhere else" aimed at
// a laptop across town — those devices are not running this code, learn nothing until they
// next reach the server, and what they get then is a 401 that looks exactly like ordinary
// expiry. Wiping on a bare 401 would evaporate the offline record for someone who simply
// came back tomorrow, which is the case this whole feature exists for. That fork is #3053.

import { clearEmergencyPayload } from "@/components/emergency-offline";
import { clearQueue } from "@/lib/offline/queue-db";
import { reopenForFailedLogout } from "@/lib/offline/write-gate";

// How long the wipe may take before the person is let go anyway.
//
// A wedged or blocked IndexedDB must never trap someone in a session they asked to leave.
// The server-side sign-out is what actually ends the session and it is not optional, so if
// the wipe cannot finish in time the sign-out still proceeds and the next authenticated
// visit's identity check wipes what is left.
const WIPE_BUDGET_MS = 2_000;

// How long the probe may take before its answer stops being worth waiting for.
//
// A DEAD LINK AND A FLAKY ONE ARE DIFFERENT FAILURES, and only the first is fast. A
// refused connection rejects immediately; a link that accepts the connection and then
// stops carrying it sits for the browser's own connect/read timeout, which is minutes.
// Everything downstream waits behind that: the undo does not run, and the rethrow that
// puts the person on the error boundary does not happen either — so the gate is shut,
// the screen is unchanged, and there is no feedback at all, in exactly the no-signal case
// this recovery exists for. The bound fails in the right direction: abort → catch →
// "not gone" → the undo runs (see R-A5 in e2e/offline-write-gate.spec.ts, which hangs the
// probe and watches the gate re-open anyway).
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Wipe this device's PHI and CLOSE THE DEVICE WRITE GATE.
 *
 * Three stores go: the emergency card copy (#42, localStorage — synchronous, which is why
 * that race never showed before), any queued offline writes plus their dead-letter entries
 * and form drafts (#28/#475/#1699), and the offline read snapshots (#2908). `clearQueue`'s
 * own transaction covers the snapshot store too, so the wipe holds even if a call site
 * drifts.
 *
 * The gate closing IN THE SAME TRANSACTION is the half that a wipe alone cannot do. The
 * document stays mounted, authenticated and interactive while the sign-out is in flight,
 * and that window admitted four different re-writes — a refresh already running, a refresh
 * that STARTS after the wipe and is answered 200 by a session that has not ended yet, the
 * same thing from another TAB, and a queue flush's retry write landing late. The gate lives
 * in the database the writes land in, is read inside each write's own transaction, and
 * stays closed until a DIFFERENT session opens it.
 */
export async function wipeDeviceForSignOut(): Promise<void> {
  clearEmergencyPayload();
  try {
    await Promise.race([
      clearQueue(),
      new Promise((resolve) => setTimeout(resolve, WIPE_BUDGET_MS)),
    ]);
  } catch {
    /* the sign-out is not conditional on the wipe succeeding */
  }
}

/**
 * Has the server ENDED this session? The only answer that keeps the write gate closed
 * after a sign-out attempt that did not obviously succeed.
 *
 * `?probe` on the snapshots route, which is the app's one cookie-authoritative GET —
 * `getCurrentSession()` rather than the coarse middleware cookie check — and answers the
 * auth question without building or returning a single payload. Only a positive 401/403
 * counts: any other status, any network failure, and the timeout above leave the
 * session's fate unknown, and unknown must not brick the device.
 */
export async function sessionEndedOnServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/offline-snapshots?probe=1", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * Take the close back off — but only when the server has NOT said this session is gone.
 *
 * The wipe closes the gate BEFORE the request that justifies it has landed, which is what
 * makes the sign-out window safe and is also a bet. When the request never lands (no
 * signal, which is this app's own subject matter, or a 5xx mid-deploy) the session is still
 * alive with its gate shut, and `openSessionAs` refuses to re-open for the session that
 * closed it — so the device would stay shut for the rest of that session: the write queue
 * stopped capturing while a dose tap still toasted "saved offline", drafts stopped saving,
 * snapshots stopped refreshing.
 *
 * UNREACHABLE COUNTS AS "NOT GONE", which is a TRADE and not a proof — see the long note at
 * `submitLogout` in components/SidebarContent.tsx for the case it gets wrong and why the
 * default stays this way round.
 */
export async function reopenUnlessSessionEnded(): Promise<void> {
  if (!(await sessionEndedOnServer())) await reopenForFailedLogout();
}

/**
 * Take the close back off with NO probe, for the one case where the server has already
 * said in words that it did not end the session: an action that RETURNED A VALUE where
 * success would have redirected (a refused `deleteLogin`). A returned value means the
 * request reached the server, the server decided, and the decision was "no" — the session
 * is alive, and asking a probe the same question could only re-derive that more slowly and
 * less reliably.
 */
export async function reopenAfterRefusedSignOut(): Promise<void> {
  await reopenForFailedLogout();
}
