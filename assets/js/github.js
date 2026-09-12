/* =========================================================================
   github.js — the repo IS the database.

   Reads go through the Git Data API (one recursive tree call gives the whole
   vault); writes go through the Contents API for single files (it gives us
   optimistic-locking via `sha`) and the Git Data API for batches (one commit
   for many files: uploads, moves, bulk deletes).
   ========================================================================= */
(function (global) {
  'use strict';

  const API = 'https://api.github.com';
  const CFG_KEY = 'mpf.config';

  const GH = {
    cfg: { owner: '', repo: '', branch: 'main', root: 'vault', token: '' },
    rate: null,

    /** Requests currently in flight, and a hook the UI uses to show progress. */
    inFlight: 0,
    onActivity: null,

    /* ------------------------------------------------------------ config */
    loadConfig() {
      let raw = null;
      try { raw = localStorage.getItem(CFG_KEY) || sessionStorage.getItem(CFG_KEY); } catch (_) {}
      if (!raw) return false;
      try {
        const saved = JSON.parse(raw);
        Object.assign(this.cfg, saved);
        return !!(this.cfg.owner && this.cfg.repo && this.cfg.token);
      } catch (_) { return false; }
    },

    saveConfig(cfg, remember) {
      Object.assign(this.cfg, cfg);
      const payload = JSON.stringify(this.cfg);
      try {
        localStorage.removeItem(CFG_KEY);
        sessionStorage.removeItem(CFG_KEY);
        (remember ? localStorage : sessionStorage).setItem(CFG_KEY, payload);
      } catch (_) {}
    },

    /**
     * Forget only the token, keeping owner/repo/branch/root, so a token that
     * expired or was revoked costs one field to fix rather than a full re-setup.
     */
    clearToken() {
      this.cfg.token = '';
      try {
        const inLocal = localStorage.getItem(CFG_KEY) !== null;
        const payload = JSON.stringify(this.cfg);
        (inLocal ? localStorage : sessionStorage).setItem(CFG_KEY, payload);
      } catch (_) {}
    },

    clearConfig() {
      try { localStorage.removeItem(CFG_KEY); sessionStorage.removeItem(CFG_KEY); } catch (_) {}
      this.cfg = { owner: '', repo: '', branch: 'main', root: 'vault', token: '' };
    },

    get repoPath() { return this.cfg.owner + '/' + this.cfg.repo; },
    get repoUrl() { return 'https://github.com/' + this.repoPath; },

    blobUrl(path) {
      return this.repoUrl + '/blob/' + encodeURIComponent(this.cfg.branch) + '/' + encodePath(path);
    },

    /* ------------------------------------------------------------ core */
    async request(path, opts) {
      opts = opts || {};
      const url = path.startsWith('http') ? path : API + path;
      const headers = Object.assign({
        Accept: opts.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, opts.headers || {});
      if (this.cfg.token) headers.Authorization = 'Bearer ' + this.cfg.token;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

      let res;
      this.inFlight++;
      if (this.onActivity) this.onActivity(this.inFlight);
      try {
        res = await fetch(url, {
          method: opts.method || 'GET',
          headers,
          cache: 'no-store',
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
        });
      } catch (netErr) {
        throw ghError(0, 'Network error — is this device online?', netErr);
      } finally {
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.onActivity) this.onActivity(this.inFlight);
      }

      const limit = res.headers.get('x-ratelimit-limit');
      if (limit) {
        this.rate = {
          limit: +limit,
          remaining: +res.headers.get('x-ratelimit-remaining'),
          reset: +res.headers.get('x-ratelimit-reset') * 1000
        };
      }

      if (res.status === 204) return null;

      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body.message || '';
          if (body.errors && body.errors.length) {
            detail += ' — ' + body.errors.map((e) => e.message || e.code).join(', ');
          }
        } catch (_) { detail = res.statusText; }
        throw ghError(res.status, friendly(res.status, detail, this), detail);
      }

      if (opts.raw === 'text') return res.text();
      if (opts.raw === 'blob') return res.blob();
      return res.json();
    },

    /* ------------------------------------------------------------ repo */
    getRepo() { return this.request('/repos/' + this.repoPath); },

    /**
     * Whole-vault listing in a single call.
     * Returns [{path, name, dir, type:'tree'|'blob', sha, size}] under cfg.root.
     */
    async getTree() {
      const root = String(this.cfg.root || '').replace(/^\/|\/$/g, '');
      let data;
      try {
        data = await this.request(
          '/repos/' + this.repoPath + '/git/trees/' + encodeURIComponent(this.cfg.branch) +
          '?recursive=1&_=' + Date.now()
        );
      } catch (err) {
        // Brand-new repo, or the branch has no commits yet: an empty vault.
        if (err.status === 404 || err.status === 409) return { entries: [], truncated: false };
        throw err;
      }

      const prefix = root ? root + '/' : '';
      const entries = (data.tree || [])
        .filter((n) => !root || n.path === root || n.path.startsWith(prefix))
        .filter((n) => n.path !== root)
        .map((n) => ({
          path: n.path,
          rel: root ? n.path.slice(prefix.length) : n.path,
          name: n.path.split('/').pop(),
          dir: n.path.split('/').slice(0, -1).join('/'),
          type: n.type,
          sha: n.sha,
          size: n.size || 0
        }));

      return { entries, truncated: !!data.truncated };
    },

    /** Text content of a blob by sha (works for private repos). */
    getBlobText(sha) {
      return this.request('/repos/' + this.repoPath + '/git/blobs/' + sha,
        { accept: 'application/vnd.github.raw', raw: 'text' });
    },

    /** Binary content of a blob by sha, as a Blob. */
    getBlobBinary(sha) {
      return this.request('/repos/' + this.repoPath + '/git/blobs/' + sha,
        { accept: 'application/vnd.github.raw', raw: 'blob' });
    },

    /** Read by path (used when we don't have a cached sha). */
    async getFile(path) {
      const data = await this.request(contentsUrl(this, path) + '&_=' + Date.now());
      return { sha: data.sha, size: data.size, text: data.content ? U.b64decode(data.content) : '' };
    },

    /**
     * Create or update one file.
     * `sha` must be the blob sha we last read — GitHub rejects the write with
     * 409 if someone else changed the file meanwhile, which is how we detect
     * a conflict instead of silently clobbering.
     */
    putFile(path, contentB64, sha, message) {
      return this.request(contentsUrl(this, path), {
        method: 'PUT',
        body: {
          message: message || 'Update ' + path,
          content: contentB64,
          branch: this.cfg.branch,
          sha: sha || undefined
        }
      });
    },

    deleteFile(path, sha, message) {
      return this.request(contentsUrl(this, path), {
        method: 'DELETE',
        body: { message: message || 'Delete ' + path, sha, branch: this.cfg.branch }
      });
    },

    /**
     * Many changes, one commit.
     * changes: [{path, contentB64}] to write, [{path, delete:true}] to remove,
     *          [{path, sha}] to point at an existing blob (used by moves).
     */
    async commitBatch(changes, message, onProgress) {
      const repo = this.repoPath;
      const branch = this.cfg.branch;

      const ref = await this.request('/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch));
      const headSha = ref.object.sha;
      const headCommit = await this.request('/repos/' + repo + '/git/commits/' + headSha);

      const tree = [];
      const uploads = changes.filter((c) => !c.delete && !c.sha).length;
      let uploaded = 0;
      for (const ch of changes) {
        if (ch.delete) {
          tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
        } else if (ch.sha) {
          tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: ch.sha });
        } else {
          const blob = await this.request('/repos/' + repo + '/git/blobs', {
            method: 'POST',
            body: { content: ch.contentB64, encoding: 'base64' }
          });
          tree.push({ path: ch.path, mode: '100644', type: 'blob', sha: blob.sha });
          uploaded++;
          if (onProgress) onProgress(uploaded, uploads);
        }
      }

      const newTree = await this.request('/repos/' + repo + '/git/trees', {
        method: 'POST',
        body: { base_tree: headCommit.tree.sha, tree }
      });
      const commit = await this.request('/repos/' + repo + '/git/commits', {
        method: 'POST',
        body: { message: message || 'Update vault', tree: newTree.sha, parents: [headSha] }
      });
      await this.request('/repos/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), {
        method: 'PATCH',
        body: { sha: commit.sha }
      });
      return commit;
    },

    /** Recent commits touching a path — powers "last edited". */
    async history(path, perPage) {
      try {
        return await this.request('/repos/' + this.repoPath + '/commits?path=' +
          encodePath(path) + '&sha=' + encodeURIComponent(this.cfg.branch) +
          '&per_page=' + (perPage || 5));
      } catch (_) { return []; }
    }
  };

  /* ------------------------------------------------------------ helpers */
  function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
  }

  function contentsUrl(gh, path) {
    return '/repos/' + gh.repoPath + '/contents/' + encodePath(path) +
      '?ref=' + encodeURIComponent(gh.cfg.branch);
  }

  function ghError(status, message, detail) {
    const e = new Error(message);
    e.status = status;
    e.detail = detail;
    return e;
  }

  function friendly(status, detail, gh) {
    switch (status) {
      case 401:
        return 'GitHub rejected the token. It may be expired or mistyped.';
      case 403:
        if (/rate limit/i.test(detail)) {
          const mins = gh.rate && gh.rate.reset
            ? Math.max(1, Math.ceil((gh.rate.reset - Date.now()) / 60000)) : null;
          return 'GitHub rate limit reached' + (mins ? '; try again in ~' + mins + ' min.' : '.');
        }
        return 'Permission denied. The token needs Contents: Read and write on ' + gh.repoPath + '.';
      case 404:
        return 'Not found on GitHub — check the owner, repo and branch (or the token\'s repo access).';
      case 409:
        return 'This file changed on GitHub since you opened it.';
      case 413:
        return 'That file is too large for the GitHub API.';
      case 422:
        return 'GitHub refused the change: ' + (detail || 'invalid request') + '.';
      default:
        return detail || ('GitHub error ' + status + '.');
    }
  }

  global.GH = GH;
})(window);
