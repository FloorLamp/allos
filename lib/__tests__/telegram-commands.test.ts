// PURE TIER — the Telegram command vocabulary (#1895).
//
// The defect was silence: every handler no-opped on non-matching text and nothing
// answered afterwards, so `/start`, `/help` and a typo'd `/doze` all vanished. These
// cases pin the parse, the per-chat gate, and the three replies that make silence
// impossible. The routing itself is pinned in lib/__db_tests__/telegram-commands.test.ts.

import { describe, it, expect } from "vitest";
import { isPlannedVerb } from "@/lib/loggable-domains";
import {
  TELEGRAM_COMMANDS,
  TELEGRAM_DOMAIN_CENSUS,
  commandsForChat,
  helpBody,
  isCommandAvailable,
  parseCommand,
  registrableCommands,
  startBody,
  unavailableCommandBody,
  unknownCommandBody,
  UNLINKED_BODY,
  type ChatCommandContext,
} from "@/lib/notifications/telegram-commands";

const LINKED: ChatCommandContext = {
  linked: true,
  moodCheckin: true,
  foodLogging: true,
  practiceTargets: true,
};
const NO_MOOD: ChatCommandContext = { ...LINKED, moodCheckin: false };
const UNLINKED: ChatCommandContext = {
  linked: false,
  moodCheckin: false,
  foodLogging: false,
  practiceTargets: false,
};

describe("parseCommand", () => {
  it("reads a bare command", () => {
    expect(parseCommand("/dose")).toEqual({
      name: "dose",
      typed: "dose",
      args: "",
    });
  });

  it("reads a command addressed to a bot by name", () => {
    // Telegram appends @botname in GROUPS. Same verb.
    expect(parseCommand("/dose@allosbot")?.name).toBe("dose");
  });

  it("does not check WHICH bot was addressed", () => {
    // A chat with two bots would otherwise get silence from the one it named — the
    // exact defect this module exists to remove. One wasted message beats no answer.
    expect(parseCommand("/dose@someotherbot")?.name).toBe("dose");
  });

  it("resolves an alias to its command", () => {
    expect(parseCommand("/symptoms")?.name).toBe("symptom");
    expect(parseCommand("/temperature")?.name).toBe("temp");
  });

  it("is case-insensitive and carries trailing args", () => {
    expect(parseCommand("/DOSE  ibuprofen ")).toEqual({
      name: "dose",
      typed: "dose",
      args: "ibuprofen",
    });
  });

  it("an unknown verb parses with a null name, keeping what was typed", () => {
    // The echo is what makes a typo read as a typo.
    expect(parseCommand("/doze")).toEqual({
      name: null,
      typed: "doze",
      args: "",
    });
  });

  it("ordinary text is NOT a command — the one case that may go unanswered", () => {
    expect(parseCommand("my throat hurts")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    // A lone slash, and a slash mid-sentence, are not commands either.
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("see /dose for this")).toBeNull();
  });
});

describe("the per-chat gate", () => {
  it("an UNLINKED chat is offered only the meta verbs", () => {
    expect(commandsForChat(UNLINKED).map((c) => c.name)).toEqual([
      "help",
      "start",
    ]);
    expect(isCommandAvailable("dose", UNLINKED)).toBe(false);
  });

  it("a gated verb is absent from a chat that cannot use it", () => {
    expect(isCommandAvailable("mood", LINKED)).toBe(true);
    expect(isCommandAvailable("mood", NO_MOOD)).toBe(false);
    // …and the ungated ones are unaffected.
    expect(isCommandAvailable("dose", NO_MOOD)).toBe(true);
  });
});

describe("/help is the per-chat-honest list", () => {
  it("names only what this chat can do", () => {
    expect(helpBody(LINKED)).toContain("/mood");
    expect(helpBody(NO_MOOD)).not.toContain("/mood");
    expect(helpBody(NO_MOOD)).toContain("/dose");
  });

  it("never lists itself or /start — the user is already reading it", () => {
    expect(helpBody(LINKED)).not.toContain("/help");
    expect(helpBody(LINKED)).not.toContain("/start");
  });

  it("an unlinked chat is told what is actually wrong", () => {
    expect(helpBody(UNLINKED)).toBe(UNLINKED_BODY);
    expect(helpBody(UNLINKED)).toContain("/help");
  });

  it("a linked chat with every logging verb gated gets a sentence, not an empty list", () => {
    // Structurally reachable, so it must not render as a blank message.
    const nothing: ChatCommandContext = {
      linked: true,
      moodCheckin: false,
      foodLogging: false,
      practiceTargets: false,
    };
    const gated = commandsForChat(nothing).filter(
      (c) => c.name !== "help" && c.name !== "start"
    );
    // (Today `/dose` is ungated, so assert the shape rather than pretend otherwise.)
    expect(gated.length).toBeGreaterThan(0);
    expect(helpBody({ ...nothing, linked: true }).length).toBeGreaterThan(0);
  });

  it("/start hands straight over to the verb list", () => {
    // A greeting that does not say what to type next is the same silence, one step
    // later.
    expect(startBody(LINKED)).toContain("/dose");
    expect(startBody(UNLINKED)).toBe(UNLINKED_BODY);
  });
});

