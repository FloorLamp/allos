import { createHash } from "node:crypto";
import { authenticateDevice, refuse } from "@/lib/device-logins";
import {
  accountPerson,
  accountsForProfile,
  ownerProfileIds,
} from "@/lib/accounts";
import { getPublicUrl } from "@/lib/settings";
import { resolveExternalBaseUrl } from "@/lib/external-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const origin = resolveExternalBaseUrl(getPublicUrl(), (name) =>
    req.headers.get(name)
  );
  const owners = ownerProfileIds();
  const accounts = auth.profiles.flatMap((p) =>
    accountsForProfile(p.id, accountPerson(p, owners), origin)
  );
  // A stable snapshot time makes unchanged bodies revalidatable without a response cache.
  const generated =
    accounts
      .flatMap((a) => [a.lastRun?.at, a.lastSuccess?.at])
      .filter((at): at is string => !!at)
      .sort()
      .at(-1) ?? "1970-01-01T00:00:00.000Z";
  const body = JSON.stringify({ accounts, generated });
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (
    (req.headers.get("if-none-match") ?? "")
      .split(",")
      .some((v) => [etag, `W/${etag}`, "*"].includes(v.trim()))
  )
    return new Response(null, { status: 304, headers });
  return new Response(body, {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
