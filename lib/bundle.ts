// THE COMPOSED WRITE, AS A FACT (#4328, generalised by #5082).
//
// One value, minted once per composed action and stamped on every row that action
// writes, in every table it touches — so a reader can tell "one tap took these four"
// from "four taps happened to land in one minute". The usual tap's servings and its
// dose confirms carry the SAME id, because they were one act.
//
// The Day ledger used to answer that question by inference — same routine, same bucket,
// same write minute — and got it wrong in the one way nobody could see: two independent
// taps a second apart read as one composed row. The inference is gone; this is what
// replaced it.
//
// A SINGLE WRITE NEVER MINTS. A row with no bundle means "stated on its own", and that
// is the reading every surface already depends on. Nothing infers a bundle, here or
// downstream: composition is RECORDED (lib/day-ledger.ts) or it is not claimed.
//
// MINTED HERE. A bundle id is not a string a caller may compose from something it
// already has: reusing a dose id, a minute, or a routine name would re-create the guess
// in a place that looks like a record. `newBundle()` is the door to use.
//
// THE BRAND DOES NOT CLOSE THE OTHER DOORS, and neither does the guard, so read call
// sites rather than trusting either. `BundleId` is `string & { __bundle }`: any
// `as BundleId` cast spells one. lib/__tests__/one-bundle-mint.test.ts catches three
// shapes — the retired dose-only mint name coming back, a second `function newBundle`
// declaration, and a file naming `BundleId` alongside `randomBytes`/`randomUUID` (that
// test spells the retired name; this file must not, or it reports itself). It misses
// a dose id or a write minute cast to the brand, `Math.random` as the source, and an
// alias such as `export const mintBundle = newBundle`. Those a reviewer has to see.
import { randomBytes } from "node:crypto";

/** One composed action's identity. Opaque, fixed-width, and only ever compared. */
export type BundleId = string & { readonly __bundle: unique symbol };

/** A fresh bundle for ONE composed action — call once per action, not once per row. */
export function newBundle(): BundleId {
  return randomBytes(8).toString("hex") as BundleId;
}
