# Properties

`mountProperties(el, host, {onOpen?})` reads bridge `GET /v1/properties`
(`bridge.properties`) and the visible paper page's `GET /v1/doc/<id>` (`bridge.doc`),
following [shared collection paging](collections.md).
Returns `{properties, refresh(), unmount()}`. Find's Properties row (`properties`, `property`,
`home(s)`) opens the page.
The web host uses `/api/properties`; macOS and Windows use `/v1/properties`.
Bridge's device route requires `bridge:find`. A shell bar given a device host shows
Properties only after that host successfully reads the collection; a bar without a
host is a backend site's session-authenticated web bar.

A property's full view starts with its place and Habitat's zones near it (`PropertyArea`, [Media](media.md) *Map*) when bridge gives
its `location`; none, no map.

Rows show bridge's address label and each held paper kind once, omitting missing kinds and dates. The shared
RowList, Drawer and StatTiles show each home's papers and recorded renewals; opening
a paper uses the shared document viewer. Bridge projects titles and kinds; visible document reads provide explicit expiry
and renewal values. No dates, ownership or required paperwork are
inferred. Missing kinds mean not indexed. A failed detail read leaves the collection paper
projection visible with dates unavailable; a failed collection read clears the previous
homes. Refresh and unmount cancel and ignore obsolete requests.

Bridge currently projects only `{kind, document}` papers, without aggregate renewals
or expiries. Papers lacking explicit document date fields say `Expiry not indexed`;
renewal messages describe only the displayed papers.
