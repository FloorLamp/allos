// Outbound notification entrypoint. Business logic lives in
// lib/notifications/tick; this file owns CLI parsing, process exit, and fan-out.

import "./load-env";

import {
  pollTelegramUpdates,
  runManualNotification,
  runNotifyTick,
  tickProfile,
  type NotifyTickProfile,
  type NotifyTickFanOut,
} from "../lib/notifications/tick";
import { now } from "../lib/clock";
import { db } from "../lib/db";
import { createLogger } from "../lib/log";
import { runInTickScope } from "../lib/tick-cache";

const log = createLogger("notify");

// The CLI is the system boundary authorized to fan out over every profile.
function allProfiles(): NotifyTickProfile[] {
  return db
    .prepare("SELECT id, name FROM profiles ORDER BY id")
    .all() as NotifyTickProfile[];
}

const fanOut: NotifyTickFanOut = async (profiles, tickMinutes, nowMs) => {
  let anyFailed = false;
  for (const profile of profiles) {
    try {
      const failed = await runInTickScope(
        () => tickProfile(profile.id, profile.name, tickMinutes, nowMs),
        { profileId: profile.id }
      );
      if (failed) anyFailed = true;
      log.info("profile evaluated", { profile: profile.id, failed });
    } catch (error) {
      log.error("profile tick failed", {
        profile: profile.id,
        err: error instanceof Error ? error : String(error),
      });
      anyFailed = true;
    }
  }
  return anyFailed;
};

function parseArgs(argv: string[]): { slot?: string; profileId: number } {
  let profileId = 1;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0) profileId = value;
    } else if (arg.startsWith("--profile=")) {
      const value = Number(arg.slice("--profile=".length));
      if (Number.isInteger(value) && value > 0) profileId = value;
    } else {
      positional.push(arg);
    }
  }
  return { slot: positional[0]?.toLowerCase(), profileId };
}

async function main(): Promise<number> {
  const { slot, profileId } = parseArgs(process.argv.slice(2));
  if (slot === "poll") await pollTelegramUpdates();
  if (slot) return runManualNotification(profileId, slot);
  return runNotifyTick(allProfiles(), now().getTime(), fanOut);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log.error("notify failed", {
      err: error instanceof Error ? error : String(error),
    });
    process.exit(1);
  }
);
