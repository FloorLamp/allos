// Persisted AI activity log. Every AI call (extraction, suggestions,
// auto-suggest, insight) and its outcome is appended as a JSON line to
// data/logs/ai.jsonl — an audit trail that's readable directly on the host
// (under the data volume) and streamed into the Settings → AI logs tab.
//
// Multi-user (issue #67, Phase 4): the log mixes extraction content across
// profiles, so each event is tagged with the acting loginId/profileId when
// they're known (see withAiLogContext) and the logs tab is admin-only.
//
// Server-only: uses node:fs. Never import from a client component.

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "./log";

const log = createLogger("ai");

export const AI_LOG_PATH = path.join(process.cwd(), "data", "logs", "ai.jsonl");

// Single-user app: prompts/responses may be logged for debugging. Set
// AI_LOG_PROMPTS=0 to keep events lean if the file grows unwieldy.
export const LOG_PROMPTS = process.env.AI_LOG_PROMPTS !== "0";

// Bound any free-text detail so a giant prompt/response can't balloon the file.
export function capDetail(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}

// Keep the file bounded: when it grows past this, rewrite with the newest lines.
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_LINES = 2000;

export type AiFeature =
  "extraction" | "suggestions" | "auto-suggest" | "insight";
export type AiStatus = "ok" | "skipped" | "failed";

export interface AiEvent {
  id: string;
  time: string;
  feature: AiFeature;
  status: AiStatus;
  model?: string;
  durationMs?: number;
  detail?: string;
  error?: string;
  // Who the call was acting for, when known (a request/session context). Null in
  // background/notify/CLI contexts that have no session. Used only for audit — the
  // logs tab is admin-only, so members never read another profile's events.
  loginId?: number | null;
  profileId?: number | null;
}

// Ambient login/profile for AI-log tagging. An AI call deep in lib/ can't see
// the session, so the request-context caller wraps the work in withAiLogContext()
// and recordAiEvent() stamps whatever's in scope. Propagates through the async
// chain — including fire-and-forget extractions launched with `void` inside the
// wrapper — because the store is captured when those async ops are created.
export interface AiLogContext {
  loginId: number | null;
  profileId: number | null;
}
const aiLogContext = new AsyncLocalStorage<AiLogContext>();

export function withAiLogContext<T>(ctx: AiLogContext, fn: () => T): T {
  return aiLogContext.run(ctx, fn);
}

// Monotonic-ish id within a process: time + counter so events appended in the
// same millisecond still sort/resume correctly.
let seq = 0;
function nextId(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now()}-${seq.toString().padStart(6, "0")}`;
}

function ensureDir() {
  fs.mkdirSync(path.dirname(AI_LOG_PATH), { recursive: true });
}

function trimIfLarge() {
  try {
    const { size } = fs.statSync(AI_LOG_PATH);
    if (size <= MAX_BYTES) return;
    const lines = fs
      .readFileSync(AI_LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean);
    fs.writeFileSync(AI_LOG_PATH, lines.slice(-KEEP_LINES).join("\n") + "\n");
  } catch {
    // best-effort
  }
}

// Record an AI event: append to the file AND echo through the central logger
// (so it also reaches stdout / `docker logs`). Best-effort — never throws into
// the caller's AI flow.
export function recordAiEvent(e: Omit<AiEvent, "id" | "time">): AiEvent {
  // Stamp the ambient session context (if any) unless the caller set it
  // explicitly. A missing context (background/notify/CLI) leaves the tags null.
  const ctx = aiLogContext.getStore();
  const event: AiEvent = {
    id: nextId(),
    time: new Date().toISOString(),
    ...e,
    loginId: e.loginId ?? ctx?.loginId ?? null,
    profileId: e.profileId ?? ctx?.profileId ?? null,
  };
  try {
    ensureDir();
    fs.appendFileSync(AI_LOG_PATH, JSON.stringify(event) + "\n");
    trimIfLarge();
  } catch (err) {
    log.error("failed to write ai log", { err });
  }
  const fields = {
    feature: event.feature,
    status: event.status,
    model: event.model,
    durationMs: event.durationMs,
    detail: event.detail,
    error: event.error,
  };
  if (event.status === "failed") log.error("ai call failed", fields);
  else log.info("ai call", fields);
  return event;
}

export function parseAiLine(line: string): AiEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o.id === "string" ? (o as AiEvent) : null;
  } catch {
    return null;
  }
}

// Newest-first, capped — for the SSR'd initial render.
export function readAiEvents(limit = 200): AiEvent[] {
  try {
    const lines = fs.readFileSync(AI_LOG_PATH, "utf8").split("\n");
    const events: AiEvent[] = [];
    for (const line of lines) {
      const e = parseAiLine(line);
      if (e) events.push(e);
    }
    return events.slice(-limit).reverse();
  } catch {
    return []; // file not created yet
  }
}

export function aiLogSize(): number {
  try {
    return fs.statSync(AI_LOG_PATH).size;
  } catch {
    return 0;
  }
}

// Read events appended since `fromByte`. Returns the parsed events (oldest-first)
// and the new byte size. If the file shrank (self-trim/rotation), re-reads from
// the start so the caller can reset its offset.
export function tailAiLog(fromByte: number): {
  events: AiEvent[];
  size: number;
} {
  const size = aiLogSize();
  if (size === 0) return { events: [], size: 0 };
  const start = fromByte > size ? 0 : fromByte; // shrank → re-tail from 0
  try {
    const fd = fs.openSync(AI_LOG_PATH, "r");
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const events: AiEvent[] = [];
      for (const line of buf.toString("utf8").split("\n")) {
        const e = parseAiLine(line);
        if (e) events.push(e);
      }
      return { events, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], size };
  }
}
