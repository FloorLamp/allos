import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { setTierConfigProvider } from "@/lib/ai-client";
import { resolveTaskClient } from "@/lib/ai-resolve";
import { getTierConfigs, setTierConfig } from "@/lib/settings/ai-tiers";
import { migratedDb } from "./migrated-db";

it("sends configured capcom aliases, authentication and Heavy images to /v1/messages", async () => {
  const requests: {
    url: string | undefined;
    key: string | string[] | undefined;
    body: unknown;
  }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      key: req.headers["x-api-key"],
      body: JSON.parse(body),
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "fake",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "fake",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  const db = migratedDb();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fake capcom address");
  const image = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data: "c3ludGhldGlj",
    },
  };
  try {
    for (const [tier, model] of [
      ["heavy", "default"],
      ["light", "fast"],
    ] as const) {
      setTierConfig(db, tier, {
        apiShape: "anthropic",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "capcom_synthetic",
        model,
      });
    }
    setTierConfigProvider(() => getTierConfigs(db));
    for (const task of ["extraction", "insight"] as const) {
      const resolved = resolveTaskClient(task)!;
      await resolved.client.messages.create({
        model: resolved.model,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content:
              task === "extraction"
                ? [image, { type: "text", text: "Synthetic fixture" }]
                : "Synthetic fixture",
          },
        ],
      });
    }
    expect(requests).toMatchObject([
      {
        url: "/v1/messages",
        key: "capcom_synthetic",
        body: {
          model: "default",
          messages: [{ content: [image, { type: "text" }] }],
        },
      },
      { url: "/v1/messages", key: "capcom_synthetic", body: { model: "fast" } },
    ]);
  } finally {
    setTierConfigProvider(null);
    db.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
