// The desktop shells' host (Deck.exe in WebView2, Deck.app in WKWebView; CONTRACT.md): every op a message to the native side,
// `{v:1, id, op, args}` → `{v:1, id, ok, result | error: {code, status?, message}}`; events `{v:1, event, data}`; a cancelled call
// `{v:1, cancel: id}`. Resources are same-origin paths the shell serves from its speed layer (`/bridge/v1/…`, `/local/recent/…`).
// The shell validates every call against contract/host-contract.json; the token never reaches this side.
import {CAPS, SITE_CAPS, HOST_API, HostError, emitter, resourcePath} from './host.js';

/** The native channel: Windows `chrome.webview` (postMessage, message events), the Mac `webkit.messageHandlers.deck` (a reply per
 *  message: WKScriptMessageHandlerWithReply; events through `deckHost.receive`, called by callAsyncJavaScript). Else null. */
export function nativeChannel(win = globalThis) {
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
  const host = {
    kind: 'shell', hostApi: HOST_API, platform: channel.platform,
    // the registry's backend names, once env.get says (the places this host can offer)
    backends: [],
    // every cap until env.get says which this shell has (browse and usage, the site's, only when it says so)
    caps: Object.fromEntries(CAPS.map(c => [c, !SITE_CAPS.includes(c)])),
    call(op, args = {}, {signal} = {}) {
      if (signal?.aborted) return Promise.reject(new HostError('cancelled'));
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
        if (op === 'env.get' && result?.caps) Object.assign(host.caps, result.caps);
        if (op === 'env.get' && Array.isArray(result?.backends)) host.backends = result.backends;
        return result;
      });
    },
    resource(path, args, options) {
      if (path === 'habitat.snapshot') return host.call(path, args, options);
      if (!resourcePath(path, {shell: true})) throw new HostError('refused', 'not a resource path');
      return path.startsWith('/local/') ? path : `/bridge${path}`;
    },
    on: events.on,
    /** UI → host notes (ui.state, ui.openGroup, ui.viewerClosed, ui.painted): no reply. */
    note(name, data) { channel.send({v: 1, note: name, data}); },
  };
  return host;
}
