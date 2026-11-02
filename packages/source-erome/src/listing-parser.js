import { extractElements, getAttribute } from './html.js';
import { normalizeAlbumUrl, normalizePostTitle } from './normalizers.js';

const MAX_POSTS_PER_PAGE = 80;

function hasClass(attributes, expected) {
  const className = getAttribute(attributes, 'class') ?? '';
  return className.split(/\s+/u).includes(expected);
}

/**
 * Parse listing cards individually instead of globally pairing unrelated
 * anchors. This prevents one malformed card from shifting title/URL pairs for
 * every card that follows it.
 */
export function parseNewListing(html, pageNumber) {
  if (pageNumber !== 1 && pageNumber !== 2) {
    throw new RangeError('The Erome collector is restricted to the first two New pages.');
  }
  if (typeof html !== 'string' || html.length === 0) {
    throw new TypeError('Listing HTML must be a non-empty string.');
  }

  const albumsContainer = extractElements(html, 'div')
    .find((element) => getAttribute(element.attributes, 'id') === 'albums');
  if (!albumsContainer) {
    throw Object.assign(new Error('The New page is missing its expected #albums container.'), {
      code: 'parser_listing_container_missing',
    });
  }

  const cards = extractElements(albumsContainer.innerHtml, 'div')
    .filter((element) => hasClass(element.attributes, 'album'));
  if (cards.length === 0) return [];
  if (cards.length > MAX_POSTS_PER_PAGE) {
    throw Object.assign(new Error(`The New page contains more than ${MAX_POSTS_PER_PAGE} album cards.`), {
      code: 'parser_post_limit_exceeded',
    });
  }

  const candidates = new Map();
  for (const card of cards) {
    const anchors = extractElements(card.innerHtml, 'a');
    const albumLink = anchors.find((anchor) => hasClass(anchor.attributes, 'album-link'));
    const albumTitle = anchors.find((anchor) => hasClass(anchor.attributes, 'album-title'));
    if (!albumLink || !albumTitle) continue;

    const href = getAttribute(albumLink.attributes, 'href')
      ?? getAttribute(albumTitle.attributes, 'href');
    const album = normalizeAlbumUrl(href);
    if (!album) continue;

    const title = normalizePostTitle(albumTitle.text);
    if (!title || !/[\p{L}\p{N}]/u.test(title)) continue;

    candidates.set(album.id, {
      ...album,
      title,
      pageNumber,
    });
  }

  return [...candidates.values()];
}
