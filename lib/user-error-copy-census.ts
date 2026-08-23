// THE RULE BEHIND #3198's GUARD, as a pure function over one file's source, so the
// scan can be run over sources authored to BREAK it as well as over the tree.
//
// The static half of the user-copy problem is #3071's: authored jargon, catchable by
// reading string literals. This is the DYNAMIC half, and no literal scan reaches it —
// the text is minted at runtime by code that never considered a reader, which is how
// `UNIQUE constraint failed: activity_segment_efforts.profile_id, …` came to sit on a
// settings page for a week.
//
// THE RULE: a caught error's own text (`err.message`, `String(err)`, `${err}`) may not
// flow into a returned or persisted string. Its homes are the operator log and a
// thrown Error — both of which a reader never sees — or `lib/user-error-copy.ts`,
// which translates it.
//
// WHAT COUNTS AS A HOME, and why each is by MECHANISM rather than by convention:
//
//   * `log.error/warn/info/debug/trace(…)` and `console.*(…)` — the admin error log,
//     which redacts on the way in (lib/error-log-format.ts).
//   * `throw new …Error(…)` — Next masks a thrown Server Action error to a generic
//     message (#478), and lib/import-persist.ts deliberately names the failing table
//     in one so an operator can find it (#1808).
//   * `recordAiEvent(…)` — the AI log, an operator surface with its own viewer.
//
// Each is matched as a CALL EXPRESSION with balanced parentheses, not as a line
// prefix, because every one of these is routinely written across several lines and a
// line-anchored test reports a sweep it never took.

export interface RawErrorSite {
  line: number;
  text: string;
}

// The shapes a caught error's own text is spelled in here. `String(err)` and the
// template interpolation are included because they are the two ways round
// `err.message` that read identically at the sink.
//
// The identifier is captured, because `e` is BOTH the usual name for a caught error
// and the usual name for a row in a `.map()`. Without the binding check below, this
// pattern flags `{e.message}` in the admin error-log and notify-log VIEWERS — which
// render a stored log line's own `message` field, are operator surfaces by design,
// and would each have needed an allowlist entry justifying a false positive. A guard
// that cries wolf on the log viewer is a guard somebody deletes.
const RAW_ERROR =
  /\b(err|error|e)\s*\.\s*(?:message|stack)\b|\bString\s*\(\s*(err|error|e)\s*\)|\$\{\s*(err|error|e)\s*\}/g;

// Is this identifier bound by a `catch` clause anywhere in the file? File-grain on
// purpose: a name bound by a catch somewhere is a caught error wherever it is read,
// and the alternative is a scope analysis this rule does not need.
function boundByCatch(code: string, name: string): boolean {
  return new RegExp(`catch\\s*\\(\\s*${name}\\b`).test(code);
}

// Call heads whose ARGUMENTS are an operator surface, not user copy.
const INTERNAL_CALL =
  /\b(?:console\s*\.\s*\w+|log\s*\.\s*(?:error|warn|info|debug|trace)|throw\s+new\s+\w*Error|recordAiEvent)\s*\(/g;

// Replace comments with same-length whitespace so every offset below still points at
// the byte it did in the original file, and a line number is still a line number.
function blankComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (m, lead: string) => lead + blank(m.slice(lead.length))
    );
}

// [start, end) of every internal call expression, by matching its parentheses.
// Quotes are tracked so a `)` inside a string cannot close the call early.
function internalRanges(code: string): [number, number][] {
  const ranges: [number, number][] = [];
  INTERNAL_CALL.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = INTERNAL_CALL.exec(code)) !== null) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    let quote = "";
    let i = open;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([head.index, Math.min(i + 1, code.length)]);
    INTERNAL_CALL.lastIndex = Math.min(i + 1, code.length);
  }
  return ranges;
}

export function rawErrorCopySites(source: string): RawErrorSite[] {
  const code = blankComments(source);
  const ranges = internalRanges(code);
  const inside = (at: number) =>
    ranges.some(([start, end]) => at >= start && at < end);
  const lineStarts: number[] = [0];
  for (let i = 0; i < code.length; i++)
    if (code[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const sites: RawErrorSite[] = [];
  RAW_ERROR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_ERROR.exec(code)) !== null) {
    if (inside(m.index)) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? "";
    if (!boundByCatch(code, name)) continue;
    const line = lineOf(m.index);
    // One site per LINE: a `x instanceof Error ? x.message : String(x)` is two
    // matches saying the same thing, and reporting it twice makes an allowlist look
    // twice as long as the problem is.
    if (sites.some((s) => s.line === line + 1)) continue;
    const text = source.split("\n")[line] ?? "";
    sites.push({ line: line + 1, text: text.trim() });
  }
  return sites;
}
