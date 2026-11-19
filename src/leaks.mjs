/**
 * Words that look like they name something specific: code identifiers, paths, ticket keys, long numbers.
 * Plain prose words never match, so ordinary vocabulary shared by both texts is not flagged.
 */
const SPECIFIC = /[A-Za-z0-9]+(?:[_./:-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}-\d+|\d{4,}/g;

/**
 * Specifics from the raw text that survived into the sanitized text. Empty means none were found;
 * it does not prove the sanitized text is safe, so a person still approves it.
 * @param {string[]} raw @param {string[]} sanitized @returns {string[]}
 */
export function leakedSpecifics(raw, sanitized) {
  const found = new Set(raw.flatMap(text => text.match(SPECIFIC) || []));
  const kept = new Set(sanitized.flatMap(text => text.match(SPECIFIC) || []));
  return [...found].filter(token => kept.has(token)).sort();
}
