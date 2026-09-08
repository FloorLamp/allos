// Private-stock refill reminders share the finding's suppression and episode
// marker. An explicit Ordered request earns one later delivery without changing
// ordinary episode deduplication. Received keeps its separate additive stock core.

import { randomBytes } from "node:crypto";
import { getIntakeItems, getRefillRates } from "../queries";
import { isPushedIntake } from "../intake-schedule";
import { intakeSupplyHref } from "../hrefs";
import { db, today, writeTx, hoistedStatement } from "../db";
import { now } from "../clock";
import { parseUtcSql, shiftDateStr } from "../date";
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
import {
  parseReceivedAmount, parseRefillReplyMarker, parseRefillCallback,
  parseOrderedRefillCallback, orderedRefillToken,
  type RefillCallback, type OrderedRefillCallback,
} from "./refill-tokens";
import { removeRowContaining, refillAnswerText, type RefillTapOutcome } from "./callback-data";
import { NOTIFICATION_DISPATCH_TIMEOUT_MS } from "./dispatch-deadline";
import {
  messagePointerAt,
  claimMessagePointerKeyboard,
  releaseMessagePointerKeyboard,
  releaseMessagePointerBody,
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
import type { TapWrote } from "./callback-data";
import { getFindingSuppressions, snoozeFinding } from "../queries/upcoming";
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
  type RefillDeliveryState,
  parseRefillMarker, refillAttemptDue, cancelRefillRequest,
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
  generation: string;
  kind?: IntakeItemKind;
  received?: NotificationAction | null;
}

// The refill nudge lists each low item with its remaining days. Each item gets an
// Ordered button that snoozes its finding and a Received button that asks for
// the amount in chat. When a public URL is configured, a refill-form link is also
// available. One row per item so a snooze consumes just that item.
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
        data: orderedRefillToken(profileId, it.id, it.generation),
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

const REFILL_MARKER = hoistedStatement(
  "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
);

function readRefillMarker(profileId: number, itemId: number): string | undefined {
  return (REFILL_MARKER.get(profileId, refillMarkerKey(itemId)) as
    { value: string } | undefined)?.value;
}

// Claims cover dispatch's complete deadline, with the existing claim margin.
const REFILL_CLAIM_MS = NOTIFICATION_DISPATCH_TIMEOUT_MS + 30_000;
const newRefillGeneration = () => randomBytes(8).toString("base64url");

function refillCandidates(profileId: number): (RefillCandidate & { kind: IntakeItemKind })[] {
  const rates = getRefillRates(profileId);
  return getIntakeItems(profileId)
    .filter((item) => item.active && item.quantity_on_hand != null &&
      item.supply_id == null && isPushedIntake(item))
    .map((item) => {
      const daysLeft = daysOfSupplyLeft(item.quantity_on_hand, item.qty_per_dose,
        rates.get(item.id)?.dosesPerDay ?? 0);
      return { id: item.id, name: item.name, kind: item.kind, daysLeft,
        low: isLowSupply(daysLeft, DEFAULT_LOW_SUPPLY_DAYS) };
    });
}

