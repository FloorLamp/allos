// The closed vocabulary for one integration run. Kept as a leaf so the shared
// history formatter does not need to import the source standing model (#3870).
export type SyncRunNoun = "push" | "sync" | "refresh" | "import" | "upload";

// A declared table rather than a suffix rule: `import` and `upload` prove that the
// English plural cannot be derived mechanically. The Record makes a new noun a type
// error until its plural is named.
const RUN_NOUN_PLURAL: Record<SyncRunNoun, string> = {
  push: "pushes",
  sync: "syncs",
  refresh: "refreshes",
  import: "imports",
  upload: "uploads",
};

export function pluralRunNoun(noun: SyncRunNoun): string {
  return RUN_NOUN_PLURAL[noun];
}
