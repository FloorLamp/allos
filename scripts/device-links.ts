// Which allos login a Deck device acts as on `/v1` (docs/device-api.md).
//
//   npm run device-links                          # list the links
//   npm run device-links -- link <device> <login> # point a device at a login
//   npm run device-links -- unlink <device>       # refuse the device again
//
// `<device>` is the device's name in boarding (spaceport); `<login>` an allos username
// or login id. Runs against the live database (ALLOS_DB_PATH or data/allos.db). The
// image bundles it like notify (Dockerfile), so on prod:
// `docker exec allos node dist/device-links.cjs link <device> <login>`. No credential
// is involved: boarding verifies those; this only says who the device is here.

import "./load-env";

import { db } from "../lib/db";
import {
  linkDevice,
  listDeviceLinks,
  unlinkDevice,
} from "../lib/device-logins";

function loginId(ref: string): number | null {
  const row = db
    .prepare(
      /^\d+$/.test(ref)
        ? "SELECT id FROM logins WHERE id = ?"
        : "SELECT id FROM logins WHERE username = ?"
    )
    .get(/^\d+$/.test(ref) ? Number(ref) : ref) as { id: number } | undefined;
  return row?.id ?? null;
}

function main(argv: string[]): number {
  const [cmd, device, login] = argv;
  if (!cmd || cmd === "list") {
    const links = listDeviceLinks();
    if (links.length === 0) console.log("No devices linked.");
    for (const l of links)
      console.log(`${l.device}\t${l.username} (#${l.loginId})\t${l.createdAt}`);
    return 0;
  }
  if (cmd === "link" && device && login) {
    const id = loginId(login);
    if (id === null) {
      console.error(`No login "${login}".`);
      return 1;
    }
    linkDevice(device, id);
    console.log(`${device} → ${login}`);
    return 0;
  }
  if (cmd === "unlink" && device) {
    console.log(
      unlinkDevice(device) ? `${device} unlinked` : `${device} was not linked`
    );
    return 0;
  }
  console.error(
    "Usage: device-links [list] | link <device> <login> | unlink <device>"
  );
  return 2;
}

process.exit(main(process.argv.slice(2)));
