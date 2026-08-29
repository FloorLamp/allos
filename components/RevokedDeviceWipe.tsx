"use client";

import { useEffect } from "react";
import { wipeDeviceForSignOut } from "@/components/device-wipe";

// WHERE A REVOKED DEVICE ACTUALLY ARRIVES (#3053).
//
// Every offline component is mounted inside the (app) layout, and a device whose session
// was ended elsewhere never renders that layout again — `requireSession` bounces it to
// /login. So the only affordance that could have heard the answer belonged to a session
// that no longer exists, which is the mechanism behind the issue's reproduction.
//
// /login is where the device lands, and the server answers there with no request at all:
// it holds the stale cookie, and lib/auth's `sessionDenial` says whether that exact token
// was REVOKED or merely lapsed. Only the first mounts this.
//
// It wipes through the SAME DOOR every sign-out uses — no second perimeter — which is
// also what closes the WRITE half: the gate shuts in the same transaction as the clear,
// and stays shut until a DIFFERENT session opens it (the next real login does).
//
// Idempotent, and it has to be: the stale cookie survives until the next sign-in, so this
// mounts on every /login render until then.
export default function RevokedDeviceWipe() {
  useEffect(() => {
    void wipeDeviceForSignOut();
  }, []);
  return null;
}
