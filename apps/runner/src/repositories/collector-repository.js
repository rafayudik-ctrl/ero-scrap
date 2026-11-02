// Backward-compatible module name for the runner's persistence boundary.
// Actual SQL remains inside the private API Worker repository.
export { CollectorApiClient as CollectorRepository } from '../clients/collector-api-client.js';
