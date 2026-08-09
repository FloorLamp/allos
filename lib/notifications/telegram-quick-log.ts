function prnLogToken(): string {
  return crypto.randomBytes(4).toString("hex");
}

// `/dose` command (#797): list the chat's active PRN (as-needed) medications, each
// as a one-tap "💊 <med>" button that logs an administration now. A chat can map to
// several profiles (a family chat), so buttons for a multi-profile chat are prefixed
// with the profile name; the callback token carries the profile id (re-checked
// against the chat on tap). Sends through the chokepoint (sendTelegramMessage).
export async function handleDoseCommand(
  message: TelegramMessage
): Promise<void> {
  // Is this text a `/dose`? Asked of the VOCABULARY (#2004), never of a private regex:
  // `isCommandText` runs the same parser the dispatcher routed on, so aliases,
  // `@botname` addressing, case and trailing args cannot mean one thing there and
  // another here.
  if (!isCommandText("dose", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "💊 Log a PRN dose",
        body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
        kind: "prn-list",
      },
      CHAT_WIDE
    );
    return;
  }

  const multi = profileIds.length > 1;
  const actions: NotificationAction[] = [];
  // The list states the SAME redose verdict the in-app card renders (#1717) — the
  // gather already carried the interval, the confirmed max and the ingredient-family
  // counters, and this surface threw all of it away for a bare item-only count. The
  // surface with the least context must not do the least checking.
  const now = clockNow();
  for (const pid of profileIds) {
    const prefix = multi ? `${getProfileNameById(pid) ?? "Profile"}: ` : "";
    for (const m of getPrnMedicationsForQuickLog(pid)) {
      actions.push({
        label: `💊 ${prnQuickLogLabel({
          name: m.name,
          prefix,
          dose: formatMedicationDoseProduct(m.amount, m.product),
          status: prnQuickLogRedoseStatus(m, now),
          // Family-aware throughout (#1027): the count the app shows spans the
          // ingredient family, so the list can't read "1 today" where the card says
          // "3 of 4 today across 2 items".
          countToday: m.familyCount,
          maxDailyCount: m.familyMaxDailyCount ?? m.maxDailyCount,
          familyMemberCount: m.familyMemberCount,
        })}`,
        data: `prn:${pid}:${m.id}:${prnLogToken()}`,
      });
    }
  }

  if (actions.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "💊 Log a PRN dose",
        body: "No as-needed medications are set up. Add one under Medications in the app.",
        kind: "prn-list",
      },
      CHAT_WIDE
    );
    return;
  }

  // CHAT_WIDE (#1995): ONE message carries every profile's buttons, prefixed by name,
  // so the chat really is what this is about — and a stable subject is what lets a
  // second `/dose` re-issue onto the same (chat, kind) slot instead of stacking.
  await sendTelegramMessage(
    chatId,
    {
      title: "💊 Log a PRN dose",
      body: "Tap a medication to record a dose now:",
      actions,
      kind: "prn-list",
    },
    CHAT_WIDE
  );
}

// A PRN log button tap: log one administration NOW for the named item, scoped to the
// profile resolved from the chat (never the token's profile id on its own). Answers
// from the typed AdministrationOutcome — never an unconditional "Logged" (the
// markDoseTaken contract) — and deliberately leaves the /dose message + buttons in
// place so the user can log again later (a PRN med is given multiple times a day).
export async function handlePrnLogTap(
  cq: TelegramCallbackQuery,
  token: PrnLogCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = logAdministration(profileId, token.itemId);
  const name = getIntakeItemName(profileId, token.itemId) ?? "medication";
  // The answer states the verdict that now stands (#1717), read back from POST-write
  // state through the same classification the card shows — so an at-max tap says
  // "Max reached · 5 of 4 today" instead of a bare "Logged ✅". The app treats a
  // redose window as guidance rather than a gate, so Telegram logs it too; what it
  // must not be is LAXER about saying so.
  const logged = administrationLogged(outcome);
  const med = logged
    ? getPrnMedicationsForQuickLog(profileId).find((m) => m.id === token.itemId)
    : undefined;
  await answerCallbackQuery(
    cq.id,
    prnLogAnswerText(
      administrationOutcomeText(outcome, name),
      logged,
      med ? prnQuickLogRedoseStatus(med, clockNow()) : null,
      med?.familyMemberCount ?? 1
    )
  );
}

// A practice "Done ✓" tap (#1259): log one session NOW for the tapped target's practice,
// scoped to the profile resolved from the chat (never the token's profile id alone).
// Answers from the typed PracticeLogOutcome — never an unconditional confirm (a session
// log is not idempotent) — and CONSUMES the tapped button so a stale message can't
// double-log; sibling practice buttons survive so the nudge stays usable.
export async function handlePracticeDoneTap(
  cq: TelegramCallbackQuery,
  token: PracticeDoneCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = logPracticeByTargetId(profileId, token.targetId);
  await answerCallbackQuery(cq.id, practiceLogOutcomeText(outcome));

  const messageId = cq.message?.message_id;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (chatId == null || messageId == null || rows.length === 0) return;
  const remaining = removeButton(rows, cq.data as string);
  if (remaining.length === 0) {
    await closeMessage(
      chatId,
      messageId,
      replacementWithTitle(
        cq.message?.text,
        outcome.kind === "logged" ? "Logged ✅" : OUTDATED_MESSAGE_TEXT
      )
    );
  } else {
    await updateMessageKeyboard(chatId, messageId, remaining);
  }
}

// The profile's top symptoms for the quick-log grid: its recency-ranked logged
// symptoms, falling back to a handful of common curated symptoms for a profile that
// hasn't logged any yet. Capped so the grid stays tappable.
const SYMPTOM_GRID_CAP = 8;
function symptomGridKeys(profileId: number): string[] {
  const ranked = getSymptomLogOrder(profileId).slice(0, SYMPTOM_GRID_CAP);
  if (ranked.length > 0) return ranked;
  return PICKER_SYMPTOMS.slice(0, SYMPTOM_GRID_CAP).map((s) => s.slug);
}

