# Notes

`mountNotes(el, host)` and `mountCollectionPage(el, host, {path: '/notes'})` render the shared Notes page.
Native shells open `/notes` from the bundled nav; web hosts mount the same page at `/notes`.
The list is newest updated first, with local case-insensitive title/text search. Selecting a note loads its full text.
New note opens an empty editor. Edit/View switches between plain text and the shared safe Markdown renderer
(headings, lists and links; embedded HTML never becomes active). The layout stacks at phone widths.

## Bridge HTTP contract

This is Deck's required Notes API; bridge main did not yet expose it when this UI was added (flightplan item 672, parent 668).
Web uses the session and `/api/notes`; Windows, Mac and Android use `/v1/notes` and their device credential.
The generated backend registry defines:

| Host op | HTTP | Grant | Answer/body |
| --- | --- | --- | --- |
| `bridge.notes.list` | GET `/v1/notes` | `bridge:find` | `{notes: [{id, title, text, updated_at}]}`; complete snapshot |
| `bridge.notes.get` | GET `/v1/notes/{id}` | `bridge:find` | `{note: {id, title, text, updated_at}}` |
| `bridge.notes.save` | PUT `/v1/notes/{id}` | `bridge:notes-write` | body `{text}`; full replacement, creates missing client UUID; any JSON success |

`updated_at` is ISO 8601; IDs are opaque path segments. Save is idempotent, including first creation and retry after a lost response.
Existing quick capture `bridge.notes.add` remains POST `{text}` with a gesture.
Only the fixed PUT save route and write grant bypass a fresh gesture: autosave and reconnect happen after input has ended.
Backend authorization still applies. A server rejection retains the draft and offers retry.

## Autosave and offline

Every input serializes the latest full text per ID to `prefs.set` key `notesOutbox` before sending;
500 ms without input flushes the queue. The shared preference adapter persists it in browser storage or native preferences.
Restart restores pending text; startup, the browser `online` event and Refresh / retry flush it.
Requests run serially. A save completing during newer input cannot clear the newer draft.
List and detail reads begun before an edit cannot replace it, even after autosave acknowledges it.
A failure stops that flush, keeps pending text and shows status. No polling or unbounded retry loop.
Unmount cancels the debounce; already persisted pending edits replay at the next mount.
Concurrent devices use last successful full-text write; there is no collaborative merge or import.

## Checkbox todos

After each successful bridge save, every nonempty `- [ ] title` or `- [x] title` line (also uppercase X,
with optional indentation) calls `flightplan.notes.upsert`: POST `/v1/items` with
`{key: "deck-note:<note-id>:<line>", title, kind: "todo", links: [{type: "url", ref: "deck-note:<note-id>", url: "https://deck.wang.team/notes#<encoded-note-id>"}]}`.
`line` is the one-based physical line number. Repeated saves upsert the same item; identical titles on different lines are separate todos.
Moving lines changes their keys; removing a line does not delete its item. Unticking does not reopen a completed todo.
The response is the item itself. Checked lines whose returned status is not `done` then call
`flightplan.notes.done`: POST `/v1/items/<id>/done` with `{}`. Both require `flightplan:write`.
These fixed routes, like note save, bypass fresh input for autosave and reconnect; ordinary add/done still require input.
The durable outbox clears only after all checkbox writes succeed, so retries and restart repair partial saves by key.
Opening `/notes#<encoded-note-id>` loads that note.
