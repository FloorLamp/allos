// Low-supply refill nudge. Once per hour per profile, checks
// every tracked (quantity_on_hand set) active item's remaining days of supply and,
// when one drops to/below the refill threshold, sends a single "refill due" nudge
// over the profile's own channel. The days-of-supply arithmetic is the pure
// lib/refill; this file is the DB gather + dedup + send, mirroring ./escalate.
//
// Dedup semantics — "once per low-supply EPISODE", not once per day:
//   - notify_last_refill_<itemId> is set (to the send date) once a nudge
//     goes out, and suppresses further nudges while the item stays low.
//   - The marker is CLEARED the moment the item is no longer low (refilled above
//     the threshold, or quantity tracking turned off / the item paused), so the next
//     time it runs low a fresh nudge fires. Without this the marker would silence it
//     forever. The clear is self-healing: markedIds is the FULL set of live markers
//     (not just the current candidates), so planRefillNudges sweeps a marker whose
//     item has left the tracked set entirely (issue #325).

import { getIntakeItems, getRefillRates } from "../queries";
import { isPushedIntake } from "../intake-schedule";
import { intakeSupplyHref } from "../hrefs";
import { db, today, writeTx } from "../db";
import { now } from "../clock";
import { parseUtcSql } from "../date";
import { refillSupply } from "../queries/intake/refill";
import type { IntakeItemKind } from "../types";
import { getProfilesByTelegramChatId } from "../settings";
import {
  currentRefillOffer,
  readRefillOffer,
  replaceRefillOffer,
  refillOfferIsTerminal,
  OFFER_RETENTION_DAYS,
  type RefillOffer,
} from "./offer-store";
import {
  offerCallback,
  parseOfferCallback,
  type OfferCallback,
} from "./offer-tokens";
import { parseReceivedAmount, parseRefillReplyMarker } from "./refill-tokens";
import {
  messagePointerAt,
  claimMessagePointerKeyboard,
  releaseMessagePointerKeyboard,
  type MessagePointer,
} from "./message-pointers";
import { messageBodyHash } from "./reconcile-core";
import { composeForRebuild } from "./compose";
import { deliveredKeyboard } from "./delivered-keyboard";
import { getPoolView } from "../queries/intake/supply-pool";
import {
  sendTelegramMessage,
  answerCallbackQuery,
  rebuildMessage,
  type TelegramCallbackQuery,
} from "./telegram";
import type { TelegramMessage } from "./telegram-api";
import { getFindingSuppressions } from "../queries/upcoming";
import {
  daysOfSupplyLeft,
  isLowSupply,
  DEFAULT_LOW_SUPPLY_DAYS,
} from "../refill";
import {
  planRefillNudges,
  refillSignalKey,
  refillMarkerKey,
  refillIdFromMarker,
  REFILL_MARKER_PREFIX,
  type RefillCandidate,
} from "../refill-nudge";
import { isSuppressed } from "../upcoming-suppress";
import {
  setProfileSetting,
  deleteProfileSetting,
  getProfileSettingKeysWithPrefix,
  getPublicUrl,
} from "../settings";
import { dispatch } from "./index";
import type { NotificationAction, NotificationMessage } from "./types";
import { createLogger } from "../log";
import { GLYPH } from "./glyphs";

const log = createLogger("notify");

interface LowItem {
  id: number;
  name: string;
  daysLeft: number;
  kind?: IntakeItemKind;
  received?: NotificationAction | null;
}

