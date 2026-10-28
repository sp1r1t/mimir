/** Query parameters that only carry tracking/campaign information. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'yclid',
  '_hsenc', '_hsmi', 'mkt_tok', 'ref_src', 'ref_url', 'cmpid', 'maca', 'ncid', 'ocid', 'sr_share',
  'spm', 'smid', 'smtyp', 'source', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
]);
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_', 'oly_'];

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Normalize an article URL into a stable deduplication key:
 * lowercase scheme/host, drop default ports, fragments, tracking parameters,
 * `www.` prefix, and trailing slashes; sort remaining query parameters.
 * Returns null for non-http(s) or unparseable URLs.
 */
export function canonicalizeUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.port === '80' || u.port === '443') u.port = '';
  u.hash = '';
  u.username = '';
  u.password = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  u.pathname = path;
  return u.toString();
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
