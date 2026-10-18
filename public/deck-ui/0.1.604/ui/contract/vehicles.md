# Vehicles

## Vehicles

`mountVehicles(el, host, {mapping?, onOpen?})` composes bridge's `GET /v1/vehicles`
(`bridge.vehicles`, device `bridge:find`) with Habitat `entities`/`states` registry reads.
Returns `{vehicles, refresh(), unmount()}`. Vehicle records publish as soon as the collection read finishes; Habitat telemetry loads independently; photo Find starts only for visible expanded cards.
Search and nested groups follow [shared collection paging](collections.md). Pending photos are labelled as loading, and optional failures leave papers usable. Papers and photos open in the shared viewer.
Every vehicle card starts collapsed, including the first. Its Expand/Collapse button
reveals or hides photos, live state and papers; the name and vehicle details stay visible.
The bundled Vehicles page opens `/?q=vehicles`; palette queries `vehicles`, `vehicle` and
`ev9` show the same cards alongside Find. The UI is shared by desktop and Android web hosts.

`mapping` is `{[bridgeVehicleId]: {charge?, fuel?, range?, location?, locked?, doors?, climate?, charging?}}`,
values exact HA entity ids. Desktop Deck config uses top-level `vehicleMapping`, passed in
`env.get`; a web palette passes `mountPalette`'s `vehicleMapping` option. No entity-name guessing.
Without a binding, only entities carrying matching VIN (or make/model when the paper has
no VIN) and an explicit `attributes.field` join; ambiguous candidates stay unknown.
Range requires `mi` or `km` (converted to miles). Missing telemetry never becomes zero/off;
location accepts HA latitude/longitude even when its state is unknown. Refresh rereads cached
telemetry; no vehicle commands or force refresh. The displayed timestamp is the oldest contributing
entity update, not evidence of a fresh cloud poll.

Photos use bridge Find on make/model: only indexed Immich document rows matching both,
with a source URL. Hero/strip thumbnails load through `host.resource(document.thumb)`; no
external image URLs or stored copies. A tap uses the ordinary large document preview, with
its source link to Immich. Paper photos share the document's calendar date, labelled as such;
this is an association, not a claim of damage or service. Search is limited to 50 results;
unindexed photos cannot appear. No album, smart-search or purchase-location matching API.

Assumptions from the coordinator (2026-10-15): bridge#199 supplies vehicle payloads;
habitat#57 supplies observed HA states, exact deployment bindings remain config; household
spending may be omitted rather than attributed to a car. Purser's published `/v1/accounts`
contract explicitly excludes balances, despite the proposed loan source: no loan or spending
tile until a documented balance source / spending configuration is available. No fake values
in production. Later: loan balances, per-car spending attribution, direct Immich albums and
smart search. Papers/photos turn on with bridge's indexed data; live state with the Habitat
registry, device grant and exact field bindings. Backend failure leaves papers available.
