// THE REPLY-MARKER FAMILY (issue #2961 step 2) — `/temp` and `/weight`.
//
// The second per-family token module, carved off `callback-tokens.ts`'s leaf. These two
// are one family and not two adjacent ones: both send a PROMPT whose body carries a
// marker naming the profile, the person REPLIES to it, and the handler attributes the
// reply from that marker in `reply_to_message.text`. `callback-data.ts` used to state
// that argument twice, once per section, which is the tell.
//
// NOTHING IS IMPORTED HERE, and that is the property to keep rather than a coincidence
// of what moved first: a marker is a string a prompt carries and a parser is a rule for
// reading one back, so this module can be a leaf the way `callback-tokens.ts` is. A file
// in the token layer that grows an import is a file that can be in a cycle again (#2961
// AC 3), and the guard that would catch it is `notification-import-cycles.test.ts`.
//
// NO GRAMMAR MOVED. Every marker is the same string it has always been and every parser
// is the same rule, including `parseTempReply`'s 45° auto-detect boundary — a prompt
// sitting in somebody's chat from last week still attributes, and a reply to it still
// reads. Only the declaration site changed.

// ---- Temperature reply quick-log (#859 item 5) ----------------------------------
//
// `/temp` sends a prompt whose body carries a "(#temp:<profileId>)" marker; the user
// REPLIES to it with a reading. The reply handler extracts the profile from the marker
// (in reply_to_message.text) and the value from the reply body. No server-side pending
// state — the marker rides the prompt message, so the flow is stateless like every
// other inbound Telegram flow.

// The marker embedded in a `/temp` prompt body so a reply can be attributed.
export function tempReplyMarker(profileId: number): string {
  return `(#temp:${profileId})`;
}

// Extract the profile id a reply targets from the prompted message text, or null.
export function parseTempReplyMarker(
  replyToText: string | null | undefined
): number | null {
  if (!replyToText) return null;
  const m = /\(#temp:(\d+)\)/.exec(replyToText);
  if (!m) return null;
  const id = Number(m[1]);
  return id > 0 ? id : null;
}

// Parse a temperature reply body ("38.5", "101F", "38,5 c") into a value + unit. An
// explicit C/F suffix wins; a bare number auto-detects (human body temps never overlap
// across scales below 45° — °C readings sit ~35–42, °F ~95–108), since a Telegram chat
// carries no #857 login unit preference. Returns null when there's no parseable number.
export function parseTempReply(
  body: string | null | undefined
): { value: number; unit: "C" | "F" } | null {
  if (!body) return null;
  const m = /(-?\d+(?:[.,]\d+)?)\s*(°?\s*[cCfF])?/.exec(body.trim());
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const suffix = (m[2] ?? "").replace(/[^cCfF]/g, "").toUpperCase();
  const unit: "C" | "F" =
    suffix === "C" || suffix === "F"
      ? (suffix as "C" | "F")
      : value < 45
        ? "C"
        : "F";
  return { value, unit };
}

// ---- Weight reply quick-log (#1895) -----------------------------------------
//
// The `/temp` prompt-reply pattern, one quantity over: `/weight` sends a prompt whose
// body carries a "(#weight:<profileId>)" marker and the user REPLIES with a number. The
// same statelessness argument applies — the marker rides the prompt, so nothing
// server-side has to remember who was asked — and the same attribution guarantee: a
// multi-profile chat gets one named prompt each, and a reply resolves to the profile its
// prompt named rather than to whoever sorts first.
//
// The VALUE is parsed by the palette's `parseWeightEntry` (lib/palette-quick-log), which
// is also the parser behind `weight 82.5` in the command palette — one grammar for the
// same one-liner, and one range guard. A chat carries no login unit preference, so the
// unit defaults to canonical kg per the notification unit policy; an explicit "lb"
// suffix still wins, and the conversion happens server-side at the write like every
// other boundary.

export function weightReplyMarker(profileId: number): string {
  return `(#weight:${profileId})`;
}

export function parseWeightReplyMarker(
  replyToText: string | null | undefined
): number | null {
  if (!replyToText) return null;
  const m = /\(#weight:(\d+)\)/.exec(replyToText);
  if (!m) return null;
  const id = Number(m[1]);
  return id > 0 ? id : null;
}
