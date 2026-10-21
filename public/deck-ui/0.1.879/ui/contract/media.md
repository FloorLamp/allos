# Media

Charts, runs and maps every hub shows (FP-1775): a thing's sensors over time, its uses, a trip's route, a property's place. Each is
one shared component in every theme and width, with a text summary and a table under it for screen readers and for when it cannot
draw. A hub passes data it already has, or the `Entity…` wrapper reads Habitat for it.

## Time series

`view/chart.js` `TimeSeries({series, range, onRange, ranges, now, timeZone, label, loading, error, onRetry})`: one or more measures over
continuous time (a charge %, fuel %, range, a temperature), beside the period chart (*Chart*) in the same module and look.

```js
series = [{id, name, unit,                 // unit: '%', 'km', 'mi', '°F', 'W', 'kWh', … (quantity.js formats it); '' for a bare number
  points: [{time, value, min?, max?}],     // time: ISO or ms, oldest first; value null: a gap (unavailable, nothing recorded)
  step?}]                                  // seconds a point stands for (Habitat's bucket): points further apart than 2.5 steps are a gap too
range = '24h' | '7d' | '30d' | '1y'         // the window drawn, ending `now`; `onRange(range)` when the person picks another (the chips)
ranges = ['24h', '7d', '30d', '1y']         // the chips shown; [] for none
```

- One panel per unit, stacked on one time axis (never two scales on a panel); a panel's series a colour and dash each. `%` spans 0–100;
  a temperature (°F, °C, K) spans its readings; anything else includes zero.
- Lines break at gaps, a lone point between gaps is a dot; `min`/`max` (a bucket's range) a faint band around the line.
- Hover (mouse) or a tap, or ←/→ on the focused plot, puts a readout under the plot: the time (in `timeZone`, Deck's clock style) and each
  series' value with its unit; it stays on the last point read.
- The summary line names each series' latest value and its low–high over the range (`Charge 64% now · 41–88% over the last 7 days`); a hidden
  table holds every point.
- `loading`: a skeleton of the plot's height; `error`: the shared failure with `onRetry`; no points: "No readings in the last 7 days".

`view/chart.js` `EntitySeries({host, entities: [{id, name?, unit?}], range?, ranges?, timeZone, label})` reads each entity's
`habitat.series` (Habitat `GET /v1/entities/<id>/history?since=&until=&points=`, habitat docs/contract/entity-history.md: numeric
buckets of min/max/mean, at most `points`) for the chosen range and draws them; a range read once is kept for the page's life. An entity
Habitat answers as states (not numeric) is left out.

## Runs

`view/runs.js` `Runs({sessions, now, timeZone, days, label, noun})`: when something was in use (a washer, the dryer, the dishwasher, a
car charging, the red light).

```js
sessions = [{start, end, minutes?}]        // ISO; end null while it runs (counted to now); any order
days = 30                                  // the window, ending today in `timeZone`
noun = ['run', 'runs']                     // what one is called: ['charge', 'charges'], ['session', 'sessions']
```

- A day-by-hour heat strip (a column a day, oldest left; a row an hour, midnight at the top), each cell as dark as the minutes in use in
  that hour; under it a bar a week (Monday weeks) of how many started. Both in the house's zone.
- The summary: how many started in the window, the longest, the average, the last (`12 runs in 30 days · longest 1h 12m (Oct 3) ·
  average 38m · last Oct 19, 7:05 PM, 24m`); a running one says so (`running since 11:35 AM, 25m so far`). A tap on a day lists its
  runs. A hidden table lists every run.
- None in the window: "No runs in the last 30 days" and no strip.

`view/runs.js` `EntityRuns({host, entity, days, timeZone, noun, label})` reads `habitat.sessions` (Habitat `GET
/v1/entities/<id>/sessions`, habitat docs/contract/sessions.md) from the window's start, following `next` until it is covered.

## Map

`view/map-view.js` `MapView({mode, label, route, points, area, kiosk, timeZone})`: Leaflet (view/leaflet.js: pinned 1.9.4 from cdnjs,
its sha384 checked) on OpenStreetMap's tiles. Nothing but tile requests leaves the page: no geocoding, no search, no positions sent
anywhere; places come with their coordinates.

```js
mode = 'route'   route = {points: [{lat, lon, time}]}               // a trip: the line, start and end pins, a time slider
mode = 'points'  points = [{id, lat, lon, label, glyph?, kind?, time?, onOpen?}]   // deliveries, photos with places: a pin each
mode = 'area'    area = {center: {lat, lon, label}, zones: [Zone], within_m?: 5000}   // a property: its pin and Habitat's zones near it
Zone = {id, name, latitude, longitude, radius_m}                      // Habitat's (habitat docs/contract/zones.md)
```

- Route: a slider (and ←/→ on it) moves a marker along the points in time order and reads its time; the map fits the line.
- Points: a pin per point, its label on hover and in the list; a point with `onOpen` opens from the list.
- Area: the zones within `within_m` of the centre (nearest first) as circles, each labelled with its name; the centre's pin.
- `kiosk` (the wall): no controls or gestures, no list. Otherwise zoom buttons drawn by the page, drag and pinch.
- The summary under the map says what it shows (`Route: 412 points, Oct 3, 9:12 AM–4:40 PM, 38 km`; `12 Example Lane: 3 zones within
  5 km: Home (here), Example Market (780 m), …`); a list (zones, points) or a hidden table (a route's) of the same places follows. When Leaflet cannot load (a desktop's self-only policy, offline) the map's place says
  "Map unavailable" and the summary and list stay.
- A page that draws a map serves under `mapPolicy` (view/leaflet.js): Find (`/`, a trip's view), `/doc/<id>`, Properties, Things,
  Vehicles and the wall.

`view/map-view.js` `TripRoute({host, trip, member, timeZone})` reads the trip's days from bridge's location history
(`bridge.locationHistory`: `GET /api/location-history?member=&from=&through=`, bridge CONTRACT.md *Location history*), paging
to at most 20,000 points and drawing at most 2,000 (evenly kept, start and end always); none: no map.
`PropertyArea({host, home})` reads `habitat.zones` and draws `home.location` (bridge's property `location: {latitude, longitude}`,
from its papers' explicit coordinates) with them; no location: no map.

## Where

- Things (a thing's hub): `EntitySeries` for its linked numeric sensors, `EntityRuns` for its usage.
- Properties (a property's full view): `PropertyArea`.
- Find (a trip's full view): `TripRoute`.
- The wall: the delivery map (house.md *Delivery map*) on MapView's map.
