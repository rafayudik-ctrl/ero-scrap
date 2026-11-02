// Prints `mode=` and `copy_authorized=` lines for $GITHUB_OUTPUT.
// COPY_AUTHORIZED in packages/config/src/security.js is the only gate: with it
// false, `auto` can never resolve to `full` and `full` is refused outright.
import { COPY_AUTHORIZED } from '../packages/config/src/security.js';

const requested = process.env.REQUESTED_MODE || 'auto';
const valid = new Set(['auto', 'metadata', 'full', 'cleanup', 'mega-check']);
if (!valid.has(requested)) throw new Error('Invalid workflow mode.');

const mode = requested === 'auto' ? (COPY_AUTHORIZED === true ? 'full' : 'metadata') : requested;
if (mode === 'full' && COPY_AUTHORIZED !== true) {
  throw new Error('Full processing is blocked: COPY_AUTHORIZED is false.');
}
console.log(`mode=${mode}`);
console.log(`copy_authorized=${COPY_AUTHORIZED === true}`);