// The synchronous claim and post-await comparison share the existing episode
// marker. No transaction spans transport, and a newer user transition always wins.
export async function runRefills(profileId: number, date: string): Promise<{ failed: boolean }> {
  const claimed = writeTx(() => {
    const candidates = refillCandidates(profileId);
    const suppressions = getFindingSuppressions(profileId);
    const markedIds = getProfileSettingKeysWithPrefix(profileId, REFILL_MARKER_PREFIX)
      .map(refillIdFromMarker).filter((id) => Number.isInteger(id) && id > 0);
    const suppressedIds = new Set(candidates.filter((item) => {
      const record = suppressions.get(refillSignalKey(item.id));
      return record != null && isSuppressed(record, date);
    }).map((item) => item.id));
    const { toClear } = planRefillNudges(candidates, markedIds, suppressedIds);
    for (const id of toClear) deleteProfileSetting(profileId, refillMarkerKey(id));

    const out: { item: LowItem; raw: string; state: Extract<RefillDeliveryState, { state: "attempt" }> }[] = [];
    for (const item of candidates) {
      if (!item.low || item.daysLeft == null) continue;
      const raw = readRefillMarker(profileId, item.id);
      const marker = parseRefillMarker(raw);
      const dueOn = marker?.state === "requested" || marker?.state === "attempt"
        ? marker.dueOn : null;
      if (dueOn != null) {
        const suppression = suppressions.get(refillSignalKey(item.id));
        if (suppression?.snooze_until !== dueOn || suppression.dismissed_at != null) {
          const baseline = cancelRefillRequest(raw);
          if (baseline == null) deleteProfileSetting(profileId, refillMarkerKey(item.id));
          else setProfileSetting(profileId, refillMarkerKey(item.id), baseline);
          continue;
        }
      }
      if (suppressedIds.has(item.id) || !refillAttemptDue(marker, date, now().getTime())) continue;
      const state: Extract<RefillDeliveryState, { state: "attempt" }> = {
        v: 1, state: "attempt", g: newRefillGeneration(),
        sentOn: marker?.state === "requested" || marker?.state === "attempt" ? marker.sentOn : null,
        dueOn, claimUntil: now().getTime() + REFILL_CLAIM_MS,
      };
      const next = JSON.stringify(state);
      const received = refillReceivedAction(profileId, item.id);
      setProfileSetting(profileId, refillMarkerKey(item.id), next);
      out.push({ item: { ...item, daysLeft: item.daysLeft, generation: state.g, received }, raw: next, state });
    }
    return out;
  });
  if (!claimed.length) return { failed: false };
  const results = await dispatch(profileId,
    renderRefillMessage(claimed.map(({ item }) => item), profileId, getPublicUrl()));
  const delivered = results.some((r) => r.ok && r.delivered);
  const failed = results.some((r) => !r.ok);
  writeTx(() => {
    for (const attempt of claimed) {
      if (readRefillMarker(profileId, attempt.item.id) !== attempt.raw) continue;
      const next: RefillDeliveryState = delivered
        ? { v: 1, state: "sent", g: attempt.state.g, sentOn: date }
        : { ...attempt.state, claimUntil: null };
      setProfileSetting(profileId, refillMarkerKey(attempt.item.id), JSON.stringify(next));
    }
  });
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
          ? `${GLYPH.ordered} Received`
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
): Promise<TapWrote> {
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
      const current = readRefillOffer(token.profileId, token.offerId)?.offer;
      if (
        current &&
        (current.state === "sending" || current.state === "pending") &&
        receiptAuthorized(token.profileId, chat) &&
        current.origin?.chatId === chat &&
        current.origin.messageId === messageId &&
        current.origin.senderId === senderId
      )
        await refreshReceipt(token.profileId, token.offerId);
      return;
    }
    await answerCallbackQuery(cq.id, "How many arrived?");
    try {
      const promptId = await sendTelegramMessage(
        chat,
        receiptPrompt(token.profileId, token.offerId, claimed),
        token.profileId
      );
      if (promptId != null) {
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
  const outcome = settleReceived(
    token.profileId,
    token.offerId,
    chat,
    messageId,
    senderId,
    cq.id,
    cancel ? "cancel" : "confirm"
  );
  await answerCallbackQuery(cq.id, outcome.text);
  if (outcome.refresh) await refreshReceipt(token.profileId, token.offerId);
  return outcome.wroteProfileId;
}

function settleReceived(
  profileId: number,
  offerId: number,
  chatId: string,
  messageId: number,
  senderId: number,
  submissionId: string,
  answer: "cancel" | "confirm" | { amount: string | undefined }
): { text: string; refresh: boolean; wroteProfileId?: number } {
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
      return { text: "This receipt is no longer available.", refresh: false };
    const fromPrompt = offer.promptId === messageId;
    const cancelFromOrigin =
      answer === "cancel" && offer.origin.messageId === messageId;
    if (!fromPrompt && !cancelFromOrigin)
      return { text: "Reply to the original receipt prompt.", refresh: false };
    if (offer.state === "completed" && offer.result)
      return {
        text: `Already recorded: ${receiptText(offer.result)}`,
        refresh: true,
      };
    if (refillOfferIsTerminal(offer))
      return { text: "This receipt is closed.", refresh: false };
    if (answer === "cancel") {
      replaceRefillOffer(profileId, offerId, offer, {
        ...offer,
        state: "canceled",
      });
      return { text: "Receipt canceled.", refresh: true };
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
      return { text: "This receipt is no longer available.", refresh: false };
    const amount =
      answer === "confirm"
        ? (offer.defaultSize ?? null)
        : parseReceivedAmount(answer.amount);
    if (amount == null || !Number.isFinite(amount) || amount <= 0)
      return {
        text: "Enter a positive number of units, such as 90.",
        refresh: false,
      };
    const result = refillSupply(
      profileId,
      offer.itemId,
      amount,
      offer.supplyId
    );
    if (result.kind !== "refilled")
      return {
        text: "This supply changed. Open its refill form.",
        refresh: false,
      };
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
    return {
      text: receiptText({ ...result, submissionId }),
      refresh: true,
      wroteProfileId: profileId,
    };
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
  const outcome = settleReceived(
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
    { title: "Supply receipt", body: outcome.text },
    token.profileId
  );
  if (outcome.refresh) await refreshReceipt(token.profileId, token.offerId);
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

function currentOrderedActions(
  profileId: number, itemId: number, pointer: MessagePointer,
  liveTokens: readonly string[], receivedStarted: boolean
): NotificationAction[] {
  if (receivedStarted) return [];
  const marker = parseRefillMarker(readRefillMarker(profileId, itemId));
  const legacy = `rfsnooze:${profileId}:${itemId}`;
  const receipt = pointer.receiptKeyboard.flat().map((button) => button.callback_data);
  const row = `rf:${itemId}`;
  if (marker?.state === "confirm" && marker.sourcePointerId === pointer.id &&
      receipt.includes(legacy)) {
    const data = orderedRefillToken(profileId, itemId, marker.g);
    if (!liveTokens.includes(legacy) && !liveTokens.includes(data)) return [];
    return [
      { label: "Remind in 3 days", data, row },
      { label: "Cancel", data: orderedRefillToken(profileId, itemId, marker.g, true), row },
    ];
  }
  if (marker?.state === "sent" || marker?.state === "attempt") {
    const data = orderedRefillToken(profileId, itemId, marker.g);
    if (liveTokens.includes(data) && receipt.includes(data))
      return [{ label: `${GLYPH.ordered} Ordered — remind me in 3 days`, data, row }];
  }
  if (marker?.state === "legacy" && liveTokens.includes(legacy) && receipt.includes(legacy)) {
    const suppression = getFindingSuppressions(profileId).get(refillSignalKey(itemId));
    if (!suppression || !isSuppressed(suppression, today(profileId)))
      return [{ label: `${GLYPH.ordered} Ordered — remind me in 3 days`, data: legacy, row }];
  }
  return [];
}

export async function handleOrderedRefillCallback(
  cq: TelegramCallbackQuery, token: RefillCallback | OrderedRefillCallback
): Promise<TapWrote> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null || !cq.data) {
    await answerCallbackQuery(cq.id, refillAnswerText("stale-item"));
    return;
  }
  const chat = String(chatId);
  const result = writeTx(() => {
    if (!receiptAuthorized(token.profileId, chat)) return null;
    const pointer = messagePointerAt(token.profileId, chat, messageId);
    if (!pointer || pointer.kind !== "refill") return null;
    if (!refillCandidates(token.profileId).some((item) => item.id === token.itemId && item.low)) return null;
    const liveTokens = pointer.keyboard.flat().flatMap((button) => button.callback_data ? [button.callback_data] : []);
    const receivedStarted = receiptIds(liveTokens).some((id) => {
      const offer = readRefillOffer(token.profileId, id)?.offer;
      return offer?.itemId === token.itemId && offer.state !== "available";
    });
    const actions = currentOrderedActions(token.profileId, token.itemId, pointer, liveTokens, receivedStarted);
    const raw = readRefillMarker(token.profileId, token.itemId);
    const marker = parseRefillMarker(raw);
    let consume: string | undefined;
    let retry = false;
    let outcome: RefillTapOutcome;
    if (!("generation" in token)) {
      const legacy = `rfsnooze:${token.profileId}:${token.itemId}`;
      if (cq.data !== legacy) return null;
      if (marker?.state === "confirm" && marker.sourcePointerId === pointer.id && actions.length) {
        retry = true;
      } else {
        if (marker?.state !== "legacy" || !actions.some((a) => a.data === legacy)) return null;
        const next: RefillDeliveryState = { v: 1, state: "confirm", g: newRefillGeneration(),
          sentOn: marker.sentOn, sourcePointerId: pointer.id };
        setProfileSetting(token.profileId, refillMarkerKey(token.itemId), JSON.stringify(next));
      }
      outcome = "confirmation";
    } else {
      if (!marker || !("g" in marker) || marker.g !== token.generation ||
          !liveTokens.includes(cq.data!) || !actions.some((action) => action.data === cq.data)) return null;
      consume = cq.data;
      if (token.cancel) {
        if (marker.state !== "confirm") return null;
        setProfileSetting(token.profileId, refillMarkerKey(token.itemId), marker.sentOn);
        outcome = "cancelled";
      } else {
        if (marker.state !== "sent" && marker.state !== "attempt" && marker.state !== "confirm") return null;
        const dueOn = shiftDateStr(today(token.profileId), 3);
        snoozeFinding(token.profileId, refillSignalKey(token.itemId), dueOn);
        const next: RefillDeliveryState = { v: 1, state: "requested", g: marker.g,
          sentOn: marker.sentOn ?? pointer.date, dueOn };
        setProfileSetting(token.profileId, refillMarkerKey(token.itemId), JSON.stringify(next));
        outcome = "snoozed";
      }
    }
    const plan = planRefillReceipt(token.profileId, pointer, consume, retry);
    if (!plan || plan === "unhandled") throw new Error("The refill reminder changed before it could be updated.");
    // A committed user operation keeps its token claim even if the wire outcome is unknown.
    plan.keepClaim = true;
    return { pointer, plan, outcome };
  });
  if (!result) {
    await answerCallbackQuery(cq.id, refillAnswerText("stale-item"));
    if (!("generation" in token) && receiptAuthorized(token.profileId, chat)) {
      const stock = refillStock(token.profileId, token.itemId);
      const base = getPublicUrl().replace(/\/$/, "");
      if (stock && base) await sendTelegramMessage(chat, {
        title: "Refill reminder",
        body: "This reminder is out of date. Open the current refill form.",
        actions: [{ label: "Open refill form", url: `${base}${intakeSupplyHref(stock.kind, token.itemId, true)}` }],
      }, token.profileId);
    }
    return;
  }
  try {
    await answerCallbackQuery(cq.id, refillAnswerText(result.outcome));
  } finally {
    // A failed acknowledgement must not strand the committed keyboard claim.
    await applyRefillReceiptPlan(token.profileId, result.pointer, result.plan);
  }
  return result.outcome === "snoozed" ? token.profileId : undefined;
}

// Refill edits also depend on an operation generation. Gather, witness and pointer
// claim share the lock; an awaited edit cannot finalize a superseded operation.
function planRefillReceipt(
  profileId: number,
  pointer: MessagePointer,
  consumeToken?: string,
  force = false
) {
  const tokens = [...pointer.receiptKeyboard, ...pointer.keyboard]
    .flat()
    .flatMap((b) => (b.callback_data ? [b.callback_data] : []));
  const ids = receiptIds(tokens);
  const visibleKeyboard = consumeToken ? removeRowContaining(pointer.keyboard, consumeToken) : pointer.keyboard;
  const liveTokens = visibleKeyboard
    .flat()
    .flatMap((b) => (b.callback_data ? [b.callback_data] : []));
  const liveIds = new Set(receiptIds(liveTokens));
  const orderedItems = [...new Set(tokens.flatMap((data) => {
    const parsed = parseOrderedRefillCallback(data) ?? parseRefillCallback(data);
    return parsed?.profileId === profileId ? [parsed.itemId] : [];
  }))];
  if (!ids.length && !orderedItems.length) return "unhandled" as const;
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
      const itemIds = [...new Set([...offers.map((it) => it.row!.offer.itemId), ...orderedItems])];
      const rates = getRefillRates(profileId);
      const orderable = new Set(refillCandidates(profileId).filter((item) => item.low).map((item) => item.id));
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
        const liveOffer = offers.some(
          (it) => liveIds.has(it.id) && it.row!.offer.itemId === itemId
        );
        const ordered = low && stock.supplyId == null && orderable.has(itemId)
          ? currentOrderedActions(profileId, itemId, pointer, liveTokens,
              offers.some((it) => liveIds.has(it.id) && it.row!.offer.itemId === itemId && it.row!.offer.state !== "available"))
          : [];
        lines.push(
          `${stock.name}: ${stock.quantity ?? "No count"}${stock.quantity == null ? "" : " on hand"}${low ? ` · ≈${days} days left (running low)` : ""}`
        );
        if (low && !liveOffer && !ordered.length) continue;
        const pending = offers.find(
          (it) =>
            it.row!.offer.itemId === itemId &&
            !refillOfferIsTerminal(it.row!.offer) &&
            it.row!.offer.state !== "available"
        );
        if (liveOffer && (low || pending)) {
          const action = refillReceivedAction(profileId, itemId);
          if (action) actions.push({ ...action, row: `rf:${itemId}` });
        }
        actions.push(...ordered);
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
      !force && JSON.stringify(keyboard) === pointer.version &&
      bodyHash === pointer.bodyHash
    )
      return null;
    const nextIds = receiptIds(
      message.actions?.flatMap((a) => (a.data ? [a.data] : [])) ?? []
    );
    const watched = [...new Set([...ids, ...nextIds])];
    const witness = JSON.stringify([receiptWitness(profileId, watched), orderedItems.map((id) => [id, readRefillMarker(profileId, id)])]);
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
    return { message, keyboard, bodyHash, watched, orderedItems, witness, keepClaim: consumeToken != null };
  });
  return plan;
}

