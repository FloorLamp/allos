import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const DATA_WRITE_REVISION_MIGRATION = "20260909-data-write-revision";

export interface SqlStatement<
  BindParameters extends unknown[] = unknown[],
  Result = unknown,
> {
  readonly source: string;
  readonly reader: boolean;
  readonly readonly: boolean;
  readonly busy: boolean;
  run(...params: BindParameters): Database.RunResult;
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
  bind(...params: BindParameters): SqlStatement<BindParameters, Result>;
  pluck(toggleState?: boolean): SqlStatement<BindParameters, Result>;
  expand(toggleState?: boolean): SqlStatement<BindParameters, Result>;
  raw(toggleState?: boolean): SqlStatement<BindParameters, Result>;
  safeIntegers(toggleState?: boolean): SqlStatement<BindParameters, Result>;
  columns(): Database.ColumnDefinition[];
}

export interface SqlPrepare {
  prepare<
    BindParameters extends unknown[] | object = unknown[],
    Result = unknown,
  >(
    source: string
  ): BindParameters extends unknown[]
    ? SqlStatement<BindParameters, Result>
    : SqlStatement<[BindParameters], Result>;
}

export type SqlPragma =
  | "foreign_keys"
  | "foreign_keys = OFF"
  | "foreign_keys = ON"
  | "foreign_key_check"
  | `foreign_key_list(${string})`
  | "integrity_check"
  | "main.journal_mode"
  | "main.synchronous"
  | "main.wal_checkpoint(FULL)"
  | `table_info(${string})`
  | "wal_checkpoint(TRUNCATE)";

export interface SqlDatabase extends SqlPrepare {
  readonly inTransaction: boolean;
  pragma(source: SqlPragma, options?: Database.PragmaOptions): unknown;
}

export interface SqlTransaction<Args extends unknown[], Result> {
  (...params: Args): Result;
  default(...params: Args): Result;
  deferred(...params: Args): Result;
  immediate(...params: Args): Result;
  exclusive(...params: Args): Result;
}

export interface TransactionDatabase extends SqlDatabase {
  transaction<Args extends unknown[], Result>(
    fn: (...params: Args) => Result
  ): SqlTransaction<Args, Result>;
}

export interface MaintenanceDatabase extends TransactionDatabase {
  exec(source: string): MaintenanceDatabase;
}

type TransactionState = { stack: string[] };

const transactionStates = new WeakMap<Database.Database, TransactionState>();
const facadeCache = new WeakMap<Database.Database, MaintenanceDatabase>();
const requestFacadeCache = new WeakMap<Database.Database, SqlDatabase>();
const statementCache = new WeakMap<
  Database.Database,
  WeakMap<Database.Statement, SqlStatement>
>();
const totalChangesCache = new WeakMap<Database.Database, Database.Statement>();
const advanceCache = new WeakMap<Database.Database, Database.Statement>();

function transactionState(db: Database.Database): TransactionState {
  let state = transactionStates.get(db);
  if (!state) {
    state = { stack: [] };
    transactionStates.set(db, state);
  }
  return state;
}

function totalChanges(db: Database.Database): number {
  let stmt = totalChangesCache.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT total_changes() AS changes");
    totalChangesCache.set(db, stmt);
  }
  return (stmt.get() as { changes: number }).changes;
}

function currentTransactionId(db: Database.Database): string | undefined {
  return transactionState(db).stack.at(-1);
}

function advanceForCurrentTransaction(db: Database.Database): void {
  const transactionId = currentTransactionId(db);
  if (!transactionId) {
    throw new Error("A tracked write executed without a transaction owner");
  }
  let stmt = advanceCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `UPDATE data_write_revision
          SET revision = revision + 1, transaction_id = ?
        WHERE singleton = 1 AND transaction_id != ?`
    );
    advanceCache.set(db, stmt);
  }
  stmt.run(transactionId, transactionId);
}

function accountForChanges(db: Database.Database, before: number): void {
  if (totalChanges(db) > before) advanceForCurrentTransaction(db);
}

function withTransactionIdentity<Result>(
  db: Database.Database,
  fn: () => Result
): Result {
  const state = transactionState(db);
  const transactionId = state.stack.at(-1) ?? randomUUID();
  state.stack.push(transactionId);
  try {
    return fn();
  } finally {
    state.stack.pop();
  }
}

function trackedTransaction<Args extends unknown[], Result>(
  db: Database.Database,
  fn: (...params: Args) => Result
): SqlTransaction<Args, Result> {
  const native = db.transaction((...params: Args) =>
    withTransactionIdentity(db, () => fn(...params))
  );
  const tx = ((...params: Args) => native(...params)) as SqlTransaction<
    Args,
    Result
  >;
  tx.default = (...params) => native.default(...params);
  tx.deferred = (...params) => native.deferred(...params);
  tx.immediate = (...params) => native.immediate(...params);
  tx.exclusive = (...params) => native.exclusive(...params);
  return tx;
}

type MutationOutcome<Result> =
  { ok: true; value: Result } | { ok: false; error: unknown };

