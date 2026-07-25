// Turn a raw User-Agent string into a short "Chrome · Linux"-style device label
// (issue #1451.A).
//
// Why this exists: the Active sessions card rendered the raw UA and truncated it,
// which meant every row on a Linux desktop read the identical
// "Mozilla/5.0 (X11; Linux x…" — even at desktop width, where the card had room.
// With 22 uncollapsed rows, the timestamps were the ONLY differentiator and a
// per-row "Revoke" was guesswork. A short browser + platform label is the smallest
// thing that makes rows distinguishable at a glance.
//
// Deliberately a small heuristic, not a UA-parsing library: it must be pure (unit
// tested, no network, no data files), and being wrong is cosmetic — the timestamps
// and the "This device" badge remain authoritative. Order matters throughout,
// because UA strings lie for compatibility: every Chromium browser claims "Safari",
// Edge also claims "Chrome", and Chrome on iOS calls itself "CriOS".

export type DeviceLabel = {
  browser: string | null;
  platform: string | null;
  // The display string: "Chrome · Linux", "Safari · iPhone", or a fallback.
  label: string;
};

const UNKNOWN = "Unknown device";

// Browser matchers, MOST-SPECIFIC FIRST — a later entry only wins if no earlier one
// matched. Edge/Opera/Samsung must precede Chrome (they all carry "Chrome"), and
// Chrome must precede Safari (Chromium carries "Safari").
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdgA?\/|\bEdge\//i, "Edge"],
  [/\bOPR\/|\bOpera\//i, "Opera"],
  [/\bSamsungBrowser\//i, "Samsung Internet"],
  [/\bVivaldi\//i, "Vivaldi"],
  [/\bBrave\//i, "Brave"],
  [/\bCriOS\//i, "Chrome"],
  [/\bFxiOS\//i, "Firefox"],
  [/\bFirefox\/|\bGecko\/\d/i, "Firefox"],
  [/\bChromium\//i, "Chromium"],
  [/\bChrome\//i, "Chrome"],
  [/\bSafari\//i, "Safari"],
  [/^curl\/|\bcurl\//i, "curl"],
];

// Platform matchers, most-specific first. iPadOS 13+ reports "Macintosh", so a
// touch-capable Mac is indistinguishable here — that ambiguity is acceptable for a
// label whose job is only to tell two rows apart.
const PLATFORMS: readonly [RegExp, string][] = [
  [/\biPhone\b/i, "iPhone"],
  [/\biPad\b/i, "iPad"],
  [/\bAndroid\b/i, "Android"],
  [/\bCrOS\b/i, "ChromeOS"],
  [/\bWindows Phone\b/i, "Windows Phone"],
  [/\bWindows NT\b|\bWin64\b|\bWindows\b/i, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/i, "macOS"],
  // X11/Linux LAST: an Android UA also contains "Linux".
  [/\bX11\b|\bLinux\b/i, "Linux"],
];

function firstMatch(
  ua: string,
  table: readonly [RegExp, string][]
): string | null {
  for (const [re, name] of table) {
    if (re.test(ua)) return name;
  }
  return null;
}

export function deviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = (userAgent ?? "").trim();
  if (ua === "") return { browser: null, platform: null, label: UNKNOWN };
  const browser = firstMatch(ua, BROWSERS);
  const platform = firstMatch(ua, PLATFORMS);
  if (browser && platform)
    return { browser, platform, label: `${browser} · ${platform}` };
  if (browser) return { browser, platform: null, label: browser };
  if (platform) return { browser: null, platform, label: platform };
  // Nothing recognized: show a trimmed head of the raw string rather than
  // "Unknown device", so an unusual client (a script, a new browser) is still
  // distinguishable from a genuinely missing UA.
  const head = ua.split(/\s+/)[0] ?? "";
  return {
    browser: null,
    platform: null,
    label: head.length > 0 && head.length <= 40 ? head : UNKNOWN,
  };
}