// `/symptom` command (#859 item 5): list the chat's profiles' ranked symptoms, each a
// one-tap button that opens a severity picker. A multi-profile chat prefixes buttons
// with the profile name; the callback token carries the profile id (re-checked on tap).
export async function handleSymptomCommand(
  message: TelegramMessage
): Promise<void> {
  // `/symptoms` resolves through the alias table, not through an `s?` here (#2004).
  if (!isCommandText("symptom", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "Log a symptom",
        body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
        kind: "symptom",
      },
      CHAT_WIDE
    );
    return;
  }

  const multi = profileIds.length > 1;
  const actions: NotificationAction[] = [];
  for (const pid of profileIds) {
    const prefix = multi ? `${getProfileNameById(pid) ?? "Profile"}: ` : "";
    for (const slug of symptomGridKeys(pid)) {
      actions.push({
        label: `${prefix}${symptomLabel(slug)}`,
        data: `symp:${pid}:${slug}`,
      });
    }
  }

  await sendTelegramMessage(
    chatId,
    {
      title: "Log a symptom",
      body: "Tap a symptom, then choose how bad it is:",
      actions,
      kind: "symptom",
    },
    CHAT_WIDE
  );
}

// A symptom button tap: replace the grid with a severity picker for the chosen symptom.
export async function handleSymptomPick(
  cq: TelegramCallbackQuery,
  token: SymptomPickCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const label = symptomLabel(token.slug);
  const actions: NotificationAction[] = [1, 2, 3, 4].map((sev) => ({
    label: SYMPTOM_SEVERITY_LABELS[sev],
    data: `symsev:${profileId}:${sev}:${token.slug}`,
    row: "sev",
  }));
  await rebuildMessage(profileId, chatId, messageId, {
    title: `🤒 Log a symptom: ${label}`,
    body: "How bad is it?",
    actions,
    kind: "symptom",
  });
  await answerCallbackQuery(cq.id);
}

// A severity button tap: log the symptom-day and answer from the typed outcome (never
// an unconditional confirm — the markDoseTaken contract). Closes the picker on success.
// A mood check-in face tap (#992). Runs the SAME upsertMoodLog core as the
// dashboard card and the offline replay (idempotent per profile+date — which also
// resets the reminder's ignored counter, re-arming an auto-paused check-in), and
// answers from the write's actual outcome — never an unconditional confirm. A tap
// on a day that ALREADY has a check-in (e.g. an old message tapped after logging
// in-app) carries the stored expand fields along so it only changes the valence.
export async function handleMoodTap(
  cq: TelegramCallbackQuery,
  token: MoodCheckinCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const existing = getMoodOnDate(profileId, token.date);
  const ok = upsertMoodLog(profileId, token.date, {
    valence: token.valence,
    energy: existing?.energy ?? null,
    anxiety: existing?.anxiety ?? null,
    factors: existing?.factors ?? [],
    note: existing?.notes ?? null,
  });
  if (!ok) {
    await answerCallbackQuery(cq.id, "Couldn't log that check-in.");
    return;
  }
  const label = moodLabel(token.valence);
  await answerCallbackQuery(cq.id, `Logged: ${label}`);
  await closeMessage(
    chatId,
    messageId,
    `${moodFace(token.valence)} Logged — ${label}. Thanks for checking in.`
  );
}

// The "Keep daily check-ins" tap (#1668). Resets the ignored streak — the SAME write a
// logged mood performs, so one mechanism serves three entry points — and answers from
// the typed decision, never an unconditional confirm: the streak may have been re-armed
// already by a mood logged elsewhere, and the check-in may have been turned off since
// the message was sent.
export async function handleMoodKeepTap(
  cq: TelegramCallbackQuery,
  token: MoodKeepCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = decideMoodKeep({
    enabled: getProfileMoodCheckin(profileId),
    ignoredCount: getMoodCheckinIgnored(profileId),
  });
  if (outcome === "kept") resetMoodCheckinIgnored(profileId);
  await answerCallbackQuery(cq.id, moodKeepAnswerText(outcome));
  await closeMessage(
    chatId,
    messageId,
    replacementWithTitle(cq.message?.text, moodKeepCloseText(outcome))
  );
}

export async function handleSymptomSeverity(
  cq: TelegramCallbackQuery,
  token: SymptomSeverityCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || chatId == null || messageId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = logSymptomCore(
    profileId,
    token.slug,
    token.severity,
    today(profileId)
  );
  if (outcome.kind === "invalid") {
    await answerCallbackQuery(cq.id, "Couldn't log that symptom.");
    return;
  }
  const label = symptomLabel(outcome.symptom);
  const sevLabel =
    SYMPTOM_SEVERITY_LABELS[outcome.severity] ?? String(outcome.severity);
  await answerCallbackQuery(
    cq.id,
    `Logged: ${label} (${sevLabel.toLowerCase()})`
  );
  await closeMessage(chatId, messageId, `✅ Logged ${label} — ${sevLabel}.`);
}

// `/temp` command (#859 item 5): prompt the chat to REPLY with a reading. The prompt
// body carries a "(#temp:<profileId>)" marker per profile, so the reply
// (handleTempReply) attributes without any server-side pending state. A multi-profile
// chat gets one named prompt each.
export async function handleTempCommand(
  message: TelegramMessage
): Promise<void> {
  // `/temperature` resolves through the alias table, not through an optional group
  // here (#2004).
  if (!isCommandText("temp", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "Log a temperature",
        body: "This chat isn't linked to a profile yet — enable Telegram in Settings → Profile.",
        kind: "temp",
      },
      CHAT_WIDE
    );
    return;
  }

  const multi = profileIds.length > 1;
  for (const pid of profileIds) {
    const who = multi ? `${getProfileNameById(pid) ?? "Profile"}'s ` : "";
    // ONE PROMPT PER PROFILE, so each names its own subject (#1995). This is the shape
    // that made the old "lowest profile in the chat" guess indefensible: N messages
    // would all have recorded their pointer under one borrowed owner, and in a family
    // chat each member's send would rotate somebody else's slot.
    await sendTelegramMessage(
      chatId,
      {
        title: "Log a temperature",
        body:
          `Reply to this message with ${who}temperature — e.g. 38.5, or 101F ` +
          `(add C or F to be explicit). ${tempReplyMarker(pid)}`,
        kind: "temp",
      },
      pid
    );
  }
}

