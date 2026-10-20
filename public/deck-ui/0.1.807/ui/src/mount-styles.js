// Required sheets for each mount, including the views it can open.
export const MOUNT_STYLES = {
  'Viewer': ['viewer/viewer', 'palette', 'foundation', 'person-profile'],
  'Details': ['viewer/viewer', 'person-profile', 'palette', 'foundation', 'collection-page'],
  'Palette': ['glance', 'phone-landing', 'viewer/viewer', 'palette', 'chart', 'foundation', 'shell-bar', 'papers', 'things', 'taxes', 'insurance', 'properties', 'vehicles', 'flightplan', 'projects', 'person-profile', 'collection-page'],
  'Rows': ['palette', 'foundation', 'collection-page'],
  'Asks': ['palette', 'foundation', 'projects', 'collection-page'],
  'ShellBar': ['shell-bar'],
  'NavTiles': ['shell-bar'],
  'StatTiles': ['foundation'],
  'Drawer': ['foundation'],
  'House': ['palette', 'foundation', 'chart', 'shell-bar', 'house', 'house-wall'],
  'Accounts': ['palette', 'foundation', 'shell-bar', 'accounts'],
  'Health': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'shell-bar', 'health'],
  'Money': ['palette', 'foundation', 'chart', 'money'],
  'Security': ['palette', 'security'],
  'Glance': ['glance'],
  'Attention': ['palette', 'foundation'],
  'People': ['palette', 'foundation', 'viewer/viewer', 'person-profile'],
  'Projects': ['palette', 'foundation', 'projects'],
  'Flightplan': ['palette', 'foundation', 'shell-bar', 'flightplan'],
  'Todo': ['palette', 'foundation', 'shell-bar', 'flightplan'],
  'Vehicles': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'vehicles', 'collection-page'],
  'Properties': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'properties', 'collection-page'],
  'Insurance': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'insurance', 'collection-page'],
  'Papers': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'papers', 'collection-page'],
  'Taxes': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'taxes', 'collection-page'],
  'Things': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'things', 'collection-page'],
  'Purchases': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'collection-page'],
  'Notes': ['palette', 'foundation', 'collection-page', 'notes'],
  'Texts': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'collection-page', 'texts'],
  'Clusters': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'clusters', 'collection-page'],
};

// Every document viewer can open a recorded collection entity; its canonical page styles travel with it.
const collectionDetails = ['papers', 'things', 'taxes', 'insurance', 'properties', 'vehicles', 'clusters', 'person-profile', 'collection-page'];
for (const mount of ['Viewer', 'Details', 'Palette', 'Rows', 'People', 'Vehicles', 'Properties', 'Insurance', 'Papers', 'Taxes', 'Things', 'Purchases', 'Clusters', 'Texts', 'Health'])
  MOUNT_STYLES[mount] = [...new Set([...MOUNT_STYLES[mount], ...collectionDetails])];

// RowList's optional collection filter shares its search and pager styles.
for (const mount of ['House', 'Accounts', 'Glance', 'Attention', 'Projects', 'Flightplan', 'Todo'])
  MOUNT_STYLES[mount] = [...new Set([...MOUNT_STYLES[mount], 'collection-page'])];
