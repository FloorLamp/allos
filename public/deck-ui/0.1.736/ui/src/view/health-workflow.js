import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Button, Field} from './controls.js';
import {PageState} from './page-state.js';
import {createHealthWorkflow, healthWorkflows} from '../health-workflow.js';
const html = htm.bind(h);
const types = new Set(['text', 'number', 'date', 'time', 'checkbox']);

function WorkflowForm({item, action, workflow, disabled}) {
  return html`<form onSubmit=${event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget), values = {};
    for (const field of action.fields ?? []) {
      const value = data.get(field.name);
      values[field.name] = field.type === 'checkbox' ? value === 'on' : field.type === 'number' ? (value === '' ? null : Number(value)) : value;
    }
    workflow.apply(item, action.id, values);
  }}><fieldset disabled=${disabled}><legend>${action.label}</legend>
    ${(action.fields ?? []).map(field => field.type === 'select' ? html`<${Field} key=${field.name} as="select" label=${field.label} name=${field.name} required=${field.required} defaultValue=${field.value ?? ''}>
      ${(field.options ?? []).map(option => html`<option key=${option.value} value=${option.value}>${option.label}</option>`)}
    </${Field}>` : html`<${Field} key=${field.name} label=${field.label} hint=${field.hint} name=${field.name} type=${types.has(field.type) ? field.type : 'text'}
      required=${field.required} step=${field.type === 'number' ? 'any' : undefined} defaultChecked=${field.type === 'checkbox' ? field.value === true : undefined}
      defaultValue=${field.type === 'checkbox' ? undefined : field.value ?? ''} />`)}
    <${Button}>${action.label}</${Button}></fieldset></form>`;
}

export function HealthWorkflow({kind, profile, writable, host, onRecord}) {
  const [workflow, setWorkflow] = useState(null), [, redraw] = useState(0), [q, setQ] = useState('');
  useEffect(() => {
    const w = createHealthWorkflow(host);
    const off = w.subscribe(() => redraw(n => n + 1));
    setWorkflow(w); w.load(kind, profile);
    return () => { off(); w.stop(); };
  }, [host, kind, profile]);
  const w = workflow?.kind === kind && workflow?.profile === profile ? workflow : null;
  return html`<section aria-label=${healthWorkflows[kind]} aria-busy=${!w || w.loading}>
    <h2>${healthWorkflows[kind]}</h2>
    <form onSubmit=${event => { event.preventDefault(); w?.load(kind, profile, q); }}>
      <${Field} label="Search" type="search" value=${q} onInput=${event => setQ(event.target.value)} />
      <${Button} disabled=${!w || w.loading || w.busy}>Search</${Button}>
    </form>
    <${PageState} state=${!w || w.loading ? 'loading' : undefined} backend="allos" host=${host} error=${w?.error} retry=${() => w?.load(kind, profile, q)}>
      ${w?.snapshot?.items?.length === 0 ? html`<${PageState} state="empty" hint="No items." />` : null}
      ${(w?.snapshot?.items ?? []).map(item => html`<article key=${`${kind}:${profile}:${item.id}:${item.revision}`}><h3>${item.title}</h3>
        <p>${item.summary}</p>
        ${kind === 'documents' && typeof item.recordKey === 'string' ? html`<${Button} disabled=${w.loading || w.busy} onClick=${() => onRecord?.({key: item.recordKey, title: item.title, profile})}>Open document</${Button}>` : null}
        <dl>${(item.facts ?? []).map(fact => html`<div key=${fact.label}><dt>${fact.label}</dt><dd>${fact.value}</dd></div>`)}</dl>
        ${writable ? (item.actions ?? []).map(action => html`<${WorkflowForm} key=${action.id} item=${item} action=${action} workflow=${w} disabled=${w.loading || w.busy} />`) : null}
      </article>`)}
      ${w?.snapshot?.next ? html`<${Button} disabled=${w.loading || w.busy} onClick=${() => w.load(kind, profile, q, w.snapshot.next)}>Next page</${Button}>` : null}
    <//><p role="status">${w?.status}</p>
  </section>`;
}
