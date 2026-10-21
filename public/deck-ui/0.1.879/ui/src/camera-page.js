// A shell's camera window (camera.html; contract/house.md *Live camera*, *Pop out*): one camera popped out of the House page or the
// palette (camera.popOut) into its own small always-on-top window, the same LiveCamera as everywhere, `windowed`: its strip on top
// (the name, the stream's state, Mute, close) is the window's drag region (window.drag), its close button closes the window
// (window.hide), and once the stream's shape is known the window keeps it (window.resize with `ratio` and `strip`: the frame below the
// strip at the video's width over its height as the person resizes it). Its camera and name from env.get's `camera`; its look from
// env.get and `theme`. The shell closes its socket with the window.
import {h, render} from '../vendor/preact.mjs';
import {shellHost} from './host/shell.js';
import {LiveCamera} from './view/camera.js';

const host = shellHost();
const root = document.documentElement, app = document.getElementById('app');
const look = ({theme, reduceMotion} = {}) => {
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme; else delete root.dataset.theme;
  if (reduceMotion) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
};
const env = await host.call('env.get', {}).catch(() => ({}));
look(env);
host.on('theme', look);
const {name, title} = env.camera ?? {};
document.title = title ?? 'Camera';
const close = () => host.call('window.hide', {}).catch(() => {});
render(name ? h(LiveCamera, {host, camera: name, title: title ?? name, windowed: true, onClose: close, closeLabel: `Close ${title ?? name}`})
  : h('p', {class: 'dk-live-note', role: 'status'}, 'No camera'), app);

// the strip moves the window (contract/shell.md *Moving the window*): a primary press on it, never on its buttons
addEventListener('pointerdown', ev => {
  const t = ev.target;
  if (!ev.isTrusted || ev.button !== 0 || !t.closest?.('[data-window-drag]') || t.closest('button, a, input')) return;
  host.call('window.drag', {}).catch(() => {});
});
addEventListener('keydown', ev => { if (ev.key === 'Escape' && !ev.defaultPrevented) close(); });

/** The window at the stream's shape: the frame's size (the video's, else the still's) once known and whenever it changes by 1% or more. */
let asked = 0;
function shape(width, height) {
  if (!(width > 0 && height > 0)) return;
  const ratio = width / height, strip = Math.ceil(app.querySelector('.dk-live-bar')?.getBoundingClientRect().height ?? 0);
  if (asked && Math.abs(ratio - asked) / asked < 0.01) return;
  asked = ratio;
  const w = Math.round(innerWidth);
  host.call('window.resize', {width: w, height: Math.round(w / ratio + strip), ratio: Math.round(ratio * 10000) / 10000, strip}).catch(() => {});
}
app.addEventListener('loadedmetadata', ev => shape(ev.target.videoWidth, ev.target.videoHeight), true);
app.addEventListener('resize', ev => { if (ev.target instanceof HTMLVideoElement) shape(ev.target.videoWidth, ev.target.videoHeight); }, true);
app.addEventListener('load', ev => { if (ev.target instanceof HTMLImageElement && !asked) shape(ev.target.naturalWidth, ev.target.naturalHeight); }, true);
