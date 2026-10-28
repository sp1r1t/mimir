import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from '../src/util/url.js';

describe('canonicalizeUrl', () => {
  it('strips tracking parameters, fragments, www, default ports and trailing slashes', () => {
    expect(canonicalizeUrl('http://WWW.Example.com:80/a/b/?utm_source=rss&id=3&fbclid=x#frag')).toBe('https://example.com/a/b?id=3');
  });
  it('sorts remaining query parameters so order does not matter', () => {
    expect(canonicalizeUrl('https://example.com/p?b=2&a=1')).toBe(canonicalizeUrl('https://example.com/p?a=1&b=2'));
  });
  it('keeps meaningful parameters', () => {
    expect(canonicalizeUrl('https://example.com/item?id=42')).toBe('https://example.com/item?id=42');
  });
  it('rejects non-http and invalid URLs', () => {
    expect(canonicalizeUrl('mailto:a@b.c')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
  });
  it('resolves relative links against a base', () => {
    expect(canonicalizeUrl('/x/', 'https://example.com/feed')).toBe('https://example.com/x');
  });
});
