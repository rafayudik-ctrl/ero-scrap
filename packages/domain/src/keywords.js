import { normalizeText, normalizeTag } from './normalization.js';

/**
 * The Ero-Scrap rule is deliberately singular: one configured phrase, matched
 * against the post title OR any tag. The phrase itself is loaded from the
 * operator-controlled config/search-keyword.txt file by the runner.
 */
export function matchesSingleKeyword({ title, tags = [], keyword }) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return false;

  const normalizedTitle = normalizeText(title);
  if (normalizedTitle.includes(normalizedKeyword)) return true;

  return tags.some((tag) => normalizeTag(tag).includes(normalizedKeyword));
}

/** Backward-compatible helper for Stage 1 callers; Stage 2 uses one term. */
export function matchesKeywordRules({ title, tags = [], terms = [] }) {
  return terms.some((term) => matchesSingleKeyword({ title, tags, keyword: term }));
}
