// Shared test helper for the AI-runtime DB tests (issue #675). NOT a test file
// (the config only collects *.test.ts) — a builder for a fake Anthropic SDK client
// injected at the `lib/ai-client.ts` seam via `vi.mock`, so the extraction /
// suggestion RUNTIME (extract.ts, supplement-suggest.ts) runs for real over canned
// model output with no network and no API key.
//
// The seam: both runtimes call `createAiClient()` (a named export used at call
// time) and then `client.messages.stream({...}).finalMessage()`. Mocking
// `@/lib/ai-client`'s `createAiClient` to return one of these fakes exercises the
// real orchestration (buildContent → tool-use parsing → normalize → error mapping →
// truncation/no-data honesty) that the pure tier structurally can't see.

import type Anthropic from "@anthropic-ai/sdk";

// Minimal shape of the assembled message the runtimes read: the content blocks,
// the stop reason (max_tokens ⇒ truncation), and the usage block (logged).
export interface FakeMessage {
  content: Array<
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "text"; text: string }
  >;
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

// A single tool_use block message, as the model returns when it calls the
// structured tool exactly once. `toolName` is save_medical_data / suggest_supplements.
export function toolMessage(
  toolName: string,
  input: unknown,
  opts: {
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  } = {}
): FakeMessage {
  return {
    content: [{ type: "tool_use", id: "toolu_test", name: toolName, input }],
    stop_reason: opts.stop_reason ?? "tool_use",
    usage: opts.usage ?? { input_tokens: 100, output_tokens: 50 },
  };
}

// A message with NO tool_use block (only prose) — the "model returned no
// structured data" failure the runtimes must surface honestly.
export function noToolMessage(
  text = "I could not read the document."
): FakeMessage {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

// Build a fake Anthropic client whose messages.stream(...).finalMessage()
// resolves to `msg` (or, when `msg` is an Error, rejects with it — the API-error
// path). Cast to the SDK type; the runtimes only touch messages.stream/finalMessage.
export function fakeClient(msg: FakeMessage | Error): Anthropic {
  return {
    messages: {
      stream: (_args: unknown) => ({
        finalMessage: async () => {
          if (msg instanceof Error) throw msg;
          return msg;
        },
      }),
    },
  } as unknown as Anthropic;
}
