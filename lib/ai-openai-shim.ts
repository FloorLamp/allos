// An OpenAI-compatible (chat-completions) client that presents the SAME surface the
// AI call sites already use on the Anthropic SDK — `messages.create({...})` and
// `messages.stream({...}).finalMessage()` — so the tier resolver can hand either
// shape to the existing extractors/narrators without touching them (issue #875).
//
// It translates the Anthropic request shape (system + message content blocks + tools
// + tool_choice) into a POST to `${baseUrl}/chat/completions`, and translates the
// response (text or a function/tool call, finish_reason, usage) back into the
// Anthropic-shaped message the call sites read. Only the widely-supported params are
// sent — model, messages, max_tokens, tools, tool_choice — so an "OpenAI-compatible"
// backend that rejects exotic params (the CometAPI-compatibility caveat) still works.
//
// The pure translation functions are exported and unit-tested with fixtures; the
// client wrapper does the fetch. Cast to the Anthropic type at the seam (the call
// sites only touch messages.create / messages.stream().finalMessage), exactly as the
// test fake does.

import type Anthropic from "@anthropic-ai/sdk";

// --- Request translation (Anthropic → OpenAI chat-completions) ----------------

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
interface AnthropicDocBlock {
  type: "document";
  source: { type: "base64"; media_type: string; data: string };
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocBlock
  | { type: string; [k: string]: unknown };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  tool_choice?: { type: string; name?: string };
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// Translate one Anthropic content block into an OpenAI content part. Text stays text;
// an image (or a base64 document, best-effort) becomes an image_url data URI — the
// only cross-provider way to carry an inline image. Unknown blocks fall back to their
// text if present, else are dropped.
function contentPart(block: AnthropicContentBlock): OpenAiContentPart | null {
  if (block.type === "text")
    return { type: "text", text: (block as AnthropicTextBlock).text };
  if (block.type === "image" || block.type === "document") {
    const src = (block as AnthropicImageBlock).source;
    if (src && src.type === "base64")
      return {
        type: "image_url",
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      };
  }
  return null;
}

// Build the OpenAI /chat/completions request body from the Anthropic-shaped args.
export function toOpenAiRequest(req: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
    } else {
      const parts = m.content
        .map(contentPart)
        .filter((p): p is OpenAiContentPart => p != null);
      // Collapse a single text part to a plain string (maximally compatible).
      if (parts.length === 1 && parts[0].type === "text")
        messages.push({ role: m.role, content: parts[0].text });
      else messages.push({ role: m.role, content: parts });
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages,
  };

  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema,
      },
    }));
    if (req.tool_choice?.type === "tool" && req.tool_choice.name) {
      body.tool_choice = {
        type: "function",
        function: { name: req.tool_choice.name },
      };
    }
  }
  return body;
}

// --- Response translation (OpenAI → Anthropic-shaped message) -----------------

export interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// The Anthropic-shaped message the call sites read back.
export interface ShapedMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

// Map an OpenAI finish_reason to the Anthropic stop_reason the extractors check
// (`max_tokens` drives their truncation handling).
function mapStopReason(finish: string | null | undefined, hasTool: boolean): string {
  if (finish === "length") return "max_tokens";
  if (hasTool || finish === "tool_calls") return "tool_use";
  return "end_turn";
}

// Parse an OpenAI chat-completions response into the Anthropic-shaped message. A
// function/tool call becomes a `tool_use` block (arguments JSON-parsed); plain text
// becomes a `text` block. Malformed tool arguments yield an empty object rather than
// throwing, so the caller's shape-guard handles it as "unrecognized" honestly.
export function fromOpenAiResponse(json: OpenAiResponse): ShapedMessage {
  const choice = json.choices?.[0];
  const msg = choice?.message;
  const toolCall = msg?.tool_calls?.[0];
  const content: ShapedMessage["content"] = [];
  if (toolCall?.function?.name) {
    let input: unknown = {};
    try {
      input = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: toolCall.id || "toolu_openai",
      name: toolCall.function.name,
      input,
    });
  } else {
    content.push({ type: "text", text: msg?.content ?? "" });
  }
  return {
    content,
    stop_reason: mapStopReason(choice?.finish_reason, Boolean(toolCall)),
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

// Join a base URL and the chat-completions path, tolerating a trailing slash and an
// already-included `/v1` (or `/chat/completions`) suffix.
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

// --- The client wrapper -------------------------------------------------------

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

async function dispatch(
  opts: OpenAiCompatOptions,
  req: AnthropicRequest
): Promise<ShapedMessage> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(chatCompletionsUrl(opts.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Local servers ignore the key; a real one needs the bearer.
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(toOpenAiRequest(req)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI-compatible endpoint returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
  const json = (await res.json()) as OpenAiResponse;
  return fromOpenAiResponse(json);
}

// Build a client that presents the Anthropic SDK surface the call sites use. Cast at
// the seam — the call sites only touch messages.create / messages.stream().finalMessage.
export function createOpenAiCompatClient(opts: OpenAiCompatOptions): Anthropic {
  const shim = {
    messages: {
      create: (req: AnthropicRequest) => dispatch(opts, req),
      stream: (req: AnthropicRequest) => ({
        finalMessage: () => dispatch(opts, req),
      }),
    },
  };
  return shim as unknown as Anthropic;
}
