/* Model Observatory — formatting helpers.
 * Pure functions only: no DOM access, no state. Everything the UI shows goes
 * through here so number formatting stays consistent across every section.
 */
window.MO = window.MO || {};

MO.format = (() => {
  'use strict';

  const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => escapeMap[char]);
  }

  /** Full number with thousands separators. */
  function fmt(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Math.trunc(Number(value)).toLocaleString('en-US');
  }

  /** Compact western notation, used for chart axes where space is tight. */
  function compact(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
  }

  /**
   * Chinese compact notation: 万 / 亿. Used for follower counts so 128,400
   * reads as "12.84万" rather than a wall of digits.
   */
  function countCN(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    const absolute = Math.abs(number);
    if (absolute >= 1e8) return trimZero((number / 1e8).toFixed(2)) + '亿';
    if (absolute >= 1e4) return trimZero((number / 1e4).toFixed(2)) + '万';
    return fmt(number);
  }

  /** Drop a trailing ".00" so "1.00万" becomes "1万". */
  function trimZero(text) {
    return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function signed(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    return `${number > 0 ? '+' : ''}${fmt(number)}`;
  }

  function signedCN(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const number = Number(value);
    return `${number > 0 ? '+' : ''}${countCN(number)}`;
  }

  /** CSS class for positive / negative deltas. */
  function tone(value) {
    if (value == null || !Number.isFinite(Number(value))) return '';
    const number = Number(value);
    if (number < 0) return 'neg';
    if (number > 0) return 'pos';
    return '';
  }

  /** Short axis label, e.g. "10/21". */
  function dayLabel(day) {
    return day ? day.slice(5).replace('-', '/') : '—';
  }

  /** "2026-10-21 08:14" style UTC timestamp. */
  function timestamp(value) {
    if (!value) return '—';
    return String(value).replace('T', ' ').slice(0, 16);
  }

  /** Whole days between an ISO timestamp and now. */
  function ageInDays(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return Math.max(0, (Date.now() - parsed) / 86400000);
  }

  /** Days between now and a deadline; negative once it has passed. */
  function untilDays(value, now = Date.now()) {
    const stamp = typeof value === 'number' ? value : Date.parse(value ?? '');
    return Number.isFinite(stamp) ? (stamp - now) / 86400000 : null;
  }

  /** Countdown wording. Deadlines already gone say so instead of showing 0. */
  function countdown(value, now = Date.now()) {
    const stamp = typeof value === 'number' ? value : Date.parse(value ?? '');
    if (!Number.isFinite(stamp)) return '—';
    const elapsed = Math.abs(stamp - now);
    const hours = Math.floor(elapsed / 3600000);
    const days = Math.floor(hours / 24);
    let text;
    if (hours < 1) text = '不足 1 小时';
    else if (days < 1) text = `${hours} 小时`;
    else if (days < 10) text = `${days} 天 ${hours % 24} 小时`;
    else text = `${days} 天`;
    return `${stamp >= now ? '' : '已过期 '}${text}`;
  }

  /** Urgency bucket used for deadline colours: urgent / soon / past / unknown. */
  function deadlineTone(value, now = Date.now()) {
    const days = untilDays(value, now);
    if (days === null) return 'unknown';
    if (days < 0) return 'past';
    if (days <= 7) return 'urgent';
    if (days <= 30) return 'soon';
    return '';
  }

  /** "UTC+08:00" from a signed offset in minutes. */
  function offsetLabel(minutes) {
    if (!Number.isFinite(minutes)) return '—';
    const absolute = Math.abs(minutes);
    const sign = minutes < 0 ? '-' : '+';
    return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  }

  return {
    esc, fmt, compact, countCN, signed, signedCN, tone, dayLabel, timestamp,
    ageInDays, untilDays, countdown, deadlineTone, offsetLabel, trimZero
  };
})();
