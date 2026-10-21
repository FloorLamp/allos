import {memberCan} from './host/member.js';
import {resourcePath} from './host/host.js';
// A person's face (contract/people.md *Faces*): the Immich face whose latest photo is their portrait. Bridge's faces and suggestions,
// linking one (moving it from someone else when asked), unlinking it, and saying a suggestion is not them; what changed, for every
// page at once: each link's portrait version (view/avatar.js asks `?v=`) and the person's new `photo` and `face` (`withFace`). No DOM.

const versions = new Map(), changes = new Map(), listeners = new Set();

/** `listener({id, photo, face})` after any link or unlink on this page. */
export function subscribeFaces(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The person's portrait version on this page: 0 until a link or unlink, then one more each time (the same photo path, a new face). */
export const portraitVersion = id => versions.get(String(id)) ?? 0;

function changed(id, person = {}) {
  id = String(id);
  const change = {id, photo: personPhotoOf(id, person.photo), face: faceOf(person)};
  versions.set(id, portraitVersion(id) + 1);
  changes.set(id, change);
  for (const listener of [...listeners]) listener(change);
  return change;
}

/** `person` as this page last changed it (a link or unlink since bridge's answer): its `photo` and `face` replaced; else as given. */
export function withFace(person) {
  const change = person?.id != null ? changes.get(String(person.id)) : null;
  return change ? {...person, photo: change.photo, face: change.face} : person;
}

/** Forget this page's changes (tests). */
export function resetFaces() { versions.clear(); changes.clear(); }

const personPhotoOf = (id, photo) => {
  const path = `/v1/people/${encodeURIComponent(id)}/photo`;
  return String(photo ?? '').replace(/^\/api\//, '/v1/') === path ? path : null;
};

/** The view's `face`: `{id, name, by, rule, label}`, or null (none linked, or not said). */
export function faceOf(person) {
  const face = person?.face;
  if (!face || typeof face !== 'object' || face.id == null) return null;
  return {id: String(face.id), name: face.name || null, by: ['rule', 'owner', 'kinfolk'].includes(face.by) ? face.by : null,
    rule: face.rule ?? null, label: face.by === 'rule' ? face.label || 'by rule' : null};
}

/** How the face came to be theirs, as a merge says it (people-duplicates.js `mergeHow`): by rule its label, from the family tree, or
 *  by a person (the owner or a member: bridge does not say which); null when bridge does not say. */
export const faceHow = face => !face?.by ? null : face.by === 'rule' ? `Linked automatically: ${face.label}`
  : face.by === 'kinfolk' ? 'Linked from the family tree' : 'Linked by hand';

/** May this page link faces? A member's web session that may write (never a device, nor the read-only agent member). */
export const canLinkFaces = host => host?.kind === 'web' && memberCan(host.member, 'write');

/** One face as the picker shows it: its thumbnail (a resource path, else null), name (null: unnamed), photo count, Immich page, whom
 *  it is linked to. */
export function faceTile(face) {
  const thumbnail = String(face?.thumbnail ?? '').replace(/^\/api\//, '/v1/');
  return {id: String(face.id), name: face.name || null, photos: Number.isFinite(face.photos) ? face.photos : null,
    thumbnail: resourcePath(thumbnail) ? thumbnail : null, immich: typeof face.immich === 'string' ? face.immich : null,
    person: face.person?.id != null ? {id: String(face.person.id), name: face.person.name || 'someone else'} : null};
}

/** A page of faces (40; `q` named faces by their words; `cursor` the next page): `{faces, next, total}`. */
export async function readFaces(host, {q = '', cursor = null} = {}, {signal} = {}) {
  const args = {...(q.trim() ? {q: q.trim()} : {}), ...(cursor ? {cursor} : {})};
  const answer = await host.call('bridge.faces', args, {signal});
  return {faces: (answer?.faces ?? []).filter(f => f?.id != null).map(faceTile), next: answer?.next ?? null, total: answer?.total ?? null};
}

/** The faces bridge thinks are this person's, best first: `[{face, why}]`. */
export async function faceSuggestions(host, id, {signal} = {}) {
  const answer = await host.call('bridge.faceSuggestions', {id: String(id)}, {signal});
  return (answer?.suggestions ?? []).filter(s => s?.face?.id != null).map(s => ({face: faceTile(s.face), why: s.why || null}));
}

/** Link `face` (its Immich id) to the person; `move`: take it from whoever has it. A 409 (someone else's) throws with `holder`. */
export async function linkFace(host, id, face, {move = false} = {}) {
  const answer = await host.call('bridge.faceLink', {id: String(id), immich: String(face), ...(move ? {move: true} : {})});
  return changed(id, answer?.person ?? {photo: `/v1/people/${encodeURIComponent(id)}/photo`, face: {id: face}});
}

/** Unlink the person's face (bridge records it not theirs): no portrait. */
export async function unlinkFace(host, id) {
  await host.call('bridge.faceUnlink', {id: String(id)});
  return changed(id, {photo: null, face: null});
}

/** That suggestion is not them: it never comes back. */
export const notTheirFace = (host, id, face) => host.call('bridge.faceNotIt', {id: String(id), immich: String(face)});
