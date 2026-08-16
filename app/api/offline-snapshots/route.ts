import { getCurrentSession } from "@/lib/auth";
import { getOfflineSnapshotsEnabled } from "@/lib/settings";
import { now } from "@/lib/clock";
import {
  buildSnapshots,
  snapshotContext,
} from "@/lib/offline/snapshot-build";
import {
  SNAPSHOT_KINDS,
  type SnapshotKind,
} from "@/lib/offline/snapshots";

// The refresh endpoint for the offline read snapshots (issue #2908). The browser
// (components/OfflineSnapshotRefresher) GETs it on an online, authenticated visit when
// something it holds is absent or past its clock, and stores the result in IndexedDB
// beside the write queue.
//
// AUTH — a ROUTE HANDLER, not a Server Action, authenticated exactly as
// /api/offline-replay is: cookie-authoritative getCurrentSession(), never the coarse
// middleware cookie-presence check. No session → 401 and the device keeps whatever it
// already holds; a lapsed cookie must not wipe a med list someone is standing in a
// clinic reading. (The WIPE is an identity CHANGE — logout, a profile switch — not a
// failed request.)
//
// PROFILE SCOPING — the snapshots are built for the session's ACTIVE profile and for no
// other. There is no profile parameter, deliberately: a caller-supplied id is a second
// authorization surface for a feature whose whole risk is cross-profile leakage, and
// the device only ever holds one profile's snapshots anyway. `session.profile` is
// already re-derived against current grants by resolveSessionToken, so a grant revoked
// while a tab sat open cannot refresh that profile onto the device one more time. The
// response names the profile it is for, and the client refuses to store a body whose
// profileId is not the one it asked as.
//
// SERVICE WORKER — public/sw.js passes every non-navigation request straight through to
// the network and never caches it, so this route is untouched by it: the snapshots are
// APPLICATION-LAYER storage the app wrote deliberately, not HTTP cache the worker
// accumulated. That distinction is the whole reason components/emergency-offline.ts:11
// gives for using localStorage over the SW cache, and it holds here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseKinds(param: string | null): SnapshotKind[] {
  if (!param) return [...SNAPSHOT_KINDS];
  const asked = new Set(param.split(",").map((s) => s.trim()));
  const known = SNAPSHOT_KINDS.filter((k) => asked.has(k));
  // An unknown kind is ignored rather than rejected: a device running an older build
  // may ask for a kind this build renamed, and refusing the whole request would strand
  // it with no snapshots at all until it reloads.
  return known.length > 0 ? [...known] : [...SNAPSHOT_KINDS];
}

export async function GET(req: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }
  const { profile, login } = session;
  if (!getOfflineSnapshotsEnabled(profile.id)) {
    // The off switch is HONEST (the acceptance criterion): the server hands back
    // nothing AND says so, and the client wipes on reading it — so a profile toggled
    // off on another device stops having payloads on this one at its next visit, not
    // just at the moment of the toggle.
    return Response.json({
      ok: true,
      enabled: false,
      profileId: profile.id,
      snapshots: [],
    });
  }
  const kinds = parseKinds(new URL(req.url).searchParams.get("kinds"));
  const ctx = snapshotContext(profile.id, login.id);
  return Response.json({
    ok: true,
    enabled: true,
    profileId: profile.id,
    snapshots: buildSnapshots(ctx, now(), kinds),
  });
}
