// A camera's picture for every House view (contract/house.md *House*, *Camera wall*, *Live camera*): its refreshed still
// (`habitat.snapshot`) and, where the host offers it, its live video (`habitat.live`: go2rtc's MSE over a WebSocket on Deck's own
// origin, or the desktop shell's relay of it). Live reconnects; until it plays, and whenever it fails, the still stands in. One camera
// on the page is heard at a time (`sound`). `LiveCamera` is the one player the House page and the palette's viewer open; the wall's
// tiles use the same hooks. Nothing is stored or logged.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {describeFailure, failurePage} from '../failure.js';

const html = htm.bind(h);

/** Whether `ref`'s element is on screen, the page visible and the device online: a camera loads only then. `away` (it plays in a
 *  picture-in-picture window, out of the page's sight): on screen whatever the page shows, while online. */
export function useActive(ref, away = false) {
  const [active, setActive] = useState(false), held = useRef(away), resync = useRef(() => {});
  held.current = away;
  useEffect(() => { resync.current(); }, [away]);
  useEffect(() => {
    let visible = false;
    const sync = () => setActive((held.current || visible && !document.hidden) && navigator.onLine);
    resync.current = sync;
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
    observer.observe(ref.current);
    document.addEventListener('visibilitychange', sync);
    addEventListener('online', sync); addEventListener('offline', sync);
    return () => {
      observer.disconnect(); document.removeEventListener('visibilitychange', sync);
      removeEventListener('online', sync); removeEventListener('offline', sync);
    };
  }, []);
  return active;
}

/** A camera's still, `{frame, message, phase, failed, retry}`: refreshed every 5 s while `ref` is on screen, the page visible, the
 *  device online and `enabled` (false while live video plays), and when `stateId`'s state changes on the stream (a Frigate camera's; not
 *  the replay of the state it had: `state`, the one it was drawn with); each at the tile's drawn width in device pixels (`w`). Images
 *  live only in this mount: a pause aborts pending work and discards the frame. `phase`: `idle` (not yet on screen: nothing asked),
 *  `loading` (its first frame asked), `ready`, `failed` (unreachable, `message` the reason) or `missing` (Habitat has no such camera).
 *  A frame that takes past `timeoutMs` is a failure, never a load that goes on forever. Failures last across pauses: a 404 waits for a
 *  changed camera list (`key`); other failures retry after 5, 15, then 60 seconds, or at once on `retry()`. */
