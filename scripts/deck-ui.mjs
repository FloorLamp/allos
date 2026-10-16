// Vendors a published version of Deck's web UI (spaceport deck/ui) from Hangar channel deck-ui: the channel's index names
// `manifest-<version>.json` and every file by its sha256; each download is checked against both (the index's sha256 and the
// manifest's), then written to public/deck-ui/<version>/ (the other versions removed) and pinned in lib/deck-ui-pin.json.
// Never fetched at runtime: a bump is a PR.
//   node scripts/deck-ui.mjs <version> [--allow-host-api-mismatch]
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANNEL = process.env.DECK_UI_CHANNEL;
export const HOST_API = 1; // the deck/ui host API this app serves (/api)
const sha = (b) => createHash("sha256").update(b).digest("hex");
const SAFE = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** root: the checkout; fetch: for tests. Answers the pin. */
export async function vendor(
  version,
  {
    root = fileURLToPath(new URL("..", import.meta.url)),
    channel = CHANNEL,
    fetch = globalThis.fetch,
    allowHostApiMismatch = false,
  } = {}
) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error(`deck-ui: a published version (0.1.n), not ${version}`);
  if (!channel) throw new Error("deck-ui: DECK_UI_CHANNEL is required");
  const get = async (url) => {
    const res = await fetch(new URL(url, channel));
    if (!res.ok) throw new Error(`deck-ui: ${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const index = JSON.parse(await get(channel));
  const file = async (name, want) => {
    const f = index.files?.[name];
    if (!f) throw new Error(`deck-ui: the channel has no ${name}`);
    if (want && f.sha256 !== want)
      throw new Error(
        `deck-ui: ${name}: the channel says ${f.sha256}, the manifest ${want}`
      );
    const b = await get(f.url ?? name);
    if (sha(b) !== f.sha256)
      throw new Error(`deck-ui: ${name}: the download is not its sha256`);
    return b;
  };
  const manifestBytes = await file(`manifest-${version}.json`);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== version)
    throw new Error(
      `deck-ui: the manifest is ${manifest.version}, not ${version}`
    );
  if (manifest.hostApi !== HOST_API && !allowHostApiMismatch)
    throw new Error(
      `deck-ui: ${version} needs host API ${manifest.hostApi}; this app serves ${HOST_API}`
    );
  const base = join(root, "public/deck-ui");
  const tmp = join(base, `.${version}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [path, want] of Object.entries(manifest.files)) {
      if (!SAFE.test(path) || !/^[0-9a-f]{64}$/.test(want))
        throw new Error(`deck-ui: the manifest names ${path}`);
      const bytes = await file(want, want);
      mkdirSync(dirname(join(tmp, path)), { recursive: true });
      writeFileSync(join(tmp, path), bytes);
    }
    writeFileSync(join(tmp, "manifest.json"), manifestBytes);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  mkdirSync(base, { recursive: true });
  for (const old of readdirSync(base))
    if (old !== `.${version}.tmp`)
      rmSync(join(base, old), { recursive: true, force: true });
  renameSync(tmp, join(base, version));
  const pin = {
    version,
    revision: manifest.revision,
    hostApi: manifest.hostApi,
    manifest: sha(manifestBytes),
  };
  writeFileSync(
    join(root, "lib/deck-ui-pin.json"),
    `${JSON.stringify(pin, null, 2)}\n`
  );
  return pin;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  vendor(process.argv[2], {
    allowHostApiMismatch: process.argv
      .slice(3)
      .includes("--allow-host-api-mismatch"),
  }).then(
    (pin) =>
      console.log(
        `deck-ui ${pin.version} (${pin.revision.slice(0, 7)}) vendored: public/deck-ui/${pin.version}/`
      ),
    (e) => {
      console.error(e.message);
      process.exit(1);
    }
  );
}
