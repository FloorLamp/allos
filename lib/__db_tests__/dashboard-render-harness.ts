// ONE HARNESS FOR RENDERING THE DASHBOARD OUTSIDE A REQUEST (#3096, #5010).
//
// Two readers of the dashboard's cost share it: the query METER
// (`dashboard-placement-manifest.test.ts`, statements per persona, a budget) and
// the PROFILER (`dashboard-profile.test.ts` behind `scripts/profile-dashboard.ts`,
// wall time, per-statement time and a CPU profile over a production snapshot). They
// used to be one file and a copy; the mocks below are the seam, so a change to how
// the page is rendered here lands in both readings at once.
//
// WHAT A RENDER NEEDS FAKED, AND WHY EACH FAKE IS SHAPED THE WAY IT IS.
//
// The page calls `requireSession` / `requireScope`, which read Next's request
// cookies — there is no request here, so `session` below is the whole identity and
// the two mocks answer from it. `withAiLogContext` and `runRecommendation` are the
// two side effects a render may start; a meter must not spend them.
//
// `vi.mock` HAS TO STAY IN THE TEST FILE. The isolation scan (vitest.isolation.ts)
// routes a spec to the isolated project by seeing `vi.mock(` in its own source, and
// a mock registered from an imported module would not be hoisted. So each spec keeps
// its five one-line `vi.mock` calls and their factories `await import` this module —
// which is also why this module imports NONE of the modules being mocked at its top
// level: a factory importing the harness, and the harness importing the module the
// factory is defining, would be a cycle through the mock registry.
//
// A REAL memoizing stand-in for `lib/request-cache`'s `cache()` (#3369).
//
// `lib/request-cache.ts` is `React.cache ?? ((fn) => fn)`, and its own comment says
// the rest: outside a Next server request React.cache has no dispatcher and simply
// calls through. So in this tier every `cache()`-wrapped read executes once per
// CALLER, and a count taken that way overstated what a production render pays by
// roughly 30 statements per persona (#3369 measured household 297 -> 267, biohacker
// 305 -> 258). A budget policed by an overstating meter polices a number nobody pays.
//
// THE SCOPE IS ONE RENDER, AND NOT ONE BYTE MORE. React's `cache()` lifetime is
// exactly one server request. Here that scope is opened around each `Dashboard()`
// call by `renderDashboard` and closed when it settles; outside it this wrapper calls
// straight through, which is also what production does outside a request. Persona
// seeding runs between renders and must not read through another persona's memo,
// and a memo that outlived a render would UNDERSTATE the budget — the wrong direction
// for a meter, because it hides queries someone is really paying for.
//
// THE KEYING IS REACT'S KEYING: positional arguments by identity, walked as a Map
// trie. Two structurally equal but distinct objects miss in React and miss here.
// FAITHFUL EXCEPT IN THE SAFE DIRECTION: this may count HIGH but never low. React
// caches a throw for the request and this does not — do not "fix" that toward
// exactness, it moves the deviation to the unsafe side.
//
// A single module-level slot rather than AsyncLocalStorage, for the same reason
// `lib/tick-cache.ts` uses one: callers await one render at a time.
import inspector from "node:inspector";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { vi } from "vitest";
import { db } from "@/lib/db";
import { authorizedProfileSubset } from "@/lib/cross-profile";

/** The identity a render sees. Mutable on purpose: the meter walks personas through it. */
export interface HarnessProfile {
  id: number;
  name: string;
  photo_path: string | null;
  photo_version: number;
}
export const session: {
  loginId: number;
  profile: HarnessProfile | null;
  accessible: HarnessProfile[];
} = { loginId: 0, profile: null, accessible: [] };

interface MemoNode {
  children: Map<unknown, MemoNode>;
  filled: boolean;
  value: unknown;
}
const node = (): MemoNode => ({
  children: new Map(),
  filled: false,
  value: undefined,
});
const childOf = (parent: MemoNode, key: unknown): MemoNode => {
  const existing = parent.children.get(key);
  if (existing) return existing;
  const created = node();
  parent.children.set(key, created);
  return created;
};
let open: Map<symbol, MemoNode> | null = null;

export const requestCache = {
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const identity = Symbol(fn.name || "cached");
    return (...args: A): R => {
      const scope = open;
      if (!scope) return fn(...args);
      let root: MemoNode | undefined = scope.get(identity);
      if (!root) {
        root = node();
        scope.set(identity, root);
      }
      let current: MemoNode = root;
      for (const arg of args) current = childOf(current, arg);
      if (current.filled) return current.value as R;
      const value = fn(...args);
      current.filled = true;
      current.value = value;
      return value;
    };
  },
  /** Run `fn` with one request's worth of memoization open. */
  async during<T>(fn: () => Promise<T>): Promise<T> {
    open = new Map();
    try {
      return await fn();
    } finally {
      open = null;
    }
  },
};

