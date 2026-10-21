/* Model Observatory — theme control.
 * The site ships with a dark palette and a light palette defined as CSS custom
 * properties. This module owns switching between them and remembering the
 * choice. Colours themselves live in style.css, never in JavaScript.
 */
window.MO = window.MO || {};

MO.theme = (() => {
  'use strict';

  const STORAGE_KEY = 'mo-theme';
  const THEMES = ['dark', 'light'];

  function readStored() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return THEMES.includes(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function store(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* private mode: the theme still applies for this session */
    }
  }

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function apply(theme) {
    const value = THEMES.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', value);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'light' ? '#f4f6fb' : '#090f1b');
    const button = document.getElementById('themeToggle');
    if (button) {
      button.textContent = value === 'light' ? '☾' : '☀';
      button.setAttribute('aria-label', value === 'light' ? '切换到深色主题' : '切换到浅色主题');
      button.title = value === 'light' ? '切换到深色主题' : '切换到浅色主题';
    }
    return value;
  }

  function toggle() {
    const next = current() === 'light' ? 'dark' : 'light';
    apply(next);
    store(next);
    return next;
  }

  /** Apply the stored or system preference before the first paint. */
  function init() {
    apply(readStored() || systemTheme());
    const button = document.getElementById('themeToggle');
    if (button) button.addEventListener('click', toggle);
    // Follow the system setting only while the user has not chosen explicitly.
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: light)');
      const listener = event => {
        if (!readStored()) apply(event.matches ? 'light' : 'dark');
      };
      if (query.addEventListener) query.addEventListener('change', listener);
      else if (query.addListener) query.addListener(listener);
    }
  }

  return { init, apply, toggle, current };
})();
