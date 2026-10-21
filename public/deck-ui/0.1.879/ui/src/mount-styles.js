// Required sheets for each mount, including the views it can open.
export const MOUNT_STYLES = {
  'Viewer': ['viewer/viewer', 'palette', 'foundation', 'person-profile'],
  'Palette': ['glance', 'phone-landing', 'viewer/viewer', 'palette', 'chart', 'foundation', 'shell-bar', 'papers', 'things', 'taxes', 'insurance', 'properties', 'vehicles', 'flightplan', 'projects', 'person-profile', 'collection-page'],
  'Rows': ['palette', 'foundation', 'collection-page'],
  'ShellBar': ['shell-bar'],
  'NavTiles': ['shell-bar'],
  'StatTiles': ['foundation'],
  'Drawer': ['foundation'],
  'House': ['palette', 'foundation', 'chart', 'shell-bar', 'house', 'house-wall', 'camera', 'map-view'],
  'HouseRules': ['palette', 'foundation', 'shell-bar', 'house'],
  'HouseShadow': ['palette', 'foundation', 'house'],
  'HouseZigbee': ['palette', 'foundation', 'house'],
  'Zones': ['palette', 'foundation', 'shell-bar', 'zones'],
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
  'Things': ['palette', 'foundation', 'chart', 'viewer/viewer', 'person-profile', 'things', 'collection-page'],
  'Purchases': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'collection-page'],
  'Notes': ['palette', 'foundation', 'collection-page', 'notes'],
  'Texts': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'collection-page', 'texts'],
  'Clusters': ['palette', 'foundation', 'viewer/viewer', 'person-profile', 'clusters', 'collection-page'],
};

// Every document viewer can open a recorded collection entity; its canonical page styles travel with it (a camera's live player, a
// thing's House controls, the charts, runs and maps of a hub, a trip's route: contract/media.md).
const collectionDetails = ['papers', 'things', 'taxes', 'insurance', 'properties', 'vehicles', 'clusters', 'person-profile', 'collection-page', 'camera', 'house', 'chart', 'map-view'];
for (const mount of ['Viewer', 'Palette', 'Rows', 'People', 'Vehicles', 'Properties', 'Insurance', 'Papers', 'Taxes', 'Things', 'Purchases', 'Clusters', 'Texts', 'Health'])
  MOUNT_STYLES[mount] = [...new Set([...MOUNT_STYLES[mount], ...collectionDetails])];

// RowList's optional collection filter shares its search and pager styles.
for (const mount of ['House', 'HouseRules', 'HouseShadow', 'HouseZigbee', 'Zones', 'Accounts', 'Glance', 'Attention', 'Projects', 'Flightplan', 'Todo'])
  MOUNT_STYLES[mount] = [...new Set([...MOUNT_STYLES[mount], 'collection-page'])];
