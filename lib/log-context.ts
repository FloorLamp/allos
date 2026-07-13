// Ambient login/profile context for server logging (issue #596). A call deep in
// lib/ can't see the session, so a request-context caller wraps its work in
// withLogContext() and the logging layers (ai-log, error-log) stamp whatever's
// in scope. Propagates through the async chain — including fire-and-forget work
// launched with `void` inside the wrapper — because the store is captured when
// those async ops are created. A missing context (background/notify/CLI) leaves
// the tags null.
//
// Server-only: uses node:async_hooks. `withAiLogContext` is re-exported from
// ai-log.ts as the historical name; both logs read the SAME store so an error
// thrown inside a withLogContext(...) request is tagged with the same acting
// login/profile as any AI call in that request.

import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  loginId: number | null;
  profileId: number | null;
}

const store = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function getLogContext(): LogContext | undefined {
  return store.getStore();
}
