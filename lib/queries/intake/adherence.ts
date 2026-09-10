// The intake dose ledger's facade (#319, split by #2960).
//
// This file used to BE the ledger: 1,705 code lines, 55 exports and ~57 prepared
// statements covering everything from a check-off to a time correction. Rule #5670
// says a change into a file that big has to leave it smaller, and the issue's own
// non-goals rule out inventing new dose semantics to get there — so each
// responsibility moved out WHOLE, under its own header, and nothing else changed.
//
// What is left is the import surface. `@/lib/queries/intake/adherence` and the
// `lib/queries/intake` barrel above it still export every name they did before, so no
// call site, no test import and no `*Declares` core declaration had to move with the
// code. Read the module you want; this list is the map.
//
//   dose-status ............ where a scheduled dose stands, and the ONE core that
//                            moves it (taken / skipped / cleared)
//   administrations ........ the ONE PRN + historical administration write path
//   administration-delete .. the undoable delete and its restore
//   dose-history ........... what was already taken: day lists, history, the ledger
//   redose-reads ........... redose notice, family arming, over-max — safety verdicts
//   prn-quick-log .......... the one-tap PRN gather each surface offers from
//   callback-reads ......... the profile-scoped lookups a notification tap is
//                            checked against
//   dose-time-correction ... the "wrong time?" offer and the one restamp core
//
// `no-rearm` is the one module NOT re-exported here: it holds the rule the two
// un-marking writers share, it was never public, and it stays internal.
//
// The profile-scoping guard walks all of lib/, so every module above stays covered;
// each read is profile-scoped directly or through the parent intake_items JOIN.
export * from "./administration-delete";
export * from "./administrations";
export * from "./callback-reads";
export * from "./dose-history";
export * from "./dose-status";
export * from "./dose-time-correction";
export * from "./prn-quick-log";
export * from "./redose-reads";