// ── The five mock modules. Each spec: `vi.mock("<id>", async (importActual) =>
// (await import("@/lib/__db_tests__/dashboard-render-harness")).<fn>(await importActual()))`.
export function requestCacheModule() {
  return { cache: requestCache.cache };
}

type AuthModule = typeof import("@/lib/auth");
export function authModule(actual: AuthModule): AuthModule {
  return {
    ...actual,
    requireSession: async () => {
      if (!session.profile)
        throw new Error("dashboard harness session not set");
      return {
        login: {
          id: session.loginId,
          username: "dashboard-test",
          role: "admin",
        },
        profile: session.profile,
        access: "write" as const,
        deviceSessionKey: "dashboard-test-device",
      } as Awaited<ReturnType<AuthModule["requireSession"]>>;
    },
    getAccessibleProfiles: async () => session.accessible,
    ownProfileForLogin: () => session.profile?.id ?? null,
  };
}

type ScopeModule = typeof import("@/lib/scope");
export function scopeModule(
  actual: ScopeModule,
  auth: AuthModule
): ScopeModule {
  return {
    ...actual,
    requireScope: async () => {
      if (!session.profile) throw new Error("dashboard harness scope not set");
      const ids = authorizedProfileSubset(
        auth.accessibleProfileIdsForLogin(session.loginId),
        session.accessible.map((profile) => profile.id)
      );
      return {
        loginId: session.loginId,
        role: "admin" as const,
        actingProfileId: session.profile.id,
        ownProfileId: session.profile.id,
        profiles: session.accessible,
        ids,
        viewIds: authorizedProfileSubset(ids, [session.profile.id]),
        access: new Map(ids.map((id) => [id, "write" as const])),
      } as Awaited<ReturnType<ScopeModule["requireScope"]>>;
    },
  };
}

type AiLogModule = typeof import("@/lib/ai-log");
export function aiLogModule(actual: AiLogModule): AiLogModule {
  // The two side effects a render may start, stubbed to nothing. Cast because the
  // originals are typed by what they return and a meter must return nothing.
  return {
    ...actual,
    withAiLogContext: (() =>
      undefined) as unknown as AiLogModule["withAiLogContext"],
  };
}

type RecommendationEngineModule = typeof import("@/lib/recommendation-engine");
export function recommendationEngineModule(
  actual: RecommendationEngineModule
): RecommendationEngineModule {
  return {
    ...actual,
    runRecommendation: (() =>
      undefined) as unknown as RecommendationEngineModule["runRecommendation"],
  };
}

