import { describe, it, expect } from "vitest";
import {
  composeNotificationEmail,
  contentFreeEmail,
  fullContentEmail,
  dedupeEmailRecipients,
  isEmailDeliverableKind,
  type EmailRecipient,
} from "../notifications/email-core";
import type { NotificationMessage } from "../notifications/types";
import { richFrom, bold } from "../notifications/rich-text";

// The email channel's pure half (issue #1855): mail composition under the two
// content modes (the PHI owner ruling), the address dedup with its conservative
// mode merge, and the deliverable-kind rule shared with Web Push.

// A message whose words stand in for PHI: none of these tokens may ever appear in
// a content-free mail. (Clearly fictional — no real names, meds, or doses.)
const PHI_MSG: NotificationMessage = {
  title: "[Testa Fixturesdottir] Medication reminder",
  body: "Take 2 × Examplomab 50 mg with food.",
  kind: "dose",
  actions: [
    { label: "Confirm taken", data: "take:1:2:2026-08-05" },
    { label: "Open Allos", url: "https://allos.example/medications" },
  ],
};

describe("contentFreeEmail (the default mode)", () => {
  it("is structurally message-blind: two different messages compose identically", () => {
    const a = composeNotificationEmail(PHI_MSG, "content-free", "");
    const b = composeNotificationEmail(
      { title: "Totally different", body: "Other words entirely." },
      "content-free",
      ""
    );
    expect(a).toEqual(b);
  });

  it("carries no message content, no profile name, and no callback token", () => {
    const mail = composeNotificationEmail(
      PHI_MSG,
      "content-free",
      "https://allos.example"
    );
    const rendered = `${mail.subject}\n${mail.text}`;
    for (const leak of [
      "Examplomab",
      "Medication",
      "Testa",
      "take:1:2",
      "with food",
    ]) {
      expect(rendered).not.toContain(leak);
    }
  });

  it("includes the public URL when configured, and still reads sensibly without one", () => {
    expect(contentFreeEmail("https://allos.example").text).toContain(
      "https://allos.example"
    );
    const bare = contentFreeEmail("");
    expect(bare.text).not.toContain("http");
    expect(bare.text).toContain("Open Allos");
  });
});

describe("fullContentEmail (opt-in channel parity)", () => {
  it("carries the title as subject and the plain body — the same words as other channels", () => {
    const mail = fullContentEmail(PHI_MSG, "");
    expect(mail.subject).toBe("[Testa Fixturesdottir] Medication reminder");
    expect(mail.text).toContain("Take 2 × Examplomab 50 mg with food.");
  });

  it("renders deep-link actions as plain links and DROPS callback actions", () => {
    const mail = fullContentEmail(PHI_MSG, "");
    expect(mail.text).toContain(
      "Open Allos: https://allos.example/medications"
    );
    // A callback token is an opaque capability string — never in a mail.
    expect(mail.text).not.toContain("take:1:2");
    expect(mail.text).not.toContain("Confirm taken");
  });

  it("flattens a RichText body to plain words (no markup fork)", () => {
    const mail = fullContentEmail(
      { title: "T", body: richFrom(["Weight ", bold("72 kg"), " logged"]) },
      ""
    );
    expect(mail.text).toContain("Weight 72 kg logged");
    expect(mail.text).not.toContain("<b>");
  });

  it("appends the public URL footer only when configured", () => {
    const msg: NotificationMessage = { title: "T", body: "B" };
    expect(fullContentEmail(msg, "https://allos.example").text).toContain(
      "Open Allos: https://allos.example"
    );
    expect(fullContentEmail(msg, "").text).not.toContain("Open Allos:");
  });
});

describe("dedupeEmailRecipients", () => {
  const r = (
    loginId: number,
    address: string,
    fullContent = false
  ): EmailRecipient => ({ loginId, address, fullContent });

  it("collapses case/whitespace variants of one address; first login wins", () => {
    const out = dedupeEmailRecipients([
      r(1, " Care@Example.com "),
      r(2, "care@example.com"),
    ]);
    expect(out).toEqual([
      { loginId: 1, address: "Care@Example.com", fullContent: false },
    ]);
  });

  it("drops empty addresses and keeps distinct ones", () => {
    const out = dedupeEmailRecipients([
      r(1, ""),
      r(2, "a@example.com"),
      r(3, "b@example.com"),
    ]);
    expect(out.map((x) => x.loginId)).toEqual([2, 3]);
  });

  it("a shared address gets full content only when EVERY login opted in (content-free wins)", () => {
    const conservative = dedupeEmailRecipients([
      r(1, "shared@example.com", true),
      r(2, "SHARED@example.com", false),
    ]);
    expect(conservative[0].fullContent).toBe(false);

    const unanimous = dedupeEmailRecipients([
      r(1, "shared@example.com", true),
      r(2, "shared@example.com", true),
    ]);
    expect(unanimous[0].fullContent).toBe(true);
  });
});

describe("isEmailDeliverableKind", () => {
  it("excludes the button-only kinds and keeps content-bearing ones (push parity)", () => {
    expect(isEmailDeliverableKind("food")).toBe(false);
    expect(isEmailDeliverableKind("mood")).toBe(false);
    expect(isEmailDeliverableKind("dose")).toBe(true);
    expect(isEmailDeliverableKind("escalation")).toBe(true);
    expect(isEmailDeliverableKind(undefined)).toBe(true);
  });
});