export function useStill(host, name, ref, {title = name, enabled = true, stateId = null, state = null, key = null, timeoutMs = 15000} = {}) {
  const failed = useRef(() => {}), gate = useRef(enabled), resync = useRef(() => {}), again$ = useRef(() => {}), known = useRef(state);
  known.current = state;
  const [frame, setFrame] = useState(null), [message, setMessage] = useState(''), [phase, setPhase] = useState('idle');
  gate.current = enabled;
  useEffect(() => { resync.current(); }, [enabled]);
  useEffect(() => {
    let visible = false, active = false, pending = null, timer = null, url = null, generation = 0, again = false, failures = 0, permanent = false, retryAt = 0, loadedAt = 0;
    setPhase('idle'); setMessage('');
    const discard = () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); url = null; setFrame(null); };
    const schedule = ms => { clearTimeout(timer); timer = setTimeout(refresh, ms); };
    const fail = err => {
      discard(); again = false;
      permanent = err?.status === 404;
      const delay = [5000, 15000, 60000][Math.min(failures++, 2)];
      retryAt = Date.now() + delay;
      setPhase(permanent ? 'missing' : 'failed');
      setMessage(permanent ? `${failurePage(`Habitat camera ${title}`)}: Camera not found. Check your camera setup.`
        : describeFailure(`Habitat camera ${title}`, err, {retryIn: `${delay / 1000} seconds while visible and online`}).message);
      clearTimeout(timer);
      if (!permanent && active) schedule(delay);
    };
    failed.current = () => fail({code: 'http'});
    const refresh = async () => {
      if (!active || permanent) return;
      if (retryAt > Date.now()) { schedule(retryAt - Date.now()); return; }
      clearTimeout(timer);
      if (pending) { again = true; return; }
      const controller = pending = new AbortController(), version = generation;
      if (!url && !failures) { setPhase('loading'); setMessage('Loading camera…'); }
      let late = false;
      const deadline = setTimeout(() => { late = true; controller.abort(); }, timeoutMs);
      try {
        // the tile's drawn width in device pixels: Habitat sends that size, not the camera's full frame
        const w = Math.max(1, Math.ceil(ref.current.getBoundingClientRect().width * (globalThis.devicePixelRatio || 1)));
        const r = await host.resource('habitat.snapshot', {query: {camera: name, w}}, {signal: controller.signal});
        if (!active || version !== generation) { if (r.url?.startsWith('blob:')) URL.revokeObjectURL(r.url); return; }
        discard(); url = r.url; setFrame(url); setMessage(''); setPhase('ready'); failures = 0; retryAt = 0; loadedAt = Date.now(); schedule(5000);
      } catch (err) {
        if (version === generation && active) fail(late ? {code: 'timeout'} : err);
      } finally {
        clearTimeout(deadline);
        if (pending === controller) { pending = null; if (again) { again = false; refresh(); } }
      }
    };
    // a press on Retry: now, whatever the backoff says (never a camera Habitat does not have)
    again$.current = () => { if (permanent) return; retryAt = 0; if (active) refresh(); };
    const sync = () => {
      const next = visible && gate.current && !document.hidden && navigator.onLine;
      if (next === active) return;
      active = next; generation++;
      clearTimeout(timer); pending?.abort(); pending = null; again = false;
      if (active) refresh();
      else { discard(); if (!permanent && !failures) { setPhase('idle'); setMessage(navigator.onLine ? 'Camera paused' : describeFailure(`Habitat camera ${title}`, {code: 'unreachable'}, {retryIn: 'when online and visible'}).message); } }
    };
    resync.current = sync;
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
    observer.observe(ref.current);
    document.addEventListener('visibilitychange', sync);
    addEventListener('online', sync); addEventListener('offline', sync);
    // a camera's state change asks for a new frame; the stream's replay of the state it already had (on every connect) does not:
    // 2026-10-20 the tablet loaded all nine cameras twice within 300 ms, the replay landing while each first frame loaded
    const sign = s => JSON.stringify([s?.state, s?.last_changed]);
    let seen;
    const off = stateId ? host.on('habitat.state', d => {
      if (d.entity_id !== stateId) return;
      // the first event this tile hears is a replay when it lands as the tile's first frame loads (or just loaded)
      // against the last state heard, else the one the tile was last drawn with (this listener runs before the redraw)
      const now = sign(d.new), before = seen ?? (known.current ? sign(known.current) : undefined);
      const changed = before !== undefined ? now !== before : !pending && Date.now() - loadedAt > 1000;
      seen = now;
      if (changed) refresh();
    }) : () => {};
    return () => {
      active = false; generation++; pending?.abort(); clearTimeout(timer); discard(); observer.disconnect(); off();
      resync.current = () => {}; again$.current = () => {};
      document.removeEventListener('visibilitychange', sync);
      removeEventListener('online', sync); removeEventListener('offline', sync);
    };
  }, [host, name, key]);
  return {frame, message, phase, failed: () => failed.current(), retry: () => again$.current()};
}

/** The codecs a page offers go2rtc (its www/video-rtc.js list): video, and sound for the tile that plays it (AAC: the cameras'). */
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
const SOUND = /mp4a|opus|flac/;

const mediaSource = win => win.ManagedMediaSource ?? win.MediaSource;
/** Whether this browser can play go2rtc's MSE stream at all. */
export const liveSupported = (win = globalThis) => !!mediaSource(win) && typeof win.WebSocket === 'function';

