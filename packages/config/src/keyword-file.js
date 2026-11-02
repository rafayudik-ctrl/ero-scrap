import { readFile } from 'node:fs/promises';

const MAX_KEYWORD_LENGTH = 80;

/**
 * Keyword sources, in order: the SEARCH_KEYWORD secret (so a public repository
 * does not publish what is being monitored), then config/search-keyword.txt.
 * No database or UI setting can change it. Empty means collection is disabled.
 */
export async function loadSearchKeyword(filePath, env = process.env) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('A keyword file path is required.');
  }

  const fromEnv = typeof env?.SEARCH_KEYWORD === 'string' ? env.SEARCH_KEYWORD.replace(/^\uFEFF/, '').trim() : '';
  const contents = fromEnv || await readFile(filePath, 'utf8');
  const keyword = contents.replace(/^\uFEFF/, '').trim();

  if (!keyword) return null;
  if (keyword.includes('\n') || keyword.includes('\r')) {
    throw new Error('search-keyword.txt must contain exactly one line.');
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    throw new Error(`The search keyword must be ${MAX_KEYWORD_LENGTH} characters or fewer.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(keyword)) {
    throw new Error('The search keyword contains unsupported control characters.');
  }

  return keyword;
}
