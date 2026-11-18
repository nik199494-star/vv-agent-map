import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../automation/Projection.gs', import.meta.url), 'utf8');
export const project = runInNewContext(source + '\nvvProjection_', Object.create(null));
export const sha256 = text => createHash('sha256').update(text).digest('hex');
