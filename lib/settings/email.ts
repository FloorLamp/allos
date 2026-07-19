import { writeTx } from "../db";
import { getSetting, setSetting, deleteSetting } from "./kv";

// Global SMTP config (issue #985). Outbound mail uses the operator's OWN SMTP
// server (Fastmail, a Gmail app-password, SES-SMTP, …) so they own SPF/DKIM and
// deliverability — the app never speaks to a vendor email API. Stored app-wide in
// the `settings` kv table (a single relay serves the whole instance, exactly like
// the Telegram bot token), admin-managed on Settings → Server. Env-seeded on first
// boot (seedSmtpFromEnv, the seedTimezoneFromEnv/#875 pattern) so an upgrading
// deploy can ship its relay via env and let the DB then own it.
//
// The password is WRITE-ONLY in the UI (the AI-key / Telegram-token posture): a
// blank submit leaves the stored secret intact, and an explicit "remove" clears it.
// `hasPassword` lets the UI show whether one is stored without ever echoing it.

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  from: string;
  // Never sent to the client — the settings card exposes only `hasPassword`.
  password: string;
}

// The externally-visible view: everything except the secret, plus whether a secret
// is stored. This is what the settings page hands to the client component.
export interface SmtpConfigView {
  host: string;
  port: number;
  user: string;
  from: string;
  hasPassword: boolean;
}

const DEFAULT_PORT = 587;

function parsePort(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

export function getSmtpConfig(): SmtpConfig {
  return {
    host: (getSetting("smtp_host") ?? "").trim(),
    port: parsePort(getSetting("smtp_port")),
    user: (getSetting("smtp_user") ?? "").trim(),
    from: (getSetting("smtp_from") ?? "").trim(),
    password: getSetting("smtp_password") ?? "",
  };
}

export function getSmtpConfigView(): SmtpConfigView {
  const c = getSmtpConfig();
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    from: c.from,
    hasPassword: !!c.password,
  };
}

// SMTP counts as configured for SENDING when a host, a port, and a From address
// are present. User/password are optional (some relays authenticate by IP), so
// they don't gate configuration. Every email affordance hides/degrades when this
// is false (the ANTHROPIC_API_KEY precedent).
export function isEmailConfigured(): boolean {
  const c = getSmtpConfig();
  return !!(c.host && c.port && c.from);
}

export interface SmtpConfigInput {
  host: string;
  port: number;
  user: string;
  from: string;
  // undefined / "" = leave the stored password untouched (write-only field).
  password?: string;
  // true = clear the stored password (the "remove" checkbox).
  clearPassword?: boolean;
}

export function setSmtpConfig(cfg: SmtpConfigInput): void {
  writeTx(() => {
    setSetting("smtp_host", cfg.host.trim());
    setSetting("smtp_port", String(parsePort(String(cfg.port))));
    setSetting("smtp_user", cfg.user.trim());
    setSetting("smtp_from", cfg.from.trim());
    if (cfg.clearPassword) {
      deleteSetting("smtp_password");
    } else if (cfg.password !== undefined && cfg.password !== "") {
      setSetting("smtp_password", cfg.password);
    }
  });
}
