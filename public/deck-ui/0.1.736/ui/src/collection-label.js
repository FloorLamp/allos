// Readable labels for collection tags; preserve existing capitalization.
export const collectionLabel = value => String(value ?? '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