// A reply to a `/temp` prompt (#859 item 5): resolve the profile from the prompt's
// marker, parse the value + unit from the reply body, log it, and answer honestly from
// the typed TemperatureLogOutcome — with the single-reading red-flag note when the
// reading crosses one. Returns whether the message was a temp reply (so the message
// dispatcher can stop). Never unconditionally confirms.
export async function handleTempReply(
  message: TelegramMessage
): Promise<boolean> {
  const chatId = message.chat?.id;
  const replyText = message.reply_to_message?.text;
  const markedProfile = parseTempReplyMarker(replyText);
  if (chatId == null || markedProfile == null) return false;

  // Only honor the marker when the profile is actually reachable from this chat.
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (!profileIds.includes(markedProfile)) {
    await sendTelegramMessage(
      chatId,
      {
        title: "🌡️ Temperature not logged",
        body: "That profile isn't linked to this chat anymore.",
      },
      CHAT_WIDE
    );
    return true;
  }

  const parsed = parseTempReply(message.text);
  if (!parsed) {
    await sendTelegramMessage(
      chatId,
      {
        title: "🌡️ Temperature not logged",
        body: "Couldn't read a temperature there — reply with a number like 38.5 or 101F.",
      },
      markedProfile
    );
    return true;
  }

  const date = today(markedProfile);
  const outcome = logTemperatureCore(
    markedProfile,
    parsed.value,
    parsed.unit,
    date
  );
  if (outcome.kind === "invalid") {
    await sendTelegramMessage(
      chatId,
      {
        title: "🌡️ Temperature not logged",
        body: outcome.error,
      },
      markedProfile
    );
    return true;
  }
  // Event-driven red-flag push (#1025): a crossing reading dispatches the
  // co-caregiver nudge NOW (fire-and-forget, quiet-hours exempt like redose); the
  // per-finding marker + bus own dedup, so the logger's own toast below and the
  // push can't double-nag.
  queueTempRedFlagDispatch(markedProfile, outcome.degF);
  const redFlag = inlineTempRedFlagNote(
    outcome.degF,
    profileAgeMonths(markedProfile, date)
  );
  const feverNote = outcome.flag === "high" ? " — fever" : "";
  // "Logged." duplicated the title's verb and said nothing (#1722 item 6). With no
  // red flag the reply states the reading and offers the episode, which the red-flag
  // and illness-care messages both already carry.
  const base = getPublicUrl().replace(/\/$/, "");
  const episodeId = currentEpisodeForProfile(markedProfile)?.id ?? null;
  // The subject is the profile the REPLY MARKER named and this chat was just checked
  // against (#1995) — the one whose reading was logged. The confirmation can carry a
  // keyboard (the episode link), so before the subject was declared this pointer was
  // recorded against whichever profile happened to sort first in the chat.
  await sendTelegramMessage(
    chatId,
    {
      title: `🌡️ Temperature logged: ${fmtTemp(outcome.degF, parsed.unit)}${feverNote}`,
      body:
        redFlag ?? `${fmtTemp(outcome.degF, parsed.unit)} recorded for today.`,
      ...(base && episodeId != null
        ? {
            actions: [
              {
                label: "View episode",
                url: `${base}${episodeHref(episodeId)}`,
              },
            ],
          }
        : {}),
    },
    markedProfile
  );
  return true;
}

// `/mood` command (#1895): the daily wellbeing check-in keyboard, ON DEMAND. Scheduled
// sends ride the evening slot; if the nudge scrolled away, was never enabled for that
// hour, or the day simply got away from someone, there was no path to it from the chat.
//
// A RE-RENDER, never a second engine (#221): it calls the SAME `buildMoodCheckin` the
// tick calls, so the faces, the token shape and the auto-pause "keep these coming"
// affordance are whatever the send renderer says they are.
//
// ONE MESSAGE, per-profile buttons — the `/dose` precedent. A multi-profile chat gets
// each member's faces prefixed with their name rather than a guess about whose day is
// being logged, and one message rather than N keeps the (chat, kind) supersede
// invariant (#1898) from closing a sibling the same command just sent.
//
// A build that yields NOTHING is answered honestly rather than with an empty keyboard:
// `buildMoodCheckin` returns null for a day already logged, and saying so is the whole
// point — a command that silently produced nothing is the defect #1895 exists to fix.
export async function handleMoodCommand(
  message: TelegramMessage
): Promise<void> {
  const chatId = message.chat?.id;
  if (chatId == null) return;
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) return;

  const multi = profileIds.length > 1;
  const actions: NotificationAction[] = [];
  const alreadyLogged: string[] = [];
  for (const pid of profileIds) {
    const name = getProfileNameById(pid) ?? "Profile";
    const built = buildMoodCheckin(pid, today(pid));
    if (!built) {
      if (getMoodOnDate(pid, today(pid)) != null) alreadyLogged.push(name);
      continue;
    }
    for (const a of built.actions ?? []) {
      actions.push({
        ...a,
        label: multi ? `${name}: ${a.label}` : a.label,
        // Keep each profile's faces on their own row in a shared chat.
        row: multi ? `mood-${pid}` : a.row,
      });
    }
  }

  if (actions.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "🙂 Check-in",
        body: alreadyLogged.length
          ? `Already checked in today${multi ? ` (${alreadyLogged.join(", ")})` : ""} — open the app to change it.`
          : "The daily check-in is off. Turn it on under Settings → Notifications.",
        kind: "mood",
      },
      CHAT_WIDE
    );
    return;
  }

  // CHAT_WIDE (#1995), and that is the whole reason this command merges every member's
  // faces into ONE message: a stable subject per (chat, kind) is what keeps the
  // supersede invariant from closing a sibling the same command just sent.
  await sendTelegramMessage(
    chatId,
    {
      title: "🙂 How are you today?",
      body: "One tap logs your day — or just skip this.",
      actions,
      kind: "mood",
    },
    CHAT_WIDE
  );
}

