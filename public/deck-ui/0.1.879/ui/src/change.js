import {timeText} from './format.js';
import {durationText} from './quantity.js';
import {analyze} from './change-analysis.js';
export const kinds = {held: 'held', queue: 'the queue', earlier: 'an earlier batch', airlock: 'Airlock', wait: 'waiting for a machine', run: 'the work', parent: 'the batch below', merge: 'merging', unknown: 'not recorded'};
export const between = (a, b) => a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
/** A change's times are Airlock's, in New York: `3:04:50 PM`. */
export const changeTime = at => at ? timeText(at, {timeZone: 'America/New_York', seconds: true}) : '–';
export function changeOf(record) {
  const a = analyze(record), s = a.setBy, job = s ? a.jobs[s.job] : null;
  const wait = j => (j?.waits ?? []).filter(w => w.cause !== 'handoff').reduce((n, w) => n + (between(w.from, w.to ?? j.started) ?? 0), 0);
  const waited = s && !s.cached && wait(job) > s.seconds;
  const verdict = !a.structured ? 'Journal only' : !s ? 'No checks recorded' : s.cached ? 'Answered from the cache' : waited ? `The wait for ${s.worker} ${a.endedAt ? 'set' : 'sets'} the finish` : 'The work set the finish';
  const final = a.batches.find(b => b.id === a.batch) ?? a.batches.at(-1), k = a.byKind;
  const figures = [ ['Took', a.seconds, `${changeTime(a.queuedAt)} to ${changeTime(a.endedAt)} ET`], ['The work', a.structured ? k.run : null, s ? `${s.check} on ${s.worker}` : 'not recorded'], ['Machine waits', a.structured ? k.wait : null, Object.entries(a.waits).map(([c,v]) => `${c} ${durationText(v)}`).join(', ') || 'none'], ['Queue and Airlock', a.structured ? k.queue + k.held + k.earlier + k.airlock + k.parent + k.merge : null, k.unknown >= 1 ? `${durationText(k.unknown)} not recorded` : 'every second recorded'] ];
  const rows = [{name: 'This change', sub: 'critical path', segments: a.path}];
  for (const b of a.batches) for (const id of [b.select?.job, ...b.checks.map(c => c.job)].filter(x => x != null)) {
    const j = a.jobs[id]; if (!j || j.missing) continue;
    rows.push({name: id === b.select?.job ? 'select' : b.checks.find(c => c.job === id)?.name ?? j.label, sub: `batch ${b.id} · ${j.worker ?? ''} · job ${id}`, segments: [...j.waits.map(w => ({from: w.from, to: w.to ?? j.started, kind: w.cause === 'handoff' ? 'airlock' : 'wait', detail: w.cause})), ...(j.started ? [{from: j.started, to: j.finished ?? a.endedAt, kind: j.cachedFrom ? 'merge' : j.state === 'failed' ? 'earlier' : 'run', detail: j.state, steps: j.steps}] : [])]});
  }
  return {a, s, job, waited, verdict, final, figures, rows, wait};
}

/** Selection explanations use only the recorded files, with Tower's five-file cap. */
export function selectionOf(select) {
  if (!select) return null;
  return {
    label: select.kind === 'every' ? 'Everything' : select.kind ?? '–',
    tests: select.tests ?? 0,
    verify: select.verify ?? [],
    reason: select.reason,
    causes: Object.entries(select.why?.verify ?? {}).map(([name, value]) => {
      const files = Array.isArray(value) ? value : [];
      return {name, files: files.slice(0, 5), more: Math.max(0, files.length - 5)};
    }),
    paths: Object.keys(select.why?.tests ?? {}).length,
  };
}
