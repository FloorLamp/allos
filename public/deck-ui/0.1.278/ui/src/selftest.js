// The shells' selftest (DESIGN.md §4: `Deck.exe selftest`, `Deck --selftest` load `app.html?selftest`): every op of the contract once
// through the real web view and host, then the note `selftest.done {ok, results: [{op, expect, got, pass}]}`. Ops that only read
// (env, bridge's answers, Recent's list, prefs, picks) go with the contract's example and must answer; any op that changes or opens
// something (an action, a transfer, the clipboard, a page, a window, an ask, telemetry) goes with args off its schema, so the host
// must refuse it, touching nothing: it proves the op is wired and checked, never runs it. An op whose cap the host turned off must
// be `unsupported` (one that changes something may say `refused` first).
const READS = new Set(['env.get', 'bridge.find', 'bridge.doc', 'bridge.pages', 'bridge.conversation', 'bridge.related', 'bridge.project', 'bridge.day',
  'bridge.vehicles', 'bridge.properties', 'bridge.insurance', 'bridge.taxes', 'bridge.taxPacket', 'bridge.papers', 'bridge.things', 'bridge.thing', 'bridge.subject', 'bridge.facets', 'bridge.browse', 'bridge.usage', 'bridge.texts', 'bridge.textsPages', 'bridge.textsConversation', 'bridge.matches', 'bridge.needs', 'bridge.actions', 'bridge.prefetch', 'recent.list', 'codes.list', 'devices.targets', 'files.pending', 'prefs.get', 'picks.list']);
/** bridge's own failures (no such document, unreachable, not set up) still show the op reached bridge through the host. */
const REACHED = new Set(['http', 'unreachable', 'not-set-up']);

export async function selftest(host, {contract = null, fetch: get = globalThis.fetch?.bind(globalThis)} = {}) {
  contract ??= await (await get(new URL('../contract/host-contract.json', import.meta.url))).json();
  const results = [];
  for (const [op, spec] of Object.entries(contract.ops)) {
    const off = spec.cap && !host.caps[spec.cap], read = READS.has(op);
    const expect = off ? 'unsupported' : read ? 'ok' : 'refused';
    let got;
    try {
      await host.call(op, read ? spec.example : {...spec.example, selftest: true});
      got = 'ok';
    } catch (e) { got = e?.code ?? 'error'; }
    results.push({op, expect, got, pass: got === expect || (expect === 'ok' && REACHED.has(got)) || (off && !read && got === 'refused')});
  }
  return {ok: results.every(r => r.pass), results};
}