// The refill nudge lists each low item with its remaining days. Each item gets a
// "📦 Ordered — remind me in 3 days" button (issue #233) that snoozes its
// `refill:<id>` finding on the shared bus (#227), plus — when a public URL is
// configured — a deep link to the refill form (a real "mark refilled" needs an
// amount, which a button handles badly, so the form is the actuator). One row per
// item so a snooze consumes just that item.
export function renderRefillMessage(
  items: LowItem[],
  profileId: number,
  deepLinkBase = ""
): NotificationMessage {
  const head =
    items.length === 1 ? items[0].name : `${items.length} items running low`;
  // "≈5 days left" gains its meaning (#1722 item 4): five days is only news against
  // the threshold that decided to send this. The prose preamble is gone — it restated
  // the title and the CTA that are already on screen.
  const lines = items.map(
    (it) =>
      `${GLYPH.bullet} ${it.name}: ≈${it.daysLeft} day${it.daysLeft === 1 ? "" : "s"} left (below your ${DEFAULT_LOW_SUPPLY_DAYS}-day threshold)`
  );
  const base = deepLinkBase.replace(/\/$/, "");
  const actions: NotificationAction[] = items.flatMap((it) => {
    const row = `rf:${it.id}`;
    const perItem: NotificationAction[] = [
      {
        label: `${GLYPH.ordered} Ordered — remind me in 3 days`,
        data: `rfsnooze:${profileId}:${it.id}`,
        row,
      },
    ];
    const received = it.received;
    if (received) perItem.push({ ...received, row });
    if (base) {
      perItem.push({
        label: "Open refill form",
        url: `${base}${intakeSupplyHref(it.kind ?? "supplement", it.id, true)}`,
        row,
      });
    }
    return perItem;
  });
  return {
    title: `${GLYPH.resupply} Refill due: ${head}`,
    body: lines.join("\n"),
    actions,
    kind: "refill",
  };
}

// Send any due low-supply nudges for one profile. Returns whether a send failed
// (aggregated into the tick's exit code). Never throws for an ordinary send
// failure. `date` is the profile-local date, used as the dedup marker value.
export async function runRefills(
  profileId: number,
  date: string
): Promise<{ failed: boolean }> {
  // Only active items that opted into quantity tracking — and only ones that may ride
  // a PUSH surface at all (#1505). A refill nudge IS a push, so the SAME shared
  // predicate the Upcoming refill items and the dose reminders consult gates it here:
  // a `may` supplement's supply state stays visible on the Supplements page,
  // it just never nudges. Medications remain in the safety tier regardless.
  const tracked = getIntakeItems(profileId).filter(
    (s) => s.active && s.quantity_on_hand != null && isPushedIntake(s)
  );
  if (tracked.length === 0) return { failed: false };

  // doses/day comes from the shared getRefillRates: the ACTUAL taken-log rate
  // (confirmed doses over the trailing window) once the item has enough history,
  // else the scheduled-dose-count estimate. A workout-only / situational
  // supplement no longer reads as daily, so the nudge stops firing weeks early.
  const rates = getRefillRates(profileId);

  const candidates: RefillCandidate[] = tracked.map((s) => {
    const daysLeft = daysOfSupplyLeft(
      s.quantity_on_hand,
      s.qty_per_dose,
      rates.get(s.id)?.dosesPerDay ?? 0
    );
    return {
      id: s.id,
      name: s.name,
      daysLeft,
      low: isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS),
    };
  });

  // Route the nudge through the shared findings-suppression bus (#227): a refill
  // dismissed/snoozed on the Upcoming page (keyed by the identical `refill:<id>`
  // signal) is held out of the push too. `date` is the profile-local today.
  const suppressions = getFindingSuppressions(profileId);
  // The FULL set of live episode markers — NOT just the ids among `candidates` — so a
  // marker whose item has left the tracked set (paused / quantity tracking turned off)
  // still reaches planRefillNudges' self-healing clear (issue #325). Mirrors the
  // preventive nudge's getProfileSettingKeysWithPrefix read.
  const markedIds = getProfileSettingKeysWithPrefix(
    profileId,
    REFILL_MARKER_PREFIX
  )
    .map(refillIdFromMarker)
    .filter((id) => Number.isInteger(id) && id > 0);
  const suppressedIds = candidates
    .filter((c) => {
      const rec = suppressions.get(refillSignalKey(c.id));
      return rec != null && isSuppressed(rec, date);
    })
    .map((c) => c.id);

  const { toSend, toClear } = planRefillNudges(
    candidates,
    markedIds,
    suppressedIds
  );

  // End any recovered/untracked episodes first — cheap, and never depends on a send.
  for (const id of toClear)
    deleteProfileSetting(profileId, refillMarkerKey(id));

  if (toSend.length === 0) return { failed: false };

  const results = await dispatch(
    profileId,
    renderRefillMessage(
      toSend.map((item) => ({
        ...item,
        kind: refillStock(profileId, item.id)?.kind,
        received: refillReceivedAction(profileId, item.id),
      })),
      profileId,
      getPublicUrl()
    )
  );
  if (results.length === 0) {
    // No channel configured — leave markers unset so it can send once configured.
    log.info("refill nudge skipped: no channel", { profile: profileId });
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    for (const it of toSend) {
      setProfileSetting(profileId, refillMarkerKey(it.id), date);
      log.info("refill nudge sent", {
        profile: profileId,
        item: it.name,
        daysLeft: it.daysLeft,
      });
    }
  }
  return { failed };
}

