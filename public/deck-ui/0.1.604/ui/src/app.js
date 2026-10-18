import {loadNavigation} from './navigation.js';
import {openMap} from './view/map.js';
// The desktop entry (DESIGN.md §1, §3 P3): Deck.exe's WebView2 and Deck.app's WKWebView load app.html with the shell host, and the
// whole palette is this page: the header, the search box (IME, every SPEC key), the rows, the commands bar, the status and hint
// lines, and the viewer over them (controller.js runs the model; view/palette.js draws it). The shell keeps only its chrome: it shows
// and hides the window, nav it and sizes it as the page asks (`window.resize {height, width}`: the panel's, or the viewer's), and
// sends `show`, `hide`, `theme`, `link`, `transfer`, `files.pending` and the lists' changes. The page plays the open motion on `show`
// (fade in, rise 8 px over motion.open) and the close motion before each `window.hide` it asks (fade over motion.close); both land
// at once under reduced motion (the host's or the system's). It notes `ui.input {at, kind}` for each key or click the person makes
// in it (the shells' gesture gate, contract/README.md) and `ui.painted {sinceShowMs, what, frame}` once the rows (after a `show`) or the
// viewer are on screen. `app.html?selftest` (both shells' selftest): every op of the contract once, then the note `selftest.done`.
// Deck's own window (`window.popOut`: a normal, resizable window the OS sizes and keeps; its env.get's caps without `window`) loads the
// same page: no header (the OS's title bar), the rows filling it, the viewer beside them when it is wide (1000 px on), else over them;
// nothing here sizes, moves or hides it. It opens on the panel's view: the pop out sends what the panel shows (viewState: the
// controller's and the viewer's snapshots) as window.popOut's `state`, and the window's page gets it back as its first env.get's
// `restore` (restored before its first paint), or as the `restore` event when it was open already.
import {h, render} from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';
import {shellHost} from './host/shell.js';
import {createController, parseViewState, viewState} from './controller.js';
import {createViewer} from './viewer.js';
import {Viewer} from './view/viewer/frame.js';
import {Palette, motionMs} from './view/palette.js';
import {selftest} from './selftest.js';

const html = htm.bind(h);
const host = shellHost();
const root = document.documentElement, app = document.getElementById('app');
let env = {mod: 'Control', ...(await host.call('env.get', {}).catch(() => null))};
// Deck's own window opened on the panel's view (window.popOut's state)
const restoring = parseViewState(env.restore);
delete env.restore;
const look = () => {
  if (env.theme === 'dark' || env.theme === 'light') root.dataset.theme = env.theme; else delete root.dataset.theme;
  if (env.reduceMotion) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
};
look();

// the open and close motion on the whole app (Web Animations: no inline styles under the CSP)
const EASE = 'cubic-bezier(0.22, 0.8, 0.25, 1)';
const motion = {
  open() {
    for (const a of app.getAnimations()) a.cancel();
    const ms = motionMs('open');
    if (ms) app.animate([{opacity: 0, transform: 'translateY(8px)'}, {opacity: 1, transform: 'none'}], {duration: ms, easing: EASE});
  },
  /** Fades the panel out, then answers (the controller's `window.hide` follows); it stays out until the next `show`. */
  close() {
    const ms = motionMs('close');
    return app.animate([{opacity: 1}, {opacity: 0}], {duration: ms, easing: 'ease-in', fill: 'forwards'}).finished.then(() => {}, () => {});
  },
};

const c = createController(host, {onMap: centre => openMap(host, centre), beforeHide: () => motion.close(), flashMs: motionMs('flash', {always: true}) || 1600, copiedMs: motionMs('copied', {always: true}) || 260,
  popOutState: () => viewState(c.snapshot(), v.snapshot())});
loadNavigation().then(nav => c.navigation(nav)).catch(() => {});
const v = createViewer(host, {
  onClose: () => { c.closeViewer(); focusBox(); },
  onGroup: (key, title) => { v.reset(); c.openGroup(key, title); focusBox(); },
});
const focusBox = () => requestAnimationFrame(() => app.querySelector('.dp-input')?.focus({preventScroll: true}));
/** Deck's own window (no window cap: nothing to size or hide), and whether it is wide enough for the viewer beside the rows. */
const own = !host.caps.window, wide = globalThis.matchMedia?.('(min-width: 1000px)');
wide?.addEventListener?.('change', () => draw());
const draw = () => {
  const side = own && !!c.viewer && !!wide?.matches;
  render(html`
  <div class=${`app${own ? ' window' : ''}${c.viewer ? ' viewing' : ''}${side ? ' side' : ''}`}>
    <div class="app-rows" hidden=${!!c.viewer && !side}><${Palette} c=${c} mod=${env.mod} chrome=${env.platform !== 'android'} layout=${env.platform === 'android' ? 'page' : 'panel'} /></div>
    ${c.viewer ? html`<div class="app-viewer"><${Viewer} v=${v} env=${env} /></div>` : null}
  </div>`, app);
};

// the person's keys and clicks in the page, for the shells' gesture gate (contract/shell.md, *Gesture gate*): every trusted keydown and
// pointerdown, before any handler runs (capture), never which key
const input = kind => ev => {
  if (!ev.isTrusted) return;
  c.input();
  host.note('ui.input', {at: Math.round(performance.timeOrigin + ev.timeStamp), kind});
};
window.addEventListener('keydown', input('key'), true);
window.addEventListener('pointerdown', input('pointer'), true);

