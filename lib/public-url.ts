// Validation/normalization for the shared public app URL setting. Pure (no
// DB/network) so it's unit-testable; consumed by the settings Server Action.

export type PublicUrlResult =
  { ok: true; url: string } | { ok: false; error: string };

// Accepts an empty string (the app isn't public), otherwise requires a plain
// http(s) base URL. A missing scheme is auto-upgraded to https:// — third
// parties this URL is handed to (Telegram webhooks in particular) require it.
// Normalizes away trailing slashes so callers can append paths directly.
export function normalizePublicUrl(raw: string): PublicUrlResult {
  const input = raw.trim();
  if (!input) return { ok: true, url: "" };
  if (/\s/.test(input))
    return { ok: false, error: "URL can’t contain spaces." };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "Not a valid URL." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, error: "URL must start with https:// (or http://)." };
  if (u.username || u.password)
    return { ok: false, error: "URL can’t contain credentials." };
  if (u.search || u.hash)
    return {
      ok: false,
      error: "Use a plain base URL, without a query string or #fragment.",
    };

  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}
