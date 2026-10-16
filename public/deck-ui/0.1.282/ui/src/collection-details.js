import {paperDates} from './properties.js';

// Membership comes from the canonical view; dates come only from its indexed documents.
export async function collectionDetails(host, item, signal) {
  const answer = item.project ? await host.call('bridge.project', {id: item.project.id}, {signal}) : await host.call('bridge.pages', {id: (item.document ?? item.result.document).id}, {signal});
  const entity = answer.project ?? answer.person;
  const documents = [...new Map((answer.documents ?? entity?.documents ?? [...(entity?.conversations ?? []), ...(entity?.mails ?? []), ...(entity?.papers ?? [])]).filter(d => d?.id).map(d => [d.id, d])).values()];
  const papers = await Promise.all(documents.map(async document => {
    try { return {document, ...paperDates(await host.call('bridge.doc', {id: document.id}, {signal}))}; }
    catch { return {document, datesUnavailable: true}; }
  }));
  return {entity, papers};
}
