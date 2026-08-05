"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { IntegrationId } from "@/lib/types";
import { getPullIntegration } from "@/lib/integrations/registry";
import { getPullRunner } from "@/lib/integrations/pull-runners";
import { createLogger } from "@/lib/log";

const log = createLogger("sync-now");

export interface SyncNowResult {
  status: "done" | "error";
  message: string;
}

// THE "Sync now" action (#208, unified in #1772, made generic in #2040). There used
// to be four of these — one per provider — with an identical skeleton: authorize,
// run, map "not connected" to a sentence, fan out revalidatePath over a hand-written
// list, then assemble a parts[] message. Only the last of those was ever
// provider-specific, and it now lives beside the provider's runner
// (lib/integrations/pull-runners.ts); the routes a run feeds are declared in the
// registry's pull facet.
//
// Runs the SAME idempotent pull the hourly tick runs — a manual tap just advances the
// same rolling window — and returns a result the button surfaces inline instead of
// navigating with ?error=.
export async function syncNow(id: IntegrationId): Promise<SyncNowResult> {
  const { profile } = await requireWriteAccess();
  const def = getPullIntegration(id);
  const runner = def && getPullRunner(id);
  if (!def || !runner) {
    return { status: "error", message: "That source can't be synced by hand." };
  }
  const blocked = runner.blockedReason?.(profile.id);
  if (blocked) return { status: "error", message: blocked };

  try {
    const res = await runner.run(profile.id);
    if ("error" in res && typeof res.error === "string") {
      const message =
        res.error === "not connected"
          ? `Connect ${def.name} first, then sync.`
          : `Sync failed: ${res.error}`;
      log.error("sync-now failed", { provider: id, error: res.error });
      return { status: "error", message };
    }
    for (const p of def.pull.revalidates) revalidatePath(p);
    return { status: "done", message: runner.describe(res) };
  } catch (err) {
    log.error("sync-now threw", { provider: id, err: String(err) });
    return { status: "error", message: "Couldn't sync. Try again." };
  }
}
