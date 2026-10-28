import { html, type SafeHtml } from './html.js';

export function fmtDate(isoStr: string | null | undefined): string {
  if (!isoStr) return '—';
  return isoStr.replace('T', ' ').slice(0, 16) + ' UTC';
}

/** A <time> element showing relative time, with the exact UTC timestamp on hover. */
export function timeEl(isoStr: string | null | undefined, now = Date.now()): SafeHtml {
  if (!isoStr) return html`<span class="muted">—</span>`;
  return html`<time datetime="${isoStr}" title="${fmtDate(isoStr)}">${relative(isoStr, now)}</time>`;
}

export function relative(isoStr: string, now = Date.now()): string {
  const diff = (now - Date.parse(isoStr)) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const unit =
    s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v * 100)}`;
}

export function duration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
