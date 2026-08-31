import { scryptSync } from "node:crypto";
import { db } from "@/lib/db";
import {
  formatApiToken,
  generateApiTokenSecret,
  type ApiTokenScope,
} from "@/lib/api-token-format";

// Route suites own request parsing, token lookup, scope checks, authorization, and
// response behavior. The dedicated api-token/password suites own production scrypt
// strength. A self-described tiny work factor keeps the real verification path here
// without charging every synthesized request ~65 ms of password-hardening work.
export function routeTestToken(
  loginId: number,
  name: string,
  scope: ApiTokenScope
): { id: number; token: string } {
  const secret = generateApiTokenSecret();
  const salt = Buffer.from([0]);
  const hash = scryptSync(secret, salt, 32, { N: 2, r: 1, p: 1 });
  const secretHash = `scrypt$2$1$1$${salt.toString("hex")}$${hash.toString("hex")}`;
  const id = Number(
    db
      .prepare(
        `INSERT INTO api_tokens
           (login_id, name, scope, secret_hash, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(loginId, name, scope, secretHash).lastInsertRowid
  );
  return { id, token: formatApiToken(id, secret) };
}
