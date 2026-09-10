import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import AuditRetentionSettings from "@/app/(app)/settings/server/AuditRetentionSettings";
import TwoFactorSettings from "@/app/(app)/settings/TwoFactorSettings";
import AiTierSettings from "@/app/(app)/settings/ai/AiTierSettings";
import FamilyManager from "@/app/(app)/settings/family/FamilyManager";
import ChannelRow from "@/app/(app)/settings/notifications/ChannelRow";
import LoginTelegramSettings from "@/app/(app)/settings/notifications/LoginTelegramSettings";
import PushNotificationSettings from "@/app/(app)/settings/notifications/PushNotificationSettings";
import ServerTelegramSettings from "@/app/(app)/settings/notifications/ServerTelegramSettings";

// ONE LOUD CONTROL PER SETTINGS CARD (#4978, PM ruling 6, 2026-09-09 23:35 UTC;
// owner ruling 10, 2026-09-10 01:30 UTC).
//
// Slice 2 demoted about a dozen settings-card commits on the reading that a
// settings ROUTE is one surface hosting many cards, so none of them may be loud.
// Ruling 6 settled it the other way: on a multi-card route the surface is the
// CARD, so a route hosting ten cards shows ten quiet cards each with one filled
// control. This pins the unit that reading turns on — the count is taken over
// the CARD the commit lives in, never over the document, because a per-route
// total is exactly the number ruling 6 says does not exist.
//
// THE BUDGET COUNTS BOTH LOUD PAINTS, NOT JUST `primary`. Ruling 10 settled that
// a filled `danger` control SPENDS the card's one loud control rather than
// sitting outside it, so counting only `button-control-primary` here would let a
// card go loud twice and still pass. `loudIn` therefore reads both, which is
// also what couples the logins case below to the per-row Deletes: those went
// quiet under the same ruling, and if they come back this fails.
//
// The two carve-outs ruling 6 names are pinned as their own cases, because they
// are what a later lane would "finish" by mistake: a fold commit that can be
// open beside the card's own commit stays quiet, and so does a commit that has
// no unique claim to its card.

vi.mock("@/app/(app)/settings/server/actions", () => ({
  saveAuditRetention: async () => {},
  saveTelegramBotConfig: async () => {},
  registerTelegramWebhook: async () => ({ ok: true, message: "registered" }),
}));

vi.mock("@/app/(app)/settings/actions", () => ({
  saveLoginTelegram: async () => ({ ok: true as const }),
  sendTestNotification: async () => ({ ok: true, message: "sent" }),
  getPushPublicKey: async () => ({ ok: true as const, publicKey: "" }),
  savePushSubscriptionAction: async () => ({ ok: true as const }),
  deletePushSubscriptionAction: async () => ({ ok: true as const }),
  sendTestPush: async () => ({ ok: true, message: "sent" }),
  begin2fa: async () => ({
    ok: true as const,
    secret: "AAAA",
    otpauthUrl: "otpauth://x",
  }),
  activate2fa: async () => ({ ok: true as const, recoveryCodes: ["a"] }),
  disable2fa: async () => ({ ok: true as const, message: "off" }),
  regenerate2faRecoveryCodes: async () => ({
    ok: true as const,
    recoveryCodes: ["a"],
  }),
}));

vi.mock("@/app/(app)/settings/ai/actions", () => ({
  saveAiTierConfig: async () => ({ ok: true, message: "saved" }),
  testAiTier: async () => ({ ok: true, message: "reached" }),
}));

vi.mock("@/app/(app)/settings/family/actions", () => ({
  createProfile: async () => ({ ok: true as const }),
  renameProfile: async () => ({ ok: true as const }),
  deleteProfile: async () => ({ ok: true as const }),
  createLogin: async () => ({ ok: true as const }),
  resetPassword: async () => ({ ok: true as const }),
  deleteLogin: async () => ({ ok: true as const }),
  revokeLoginSessions: async () => ({ ok: true as const }),
  setGrants: async () => ({ ok: true as const }),
  setLoginOwnProfile: async () => ({ ok: true as const }),
  setLoginEmail: async () => ({ ok: true as const }),
  sendInvite: async () => ({ ok: true as const }),
}));

vi.mock("@/app/(app)/settings/photo-actions", () => ({
  uploadProfilePhoto: async () => ({ ok: true as const }),
  removeProfilePhoto: async () => ({ ok: true as const }),
}));

afterEach(cleanup);

/** The `.card` box the given control lives in — the surface ruling 6 names. */
function cardOf(control: HTMLElement): HTMLElement {
  const card = control.closest(".card");
  if (!(card instanceof HTMLElement)) {
    throw new Error("control is not inside a settings card");
  }
  return card;
}

/** Every loud control on the card — both paints ruling 10 counts against it. */
function loudIn(card: HTMLElement): string[] {
  return Array.from(
    card.querySelectorAll(".button-control-primary, .button-control-danger"),
    (el) => (el.textContent ?? "").trim()
  );
}

