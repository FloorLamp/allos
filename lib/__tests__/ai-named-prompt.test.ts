import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { runNamedPrompt } from "../ai-named-prompt";
import { buildContent } from "../medical-extract/prompt";

function fakeCapcom(status = 200, stop_reason = "tool_use") {
  const requests: { path: string; body: any }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify(
        path.endsWith("/outcome")
          ? {}
          : {
              text: "A synthetic coaching response",
              json: { results: [] },
              run: "synthetic-run",
              model: "fake",
              stop_reason,
              usage: { input: 12, output: 8 },
              error:
                status === 200
                  ? undefined
                  : "reply truncated at the output limit",
            }
      ),
      {
        status,
        headers: {
          "content-type": "application/json",
          "x-capcom-run": "synthetic-run",
        },
      }
    );
  });
  return {
    requests,
    client: new Anthropic({
      apiKey: "synthetic",
      baseURL: "http://capcom.test",
      fetch,
      maxRetries: 0,
    }),
  };
}

describe("capcom named prompt transport", () => {
  it.each([
    ["image/png", "synthetic.png"],
    ["application/pdf", "synthetic.pdf"],
    ["text/csv", "synthetic.csv"],
  ])(
    "carries %s and bounded vocabulary to extraction",
    async (mime, filename) => {
      const { client, requests } = fakeCapcom();
      const blocks = await buildContent(
        Buffer.from("synthetic document"),
        mime,
        filename,
        Array.from({ length: 401 }, (_, i) => `Marker${i}`)
      );
      const result = await runNamedPrompt(
        client,
        "extraction",
        "heavy-alias",
        16000,
        blocks
      );
      expect(result.message.content[0]).toMatchObject({
        type: "tool_use",
        input: { results: [] },
      });
      expect(result.message.usage).toMatchObject({
        input_tokens: 12,
        output_tokens: 8,
      });
      const request = requests[0];
      expect(request.path).toBe("/v1/prompts/allos/extraction/run");
      expect(request.body).toMatchObject({
        model: "heavy-alias",
        maxTokens: 16000,
        caller: "extraction",
      });
      expect(JSON.stringify(request.body)).toContain("Marker399");
      expect(JSON.stringify(request.body)).not.toContain("Marker400");
      if (mime === "image/png")
        expect(request.body.images).toEqual([
          {
            data: `data:image/png;base64,${Buffer.from("synthetic document").toString("base64")}`,
          },
        ]);
      if (mime === "application/pdf")
        expect(request.body.content[0]).toMatchObject({
          type: "document",
          source: { media_type: mime },
        });
      await result.reportOutcome("changed");
      expect(requests[1]).toEqual({
        path: "/v1/runs/synthetic-run/outcome",
        body: { effect: "changed" },
      });
    }
  );

  it("returns insight text and sends the caller's context unchanged", async () => {
    const { client, requests } = fakeCapcom(200, "end_turn");
    const context = "<untrusted>Invented condition</untrusted>";
    const result = await runNamedPrompt(client, "insight", "fast", 600, [
      { type: "text", text: context },
    ]);
    expect(result.message.content).toEqual([
      { type: "text", text: "A synthetic coaching response" },
    ]);
    expect(requests[0]).toMatchObject({
      path: "/v1/prompts/allos/insight/run",
      body: { input: context },
    });
  });

  it.each([200, 502])(
    "rejects truncation and reports no effect (HTTP %s)",
    async (status) => {
      const { client, requests } = fakeCapcom(status, "max_tokens");
      await expect(
        runNamedPrompt(client, "extraction", "default", 16000, [])
      ).rejects.toThrow();
      expect(requests.at(-1)).toEqual({
        path: "/v1/runs/synthetic-run/outcome",
        body: { effect: "no-op" },
      });
    }
  );
});
