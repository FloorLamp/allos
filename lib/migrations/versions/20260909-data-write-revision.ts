import type { Migration } from "../runner";
import { DATA_WRITE_REVISION_MIGRATION } from "../../write-revision";

export const migration: Migration = {
  name: DATA_WRITE_REVISION_MIGRATION,
  up(db) {
    db.exec(`
      CREATE TABLE data_write_revision (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        transaction_id TEXT NOT NULL
      );

      INSERT INTO data_write_revision (singleton, revision, transaction_id)
      VALUES (1, 0, 'migration:init');
    `);
  },
};
