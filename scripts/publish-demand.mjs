import {readAgentRows, shapePoints} from './agent-data.mjs';
import {schemaVersion, validateSnapshot} from '../source.js';

export function generateDemand(csv, now = new Date(), snapshotId = '') {
  return validateSnapshot({schema: schemaVersion, publishedAt: now.toISOString(),
    ...(snapshotId ? {snapshotId} : {}), ...shapePoints(readAgentRows(csv))});
}
