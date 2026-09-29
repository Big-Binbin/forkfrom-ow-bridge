export function parseJson(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