describe("a settings card spends its one loud control on its own commit", () => {
  it("fills the card's Save and nothing else beside it", () => {
    render(<AuditRetentionSettings months={24} />);
    const save = screen.getByTestId("audit-retention-save");

    expect(save.className).toContain("button-control-primary");
    expect(loudIn(cardOf(save))).toEqual(["Save"]);
  });

  it("keeps the logins card at one filled control with both row folds open", () => {
    render(
      <ConfirmProvider>
        <FamilyManager
          profiles={[]}
          logins={[
            {
              id: 1,
              username: "owner",
              role: "admin" as const,
              email: "owner@example.test",
              own_profile_id: null,
            },
          ]}
          grants={{}}
          access={{}}
          summaries={{}}
          sessionCounts={{ 1: 1 }}
          canInvite={true}
          selfLoginId={1}
        />
      </ConfirmProvider>
    );

    const create = screen.getByRole("button", { name: "Create login" });
    const card = cardOf(create);
    // The one loud control on a card that also renders a Delete per login row —
    // quiet since ruling 10, so the card's budget is spent here and nowhere else.
    expect(card.querySelectorAll("[data-testid='login-row']").length).toBe(1);
    expect(loudIn(card)).toEqual(["Create login"]);

    // CARVE-OUT 1, checked as state rather than asserted as doctrine: `open` and
    // `emailOpen` are independent booleans and neither toggle clears the other,
    // so both folds can stand open at once — and they stand open beside the
    // card's own commit, which nothing here hides. Filling either fold commit
    // would put two or three loud controls on this card.
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByTestId("save-email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set" })).toBeTruthy();

    expect(loudIn(card)).toEqual(["Create login"]);
  });

  it("fills the enrollment commit in each state, and neither of the two that coexist", () => {
    const { rerender } = render(
      <TwoFactorSettings enabled={false} recoveryRemaining={0} />
    );
    const enable = screen.getByTestId("twofa-enable");
    expect(loudIn(cardOf(enable))).toEqual([
      "Enable two-factor authentication",
    ]);

    // Regenerate and Turn off render from the SAME condition — neither is behind
    // a fold and neither hides the other — so the card has no loud control at
    // all in this state rather than two, or one picked by declaration order.
    rerender(<TwoFactorSettings enabled={true} recoveryRemaining={3} />);
    const card = cardOf(screen.getByTestId("twofa-status-on"));
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(loudIn(card)).toEqual([]);
  });

  // THE NOTIFICATION CHANNEL CARDS (#4978 slice 7). The card here is the
  // `ChannelRow` disclosure, not the route and not the component — all four
  // channels render their controls as its children, so the card box has to come
  // from the row for the count to be over the surface ruling 6 names.
  it("fills the channel card's Save and leaves its test diagnostic quiet", () => {
    render(
      <ChannelRow
        channel="telegram"
        name="Telegram"
        scope="owner"
        state={{ state: "ready" }}
        blocker={null}
        profileName="Ada"
      >
        <LoginTelegramSettings
          telegram={{ telegramEnabled: true, telegramChatId: "1" }}
          botConfigured={true}
          reviewNeeded={false}
        />
      </ChannelRow>
    );

    const save = screen.getByTestId("login-telegram-save");
    // "Send test" is on the card too, and it is the coupling: the card's one
    // fill is only defensible while the diagnostic beside it stays quiet.
    expect(screen.getByTestId("login-telegram-test")).toBeTruthy();
    expect(loudIn(cardOf(save))).toEqual(["Save"]);
  });

  it("fills the push card's enrollment commit and nothing once it is on", async () => {
    // jsdom carries none of the three globals this card probes for, so its
    // controls do not render at all without them. `getSubscription` is what
    // decides which arm of the enable/disable ternary mounts.
    let subscription: object | null = null;
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => subscription },
        }),
      },
    });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: "granted" });

    const shell = (
      <ChannelRow
        channel="push"
        name="Push"
        scope="owner"
        state={{ state: "ready" }}
        blocker={null}
        profileName="Ada"
      >
        <PushNotificationSettings />
      </ChannelRow>
    );

    render(shell);
    await act(async () => {});
    const enable = screen.getByTestId("push-enable");
    expect(loudIn(cardOf(enable))).toEqual(["Enable push on this browser"]);

    // ONCE PUSH IS ON, THE CARD HAS NO LOUD CONTROL. `Disable` is the teardown of
    // the enrollment commit rather than a second commit — the same reading that
    // keeps `TwoFactorSettings`' "Turn off" quiet above — and "Send test" is a
    // diagnostic. Filling either is what a later lane would call finishing the
    // conversion, so it is pinned here rather than argued.
    // Remounted rather than rerendered: `subscribed` is read once from the
    // registration on mount, so the second state is a fresh probe.
    subscription = {};
    cleanup();
    render(shell);
    await act(async () => {});
    const disable = screen.getByTestId("push-disable");
    expect(screen.getByTestId("push-test")).toBeTruthy();
    expect(loudIn(cardOf(disable))).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("fills the bot card's own commit and leaves the webhook follow-up quiet", () => {
    render(
      <ServerTelegramSettings
        config={{
          telegramBotToken: "t",
          telegramMode: "webhook",
          telegramWebhookSecret: "s",
        }}
        publicUrl="https://example.test"
        lastError={null}
      />
    );

    const apply = screen.getByRole("button", { name: "Apply bot settings" });
    // "Register webhook" acts on what Apply just stored, so it is a follow-up on
    // this card rather than a rival commit.
    expect(
      screen.getByRole("button", { name: "Register webhook" })
    ).toBeTruthy();
    expect(loudIn(cardOf(apply))).toEqual(["Apply bot settings"]);
  });

  it("leaves the two peer tier commits on one card quiet", () => {
    const view = {
      apiShape: "anthropic" as const,
      baseUrl: "",
      model: "",
      hasApiKey: false,
    };
    render(<AiTierSettings heavy={view} light={view} />);

    // Both blocks post the same action with a different `tier`, inside one card:
    // peers share no rank (ruling 7), and a fill on either would also be the
    // second loud control on this card.
    expect(loudIn(screen.getByTestId("ai-tier-settings"))).toEqual([]);
    expect(screen.getByTestId("ai-tier-heavy-save")).toBeTruthy();
    expect(screen.getByTestId("ai-tier-light-save")).toBeTruthy();
  });
});
