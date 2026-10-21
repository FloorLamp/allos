import {houseActionOps} from './house-actions.js';
// The desktop shells' host (Deck.exe in WebView2, Deck.app in WKWebView; contract/README.md): every op a message to the native side,
// `{v:1, id, op, args}` → `{v:1, id, ok, result | error: {code, status?, message}}`; events `{v:1, event, data}`; a cancelled call
// `{v:1, cancel: id}`. Resources are same-origin paths the shell serves from its speed layer (`/bridge/v1/…`, `/local/recent/…`).
// The shell validates every call against contract/host-contract.json; the token never reaches this side.
import {CAPS, SITE_CAPS, HOST_API, HostError, emitter, resourcePath, untilWarm} from './host.js';

/** Full-page controls need the same gesture notes as the palette, before their handlers run. */
export function pageInput(host, win = globalThis) {
  for (const [event, kind] of [['keydown', 'key'], ['pointerdown', 'pointer']]) {
    win.addEventListener(event, ev => {
      if (ev.isTrusted) host.note('ui.input', {at: Math.round(performance.timeOrigin + ev.timeStamp), kind});
    }, true);
  }
}

/** Android's own commands in the shared bar's Menu (contract/shell.md *Android pages*): the native file picker and Settings. */
export const androidActions = host => [
  {id: 'send', label: 'Send file', glyph: 'file', run: () => host.note('android.send', {})},
  {id: 'settings', label: 'Settings', glyph: 'settings', run: () => host.note('android.settings', {})},
];

/** The native channel: Windows `chrome.webview` (postMessage, message events), the Mac `webkit.messageHandlers.deck` (a reply per
 *  message: WKScriptMessageHandlerWithReply; events through `deckHost.receive`, called by callAsyncJavaScript). Else null. */
export function nativeChannel(win = globalThis) {
  if (win.deckAndroid) return {
    platform: 'android', send: msg => { win.deckAndroid.postMessage(msg); return null; },
    listen: fn => win.deckAndroid.addEventListener('message', e => fn(e.data)),
  };
  const wv = win.chrome?.webview;
  if (wv) {
    return {
      platform: 'windows',
      send: msg => { wv.postMessage(msg); return null; },
      listen: fn => wv.addEventListener('message', e => fn(e.data)),
    };
  }
  const mac = win.webkit?.messageHandlers?.deck;
  if (mac) {
    let receive = () => {};
    win.deckHost = Object.freeze({receive: msg => receive(msg)});
    return {platform: 'mac', send: msg => mac.postMessage(msg), listen: fn => { receive = fn; }};
  }
  return null;
}

/** channel: {send(msg) → a reply's promise or null (the reply comes as a message), listen(fn)}; nativeChannel() by default. */
export function shellHost(channel = nativeChannel()) {
  if (!channel) throw new Error('deck-ui: no native host here (not inside Deck.exe or Deck.app)');
  const events = emitter(), pending = new Map();
  let next = 1;
  const settle = msg => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result ?? null);
    else p.reject(new HostError(msg.error?.code ?? 'http', msg.error?.message ?? 'failed', msg.error?.status));
  };
  channel.listen(msg => {
    if (!msg || msg.v !== 1) return;
    if (typeof msg.event === 'string') events.emit(msg.event, msg.data ?? null);
    else if (msg.id != null) settle(msg);
  });
  /** One call to the native side: its reply's result, or a HostError. */
  function once(op, args, signal) {
    if (signal?.aborted) return Promise.reject(new HostError('cancelled'));
    if (op.startsWith('money.') && !host.caps.money) return Promise.reject(new HostError('unsupported'));
    const id = next++;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      signal?.addEventListener('abort', () => {
        if (!pending.delete(id)) return;
        channel.send({v: 1, cancel: id});
        reject(new HostError('cancelled'));
      }, {once: true});
      Promise.resolve(channel.send({v: 1, id, op, args})).then(reply => { if (reply) settle({...reply, id}); },
        e => { pending.delete(id); reject(new HostError('unreachable', String(e?.message ?? e))); });
    }).then(result => {
      // env.get is authoritative; older hosts omit capabilities introduced by newer UI bundles.
      if (op === 'env.get' && result?.caps) for (const cap of CAPS) host.caps[cap] = result.caps[cap] === true;
      if (op === 'env.get' && Array.isArray(result?.backends)) host.backends = result.backends;
      return result;
    });
  }
  const houseActions = houseActionOps((op, args, options) => once(op, args, options?.signal));
  /** habitat.live on a shell (contract/house.md *Live camera*): the shell opens Habitat's live socket with its device credential and
   *  relays it (`camera.open`, `camera.send`, `camera.close`; events `camera.message`, `camera.closed`), so the page gets a
   *  WebSocket-shaped socket for playLive and never the credential. A shell without the `live` cap has none: the still alone. */
  let relays = 0;
  function live(args) {
    if (!host.caps.live) return Promise.reject(new HostError('unsupported', 'no live video on this device'));
    const camera = args?.query?.camera;
    if (typeof camera !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(camera)) return Promise.reject(new HostError('refused', 'not a camera name'));
    return Promise.resolve({url: null, open: () => relay(camera)});
  }
  function relay(camera) {
    const id = `l${(++relays).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let opened = false, done = false;
    const ws = {binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null,
      send(text) { if (opened && !done) once('camera.send', {id, text}).catch(() => {}); },
      close() { if (done) return; done = true; off(); if (opened) once('camera.close', {id}).catch(() => {}); }};
    const offs = [events.on('camera.message', d => {
      if (d?.id !== id || done) return;
      if (typeof d.text === 'string') ws.onmessage?.({data: d.text});
      else if (typeof d.data === 'string') ws.onmessage?.({data: base64Bytes(d.data)});
    }), events.on('camera.closed', d => { if (d?.id === id) end(); })];
    const off = () => { for (const f of offs) f(); };
    const end = () => { if (done) return; done = true; off(); ws.onclose?.({}); };
    once('camera.open', {id, camera}).then(() => {
      if (done) { once('camera.close', {id}).catch(() => {}); return; }
      opened = true; ws.onopen?.();
    }, end);
    return ws;
  }
  const host = {
    kind: 'shell', hostApi: HOST_API, platform: channel.platform,
    // the registry's backend names, once env.get says (the nav this host can offer)
    backends: [],
    // every cap until env.get says which this shell has (browse and usage, the site's, only when it says so)
    caps: Object.fromEntries(CAPS.map(c => [c, !SITE_CAPS.includes(c)])),
    // bridge's collections just after its start answer 503 warming: asked again until they answer (host.js untilWarm)
    call(op, args = {}, {signal, onWarming} = {}) {
      if (channel.platform !== 'mac' && (op === 'habitat.actions' || op === 'habitat.run')) {
        if (!host.caps.actions) throw new HostError('unsupported');
        return houseActions(op, args, {signal});
      }
      return untilWarm(() => once(op, args, signal), {signal, onWarming});
    },
    resource(path, args, options) {
      if (path === 'habitat.snapshot') return host.call(path, args, options);
      if (path === 'habitat.live') return live(args);
      if (!resourcePath(path, {shell: true})) throw new HostError('refused', 'not a resource path');
      return path.startsWith('/local/') ? path : `/bridge${path}`;
    },
    on: events.on,
    /** UI → host notes (ui.state, ui.openGroup, ui.viewerClosed, ui.painted): no reply. */
    note(name, data) { channel.send({v: 1, note: name, data}); },
  };
  return host;
}

/** A relayed binary message (base64) as the ArrayBuffer a WebSocket would deliver. */
function base64Bytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text).buffer;
  const raw = atob(text), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}
