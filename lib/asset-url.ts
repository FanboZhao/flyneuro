// Resolve assets from the app directory, including personal-site subpaths.
// Called only by client effects, so the Sites server build stays compatible.
export function assetUrl(path: string) {
  return new URL(path.replace(/^\/+/, ""), document.baseURI).href
}
