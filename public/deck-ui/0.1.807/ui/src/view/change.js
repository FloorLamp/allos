import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {changeOf, changeTime, between, kinds, selectionOf} from '../change.js';
import {dateTimeText, plural, sentence} from '../format.js';
import {durationText} from '../quantity.js';
import {StatTiles} from './stat-tiles.js';
import {Failure} from './page-state.js';
const html = htm.bind(h);
const VERDICT = {green: 'ok', red: 'bad', pending: 'warn'}, VERDICT_LABEL = {green: 'Passed', red: 'Failed', pending: 'Running'};
/** A change; `standalone` in its own drawer, whose header already names the PR. */
function Change({record, standalone}) {
  const {a, s, job, waited, verdict, final, figures, rows, wait} = changeOf(record);
  const selection = selectionOf(final?.select);
  const total = Math.max(1, a.seconds ?? 1), pos = at => Math.max(0, Math.min(100, 100 * (between(a.queuedAt, at) ?? 0) / total));
  const segment = p => html`<i class=${`df-change-segment df-change-${p.kind}`} style=${{left: `${pos(p.from)}%`, width: `${Math.max(.2, pos(p.to) - pos(p.from))}%`}} title=${`${kinds[p.kind]}${p.detail ? `: ${p.detail}` : ''} · ${changeTime(p.from)}–${changeTime(p.to)} (${durationText(between(p.from, p.to))})`}>${(p.steps ?? []).filter(st => st.to).map(st => html`<b class="df-change-step" style=${{left: `${100 * (between(p.from, st.to) ?? 0) / Math.max(1, between(p.from, p.to) ?? 1)}%`}} title=${`${st.name} ends ${changeTime(st.to)}`} />`)}</i>`;
  return html`<article class=${`df-change${standalone ? ' standalone' : ''}`} aria-label=${`Change ${a.repo} #${a.pr}`}>
    ${standalone ? html`<h3>${a.title}</h3>` : html`<h3 class="dk-label">Change</h3><h4 class="df-change-title">${a.title}<small>${a.repo} #${a.pr}</small></h4>`}
    <p>${sentence(a.outcome)}${a.endedAt ? ` · ${dateTimeText(a.endedAt, {timeZone: 'America/New_York', zone: true, now: new Date()})}` : ''} · ${a.batch ? `batch ${a.batch} · ` : ''}${a.mergedSha ? html`as <code>${a.mergedSha.slice(0,8)}</code> ` : null} <a href=${`https://github.com/${a.repo}/pull/${a.pr}`}>GitHub</a></p>
    <p class="df-change-verdict">${verdict} <small>${durationText(a.seconds)}</small></p>
    <ul class="df-change-facts">
      ${a.reason ? html`<li>Failed: ${a.reason}</li>` : null}
      ${s ? html`<li>${sentence(`${s.check} on ${s.worker} ${s.cached ? 'cached' : `ran ${durationText(s.seconds)}`}`)}</li>` : null}
      ${s?.behind?.length ? html`<li>${sentence(s.worker)} busy with ${s.behind.map(id => `${final?.checks.find(c => c.job === id)?.name ?? a.jobs[id]?.label} ${id}`).join(', ')}</li>` : null}
      ${waited ? html`<li>Waited ${durationText(wait(job))}${s.waitCost != null ? ` · cost the change ${durationText(s.waitCost)}` : ''}</li>` : null}
      ${s?.longest?.[0] ? html`<li>Longest: ${s.longest[0].name} ${durationText(s.longest[0].seconds)}</li>` : null}
      ${a.agents ? html`<li>Agents wrote ${plural(a.agents.out, 'token')} on ${a.branch} (${Object.entries(a.agents.byAgent).map(([name, n]) => `${name} ${plural(n, 'token')}`).join(' · ')})</li>` : null}
      ${a.structured ? html`<li>${a.busy ? 'Busy queue' : 'Quiet queue'}</li>` : html`<li>Before Airlock recorded its checks</li>`}
    </ul>
    <${StatTiles} label="Change timing" tiles=${figures.map(([label, value, sub]) => ({key: label, label, value: durationText(value), sub}))} />
    ${a.structured ? html`<h4>Where the time went</h4><div class="df-change-track">${a.path.map(segment)}</div>
      <div class="df-change-legend">${Object.entries(kinds).filter(([k]) => a.byKind[k] > 0).map(([k,label]) => html`<span><i class=${`df-change-${k}`} />${label} ${durationText(a.byKind[k])}</span>`)}</div>
      <div class="df-change-lanes">${rows.map(row => html`<div class="df-change-row"><span>${row.name}<small>${row.sub}</small></span><div class="df-change-track">${row.segments.filter(p => p.from && p.to).map(segment)}</div></div>`)}
      <div class="df-change-row df-change-axis" aria-hidden="true"><span></span><div>${[0, .25, .5, .75, 1].map(f => html`<span>${changeTime(new Date(Date.parse(a.queuedAt) + total * f * 1000).toISOString())}</span>`)}</div></div></div>
      <h4>Required work and why</h4>${selection ? html`<div class="df-change-box"><p><b>${selection.label}</b>${selection.tests ? `: ${plural(selection.tests, 'test')}` : ''}${selection.verify.length ? `${selection.tests ? ', ' : ': '}${selection.verify.join(', ')}` : ''}${selection.reason ? ` · ${selection.reason}` : ''}</p>
        ${selection.causes.map(({name, files, more}) => html`<p>${name}${files.length ? ' because of ' : ' · always'}${files.map((f, i) => html`${i ? ', ' : ''}<code>${f}</code>`)}${more ? ` +${more}` : ''}</p>`)}
        ${selection.paths ? html`<p>tests for ${plural(selection.paths, 'changed path')}</p>` : null}</div>` : html`<p>No selection recorded.</p>`}
      <h4>Checks</h4><div class="df-change-table"><table><thead><tr>${['Check','Machine','Waited','Ran','Verdict'].map(x => html`<th>${x}</th>`)}</tr></thead><tbody>${(final?.checks ?? []).map(c => { const j = a.jobs[c.job]; return html`<tr><td>${c.name}<small>Job ${c.job}${c.job === s?.job ? ' · set the finish' : ''}</small></td>${!j || j.missing ? html`<td colspan="4">not kept</td>` : html`<td>${j.worker ?? '–'}</td><td class="df-change-num">${durationText(wait(j))} <small>${[...new Set(j.waits.filter(w => w.cause !== 'handoff').map(w => w.cause))].join(', ')}</small></td><td class="df-change-num">${j.cachedFrom ? `cached job ${j.cachedFrom}` : durationText(between(j.started, j.finished))}</td><td><span class=${`df-verdict ${VERDICT[c.verdict] ?? ''}`}>${VERDICT_LABEL[c.verdict] ?? sentence(c.verdict)}</span> ${c.reason} <small>${j.stepCount ? `${j.stepCount} steps, ${j.reused} reused` : ''}</small></td>`}</tr>`; })}</tbody></table></div>
      ${job?.steps?.length ? html`<h4>Inside ${s.check}</h4>${job.steps.map(st => html`<div class="df-change-row"><span>${st.name} ${st.detail}<small>${durationText(st.seconds)}</small></span><div class="df-change-track"><i class="df-change-segment df-change-run" style=${{width: `${100 * (st.seconds ?? 0) / Math.max(1, ...job.steps.map(x => x.seconds ?? 0))}%`}} /></div></div>`)}` : null}` : null}
    ${a.batches.length > 1 ? html`<h4>Batches</h4><ol class="df-change-box df-change-log">${a.batches.map(b => html`<li><span class="df-change-when">${changeTime(b.formedAt)}</span><span>Batch ${b.id} · ${b.prs.map(n => `#${n}`).join(' ')} · ${b.ended || b.summary || VERDICT_LABEL[b.verdict] || b.verdict || '–'}</span></li>`)}</ol>` : null}
    ${a.journal.length ? html`<h4>Airlock's journal</h4><ol class="df-change-box df-change-log">${a.journal.map(e => html`<li><span class="df-change-when">${changeTime(e.at)}</span><span>${e.text}</span></li>`)}</ol>` : null}
  </article>`;
}
export function Changes({state, host, standalone = false}) {
  return html`<section aria-label="Changes">${state.changesError ? html`<${Failure} backend="flightplan" error=${state.changesError} host=${host} />` : state.changes == null ? html`<p role="status">Loading changes…</p>` : !state.changes.length ? html`<p>No record until it leaves the queue.</p>` : state.changes.map(change => change.records?.[0] ? html`<${Change} record=${change.records[0]} standalone=${standalone} />` : html`<p>${change.repo} #${change.pr}: No record until it leaves the queue.</p>`)}</section>`;
}
