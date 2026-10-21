# Insurance

`mountInsurance(el, host, {onOpen?})` reads bridge `GET /v1/insurance`
(`bridge.insurance`); returns `{insurance, refresh(), unmount()}`. Find's Insurance row
(`insurance`, `policy`, `policies`) opens the page, also usable in Android's browser.
The web host uses `/api/insurance`; macOS and Windows use `/v1/insurance`.
Bridge requires a device credential with `bridge:find`. The shared shell bar shows
Insurance only after its device host successfully reads this route; a denied
read leaves it hidden. A hostless bar uses the backend site’s authenticated session,
as with Properties.

Bridge's Insurance projection supplies kind, insurer, insured `{id,name}`, home
(address string), vehicles (`{id,name}`), term dates, renewal and documents. Rows
retain bridge's subtitle and expired state, formatting dates as `Apr 24, 2019` in UTC.
Policies are grouped Active, Upcoming, Status unknown, then Expired, preserving bridge order within each group.
Insurer and term status remain in the policy's card and full view. Bridge's state supplies the status;
when absent, explicit term dates provide a UTC calendar comparison. Status does not assert coverage.
Unknown dates and suppressed health-policy fields stay unknown.

The shared RowList, Drawer and StatTiles show policy details and documents.
Documents open the existing viewer. The insured person and covered vehicles link to their records
(collections.md *Cross-links*); the home is an address string with no property id, so it is named, not linked.
No identities or additional relationships are inferred.
A failed collection read clears stale policies; refresh/unmount abort obsolete reads.

Publication follows the Deck UI release pipeline (ui/README.md). Bridge must pin
the published bundle for its website to consume it; desktop releases embed it.
Prod data and native-shell validation require the released bundle. The read-only
agent probe exposes Bridge deployment status, not authenticated Insurance data.
