// Path globs shared by secret_globs (SR-4) and verify.test_paths (§6.3).
// '*' and '?' stay within one segment, '**' crosses segments; matching ignores case.

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * True when a relative path matches any glob. A glob without '/' matches any path
 * segment; a glob with '/' matches the whole path (a trailing '/' means '/**').
 */
export function matchesAnyGlob(p, globs) {
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  for (const g of Array.isArray(globs) ? globs : []) {
    if (typeof g !== 'string' || !g) continue;
    const pattern = g.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '/**');
    const re = globToRegExp(pattern);
    if (pattern.includes('/') ? re.test(norm) : parts.some((seg) => re.test(seg))) return true;
  }
  return false;
}

// A project-relative path the feature's tests live in (verify.test_paths).
export const isTestPath = (p, testPaths) => matchesAnyGlob(p, testPaths);

const DEFAULT_SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /\.p12$/i];

/**
 * True when a repo-relative path must not reach a model prompt (SR-4).
 * Default patterns apply to every path segment (a `.env.d/` directory hides its files);
 * a secret_glob without '/' matches any segment, with '/' the whole path.
 */
export function isSecretPath(p, secretGlobs = []) {
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.some((seg) => DEFAULT_SECRET.some((re) => re.test(seg)))) return true;
  return matchesAnyGlob(norm, secretGlobs);
}
