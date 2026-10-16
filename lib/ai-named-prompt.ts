import type Anthropic from "@anthropic-ai/sdk";

interface PromptReply {
  text: string;
  json?: unknown;
  stop_reason: string | null;
  model: string;
  run: string;
  usage: { input: number; output: number };
}

// Use the resolved tier's SDK for authentication, timeout and HTTP errors too.
export async function runNamedPrompt(
  client: Anthropic,
  name: "extraction" | "insight",
  model: string,
  maxTokens: number,
  blocks: Anthropic.ContentBlockParam[]
) {
  const images: { data: string }[] = [];
  const content = blocks
    .map((block) => {
      if (block.type === "image" && block.source.type === "base64") {
        images.push({
          data: `data:${block.source.media_type};base64,${block.source.data}`,
        });
        return null;
      }
      return block;
    })
    .filter((block) => block !== null);
  let run: string | undefined;
  const reportOutcome = async (effect: "changed" | "no-op") => {
    if (!run) return;
    try {
      await client.post(`/v1/runs/${encodeURIComponent(run)}/outcome`, {
        body: { effect },
        timeout: 5_000,
        maxRetries: 0,
      });
    } catch {
      // Outcome telemetry must not discard a usable answer.
    }
  };
  try {
    const reply = await client.post<PromptReply>(
      `/v1/prompts/allos/${name}/run`,
      {
        body: {
          model,
          maxTokens,
          caller: name,
          ...(name === "insight"
            ? {
                input: blocks
                  .filter(
                    (block): block is Anthropic.TextBlockParam =>
                      block.type === "text"
                  )
                  .map((block) => block.text)
                  .join("\n"),
              }
            : { content, images }),
        },
        timeout: 600_000,
      }
    );
    run = reply.run;
    if (reply.stop_reason === "max_tokens" || reply.stop_reason === "length") {
      throw new Error("Reply truncated at the output limit");
    }
    const message = {
      content:
        name === "extraction"
          ? [{ type: "tool_use", name: "save_medical_data", input: reply.json }]
          : [{ type: "text", text: reply.text }],
      stop_reason: reply.stop_reason,
      usage: {
        input_tokens: reply.usage.input,
        output_tokens: reply.usage.output,
      },
    } as Anthropic.Message;
    return { message, reportOutcome };
  } catch (error) {
    if (error && typeof error === "object" && "headers" in error) {
      run = (error.headers as Headers | undefined)?.get("x-capcom-run") ?? run;
    }
    await reportOutcome("no-op");
    throw error;
  }
}
