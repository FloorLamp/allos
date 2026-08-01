"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getHomeLocation } from "@/lib/settings";
import {
  enableWeather,
  disconnectWeather,
} from "@/lib/integrations/connections";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import { createLogger } from "@/lib/log";

const log = createLogger("weather");

// Enable the keyless Open-Meteo weather/UV integration for the active profile. No
// token/OAuth — the only prerequisite is a home location (Settings → Profile), so we
// refuse without one. On enable we also kick an initial sync so the cache fills.
export async function enableWeatherAction() {
  const { profile } = await requireWriteAccess();
  if (!getHomeLocation(profile.id)) {
    redirect("/integrations/weather?error=no_location");
  }
  enableWeather(profile.id);
  try {
    await runWeatherSync(profile.id);
  } catch (err) {
    // A first-sync failure is non-fatal — the hourly tick retries; just log it.
    log.error("weather initial sync threw", { err: String(err) });
  }
  for (const p of ["/", "/timeline", "/integrations/weather", "/data"]) {
    revalidatePath(p);
  }
}

export interface SyncNowResult {
  status: "done" | "error";
  message: string;
}

// "Sync now" for the shared <SyncNowButton> (#1772). The setup page and Review used
// to offer DIFFERENT sync affordances — a redirecting form action here, an inline
// toasting button there — for the same idempotent run. There is one now, and it
// returns a result the button surfaces inline instead of navigating with ?error=.
export async function syncWeatherNow(): Promise<SyncNowResult> {
  const { profile } = await requireWriteAccess();
  if (!getHomeLocation(profile.id)) {
    return {
      status: "error",
      message: "Set your home location first (Settings → Profile).",
    };
  }
  try {
    const res = await runWeatherSync(profile.id);
    if (res && "error" in res) {
      log.error("weather sync-now failed", { error: res.error });
      return { status: "error", message: `Sync failed: ${res.error}` };
    }
    for (const p of ["/", "/timeline", "/integrations/weather", "/data"]) {
      revalidatePath(p);
    }
    const suffix = res.partial ? " (air quality unavailable this run)" : "";
    return {
      status: "done",
      message: `Refreshed ${res.hours} ${res.hours === 1 ? "hour" : "hours"} and ${res.days} ${res.days === 1 ? "day" : "days"} of forecast.${suffix}`,
    };
  } catch (err) {
    log.error("weather sync-now threw", { err: String(err) });
    return { status: "error", message: "Couldn't sync. Try again." };
  }
}

export async function disconnectWeatherAction() {
  const { profile } = await requireWriteAccess();
  disconnectWeather(profile.id);
  revalidatePath("/integrations/weather");
  revalidatePath("/data");
}
