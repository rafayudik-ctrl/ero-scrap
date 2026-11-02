/** Normalize user-controlled text consistently for matching and indexing. */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';

  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

export function normalizeTag(value) {
  return normalizeText(value)
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ');
}
