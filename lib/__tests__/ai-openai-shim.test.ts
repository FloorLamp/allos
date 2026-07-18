// PURE TIER (npm test) — the OpenAI-compatible request/response translation (#875).
//
// Pins the two pure seams (Anthropic request → chat-completions body; chat-completions
// response → Anthropic-shaped message) with fixtures, plus a fetch-injected round trip
// so the tool-call path is exercised end to end without network.

import { describe, it, expect } from "vitest";
import {
  chatCompletionsUrl,
  createOpenAiCompatClient,
  fromOpenAiResponse,
  toOpenAiRequest,
  type AnthropicRequest,
} from "@/lib/ai-openai-shim";

describe("toOpenAiRequest", () => {
  it("prepends the system message and passes a plain-text user turn", () => {
    const body = toOpenAiRequest({
      model: "m",
      max_tokens: 100,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body.model).toBe("m");
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("translates an image content block into an image_url data URI", () => {
    const req: AnthropicRequest = {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    };
    const body = toOpenAiRequest(req) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("translates tools + a forced tool_choice into OpenAI function-calling", () => {
    const body = toOpenAiRequest({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "save_data",
          description: "d",
          input_schema: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "tool", name: "save_data" },
    }) as { tools: unknown[]; tool_choice: unknown };
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "save_data",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "save_data" },
    });
  });
});

describe("fromOpenAiResponse", () => {
  it("maps a text completion to a text block + end_turn", () => {
    const msg = fromOpenAiResponse({
      choices: [{ finish_reason: "stop", message: { content: "hi there" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    expect(msg.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it("maps a tool call to a tool_use block with parsed input", () => {
    const msg = fromOpenAiResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              { id: "call_1", function: { name: "save_data", arguments: '{"a":1}' } },
            ],
          },
        },
      ],
    });
    expect(msg.content).toEqual([
      { type: "tool_use", id: "call_1", name: "save_data", input: { a: 1 } },
    ]);
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("maps finish_reason length to max_tokens (truncation)", () => {
    const msg = fromOpenAiResponse({
      choices: [{ finish_reason: "length", message: { content: "cut" } }],
    });
    expect(msg.stop_reason).toBe("max_tokens");
  });

  it("tolerates malformed tool arguments (empty object, no throw)", () => {
    const msg = fromOpenAiResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{ function: { name: "save_data", arguments: "{not json" } }],
          },
        },
      ],
    });
    expect(msg.content[0]).toMatchObject({ type: "tool_use", input: {} });
  });
});

describe("chatCompletionsUrl", () => {
  it("appends the path and tolerates trailing slashes / existing suffix", () => {
    expect(chatCompletionsUrl("http://h:8000/v1")).toBe(
      "http://h:8000/v1/chat/completions"
    );
    expect(chatCompletionsUrl("http://h:8000/v1/")).toBe(
      "http://h:8000/v1/chat/completions"
    );
    expect(chatCompletionsUrl("http://h:8000/v1/chat/completions")).toBe(
      "http://h:8000/v1/chat/completions"
    );
  });
});

describe("createOpenAiCompatClient (fetch-injected round trip)", () => {
  it("presents messages.stream().finalMessage() over a fake fetch", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: (init?.headers as Record<string, string>)?.authorization,
      });
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { id: "c1", function: { name: "save_data", arguments: '{"ok":true}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = createOpenAiCompatClient({
      baseUrl: "http://local/v1",
      apiKey: "k",
      fetchImpl: fakeFetch,
    });
    const msg = await (
      client as unknown as {
        messages: { stream: (r: AnthropicRequest) => { finalMessage: () => Promise<unknown> } };
      }
    ).messages
      .stream({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
      .finalMessage();

    expect(calls[0].url).toBe("http://local/v1/chat/completions");
    expect(calls[0].auth).toBe("Bearer k");
    expect(msg).toMatchObject({
      content: [{ type: "tool_use", name: "save_data", input: { ok: true } }],
      stop_reason: "tool_use",
    });
  });
});
