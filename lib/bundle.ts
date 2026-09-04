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
// MINTED HERE AND NOWHERE ELSE, which is the whole reason the type is branded. A bundle
// id is not a string a caller may compose from something it already has: reusing a dose
// id, a minute, or a routine name would re-create the guess in a place that looks like a
// record. `newBundle()` is the only door, so the wrong value cannot be spelled — and
// lib/__tests__/one-bundle-mint.test.ts fails if a second door is cut.
import { randomBytes } from "node:crypto";

/** One composed action's identity. Opaque, fixed-width, and only ever compared. */
export type BundleId = string & { readonly __bundle: unique symbol };

/** A fresh bundle for ONE composed action — call once per action, not once per row. */
export function newBundle(): BundleId {
  return randomBytes(8).toString("hex") as BundleId;
}