function executeInOwnedTransaction<Result>(
  db: Database.Database,
  execute: () => Result
): MutationOutcome<Result> {
  const before = totalChanges(db);
  let outcome: MutationOutcome<Result>;
  try {
    outcome = { ok: true, value: execute() };
  } catch (error) {
    // A ROLLBACK conflict ends the transaction itself and must escape directly.
    if (!db.inTransaction) throw error;
    outcome = { ok: false, error };
  }
  // Deliberately outside the native-execution catch: failure to record a change
  // must abort the transaction instead of being mistaken for a committable SQL
  // FAIL outcome.
  accountForChanges(db, before);
  return outcome;
}

function executeMutation<Result>(
  db: Database.Database,
  execute: () => Result
): Result {
  if (!currentTransactionId(db)) {
    // Keep SQLite's autocommit FAIL behavior: a multi-row statement may retain an
    // earlier row while still throwing. Catch inside the synthetic transaction so
    // that retained data and its revision commit together, then rethrow afterward.
    const outcome = trackedTransaction(db, () =>
      executeInOwnedTransaction(db, execute)
    ).immediate();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  const outcome = executeInOwnedTransaction(db, execute);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function wrapStatement<BindParameters extends unknown[], Result>(
  db: Database.Database,
  native: Database.Statement<BindParameters, Result>
): SqlStatement<BindParameters, Result> {
  let forDatabase = statementCache.get(db);
  if (!forDatabase) {
    forDatabase = new WeakMap();
    statementCache.set(db, forDatabase);
  }
  const cached = forDatabase.get(native);
  if (cached) return cached as SqlStatement<BindParameters, Result>;

  const execute = <Value>(fn: () => Value): Value =>
    native.readonly ? fn() : executeMutation(db, fn);
  const wrapped: SqlStatement<BindParameters, Result> = {
    get source() {
      return native.source;
    },
    get reader() {
      return native.reader;
    },
    get readonly() {
      return native.readonly;
    },
    get busy() {
      return native.busy;
    },
    run: (...params) => execute(() => native.run(...params)),
    get: (...params) => execute(() => native.get(...params)),
    all: (...params) => execute(() => native.all(...params)),
    iterate: (...params) => {
      if (native.readonly) return native.iterate(...params);
      return execute(() => [...native.iterate(...params)].values());
    },
    bind: (...params) => {
      native.bind(...params);
      return wrapped;
    },
    pluck: (toggleState) => {
      if (toggleState === undefined) native.pluck();
      else native.pluck(toggleState);
      return wrapped;
    },
    expand: (toggleState) => {
      if (toggleState === undefined) native.expand();
      else native.expand(toggleState);
      return wrapped;
    },
    raw: (toggleState) => {
      if (toggleState === undefined) native.raw();
      else native.raw(toggleState);
      return wrapped;
    },
    safeIntegers: (toggleState) => {
      if (toggleState === undefined) native.safeIntegers();
      else native.safeIntegers(toggleState);
      return wrapped;
    },
    columns: () => native.columns(),
  };
  forDatabase.set(native, wrapped);
  return wrapped;
}

export function trackedDatabase(db: Database.Database): MaintenanceDatabase {
  const cached = facadeCache.get(db);
  if (cached) return cached;

  const prepare = ((source: string) =>
    wrapStatement(db, db.prepare(source))) as SqlPrepare["prepare"];
  const facade: MaintenanceDatabase = {
    get inTransaction() {
      return db.inTransaction;
    },
    prepare,
    pragma: (source, options) => db.pragma(source, options),
    transaction: <Args extends unknown[], Result>(
      fn: (...params: Args) => Result
    ) => trackedTransaction(db, fn),
    exec: (source) => {
      executeMutation(db, () => db.exec(source));
      return facade;
    },
  };
  facadeCache.set(db, facade);
  return facade;
}

export function trackedRequestDatabase(db: Database.Database): SqlDatabase {
  const cached = requestFacadeCache.get(db);
  if (cached) return cached;
  const maintenance = trackedDatabase(db);
  const facade: SqlDatabase = {
    get inTransaction() {
      return maintenance.inTransaction;
    },
    prepare: maintenance.prepare,
    pragma: maintenance.pragma,
  };
  requestFacadeCache.set(db, facade);
  return facade;
}

export function readDataWriteRevision(db: SqlDatabase): number {
  const row = db
    .prepare<[], { revision: number }>(
      "SELECT revision FROM data_write_revision WHERE singleton = 1"
    )
    .get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("The data write revision row is missing or invalid");
  }
  return row.revision;
}

export function dataWriteRevisionExists(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_write_revision'"
      )
      .get() != null
  );
}

export function advanceDataWriteRevisionForMigration(
  db: Database.Database
): void {
  const transactionId = `migration:${randomUUID()}`;
  db.prepare(
    `UPDATE data_write_revision
        SET revision = revision + 1, transaction_id = ?
      WHERE singleton = 1 AND transaction_id != ?`
  ).run(transactionId, transactionId);
}
