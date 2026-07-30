// The message-body RICH-TEXT SEAM (issue #1720) — pure, no DB/network.
//
// WHY IT EXISTS. The Telegram chokepoint escapes the ENTIRE body
// (`renderMessageHtml` = `<b>${esc(title)}</b>\n${esc(body)}`), which is exactly the
// security property we want for user-influenced text (names, notes, group labels must
// never reach Telegram as markup) — but it also meant NO builder could emit emphasis
// even deliberately. Every multi-line message was a flat wall by construction, not by
// choice, and the specced formatting work (#1710 food nudge, #1712 digest, #1722's
// sweep) had nothing to build on.
//
// THE SHAPE (option 1 of the issue — escaped-by-construction segments). A body is
// either a plain `string` (unchanged, still escaped wholesale) or a `RichText`: an
// ordered list of RUNS, each carrying its own text plus the emphasis flags the
// BUILDER declared. The renderer escapes every run's text and assembles the markup
// AROUND the already-escaped text, so:
//
//   • misuse is impossible by type — a builder never writes a tag, it declares a run,
//     and interpolated user text lands in a run's `text` where escaping still applies;
//   • CHANNEL PARITY is free — Web Push and Home Assistant read `plainBody()`, which
//     is the run texts concatenated: one expression of emphasis, channels degrade
//     rather than fork;
//   • BACK-COMPAT is byte-identical — a plain-string body normalizes to a single
//     unstyled run and renders exactly as `esc(body)` did.
//
// NEWLINE DISCIPLINE. A run's text may contain newlines, but the renderer emits its
// tags PER LINE (see telegram-render), so a tag never spans a "\n". That is what keeps
// `splitTelegramHtml`'s line-boundary splitting provably tag-safe: every chunk it
// produces has balanced tags.

// One styled run of body text. The flags are what the BUILDER declared; the renderer
// turns them into markup on channels that support it and drops them everywhere else.
export interface RichSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

// A body composed of styled runs. Branded with a literal marker rather than a class so
// it survives module duplication (vitest, bundlers) and stays a plain serializable
// object.
export interface RichText {
  readonly __richText: true;
  readonly spans: readonly RichSpan[];
}

// What a NotificationMessage's `body` may be. `string` remains the overwhelmingly
// common case and means "plain text, escaped wholesale" exactly as before.
export type MessageBody = string | RichText;

// A value acceptable inside `rich` interpolation: plain text (escaped later), a
// declared run, a nested RichText, or nullish (dropped, so a conditional fragment
// reads naturally).
export type RichPart =
  | string
  | number
  | RichSpan
  | RichText
  | null
  | undefined;

export function isRichText(value: unknown): value is RichText {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __richText?: unknown }).__richText === true &&
    Array.isArray((value as { spans?: unknown }).spans)
  );
}

function isRichSpan(value: unknown): value is RichSpan {
  return (
    typeof value === "object" &&
    value !== null &&
    !isRichText(value) &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

// ---- Declaring emphasis ----------------------------------------------------------
//
// Builders call these, never write tags. `bold("107 g")` is a run, not a string, so it
// cannot be concatenated into a plain body by accident — the type stops it.

export function bold(text: string): RichSpan {
  return { text, bold: true };
}

export function italic(text: string): RichSpan {
  return { text, italic: true };
}

export function code(text: string): RichSpan {
  return { text, code: true };
}

// Merge adjacent runs sharing a style and drop empty ones, so the rendered markup is
// tidy and two equal bodies compare equal regardless of how they were assembled.
function normalize(spans: readonly RichSpan[]): RichSpan[] {
  const out: RichSpan[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const style = {
      ...(span.bold ? { bold: true } : {}),
      ...(span.italic ? { italic: true } : {}),
      ...(span.code ? { code: true } : {}),
    };
    const prev = out[out.length - 1];
    if (
      prev &&
      !!prev.bold === !!style.bold &&
      !!prev.italic === !!style.italic &&
      !!prev.code === !!style.code
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + span.text };
      continue;
    }
    out.push({ text: span.text, ...style });
  }
  return out;
}

function partSpans(part: RichPart): RichSpan[] {
  if (part == null) return [];
  if (typeof part === "string") return part ? [{ text: part }] : [];
  if (typeof part === "number") return [{ text: String(part) }];
  if (isRichText(part)) return [...part.spans];
  if (isRichSpan(part)) return [part];
  return [];
}

// Assemble a RichText from an ordered list of parts.
export function richFrom(parts: readonly RichPart[]): RichText {
  const spans: RichSpan[] = [];
  for (const part of parts) spans.push(...partSpans(part));
  return { __richText: true, spans: normalize(spans) };
}

// The ergonomic builder form:
//
//   rich`Protein · ${bold("at least 107 g")} of ~80–105 g — goal reached`
//
// Literal segments are plain text; interpolated values are plain text UNLESS they are
// declared runs. Nothing here can produce markup, so an interpolated user-supplied
// name is still just text that the renderer escapes.
export function rich(
  strings: TemplateStringsArray,
  ...values: RichPart[]
): RichText {
  const parts: RichPart[] = [];
  strings.forEach((literal, i) => {
    parts.push(literal);
    if (i < values.length) parts.push(values[i]);
  });
  return richFrom(parts);
}

// ---- Reading a body --------------------------------------------------------------

// The body's runs, with a plain string normalized to one unstyled run. The single
// accessor every renderer uses, so string and rich bodies can't take different paths.
export function bodySpans(body: MessageBody): readonly RichSpan[] {
  return typeof body === "string"
    ? body
      ? [{ text: body }]
      : []
    : body.spans;
}

// The body as PLAIN TEXT — the exact content Web Push and Home Assistant carry, and
// what any length/really-plain check should measure. Emphasis is dropped, never the
// words: the status words live in the text, so meaning survives on every channel.
export function plainBody(body: MessageBody): string {
  return typeof body === "string"
    ? body
    : body.spans.map((s) => s.text).join("");
}

// Join body fragments with a separator, staying a plain string when every fragment is
// plain (so nothing becomes "rich" merely by being composed) and becoming RichText as
// soon as any fragment declares emphasis. Empty fragments are dropped.
export function joinBody(
  parts: readonly (MessageBody | null | undefined)[],
  separator = "\n"
): MessageBody {
  const present = parts.filter(
    (p): p is MessageBody => p != null && plainBody(p) !== ""
  );
  if (present.length === 0) return "";
  if (present.every((p) => typeof p === "string")) {
    return (present as string[]).join(separator);
  }
  const seq: RichPart[] = [];
  present.forEach((part, i) => {
    if (i > 0) seq.push(separator);
    seq.push(typeof part === "string" ? part : part);
  });
  return richFrom(seq);
}
