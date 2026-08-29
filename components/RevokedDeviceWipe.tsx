"use client";

import { useEffect } from "react";
import { wipeDeviceForSignOut } from "@/components/device-wipe";

// WHERE A REVOKED DEVICE ACTUALLY ARRIVES (#3053).
//
// Every offline component — the queue provider, the snapshot refresher, the write gate's
// re-open — is mounted inside the (app) layout, and a device whose session was ended
// elsewhere never renders that layout again: `requireSession` bounces it to /login. So the
// only affordance that could hear the answer was one belonging to a session that no longer
// exists. That is the mechanism behind the issue's reproduction, where the health record
// was still on the phone after the app had already bounced.
//
// /login is where the device lands, and the server can answer the question there without a
// request at all: it holds the stale cookie, and lib/auth's `sessionDenial` says whether
// that exact token was REVOKED or merely lapsed. Only the first mounts this.
//
// IT WIPES THROUGH THE SAME DOOR EVERY SIGN-OUT USES — no second perimeter, no partial
// wipe: the emergency card, the write queue and its dead letters, the form drafts, the read
// snapshots, and the device write gate closed in the same transaction as the clear. The
// gate is what closes the WRITE half of #3053: the device stops accepting drafts and
// intents under the destroyed session, and stays closed until a DIFFERENT session opens it,
// which the next real login does.
//
// Idempotent by construction, which matters because the stale cookie survives until the
// next sign-in and this therefore mounts on every /login render until then: clearing an
// empty store and re-closing a closed gate both cost two IndexedDB opens and change
// nothing.
export default function RevokedDeviceWipe() {
  useEffect(() => {
    void wipeDeviceForSignOut();
  }, []);
  return null;
}
