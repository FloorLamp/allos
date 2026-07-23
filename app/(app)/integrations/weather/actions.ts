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

// Pull the UV series on demand. runWeatherSync returns { error } for graceful failures
// (no location, provider/network error) and can throw — catch both so neither becomes
// an unhandled error page; surface the failure via ?error=.
export async function syncWeatherAction() {
  const { profile } = await requireWriteAccess();
  let failed = false;
  try {
    const res = await runWeatherSync(profile.id);
    if (res && "error" in res) {
      log.error("weather sync failed", { error: res.error });
      failed = true;
    }
  } catch (err) {
    log.error("weather sync threw", { err: String(err) });
    failed = true;
  }
  for (const p of ["/", "/timeline", "/integrations/weather", "/data"]) {
    revalidatePath(p);
  }
  if (failed) redirect("/integrations/weather?error=sync_failed");
}

export async function disconnectWeatherAction() {
  const { profile } = await requireWriteAccess();
  disconnectWeather(profile.id);
  revalidatePath("/integrations/weather");
  revalidatePath("/data");
}