/** Plays one go2rtc MSE socket (`url`, or `open()`'s socket: the shell's relay, WebSocket-shaped) into `video`: asks for the codecs the
 *  browser plays, appends go2rtc's fMP4 as it comes, keeps near the live edge and drops what has played. `onState('live', null, audio)`
 *  once frames play (`audio`: the stream carries sound), `onState('failed', why)` on a socket close (`refused`: closed before it
 *  opened, as Habitat's 404 for a camera it does not stream), a codec go2rtc chose the browser cannot play, an append or decode error,
 *  or `stallMs` without data (then everything is released). Answers stop(). `win`: tests' window. */
export function playLive({url, open = null, video, onState, win = globalThis, stallMs = 10000, firstMs = 15000}) {
  const MS = mediaSource(win), managed = MS === win.ManagedMediaSource;
  const ms = new MS(), started = Date.now();
  let ws = null, sb = null, queue = [], stopped = false, last = 0, live = false, objectUrl = null, opened = false;
  if (managed) { video.disableRemotePlayback = true; video.srcObject = ms; }
  else video.src = objectUrl = (win.URL ?? URL).createObjectURL(ms);
  let audio = false;
  const playing = () => { if (!live && !stopped) { live = true; onState('live', null, audio); } };
  const fail = why => { if (stopped) return; stop(); onState('failed', why); };
  const broken = () => fail('decode');
  video.addEventListener('playing', playing);
  video.addEventListener('error', broken);
  // Runs from the socket and from the SourceBuffer's events: nothing it touches may throw out of them. A frame the browser cannot
  // decode (WebKit on Linux: no H.264) detaches the SourceBuffer before the video's error arrives, and then even its `buffered`
  // throws InvalidStateError: that is a failure like any other, and the still stands in.
  const pump = () => {
    if (!sb || stopped) return;
    try {
      if (sb.updating) return;
      if (queue.length) {
        const chunk = queue.length === 1 ? queue[0] : concat(queue);
        queue = [];
        sb.appendBuffer(chunk);
        return;
      }
      const b = sb.buffered;
      if (!b.length) return;
      const start = b.start(0), end = b.end(b.length - 1);
      // a socket delivers in bursts: keep within 3 s of the newest frame, and the buffer under 10 s
      if (end - video.currentTime > 3) video.currentTime = Math.max(start, end - 0.5);
      else if (video.currentTime - start > 10) sb.remove(start, video.currentTime - 5);
      if (video.paused) video.play().catch(() => {});
    } catch (e) { fail(e?.name ?? 'append'); }
  };
  ms.addEventListener('sourceopen', () => {
    if (stopped) return;
    try { ws = open ? open() : new win.WebSocket(url); } catch { fail('socket'); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { opened = true; ws.send(JSON.stringify({type: 'mse', value: CODECS.filter(c => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',')})); };
    ws.onmessage = ev => {
      if (stopped) return;
      if (typeof ev.data !== 'string') { last = Date.now(); queue.push(ev.data); pump(); return; }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === 'error') fail('go2rtc');
      else if (msg?.type === 'mse' && !sb) {
        if (typeof msg.value !== 'string' || !MS.isTypeSupported(msg.value)) return fail('codec');
        audio = SOUND.test(msg.value);
        try { sb = ms.addSourceBuffer(msg.value); } catch { return fail('codec'); }
        try { sb.mode = 'segments'; } catch { return fail('codec'); }
        sb.addEventListener('updateend', pump);
        sb.addEventListener('error', () => fail('decode'));
      }
    };
    ws.onclose = () => fail(opened ? 'closed' : 'refused');
  }, {once: true});
  const watchdog = setInterval(() => {
    if (last ? Date.now() - last > stallMs : Date.now() - started > firstMs) fail('stalled');
  }, Math.min(2000, stallMs));
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    video.removeEventListener('playing', playing);
    video.removeEventListener('error', broken);
    if (ws) { ws.onclose = ws.onmessage = null; try { ws.close(); } catch { /* closing */ } }
    queue = [];
    try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* already ended */ }
    if (managed) video.srcObject = null;
    else video.removeAttribute('src');
    try { video.load(); } catch { /* a detached element */ }
    if (objectUrl) (win.URL ?? URL).revokeObjectURL(objectUrl);
  }
  return stop;
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(new Uint8Array(c), at); at += c.byteLength; }
  return out.buffer;
}

