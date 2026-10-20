import {loadNavigation} from '../navigation.js';
import {openMap} from '../view/map.js';
import {h, render} from '../../vendor/preact.mjs';
import {createController} from '../controller.js';
import {createViewer} from '../viewer.js';
import {Palette} from '../view/palette.js';
import {docPage, recordPage} from '../mount-runtime.js';
import {later} from '../view/deferred.js';
import {drawing} from '../mount-runtime.js';

/** The palette in a page (the site's `/`): the box, the rows, the hint line, full width (`layout` page). opts: `query` to start with,
 *  `ask` (true: ask it), `group` {key, title} to open (a Related chip from a document's page), `browse` {source, type, year, sort},
 *  `nav` (the same bundled list passed to the shell; omitted: load the bundled contract for collection search),
 *  `landing` (an element of the page shown only on the empty query, with no group or answer: what expires, recent asks),
 *  `commands` (default: none on the web), `onView(target)` (default on the web: a collection record on its collection's page, Health here,
 *  documents on their page), `onDocument(target)` (the web: a document, {id, query}; default its page), `onChange(controller)` (the
 *  page's URL), `onPaint({what, ms})`. Answers {controller, find(text), ask(text), browse(filters), group(key, title), unmount()}. */
export function mountPalette(el, host, opts = {}) {
  // The viewer's frame and its kinds load only when a collection or Health record opens here.
  let localViewer = null, offViewer = null, Viewer = null;
  const clearViewer = () => {
    offViewer?.(); offViewer = null;
    localViewer?.reset(); localViewer = null;
  };
  const showPalette = () => { clearViewer(); d.draw(); };
  const open = target => {
    if (opts.onView) return opts.onView(target);
    // the site: a collection record opens on its collection's page, as the page's own list opens it
    const page = host.kind === 'web' ? recordPage(target, c.env.nav) : null;
    if (page) return location.assign(page);
    if (target.health || target.collection) {
      clearViewer();
      const v = localViewer = createViewer(host, {onClose: showPalette});
      offViewer = v.subscribe(() => d.draw());
      if (!Viewer) later().then(m => { Viewer = m.Viewer; if (localViewer === v) d.draw(); });
      return v.open(target);
    } else if (host.kind === 'web') (opts.onDocument ?? docPage)(target);
  };
  const c = createController(host, {nav: opts.nav, needsSource: opts.needsSource, onMap: centre => openMap(host, centre), commands: opts.commands ?? host.kind !== 'web', onView: host.kind === 'web' || opts.onView ? open : null});
  const layout = opts.layout ?? 'page';
  const d = drawing(el, 'Palette', () => render(localViewer && Viewer ? h(Viewer, {v: localViewer, env: c.platform ?? {mod: 'Control'}}) : h(Palette, {c, mod: c.platform?.mod ?? 'Control', layout, nav: opts.nav, box: true, hint: opts.hint ?? true, onPaint: opts.onPaint}), el));
  const idle = () => !c.state.query && !c.state.scopes.length && !c.state.answer && !c.asking;
  const landing = opts.landing ?? null;
  const changed = () => {
    // the page's landing follows the palette: the page's end padding goes below it, not between them
    if (landing) { landing.hidden = !idle(); el.classList.toggle('dp-landed', idle()); }
    opts.onChange?.(c);
  };
  c.subscribe(changed);
  changed();
  // A deep-link query can search while the idle page's background loads are still pending.
  const starting = c.start();
  if (!opts.group?.key && !Object.values(opts.browse ?? {}).some(Boolean) && opts.query) {
    c.edit(opts.query);
    if (opts.ask) c.key('Shift+Enter');
  }
  let mounted = true;
  const navigation = opts.nav ? Promise.resolve() : loadNavigation().then(nav => { if (mounted) c.navigation(nav); }).catch(() => {});
  const ready = Promise.all([starting, d.styled, navigation]).then(() => {
    d.draw();
    if (opts.group?.key) c.openGroup(opts.group.key, opts.group.title);
    else if (opts.browse && Object.values(opts.browse).some(Boolean)) c.browse(opts.browse);
  });
  const focus = r => { el.querySelector('.dp-input')?.focus({preventScroll: true}); return r; };
  return {
    controller: c, ready,
    find(text) { c.reset(); c.edit(String(text)); showPalette(); focus(); },
    ask(text) { c.reset(); c.edit(String(text)); c.key('Shift+Enter'); showPalette(); focus(); },
    browse(filters) { const result = c.browse(filters); showPalette(); return focus(result); },
    group(key, title) { clearViewer(); const result = c.openGroup(key, title); d.draw(); return focus(result); },
    unmount() { mounted = false; clearViewer(); c.stopNeeds(); d.unmount(); },
  };
}
