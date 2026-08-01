// The identity bar's ONE computation (issue #1801).
//
// Three surfaces used to answer "whose data is on screen?" their own way: the
// sidebar profile menu (acting profile only), the view strip (in-view profiles,
// acting marked with a badge) and the contextual destination chips. #1801
// collapses the first two into ONE identity bar, and this module is the engine
// behind it — pure, so the bar, its tests and any future surface that needs the
// same answer share a single derivation rather than each re-deciding what
// "acting first" and "+N more" mean.
//
// The SAFETY rule this encodes (the reason it is not just a `filter`): the bar
// shows who is VISIBLE, but writes land on who is ACTING. So the acting profile
// is always index 0 of `ordered` — the ringed avatar and the emphasized name are
// positional, which makes "the first avatar is the acting profile" a structural
// property a browser test can pin rather than a styling convention.
//
// `viewIds` is the persisted, access-validated view-set (#1096, ProfileScope) —
// this module never widens it: a profile that is not in `profiles` cannot appear
// in the bar, and the acting profile is forced in even if a stale view-set
// somehow omitted it (toggleViewProfile already refuses to drop it server-side).

export interface IdentityProfile {
  id: number;
  name: string;
}

// How many names the line spells out before collapsing to "+N more". Two is the
// most a 390px phone bar can hold beside the avatar stack and the hamburger.
export const IDENTITY_NAMES_SHOWN = 2;
// How many avatars the stack renders. One more than the names, because an avatar
// costs a fixed ~20px of overlap while a name costs an unbounded string.
export const IDENTITY_AVATARS_SHOWN = 3;

export interface IdentityBarView<T extends IdentityProfile> {
  // Every in-view profile, ACTING FIRST, then the rest in their accessible order.
  ordered: T[];
  // The prefix of `ordered` the avatar stack renders.
  avatars: T[];
  // The name line: "Alice", "Alice, Bob", "Alice, Bob +2 more".
  nameLine: string;
  // The acting profile, always `ordered[0]`.
  acting: T;
  // Profiles beyond the named ones — 0 when the line names everyone.
  overflow: number;
}

// Derive the bar's whole visible state from the scope's three inputs. Returns
// null only when the acting profile is not in the accessible set, which the auth
// boundary already makes impossible — the caller renders nothing rather than a
// bar that cannot name who is acting.
export function identityBarView<T extends IdentityProfile>(
  profiles: readonly T[],
  viewIds: readonly number[],
  actingProfileId: number
): IdentityBarView<T> | null {
  const acting = profiles.find((p) => p.id === actingProfileId);
  if (!acting) return null;
  const wanted = new Set(viewIds);
  const rest = profiles.filter(
    (p) => p.id !== actingProfileId && wanted.has(p.id)
  );
  const ordered = [acting, ...rest];
  const named = ordered.slice(0, IDENTITY_NAMES_SHOWN);
  const overflow = ordered.length - named.length;
  const nameLine =
    overflow > 0
      ? `${named.map((p) => p.name).join(", ")} +${overflow} more`
      : named.map((p) => p.name).join(", ");
  return {
    ordered,
    avatars: ordered.slice(0, IDENTITY_AVATARS_SHOWN),
    nameLine,
    acting,
    overflow,
  };
}

// The bar's accessible name — it states the ACTING fact, not the view, because
// that is the fact a screen-reader user needs before tapping anything that
// writes (#1801 house rules; #1013's wrong-profile-write risk).
export function identityBarLabel(actingName: string): string {
  return `Acting as ${actingName} — switch profile`;
}
