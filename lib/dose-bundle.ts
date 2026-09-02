// THE COMPOSED DOSE WRITE, AS A FACT (#4328).
//
// A person's own `intake_items.stack` label (#3098) says WHICH doses go together — it is
// the identity, and every surface that names a group already reads it. This module is
// the other half: the EVENT. One value, minted once per composed action and stamped on
// every `intake_item_logs` row that action writes, so a reader can tell "one tap took
// these four" from "four taps happened to land in one minute".
//
// The Day ledger used to answer that question by inference — same routine, same bucket,
// same write minute — and got it wrong in the one way nobody could see: two independent
// taps a second apart read as one composed row. The inference is gone; this is what
// replaced it.
//
// MINTED HERE AND NOWHERE ELSE, which is the whole reason the type is branded. A bundle
// id is not a string a caller may compose from something it already has: reusing a dose
// id, a minute, or a routine name would re-create the guess in a place that looks like a
// record. `newDoseBundle()` is the only door, so the wrong value cannot be spelled.
import { randomBytes } from "node:crypto";

/** One composed action's identity. Opaque, fixed-width, and only ever compared. */
export type DoseBundleId = string & { readonly __doseBundle: unique symbol };

/** A fresh bundle for ONE composed action — call once per action, not once per row. */
export function newDoseBundle(): DoseBundleId {
  return randomBytes(8).toString("hex") as DoseBundleId;
}