// the window's drag regions (contract/shell.md, *Moving the window*): a primary press on `[data-window-drag]` (the header), never on a
// control in it, asks the shell to move the window with the mouse (`window.drag`, answered once the button is let go)
window.addEventListener('pointerdown', ev => {
  const t = ev.target;
  if (!ev.isTrusted || ev.button !== 0 || !host.caps.window || !t.closest?.('[data-window-drag]') || t.closest('button, a, input, textarea, select')) return;
  host.call('window.drag', {}).catch(() => {});
});

let shownAt = null, shownViewer = null;
host.on('show', () => {
  shownAt = performance.now();
  motion.open();
  if (!c.viewer) focusBox();
  painted(shownAt, 'rows');
});
host.on('theme', d => { env = {...env, ...d}; look(); draw(); });
host.on('hide', () => {
  v.reset();
  // hidden: out of sight until the next show opens it (no fade from the last frame)
  for (const a of app.getAnimations()) a.cancel();
  app.animate([{opacity: 0}], {duration: 0, fill: 'forwards'});
});

/** ui.painted once the rows or the viewer are in the page: after the next frame (`frame: true`, the real time); a view that ran no
 *  frame within 100 ms (never shown, or its window late on screen) notes `frame: false` then, and the frame's note still follows
 *  when it comes. A later show or open of the same kind drops the earlier one's notes. */
const painting = {};
function painted(t0, what) {
  const seq = painting[what] = (painting[what] ?? 0) + 1;
  let framed = false, fellBack = false;
  const send = frame => {
    if (painting[what] !== seq || framed || (!frame && fellBack) || !app.querySelector(what === 'viewer' ? '.dv' : '.dp')) return;
    if (frame) framed = true; else fellBack = true;
    host.note('ui.painted', {sinceShowMs: Math.round(performance.now() - t0), what, frame});
  };
  requestAnimationFrame(() => requestAnimationFrame(() => send(true)));
  setTimeout(() => send(false), 100);
}

/** The panel's size for the shell's window (the window cap): its own height (header, box, rows up to sizes.visibleRows, commands,
 *  status, hint) at sizes.width; the viewer asks its own (fit). */
let lastSize = '';
function fitPanel() {
  if (!host.caps.window || c.viewer) return;
  const dp = app.querySelector('.dp');
  if (!dp) return;
  const size = {height: Math.ceil(dp.offsetHeight), width: Math.ceil(dp.offsetWidth)};
  const k = `${size.height}x${size.width}`;
  if (!size.height || k === lastSize) return;
  lastSize = k;
  host.call('window.resize', size).catch(() => {});
}
const panelSize = new ResizeObserver(fitPanel);

/** The viewer follows the controller: a new target opens it (its frame painted), none closes it (the panel's size again). */
function changed() {
  if (env.platform === 'android') host.note('android.back', {inside: !!c.viewer || !!c.view().query || !!c.view().scope?.length || !!c.view().confirm});
  const t = c.viewer ? c.viewerTarget ?? c.viewer : null;
  if (t && t !== shownViewer) {
    shownViewer = t;
    const t0 = shownAt ?? performance.now();
    shownAt = null;
    v.open(t);
    draw();
    painted(t0, 'viewer');
  } else if (!t && shownViewer) {
    shownViewer = null;
    if (v.entry) v.reset();
    lastSize = '';
    asked = null;
    draw();
  } else draw();
  const dp = app.querySelector('.dp');
  if (dp && dp !== observed) { if (observed) panelSize.unobserve(observed); panelSize.observe(dp); observed = dp; }
  // after the next frame (its layout), or soon in a view never shown (no frames while hidden)
  requestAnimationFrame(fitPanel);
  setTimeout(fitPanel, 50);
}
let observed = null;

/** The frame's height for the shell's window (the window cap): pages, video and loading the screen's less 72; text, a table, an
 *  archive, a thread what they need up to that. */
let asked = null;
function fit() {
  const e = v.entry;
  if (!host.caps.window || !e) return;
  requestAnimationFrame(() => {
    const full = Math.max(420, (screen.availHeight || 900) - 72), dv = app.querySelector('.dv');
    let height = full;
    if (dv && e.status === 'ready' && !['pages', 'video'].includes(e.kind)) {
      const scroll = dv.querySelector('.dv-main .dv-scroll'), rest = dv.offsetHeight - (dv.querySelector('.dv-main')?.offsetHeight ?? 0);
      if (scroll) height = Math.max(300, Math.min(full, rest + scroll.scrollHeight + (dv.querySelector('.dv-sheets, .dv-filter')?.offsetHeight ?? 0)));
    }
    const key = `${e.seq}:${e.status}:${height}`;
    if (key === asked) return;
    asked = key;
    lastSize = '';
    host.call('window.resize', {height: Math.round(height), width: 1040}).catch(() => {});
  });
}
/** The panel's view in Deck's own window (window.popOut's state): the palette as it was, the viewer on its document where it was. */
function restoreView(s) {
  v.reset();
  c.restore(s.palette, {quiet: true});
  const t = c.viewer ? c.viewerTarget ?? c.viewer : null;
  shownViewer = t;
  if (t) v.restore(s.viewer?.chain?.length ? s.viewer : {chain: [t]});
  changed();
  if (t) painted(performance.now(), 'viewer');
  else focusBox();
}
host.on('restore', d => { const s = parseViewState(d?.state); if (s) restoreView(s); });

v.subscribe(fit);
c.subscribe(changed);
v.start();
if (restoring) restoreView(restoring);
draw();
c.start().then(() => { changed(); if (env.platform === 'android') host.note('android.ready', {}); });
if (new URLSearchParams(location.search).has('selftest')) selftest(host).then(r => host.note('selftest.done', r));
