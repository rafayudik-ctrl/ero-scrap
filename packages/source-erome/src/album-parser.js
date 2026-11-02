import { extractElements, getAttribute, parseAttributes } from './html.js';
import {
  classifyMediaUrl,
  getStableMediaId,
  normalizeAlbumUrl,
  normalizePostTitle,
  normalizeTagList,
} from './normalizers.js';

function parseDurationValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = Math.round(value * 1000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }

  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (/^\d+(?:\.\d+)?$/u.test(normalized)) {
    const milliseconds = Math.round(Number(normalized) * 1000);
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
  }

  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part))) {
    return null;
  }

  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  const milliseconds = Math.round(seconds * 1000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function parseDurationMs(attributes) {
  const milliseconds = getAttribute(attributes, 'data-duration-ms', 'duration-ms');
  if (milliseconds !== null && /^\d+$/u.test(milliseconds)) {
    const value = Number(milliseconds);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }

  const direct = parseDurationValue(getAttribute(attributes, 'data-duration', 'duration', 'data-length'));
  if (direct !== null) return direct;

  // Some HTML5 player configurations serialize optional metadata in data-setup.
  // Only explicit duration fields are accepted; duration is never inferred.
  const setupText = getAttribute(attributes, 'data-setup');
  if (setupText) {
    try {
      const setup = JSON.parse(setupText);
      for (const key of ['durationMs', 'duration_ms']) {
        const value = setup?.[key];
        if (Number.isSafeInteger(value) && value > 0) return value;
      }
      for (const key of ['duration', 'videoDuration', 'video_duration']) {
        const value = parseDurationValue(setup?.[key]);
        if (value !== null) return value;
      }
    } catch {
      // Malformed player metadata is treated as unknown, never guessed.
    }
  }

  return null;
}

function getMediaUrl(attributes) {
  return getAttribute(attributes, 'src', 'data-src', 'data-video-src', 'data-original');
}

function getMediaElements(html, postId) {
  const videos = [];
  const seen = new Set();

  const addVideo = (videoAttributes, sourceAttributes = Object.create(null)) => {
    const attributes = { ...videoAttributes, ...sourceAttributes };
    const mediaUrl = getMediaUrl(sourceAttributes) ?? getMediaUrl(videoAttributes);
    if (!mediaUrl || classifyMediaUrl(mediaUrl) !== 'video') return;

    // Do not trust generic DOM `id` attributes: player libraries often reuse them.
    const normalizedMediaUrl = new URL(mediaUrl).toString();
    const sourceVideoId = getStableMediaId({
      explicitId: getAttribute(sourceAttributes, 'data-media-id', 'data-id')
        ?? getAttribute(videoAttributes, 'data-media-id', 'data-id'),
      mediaUrl: normalizedMediaUrl,
      postId,
    });
    if (seen.has(sourceVideoId)) return;
    seen.add(sourceVideoId);

    videos.push({
      sourceVideoId,
      // Transient public URL: the API sanitizer deliberately drops this field
      // before any metadata is persisted to D1.
      mediaUrl: normalizedMediaUrl,
      durationMs: parseDurationMs(videoAttributes) ?? parseDurationMs(attributes),
    });
  };

  for (const video of extractElements(html, 'video')) {
    const sources = extractElements(video.innerHtml, 'source');
    if (sources.length === 0) {
      addVideo(video.attributes);
      continue;
    }

    // A single HTML5 <video> may list multiple quality/codec alternatives.
    // They represent one logical asset: keep only the first supported source.
    for (const source of sources) {
      const mediaUrl = getMediaUrl(source.attributes);
      if (mediaUrl && classifyMediaUrl(mediaUrl) === 'video') {
        addVideo(video.attributes, source.attributes);
        break;
      }
    }
  }

  return videos;
}

function extractDurationLabels(html) {
  const tags = ['span', 'div', 'small', 'time', 'p', 'strong', 'b', 'label'];
  const labels = [];

  for (const tagName of tags) {
    for (const element of extractElements(html, tagName)) {
      const classNames = (getAttribute(element.attributes, 'class') ?? '').split(/\s+/u);
      if (!classNames.includes('duration')) continue;
      const durationMs = parseDurationValue(element.text);
      if (durationMs !== null) labels.push({ index: element.index, durationMs });
    }
  }

  return labels
    .sort((left, right) => left.index - right.index)
    .map((item) => item.durationMs);
}

function extractTags(html) {
  const tags = [];
  for (const anchor of extractElements(html, 'a')) {
    const href = getAttribute(anchor.attributes, 'href') ?? '';
    const className = getAttribute(anchor.attributes, 'class') ?? '';
    const tagClasses = className.split(/\s+/u).some((name) => /^tag(?:-|$)/iu.test(name));
    const looksLikeTag = /\/tags?\//iu.test(href) || tagClasses
      || getAttribute(anchor.attributes, 'data-tag') !== null
      || anchor.text.trim().startsWith('#');
    if (!looksLikeTag) continue;
    const tag = getAttribute(anchor.attributes, 'data-tag') ?? anchor.text;
    if (tag) tags.push(tag);
  }

  for (const meta of extractElements(html, 'meta')) {
    const name = (getAttribute(meta.attributes, 'name', 'property') ?? '').toLowerCase();
    if (name === 'keywords' || name === 'article:tag') {
      const content = getAttribute(meta.attributes, 'content') ?? '';
      tags.push(...content.split(/[,;|]/u));
    }
  }

  // Some templates attach the tag value to non-anchor elements.
  for (const match of html.matchAll(/<[a-z][^>]*\bdata-tag\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/giu)) {
    const attributes = parseAttributes(match[0].slice(1, match[0].indexOf('>')));
    const dataTag = getAttribute(attributes, 'data-tag');
    if (dataTag) tags.push(dataTag);
  }

  return normalizeTagList(tags);
}

function extractAlbumTitle(html) {
  const heading = extractElements(html, 'h1')[0]?.text;
  if (heading) return normalizePostTitle(heading);
  const title = extractElements(html, 'title')[0]?.text ?? '';
  return normalizePostTitle(title.replace(/\s*[-|–].*$/u, ''));
}

export function parseAlbumPage(html, albumUrl, { inspectedAt = new Date().toISOString() } = {}) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new TypeError('Album HTML must be a non-empty string.');
  }
  const album = normalizeAlbumUrl(albumUrl);
  if (!album) throw new TypeError('Album URL is not a canonical Erome album URL.');

  const title = extractAlbumTitle(html);
  const tags = extractTags(html);
  let videos = getMediaElements(html, album.id);

  // Erome album templates may expose one `.duration` label per media group.
  // Associate by document order only when cardinality matches exactly; when
  // labels are missing/ambiguous, keep duration unknown rather than guessing.
  if (videos.length > 0 && videos.some((video) => video.durationMs === null)) {
    const durationLabels = extractDurationLabels(html);
    if (durationLabels.length === videos.length) {
      videos = videos.map((video, index) => ({
        ...video,
        durationMs: video.durationMs ?? durationLabels[index],
      }));
    }
  }

  const images = extractElements(html, 'img');

  return {
    postId: album.id,
    title,
    tags,
    videos,
    imageCount: images.length,
    mediaCount: videos.length + images.length,
    inspectedAt,
  };
}
