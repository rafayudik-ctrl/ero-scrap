import { createHash } from 'node:crypto';
import { normalizeText, normalizeTag } from '../../domain/src/normalization.js';

const EROME_ORIGIN = 'https://www.erome.com';
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

export function normalizeAlbumUrl(input) {
  let url;
  try {
    url = new URL(input, EROME_ORIGIN);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== 'www.erome.com'
    || url.username || url.password || url.port) return null;
  const match = url.pathname.match(/^\/a\/([A-Za-z0-9_-]{4,64})\/?$/u);
  if (!match) return null;

  return {
    id: match[1],
    canonicalUrl: `${EROME_ORIGIN}/a/${match[1]}`,
  };
}

export function normalizeTagList(tags) {
  if (!Array.isArray(tags)) return [];
  const unique = new Map();
  for (const raw of tags) {
    const name = String(raw ?? '').trim().replace(/^#+/u, '').slice(0, 80);
    const normalized = normalizeTag(name);
    if (normalized && !unique.has(normalized)) unique.set(normalized, name);
  }
  return [...unique.entries()].slice(0, 40).map(([normalizedName, name]) => ({
    name,
    normalizedName,
  }));
}

export function classifyMediaUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return 'unsupported';
  }

  if (url.protocol !== 'https:' || !/(^|\.)erome\.com$/iu.test(url.hostname)) {
    return 'unsupported';
  }

  const extension = url.pathname.split('.').at(-1)?.toLowerCase() ?? '';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'unsupported';
}

export function getStableMediaId({ explicitId, mediaUrl, postId }) {
  const explicit = String(explicitId ?? '').trim();
  if (/^[A-Za-z0-9_-]{4,128}$/u.test(explicit)) return explicit;

  if (mediaUrl) {
    try {
      const url = new URL(mediaUrl);
      const filename = url.pathname.split('/').at(-1) ?? '';
      const stem = filename.replace(/\.[a-z\d]{2,5}$/iu, '');
      if (/^[A-Za-z0-9_-]{4,128}$/u.test(stem)) return stem;
      const stablePath = `${url.hostname}${url.pathname}`;
      return createHash('sha256').update(stablePath).digest('hex').slice(0, 32);
    } catch {
      // Fall through to a deterministic unknown identifier.
    }
  }

  return createHash('sha256').update(`${postId}:unknown-media`).digest('hex').slice(0, 32);
}

export function normalizePostTitle(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300);
}

export function getNormalizedTitle(value) {
  return normalizeText(normalizePostTitle(value));
}

export function getVideoExtensionSet() {
  return new Set(VIDEO_EXTENSIONS);
}
