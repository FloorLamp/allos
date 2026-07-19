import fs from "node:fs";
import nodemailer from "nodemailer";
import { getSmtpConfig, isEmailConfigured } from "./settings/email";
import { createLogger } from "./log";

// Outbound-email CHOKEPOINT (issue #985), the lib/notifications/telegram.ts
// discipline applied to mail: EVERY email the app sends goes through sendEmail()
// here, the SOLE importer of `nodemailer`. Owning the wire in one place means the
// cross-cutting obligations — TLS enforcement, the "not configured ⇒ refuse"
// gate, plaintext-first bodies, and the deterministic test capture — are applied
// once and can never drift per call site. Enforced by the source-scan test
// lib/__tests__/email-chokepoint.test.ts, which fails CI if any other module
// imports nodemailer.
//
// Plaintext-first, minimal HTML, NEVER attachments (phase-1 auth mail carries no
// PHI). TLS is required: port 465 uses implicit TLS (secure), everything else uses
// STARTTLS via requireTLS, so credentials never cross the wire in the clear.

const log = createLogger("email");

export interface OutboundEmail {
  to: string;
  subject: string;
  // Plaintext body — always present (plaintext-first).
  text: string;
  // Optional minimal HTML alternative. No attachments, ever.
  html?: string;
}

// Deterministic test capture (no network): when EMAIL_TEST_CAPTURE names a file,
// every send is APPENDED to it as one JSON line via nodemailer's jsonTransport
// instead of hitting a relay. The e2e mailbox stub reads this file to pull the
// invite/reset link. Read at SEND time (not module load) so a test can set it after
// import. Kept out of the configured/TLS path entirely so specs run without any SMTP
// server.
export { isEmailConfigured };

// Send one email through the configured relay. Throws when SMTP isn't configured
// (callers gate on isEmailConfigured() first and surface friendly copy) or when
// the relay rejects the message — auth mail is request-path, so a failure must
// surface to the requesting UI immediately, not be swallowed like a notification.
export async function sendEmail(msg: OutboundEmail): Promise<void> {
  const cfg = getSmtpConfig();
  const CAPTURE_PATH = process.env.EMAIL_TEST_CAPTURE;

  if (CAPTURE_PATH) {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const info = await transport.sendMail({
      from: cfg.from || "allos@example.com",
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    // info.message is the serialized message (a JSON string here); append it as
    // one capture line the mailbox stub parses.
    fs.appendFileSync(CAPTURE_PATH, `${info.message}\n`);
    return;
  }

  if (!isEmailConfigured()) {
    throw new Error("SMTP is not configured");
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // Implicit TLS on 465; STARTTLS (requireTLS) on 587/25 so the session is
    // always encrypted before auth.
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });

  try {
    await transport.sendMail({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
  } catch (err) {
    // Log server-side (the cause never leaks to the caller — the UI shows shaped
    // copy), then re-throw so the requesting action reports the failure.
    log.error("email send failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// Verify the relay accepts the connection + credentials WITHOUT sending mail — the
// "send test" affordance on Settings → Server (the register-webhook precedent).
// Returns a friendly outcome, never throws.
export async function verifyEmailConfig(): Promise<{
  ok: boolean;
  message: string;
}> {
  const cfg = getSmtpConfig();
  if (!isEmailConfigured()) {
    return {
      ok: false,
      message: "Set the SMTP host, port, and From address first.",
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });
  try {
    await transport.verify();
    return { ok: true, message: "Connected to the mail server." };
  } catch (err) {
    log.warn("email verify failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      message:
        "Couldn't reach the mail server. Check the host, port, and credentials.",
    };
  }
}
