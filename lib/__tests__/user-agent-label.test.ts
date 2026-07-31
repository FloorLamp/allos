import { describe, it, expect } from "vitest";
import { deviceLabel } from "../user-agent-label";

// The device label behind the Active sessions list (#1451.A). The bug it fixes is
// that raw UAs are near-identical in their first 30 characters, so a truncated list
// gave every row the same text. The tests that matter are therefore the ORDERING
// ones: UA strings lie for compatibility (every Chromium claims "Safari", Edge also
// claims "Chrome", an Android UA also contains "Linux"), and a naive matcher
// collapses distinct devices back into one label.

describe("deviceLabel", () => {
  it("labels Chrome on Linux", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      ).label
    ).toBe("Chrome · Linux");
  });

  it("labels Safari on macOS without being fooled by Chromium's Safari token", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
      ).label
    ).toBe("Safari · macOS");
  });

  it("prefers Edge over the Chrome token it also carries", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
      ).label
    ).toBe("Edge · Windows");
  });

  it("prefers Opera over the Chrome token it also carries", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0"
      ).browser
    ).toBe("Opera");
  });

  it("labels Android rather than the Linux token it also carries", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
      ).label
    ).toBe("Chrome · Android");
  });

  it("labels Chrome on iOS by its CriOS token", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1"
      ).label
    ).toBe("Chrome · iPhone");
  });

  it("labels Safari on iPhone", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
      ).label
    ).toBe("Safari · iPhone");
  });

  it("labels Firefox on Windows", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0"
      ).label
    ).toBe("Firefox · Windows");
  });

  it("labels an iPad", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1"
      ).platform
    ).toBe("iPad");
  });

  it("gives distinct labels to two rows a truncated raw UA would have merged", () => {
    // The exact #1451.A failure: both of these render as
    // "Mozilla/5.0 (X11; Linux x…" when truncated.
    const a = deviceLabel(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ).label;
    const b = deviceLabel(
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
    ).label;
    expect(a).not.toBe(b);
  });

  it("falls back to the platform when the browser is unrecognized", () => {
    expect(deviceLabel("SomeBot/1.0 (Windows NT 10.0)").label).toBe("Windows");
  });

  it("keeps an unrecognized client's leading token rather than erasing it", () => {
    expect(deviceLabel("allos-sync-agent/2.1").label).toBe(
      "allos-sync-agent/2.1"
    );
  });

  it("handles a missing or empty user agent", () => {
    expect(deviceLabel(null).label).toBe("Unknown device");
    expect(deviceLabel(undefined).label).toBe("Unknown device");
    expect(deviceLabel("   ").label).toBe("Unknown device");
  });

  it("degrades to Unknown device for an absurdly long unrecognized token", () => {
    expect(deviceLabel("x".repeat(500)).label).toBe("Unknown device");
  });
});