interface RefillStock {
  id: number;
  kind: IntakeItemKind;
  name: string;
  supplyId: number | null;
  quantity: number | null;
  lastFillSize: number | null;
}

function refillStock(profileId: number, itemId: number): RefillStock | null {
  return (
    (db
      .prepare(
        `SELECT i.id, i.kind, i.name, i.supply_id AS supplyId,
    CASE WHEN i.supply_id IS NULL THEN i.quantity_on_hand ELSE p.quantity_on_hand END AS quantity,
    i.last_fill_size AS lastFillSize FROM intake_items i
    LEFT JOIN shared_supplies p ON p.id = i.supply_id WHERE i.profile_id = ? AND i.id = ?`
      )
      .get(profileId, itemId) as RefillStock | undefined) ?? null
  );
}

function hasRefillToken(
  profileId: number,
  chatId: string,
  messageId: number,
  token: string
): boolean {
  return (
    messagePointerAt(profileId, chatId, messageId)
      ?.keyboard.flat()
      .some((b) => b.callback_data === token) ?? false
  );
}

function receiptText(result: NonNullable<RefillOffer["result"]>): string {
  return `Added ${result.fillSize} · ${result.newQuantity} on hand`;
}

function receiptPrompt(
  profileId: number,
  offerId: number,
  offer: RefillOffer
): NotificationMessage {
  const stock = refillStock(profileId, offer.itemId);
  const marker = `(refill:${profileId}:${offerId})`;
  const actions: NotificationAction[] = [];
  let body: string;
  if (offer.state === "completed" && offer.result)
    body = `${receiptText(offer.result)}\n${marker}`;
  else if (refillOfferIsTerminal(offer))
    body =
      "This receipt is closed. Open a new Received request from the reminder.";
  else {
    body = `How many arrived?\nReply to this message with the number of units.\n${marker}`;
    if (offer.defaultSize != null)
      actions.push({
        label: `Confirm ${offer.defaultSize}`,
        data: offerCallback("rfconfirm", profileId, offerId),
      });
    actions.push({
      label: "Cancel",
      data: offerCallback("rfcancel", profileId, offerId),
    });
  }
  const base = getPublicUrl().replace(/\/$/, "");
  if (base && stock)
    actions.push({
      label: "Open refill form",
      url: `${base}${intakeSupplyHref(stock.kind, stock.id, true)}`,
    });
  return {
    title: stock?.name ?? "Supply receipt",
    body,
    actions,
    kind: "refill",
  };
}

export function refillReceivedAction(
  profileId: number,
  itemId: number
): NotificationAction | null {
  return writeTx(() => {
    const stock = refillStock(profileId, itemId);
    if (!stock || stock.quantity == null) return null;
    let offerId = currentRefillOffer(
      profileId,
      itemId,
      stock.supplyId,
      today(profileId)
    );
    let current = readRefillOffer(profileId, offerId)!;
    if (
      !refillOfferIsTerminal(current.offer) &&
      refillExpired(current.createdAt)
    ) {
      replaceRefillOffer(profileId, offerId, current.offer, {
        ...current.offer,
        state: "invalidated",
      });
      offerId = currentRefillOffer(
        profileId,
        itemId,
        stock.supplyId,
        today(profileId)
      );
      current = readRefillOffer(profileId, offerId)!;
    }
    return {
      label:
        current.offer.state === "available"
          ? "Received"
          : "Cancel pending receipt",
      data: offerCallback(
        current.offer.state === "available" ? "rfreceived" : "rfcancel",
        profileId,
        offerId
      ),
    };
  });
}

