import { APP_CONFIG } from './app.js';

export const MIN_UNOPENED_DAYS = 1;
export const MAX_UNOPENED_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * How many days a video that nobody opened stays stored. Default: APP_CONFIG
 * (4 days). Override with the UNOPENED_RETENTION_DAYS repository variable
 * (a whole number from 1 to 7). The 24 h after the first click is separate.
 */
export function resolveUnopenedDays(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return APP_CONFIG.retention.unopenedDays;
  const days = Number(text);
  if (!Number.isInteger(days) || days < MIN_UNOPENED_DAYS || days > MAX_UNOPENED_DAYS) {
    throw new RangeError(`UNOPENED_RETENTION_DAYS must be a whole number from ${MIN_UNOPENED_DAYS} to ${MAX_UNOPENED_DAYS}.`);
  }
  return days;
}

/** True when expiresAt is a whole number of days (1-7) after uploadedAt. */
export function isValidUnopenedExpiry(uploadedAt, expiresAt) {
  const difference = Date.parse(expiresAt) - Date.parse(uploadedAt);
  return Number.isFinite(difference) && difference % DAY_MS === 0
    && difference >= MIN_UNOPENED_DAYS * DAY_MS && difference <= MAX_UNOPENED_DAYS * DAY_MS;
}
