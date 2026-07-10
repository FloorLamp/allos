// Shared AI plumbing: the model knob, the "is AI configured" predicate, and the
// SDK-client factory used by the medical extractor, the coaching insights, and
// the supplement suggester. (Logging now lives in lib/log.ts.)

import Anthropic from "@anthropic-ai/sdk";

// Default to a capable, fast model; override with HEALTH_AI_MODEL.
export const AI_MODEL = process.env.HEALTH_AI_MODEL || "claude-sonnet-5";

// --- Configurable endpoint (issue #43) ---------------------------------------
// By default the SDK talks to Anthropic's hosted API. Privacy-focused
// self-hosters can point the app at a local/self-hosted inference server that
// exposes an Anthropic-compatible API (Ollama & friends, or a proxy) by setting
// AI_BASE_URL — then no request ever leaves the box beyond that endpoint.
//
// The resolution logic below is kept as pure, env-injected helpers so it stays
// unit-testable without importing/instantiating the SDK.

export interface AiEnv {
  ANTHROPIC_API_KEY?: string;
  AI_BASE_URL?: string;
  // Index signature so `process.env` (NodeJS.ProcessEnv) is assignable directly,
  // while a plain `{ AI_BASE_URL: "…" }` test object still type-checks.
  [key: string]: string | undefined;
}

// AI counts as configured when EITHER a real API key OR a custom base URL is
// set. A local inference server usually ignores the key, so a base URL on its
// own is enough to enable the AI features (they degrade gracefully otherwise).
export function isAiConfigured(env: AiEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.AI_BASE_URL);
}

export interface AiClientOptions {
  apiKey: string;
  baseURL?: string;
}

// Resolve the SDK constructor options from the environment, or null when AI is
// not configured at all. When a base URL is set without a key, the SDK still
// requires a non-empty apiKey, so we pass a harmless placeholder ("local") —
// local servers ignore it.
export function resolveClientOptions(env: AiEnv): AiClientOptions | null {
  if (!isAiConfigured(env)) return null;
  const baseURL = env.AI_BASE_URL || undefined;
  const apiKey = env.ANTHROPIC_API_KEY || "local";
  return baseURL ? { apiKey, baseURL } : { apiKey };
}

// Host-only view of the configured endpoint, for display and audit. Returns
// undefined for the default Anthropic endpoint (no AI_BASE_URL). Never includes
// the path/query (or any secret embedded in the URL) — just the host, so an
// AI-log tag or a settings line can name the backend without leaking a token.
export function endpointHost(env: AiEnv): string | undefined {
  const raw = env.AI_BASE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return raw; // malformed URL — fall back to the raw value (no secret to leak)
  }
}

// A human label for the active endpoint: the default hosted API vs a custom host.
export function endpointLabel(env: AiEnv): string {
  return endpointHost(env) ?? "Anthropic API";
}

// --- Runtime wrappers (read process.env) -------------------------------------

// The single "is AI available" predicate — use this everywhere instead of a
// scattered `process.env.ANTHROPIC_API_KEY` check, so AI_BASE_URL counts too.
export function aiConfigured(): boolean {
  return isAiConfigured(process.env);
}

// Build an SDK client from the resolved environment options. Callers guard with
// aiConfigured() first and take their graceful-degradation path when it's false;
// this throws only on the unreachable no-config path as a defensive backstop.
export function createAiClient(): Anthropic {
  const opts = resolveClientOptions(process.env);
  if (!opts) {
    throw new Error(
      "AI is not configured — set ANTHROPIC_API_KEY or AI_BASE_URL."
    );
  }
  return new Anthropic(opts);
}

export interface AiEndpointInfo {
  configured: boolean;
  label: string;
  host?: string;
  model: string;
}

// A read-only snapshot of the active AI backend for the admin Server settings
// page and for AI-log tagging. Deliberately host-only (never the raw
// AI_BASE_URL): the snapshot is serialized into a client component's props, and
// a raw URL could carry embedded credentials (http://user:token@host).
export function aiEndpointInfo(): AiEndpointInfo {
  return {
    configured: aiConfigured(),
    label: endpointLabel(process.env),
    host: endpointHost(process.env),
    model: AI_MODEL,
  };
}