type RefillEditPlan = Exclude<ReturnType<typeof planRefillReceipt>, null | "unhandled">;

async function applyRefillReceiptPlan(profileId: number, pointer: MessagePointer, plan: RefillEditPlan): Promise<void> {
  const current = () => {
    const claimed = messagePointerAt(
      profileId,
      pointer.chatId,
      pointer.messageId
    );
    return (
      claimed?.version === JSON.stringify(plan.keyboard) &&
      claimed.bodyHash === plan.bodyHash &&
      JSON.stringify([receiptWitness(profileId, plan.watched), plan.orderedItems.map((id) => [id, readRefillMarker(profileId, id)])]) === plan.witness
    );
  };
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
      if (!current()) return;
      if (plan.keepClaim) {
        // Keep consumed tokens retired, but let the next sweep retry the body.
        releaseMessagePointerBody(profileId, pointer.id, plan.bodyHash, null);
      } else releaseMessagePointerKeyboard(
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
}

export async function reconcileRefillReceipt(profileId: number, pointer: MessagePointer): Promise<"unhandled" | "unchanged" | "edited"> {
  const plan = planRefillReceipt(profileId, pointer);
  if (plan === "unhandled") return plan;
  if (!plan) return "unchanged";
  await applyRefillReceiptPlan(profileId, pointer, plan);
  return "edited";
}
