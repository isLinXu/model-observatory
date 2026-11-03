/* Model Observatory — the single write path to GitHub.
 *
 * Three boards can write back to this repository (模版库, 实体注册表 and the
 * upcoming 任务看板), and all of them need the same four things: a token that
 * never leaves the tab, the Contents API, and a baseline that makes a push
 * refuse to overwrite somebody else's edit. Duplicating that per board is how
 * one of them ends up sending a credential somewhere it should not.
 *
 * Rules this module owns:
 *
 *   1. The token lives in sessionStorage only - it dies with the tab, is never
 *      written to any JSON payload, and is sent exclusively to api.github.com.
 *      This site is static: there is no backend to proxy through.
 *   2. Every request goes to `API + path` with a path that starts with `/`, so
 *      no caller can turn this into an arbitrary fetch.
 *   3. A push carries the blob SHA the draft was taken from. If the remote file
 *      no longer has that SHA, the push is refused with `error.conflict` set -
 *      never a silent overwrite.
 *   4. Without a token everything else on the page still works: browsing,
 *      copying, exporting and saving local drafts. Only the write is disabled,
 *      and `requireToken` says which of the two conditions is missing.
 */
window.MO = window.MO || {};

MO.repo = (() => {
  'use strict';

  const API = 'https://api.github.com';
  const TOKEN_KEY = 'mo.repo.token';
  // The library board used to own the token store; a token typed before this
  // module existed is still in this tab, so read it once and move it.
  const LEGACY_TOKEN_KEYS = ['mo.templates.token'];

  // --- Guarded browser storage --------------------------------------------
  // Private modes can throw on any access; a board must stay readable then.

  function readLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function clearLocal(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      /* nothing to clean up */
    }
  }

  function readSession(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch (error) {
      return '';
    }
  }

  function writeSession(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (error) {
      /* The token stays in memory for this page load. */
    }
  }

  function clearSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      /* nothing to clean up */
    }
  }

  // --- Token ---------------------------------------------------------------

  // Which repository to write to, and the credential for it. `token` is only
  // ever a copy of what sessionStorage holds.
  const state = { owner: 'isLinXu', name: 'model-observatory', branch: 'main', token: '' };

  function token() {
    const saved = readSession(TOKEN_KEY);
    if (saved) return saved;
    for (const key of LEGACY_TOKEN_KEYS) {
      const legacy = readSession(key) || readLocal(key, '');
      if (legacy) {
        writeSession(TOKEN_KEY, legacy);
        clearSession(key);
        clearLocal(key);
        return legacy;
      }
    }
    return '';
  }

  function setToken(value) {
    const clean = String(value || '').trim();
    if (clean) writeSession(TOKEN_KEY, clean);
    else clearSession(TOKEN_KEY);
    // The in-memory copy is what every request is signed with, so it moves with
    // the store: a panel that verifies right after typing must not read a stale ''.
    state.token = clean;
    return clean;
  }

  function clearToken() {
    clearSession(TOKEN_KEY);
    LEGACY_TOKEN_KEYS.forEach(key => { clearSession(key); clearLocal(key); });
    state.token = '';
  }

  function requireToken() {
    if (!state.token) throw new Error('请先填写 GitHub Token（仅需 Contents 读写权限）');
    if (!state.owner || !state.name) throw new Error('仓库信息缺失，无法定位要写入的文件');
  }

  // --- Which repository are we writing to? --------------------------------

  /**
   * Adopt the coordinates a collector published (`source.repo` / `source.branch`)
   * so the page writes back to the same branch it reads its data from.
   */
  function adopt(source) {
    const [owner = '', name = ''] = String(source?.repo || '').split('/');
    if (owner && name) {
      state.owner = owner;
      state.name = name;
    }
    if (source?.branch) state.branch = String(source.branch);
    state.token = token();
    return { owner: state.owner, name: state.name, branch: state.branch };
  }

  function coordinates() {
    return { owner: state.owner, name: state.name, branch: state.branch, token: state.token };
  }

  // --- Base64 --------------------------------------------------------------
  // btoa alone throws on any non-Latin-1 character, and these files are Chinese.

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(String(value || '').replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  // --- Contents API --------------------------------------------------------

  function headers(extra) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...extra
    };
  }

  function url(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('GitHub 请求路径必须以 / 开头');
    }
    // A fetch collapses `..` before the origin ever sees the intent, so a path
    // that escapes its folder would turn this single write path into any URL.
    if (path.split('/').includes('..')) throw new Error('GitHub 请求路径不能跳出所在目录');
    return `${API}${path}`;
  }

  /** `entities/a b.md` -> `entities/a%20b.md`, so a name cannot escape its folder. */
  function encodePath(path) {
    return String(path).split('/').map(part => encodeURIComponent(part)).join('/');
  }

  function contentsPath(path) {
    return `/repos/${state.owner}/${state.name}/contents/${encodePath(path)}`;
  }

  async function apiGet(path) {
    const response = await fetch(url(path), { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  }

  /**
   * The current file, its blob SHA, and the commit that last touched it.
   * Returns `{ exists: false }` for a file that is simply not there yet.
   */
  async function readFile(path) {
    const file = await apiGet(contentsPath(path));
    if (!file || typeof file.content !== 'string') return { exists: false, sha: null, text: '', last: null };
    return {
      exists: true,
      sha: file.sha,
      text: fromBase64(file.content),
      last: file.last_commit ? { date: file.last_commit.committer?.date, message: file.last_commit.message } : null
    };
  }

  /**
   * Write one file. `baseline` is the blob SHA the draft was composed from:
   * when the remote no longer matches it, somebody edited the file after us and
   * the push is refused rather than silently winning. `force` is the explicit
   * human decision to overwrite anyway.
   *
   * `baseline === null` means "this draft is for a file that did not exist". If
   * the remote has one now, that premise is gone - creating would overwrite
   * whoever put it there, so it is refused with the same conflict shape instead
   * of quietly winning the race.
   */
  async function pushFile({ path, content, message, baseline = null, force = false }) {
    requireToken();
    const live = await apiGet(contentsPath(path));
    const sha = live ? live.sha : null;
    const differs = sha !== null && (baseline === null ? true : sha !== baseline);
    if (differs && !force) {
      const error = new Error(baseline === null
        ? '远端已经存在这个文件，而草稿是按「文件还不存在」写的，推送已挡下'
        : '远端文件在草稿建立之后被修改过，推送已挡下');
      error.conflict = true;
      error.created = baseline === null;
      error.remoteSha = sha;
      error.remoteText = typeof live.content === 'string' ? fromBase64(live.content) : '';
      throw error;
    }
    const response = await fetch(url(contentsPath(path)), {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message, content: toBase64(content), branch: state.branch,
        ...(sha ? { sha } : {})
      })
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      // GitHub's own sentence is safe to show; headers, tokens and URLs are not.
      throw new Error(String(detail.message || `GitHub API ${response.status}`).slice(0, 200));
    }
    return response.json();
  }

  /** `GET /user` - the cheapest way to say "this token works" before a push. */
  function verifyToken() {
    requireToken();
    return apiGet('/user');
  }

  return {
    API, TOKEN_KEY, state,
    readLocal, writeLocal, clearLocal, readSession, writeSession, clearSession,
    token, setToken, clearToken, requireToken, adopt, coordinates,
    toBase64, fromBase64, encodePath, contentsPath, apiGet,
    readFile, pushFile, verifyToken
  };
})();
