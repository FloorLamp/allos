// The menu bar's popover page (glance.html; palette SPEC.md, *Menu bar and tray*): the shell's resident panel under its menu bar item.
// The look from env.get and `theme`; the gesture gate's notes; its own height for the shell's window (window.resize); on `show` the
// first control focused (arrows move from there).
import {shellHost, pageInput} from './host/shell.js';
import {mountGlance} from './mount.js';

const host = shellHost();
pageInput(host);
const root = document.documentElement;
const look = ({theme, reduceMotion}) => { root.dataset.theme = theme; if (reduceMotion) root.dataset.motion = 'reduce'; else delete root.dataset.motion; };
look(await host.call('env.get'));
host.on('theme', look);
const el = document.getElementById('app');
mountGlance(el, host);

let last = '';
new ResizeObserver(() => {
  const panel = el.querySelector('.dg');
  if (!panel) return;
  const size = {height: Math.ceil(panel.offsetHeight), width: Math.ceil(panel.offsetWidth)};
  const k = `${size.height}x${size.width}`;
  if (k !== last) { last = k; host.call('window.resize', size).catch(() => {}); }
}).observe(el);
host.on('show', () => {
  el.querySelector('[data-nav]:not(:disabled)')?.focus();
});
