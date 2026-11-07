import { APP_CONFIG } from './app.js';

/** Hard ceiling for how deep into the public "New" tab the collector may ever read. */
export const MIN_LISTING_PAGES = 1;
export const MAX_LISTING_PAGES = 6;
/** Largest list of post IDs one scan can handle (pages x cards per page). */
export const MAX_LISTED_POSTS = MAX_LISTING_PAGES * APP_CONFIG.scan.maxPostsPerPage;

export function isValidListingPage(value) {
  return Number.isInteger(value) && value >= MIN_LISTING_PAGES && value <= MAX_LISTING_PAGES;
}

/**
 * How many "New" pages each scan reads. Default: APP_CONFIG (4). Override with
 * the SCAN_LISTING_PAGES repository variable (a whole number from 1 to 6).
 */
export function resolveListingPages(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return APP_CONFIG.scan.maxListingPages;
  const pages = Number(text);
  if (!isValidListingPage(pages)) {
    throw new RangeError(`SCAN_LISTING_PAGES must be a whole number from ${MIN_LISTING_PAGES} to ${MAX_LISTING_PAGES}.`);
  }
  return pages;
}
