"use client";

import { createContext, useContext } from "react";

// The session's active profile id, available to any client component (issue #1699).
//
// Device-local state that holds health data has to be keyed by the SUBJECT it
// belongs to — a form draft, above all: switching profiles must never surface
// another subject's half-typed entry. The layout already resolves the acting profile
// at the auth boundary and hands it to OfflineQueueProvider for exactly this reason
// (#599, stamping queued intents); this exposes the same value as ordinary context
// so a form deep in the tree doesn't need it threaded through as a prop.
//
// It is an IDENTIFIER FOR SCOPING, never an authorization: every write still goes
// through the Server Action's own gate.

const Ctx = createContext<number | null>(null);

export function ActiveProfileProvider({
  profileId,
  children,
}: {
  profileId: number;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={profileId}>{children}</Ctx.Provider>;
}

/**
 * The acting profile's id, or null outside the app shell (the auth routes, the
 * offline page). A null means device-local, profile-keyed features simply stay off
 * rather than guessing a subject.
 */
export function useActiveProfileId(): number | null {
  return useContext(Ctx);
}