/** A camera's live video into `videoRef` while `enabled`: {state, audio, refused}; state `'off'` (not enabled), `'none'` (no MSE, or
 *  the host offers none), `'connecting'`, `'live'` or `'failed'` (reconnecting after 1 s, doubling to 30 s); `audio` whether the playing
 *  stream carries sound; `refused` whether Habitat refused this camera's stream (its socket closed before it opened) since it last
 *  played: a camera Habitat does not stream live, so the still stands in and says so. */
export function useLive(host, name, videoRef, {enabled = true} = {}) {
  const [state, setState] = useState('off'), [audio, setAudio] = useState(false), [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!enabled) { setState('off'); return undefined; }
    if (!liveSupported()) { setState('none'); return undefined; }
    let stop = null, retry = null, attempt = 0, gone = false;
    const start = async () => {
      setState(s => s === 'failed' ? s : 'connecting');
      let answer;
      try { answer = await host.resource('habitat.live', {query: {camera: name}}); }
      catch { if (!gone) setState('none'); return; } // this host has no live video: the still alone
      if (gone || !videoRef.current) return;
      stop = playLive({url: answer.url, open: answer.open ?? null, video: videoRef.current, onState: (s, why, sound) => {
        if (gone) return;
        if (s === 'live') { attempt = 0; setAudio(!!sound); setRefused(false); setState('live'); return; }
        if (why === 'refused') setRefused(true);
        setState('failed');
        stop = null;
        retry = setTimeout(start, Math.min(30000, 1000 * 2 ** attempt++));
      }});
    };
    start();
    return () => { gone = true; clearTimeout(retry); stop?.(); };
  }, [host, name, enabled]);
  return {state, audio, refused};
}

/** The one camera heard (contract/house.md *Live camera*): a player takes the sound, which mutes whichever had it, so two streams never
 *  sound at once. `owner` is a player's own token (useSound), or `elsewhere`: a camera in another of the shell's windows took it (the
 *  shell's `camera.muted`). On a shell with the `live` cap (`link`) the rule spans its windows: taking the sound here says so
 *  (`camera.sound`), and the shell mutes the rest. */
export const sound = {
  owner: null, listeners: new Set(), hosts: new Set(), elsewhere: Symbol('another window'),
  take(token) {
    if (sound.owner === token) return;
    sound.owner = token;
    for (const fn of sound.listeners) fn(token);
    if (token !== sound.elsewhere) for (const host of sound.hosts) host.call('camera.sound', {}).catch(() => {});
  },
  drop(token) { if (sound.owner === token) { sound.owner = null; for (const fn of sound.listeners) fn(null); } },
  /** A shell's page: its players' sound and the other windows' one rule (once per host). */
  link(host) {
    if (host?.kind !== 'shell' || !host.caps?.live || sound.hosts.has(host)) return;
    sound.hosts.add(host);
    host.on('camera.muted', () => sound.take(sound.elsewhere));
  },
};
/** [mine, take, drop]: whether this player has the sound; taking it mutes every other player (on a shell, in its other windows too);
 *  unmounting drops it. */
export function useSound(host = null) {
  const token = useRef(null);
  token.current ??= Symbol('camera');
  sound.link(host);
  const [owner, setOwner] = useState(sound.owner);
  useEffect(() => {
    sound.listeners.add(setOwner);
    const me = token.current;
    return () => { sound.listeners.delete(setOwner); sound.drop(me); };
  }, []);
  return [owner === token.current, () => sound.take(token.current), () => sound.drop(token.current)];
}

/** Unmutes `videoRef` while `heard`, else mutes it. A browser that refuses sound without a gesture (`play()` rejected
 *  `NotAllowedError`) keeps it muted and calls `onBlocked`; a later gesture's `heard` asks again. */
