// The "Test connection" probe behind each tier's button on Settings → Server (#875).
// A tiny ping through the resolver: confirm the tier's endpoint answers with its
// model, and — for the Heavy tier, which handles document extraction — probe whether
// it accepts an image, so a blind model is caught BEFORE it silently misroutes a
// vision job to garbage.
//
// Auth-blind (the admin gate lives in the Server Action that calls this). Degrades
// gracefully: an unconfigured tier returns a "not configured" result rather than
// throwing, so the keyless path (and CI) surfaces the honest degradation.

import { resolveTierClient } from "./ai-resolve";
import { taskNeedsVision, type TierName } from "./ai-tiers";
import { createLogger } from "./log";

const log = createLogger("ai-probe");

// A 1×1 transparent PNG — the smallest valid image, for the vision-capability probe.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface TierProbeResult {
  ok: boolean;
  tier: TierName;
  model?: string;
  // Whether the endpoint accepted an image call: true / false (a vision-required tier
  // that rejected the image) / null (not probed — a non-vision tier).
  visionCapable: boolean | null;
  message: string;
}

// Extract the plain text from an Anthropic-shaped message (SDK or shim).
function textOf(msg: unknown): string {
  const blocks = (msg as { content?: Array<{ type?: string; text?: string }> })
    ?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b?.type === "text")
    .map((b) => b?.text ?? "")
    .join("")
    .trim();
}

export async function probeTier(tier: TierName): Promise<TierProbeResult> {
  const resolved = resolveTierClient(tier);
  if (!resolved) {
    return {
      ok: false,
      tier,
      visionCapable: null,
      message:
        "Not configured — add an API key or a base URL for this tier, then save before testing.",
    };
  }
  const { client, model } = resolved;

  // 1) Text ping — proves the endpoint + model answer at all.
  try {
    await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok." }],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    log.warn("tier text probe failed", { tier, model, err: detail });
    return {
      ok: false,
      tier,
      model,
      visionCapable: null,
      message: `Couldn't reach ${model}: ${detail}`,
    };
  }

  // 2) Vision probe (Heavy only) — extraction needs an image-capable model.
  if (!taskNeedsVision("extraction") || tier !== "heavy") {
    return {
      ok: true,
      tier,
      model,
      visionCapable: null,
      message: `Connected — ${model} responded.`,
    };
  }

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply 'ok' if you can see this image." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: TINY_PNG_BASE64,
              },
            },
          ] as never,
        },
      ],
    });
    // A model that answered the image call is vision-capable enough for extraction.
    void textOf(msg);
    return {
      ok: true,
      tier,
      model,
      visionCapable: true,
      message: `Connected — ${model} responded and accepts images.`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    log.warn("tier vision probe failed", { tier, model, err: detail });
    return {
      // Text works, but extraction will fail on a blind model — surface it as not-ok
      // so the admin fixes it before uploading a document.
      ok: false,
      tier,
      model,
      visionCapable: false,
      message: `${model} answered text but rejected an image — document extraction will fail. Choose a vision-capable model for the Heavy tier.`,
    };
  }
}
