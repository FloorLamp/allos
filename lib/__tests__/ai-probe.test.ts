import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { probeTier } from "../ai-probe";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../ai-resolve", () => ({
  resolveTierClient: () => ({
    model: "gpt-5.6-luna",
    client: { messages: { create } },
  }),
}));
vi.mock("../log", () => ({ createLogger: () => ({ warn: vi.fn() }) }));

describe("Heavy image probe", () => {
  it("sends a decodable PNG and reports image acceptance", async () => {
    create.mockReset().mockResolvedValue({ content: [] });
    create.mockImplementationOnce(async () => ({ content: [] }));
    create.mockImplementationOnce(async (request) => {
      const image = request.messages[0].content[1];
      const { data, info } = await sharp(
        Buffer.from(image.source.data, "base64")
      )
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 32, height: 32, channels: 3 });
      expect([...data.subarray(0, 3)]).toEqual([255, 0, 0]);
      return { content: [{ type: "text", text: "ok" }] };
    });
    expect(await probeTier("heavy")).toMatchObject({
      ok: true,
      visionCapable: true,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("preserves the image error instead of diagnosing missing vision support", async () => {
    create.mockReset().mockResolvedValueOnce({ content: [] });
    create.mockRejectedValueOnce(new Error("HTTP 429: rate limit exceeded"));
    expect(await probeTier("heavy")).toMatchObject({
      ok: false,
      message:
        "gpt-5.6-luna answered text, but the image test failed: HTTP 429: rate limit exceeded",
    });
  });
});
