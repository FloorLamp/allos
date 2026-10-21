import {h, render} from '../../vendor/preact.mjs';
import {createNotes} from '../notes.js';
import {Notes} from '../view/notes.js';
import {drawing} from '../mount-runtime.js';

export function mountNotes(el, host) {
  const notes = createNotes(host);
  const d = drawing(el, 'Notes', () => render(h(Notes, {model: notes, host}), el));
  notes.subscribe(() => d.draw());
  const win = el.ownerDocument.defaultView;
  const reconnect = () => notes.flush().then(() => notes.refresh());
  win?.addEventListener('online', reconnect);
  const linked = decodeURIComponent(win?.location.hash.slice(1) || '');
  const ready = notes.start().then(() => linked ? notes.open(linked) : undefined).then(() => {
    // the open note in the URL (`/notes#<id>`), so a reload opens it again
    notes.subscribe(() => {
      const want = notes.selected ? `#${encodeURIComponent(notes.selected)}` : '';
      if (win && win.location.hash !== want) win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}${want}`);
    });
  });
  return {notes, ready, refresh: () => notes.refresh(), unmount() {
    win?.removeEventListener('online', reconnect); notes.stop(); d.unmount();
  }};
}
