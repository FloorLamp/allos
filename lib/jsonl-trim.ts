// Byte-budgeted self-trim for the append-only JSONL logs (issue #1841), shared
// by both sinks (lib/ai-log.ts, lib/error-log.ts). Pure — no fs — so the
// convergence property is unit-testable.
//
// Why bytes AND lines: the old trim kept a fixed line count (2000), but a line
// of free text is capped near 4KB, so 2000 fat lines ≈ 8MB — still over the 5MB
// trigger. Once a file crossed the trigger with fat lines, the line-count trim
// never brought it back under, and EVERY subsequent append synchronously
// rewrote a multi-MB file on the request path. The kept tail must therefore fit
// a byte budget too, and the sinks pass a budget WELL UNDER the trigger so the
// appends between rewrites amortize — trimming to exactly the trigger would
// rewrite again on the very next append.

// The newest non-empty lines, in order (oldest→newest of the kept set), whose
// count fits `maxLines` AND whose serialized size (each line + its trailing
// "\n") fits `maxBytes`.
export function trimJsonlLines(
  lines: string[],
  maxLines: number,
  maxBytes: number
): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (kept.length >= maxLines || bytes + lineBytes > maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.reverse();
}
