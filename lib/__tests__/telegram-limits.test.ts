import { describe, it, expect } from "vitest";
import {
  splitTelegramHtml,
  capTelegramKeyboard,
  TELEGRAM_SPLIT_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_MAX_BUTTONS,
} from "@/lib/notifications/telegram-limits";

describe("splitTelegramHtml", () => {
  it("returns a single chunk when the text fits under the limit", () => {
    const html = "<b>💊 Morning</b>\n• Vitamin D\n• Magnesium";
    expect(splitTelegramHtml(html)).toEqual([html]);
  });

  it("keeps a message exactly at the limit as one chunk (boundary)", () => {
    const html = "a".repeat(TELEGRAM_SPLIT_LIMIT);
    expect(splitTelegramHtml(html)).toEqual([html]);
  });

  it("splits a many-line message on line boundaries, each chunk within the limit", () => {
    // 200 lines of 30 chars → ~6200 chars, well over the split limit.
    const lines = Array.from(
      { length: 200 },
      (_, i) => `• item ${String(i).padStart(3, "0")} ${"x".repeat(18)}`
    );
    const html = lines.join("\n");
    const chunks = splitTelegramHtml(html, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // No content is lost: rejoining reproduces the original (line-boundary split).
    expect(chunks.join("\n")).toBe(html);
    // Every chunk stays under Telegram's true hard cap.
    for (const c of chunks)
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it("hard-splits a single line longer than the limit without losing content", () => {
    const line = "z".repeat(TELEGRAM_SPLIT_LIMIT * 2 + 37);
    const chunks = splitTelegramHtml(line, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(line);
  });

  it("never cuts through an escaped HTML entity when hard-splitting", () => {
    // Place a '&amp;' so a naive cut at the limit would land mid-entity.
    const limit = 20;
    const line = "x".repeat(limit - 2) + "&amp;" + "y".repeat(limit);
    const chunks = splitTelegramHtml(line, limit);
    // No chunk may start or end mid-entity: the '&amp;' must live wholly in one chunk.
    const joined = chunks.join("");
    expect(joined).toBe(line);
    for (const c of chunks) {
      // A chunk ending in a bare '&' or a dangling entity prefix would be a break.
      expect(c.endsWith("&")).toBe(false);
      expect(/&(a(m(p)?)?|l(t)?|g(t)?)$/.test(c)).toBe(false);
    }
  });
});

describe("capTelegramKeyboard", () => {
  const row = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`);

  it("leaves a small keyboard untouched", () => {
    const kb = [row(1), row(2), row(2)];
    const { keyboard, dropped } = capTelegramKeyboard(kb);
    expect(keyboard).toEqual(kb);
    expect(dropped).toBe(0);
  });

  it("keeps a keyboard exactly at the cap (boundary)", () => {
    const kb = Array.from({ length: TELEGRAM_MAX_BUTTONS }, () => row(1));
    const { keyboard, dropped } = capTelegramKeyboard(kb);
    expect(keyboard.length).toBe(TELEGRAM_MAX_BUTTONS);
    expect(dropped).toBe(0);
  });

  it("drops whole rows past the cap and reports the dropped count", () => {
    // 60 rows of 2 buttons = 120 buttons; cap 100 → keep 50 rows, drop 10 rows (20).
    const kb = Array.from({ length: 60 }, () => row(2));
    const { keyboard, dropped } = capTelegramKeyboard(kb, 100);
    const kept = keyboard.reduce((n, r) => n + r.length, 0);
    expect(kept).toBeLessThanOrEqual(100);
    expect(kept + dropped).toBe(120);
    expect(dropped).toBe(20);
    // Rows are kept intact (never half a row).
    for (const r of keyboard) expect(r.length).toBe(2);
    // Leading rows are the ones kept (most useful actions come first).
    expect(keyboard[0]).toEqual(kb[0]);
  });
});