// `/food` command (#1895): the food-log keyboard for the CURRENT slot, on demand. The
// domain has had inline logging buttons since #682, but only if a nudge happened to
// arrive — an opted-out profile, a slot whose send was hours ago, or a nudge that
// scrolled away all left the chat with no door.
//
// A RE-RENDER, never a second engine (#221): `buildFoodNudge` is the builder the tick
// calls, the reconcile rebuilds with, and every tap re-renders through, so the ranked
// buttons, the day counts, the protein line and the eating-time chips are whatever the
// send renderer says they are — for the slot the profile is IN right now
// (`currentFoodSlot`, the same derivation the Food tab's chip reads).
//
// ONE MESSAGE PER PROFILE, not one merged keyboard (the `/temp` shape, not `/dose`'s):
// the food family's reconciler REBUILDS a nudge from its first `food:` token, so two
// profiles' buttons in one message would have every rebuild silently render one
// profile's nudge over the other's. Each message therefore declares its own subject
// (#1995) and rotates its own #947 pointer.
//
// It is deliberately NOT gated on the food_telegram_enabled opt-in: that flag governs
// whether the tick may CONTACT someone, and this is a reply to a message they just sent.
// Nothing here sends anything nobody asked for.
export async function handleFoodCommand(
  message: TelegramMessage
): Promise<void> {
  if (!isCommandText("food", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) return;

  const skipped: string[] = [];
  for (const pid of profileIds) {
    const built = buildFoodNudge(pid, currentFoodSlot(pid), today(pid));
    // Null is the life-stage gate (an infant logs no food groups, #591) — answered
    // honestly below rather than with an empty keyboard.
    if (!built) {
      skipped.push(getProfileNameById(pid) ?? "Profile");
      continue;
    }
    // Attribution through the ONE derivation (#429), never a hand-built "[Name] ":
    // the sweep's rebuild re-applies `prefixForProfile` at the chokepoint (#377), so a
    // prefix minted by any other rule would silently appear or vanish the first time
    // this nudge is rebuilt.
    await sendTelegramMessage(
      chatId,
      prefixMessage(built, prefixForProfile(pid)),
      pid
    );
  }

  if (skipped.length === profileIds.length) {
    await sendTelegramMessage(
      chatId,
      {
        title: "🍽️ Log food",
        body: "Food-group logging doesn't apply here yet. Everything else is in the app.",
        kind: "food",
      },
      CHAT_WIDE
    );
  }
}

// `/practice` command (#1895): the tracked wellness practices as one-tap buttons.
// Telegram has offered practice logging since #1259 but ONLY on the pace nudge, so a
// practice you are on track with had no chat door at all.
//
// ONE MESSAGE, per-profile prefixed buttons — the `/dose` shape, since the list's
// buttons carry their own profile id and nothing rebuilds the message from a single
// token. CHAT_WIDE (#1995) keeps the (chat, kind) supersede slot stable, so a second
// `/practice` re-issues THE list rather than stacking a second one (#1898).
export async function handlePracticeCommand(
  message: TelegramMessage
): Promise<void> {
  if (!isCommandText("practice", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) return;

  const multi = profileIds.length > 1;
  const nonce = crypto.randomBytes(4).toString("hex");
  const actions: NotificationAction[] = [];
  const lines: string[] = [];
  for (const pid of profileIds) {
    const name = getProfileNameById(pid) ?? "Profile";
    const built = buildPracticeList(pid, nonce);
    if (!built) continue;
    lines.push(
      multi ? `${name}\n${plainBody(built.body)}` : plainBody(built.body)
    );
    for (const a of built.actions ?? []) {
      actions.push({
        ...a,
        label: multi ? `${name}: ${a.label}` : a.label,
        row: multi ? `practice-${pid}` : a.row,
      });
    }
  }

  if (actions.length === 0) {
    await sendTelegramMessage(
      chatId,
      {
        title: "🧘 Log a practice",
        body: "No wellness practices are tracked yet. Add one under Practices in the app.",
        kind: "practice-list",
      },
      CHAT_WIDE
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    {
      title: "🧘 Log a practice",
      body: lines.join("\n"),
      actions,
      kind: "practice-list",
    },
    CHAT_WIDE
  );
}

// `/weight` command (#1895): the `/temp` prompt-reply shape, one quantity over. A
// weight is a single number, which is exactly the capture a chat does well and exactly
// what a keyboard cannot do — so the prompt asks for a reply and carries a marker that
// attributes it, with no server-side pending state. A multi-profile chat gets one named
// prompt each, never a guess about whose weigh-in this is.
export async function handleWeightCommand(
  message: TelegramMessage
): Promise<void> {
  if (!isCommandText("weight", message.text)) return;
  const chatId = message.chat?.id;
  if (chatId == null) return;
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length === 0) return;

  const multi = profileIds.length > 1;
  for (const pid of profileIds) {
    const who = multi ? `${getProfileNameById(pid) ?? "Profile"}'s ` : "";
    await sendTelegramMessage(
      chatId,
      {
        title: "Log a weight",
        body:
          `Reply to this message with ${who}weight — e.g. 82.5, or 180 lb ` +
          `(kg unless you say otherwise). ${weightReplyMarker(pid)}`,
        kind: "weight",
      },
      pid
    );
  }
}

// A reply to a `/weight` prompt (#1895) — the `/temp` reply handler's twin: resolve the
// profile from the prompt's marker, parse the number through the SAME grammar the
// palette's `weight 82.5` uses, write through the SAME `insertBodyMetric` core every
// weight entry goes through (canonical kg conversion server-side, at the boundary), and
// answer from what the write actually returned. Returns whether the message was a weight
// reply, so the dispatcher can stop. Never confirms unconditionally.
export async function handleWeightReply(
  message: TelegramMessage
): Promise<boolean> {
  const chatId = message.chat?.id;
  const markedProfile = parseWeightReplyMarker(message.reply_to_message?.text);
  if (chatId == null || markedProfile == null) return false;

  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (!profileIds.includes(markedProfile)) {
    await sendTelegramMessage(
      chatId,
      {
        title: "⚖️ Weight not logged",
        body: "That profile isn't linked to this chat anymore.",
      },
      CHAT_WIDE
    );
    return true;
  }

  // kg by default: a chat carries no login unit preference (#857 lives on the login,
  // and several logins with different preferences can watch one profile), so the
  // notification unit policy applies — canonical kg, with an explicit lb still honored.
  const parsed = parseWeightEntry((message.text ?? "").trim(), "kg");
  if (parsed.error || !Number.isFinite(parsed.value)) {
    await sendTelegramMessage(
      chatId,
      {
        title: "⚖️ Weight not logged",
        body:
          parsed.error ??
          "Couldn't read a weight there — reply with a number like 82.5.",
      },
      markedProfile
    );
    return true;
  }

  // Time-blind: a `/weight` reply states a number and nothing about when, so the
  // core's stated-time verdict is always "unstated" on this path (#2311).
  const { wrote } = insertBodyMetric(markedProfile, {
    date: today(markedProfile),
    weight: String(parsed.value),
    weightUnit: parsed.unit,
    bodyFatPct: null,
    restingHr: null,
    notes: null,
  });
  await sendTelegramMessage(
    chatId,
    wrote
      ? {
          title: `⚖️ Weight logged: ${fmtWeight(toKg(parsed.value, parsed.unit), "kg")}`,
          body: "Recorded for today.",
        }
      : {
          title: "⚖️ Weight not logged",
          body: "Couldn't record that weight — try again in the app.",
        },
    markedProfile
  );
  return true;
}

// The ONE inbound text-message dispatcher (webhook + poller both call this), and since
// #1895 the ONE router for the command vocabulary too.
//
// THE RULE IT ENFORCES: a slash command in a chat the bot is in gets an answer. Always.
// Before #1895 every handler no-opped on non-matching text and nothing answered
// afterwards, so `/start` — the first thing Telegram shows a new user — `/help`, and a
// typo'd `/doze` all vanished into silence, which from the chat's side is
// indistinguishable from the bot being broken.
//
// Order matters and is deliberate:
//
//   1. a REPLY to a `/temp` prompt, which is not a command and must not be re-parsed;
//   2. a slash command, routed by the parsed verb (aliases resolved) — one switch, so a
//      verb in the vocabulary that nobody wired up is a compile-time gap rather than a
//      silent one;
//   3. ordinary text, which is NOT addressed to the bot and is the only case that may
//      go unanswered — the free-text symptom intake (#877) claims it or nothing does.
export async function handleIncomingMessage(
  message: TelegramMessage
): Promise<void> {
  if (await handleTempReply(message)) return;
  // The second prompt-reply flow (#1895). Same arm, same reason: a REPLY to a prompt is
  // not a command and must not be re-parsed as one. Each marker is its own, so the two
  // cannot claim each other's replies.
  if (await handleWeightReply(message)) return;

  const parsed = parseCommand(message.text);
  if (!parsed) {
    // Free-text symptom intake (#877): a plain sentence during an open episode maps
    // onto the vocabulary and replies with confirm buttons. Deliberately conservative
    // and unchanged by this issue.
    await handleSymptomTextIntake(message);
    return;
  }

  const chatId = message.chat?.id;
  if (chatId == null) return;
  const ctx = chatCommandContext(chatId);

  // A slash-word this build does not ship. Echoed back so a typo reads as a typo.
  if (!parsed.name) {
    await sendUnknownCommand(chatId, parsed.typed);
    return;
  }

  if (!isCommandAvailable(parsed.name, ctx)) {
    // An UNLINKED chat is told what is actually wrong (nothing is wired up yet), not
    // that this one verb is unavailable — the same answer /help gives it.
    if (!ctx.linked) {
      await sendHelp(chatId, ctx);
      return;
    }
    // A real verb, gated off for this chat. Answered differently from an unknown one:
    // "not set up here" and "not a thing" send you looking in two different places.
    await sendUnavailable(chatId, parsed.name);
    return;
  }

  switch (parsed.name) {
    case "help":
      await sendHelp(chatId, ctx);
      return;
    case "start":
      await sendStart(chatId, ctx);
      return;
    case "dose":
      await handleDoseCommand(message);
      return;
    case "symptom":
      await handleSymptomCommand(message);
      return;
    case "temp":
      await handleTempCommand(message);
      return;
    case "mood":
      await handleMoodCommand(message);
      return;
    case "food":
      await handleFoodCommand(message);
      return;
    case "practice":
      await handlePracticeCommand(message);
      return;
    case "weight":
      await handleWeightCommand(message);
      return;
    default:
      // A verb declared in TELEGRAM_COMMANDS with no route here. Unreachable while the
      // completeness pin in lib/__db_tests__/telegram-commands.test.ts is green, and it
      // still answers rather than falling silent.
      await sendUnknownCommand(chatId, parsed.typed);
      return;
  }
}

// Free-text symptom intake (issue #877): map a plain-text message onto the symptom
// vocabulary via the Light tier and reply with per-symptom confirm buttons that reuse
// the existing severity handler (suggest-only — nothing logs until a button is tapped).
// Deliberately conservative so ordinary chat isn't hijacked: only fires for a
// SINGLE-profile chat with an OPEN illness episode, and only when the Light tier is
// configured. Returns true when it took over the message.
export async function handleSymptomTextIntake(
  message: TelegramMessage
): Promise<boolean> {
  const text = (message.text ?? "").trim();
  if (!text || text.startsWith("/")) return false;
  const chatId = message.chat?.id;
  if (chatId == null) return false;
  if (!isTaskConfigured("symptom-map")) return false;

  // One profile per chat only — a plain sentence carries no profile token, so a
  // multi-profile chat can't be safely attributed (never guess whose symptom it is).
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  if (profileIds.length !== 1) return false;
  const profileId = profileIds[0];

  // Gate on an open illness episode so chit-chat isn't parsed as symptoms.
  if (!currentEpisodeForProfile(profileId)) return false;

  const outcome = await mapSymptomText(text, {
    slugs: symptomSlugs(),
    labels: Object.fromEntries(PICKER_SYMPTOMS.map((s) => [s.slug, s.label])),
    customNames: getCustomSymptomNames(profileId),
  });
  if (outcome.status !== "ok") return false;

  // Confirm buttons only for CURATED slugs — their callback data is colon-safe. Custom
  // proposals + unmapped fragments are named in the body for the user to add in-app.
  const curated = outcome.mapping.symptoms.filter((s) => !s.isCustom);
  if (curated.length === 0) return false;
  const actions: NotificationAction[] = curated.map((s) => ({
    label: `${symptomLabel(s.slug)} — ${SYMPTOM_SEVERITY_LABELS[s.severity] ?? s.severity}`,
    data: `symsev:${profileId}:${s.severity}:${s.slug}`,
  }));

  const extras: string[] = [];
  if (outcome.mapping.temperature) {
    const t = outcome.mapping.temperature;
    extras.push(`🌡 Temperature ${t.value}°${t.unit} — log it with /temp.`);
  }
  const notMapped = [
    ...outcome.mapping.symptoms.filter((s) => s.isCustom).map((s) => s.label),
    ...outcome.mapping.unmapped,
  ];
  if (notMapped.length > 0) {
    extras.push(`Not mapped: ${notMapped.join(", ")} — add these in the app.`);
  }

  // The single profile this intake already refused to run without (#1995): a plain
  // sentence carries no profile token, so the gate above only fires for a one-profile
  // chat — which means the subject is known exactly, not resolved by sort order.
  await sendTelegramMessage(
    chatId,
    {
      title: "Log these symptoms?",
      body:
        "Tap each to confirm — nothing is logged until you do." +
        (extras.length ? `\n${extras.join("\n")}` : ""),
      actions,
    },
    profileId
  );
  return true;
}

// Drop the tapped button's WHOLE row and, when it was the last row, replace the
// message text with a closing line (buttons gone). Shared by the preventive and
// refill handlers, whose per-item rows each resolve one item. Mirrors the dose
// handler's keyboard-rebuild discipline: only act when the message actually had
// buttons, so an absent keyboard can't overwrite the text.
import crypto from "node:crypto";
import { collapsedOfferAction, expandedOfferActions } from "./offer-tail";
import {
  collapsedTuneAction,
  expandedTuneActions,
  tunableCategoriesFor,
  tuneToggleAnswer,
} from "./digest-tune";
import { digestTunableCategories } from "./digest-data";
import {
  getLoginDigestDemotions,
  loginIdsForTelegramChat,
  toggleLoginDigestDemotion,
} from "../settings";
import type {
  DemoteCallback,
  OfferTailCallback,
  TuneCallback,
} from "./callback-data";
import { demoteIntakeObligation } from "../intake-obligation-write";
import { DEMOTION_OUTCOME_TEXT } from "../supplement-demotion";
import { collectRightSizeCandidates } from "../rule-findings";
import { lowerFrequencyTargetFloor } from "../target-rightsize-write";
import { RIGHTSIZE_OUTCOME_TEXT } from "../target-rightsize";
import { getOfferedIntakeForSlot } from "../queries/intake";
import { messageKeyboard } from "./telegram-render";
import { zonedDateParts } from "../date";

import {
  getCustomSymptomNames,
  getDoseEscalateChatId,
  getIntakeItemName,
  getPrnMedicationsForQuickLog,
  getSymptomLogOrder,
  logAdministration,
  logPracticeByTargetId,
} from "../queries";
import { practiceLogOutcomeText } from "../practice";
import { getDigestTimeSuggestion } from "../queries/digest-time-suggestion";
import {
  DIGEST_TIME_DISMISS_ANSWER,
  DIGEST_TIME_STALE_TEXT,
  digestTimeDismissToken,
  digestTimeDynamicAnswer,
  digestTimeDynamicToken,
  digestTimeUseAnswer,
  digestTimeUseToken,
} from "../digest-time-suggestion";
import { setDigestMinute, setDigestMode } from "../settings";
import { dismissFinding } from "../queries/upcoming/suppressions";
import { today } from "../db";
import {
  getMoodCheckinIgnored,
  getProfileMoodCheckin,
  getProfilesByTelegramChatId,
  getTimezone,
  getUserAge,
  resetMoodCheckinIgnored,
} from "../settings";
import { getProfileNameById } from "../profile-summary-load";
import { prefixForProfile } from "./attribution";
import { buildMoodCheckin } from "./mood";
import { buildFoodNudge } from "./food";
import { currentFoodSlot } from "../queries";
import { buildPracticeList } from "./practices";
import { plainBody } from "./rich-text";
import { parseWeightEntry } from "../palette-quick-log";
import { insertBodyMetric } from "../offline/writes";
import { fmtWeight } from "../units";
import { toKg } from "../units";
import { isCommandText, parseCommand } from "./telegram-commands";
import {
  chatCommandContext,
  isCommandAvailable,
  sendHelp,
  sendStart,
  sendUnavailable,
  sendUnknownCommand,
} from "./telegram-help";
import { getPublicUrl } from "../settings";
import {
  administrationLogged,
  administrationOutcomeText,
} from "../administration-format";
import { prnLogAnswerText, prnQuickLogLabel } from "../redose-format";
import { prnQuickLogRedoseStatus } from "../prn-redose";
import { now as clockNow } from "../clock";
import { logSymptomCore } from "../symptom-log-write";
import { upsertMoodLog } from "../offline/writes";
import { getMoodOnDate } from "../queries/mood";
import { decideMoodKeep, moodFace, moodLabel } from "../mood";
import { logTemperatureCore } from "../temperature-log";
import { symptomLabel, symptomSlugs, PICKER_SYMPTOMS } from "../symptoms";
import { currentEpisodeForProfile } from "../illness-episode";
import { episodeHref } from "../hrefs";
import { isTaskConfigured } from "../ai-resolve";
import { mapSymptomText } from "../symptom-text-map";
import { profileAgeMonths } from "../settings";
import { inlineTempRedFlagNote } from "../temp-red-flag";
import { fmtTemp } from "../units";
import { formatMedicationDoseProduct } from "../medication-dose-format";
import { queueTempRedFlagDispatch } from "./temp-red-flag";
import {
  parseMoodCheckinCallback,
  parseMoodKeepCallback,
  moodKeepAnswerText,
  moodKeepCloseText,
  parsePrnLogCallback,
  parseSymptomPickCallback,
  parseSymptomSeverityCallback,
  parseTempReply,
  parseTempReplyMarker,
  parseWeightReplyMarker,
  removeButton,
  replacementWithTitle,
  resolveTapProfile,
  SYMPTOM_SEVERITY_LABELS,
  tempReplyMarker,
  weightReplyMarker,
  OUTDATED_MESSAGE_TEXT,
  type DigestTimeCallback,
  type MoodCheckinCallback,
  type MoodKeepCallback,
  type PracticeDoneCallback,
  type RightSizeLowerCallback,
  type PrnLogCallback,
  type SymptomPickCallback,
  type SymptomSeverityCallback,
} from "./callback-data";
import {
  answerCallbackQuery,
  closeMessage,
  rebuildMessage,
  sendTelegramMessage,
  updateMessageKeyboard,
  CHAT_WIDE,
  type TelegramCallbackQuery,
} from "./telegram";
import type { TelegramMessage } from "./telegram-api";
import { prefixMessage, type NotificationAction } from "./types";

// An offer-tail tap (#1505): expand the digest's "Log other…" button IN PLACE into
// one-tap log buttons for the `may` items on offer RIGHT NOW, or collapse it back.
//
// Nothing is sent and nothing is written — both directions are a single
// editMessageReplyMarkup on a message that already exists. That is the mechanism
// behind the contact-consent rule: the system may give the user more ways to reach
// their own data without ever spending another notification on them.
//
// SLOT SCOPING HAPPENS HERE, at tap time, against the PROFILE-LOCAL clock — not
// against the slot the digest was built in. A morning digest tapped at bedtime must
// offer bedtime items; anything else would be answering a question the user asked now
// with data from eight hours ago.
//
// A tap on a message from a PREVIOUS day is refused rather than silently re-scoped:
// the keyboard belongs to that day's message, and logging "now" from it would attach
// today's administration to yesterday's context.
export async function handleOfferTailTap(
  cq: TelegramCallbackQuery,
  token: OfferTailCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || messageId == null || chatId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const date = today(profileId);
  if (token.date !== date) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;
  const offered = getOfferedIntakeForSlot(profileId, nowHhmm);

  if (token.action === "collapse") {
    // Collapsing restores the digest's WHOLE collapsed keyboard, not just this
    // control: the ⚙️ Tune button (#1714) shares the message and would otherwise be
    // destroyed by the first expand/collapse round-trip.
    await updateMessageKeyboard(
      chatId,
      messageId,
      messageKeyboard({
        title: "",
        body: "",
        actions: [
          collapsedOfferAction(profileId, date, nowHhmm, offered.length),
          ...(digestTunableCategories(profileId, date).length
            ? [collapsedTuneAction(profileId, date)]
            : []),
        ],
      })
    );
    await answerCallbackQuery(cq.id);
    return;
  }

  if (offered.length === 0) {
    // The slot turned over (or the items were paused) since the label was rendered.
    // Say so plainly instead of opening an empty list.
    await answerCallbackQuery(
      cq.id,
      "Nothing available in this slot right now."
    );
    return;
  }
  await updateMessageKeyboard(
    chatId,
    messageId,
    messageKeyboard({
      title: "",
      body: "",
      actions: expandedOfferActions(profileId, date, offered, prnLogToken),
    })
  );
  await answerCallbackQuery(cq.id);
}

// A ⤓ May tap on a dose reminder (#1505 part 2): accept the demotion suggestion for
// the named item.
//
// This is the ONLY obligation write the notification layer can perform, and it is a
// downward one initiated by the user — the two properties that make it safe. It goes
// through the SAME compare-and-swap core the in-app card uses, so the two surfaces
// cannot diverge on outcomes, and it answers from the typed result rather than
// confirming unconditionally: a stale button on a paused or already-may item
// legitimately refuses.
//
// The tapped ROW is consumed on success — take/skip/demote all become meaningless for
// an item that no longer has a scheduled dose — while the rest of the reminder's
// buttons survive so the session stays usable.
export async function handleDemoteTap(
  cq: TelegramCallbackQuery,
  token: DemoteCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const outcome = demoteIntakeObligation(profileId, token.itemId);
  await answerCallbackQuery(cq.id, DEMOTION_OUTCOME_TEXT[outcome]);
  if (outcome !== "demoted" || chatId == null || messageId == null) return;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (rows.length === 0) return;
  await updateMessageKeyboard(
    chatId,
    messageId,
    removeButton(rows, cq.data as string)
  );
}

// A ⤓ right-size tap on the practice nudge (#1670): lower the tapped practice's weekly
// floor to the cadence the profile actually keeps.
//
// This is the notification layer's ONLY frequency-target write, and the two properties
// that make it safe are the same ones the ⤓ May tap has: it is DOWNWARD, and it is
// initiated by the user. It goes through the SAME write core the in-app card uses and,
// critically, re-derives the suggested floor from the live detector rather than reading
// a number off the button — a stale button on a practice whose cadence recovered
// refuses instead of shrinking a commitment nobody is suggesting shrinking.
//
// The tapped ROW is consumed on success (both the ✓ and the ⤓ for that practice become
// stale once its floor moved); the rest of the nudge's buttons survive so the message
// stays usable.
export async function handleRightSizeLowerTap(
  cq: TelegramCallbackQuery,
  token: RightSizeLowerCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const candidate = collectRightSizeCandidates(
    profileId,
    today(profileId)
  ).find((c) => c.targetId === token.targetId);
  if (!candidate || candidate.suggestedFloor == null) {
    await answerCallbackQuery(cq.id, RIGHTSIZE_OUTCOME_TEXT.stale);
    return;
  }
  const outcome = lowerFrequencyTargetFloor(
    profileId,
    candidate.targetId,
    candidate.suggestedFloor
  );
  await answerCallbackQuery(cq.id, RIGHTSIZE_OUTCOME_TEXT[outcome]);
  if (outcome !== "lowered" || chatId == null || messageId == null) return;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (rows.length === 0) return;
  await updateMessageKeyboard(
    chatId,
    messageId,
    removeButton(rows, cq.data as string)
  );
}

// The ⚙️ Tune tap (#1714): per-category digest demotion, driven from the message that
// annoyed you rather than a settings page you visit later (#1505's Take/Skip/Demote
// precedent).
//
// EXPAND AND COLLAPSE ARE NOT SENDS. Both are keyboard edits on a message the user
// already received — Telegram does not notify on an edit, no new row appears in the
// chat, the phone stays silent. That is what lets a control like this exist without
// spending an interruption on it (the contact-consent rule in mechanism form).
//
// THE TOGGLE IS THE ONLY WRITE, and it is the user's own declared preference: nothing
// here infers a demotion, and the write is login-scoped display state, never the data
// subject's records. It answers from the TYPED outcome (which state the category
// actually landed in) rather than confirming unconditionally, and re-renders the
// keyboard so the icons always show the state that was actually stored.
//
// WHICH LOGIN. The preference belongs to the login whose Telegram channel IS this
// chat. A family chat several logins point at resolves to the LOWEST login id — the
// same "first login owns the chat" rule the outbound dedup uses
// (dedupeRecipientsByChat), so inbound and outbound cannot disagree about whose chat
// this is.
export async function handleTuneTap(
  cq: TelegramCallbackQuery,
  token: TuneCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null || messageId == null || chatId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const date = today(profileId);
  // A tap on YESTERDAY's digest would tune against a message whose content has rolled
  // over. Refuse plainly rather than silently retuning from stale context.
  if (token.date !== date) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const loginId = [...loginIdsForTelegramChat(String(chatId))].sort(
    (a, b) => a - b
  )[0];
  if (loginId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }

  if (token.action === "collapse") {
    const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;
    const offered = getOfferedIntakeForSlot(profileId, nowHhmm);
    await updateMessageKeyboard(
      chatId,
      messageId,
      messageKeyboard({
        title: "",
        body: "",
        actions: [
          ...(offered.length
            ? [collapsedOfferAction(profileId, date, nowHhmm, offered.length)]
            : []),
          collapsedTuneAction(profileId, date),
        ],
      })
    );
    await answerCallbackQuery(cq.id);
    return;
  }

  // The write, then the re-render — so the keyboard below is drawn from what was
  // actually stored, never from what the tap intended.
  let answer: string | undefined;
  if (token.action === "toggle" && token.category) {
    const outcome = toggleLoginDigestDemotion(loginId, token.category);
    answer = tuneToggleAnswer(token.category, outcome.demoted);
  }

  const offering = tunableCategoriesFor(
    digestTunableCategories(profileId, date),
    getLoginDigestDemotions(loginId)
  );
  if (offering.length === 0) {
    await answerCallbackQuery(
      cq.id,
      answer ?? "Nothing in today's digest to tune."
    );
    return;
  }
  await updateMessageKeyboard(
    chatId,
    messageId,
    messageKeyboard({
      title: "",
      body: "",
      actions: expandedTuneActions(
        profileId,
        date,
        offering,
        getLoginDigestDemotions(loginId)
      ),
    })
  );
  await answerCallbackQuery(cq.id, answer);
}

// The digest time suggestion's three exits (#2217), tapped from the digest itself.
//
// WHY THE MESSAGE CARRIES THEM AT ALL. This suggestion exists for the person whose
// digest is silently incomplete and who does not reopen Settings — reaching only
// surfaces you must open to see inverts the purpose of a feature whose whole job is to
// run without you (#1685). The LINE is the reach; these are the exits beside it.
//
// EVERY TAP RE-RESOLVES THE LIVE SUGGESTION before it writes. The token carries no
// minute on purpose: a digest sits in a chat for as long as the reader leaves it there,
// and the statistic behind the proposal moves. So `getDigestTimeSuggestion` is asked
// again at tap time and its answer — not the button's memory — is what gets written,
// or the tap is refused and says so (the #1670 ride-along's rule, one control over).
//
// ONE FINDING, ONE EPISODE KEY (constraint 5): 🔕 Not now writes the same suppression
// row the Settings row's "Not now" writes, so declining here also clears the Settings
// row. Two surfaces asking one question twice is exactly the noise this is bounded
// against.
//
// THE ROW IS CONSUMED on any successful tap — all three exits answer the same question,
// so leaving the other two live would invite a second answer to a question already
// answered. A refused tap leaves the keyboard alone.
export async function handleDigestTimeTap(
  cq: TelegramCallbackQuery,
  token: DigestTimeCallback
): Promise<void> {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const profileId =
    chatId != null
      ? resolveTapProfile(token, getProfilesByTelegramChatId(String(chatId)))
      : null;
  if (profileId == null) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  // A tap on YESTERDAY's digest is about a message whose content has rolled over.
  // Refuse plainly rather than writing a send time from stale context.
  if (token.date !== today(profileId)) {
    await answerCallbackQuery(cq.id, OUTDATED_MESSAGE_TEXT);
    return;
  }
  const suggestion = getDigestTimeSuggestion(profileId);
  if (!suggestion) {
    await answerCallbackQuery(cq.id, DIGEST_TIME_STALE_TEXT);
    return;
  }

  let answer: string;
  if (token.action === "use") {
    setDigestMinute(profileId, suggestion.proposedMinute);
    answer = digestTimeUseAnswer(suggestion.proposedMinute);
  } else if (token.action === "dynamic") {
    setDigestMode(profileId, "dynamic");
    answer = digestTimeDynamicAnswer(suggestion.configuredMinute);
  } else {
    dismissFinding(profileId, suggestion.dedupeKey);
    answer = DIGEST_TIME_DISMISS_ANSWER;
  }
  await answerCallbackQuery(cq.id, answer);

  if (chatId == null || messageId == null) return;
  const rows = cq.message?.reply_markup?.inline_keyboard ?? [];
  if (rows.length === 0) return;
  const consumed = [
    digestTimeUseToken(profileId, token.date),
    digestTimeDynamicToken(profileId, token.date),
    digestTimeDismissToken(profileId, token.date),
  ].reduce(removeButton, rows);
  await updateMessageKeyboard(chatId, messageId, consumed);
}
