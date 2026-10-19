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
  const ready = notes.start().then(() => {
    const id = decodeURIComponent(win?.location.hash.slice(1) || '');
    if (id) return notes.open(id);
  });
  return {notes, ready, refresh: () => notes.refresh(), unmount() {
    win?.removeEventListener('online', reconnect); notes.stop(); d.unmount();
  }};
}
