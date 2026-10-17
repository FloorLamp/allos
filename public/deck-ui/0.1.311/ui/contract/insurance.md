# Insurance

`mountInsurance(el, host, {onOpen?})` reads bridge `GET /v1/insurance`
(`bridge.insurance`); returns `{insurance, refresh(), unmount()}`. Palette queries
`insurance`, `policy` and `policies` open the collection. The bundled shell destination
is `https://deck.wang.team/?q=insurance`, also usable in Android's browser.
The web host uses `/api/insurance`; macOS and Windows use `/v1/insurance`.
Bridge requires a device credential with `bridge:find`. The shared shell bar shows
Insurance only after its device host successfully reads this route; a denied
read leaves it hidden. A hostless bar uses the backend site’s authenticated session,
as with Properties.

Bridge's Insurance projection supplies kind, insurer, insured `{id,name}`, home
(address string), vehicles (`{id,name}`), term dates, renewal and documents. Rows
show kind, insured person/vehicle/property and `renews <date>` (term end when renewal
is absent), omitting missing values. Insurer and term status remain in the drawer.
Status is a UTC calendar comparison of explicit term dates, labelled
Upcoming, In term, Term ended or Status unknown; it does not assert coverage.
Unknown dates and suppressed health-policy fields stay unknown.

The shared RowList, Drawer and StatTiles show policy details and documents.
Documents open the existing viewer. Linked people, property addresses and vehicles
open Deck Find with the exact supplied name/address, since those references do not
include document view IDs. No identities or additional relationships are inferred.
A failed collection read clears stale policies; refresh/unmount abort obsolete reads.

Publication follows the Deck UI release pipeline (ui/README.md). Bridge must pin
the published bundle for its website to consume it; desktop releases embed it.
Prod data and native-shell validation require the released bundle. The read-only
agent probe exposes Bridge deployment status, not authenticated Insurance data.
