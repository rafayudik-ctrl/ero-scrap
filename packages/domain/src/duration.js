import { APP_CONFIG } from '../../config/src/app.js';

export const DURATION_STATUS = Object.freeze({
  ACCEPTED: 'accepted',
  TOO_LONG: 'too_long',
  UNKNOWN: 'duration_unknown',
  INVALID: 'invalid_duration',
});

/**
 * Duration checks operate on integer milliseconds; null/undefined is unknown.
 * Unknown values are never accepted by fail-closed design.
 */
export function evaluateDuration(durationMs, maxDurationMs = APP_CONFIG.media.maxDurationMs) {
  if (durationMs === null || durationMs === undefined) {
    return DURATION_STATUS.UNKNOWN;
  }

  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    return DURATION_STATUS.INVALID;
  }

  return durationMs <= maxDurationMs
    ? DURATION_STATUS.ACCEPTED
    : DURATION_STATUS.TOO_LONG;
}

/** Only video candidates can enter the pipeline; all image candidates stop here. */
export function classifyMediaCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return 'invalid';
  if (candidate.type === 'image') return 'ignored_image';
  if (candidate.type !== 'video') return 'unsupported_media';
  return 'video_candidate';
}

/** Keep only video candidates; image-only posts therefore yield an empty list. */
export function selectVideoCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((candidate) => classifyMediaCandidate(candidate) === 'video_candidate');
}
