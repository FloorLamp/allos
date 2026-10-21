# deck/ui host contract (hostApi 1)

What a host gives the web UI. Machine-readable: [host-contract.json](host-contract.json) (args schemas, caps, each
op's web and shell backend, examples); these documents are the prose. Additive changes keep `hostApi` 1; anything else bumps it, and the
UI checks it. `ui/test/compatibility.test.mjs` checks operation removals and wire changes on first-parent history
since the version migration and in the working tree; update `HOST_API` with the contract version.


- [Host](host.md)
- [Shell Bar](shell-bar.md)
- [Foundation](foundation.md)
- [Chart](chart.md)
- [Media](media.md)
- [House](house.md)
- [Accounts](accounts.md)
- [Shell](shell.md)
- [Resources](resources.md)
- [Backends](backends.md)
- [Health](health.md)
- [Money](money.md)
- [Collection search and paging](collections.md)
- [People](people.md)
- [Security](security.md)
- [Vehicles](vehicles.md)
- [Papers](papers.md)
- [Insurance](insurance.md)
- [Taxes](taxes.md)
- [Things](things.md)
- [Flightplan](flightplan.md)

## Navigation

`contract/nav/<id>.json` (`nav.mjs`; published as `nav.json`, [Shell Bar](shell-bar.md)) is every page Deck serves. Each entry, and each
of its `pages` (the pages it serves beside its own, each `via` its `header` links, its header's More `menu`, `home` or Find's rows), declares how people reach it:

- `find`: `records`, the record kinds whose own names open it in Find (a car's name its car's hub: `vehicle`), and `words`, the task
  words people use for it (`cameras`, `rules`, `due`); never a category word alone. Home (`/`) declares none.
- `from`: the record kinds whose card or page links to it (a purchase its thing: `purchase` on Things).

[test/discoverable.test.mjs](../test/discoverable.test.mjs) is the rule: a served page with no entry, a `find` Find does not
open, a `from` link not drawn, or no way in from Home or a menu fails it.

Backend route validation uses `host-contract.json`’s `backendValidation` path and destination vectors in JS, Kotlin, C# and Swift tests. `deck/tool/backends.mjs` generates their shared path pattern with the backend registries.

`deck/test/surfaces.test.mjs` derives each shell’s required dispatch table from the ops’ `shell` field and advertised capabilities. It runs in the ordinary Node suite on Linux, including Windows and Android Habitat handlers; native contract tests still verify runtime behavior.
