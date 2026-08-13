// Column liveness for the kind × channel routing matrix (#2565 part B). PURE: no DB,
// no clock, no network, no React.
//
// WHAT WAS WRONG. The matrix asks "which kinds go to which channel", and on a fresh
// instance it answered with ~56 boxes checked at FULL INK — identical to boxes that
// would actually be sent — under column headers whose only disclosure was 10px grey
// "not set up" text. The grid stated INTENT and was silent about OUTCOME, which is the
// one thing a reader takes from a checked box.
//
// THE THREE-WAY READING this module exists to make possible, and its inequality:
//
//     live  = ticked, and this channel is set up          → it goes out on this channel
//     ghost = ticked, and this channel is NOT set up      → a KEPT preference, waiting
//     off   = not ticked                                   → the user turned it off
//
//   ghost ≠ off is the whole point. Hiding a dead column, or rendering its kept ticks
//   as blanks, would make "you set this and it is waiting on one setup step" look
//   identical to "you turned this off" — and the second is a decision the user made.
//   Nothing here writes: a ghost is a RENDER of a stored tick, and configuring the
//   channel later brings the same ticks back live with no migration and no re-tick.
//
// WHY "set up" AND NOT "delivering". The issue's mockup captions a live column
// `● delivering`. This module deliberately does not say that word. Whether a channel is
// actually DELIVERING is a question about `notify_lifecycle` and belongs to
// `lib/notifications/delivery-status.ts`; a green light that means "configured, and
// nothing has been tried" is exactly the lie that doctrine forbids. So liveness here is
// a CONFIGURATION claim in configuration words, and delivery health stays a separate
// axis that a later piece (the status strip, which auto-expands a failing channel) is
// free to layer on top. Two axes, two vocabularies, neither borrowing the other's
// credibility.
//
// WHY THE BLOCKER IS PART OF THE ANSWER — the mixed-scope trap, in miniature.
// Settings → Notifications is intentionally mixed-tier, and these four columns are
// owned by THREE different people:
//
//     Telegram  server (bot token, an admin) AND login (your chat)
//     Web Push  server (VAPID keys, an admin) AND login (this browser's subscription)
//     Email     server (SMTP, an admin)       AND login (your address + opt-in)
//     Home Assistant                              profile (that profile's webhook)
//
// A bare "not set up" tells a member nothing about whether the next step is theirs, an
// admin's, or the profile's — so the same two words meant three different obligations.
// `columnLiveness` therefore returns WHO is blocking, server-first (an admin's missing
// bot token blocks a member's chat id, not the other way round), and `deadColumnNotes`
// turns that into one sentence per OWNER. Three owners, three sentences, each naming
// its own tier: that is how this change keeps the tiers legible rather than flattening
// them into one indistinguishable row of dots.

// Who has to act for a channel to be set up. "server" is the instance-wide technology
// an admin configures; "login" is the person/device tier (`login_settings`); "profile"
// is the data subject's tier (`profile_settings`).
export type ChannelScope = "server" | "login" | "profile";

// The facts a surface supplies per column. Deliberately two booleans and a scope rather
// than one `configured`: the single boolean is what made "not set up" unactionable.
export type ChannelReadiness = {
  // The instance-wide technology this channel needs (a bot token, VAPID keys, SMTP).
  // A channel with no server tier at all — Home Assistant — passes `true`.
  serverReady: boolean;
  // Whether the tier that owns the TARGET has one: a chat, a push subscription, an
  // address, a webhook URL.
  targetReady: boolean;
  // Which tier owns that target.
  targetScope: Exclude<ChannelScope, "server">;
};

export type ColumnLiveness =
  { state: "ready" } | { state: "not-set-up"; blocker: ChannelScope };

// Server first: an unconfigured instance blocks every login and every profile, so
// naming the login's missing chat id while the bot token is absent would send the
// member to a control that cannot help them.
export function columnLiveness(r: ChannelReadiness): ColumnLiveness {
  if (!r.serverReady) return { state: "not-set-up", blocker: "server" };
  if (!r.targetReady) return { state: "not-set-up", blocker: r.targetScope };
  return { state: "ready" };
}

// The one boolean the rest of the matrix already asked for (safety coverage, the
// legend), preserved exactly: set up === serverReady && targetReady.
export function isColumnReady(l: ColumnLiveness): boolean {
  return l.state === "ready";
}

// The words a column header shows. Configuration words only — see the header note on
// why this is not "delivering".
export function columnStateLabel(l: ColumnLiveness): string {
  return l.state === "ready" ? "set up" : "not set up";
}

// How a single cell renders. `ready` is the column's liveness; `routes` is the stored
// preference (enabled-unless-disabled, the same convention the matrix already uses).
export type CellInk = "live" | "ghost" | "off";

export function matrixCellInk(ready: boolean, routes: boolean): CellInk {
  if (!routes) return "off";
  return ready ? "live" : "ghost";
}

// What a ghost adds to a cell's accessible name. Opacity is not available to a screen
// reader and colour is not available to everyone, so the state that the ink carries
// visually is carried in words too — otherwise "checked" would be the only thing
// announced, which is the pre-#2565 lie with extra steps.
export function cellInkNote(ink: CellInk): string | null {
  return ink === "ghost" ? "kept, waiting on this channel's setup" : null;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type DeadColumn = { label: string; liveness: ColumnLiveness };

// ONE sentence per blocking OWNER, in server → login → profile order, naming the tier
// and where its fix lives. Empty when every column is set up: a page with nothing to
// say says nothing.
//
// The server sentence differs by ROLE, and only by role: an admin is sent to the
// control, a member is told whose step it is. `adminOnly` navigation hiding is never a
// permission check — this is copy, and Settings → Server keeps its own `requireAdmin()`.
export function deadColumnNotes(
  columns: readonly DeadColumn[],
  opts: { isAdmin: boolean; profileName: string }
): string[] {
  const by = (scope: ChannelScope) =>
    columns
      .filter(
        (c) => c.liveness.state === "not-set-up" && c.liveness.blocker === scope
      )
      .map((c) => c.label);

  const notes: string[] = [];

  const server = by("server");
  if (server.length > 0) {
    const subject = andList(server);
    const are = server.length === 1 ? "isn’t" : "aren’t";
    notes.push(
      opts.isAdmin
        ? `${subject} ${are} set up on this server yet — configure ${server.length === 1 ? "it" : "them"} on Settings → Server.`
        : `${subject} ${are} set up on this server yet — an admin configures ${server.length === 1 ? "it" : "them"} on Settings → Server.`
    );
  }

  const login = by("login");
  if (login.length > 0) {
    const are = login.length === 1 ? "isn’t" : "aren’t";
    notes.push(
      `${andList(login)} ${are} set up for your login yet — ${login.length === 1 ? "its card is" : "their cards are"} in Channels above.`
    );
  }

  const profile = by("profile");
  if (profile.length > 0) {
    const are = profile.length === 1 ? "isn’t" : "aren’t";
    notes.push(
      `${andList(profile)} ${are} set up for ${opts.profileName} yet — ${profile.length === 1 ? "its card is" : "their cards are"} in Channels above.`
    );
  }

  return notes;
}
