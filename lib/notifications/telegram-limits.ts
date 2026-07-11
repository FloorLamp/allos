// Pure size-guard policy for the Telegram channel (no DB/network, unit-tested in
// lib/__tests__). Telegram rejects a sendMessage whose text exceeds 4096 chars or
// whose inline keyboard carries too many buttons; without a guard an oversized
// message — most plausibly a SAFETY-TIER dose reminder for a big supplement window
// (many lines, each with amount + food-timing + food-drug guidance + streak) —
// fails outright, so `delivered` never flips true, the slot marker is never set,
// and the reminder retries and refails every hour delivering NOTHING (#379).
//
// The policy here NEVER silently drops the actionable buttons: the text is split
// on line boundaries into multiple sends and the keyboard rides the LAST chunk; a
// keyboard that still overflows the button cap keeps its leading (most useful)
// rows and surfaces an explicit "+N more — open the app" overflow line rather than
// dropping doses on the floor. The channel counts on the ESCAPED HTML it actually
// sends (per the issue), so this module operates on already-rendered HTML strings.

// Telegram's hard message cap is 4096 chars; split below it with headroom so the
// appended overflow note (and Telegram's own UTF-16 counting quirks) can't nudge a
// chunk back over the real limit.
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_SPLIT_LIMIT = 4000;

// Telegram caps an inline keyboard at 100 buttons total.
export const TELEGRAM_MAX_BUTTONS = 100;

// Back a hard cut off a few chars so it never lands inside an escaped HTML entity
// (&amp; / &lt; / &gt;) — splitting one would render as literal garbage under
// parse_mode HTML. Entities are short, so a small lookback suffices.
function safeCutPoint(s: string, cut: number): number {
  const amp = s.lastIndexOf("&", cut - 1);
  if (amp >= 0 && amp >= cut - 6) {
    const semi = s.indexOf(";", amp);
    if (semi === -1 || semi >= cut) return amp; // cut before the entity, not through it
  }
  return cut;
}

// Last-resort split of a single line longer than the limit (pathological — normal
// overflow is many short lines). Cuts on a safe boundary so no HTML entity is
// severed; content is preserved in order across the pieces.
function hardSplitLine(line: string, limit: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = safeCutPoint(rest, limit);
    // safeCutPoint can back the cut all the way to 0 for a degenerate line; force
    // forward progress so this can't loop forever.
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// Split rendered-HTML message text into <= `limit`-char chunks on newline
// boundaries so an oversized message is DELIVERED as several sends instead of
// rejected wholesale. A line that is itself longer than the limit is hard-split as
// a last resort. Reassembling the returned chunks with "\n" reproduces the input
// (for the common, no-hard-split case). Only the title line carries a tag
// (<b>...</b>) and is short, so newline splitting never severs a tag.
export function splitTelegramHtml(
  html: string,
  limit = TELEGRAM_SPLIT_LIMIT
): string[] {
  if (html.length <= limit) return [html];

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of html.split("\n")) {
    if (line.length > limit) {
      flush();
      for (const piece of hardSplitLine(line, limit)) chunks.push(piece);
      continue;
    }
    const candidate = current.length > 0 ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks.length > 0 ? chunks : [""];
}

// Trim an inline keyboard to at most `max` buttons, keeping whole rows (a row is
// an atomic group — e.g. a dose's paired ✅ take + ⏭ skip) so a kept row is never
// half-usable. Leading rows are kept (the "✅ All" / highest-priority actions come
// first), and `dropped` reports how many buttons were left off so the caller can
// append an overflow line pointing the user to the app.
export function capTelegramKeyboard<T>(
  keyboard: T[][],
  max = TELEGRAM_MAX_BUTTONS
): { keyboard: T[][]; dropped: number } {
  let count = 0;
  let dropped = 0;
  const out: T[][] = [];
  for (const row of keyboard) {
    if (count + row.length <= max) {
      out.push(row);
      count += row.length;
    } else {
      dropped += row.length;
    }
  }
  return { keyboard: out, dropped };
}
