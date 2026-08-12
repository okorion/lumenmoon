function readAttribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match?.[2] ?? null;
}

/** Returns JavaScript declared by the built HTML as an entry or module preload. */
export function collectInitialJavaScriptPaths(html) {
  const paths = new Set();

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    if (readAttribute(tag, "type") !== "module") continue;
    const source = readAttribute(tag, "src");
    if (source) paths.add(normalizeLocalAssetPath(source));
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const relations = readAttribute(tag, "rel")?.toLowerCase().split(/\s+/);
    if (!relations?.includes("modulepreload")) continue;
    const source = readAttribute(tag, "href");
    if (source) paths.add(normalizeLocalAssetPath(source));
  }

  return [...paths];
}

function normalizeLocalAssetPath(source) {
  if (/^(?:[a-z]+:)?\/\//i.test(source)) {
    throw new Error(`Initial JavaScript must be a local asset: ${source}`);
  }
  const path = source.split(/[?#]/, 1)[0]?.replace(/^\.?\//, "");
  if (!path?.endsWith(".js") || path.includes("..")) {
    throw new Error(`Invalid initial JavaScript asset path: ${source}`);
  }
  return path;
}
