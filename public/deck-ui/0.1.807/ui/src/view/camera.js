// A camera's picture for every House view (contract/house.md *House*, *Camera wall*): its refreshed still (`habitat.snapshot`)
// and, where the host offers it, its live video (`habitat.live`: go2rtc's MSE over a WebSocket on Deck's own origin). Live plays
// muted with no controls and reconnects; until it plays, and whenever it fails, the still stands in. Nothing is stored or logged.
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import {describeFailure, failurePage} from '../failure.js';

/** Whether `ref`'s element is on screen, the page visible and the device online: a camera loads only then. */
export function useActive(ref) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let visible = false;
    const sync = () => setActive(visible && !document.hidden && navigator.onLine);
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

/** A camera's still, `{frame, message, failed}`: refreshed every 5 s while `ref` is on screen, the page visible, the device online and
 *  `enabled` (false while live video plays), and when `stateId`'s state changes on the stream (a Frigate camera's; not the replay of
 *  the state it had: `state`, the one it was drawn with); each at the tile's drawn width in device pixels (`w`). Images live only in this
 *  mount: a pause aborts pending work and discards the frame. Failures last across pauses: a 404 waits for a changed camera list
 *  (`key`); other failures retry after 5, 15, then 60 seconds. */
export function useStill(host, name, ref, {title = name, enabled = true, stateId = null, state = null, key = null} = {}) {
  const failed = useRef(() => {}), gate = useRef(enabled), resync = useRef(() => {}), known = useRef(state);
  known.current = state;
  const [frame, setFrame] = useState(null), [message, setMessage] = useState('Loading camera…');
  gate.current = enabled;
  useEffect(() => { resync.current(); }, [enabled]);
  useEffect(() => {
    let visible = false, active = false, pending = null, timer = null, url = null, generation = 0, again = false, failures = 0, permanent = false, retryAt = 0, loadedAt = 0;
    const discard = () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); url = null; setFrame(null); };
    const schedule = ms => { clearTimeout(timer); timer = setTimeout(refresh, ms); };
    const fail = err => {
      discard(); again = false;
      permanent = err?.status === 404;
      const delay = [5000, 15000, 60000][Math.min(failures++, 2)];
      retryAt = Date.now() + delay;
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
      try {
        // the tile's drawn width in device pixels: Habitat sends that size, not the camera's full frame
        const w = Math.max(1, Math.ceil(ref.current.getBoundingClientRect().width * (globalThis.devicePixelRatio || 1)));
        const r = await host.resource('habitat.snapshot', {query: {camera: name, w}}, {signal: controller.signal});
        if (!active || version !== generation) { if (r.url?.startsWith('blob:')) URL.revokeObjectURL(r.url); return; }
        discard(); url = r.url; setFrame(url); setMessage(''); failures = 0; retryAt = 0; loadedAt = Date.now(); schedule(5000);
      } catch (err) {
        if (version === generation && active) fail(err);
      } finally {
        if (pending === controller) { pending = null; if (again) { again = false; refresh(); } }
      }
    };
    const sync = () => {
      const next = visible && gate.current && !document.hidden && navigator.onLine;
      if (next === active) return;
      active = next; generation++;
      clearTimeout(timer); pending?.abort(); pending = null; again = false;
      if (active) refresh();
      else { discard(); if (!permanent && !failures) setMessage(navigator.onLine ? 'Camera paused' : describeFailure(`Habitat camera ${title}`, {code: 'unreachable'}, {retryIn: 'when online and visible'}).message); }
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
      resync.current = () => {};
      document.removeEventListener('visibilitychange', sync);
      removeEventListener('online', sync); removeEventListener('offline', sync);
    };
  }, [host, name, key]);
  return {frame, message, failed: () => failed.current()};
}

/** The codecs a page offers go2rtc (its www/video-rtc.js list): video, and sound for the tile that plays it (AAC: the cameras'). */
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
const SOUND = /mp4a|opus|flac/;

const mediaSource = win => win.ManagedMediaSource ?? win.MediaSource;
/** Whether this browser can play go2rtc's MSE stream at all. */
export const liveSupported = (win = globalThis) => !!mediaSource(win) && typeof win.WebSocket === 'function';

/** Plays one go2rtc MSE socket (`url`) into `video`: asks for the codecs the browser plays, appends go2rtc's fMP4 as it comes, keeps
 *  near the live edge and drops what has played. `onState('live', null, audio)` once frames play (`audio`: the stream carries sound), `onState('failed', why)` on a socket close, a
 *  codec go2rtc chose the browser cannot play, an append or decode error, or `stallMs` without data (then everything is released). Answers
 *  stop(). `win`: tests' window. */
export function playLive({url, video, onState, win = globalThis, stallMs = 10000, firstMs = 15000}) {
  const MS = mediaSource(win), managed = MS === win.ManagedMediaSource;
  const ms = new MS(), started = Date.now();
  let ws = null, sb = null, queue = [], stopped = false, last = 0, live = false, objectUrl = null;
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
    try { ws = new win.WebSocket(url); } catch { fail('socket'); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({type: 'mse', value: CODECS.filter(c => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',')}));
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
    ws.onclose = () => fail('closed');
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

/** A camera's live video into `videoRef` while `enabled`: [state, audio]; state `'off'` (none: not enabled, no MSE, or the host
 *  offers none), `'connecting'`, `'live'` or `'failed'` (reconnecting after 1 s, doubling to 30 s); `audio` whether the playing
 *  stream carries sound. */
export function useLive(host, name, videoRef, {enabled = true} = {}) {
  const [state, setState] = useState('off'), [audio, setAudio] = useState(false);
  useEffect(() => {
    if (!enabled || !liveSupported()) { setState('off'); return undefined; }
    let stop = null, retry = null, attempt = 0, gone = false;
    const start = async () => {
      setState(s => s === 'failed' ? s : 'connecting');
      let url;
      try { ({url} = await host.resource('habitat.live', {query: {camera: name}})); }
      catch { if (!gone) setState('off'); return; } // this host has no live video: the still alone
      if (gone || !videoRef.current) return;
      stop = playLive({url, video: videoRef.current, onState: (s, why, sound) => {
        if (gone) return;
        if (s === 'live') { attempt = 0; setAudio(!!sound); setState('live'); return; }
        setState('failed');
        stop = null;
        retry = setTimeout(start, Math.min(30000, 1000 * 2 ** attempt++));
      }});
    };
    start();
    return () => { gone = true; clearTimeout(retry); stop?.(); };
  }, [host, name, enabled]);
  return [state, audio];
}