export function useHeard(videoRef, heard, onBlocked) {
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !heard;
    if (heard) v.play().catch(e => { if (e?.name === 'NotAllowedError') { v.muted = true; onBlocked?.(); } });
  }, [heard]);
}

/** How this host pops a camera out (contract/house.md *Live camera*, *Pop out*): `window` (a shell with the `live` cap: the camera in
 *  its own small always-on-top window, camera.popOut), `document` (Document Picture-in-Picture, Chromium: the player itself, its sound
 *  button with it), `video` (the video's own Picture-in-Picture: Chromium, Safari), else null (no button). `win`: tests' window. */
export function popOutKind(host, win = globalThis) {
  if (host?.kind === 'shell') return host.caps?.live ? 'window' : null;
  if (typeof win.documentPictureInPicture?.requestWindow === 'function') return 'document';
  if (win.document?.pictureInPictureEnabled && typeof win.HTMLVideoElement?.prototype?.requestPictureInPicture === 'function') return 'video';
  return null;
}

/** The player's `box` moved into a Document Picture-in-Picture window the frame's size (the page's style sheets and look with it: the
 *  camera window's layout, `data-surface="camera"`), back in its place when that window closes (`onBack`). Answers close(). Its
 *  controls are the same elements, so the sound button and the one-sound rule go with them. */
