// The `deleted_rows` kind a sleep re-time holds its undo under (#5021).
//
// Its own file so the Trash can exclude it (lib/trash.ts) without importing the store
// half — `lib/sleep-retime-db.ts` reaches the database, and `lib/trash.ts` is read by
// pure surfaces that must not.
export const SLEEP_RETIME_KIND = "sleep-retime";
