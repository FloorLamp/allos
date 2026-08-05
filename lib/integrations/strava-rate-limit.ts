// Strava applies its read quota to the API APPLICATION, not to one athlete. All
// profiles configured with the same client id therefore spend the same allowance.
// Keep one conservative process-wide view of that allowance and refine it from the
// authoritative X-ReadRateLimit-* headers returned by every Strava response.

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const DEFAULT_SHORT_LIMIT = 100;
const DEFAULT_DAILY_LIMIT = 1_000;
const SHORT_RESERVE = 5;
const DAILY_RESERVE = 25;

interface StravaRateState {
  shortWindow: number;
  utcDay: string;
  shortUsed: number;
  dailyUsed: number;
  shortLimit: number;
  dailyLimit: number;
}

interface GlobalStravaRateState {
  byClientId: Map<string, StravaRateState>;
}

const globalForStrava = globalThis as typeof globalThis & {
  __allosStravaRateState?: GlobalStravaRateState;
};

const globalState =
  globalForStrava.__allosStravaRateState ??
  (globalForStrava.__allosStravaRateState = { byClientId: new Map() });

function windows(at: number): { shortWindow: number; utcDay: string } {
  return {
    shortWindow: Math.floor(at / FIFTEEN_MINUTES_MS),
    utcDay: new Date(at).toISOString().slice(0, 10),
  };
}

function stateFor(clientId: string, at: number): StravaRateState {
  const currentWindows = windows(at);
  const existing = globalState.byClientId.get(clientId);
  if (!existing) {
    const created = {
      ...currentWindows,
      shortUsed: 0,
      dailyUsed: 0,
      shortLimit: DEFAULT_SHORT_LIMIT,
      dailyLimit: DEFAULT_DAILY_LIMIT,
    };
    globalState.byClientId.set(clientId, created);
    return created;
  }
  if (existing.shortWindow !== currentWindows.shortWindow) {
    existing.shortWindow = currentWindows.shortWindow;
    existing.shortUsed = 0;
  }
  if (existing.utcDay !== currentWindows.utcDay) {
    existing.utcDay = currentWindows.utcDay;
    existing.dailyUsed = 0;
  }
  return existing;
}

function pair(value: string | null): [number, number] | null {
  if (!value) return null;
  const values = value.split(",").map((part) => Number(part.trim()));
  return values.length === 2 && values.every(Number.isFinite)
    ? [values[0], values[1]]
    : null;
}

export interface StravaRequestBudget {
  readonly requests: number;
  readonly exhausted: boolean;
  reserve(): boolean;
  observe(headers: Headers): void;
}

// maxRequests is an Allos safety ceiling for one operation. The provider quota may
// stop it sooner; callers treat either condition as a resumable partial operation.
export function createStravaRequestBudget(
  clientId: string,
  maxRequests: number,
  clock: () => number = Date.now
): StravaRequestBudget {
  let requests = 0;
  let exhausted = false;
  return {
    get requests() {
      return requests;
    },
    get exhausted() {
      return exhausted;
    },
    reserve() {
      const state = stateFor(clientId, clock());
      if (
        requests >= maxRequests ||
        state.shortUsed >= Math.max(0, state.shortLimit - SHORT_RESERVE) ||
        state.dailyUsed >= Math.max(0, state.dailyLimit - DAILY_RESERVE)
      ) {
        exhausted = true;
        return false;
      }
      // Reserve before fetch: a timeout or dropped response still may have reached
      // Strava and consumed quota.
      requests++;
      state.shortUsed++;
      state.dailyUsed++;
      return true;
    },
    observe(headers) {
      const state = stateFor(clientId, clock());
      const limits = pair(headers.get("x-readratelimit-limit"));
      const usage = pair(headers.get("x-readratelimit-usage"));
      if (limits) {
        state.shortLimit = limits[0];
        state.dailyLimit = limits[1];
      }
      if (usage) {
        // Never move behind a request reserved concurrently in this process.
        state.shortUsed = Math.max(state.shortUsed, usage[0]);
        state.dailyUsed = Math.max(state.dailyUsed, usage[1]);
      }
    },
  };
}

// Test seam: DB suites share one Node process, unlike independent app boots.
export function resetStravaRateLimitState(): void {
  globalState.byClientId.clear();
}
