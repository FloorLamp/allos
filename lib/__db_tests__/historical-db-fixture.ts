import Database from "better-sqlite3";

/** Build one real historical fixture, then return a fresh byte-copy per case. */
export function historicalDbFixture(
  build: (db: Database.Database) => void
): () => Database.Database {
  let snapshot: Buffer | null = null;

  return () => {
    if (snapshot === null) {
      const source = new Database(":memory:");
      try {
        build(source);
        snapshot = source.serialize();
      } finally {
        source.close();
      }
    }
    return new Database(snapshot);
  };
}
