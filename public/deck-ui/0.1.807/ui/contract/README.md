# deck/ui host contract (hostApi 1)

What a host gives the web UI. Machine-readable: [host-contract.json](host-contract.json) (args schemas, caps, each
op's web and shell backend, examples); these documents are the prose. Additive changes keep `hostApi` 1; anything else bumps it, and the
UI checks it. `ui/test/compatibility.test.mjs` checks operation removals and wire changes on first-parent history
since the version migration and in the working tree; update `HOST_API` with the contract version.


- [Host](host.md)
- [Shell Bar](shell-bar.md)
- [Foundation](foundation.md)
- [Chart](chart.md)
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

Backend route validation uses `host-contract.json`’s `backendValidation` path and destination vectors in JS, Kotlin, C# and Swift tests. `deck/tool/backends.mjs` generates their shared path pattern with the backend registries.

`deck/test/surfaces.test.mjs` derives each shell’s required dispatch table from the ops’ `shell` field and advertised capabilities. It runs in the ordinary Node suite on Linux, including Windows and Android Habitat handlers; native contract tests still verify runtime behavior.