function refillExpired(createdAt: string): boolean {
  return (
    now().getTime() - (parseUtcSql(createdAt)?.getTime() ?? 0) >=
    OFFER_RETENTION_DAYS * 86400000
  );
}

function receiptAuthorized(profileId: number, chatId: string): boolean {
  return getProfilesByTelegramChatId(chatId).includes(profileId);
}

// The transaction claims the parent before any network call. An unknown send stays
// sending until explicit cancellation; retries never create a second active prompt.
export async function handleReceivedCallback(
  cq: TelegramCallbackQuery,
  token: OfferCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const senderId = cq.from?.id;
  if (chatId == null || messageId == null || senderId == null) {
    await answerCallbackQuery(cq.id, "This receipt is no longer available.");
    return;
  }
  const chat = String(chatId);
  if (cq.data?.startsWith("rfreceived:")) {
    const claimed = writeTx(() => {
      if (
        !receiptAuthorized(token.profileId, chat) ||
        !hasRefillToken(token.profileId, chat, messageId, cq.data!)
      )
        return null;
      const row = readRefillOffer(token.profileId, token.offerId);
      if (
        !row ||
        row.offer.state !== "available" ||
        refillExpired(row.createdAt)
      )
        return null;
      const stock = refillStock(token.profileId, row.offer.itemId);
      if (
        !stock ||
        stock.quantity == null ||
        stock.supplyId !== row.offer.supplyId
      )
        return null;
      const next: RefillOffer = {
        ...row.offer,
        state: "sending",
        origin: { chatId: chat, messageId, senderId, callbackId: cq.id },
        defaultSize:
          stock.lastFillSize != null && stock.lastFillSize > 0
            ? stock.lastFillSize
            : null,
      };
      return replaceRefillOffer(token.profileId, token.offerId, row.offer, next)
        ? next
        : null;
    });
    if (!claimed) {
      await answerCallbackQuery(
        cq.id,
        "This receipt is already open or no longer available."
      );
      return;
    }
    await answerCallbackQuery(cq.id, "How many arrived?");
    try {
      const promptId = await sendTelegramMessage(
        chat,
        receiptPrompt(token.profileId, token.offerId, claimed),
        token.profileId
      );
      if (promptId == null) return;
      const activated = writeTx(() => {
        const row = readRefillOffer(token.profileId, token.offerId);
        if (
          !row ||
          row.offer.state !== "sending" ||
          !hasRefillToken(
            token.profileId,
            chat,
            promptId,
            offerCallback("rfcancel", token.profileId, token.offerId)
          )
        )
          return false;
        return replaceRefillOffer(token.profileId, token.offerId, row.offer, {
          ...row.offer,
          state: "pending",
          promptId,
        });
      });
      if (!activated) {
        const current = readRefillOffer(token.profileId, token.offerId);
        if (current && refillOfferIsTerminal(current.offer))
          await rebuildMessage(
            token.profileId,
            chat,
            promptId,
            receiptPrompt(token.profileId, token.offerId, current.offer)
          );
      }
    } catch (error) {
      log.info("refill prompt delivery uncertain", {
        profile: token.profileId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
    await refreshReceipt(token.profileId, token.offerId);
    return;
  }
  const cancel = cq.data?.startsWith("rfcancel:") ?? false;
  const text = settleReceived(
    token.profileId,
    token.offerId,
    chat,
    messageId,
    senderId,
    cq.id,
    cancel ? "cancel" : "confirm"
  );
  await answerCallbackQuery(cq.id, text);
  await refreshReceipt(token.profileId, token.offerId);
}

function settleReceived(
  profileId: number,
  offerId: number,
  chatId: string,
  messageId: number,
  senderId: number,
  submissionId: string,
  answer: "cancel" | "confirm" | { amount: string | undefined }
): string {
  return writeTx(() => {
    const row = readRefillOffer(profileId, offerId);
    const offer = row?.offer;
    if (
      !row ||
      !offer?.origin ||
      !receiptAuthorized(profileId, chatId) ||
      offer.origin.chatId !== chatId ||
      offer.origin.senderId !== senderId
    )
      return "This receipt is no longer available.";
    const fromPrompt = offer.promptId === messageId;
    const cancelFromOrigin =
      answer === "cancel" && offer.origin.messageId === messageId;
    if (!fromPrompt && !cancelFromOrigin)
      return "Reply to the original receipt prompt.";
    if (offer.state === "completed" && offer.result)
      return `Already recorded: ${receiptText(offer.result)}`;
    if (refillOfferIsTerminal(offer)) return "This receipt is closed.";
    if (answer === "cancel") {
      replaceRefillOffer(profileId, offerId, offer, {
        ...offer,
        state: "canceled",
      });
      return "Receipt canceled.";
    }
    if (
      offer.state !== "pending" ||
      refillExpired(row.createdAt) ||
      !hasRefillToken(
        profileId,
        chatId,
        messageId,
        offerCallback("rfcancel", profileId, offerId)
      )
    )
      return "This receipt is no longer available.";
    const amount =
      answer === "confirm"
        ? (offer.defaultSize ?? null)
        : parseReceivedAmount(answer.amount);
    if (amount == null || !Number.isFinite(amount) || amount <= 0)
      return "Enter a positive number of units, such as 90.";
    const result = refillSupply(
      profileId,
      offer.itemId,
      amount,
      offer.supplyId
    );
    if (result.kind !== "refilled")
      return "This supply changed. Open its refill form.";
    // The refill owner invalidates sibling offers, including this pending row. Under
    // this same lock only the winning submission may replace its own row with a receipt.
    const current = readRefillOffer(profileId, offerId)!.offer;
    replaceRefillOffer(profileId, offerId, current, {
      ...offer,
      state: "completed",
      result: {
        fillSize: result.fillSize,
        newQuantity: result.newQuantity,
        submissionId,
      },
    });
    return receiptText({ ...result, submissionId });
  });
}

async function refreshReceipt(
  profileId: number,
  offerId: number
): Promise<void> {
  const row = readRefillOffer(profileId, offerId);
  if (!row?.offer.origin) return;
  for (const id of [row.offer.promptId, row.offer.origin.messageId]) {
    if (id == null) continue;
    const pointer = messagePointerAt(profileId, row.offer.origin.chatId, id);
    if (pointer) await reconcileRefillReceipt(profileId, pointer);
  }
}

export async function handleReceivedReply(
  message: TelegramMessage
): Promise<boolean> {
  const token = parseRefillReplyMarker(message.reply_to_message?.text);
  if (!token) return false;
  const chatId = message.chat?.id;
  const promptId = message.reply_to_message?.message_id;
  if (
    chatId == null ||
    promptId == null ||
    message.from?.id == null ||
    message.message_id == null
  )
    return true;
  if (!receiptAuthorized(token.profileId, String(chatId))) return true;
  const text = settleReceived(
    token.profileId,
    token.offerId,
    String(chatId),
    promptId,
    message.from.id,
    String(message.message_id),
    { amount: message.text }
  );
  await sendTelegramMessage(
    chatId,
    { title: "Supply receipt", body: text },
    token.profileId
  );
  await refreshReceipt(token.profileId, token.offerId);
  return true;
}

function receiptIds(tokens: readonly string[]): number[] {
  return [
    ...new Set(
      tokens.flatMap((token) => {
        for (const prefix of ["rfreceived", "rfconfirm", "rfcancel"] as const) {
          const parsed = parseOfferCallback(token, prefix);
          if (parsed) return [parsed.offerId];
        }
        return [];
      })
    ),
  ];
}

function receiptWitness(profileId: number, ids: number[]): string {
  return JSON.stringify(ids.map((id) => [id, readRefillOffer(profileId, id)]));
}

// Refill edits also depend on an operation generation. Gather, witness and pointer
// claim share the lock; an awaited edit cannot finalize a superseded operation.
export async function reconcileRefillReceipt(
  profileId: number,
  pointer: MessagePointer
): Promise<"unhandled" | "unchanged" | "edited"> {
  const tokens = [...pointer.receiptKeyboard, ...pointer.keyboard]
    .flat()
    .flatMap((b) => (b.callback_data ? [b.callback_data] : []));
  const ids = receiptIds(tokens);
  if (!ids.length) return "unhandled";
  const plan = writeTx(() => {
    const currentPointer = messagePointerAt(
      profileId,
      pointer.chatId,
      pointer.messageId
    );
    if (
      !currentPointer ||
      currentPointer.version !== pointer.version ||
      currentPointer.bodyHash !== pointer.bodyHash
    )
      return null;
    const offers = ids
      .map((id) => ({ id, row: readRefillOffer(profileId, id) }))
      .filter((it) => it.row != null);
    const prompt = offers.find(
      (it) => it.row!.offer.promptId === pointer.messageId
    );
    let message: NotificationMessage;
    if (prompt)
      message = receiptPrompt(profileId, prompt.id, prompt.row!.offer);
    else {
      const itemIds = [...new Set(offers.map((it) => it.row!.offer.itemId))];
      const rates = getRefillRates(profileId);
      const lines: string[] = [];
      const actions: NotificationAction[] = [];
      for (const itemId of itemIds) {
        const stock = refillStock(profileId, itemId);
        if (!stock) continue;
        const item = getIntakeItems(profileId).find((it) => it.id === itemId);
        const pool =
          stock.supplyId == null ? null : getPoolView(stock.supplyId);
        const days = pool
          ? pool.daysLeft
          : daysOfSupplyLeft(
              stock.quantity,
              item?.qty_per_dose ?? 1,
              rates.get(itemId)?.dosesPerDay ?? 0
            );
        const low = pool
          ? pool.low
          : isLowSupply(days, DEFAULT_LOW_SUPPLY_DAYS);
        lines.push(
          `${stock.name}: ${stock.quantity ?? "No count"}${stock.quantity == null ? "" : " on hand"}${low ? ` · ≈${days} days left (running low)` : ""}`
        );
        const pending = offers.find(
          (it) =>
            it.row!.offer.itemId === itemId &&
            !refillOfferIsTerminal(it.row!.offer) &&
            it.row!.offer.state !== "available"
        );
        if (low || pending) {
          const action = refillReceivedAction(profileId, itemId);
          if (action) actions.push({ ...action, row: `rf:${itemId}` });
        }
        if (low && stock.supplyId == null)
          actions.push({
            label: `${GLYPH.ordered} Ordered — remind me in 3 days`,
            data: `rfsnooze:${profileId}:${itemId}`,
            row: `rf:${itemId}`,
          });
        const base = getPublicUrl().replace(/\/$/, "");
        if (base)
          actions.push({
            label: "Open refill form",
            url: `${base}${intakeSupplyHref(stock.kind, itemId, true)}`,
            row: `rf:${itemId}`,
          });
      }
      message = {
        title: "Supply update",
        body: lines.join("\n") || "This supply is no longer available.",
        actions,
        kind: "refill",
      };
    }
    const keyboard = deliveredKeyboard(
      composeForRebuild(profileId, message, pointer)
    );
    const bodyHash = messageBodyHash(
      composeForRebuild(profileId, message, pointer)
    );
    if (
      JSON.stringify(keyboard) === pointer.version &&
      bodyHash === pointer.bodyHash
    )
      return null;
    const nextIds = receiptIds(
      message.actions?.flatMap((a) => (a.data ? [a.data] : [])) ?? []
    );
    const watched = [...new Set([...ids, ...nextIds])];
    const witness = receiptWitness(profileId, watched);
    if (
      !claimMessagePointerKeyboard(
        profileId,
        pointer.id,
        pointer.version,
        keyboard,
        { previous: pointer.bodyHash, next: bodyHash }
      )
    )
      return null;
    return { message, keyboard, bodyHash, watched, witness };
  });
  if (!plan) return "unchanged";
  const current = () =>
    receiptWitness(profileId, plan.watched) === plan.witness;
  try {
    await rebuildMessage(
      profileId,
      pointer.chatId,
      pointer.messageId,
      plan.message,
      current
    );
  } catch (error) {
    writeTx(() => {
      if (current())
        releaseMessagePointerKeyboard(
          profileId,
          pointer.id,
          plan.keyboard,
          pointer.version,
          { previous: pointer.bodyHash, next: plan.bodyHash }
        );
    });
    throw error;
  }
  // A lost generation keeps its claimed keyboard only as a retry target. The next
  // sweep derives the new generation and repairs the message; no old ID reactivates.
  return "edited";
}