// The three verbs #2130 decided IN and #1895 built. Each is gated by the DASHBOARD's
// relevance rule, so /help never advertises a verb that would then answer with an
// explanation instead of a keyboard.
describe("the on-demand loggers (#1895 half 2)", () => {
  it("/food follows food-logging relevance", () => {
    expect(helpBody(LINKED)).toContain("/food");
    expect(helpBody({ ...LINKED, foodLogging: false })).not.toContain("/food");
    expect(isCommandAvailable("food", { ...LINKED, foodLogging: false })).toBe(
      false
    );
  });

  it("/practice is offered only where a practice is tracked", () => {
    expect(helpBody(LINKED)).toContain("/practice");
    expect(helpBody({ ...LINKED, practiceTargets: false })).not.toContain(
      "/practice"
    );
  });

  it("/practices routes to /practice, and the menu lists one row", () => {
    expect(parseCommand("/practices")?.name).toBe("practice");
    expect(registrableCommands().map((c) => c.command)).not.toContain(
      "practices"
    );
  });

  it("/weight needs no relevance bit — everyone has a weight", () => {
    expect(
      helpBody({
        ...LINKED,
        moodCheckin: false,
        foodLogging: false,
        practiceTargets: false,
      })
    ).toContain("/weight");
    expect(isCommandAvailable("weight", UNLINKED)).toBe(false);
  });
});

describe("the fallbacks", () => {
  it("unknown echoes what was typed and points at /help", () => {
    const body = unknownCommandBody("doze");
    expect(body).toContain("/doze");
    expect(body).toContain("/help");
  });

  it("unavailable is a DIFFERENT answer from unknown", () => {
    // "not set up here" and "not a thing" send you looking in two different places.
    const body = unavailableCommandBody("mood");
    expect(body).toContain("/mood");
    expect(body).toContain("/help");
    expect(body).not.toEqual(unknownCommandBody("mood"));
  });
});

describe("the registered /-menu list", () => {
  it("is generic — every verb the build ships, aliases folded in", () => {
    expect(registrableCommands().map((c) => c.command)).toEqual(
      TELEGRAM_COMMANDS.map((c) => c.name)
    );
    // One row per verb: `/symptoms` must not double `/symptom` in the menu.
    expect(registrableCommands().map((c) => c.command)).not.toContain(
      "symptoms"
    );
  });

  it("leads with /help", () => {
    expect(registrableCommands()[0].command).toBe("help");
  });

  it("every description fits Telegram's limit and the copy standard", () => {
    for (const c of registrableCommands()) {
      expect(c.description.length, c.command).toBeGreaterThan(3);
      expect(c.description.length, c.command).toBeLessThanOrEqual(64);
      // A menu row is a label, not a sentence.
      expect(c.description.endsWith("."), c.command).toBe(false);
    }
  });

  it("no duplicate verbs, and no verb collides with another's alias", () => {
    const seen = new Set<string>();
    for (const c of TELEGRAM_COMMANDS) {
      for (const v of [c.name, ...(c.aliases ?? [])]) {
        expect(seen.has(v), `duplicate verb "${v}"`).toBe(false);
        seen.add(v);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The #2130 domain census. The `satisfies` in lib/notifications/telegram-commands.ts
// proves at compile time that every LoggableDomain maps to a shipped verb, a
// planned verb, or an argued exclusion. The runtime half types cannot see: a
// PLANNED verb must not name a verb the build already ships — the moment #1895
// lands one, its census row must flip to the real command name.
// ---------------------------------------------------------------------------

describe("the domain census (#2130)", () => {
  it("a planned verb never shadows a shipped one", () => {
    const shipped = new Set(TELEGRAM_COMMANDS.map((c) => c.name));
    for (const value of Object.values(TELEGRAM_DOMAIN_CENSUS)) {
      if (isPlannedVerb(value)) {
        expect(shipped.has(value.verb), value.verb).toBe(false);
      }
    }
  });

  it("food, practice and weight are SHIPPED — #1895 built what #2130 decided", () => {
    // The rows flipped from plannedVerb(...) to the real command names in the same
    // change that routed the handlers, which is what the pin above exists to force.
    expect(TELEGRAM_DOMAIN_CENSUS.food).toBe("food");
    expect(TELEGRAM_DOMAIN_CENSUS.practice).toBe("practice");
    expect(TELEGRAM_DOMAIN_CENSUS.weight).toBe("weight");
    for (const domain of ["food", "practice", "weight"] as const) {
      expect(isPlannedVerb(TELEGRAM_DOMAIN_CENSUS[domain])).toBe(false);
    }
  });

  it("nothing is left planned — every decided-IN domain has a shipped verb", () => {
    expect(
      Object.entries(TELEGRAM_DOMAIN_CENSUS)
        .filter(([, v]) => isPlannedVerb(v))
        .map(([k]) => k)
    ).toEqual([]);
  });
});
