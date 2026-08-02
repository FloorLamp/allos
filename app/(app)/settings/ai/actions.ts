"use server";
// Admin/global AI settings actions — Settings → Server → AI (issue #1870). Split
// out of ../server/actions.ts when the two AI cards moved to their own sub-page
// (the account→tokens precedent), keeping the #319 rule intact: actions live with
// the surface that posts them, and every action here gates on requireAdmin().
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { setAiPrefs } from "@/lib/settings";
import { setTierConfig, clearTierApiKey } from "@/lib/settings/ai-tiers";
import { parseApiShape, type TierName } from "@/lib/ai-tiers";
import { probeTier } from "@/lib/ai-probe";

// ---- AI provider tiers (global, admin-only) — issue #875 ----

function parseTier(v: FormDataEntryValue | null): TierName {
  return v === "light" ? "light" : "heavy";
}

// Save one tier's provider config. The API key field is write-only: a blank submit
// leaves the stored secret intact (setTierConfig ignores an empty key), and the
// "remove key" checkbox clears it — the Telegram-bot-token posture applied to AI.
export async function saveAiTierConfig(formData: FormData) {
  await requireAdmin();
  const tier = parseTier(formData.get("tier"));
  const apiKey = String(formData.get("api_key") ?? "");
  setTierConfig(tier, {
    apiShape: parseApiShape(String(formData.get("api_shape") ?? "")),
    baseUrl: String(formData.get("base_url") ?? ""),
    model: String(formData.get("model") ?? ""),
    apiKey,
  });
  if (formData.get("clear_api_key") === "1") clearTierApiKey(tier);
  revalidatePath("/settings/ai");
}

// Test-connection affordance (the register-webhook precedent): ping the tier through
// the resolver and report reachability + whether the Heavy endpoint accepts an image.
export async function testAiTier(
  formData: FormData
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const tier = parseTier(formData.get("tier"));
  const result = await probeTier(tier);
  return { ok: result.ok, message: result.message };
}

// ---- AI automation (global, admin-only) ----

export async function saveAiSettings(formData: FormData) {
  await requireAdmin();
  // Accept both the "1" our client sends and a native checkbox's "on".
  const on = (key: string) => {
    const v = formData.get(key);
    return v === "1" || v === "on";
  };
  // The clamp is applied inside setAiPrefs (pure clampMaxRunsPerDay), so a blank/
  // bad value falls back to the default 1 rather than disabling the backstop.
  setAiPrefs({
    autoSupplementSuggestions: on("auto_supplement_suggestions"),
    recommendationMaxRunsPerDay: Number(
      formData.get("recommendation_max_runs_per_day")
    ),
  });
  revalidatePath("/settings/ai");
}