// ── Identity helpers over the open database. `db` is `export let`; read it through
// the live binding at call time, never captured, so a `reopenDatabaseForTests()`
// between calls is honoured.
export function adminLoginId(): number {
  return (
    db
      .prepare("SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1")
      .get() as { id: number }
  ).id;
}
export function allProfileIds(): number[] {
  return (
    db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: number }[]
  ).map((row) => row.id);
}
export function profilesForIds(ids: readonly number[]): HarnessProfile[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, name, photo_path, photo_version FROM profiles
       WHERE id IN (${marks}) ORDER BY id`
    )
    .all(...ids) as HarnessProfile[];
}

// ── The statement trace: every prepared statement's get/all/run/iterate, counted
// and (when asked) timed with the first app frame that ran it. Counting is what the
// meter budgets; timing is what the profiler ranks. One proxy, two readings.
export interface StatementStat {
  sql: string;
  count: number;
  ms: number;
  /** Caller frame → ms, for the timed trace only. */
  callers: Map<string, number>;
}
function callerFrame(): string {
  // Capturing a stack per statement is the trace's own cost; twelve frames reach
  // the first app frame from any query helper and keep it under a tenth of the
  // work being measured on a 1,500-statement page.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const lines = stack.split("\n").slice(1);
  for (const line of lines) {
    if (/lib\/db\.ts|node_modules|dashboard-render-harness/.test(line))
      continue;
    const m = line.match(/\((.*?):(\d+):\d+\)|at (.*?):(\d+):\d+/);
    if (m) {
      const file = (m[1] ?? m[3] ?? "").replace(
        /^.*?\/(app|lib|components)\//,
        "$1/"
      );
      return `${file}:${m[2] ?? m[4]}`;
    }
  }
  return "?";
}
export function installStatementTrace(options: { timing?: boolean } = {}) {
  const stats = new Map<string, StatementStat>();
  let executed = 0;
  const realPrepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof value === "function" &&
          ["get", "all", "run", "iterate"].includes(String(property))
        ) {
          return (...args: unknown[]) => {
            executed += 1;
            if (!options.timing) return value.apply(target, args);
            const started = process.hrtime.bigint();
            try {
              return value.apply(target, args);
            } finally {
              const ms = Number(process.hrtime.bigint() - started) / 1e6;
              const key = sql.replace(/\s+/g, " ").trim();
              let stat = stats.get(key);
              if (!stat) {
                stat = { sql: key, count: 0, ms: 0, callers: new Map() };
                stats.set(key, stat);
              }
              stat.count += 1;
              stat.ms += ms;
              const caller = callerFrame();
              stat.callers.set(caller, (stat.callers.get(caller) ?? 0) + ms);
            }
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.prepare);
  return {
    clear: () => {
      executed = 0;
      stats.clear();
    },
    count: () => executed,
    stats: () => [...stats.values()],
  };
}

// ── Rendering. The page is imported lazily so the mocks above are in place first.
export async function loadDashboard() {
  const { default: Dashboard } = await import("../../app/(app)/page");
  return Dashboard;
}
/**
 * Any App Router page under `app/`, by module path (`app/(app)/trends/page`).
 * The profiler's `--page`; pages that read Next's request APIs directly (rather
 * than through the mocked session/scope) throw here and say so.
 */
export async function loadPage(
  modulePath: string
): Promise<(props: PageProps) => Promise<ReactElement>> {
  const mod = (await import(/* @vite-ignore */ `../../${modulePath}`)) as {
    default: (props: PageProps) => Promise<ReactElement>;
  };
  return mod.default;
}
export interface PageProps {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}
export function pageProps(
  params: Record<string, string> = {},
  searchParams: Record<string, string | string[] | undefined> = {}
): PageProps {
  return {
    params: Promise.resolve(params),
    searchParams: Promise.resolve(searchParams),
  };
}
export async function renderDashboard(
  Dashboard: () => Promise<ReactElement>
): Promise<ReactElement> {
  return requestCache.during(async () => await Dashboard());
}
export async function renderPage(
  Page: (props: PageProps) => Promise<ReactElement>,
  props: PageProps
): Promise<ReactElement> {
  return requestCache.during(async () => await Page(props));
}

// ── A CPU profile around a stretch of the same process (works inside vitest's
// worker threads: each has its own inspector). `interval` is the sampling
// interval in microseconds.
export async function withCpuProfile<T>(
  fn: () => Promise<T>,
  interval = 500
): Promise<{ result: T; profile: inspector.Profiler.Profile }> {
  const inspectorSession = new inspector.Session();
  inspectorSession.connect();
  const post = <R>(method: string, params?: object) =>
    new Promise<R>((resolve, reject) =>
      inspectorSession.post(method, params ?? {}, (error, result) =>
        error ? reject(error) : resolve(result as R)
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval });
  await post("Profiler.start");
  try {
    const result = await fn();
    const { profile } = await post<{ profile: inspector.Profiler.Profile }>(
      "Profiler.stop"
    );
    return { result, profile };
  } finally {
    inspectorSession.disconnect();
  }
}

// ── RESOLVE THE ASYNC TREE. A page function returns an element tree; the work of a
// route that streams its sections lives in nested async server components that
// React would run during rendering. Nothing in this tier is a React server
// renderer, so this walks the tree and runs every function-typed element itself:
// an async component is awaited and its result walked; a sync one is called and
// its result walked; one that throws (a client component reaching for a hook, a
// server-only API with no request) is left as it was and counted. The gathers
// inside the sections are what this measures; the markup is irrelevant.
export interface ResolvedTree {
  components: number;
  awaited: number;
  skipped: string[];
}
type AnyProps = { children?: ReactNode } & Record<string, unknown>;
export async function resolveAsyncTree(
  root: ReactNode,
  stats: ResolvedTree = { components: 0, awaited: 0, skipped: [] }
): Promise<ResolvedTree> {
  const visit = async (node: ReactNode): Promise<void> => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) await visit(child);
      return;
    }
    if (node instanceof Promise) {
      await visit(await node);
      return;
    }
    if (!isValidElement(node)) return;
    const element = node as ReactElement<AnyProps>;
    const type = element.type;
    if (typeof type === "function") {
      const name = (type as { name?: string }).name || "(anon)";
      try {
        stats.components += 1;
        let rendered = (type as (props: AnyProps) => unknown)(element.props);
        if (rendered instanceof Promise) {
          stats.awaited += 1;
          rendered = await rendered;
        }
        await visit(rendered as ReactNode);
      } catch (error) {
        stats.skipped.push(
          `${name}: ${String((error as Error)?.message ?? error).slice(0, 80)}`
        );
        // A client component that could not run still WRAPS server work — a
        // provider around a page's sections is the usual case — so its children
        // are walked as if it were transparent.
        const wrapped = element.props?.children;
        if (wrapped !== undefined)
          for (const child of Children.toArray(wrapped)) await visit(child);
      }
      return;
    }
    const children = element.props?.children;
    if (children !== undefined) {
      for (const child of Children.toArray(children)) await visit(child);
    }
  };
  await visit(root);
  return stats;
}
