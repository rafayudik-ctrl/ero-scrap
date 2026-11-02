import { APP_CONFIG } from '../../config/src/app.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseTimestamp(value, fieldName) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 timestamp.`);
  }
  return Date.parse(value);
}

/**
 * Retention starts after a successful upload. First click is immutable and
 * changes the deadline to 24 hours after that first click.
 */
export function calculateExpiry({ uploadedAt, firstClickedAt = null }) {
  const uploaded = parseTimestamp(uploadedAt, 'uploadedAt');

  if (firstClickedAt !== null) {
    const clicked = parseTimestamp(firstClickedAt, 'firstClickedAt');
    if (clicked < uploaded) {
      throw new RangeError('firstClickedAt cannot be earlier than uploadedAt.');
    }
    return new Date(clicked + APP_CONFIG.retention.afterFirstClickHours * HOUR_MS).toISOString();
  }

  return new Date(uploaded + APP_CONFIG.retention.unopenedDays * DAY_MS).toISOString();
}

export function isExpired(expiresAt, now = new Date()) {
  const expiry = parseTimestamp(expiresAt, 'expiresAt');
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(current)) throw new TypeError('now must be a valid date.');
  return current >= expiry;
}

/** First click wins. Repeated clicks must not extend the retention window. */
export function registerFirstClick({ uploadedAt, firstClickedAt = null, clickedAt }) {
  if (firstClickedAt !== null) {
    return {
      firstClickedAt,
      expiresAt: calculateExpiry({ uploadedAt, firstClickedAt }),
      changed: false,
    };
  }

  const clicked = parseTimestamp(clickedAt, 'clickedAt');
  const uploaded = parseTimestamp(uploadedAt, 'uploadedAt');
  if (clicked < uploaded) throw new RangeError('clickedAt cannot be earlier than uploadedAt.');

  const first = new Date(clicked).toISOString();
  return {
    firstClickedAt: first,
    expiresAt: calculateExpiry({ uploadedAt, firstClickedAt: first }),
    changed: true,
  };
}
