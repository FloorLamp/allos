// The views a page shows only after its first screen (deferred.js): a document's viewer (its frame and kinds) and Details, a recorded
// entity's content, a series' chart, the palette's Flightplan.
export {Viewer} from './viewer/frame.js';
export {CollectionContent} from './viewer/collection-content.js';
export {Chart} from './chart.js';
export {PaletteFlightplan} from './flightplan.js';
export {mountViewer} from '../mounts/viewer.js';
export {mountDetails} from '../mounts/details.js';