async function documentPip(box, title, onBack, win = globalThis) {
  const {width, height} = box.getBoundingClientRect();
  const pip = await win.documentPictureInPicture.requestWindow({width: Math.round(Math.max(320, width)), height: Math.round(Math.max(200, height))});
  const doc = pip.document, root = win.document.documentElement;
  doc.title = title;
  for (const sheet of win.document.querySelectorAll('link[rel="stylesheet"]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet'; link.href = sheet.href;
    doc.head.append(link);
  }
  const look = () => {
    for (const k of Object.keys(doc.documentElement.dataset)) delete doc.documentElement.dataset[k];
    Object.assign(doc.documentElement.dataset, root.dataset, {surface: 'camera'});
  };
  look();
  const watch = new MutationObserver(look);
  watch.observe(root, {attributes: true, attributeFilter: ['data-theme', 'data-motion']});
  const home = box.parentNode, next = box.nextSibling;
  doc.body.append(box);
  pip.addEventListener('pagehide', () => {
    watch.disconnect();
    if (home.isConnected || home.parentNode) home.insertBefore(box, next?.parentNode === home ? next : null);
    onBack();
  }, {once: true});
  return () => pip.close();
}

/** The video in the browser's own Picture-in-Picture (`requestPictureInPicture`, inside the press's gesture), back on its
 *  `leavepictureinpicture` (`onBack`). Answers close(). */
function videoPip(video, onBack, win = globalThis) {
  video.disablePictureInPicture = false;
  video.addEventListener('leavepictureinpicture', () => { video.disablePictureInPicture = true; onBack(); }, {once: true});
  return video.requestPictureInPicture().then(() => () => {
    if (win.document.pictureInPictureElement === video) win.document.exitPictureInPicture().catch(() => {});
  }, e => { video.disablePictureInPicture = true; throw e; });
}

/** One camera live with its sound (contract/house.md *Live camera*): its video while it plays, else its still (with *Live
 *  unavailable* when Habitat refuses this camera's stream), under it the camera's name, what the stream is doing, a sound button
 *  (when its stream carries sound: its glyph the sound's state, its words the press's: Mute, Unmute), a pop out button where the host
 *  has one (popOutKind; *Pop out*) and, with `onClose`, a close button (focused). `named` false where a header names it already;
 *  `fit` `contain` shows the whole frame, `cover` fills the box. `windowed`: the camera window's own page (camera.html): its bar the
 *  window's drag region, no pop out. Opening it plays its sound, as a tap on the wall's tile does; the button mutes and unmutes it,
 *  and taking the sound mutes any other camera (on a shell, in its other windows too). A browser that wants a gesture first keeps it
 *  muted and the button says *Tap for sound*. Popped out, it plays on whatever the page shows: in a picture-in-picture window (the
 *  web: back in its place when that closes), or in the shell's camera window (the panel hides; Deck's own window keeps the still,
 *  *In its own window*, until Play here). Unmounted (closed), its socket and frames go, and a picture-in-picture window with them. */
export function LiveCamera({host, camera, title, named = true, fit = 'contain', stateId = null, state = null, cameras = null, onClose = null, closeLabel = 'Close', windowed = false}) {
  const frameRef = useRef(null), video = useRef(null), close = useRef(null), box = useRef(null), back = useRef(null);
  // where it plays when not in the page: 'window' (the shell's camera window), 'document' or 'video' (picture-in-picture)
  const [away, setAway] = useState(null), [note, setNote] = useState(null);
  const inPip = away === 'document' || away === 'video';
  const active = useActive(frameRef, inPip);
  // a camera Habitat has no still of (404: Frigate does not list it) is offered no live video either
  const [missing, setMissing] = useState(false);
  const {state: live, audio, refused} = useLive(host, camera, video, {enabled: active && away !== 'window' && !missing});
  const {frame, message, phase, failed} = useStill(host, camera, frameRef, {title, enabled: live !== 'live', stateId, state, key: cameras});
  useEffect(() => { setMissing(phase === 'missing'); }, [phase]);
  const [mine, take, drop] = useSound(host), [want, setWant] = useState(true), [blocked, setBlocked] = useState(false);
  const playing = live === 'live', heard = want && mine && playing && audio && !blocked;
  // opened: its sound wanted, so it takes the sound (another camera's goes quiet)
  useEffect(() => { if (want) take(); }, [want]);
  useHeard(video, heard, () => setBlocked(true));
  // opened in the page: its close focused (a camera window opens without taking the focus)
  useLayoutEffect(() => { if (onClose && !windowed) close.current?.focus({preventScroll: true}); }, []);
  // closed while popped out: the picture-in-picture window goes too
  useEffect(() => () => { back.current?.(); back.current = null; }, []);
  useEffect(() => { if (!note) return undefined; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);
  const on = want && mine && !blocked;
  const toggle = () => {
    // a press is the gesture a browser waits for: sound now plays
    if (blocked) { setBlocked(false); setWant(true); take(); return; }
    if (on) { setWant(false); drop(); } else { setWant(true); take(); }
  };
  const kind = windowed ? null : popOutKind(host);
  const returned = () => { back.current = null; setAway(null); };
  const popOut = () => {
    if (away === 'window') { setAway(null); return; }
    if (inPip) { back.current?.(); return; }
    const failedToOpen = e => setNote(e?.message && kind === 'window' ? e.message : 'Could not pop out');
    if (kind === 'window') {
      host.call('camera.popOut', {camera, title}).then(() => {
        // the panel hides (its page resets); Deck's own window keeps the still until Play here
        if (host.caps.window) host.call('window.hide', {}).catch(() => {});
        else setAway('window');
      }, failedToOpen);
    } else if (kind === 'video') {
      videoPip(video.current, returned).then(closeIt => { back.current = closeIt; setAway('video'); }, failedToOpen);
    } else if (kind === 'document') {
      documentPip(box.current, title, returned).then(closeIt => { back.current = closeIt; setAway('document'); }, failedToOpen);
    }
  };
  const feed = playing ? 'live' : frame ? 'still' : 'none';
  const unavailable = refused || live === 'none' || missing;
  const said = note ?? (away === 'window' ? 'In its own window' : playing ? 'Live' : missing ? 'Camera not found' : unavailable ? 'Live unavailable' : live === 'failed' ? 'Reconnecting…' : 'Connecting…');
  const soundState = playing && audio ? blocked ? 'blocked' : on ? 'on' : 'off' : null;
  // the pop out: once it plays (a picture-in-picture window needs its frames); out already, the press brings it back
  const [popLabel, popName] = away === 'window' ? ['Play here', `Play ${title} here`] : inPip ? ['Back to the page', `Bring ${title} back`] : ['Pop out', `Pop out ${title}`];
  const popButton = kind && (playing || away) ? html`<button type="button" class=${`dk-btn dk-live-pop${away ? ' out' : ''}`} aria-label=${popName} title=${popLabel}
    onClick=${popOut}><${Glyph} name=${away === 'window' ? 'video' : 'popout'} />${away === 'window' ? popLabel : null}</button>` : null;
  return html`<figure class=${`dk-live fit-${fit === 'contain' ? 'contain' : 'cover'}${windowed ? ' windowed' : ''}`} data-camera=${camera} data-feed=${feed} data-live=${unavailable ? 'unavailable' : live}
    data-sound=${soundState} data-away=${away} aria-label=${`${title}, ${playing ? 'live' : unavailable ? 'live unavailable' : 'snapshot'}`}>
    <div class="dk-live-box" ref=${box}>
      <div class="dk-live-frame" ref=${frameRef}>
        <video ref=${video} class=${playing ? 'on' : ''} muted playsinline autoplay disablepictureinpicture aria-hidden="true"></video>
        ${playing ? null : frame ? html`<img src=${frame} alt="" decoding="async" onError=${failed} />` : html`<span class="dk-live-note" role="status">${message}</span>`}
      </div>
      <div class="dk-live-bar" data-window-drag=${windowed ? '' : null}>
        <span class="dk-live-title">${named ? html`<b>${title}</b>` : null}<span class=${`dk-live-state${note ? ' off' : playing && away !== 'window' ? ' on' : unavailable ? ' off' : ''}`} role="status">${said}</span></span>
        ${soundState ? html`<button type="button" class=${`dk-btn dk-live-sound ${soundState}`} onClick=${toggle}>
          <${Glyph} name=${soundState === 'on' ? 'sound' : 'muted'} />${soundState === 'blocked' ? 'Tap for sound' : soundState === 'on' ? 'Mute' : 'Unmute'}</button>` : null}
        ${popButton}
        ${onClose ? html`<button type="button" class="dk-btn dk-live-close" ref=${close} aria-label=${closeLabel} onClick=${onClose}><${Glyph} name="close" /></button>` : null}
      </div>
    </div>
    <p class="dk-live-away" role="status" hidden=${away !== 'document'}>${`${title} is playing in a picture-in-picture window.`}</p>
  </figure>`;
}

/** The Habitat camera among a thing's Home Assistant entities (`ids`, exact entity ids; never matched by name): its camera name
 *  (`camera.garage` → `garage`, Habitat's snapshot and live key), else null. */
export const cameraOf = ids => ids.find(id => /^camera\.[a-z0-9_]+$/.test(id ?? ''))?.slice(7) ?? null;

/** The camera a house record names (bridge.doc's answer for a thing's own document: house-model's `kind: camera` and its `camera`,
 *  Frigate's name for it), else null. A camera house-model records with no Home Assistant entity is still a camera. */
export function cameraOfRecord(doc) {
  const field = name => (doc?.fields ?? []).find(f => String(f?.name).toLowerCase() === name)?.value;
  const name = String(field('camera') ?? '').trim();
  return doc?.source === 'house' && String(field('kind') ?? '').toLowerCase() === 'camera' && /^[a-z0-9_]+$/.test(name) ? name : null;
}

/** A thing that is a camera (the palette's viewer: palette SPEC.md *Kinds*, `thing`) plays live at its view's top, where the host has
 *  Habitat; closing the view stops it. `camera`: its name where the thing says it outright (bridge's `camera`, its house record's). */
export function ThingCamera({host, ids = [], title, camera: named = null}) {
  const camera = named ?? cameraOf(ids);
  if (!camera || !host?.backends?.includes('habitat')) return null;
  return html`<${LiveCamera} host=${host} camera=${camera} title=${title} named=${false} />`;
}
