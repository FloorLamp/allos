import type Database from "better-sqlite3";
import type { Migration } from "../runner";

export function up(db: Database.Database): void {
  // SQLite's default trim only removes spaces; match the form/schedule's JS trim.
  const whitespace =
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  db.prepare(
    `UPDATE intake_item_doses
        SET retired = 1
      WHERE retired = 0
        AND trim(COALESCE(time_of_day, ''), ?) = ''
        AND trim(COALESCE(amount, ''), ?) = ''`
  ).run(whitespace, whitespace);
}

export const migration: Migration = {
  name: "20260908-retire-blank-intake-doses",
  up,
};
