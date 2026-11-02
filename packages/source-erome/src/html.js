const ENTITY_MAP = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  '#39': "'",
});

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

const HTML_TOKEN_PATTERN = /<!--[\s\S]*?-->|<![^>]*>|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?([a-z][a-z0-9:-]*)\b[^>]*>/giu;

export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (match, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) {
      const point = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    if (key.startsWith('#')) {
      const point = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITY_MAP[key] ?? match;
  });
}

export function stripHtml(value) {
  return decodeHtmlEntities(String(value ?? '')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim());
}

export function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '/') continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }

  return attributes;
}

/**
 * Small, dependency-free HTML element extractor for the limited selectors the
 * source adapter needs. It tracks nesting of the requested tag, so nested
 * `.album` cards/divs cannot truncate each other's content as a non-greedy
 * regular expression would. It is not a browser-grade HTML5 parser; malformed
 * markup is rejected conservatively by higher-level parsers.
 */
export function extractElements(html, tagName) {
  const target = String(tagName ?? '').toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/u.test(target)) throw new TypeError('A valid HTML tag name is required.');

  const elements = [];
  const stack = [];
  let match;

  while ((match = HTML_TOKEN_PATTERN.exec(html)) !== null) {
    const token = match[0];
    const actualTag = match[2]?.toLowerCase();
    if (!actualTag || actualTag !== target) continue;

    const isClosing = token.startsWith('</');
    if (isClosing) {
      const opening = stack.pop();
      if (!opening) continue;
      elements.push({
        attributes: opening.attributes,
        innerHtml: html.slice(opening.innerStart, match.index),
        text: stripHtml(html.slice(opening.innerStart, match.index)),
        index: opening.index,
      });
      continue;
    }

    const selfClosingSuffix = token.match(/\/\s*>$|>$/u)?.[0] ?? '>';
    const isExplicitlySelfClosing = selfClosingSuffix.startsWith('/');
    const isSelfClosing = isExplicitlySelfClosing || VOID_TAGS.has(target);
    const attributesSource = token.slice(target.length + 1, token.length - selfClosingSuffix.length);
    const element = {
      attributes: parseAttributes(attributesSource),
      innerHtml: '',
      text: '',
      index: match.index,
    };

    if (isSelfClosing) {
      elements.push(element);
    } else {
      stack.push({ ...element, innerStart: match.index + token.length });
    }
  }

  return elements.sort((left, right) => left.index - right.index);
}

export function getAttribute(attributes, ...names) {
  for (const name of names) {
    const value = attributes[name.toLowerCase()];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
