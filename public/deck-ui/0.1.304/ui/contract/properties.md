# Properties

`mountProperties(el, host, {onOpen?})` reads bridge `GET /v1/properties`
(`bridge.properties`) and each paper's `GET /v1/doc/<id>` (`bridge.doc`).
Returns `{properties, refresh(), unmount()}`. `properties`, `property` and `home(s)`
open the same collection in the palette; the bundled shell destination is `/?q=properties`.
The web host uses `/api/properties`; macOS and Windows use `/v1/properties`.
Bridge's device route requires `bridge:find`. A shell bar given a device host shows
Properties only after that host successfully reads the collection; a bar without a
host is a backend site's session-authenticated web bar.

Rows show bridge's address label and each held paper kind once, omitting missing kinds and dates. The shared
RowList, Drawer and StatTiles show each home's papers and recorded renewals; opening
a paper uses the shared document viewer. Explicit expiry/expiration, policy/term end
and renewal fields/facts come from the document contract, with owner edits preferred.
No dates, ownership or required paperwork are inferred. Missing kinds mean not
indexed. A failed document read leaves the paper visible with dates unavailable;
a failed collection read clears the previous homes. Refresh and unmount cancel and
ignore obsolete requests.

Bridge currently projects only `{kind, document}` papers, without aggregate renewals
or expiries. Papers lacking explicit document date fields say `Expiry not indexed`;
homes without renewal fields say `No indexed renewals`.
