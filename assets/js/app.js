/* =========================================================================
   app.js — Keep
   ========================================================================= */
(function () {
  'use strict';

  const { $, $$, el, icon, toast, modal, confirmModal, contextMenu } = U;

  const UI_KEY = 'keep.ui';
  const DRAFT_PREFIX = 'keep.draft.';
  const MAX_UPLOAD = 50 * 1024 * 1024;   // GitHub blob API ceiling we're willing to try
  const WARN_UPLOAD = 8 * 1024 * 1024;
  const ASSET_DIR = 'assets';            // where pasted/dropped images land, inside the vault

  // Used when nothing is saved and the URL tells us nothing (e.g. localhost).
  // Edit these if you fork this app for a different vault.
  const DEFAULT_TARGET = { owner: 'ambujraj2001', repo: 'keep', branch: 'main', root: 'vault' };

  /** Work out the repo from a github.io URL, so the app only has to ask for a token. */
  function detectTarget() {
    const m = location.hostname.match(/^([A-Za-z0-9-]+)\.github\.io$/i);
    if (!m) return null;                                  // custom domain or local
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return { owner: m[1], repo: seg || (m[1] + '.github.io') };
  }

  /**
   * If the app is served from a github.io URL and the saved repo isn't the one
   * the user deliberately chose, trust the URL. That way renaming the repo
   * re-points every signed-in device instead of stranding it on a dead name.
   */
  function reconcileTarget() {
    const det = detectTarget();
    if (!det || GH.cfg.pinned) return;
    if (!GH.cfg.owner || !GH.cfg.repo) return;
    if (GH.cfg.owner === det.owner && GH.cfg.repo === det.repo) return;
    GH.cfg.owner = det.owner;
    GH.cfg.repo = det.repo;
    GH.saveConfig(GH.cfg, true);
  }

  /** Saved config wins, then the URL, then the baked-in default. */
  function setupTarget() {
    const det = detectTarget();
    return {
      owner: GH.cfg.owner || (det && det.owner) || DEFAULT_TARGET.owner,
      repo: GH.cfg.repo || (det && det.repo) || DEFAULT_TARGET.repo,
      branch: GH.cfg.branch || DEFAULT_TARGET.branch,
      root: GH.cfg.root || DEFAULT_TARGET.root
    };
  }

  const state = {
    entries: [],
    byPath: new Map(),
    open: new Set(),
    selectedDir: '',          // folder context for "new" actions (vault-relative)
    current: null,            // {kind:'note'|'file', path}
    doc: null,                // {path, sha, text, original, isNew, dirty, attrs}
    mode: 'preview',
    kindFilter: 'all',
    filter: '',
    assetUrls: new Map(),
    busyPaths: new Set(),      // rows waiting on a commit
    ready: false,
    truncated: false
  };

  const ui = Object.assign(
    { sidebar: 288, mode: 'preview', last: '', accent: 'indigo' },
    readJSON(UI_KEY) || {}
  );

  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  const saveUI = U.debounce(() => writeJSON(UI_KEY, ui), 250);

  const vaultRoot = () => String(GH.cfg.root || '').replace(/^\/|\/$/g, '');
  const abs = (rel) => U.joinPath(vaultRoot(), rel);
  const rel = (path) => {
    const r = vaultRoot();
    return r && path.startsWith(r + '/') ? path.slice(r.length + 1) : (path === r ? '' : path);
  };

  /* =======================================================================
     Boot
     ======================================================================= */
  /**
   * Any request in flight lights the bar. Delayed slightly so quick calls
   * don't make it flicker.
   */
  let progressTimer = null;
  function wireProgress() {
    GH.onActivity = (inFlight) => {
      const bar = $('#progress');
      if (!bar) return;
      if (inFlight > 0) {
        if (bar.hidden && !progressTimer) {
          progressTimer = setTimeout(() => { bar.hidden = false; progressTimer = null; }, 160);
        }
      } else {
        clearTimeout(progressTimer);
        progressTimer = null;
        bar.hidden = true;
      }
    };
  }

  /** Show a spinner on the row(s) an operation is about to change. */
  function setRowsBusy(paths, on) {
    [].concat(paths).forEach((p) => on ? state.busyPaths.add(p) : state.busyPaths.delete(p));
    renderTree();
  }

  function boot() {
    applyAccent(ui.accent);
    wireProgress();
    localizeKeyHints();
    wireSetup();
    wireChrome();
    wireEditor();
    wirePalette();
    wireDnD();
    wireShortcuts();

    if (GH.loadConfig()) { reconcileTarget(); connect(); }
    else showSetup();
  }

  function showSetup(message, kind) {
    $('#app').hidden = true;
    $('#setup').hidden = false;
    const t = setupTarget();
    $('#cfg-owner').value = t.owner;
    $('#cfg-repo').value = t.repo;
    $('#cfg-branch').value = t.branch;
    $('#cfg-root').value = t.root;
    $('#cfg-token').value = '';
    updateTargetLine();
    const err = $('#setup-error');
    err.className = 'alert ' + (kind || 'error');
    err.hidden = !message;
    if (message) err.textContent = message;
    setTimeout(() => $('#cfg-token').focus(), 60);
  }

  function updateTargetLine() {
    const owner = $('#cfg-owner').value.trim();
    const repo = $('#cfg-repo').value.trim();
    $('#target-repo').textContent = owner && repo ? owner + '/' + repo : 'Choose a repository';
    $('#target-meta').textContent = $('#cfg-branch').value.trim() + ' · ' + $('#cfg-root').value.trim() + '/';
  }

  function wireSetup() {
    $('#toggle-token').addEventListener('click', () => {
      const i = $('#cfg-token');
      i.type = i.type === 'password' ? 'text' : 'password';
      i.focus();
    });

    $('#toggle-advanced').addEventListener('click', () => {
      const box = $('#advanced');
      box.hidden = !box.hidden;
      $('#toggle-advanced').textContent = box.hidden ? 'Change' : 'Done';
      if (!box.hidden) $('#cfg-owner').focus();
    });
    ['#cfg-owner', '#cfg-repo', '#cfg-branch', '#cfg-root'].forEach((sel) =>
      $(sel).addEventListener('input', updateTargetLine));

    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#setup-submit');
      const err = $('#setup-error');
      err.hidden = true;
      btn.disabled = true;
      btn.innerHTML = '';
      btn.append(el('span', { class: 'spin' }), el('span', { text: 'Connecting…' }));

      const cfg = {
        owner: $('#cfg-owner').value.trim().replace(/^https?:\/\/github\.com\//, '').split('/')[0],
        repo: $('#cfg-repo').value.trim().replace(/\.git$/, '').split('/').pop(),
        branch: $('#cfg-branch').value.trim() || 'main',
        root: $('#cfg-root').value.trim().replace(/^\/|\/$/g, ''),
        token: $('#cfg-token').value.trim()
      };
      const remember = $('#cfg-remember').checked;
      const det = detectTarget();
      cfg.pinned = !!(det && (det.owner !== cfg.owner || det.repo !== cfg.repo));

      const prev = Object.assign({}, GH.cfg);
      Object.assign(GH.cfg, cfg);
      try {
        const repo = await GH.getRepo();
        if (!repo.permissions || repo.permissions.push === false) {
          throw new Error('This token can read ' + GH.repoPath + ' but not write to it. Give it Contents: Read and write.');
        }
        // A repo on 'master' (or any other default) shouldn't look like an empty
        // vault just because the branch field still said 'main'.
        let swapped = null;
        try {
          await GH.request('/repos/' + GH.repoPath + '/branches/' + encodeURIComponent(GH.cfg.branch));
        } catch (branchErr) {
          if (branchErr.status !== 404 || !repo.default_branch) throw branchErr;
          if (repo.default_branch !== GH.cfg.branch) {
            swapped = GH.cfg.branch;
            GH.cfg.branch = repo.default_branch;
          }
        }
        GH.saveConfig(GH.cfg, remember);
        $('#setup').hidden = true;
        await connect();
        if (swapped) {
          toast('No branch called “' + swapped + '” — using “' + GH.cfg.branch + '” instead.', 'info', { duration: 7000 });
        }
      } catch (ex) {
        Object.assign(GH.cfg, prev);
        err.textContent = ex.message;
        err.hidden = false;
        if (ex.status === 404) {          // wrong repo — show the fields so it can be fixed
          $('#advanced').hidden = false;
          $('#toggle-advanced').textContent = 'Done';
        }
      } finally {
        btn.disabled = false;
        btn.innerHTML = '';
        btn.append(icon('check'), el('span', { text: 'Connect vault' }));
      }
    });
  }

  async function connect() {
    $('#setup').hidden = true;
    $('#app').hidden = false;
    $('#brand-repo').textContent = 'Keep';
    $('#brand-repo').title = GH.repoPath;
    $('#btn-gh').href = GH.repoUrl;
    document.title = 'Keep';
    $('#sidebar').style.setProperty('--sidebar-w', ui.sidebar + 'px');
    document.documentElement.style.setProperty('--sidebar-w', ui.sidebar + 'px');
    setMode(ui.mode || 'preview', true);

    renderTree();                // paints the skeleton while the first load runs
    await refresh({ silent: true });
    state.ready = true;

    if (ui.last && state.byPath.has(ui.last)) openPath(ui.last);
    else if (!state.entries.length) showEmpty();
  }

  /* =======================================================================
     Sync status
     ======================================================================= */
  let busyCount = 0;
  function setSync(kind, text) {
    const n = $('#sync');
    n.dataset.state = kind;
    n.querySelector('.sync-text').textContent = text;
  }
  function busy(text) {
    busyCount++;
    setSync('busy', text || 'Working…');
    return () => {
      busyCount = Math.max(0, busyCount - 1);
      if (!busyCount) setSync('ok', 'Synced');
    };
  }
  function failed(err) {
    busyCount = Math.max(0, busyCount - 1);
    setSync('error', 'Error');
    console.error(err);
    toast(err && err.message ? err.message : String(err), 'err');
  }

  /* =======================================================================
     Vault data
     ======================================================================= */
  async function refresh(opts) {
    opts = opts || {};
    const btn = $('#btn-refresh');
    if (btn) btn.classList.add('spinning');
    const done = busy('Loading vault…');
    try {
      const { entries, truncated } = await GH.getTree();
      const pending = state.entries.filter((e) => e.pending);
      state.entries = entries.concat(pending.filter((p) => !entries.some((e) => e.path === p.path)));
      state.truncated = truncated;
      reindex();
      renderTree();
      renderStats();
      done();
      if (btn) btn.classList.remove('spinning');
      if (truncated) toast('This repo is very large — the file list was truncated by GitHub.', 'err');
      if (!opts.silent) toast('Vault refreshed', 'ok');
    } catch (err) {
      if (btn) btn.classList.remove('spinning');
      failed(err);
      if (err.status === 401) {
        GH.clearToken();
        showSetup('That token expired or was revoked — paste a new one. Everything else is remembered.');
      }
    }
  }

  function reindex() {
    state.byPath = new Map();
    state.entries.forEach((e) => {
      e.kind = e.type === 'tree' ? 'folder' : (U.isMd(e.path) ? 'note' : 'file');
      e.hidden = e.name === '.gitkeep';
      state.byPath.set(e.path, e);
    });
  }

  function renderStats() {
    const visible = state.entries.filter((e) => !e.hidden);
    const notes = visible.filter((e) => e.kind === 'note').length;
    const files = visible.filter((e) => e.kind === 'file').length;
    const bytes = visible.reduce((s, e) => s + (e.size || 0), 0);
    $('#stats').textContent =
      notes + (notes === 1 ? ' note' : ' notes') + ' · ' +
      files + (files === 1 ? ' file' : ' files') + ' · ' + U.formatBytes(bytes);
  }

  /* -------------------------------------------------- tree building */
  function buildTree() {
    const root = { name: '', path: vaultRoot(), children: new Map(), type: 'tree' };
    const getFolder = (dirPath) => {
      if (!dirPath || dirPath === vaultRoot()) return root;
      const parts = rel(dirPath).split('/').filter(Boolean);
      let node = root, acc = vaultRoot();
      parts.forEach((p) => {
        acc = U.joinPath(acc, p);
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, path: acc, children: new Map(), type: 'tree', synthetic: true });
        }
        node = node.children.get(p);
      });
      return node;
    };

    state.entries.filter((e) => e.type === 'tree').forEach((e) => {
      const f = getFolder(e.path);
      f.synthetic = false;
      f.entry = e;
    });
    state.entries.filter((e) => e.type !== 'tree' && !e.hidden).forEach((e) => {
      const parent = getFolder(e.dir);
      parent.children.set(e.name, { name: e.name, path: e.path, type: 'blob', entry: e });
    });
    return root;
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortChildren(node) {
    return Array.from(node.children.values()).sort((a, b) => {
      const af = a.type === 'tree', bf = b.type === 'tree';
      if (af !== bf) return af ? -1 : 1;
      return collator.compare(a.name, b.name);
    });
  }

  function matchesKind(node) {
    if (state.kindFilter === 'all') return true;
    if (node.type === 'tree') return true;
    const k = U.isMd(node.path) ? 'note' : 'file';
    return k === state.kindFilter;
  }

  /* -------------------------------------------------- tree render */
  function renderTree() {
    const host = $('#tree');
    host.innerHTML = '';

    if (!state.ready && !state.entries.length) {
      host.appendChild(el('div', { class: 'skeleton' },
        [1,2,3,4,5].map(() => el('span'))));
      return;
    }

    if (state.filter.trim()) return renderFilteredTree(host);

    const root = buildTree();
    const frag = renderChildren(root, 0);
    if (!frag.childNodes.length) {
      host.appendChild(el('div', { class: 'tree-empty' }, [
        el('div', { text: 'This vault is empty.' }),
        el('div', { class: 'hint', text: 'Create a note or drop in some files.' })
      ]));
      return;
    }
    host.appendChild(frag);
  }

  function renderChildren(node, depth) {
    const frag = document.createDocumentFragment();
    sortChildren(node).forEach((child) => {
      if (!matchesKind(child)) return;
      if (child.type === 'tree') {
        const isOpen = state.open.has(child.path);
        const row = folderRow(child, isOpen);
        frag.appendChild(row);
        if (isOpen) {
          const kids = renderChildren(child, depth + 1);
          const box = el('div', { class: 'children' });
          if (!kids.childNodes.length) {
            box.appendChild(el('div', { class: 'node', style: 'color:var(--txt-3);cursor:default' },
              [el('span', { class: 'label', text: 'empty' })]));
          } else box.appendChild(kids);
          frag.appendChild(box);
        }
      } else {
        frag.appendChild(fileRow(child));
      }
    });
    return frag;
  }

  function folderRow(node, isOpen) {
    const busy = state.busyPaths.has(node.path);
    const row = el('div', {
      class: 'node' + (isOpen ? ' open' : '') + (busy ? ' busy' : '') +
             (state.selectedDir === node.path ? ' active' : ''),
      draggable: 'true',
      title: rel(node.path)
    }, [
      icon('chev-r', 'twist'),
      busy ? el('span', { class: 'node-spin' }) : icon('folder'),
      el('span', { class: 'label', text: node.name }),
      el('span', {
        class: 'node-menu', onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, node); }
      }, [icon('more')])
    ]);
    row.addEventListener('click', () => {
      state.selectedDir = node.path;
      if (state.open.has(node.path)) state.open.delete(node.path);
      else state.open.add(node.path);
      renderTree();
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, node); });
    makeDraggable(row, node.path, true);
    return row;
  }

  function fileRow(node) {
    const entry = node.entry;
    const isNote = U.isMd(node.path);
    const kindIcon = isNote ? 'note' : ({ image: 'image', video: 'file', audio: 'file', pdf: 'file' }[U.fileKind(node.path)] || 'file');
    const active = state.current && state.current.path === node.path;
    const dirty = state.doc && state.doc.path === node.path && state.doc.dirty;

    const busy = state.busyPaths.has(node.path);
    const row = el('div', {
      class: 'node' + (active ? ' active' : '') + (busy ? ' busy' : ''),
      draggable: 'true',
      title: rel(node.path)
    }, [
      busy ? el('span', { class: 'node-spin' }) : icon(kindIcon),
      el('span', { class: 'label', text: isNote ? U.stem(node.name) : node.name }),
      dirty ? el('span', { class: 'dirty-dot' }) : null,
      el('span', {
        class: 'node-menu', onclick: (e) => { e.stopPropagation(); fileMenu(e.currentTarget, entry); }
      }, [icon('more')])
    ]);
    row.addEventListener('click', () => openPath(node.path));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, entry); });
    makeDraggable(row, node.path, false);
    return row;
  }

  function renderFilteredTree(host) {
    const q = state.filter.trim().toLowerCase();
    const hits = state.entries
      .filter((e) => e.type !== 'tree' && !e.hidden && matchesKind({ type: 'blob', path: e.path }))
      .filter((e) => rel(e.path).toLowerCase().includes(q))
      .sort((a, b) => collator.compare(rel(a.path), rel(b.path)))
      .slice(0, 300);

    if (!hits.length) {
      host.appendChild(el('div', { class: 'tree-empty' }, [
        el('div', { text: 'No matches for “' + state.filter + '”' }),
        el('div', { class: 'hint', text: 'Try ' + metaKeyLabel() + 'K to search inside notes too.' })
      ]));
      return;
    }
    hits.forEach((e) => {
      host.appendChild(fileRow({ name: e.name, path: e.path, type: 'blob', entry: e }));
    });
  }

  const metaKeyLabel = () => (/Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+');

  function localizeKeyHints() {
    if (/Mac|iP(hone|ad)/.test(navigator.platform)) return;
    $$('kbd').forEach((k) => { k.textContent = k.textContent.replace('⌘', 'Ctrl+').replace('⇧', 'Shift+'); });
  }

  function applyAccent(name) {
    document.documentElement.dataset.accent = name || 'indigo';
    ui.accent = name || 'indigo';
    saveUI();
  }

  /* =======================================================================
     Opening notes & files
     ======================================================================= */
  function showPane(id) {
    ['view-empty', 'view-note', 'view-file'].forEach((p) => { $('#' + p).hidden = (p !== id); });
  }
  function showEmpty() {
    state.current = null;
    showPane('view-empty');
  }

  async function openPath(path, hash) {
    const entry = state.byPath.get(path);
    if (!entry) { toast('Not in this vault: ' + rel(path), 'err'); return; }
    if (entry.kind === 'note') return openNote(entry, hash);
    return openFile(entry);
  }

  async function openNote(entry, hash) {
    if (!(await guardUnsaved())) return;

    state.current = { kind: 'note', path: entry.path };
    state.selectedDir = entry.dir;
    ui.last = entry.path;
    saveUI();
    showPane('view-note');
    renderCrumbs(entry);
    $('#preview').innerHTML = '';
    $('#preview').appendChild(el('div', { class: 'loading-pane' }, [el('span', { class: 'spin' })]));
    renderTree();

    const done = busy('Opening…');
    try {
      const text = entry.pending ? (entry.draftText || '') : await GH.getBlobText(entry.sha);
      state.doc = {
        path: entry.path, sha: entry.sha, text, original: text,
        isNew: !!entry.pending, dirty: !!entry.pending
      };

      // Restore an unsaved draft from a previous session, if it still applies.
      const draft = readJSON(DRAFT_PREFIX + entry.path);
      if (draft && draft.text !== text && !entry.pending) {
        state.doc.text = draft.text;
        state.doc.dirty = true;
        toast('Restored unsaved changes from ' + U.timeAgo(draft.ts), 'info', {
          action: 'Discard', duration: 9000,
          onAction: () => {
            state.doc.text = state.doc.original;
            state.doc.dirty = false;
            clearDraft(entry.path);
            $('#editor').value = state.doc.text;
            renderPreview();
            markDirty();
          }
        });
      }

      $('#editor').value = state.doc.text;
      markDirty();
      renderPreview();
      updateCount();
      done();
      if (hash) setTimeout(() => {
        const t = $('#preview').querySelector('#' + CSS.escape(hash));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 120);
      if (state.mode !== 'preview') focusEditor();
      loadNoteMeta(entry.path);
    } catch (err) {
      failed(err);
      $('#preview').innerHTML = '';
      $('#preview').appendChild(el('div', { class: 'md-empty', text: 'Could not load this note.' }));
    }
  }

  async function loadNoteMeta(path) {
    const commits = await GH.history(path, 1);
    if (!commits.length || !state.current || state.current.path !== path) return;
    const when = commits[0].commit.committer.date;
    const box = $('#crumbs');
    const old = box.querySelector('.meta');
    if (old) old.remove();
    box.appendChild(el('span', { class: 'meta', text: 'edited ' + U.timeAgo(when) }));
  }

  function renderCrumbs(entry, hostSel) {
    const host = $(hostSel || '#crumbs');
    host.innerHTML = '';
    const parts = rel(entry.path).split('/');
    const name = parts.pop();
    let acc = vaultRoot();

    host.appendChild(el('span', {
      class: 'crumb link', text: GH.cfg.root || 'vault',
      onclick: () => { state.selectedDir = vaultRoot(); state.filter = ''; $('#tree-filter').value = ''; renderTree(); }
    }));
    parts.forEach((p) => {
      acc = U.joinPath(acc, p);
      const target = acc;
      host.appendChild(el('span', { class: 'sep', text: '/' }));
      host.appendChild(el('span', {
        class: 'crumb link', text: p,
        onclick: () => { state.selectedDir = target; state.open.add(target); renderTree(); }
      }));
    });
    host.appendChild(el('span', { class: 'sep', text: '/' }));
    host.appendChild(el('span', {
      class: 'crumb current', text: U.isMd(name) ? U.stem(name) : name,
      title: 'Click to rename',
      onclick: () => renameEntry(state.byPath.get(entry.path) || entry)
    }));
  }

  /* -------------------------------------------------- preview */
  function renderPreview() {
    if (!state.doc) return;
    const host = $('#preview');
    const out = MD.render(state.doc.text);
    host.innerHTML = out.html;

    if (out.attrs) {
      const bar = el('div', { class: 'fm-bar' });
      const tags = [].concat(out.attrs.tags || out.attrs.tag || []);
      Object.keys(out.attrs).forEach((k) => {
        if (k === 'tags' || k === 'tag') return;
        const v = out.attrs[k];
        if (!v || Array.isArray(v)) return;
        bar.appendChild(el('span', { class: 'fm-chip' }, [
          el('b', { text: k + ':', style: 'font-weight:600;color:var(--txt-3)' }),
          el('span', { text: ' ' + v })
        ]));
      });
      tags.forEach((t) => {
        bar.appendChild(el('span', {
          class: 'fm-chip tag', onclick: () => { $('#tree-filter').value = ''; openPalette('#' + t); }
        }, [icon('tag'), el('span', { text: t })]));
      });
      if (bar.childNodes.length) host.insertBefore(bar, host.firstChild);
    }

    MD.enhance(host, {
      dir: U.dirname(state.doc.path),
      resolveAsset,
      openPath: (p, hash) => openPath(p, hash),
      onToggleTask: (index, checked) => {
        state.doc.text = MD.toggleTaskInSource(state.doc.text, index, checked);
        $('#editor').value = state.doc.text;
        markDirty();
        saveDraft();
        autosaveTasks();
      }
    });

    buildToc(out.headings);
  }

  const renderPreviewSoon = U.debounce(renderPreview, 260);

  /** Ticking a checkbox is a real edit — commit it, but coalesce rapid clicks. */
  const autosaveTasks = U.debounce(() => {
    if (!state.doc || !state.doc.dirty || state.doc.isNew) return;
    saveNote({ quiet: true, message: 'Update tasks in ' + rel(state.doc.path) });
  }, 900);

  function buildToc(headings) {
    const box = $('#toc'), list = $('#toc-list');
    const items = (headings || []).filter((h) => h.level >= 2 && h.level <= 4);
    // Only worth the space in full-width preview.
    if (items.length < 2 || state.mode !== 'preview') { box.hidden = true; return; }
    box.hidden = false;
    list.innerHTML = '';
    items.forEach((h) => {
      list.appendChild(el('a', {
        href: '#' + h.id, class: 'h' + h.level, text: h.text,
        onclick: (e) => {
          e.preventDefault();
          const t = $('#preview').querySelector('#' + CSS.escape(h.id));
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }));
    });
  }

  /** Fetch an in-repo asset through the API so private repos render too. */
  async function resolveAsset(path) {
    if (state.assetUrls.has(path)) return state.assetUrls.get(path);
    let entry = state.byPath.get(path);
    let blob;
    if (entry && entry.sha) blob = await GH.getBlobBinary(entry.sha);
    else {
      const meta = await GH.request('/repos/' + GH.repoPath + '/contents/' +
        path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(GH.cfg.branch));
      blob = await GH.getBlobBinary(meta.sha);
    }
    const typed = new Blob([blob], { type: mimeFor(path) });
    const url = URL.createObjectURL(typed);
    state.assetUrls.set(path, url);
    return url;
  }

  function mimeFor(path) {
    const e = U.extname(path);
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
      pdf: 'application/pdf', json: 'application/json', csv: 'text/csv', txt: 'text/plain'
    };
    return map[e] || 'application/octet-stream';
  }

  /* -------------------------------------------------- file view */
  async function openFile(entry) {
    if (!(await guardUnsaved())) return;
    state.current = { kind: 'file', path: entry.path };
    state.selectedDir = entry.dir;
    ui.last = entry.path;
    saveUI();
    showPane('view-file');
    renderCrumbs(entry, '#file-crumbs');
    renderTree();

    const host = $('#file-body');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'loading-pane' }, [el('span', { class: 'spin' })]));

    const kind = U.fileKind(entry.path);
    const done = busy('Opening…');
    try {
      const wrap = el('div', { class: 'file-preview' });
      if (kind === 'image') {
        wrap.appendChild(el('img', { src: await resolveAsset(entry.path), alt: entry.name }));
      } else if (kind === 'video') {
        wrap.appendChild(el('video', { controls: true, src: await resolveAsset(entry.path) }));
      } else if (kind === 'audio') {
        wrap.appendChild(el('audio', { controls: true, src: await resolveAsset(entry.path) }));
      } else if (kind === 'pdf') {
        wrap.appendChild(el('iframe', { src: await resolveAsset(entry.path), title: entry.name }));
      } else if (kind === 'text' && entry.size < 400000) {
        wrap.appendChild(el('pre', { text: await GH.getBlobText(entry.sha) }));
      } else {
        wrap.appendChild(el('div', { style: 'padding:48px;text-align:center;color:var(--txt-3)' }, [
          icon('file', 'big'),
          el('div', { style: 'margin-top:10px', text: 'No preview for .' + (U.extname(entry.path) || 'file') })
        ]));
      }

      host.innerHTML = '';
      host.appendChild(wrap);
      host.appendChild(el('div', { class: 'file-meta' }, [
        el('dl', {}, [el('dt', { text: 'Name' }), el('dd', { text: entry.name })]),
        el('dl', {}, [el('dt', { text: 'Size' }), el('dd', { text: U.formatBytes(entry.size) })]),
        el('dl', {}, [el('dt', { text: 'Type' }), el('dd', { text: U.extname(entry.path).toUpperCase() || 'FILE' })]),
        el('dl', {}, [el('dt', { text: 'Path' }), el('dd', { text: rel(entry.path) })])
      ]));
      host.appendChild(el('div', { class: 'file-note', text: 'Use “Copy path” to embed this in a note, e.g. ![](' + rel(entry.path) + ')' }));
      done();
    } catch (err) {
      host.innerHTML = '';
      host.appendChild(el('div', { class: 'file-note', text: 'Could not load this file.' }));
      failed(err);
    }
  }

  /* =======================================================================
     Saving
     ======================================================================= */
  function markDirty() {
    const dirty = state.doc ? state.doc.text !== state.doc.original || state.doc.isNew : false;
    if (state.doc) state.doc.dirty = dirty;
    $('#dirty').hidden = !dirty;
    $('#btn-save').disabled = !dirty;
    const btn = $('#btn-save').querySelector('span');
    if (btn) btn.textContent = dirty ? 'Save' : 'Saved';
    const node = $$('#tree .node.active')[0];
    if (node) {
      const has = node.querySelector('.dirty-dot');
      if (dirty && !has) node.insertBefore(el('span', { class: 'dirty-dot' }), node.querySelector('.node-menu'));
      if (!dirty && has) has.remove();
    }
  }

  /** 'saving' locks the button and spins; 'idle' hands control back to markDirty. */
  function setSaveButton(mode) {
    const btn = $('#btn-save');
    btn.innerHTML = '';
    if (mode === 'saving') {
      btn.disabled = true;
      btn.append(el('span', { class: 'spin' }), el('span', { text: 'Saving…' }));
      return;
    }
    btn.append(icon('save'), el('span', { text: 'Save' }));
    markDirty();
  }

  const saveDraft = U.debounce(() => {
    if (!state.doc || !state.doc.dirty) return;
    writeJSON(DRAFT_PREFIX + state.doc.path, { text: state.doc.text, ts: Date.now() });
  }, 700);

  function clearDraft(path) { try { localStorage.removeItem(DRAFT_PREFIX + path); } catch (_) {} }

  async function saveNote(opts) {
    opts = opts || {};
    if (!state.doc || !state.doc.dirty) return true;
    const doc = state.doc;

    // A brand-new note earns its filename from its first heading.
    if (doc.isNew) {
      const title = MD.firstHeading(doc.text);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
      const base = U.sanitizeName(title || ('Note ' + stamp)) || ('Note ' + stamp);
      const dir = U.dirname(doc.path);
      const wanted = uniquePath(U.joinPath(dir, base + '.md'));
      if (wanted !== doc.path) {
        const old = doc.path;
        doc.path = wanted;
        state.entries = state.entries.filter((e) => e.path !== old);
        clearDraft(old);
        if (state.current) state.current.path = wanted;
        ui.last = wanted;
      }
    }

    const done = busy('Saving…');
    setSaveButton('saving');
    try {
      const res = await GH.putFile(
        doc.path, U.b64encode(doc.text), doc.isNew ? null : doc.sha,
        opts.message || (doc.isNew ? 'Create ' + rel(doc.path) : 'Update ' + rel(doc.path))
      );
      doc.sha = res.content.sha;
      doc.original = doc.text;
      doc.isNew = false;
      clearDraft(doc.path);

      const entry = {
        path: doc.path, rel: rel(doc.path), name: U.basename(doc.path),
        dir: U.dirname(doc.path), type: 'blob', sha: doc.sha,
        size: res.content.size || doc.text.length, kind: 'note'
      };
      state.entries = state.entries.filter((e) => e.path !== doc.path && !e.pending);
      state.entries.push(entry);
      reindex();
      state.current = { kind: 'note', path: doc.path };
      renderTree();
      renderStats();
      renderCrumbs(entry);
      markDirty();
      done();
      setSaveButton('idle');
      if (!opts.quiet) toast('Saved to GitHub', 'ok');
      return true;
    } catch (err) {
      setSaveButton('idle');
      if (err.status === 409 || err.status === 422) return handleConflict(doc, err);
      failed(err);
      return false;
    }
  }

  async function handleConflict(doc, err) {
    busyCount = Math.max(0, busyCount - 1);
    setSync('error', 'Conflict');
    const choice = await modal({
      title: 'This note changed on GitHub',
      subtitle: 'Someone (or another device) saved ' + rel(doc.path) + ' after you opened it.',
      icon: 'alert', danger: true,
      confirmText: 'Overwrite with my version',
      cancelText: 'Keep GitHub version'
    });
    try {
      const remote = await GH.getFile(doc.path);
      if (choice === null) {
        doc.text = remote.text;
        doc.original = remote.text;
        doc.sha = remote.sha;
        clearDraft(doc.path);
        $('#editor').value = doc.text;
        renderPreview();
        markDirty();
        toast('Loaded the version from GitHub', 'info');
        return false;
      }
      doc.sha = remote.sha;
      return saveNote({ message: 'Overwrite ' + rel(doc.path) });
    } catch (e2) { failed(e2); return false; }
  }

  /** Ask before throwing away unsaved edits. Returns true to proceed. */
  async function guardUnsaved() {
    if (!state.doc || !state.doc.dirty) return true;
    const name = rel(state.doc.path);
    const res = await modal({
      title: 'Save changes?',
      subtitle: name + ' has unsaved edits.',
      icon: 'save',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Discard', value: 'discard', kind: 'danger' },
        { label: 'Save', value: 'save', kind: 'primary', primary: true }
      ]
    });
    if (res === null) return false;               // dismissed — stay put
    if (res === 'discard') {
      clearDraft(state.doc.path);
      state.doc.dirty = false;
      state.entries = state.entries.filter((e) => !e.pending);
      reindex();
      renderTree();
      return true;
    }
    return saveNote();
  }

  function uniquePath(path, taken) {
    const used = (p) => state.byPath.has(p) || (taken && taken.has(p));
    if (!used(path)) return path;
    const dir = U.dirname(path), base = U.stem(path), ext = U.extname(path);
    for (let i = 2; i < 999; i++) {
      const p = U.joinPath(dir, base + '-' + i + (ext ? '.' + ext : ''));
      if (!used(p)) return p;
    }
    return path;
  }

  /* =======================================================================
     Create / rename / duplicate / delete / move
     ======================================================================= */
  function currentDir() {
    if (state.selectedDir) return state.selectedDir;
    if (state.current) return U.dirname(state.current.path);
    return vaultRoot();
  }

  async function newNote(dir) {
    if (!(await guardUnsaved())) return;
    dir = dir || currentDir();
    const path = uniquePath(U.joinPath(dir, 'Untitled.md'));
    const entry = {
      path, rel: rel(path), name: U.basename(path), dir, type: 'blob',
      sha: null, size: 0, kind: 'note', pending: true, draftText: ''
    };
    state.entries.push(entry);
    reindex();
    if (dir !== vaultRoot()) state.open.add(dir);

    state.current = { kind: 'note', path };
    state.doc = { path, sha: null, text: '', original: '', isNew: true, dirty: true };
    showPane('view-note');
    renderCrumbs(entry);
    renderTree();
    $('#editor').value = '';
    $('#preview').innerHTML = '';
    markDirty();
    updateCount();
    setMode('edit');
    focusEditor();
    toast('New note — it commits to GitHub when you save (' + metaKeyLabel() + 'S)', 'info');
  }

  async function newFolder(dir) {
    dir = dir || currentDir();
    const res = await modal({
      title: 'New folder',
      subtitle: 'Inside ' + (rel(dir) || GH.cfg.root),
      icon: 'folder-plus',
      confirmText: 'Create',
      fields: [{ name: 'name', label: 'Folder name', placeholder: 'Projects' }],
      validate: (v) => !v.name ? 'Give the folder a name.' : null
    });
    if (!res) return;
    const name = U.sanitizeName(res.name);
    const path = U.joinPath(dir, name);
    if (state.byPath.has(path)) return toast('That folder already exists', 'err');

    // Git has no empty directories, so seed one with a .gitkeep.
    const done = busy('Creating folder…');
    const note = toast('Creating folder…', 'info', { sticky: true, spinner: true });
    try {
      await GH.putFile(U.joinPath(path, '.gitkeep'), U.b64encode(''), null, 'Create folder ' + rel(path));
      state.entries.push({ path, rel: rel(path), name, dir, type: 'tree', sha: null, size: 0, kind: 'folder' });
      reindex();
      state.open.add(path);
      state.selectedDir = path;
      renderTree();
      done();
      note.done('Folder created');
    } catch (err) { note.close(); failed(err); }
  }

  async function renameEntry(entry) {
    if (!entry) return;
    const isFolder = entry.type === 'tree';
    const currentName = isFolder ? entry.name : (U.isMd(entry.path) ? U.stem(entry.name) : entry.name);
    const res = await modal({
      title: isFolder ? 'Rename folder' : 'Rename',
      subtitle: rel(entry.path),
      icon: 'edit',
      confirmText: 'Rename',
      fields: [{
        name: 'name', label: 'New name',
        hint: U.isMd(entry.path) ? '.md is added for you' : '',
        value: currentName,
        selectRange: [0, currentName.length]
      }],
      validate: (v) => !v.name ? 'Name cannot be empty.' : null
    });
    if (!res) return;

    let name = U.sanitizeName(res.name);
    if (!isFolder && U.isMd(entry.path) && !U.isMd(name)) name += '.md';
    if (name === entry.name) return;
    const target = U.joinPath(U.dirname(entry.path), name);
    if (state.byPath.has(target)) return toast('“' + name + '” already exists here', 'err');
    await movePaths(entry, target, 'Rename ' + rel(entry.path) + ' → ' + rel(target));
  }

  /** Move or rename a blob or a whole folder, as one commit. */
  async function movePaths(entry, targetPath, message) {
    const isFolder = entry.type === 'tree';
    const moving = isFolder
      ? state.entries.filter((e) => e.type !== 'tree' && e.path.startsWith(entry.path + '/'))
      : [entry];
    if (!moving.length && isFolder) {
      // Folder only existed via .gitkeep; recreate it at the new path.
      const done = busy('Moving…');
      try {
        await GH.putFile(U.joinPath(targetPath, '.gitkeep'), U.b64encode(''), null, message);
        try {
          const keep = await GH.getFile(U.joinPath(entry.path, '.gitkeep'));
          await GH.deleteFile(U.joinPath(entry.path, '.gitkeep'), keep.sha, message);
        } catch (_) {}
        done();
        await refresh({ silent: true });
        toast('Moved', 'ok');
      } catch (err) { failed(err); }
      return;
    }

    const changes = [];
    moving.forEach((m) => {
      const newPath = isFolder ? targetPath + m.path.slice(entry.path.length) : targetPath;
      changes.push({ path: newPath, sha: m.sha });
      changes.push({ path: m.path, delete: true });
    });

    const done = busy('Moving…');
    const verb = U.dirname(entry.path) === U.dirname(targetPath) ? 'Renaming' : 'Moving';
    const note = toast(verb + ' ' + rel(entry.path) + '…', 'info', { sticky: true, spinner: true });
    setRowsBusy(moving.map((m) => m.path).concat(entry.path), true);
    try {
      await GH.commitBatch(changes, message);
      const wasOpen = state.current && (state.current.path === entry.path ||
        (isFolder && state.current.path.startsWith(entry.path + '/')));
      const newCurrent = wasOpen
        ? (isFolder ? targetPath + state.current.path.slice(entry.path.length) : targetPath)
        : null;

      moving.forEach((m) => clearDraft(m.path));
      if (state.doc && wasOpen && !isFolder) { state.doc.path = targetPath; }
      done();
      state.busyPaths.clear();
      await refresh({ silent: true });
      if (newCurrent && state.byPath.has(newCurrent)) {
        state.current = null;
        openPath(newCurrent);
      }
      note.done(verb === 'Renaming' ? 'Renamed' : 'Moved');
    } catch (err) {
      note.close();
      state.busyPaths.clear();
      renderTree();
      failed(err);
    }
  }

  async function duplicateNote(entry) {
    const done = busy('Duplicating…');
    const note = toast('Duplicating ' + rel(entry.path) + '…', 'info', { sticky: true, spinner: true });
    setRowsBusy(entry.path, true);
    try {
      const text = await GH.getBlobText(entry.sha);
      const target = uniquePath(U.joinPath(entry.dir, U.stem(entry.name) + ' copy.md'));
      await GH.putFile(target, U.b64encode(text), null, 'Duplicate ' + rel(entry.path));
      done();
      state.busyPaths.clear();
      await refresh({ silent: true });
      openPath(target);
      note.done('Duplicated');
    } catch (err) {
      note.close();
      state.busyPaths.clear();
      renderTree();
      failed(err);
    }
  }

  async function deleteEntry(entry) {
    const isFolder = entry.type === 'tree';
    const victims = isFolder
      ? state.entries.filter((e) => e.type !== 'tree' && e.path.startsWith(entry.path + '/'))
      : [entry];

    if (entry.pending) {
      state.entries = state.entries.filter((e) => e.path !== entry.path);
      reindex();
      clearDraft(entry.path);
      state.doc = null;
      showEmpty();
      renderTree();
      return;
    }

    const ok = await confirmModal({
      title: isFolder ? 'Delete this folder?' : 'Delete ' + (U.isMd(entry.path) ? 'note' : 'file') + '?',
      subtitle: isFolder
        ? rel(entry.path) + ' and ' + victims.length + (victims.length === 1 ? ' item' : ' items') + ' inside it.'
        : rel(entry.path),
      body: 'It is removed from the branch in a new commit. Git keeps the history, so it can still be recovered from GitHub.'
    });
    if (!ok) return;

    const done = busy('Deleting…');
    const note = toast('Deleting ' + rel(entry.path) +
      (victims.length > 1 ? ' (' + victims.length + ' items)…' : '…'),
      'info', { sticky: true, spinner: true });
    setRowsBusy(victims.map((v) => v.path).concat(entry.path), true);
    try {
      if (victims.length === 1 && !isFolder) {
        await GH.deleteFile(victims[0].path, victims[0].sha, 'Delete ' + rel(victims[0].path));
      } else {
        // Include the folder's .gitkeep, which isn't in our filtered entry list.
        await GH.commitBatch(victims.map((v) => ({ path: v.path, delete: true })),
          'Delete ' + rel(entry.path));
      }
      victims.forEach((v) => {
        clearDraft(v.path);
        const url = state.assetUrls.get(v.path);
        if (url) { URL.revokeObjectURL(url); state.assetUrls.delete(v.path); }
      });
      const hitCurrent = state.current && (state.current.path === entry.path ||
        state.current.path.startsWith(entry.path + '/'));
      if (hitCurrent) { state.doc = null; showEmpty(); }
      done();
      state.busyPaths.clear();
      await refresh({ silent: true });
      note.done('Deleted');
    } catch (err) {
      state.busyPaths.clear();
      renderTree();
      if (err.status === 422 && !isFolder) {
        // Stale sha — re-read and retry once.
        try {
          const fresh = await GH.getFile(entry.path);
          await GH.deleteFile(entry.path, fresh.sha, 'Delete ' + rel(entry.path));
          await refresh({ silent: true });
          note.done('Deleted');
          return;
        } catch (e2) { note.close(); failed(e2); return; }
      }
      note.close();
      failed(err);
    }
  }

  async function downloadEntry(entry) {
    const done = busy('Preparing…');
    const note = toast('Preparing ' + entry.name + '…', 'info', { sticky: true, spinner: true });
    try {
      const blob = await GH.getBlobBinary(entry.sha);
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: entry.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      done();
      note.done('Downloaded ' + entry.name);
    } catch (err) { note.close(); failed(err); }
  }

  /* =======================================================================
     Uploads
     ======================================================================= */
  async function uploadFiles(fileList, dir, opts) {
    opts = opts || {};
    const files = Array.from(fileList || []);
    if (!files.length) return [];
    dir = dir || currentDir();

    const tooBig = files.filter((f) => f.size > MAX_UPLOAD);
    if (tooBig.length) {
      toast(tooBig[0].name + ' is ' + U.formatBytes(tooBig[0].size) + ' — over the ' + U.formatBytes(MAX_UPLOAD) + ' limit for the GitHub API.', 'err');
      if (tooBig.length === files.length) return [];
    }
    const queue = files.filter((f) => f.size <= MAX_UPLOAD);
    const heavy = queue.reduce((s, f) => s + f.size, 0) > WARN_UPLOAD;

    const total = queue.reduce((s, f) => s + f.size, 0);
    const done = busy('Uploading ' + queue.length + (queue.length === 1 ? ' file…' : ' files…'));
    const label = queue.length === 1 ? queue[0].name : queue.length + ' files';
    const note = toast('Reading ' + label + '…' + (heavy ? ' (' + U.formatBytes(total) + ')' : ''),
      'info', { sticky: true, spinner: true });

    try {
      const changes = [];
      const created = [];
      const taken = new Set();
      for (const f of queue) {
        const name = U.sanitizeName(f.name) || ('file-' + Date.now());
        const path = uniquePath(U.joinPath(dir, name), taken);
        taken.add(path);
        changes.push({ path, contentB64: await U.readFileAsB64(f) });
        created.push(path);
        if (queue.length > 1) note.update('Reading ' + created.length + ' of ' + queue.length + '…');
      }
      const msg = queue.length === 1
        ? 'Upload ' + rel(created[0])
        : 'Upload ' + queue.length + ' files to ' + (rel(dir) || GH.cfg.root);

      note.update('Uploading ' + label + '…');
      if (changes.length === 1) {
        await GH.putFile(changes[0].path, changes[0].contentB64, null, msg);
      } else {
        await GH.commitBatch(changes, msg, (n, of) =>
          note.update('Uploading ' + n + ' of ' + of + '…'));
      }

      note.update('Committing…');
      done();
      await refresh({ silent: true });
      if (dir !== vaultRoot()) state.open.add(dir);
      renderTree();
      if (opts.quiet) note.close();
      else note.done(queue.length + (queue.length === 1 ? ' file uploaded' : ' files uploaded'));
      return created;
    } catch (err) { note.close(); failed(err); return []; }
  }

  /* =======================================================================
     Context menus
     ======================================================================= */
  function folderMenu(anchor, node) {
    const entry = state.byPath.get(node.path) ||
      { path: node.path, name: node.name, dir: U.dirname(node.path), type: 'tree' };
    contextMenu(anchor, [
      { label: 'New note here', icon: 'plus', onClick: () => newNote(node.path) },
      { label: 'New folder', icon: 'folder-plus', onClick: () => newFolder(node.path) },
      { label: 'Upload here', icon: 'upload', onClick: () => pickFiles(node.path) },
      'sep',
      { label: 'Rename', icon: 'edit', onClick: () => renameEntry(entry) },
      { label: 'Copy path', icon: 'copy', onClick: () => copyPath(node.path) },
      { label: 'Open on GitHub', icon: 'github', onClick: () => window.open(GH.repoUrl + '/tree/' + GH.cfg.branch + '/' + node.path, '_blank') },
      'sep',
      { label: 'Delete folder', icon: 'trash', danger: true, onClick: () => deleteEntry(entry) }
    ]);
  }

  function fileMenu(anchor, entry) {
    const isNote = U.isMd(entry.path);
    const items = [
      { label: 'Open', icon: isNote ? 'note' : 'file', onClick: () => openPath(entry.path) },
      { label: 'Rename', icon: 'edit', onClick: () => renameEntry(entry) }
    ];
    if (isNote && !entry.pending) items.push({ label: 'Duplicate', icon: 'copy', onClick: () => duplicateNote(entry) });
    items.push({ label: 'Move to folder…', icon: 'folder', onClick: () => moveToFolder(entry) });
    items.push('sep');
    items.push({ label: 'Copy path', icon: 'copy', onClick: () => copyPath(entry.path) });
    if (!isNote) items.push({ label: 'Copy markdown embed', icon: 'link', onClick: () => copyEmbed(entry) });
    if (!entry.pending) {
      items.push({ label: 'Download', icon: 'download', onClick: () => downloadEntry(entry) });
      items.push({ label: 'Open on GitHub', icon: 'github', onClick: () => window.open(GH.blobUrl(entry.path), '_blank') });
    }
    items.push('sep');
    items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteEntry(entry) });
    contextMenu(anchor, items);
  }

  async function copyPath(path) {
    const ok = await U.copyText(rel(path));
    toast(ok ? 'Path copied: ' + rel(path) : 'Could not copy', ok ? 'ok' : 'err');
  }

  async function copyEmbed(entry) {
    const kind = U.fileKind(entry.path);
    const r = rel(entry.path);
    const md = kind === 'image' || kind === 'video' || kind === 'audio'
      ? '![' + U.stem(entry.name) + '](' + r + ')'
      : '[' + entry.name + '](' + r + ')';
    const ok = await U.copyText(md);
    toast(ok ? 'Markdown copied' : 'Could not copy', ok ? 'ok' : 'err');
  }

  async function moveToFolder(entry) {
    const folders = [vaultRoot()].concat(
      state.entries.filter((e) => e.type === 'tree').map((e) => e.path)
    ).filter((p, i, a) => a.indexOf(p) === i && p !== entry.dir);

    if (!folders.length) return toast('No other folders yet — create one first.', 'info');
    const res = await modal({
      title: 'Move to folder',
      subtitle: rel(entry.path),
      icon: 'folder',
      confirmText: 'Move',
      fields: [{
        name: 'dir', label: 'Destination folder',
        hint: 'existing: ' + folders.map((f) => rel(f) || '/').join(', '),
        value: rel(folders[0]), placeholder: 'Projects/2026'
      }],
      validate: (v) => {
        const target = U.joinPath(abs(v.dir), entry.name);
        if (state.byPath.has(target)) return 'Something with that name is already in there.';
        return null;
      }
    });
    if (!res) return;
    const dest = U.joinPath(abs(U.sanitizeName(res.dir, { allowSlash: true })), entry.name);
    await movePaths(entry, dest, 'Move ' + rel(entry.path) + ' → ' + rel(dest));
  }

  /* =======================================================================
     Chrome wiring
     ======================================================================= */
  function wireChrome() {
    $('#btn-refresh').addEventListener('click', () => refresh());
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-new-note').addEventListener('click', () => newNote());
    $('#empty-new').addEventListener('click', () => newNote());
    $('#btn-new-folder').addEventListener('click', () => newFolder());
    $('#btn-upload').addEventListener('click', () => pickFiles());
    $('#empty-upload').addEventListener('click', () => pickFiles());
    $('#btn-omni').addEventListener('click', () => openPalette());
    $('#btn-save').addEventListener('click', () => saveNote());
    $('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

    $('#btn-doc-menu').addEventListener('click', (e) => {
      if (!state.doc) return;
      const entry = state.byPath.get(state.doc.path);
      if (entry) fileMenu(e.currentTarget, entry);
    });
    $('#btn-file-menu').addEventListener('click', (e) => {
      const entry = state.current && state.byPath.get(state.current.path);
      if (entry) fileMenu(e.currentTarget, entry);
    });
    $('#btn-file-copy').addEventListener('click', () => state.current && copyPath(state.current.path));
    $('#btn-file-download').addEventListener('click', () => {
      const entry = state.current && state.byPath.get(state.current.path);
      if (entry) downloadEntry(entry);
    });

    $$('#mode-seg .seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    $('#tree-filter').addEventListener('input', U.debounce((e) => {
      state.filter = e.target.value;
      renderTree();
    }, 130));

    $$('#kind-chips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('#kind-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
        state.kindFilter = chip.dataset.kind;
        renderTree();
      });
    });

    $('#file-input').addEventListener('change', async (e) => {
      const dir = $('#file-input').dataset.dir || currentDir();
      await uploadFiles(e.target.files, dir);
      e.target.value = '';
    });

    $('#lb-close').addEventListener('click', () => { $('#lightbox').hidden = true; });
    $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });

    // sidebar resize
    const resizer = $('#resizer');
    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.min(520, Math.max(200, e.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      ui.sidebar = w;
      saveUI();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });

    window.addEventListener('beforeunload', (e) => {
      if (state.doc && state.doc.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function pickFiles(dir) {
    const input = $('#file-input');
    input.dataset.dir = dir || currentDir();
    input.click();
  }

  function setMode(mode, silent) {
    state.mode = mode;
    ui.mode = mode;
    if (!silent) saveUI();
    $('#doc-body').dataset.mode = mode;
    $$('#mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode !== 'edit' && state.doc) renderPreview();
    if (mode !== 'preview') $('#toc').hidden = true;
  }

  const focusEditor = () => setTimeout(() => $('#editor').focus(), 40);

  function updateCount() {
    if (!state.doc) return;
    const words = MD.countWords(state.doc.text);
    $('#editor-count').textContent = words + (words === 1 ? ' word' : ' words') +
      ' · ' + state.doc.text.length + ' chars';
  }

  /* =======================================================================
     Editor
     ======================================================================= */
  function wireEditor() {
    const ed = $('#editor');

    ed.addEventListener('input', () => {
      if (!state.doc) return;
      state.doc.text = ed.value;
      markDirty();
      saveDraft();
      updateCount();
      if (state.mode === 'split') renderPreviewSoon();
    });

    ed.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); return wrapSelection('**', '**', 'bold text'); }
        if (k === 'i') { e.preventDefault(); return wrapSelection('*', '*', 'italic'); }
        if (k === 'k') { e.preventDefault(); return insertLink(); }
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        return e.shiftKey ? outdent() : indent();
      }
      if (e.key === 'Enter' && !e.shiftKey) continueList(e);
    });

    ed.addEventListener('paste', onEditorPaste);

    // split-view scroll sync
    let lock = false;
    ed.addEventListener('scroll', () => {
      if (state.mode !== 'split' || lock) return;
      lock = true;
      const pv = $('#preview-wrap');
      const ratio = ed.scrollTop / Math.max(1, ed.scrollHeight - ed.clientHeight);
      pv.scrollTop = ratio * Math.max(0, pv.scrollHeight - pv.clientHeight);
      requestAnimationFrame(() => { lock = false; });
    });

    $('#md-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-md]');
      if (!btn) return;
      ed.focus();
      applyToolbar(btn.dataset.md);
    });
  }

  function sel() {
    const ed = $('#editor');
    return { ed, start: ed.selectionStart, end: ed.selectionEnd, value: ed.value };
  }

  function replaceRange(start, end, text, selStart, selEnd) {
    const ed = $('#editor');
    ed.setRangeText(text, start, end, 'preserve');
    if (selStart !== undefined) ed.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function wrapSelection(before, after, placeholder) {
    const { start, end, value } = sel();
    const chosen = value.slice(start, end) || placeholder || '';
    const already = value.slice(start - before.length, start) === before &&
                    value.slice(end, end + after.length) === after;
    if (already) {
      replaceRange(start - before.length, end + after.length, chosen, start - before.length, end - before.length);
      return;
    }
    replaceRange(start, end, before + chosen + after,
      start + before.length, start + before.length + chosen.length);
  }

  function linePrefix(prefix, toggle) {
    const { start, end, value } = sel();
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to === -1) to = value.length;
    const lines = value.slice(from, to).split('\n');
    const on = lines.every((l) => l.startsWith(prefix));
    const out = lines.map((l, i) => {
      const p = typeof prefix === 'function' ? prefix(i) : prefix;
      return on && toggle !== false ? l.slice(p.length) : p + l;
    }).join('\n');
    replaceRange(from, to, out, from, from + out.length);
  }

  function indent() {
    const { start, end, value } = sel();
    if (start === end) return replaceRange(start, end, '  ', start + 2);
    linePrefix('  ', false);
  }

  function outdent() {
    const { start, end, value } = sel();
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to === -1) to = value.length;
    const out = value.slice(from, to).split('\n').map((l) => l.replace(/^ {1,2}/, '')).join('\n');
    replaceRange(from, to, out, from, from + out.length);
  }

  /** Continue (or close out) lists and quotes on Enter. */
  function continueList(e) {
    const { start, end, value } = sel();
    if (start !== end) return;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const line = value.slice(from, start);
    const m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?\s+(.*)$/);
    const q = line.match(/^(\s*>\s?)(.*)$/);

    if (m) {
      e.preventDefault();
      if (!m[4].trim()) {                                 // empty item → end the list
        return replaceRange(from, start, m[1], from + m[1].length);
      }
      const marker = /\d/.test(m[2]) ? (parseInt(m[2], 10) + 1) + m[2].slice(-1) : m[2];
      const task = m[3] ? ' [ ]' : '';
      const ins = '\n' + m[1] + marker + task + ' ';
      return replaceRange(start, start, ins, start + ins.length);
    }
    if (q) {
      e.preventDefault();
      if (!q[2].trim()) return replaceRange(from, start, '', from);
      const ins = '\n' + q[1];
      return replaceRange(start, start, ins, start + ins.length);
    }
  }

  function insertLink() {
    const { start, end, value } = sel();
    const chosen = value.slice(start, end);
    if (/^https?:\/\//i.test(chosen)) {
      return replaceRange(start, end, '[](' + chosen + ')', start + 1, start + 1);
    }
    const text = chosen || 'link text';
    const ins = '[' + text + '](url)';
    replaceRange(start, end, ins, start + ins.length - 4, start + ins.length - 1);
  }

  function applyToolbar(kind) {
    switch (kind) {
      case 'h': return linePrefix('#', true);
      case 'bold': return wrapSelection('**', '**', 'bold text');
      case 'italic': return wrapSelection('*', '*', 'italic');
      case 'strike': return wrapSelection('~~', '~~', 'struck');
      case 'code': return wrapSelection('`', '`', 'code');
      case 'link': return insertLink();
      case 'quote': return linePrefix('> ', true);
      case 'ul': return linePrefix('- ', true);
      case 'ol': return linePrefix((i) => (i + 1) + '. ', true);
      case 'task': return linePrefix('- [ ] ', true);
      case 'fence': {
        const { start, end, value } = sel();
        const chosen = value.slice(start, end) || 'code here';
        const ins = '```\n' + chosen + '\n```\n';
        return replaceRange(start, end, ins, start + 3, start + 3);
      }
      case 'table': {
        const { start } = sel();
        const ins = '\n| Column | Column |\n| --- | --- |\n| value | value |\n\n';
        return replaceRange(start, start, ins, start + ins.length);
      }
      case 'hr': {
        const { start } = sel();
        const ins = '\n---\n\n';
        return replaceRange(start, start, ins, start + ins.length);
      }
    }
  }

  /** Pasting an image uploads it into the vault and links it. */
  async function onEditorPaste(e) {
    if (!state.doc) return;
    const items = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!items.length) return;
    e.preventDefault();

    const named = items.map((f) => {
      if (f.name && f.name !== 'image.png') return f;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], 'pasted-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext, { type: f.type });
    });

    const dir = abs(ASSET_DIR);
    const created = await uploadFiles(named, dir, { quiet: true });
    if (!created.length) return;
    const snippets = created.map((p) => {
      const r = relativeFrom(U.dirname(state.doc.path), p);
      return U.fileKind(p) === 'image' ? '![' + U.stem(p) + '](' + r + ')' : '[' + U.basename(p) + '](' + r + ')';
    }).join('\n');
    const { start, end } = sel();
    replaceRange(start, end, snippets + '\n', start + snippets.length + 1);
    toast('Uploaded and linked', 'ok');
  }

  /** Path of `toPath` as seen from directory `fromDir`. */
  function relativeFrom(fromDir, toPath) {
    const a = fromDir ? fromDir.split('/') : [];
    const b = toPath.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    const up = a.length - i;
    return (up ? new Array(up).fill('..').join('/') + '/' : '') + b.slice(i).join('/');
  }

  /* =======================================================================
     Command palette — quick open, content search, commands
     ======================================================================= */
  const contentCache = new Map();
  let paletteItems = [];
  let paletteIndex = 0;

  function commands() {
    return [
      { label: 'New note', icon: 'plus', run: () => newNote() },
      { label: 'New folder', icon: 'folder-plus', run: () => newFolder() },
      { label: 'Upload files', icon: 'upload', run: () => pickFiles() },
      { label: 'Save note', icon: 'save', run: () => saveNote() },
      { label: 'Toggle editor / preview', icon: 'split', run: () => setMode(state.mode === 'edit' ? 'preview' : 'edit') },
      { label: 'Split view', icon: 'split', run: () => setMode('split') },
      { label: 'Refresh from GitHub', icon: 'refresh', run: () => refresh() },
      { label: 'Search inside all notes', icon: 'search', run: () => indexAllNotes(true) },
      { label: 'Open repo on GitHub', icon: 'github', run: () => window.open(GH.repoUrl, '_blank') },
      { label: 'Settings', icon: 'settings', run: openSettings }
    ];
  }

  function wirePalette() {
    const box = $('#palette');
    const input = $('#palette-q');

    box.addEventListener('mousedown', (e) => { if (e.target === box) closePalette(); });
    input.addEventListener('input', () => renderPalette(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return closePalette();
      if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if ((e.metaKey || e.ctrlKey) && input.value.trim()) return createFromPalette(input.value.trim());
        const item = paletteItems[paletteIndex];
        if (item) { closePalette(); item.run(); }
      }
    });
  }

  function openPalette(prefill) {
    const box = $('#palette');
    box.hidden = false;
    const input = $('#palette-q');
    input.value = prefill || '';
    renderPalette(input.value);
    setTimeout(() => { input.focus(); input.select(); }, 20);
  }

  function closePalette() { $('#palette').hidden = true; }

  function movePalette(delta) {
    if (!paletteItems.length) return;
    paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
    const rows = $$('#palette-list .p-item');
    rows.forEach((r, i) => r.classList.toggle('sel', i === paletteIndex));
    const sel = rows[paletteIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  /** Subsequence match — "prj26" finds "Projects/2026.md". */
  function fuzzy(needle, hay) {
    const n = needle.toLowerCase(), h = hay.toLowerCase();
    if (!n) return { score: 0, marks: [] };
    let i = 0, score = 0, streak = 0;
    const marks = [];
    for (let j = 0; j < h.length && i < n.length; j++) {
      if (h[j] === n[i]) {
        marks.push(j);
        streak++;
        score += 1 + streak + (j === 0 || /[\/\s\-_.]/.test(h[j - 1]) ? 4 : 0);
        i++;
      } else streak = 0;
    }
    return i === n.length ? { score, marks } : null;
  }

  function highlight(text, marks) {
    if (!marks || !marks.length) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    let last = 0;
    marks.forEach((m) => {
      if (m > last) frag.appendChild(document.createTextNode(text.slice(last, m)));
      frag.appendChild(el('mark', { text: text[m] }));
      last = m + 1;
    });
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderPalette(q) {
    q = (q || '').trim();
    const list = $('#palette-list');
    list.innerHTML = '';
    paletteItems = [];
    paletteIndex = 0;

    if (q.startsWith('>')) {
      const needle = q.slice(1).trim();
      commands()
        .map((c) => ({ c, m: needle ? fuzzy(needle, c.label) : { score: 0, marks: [] } }))
        .filter((x) => x.m)
        .sort((a, b) => b.m.score - a.m.score)
        .forEach(({ c, m }) => addRow(list, c.icon, highlight(c.label, m.marks), '', c.run));
      if (!paletteItems.length) list.appendChild(el('div', { class: 'p-group', text: 'No matching command' }));
      return markSelection();
    }

    const tag = q.startsWith('#') ? q.slice(1).toLowerCase() : null;

    // --- files by path ---
    const files = state.entries.filter((e) => e.type !== 'tree' && !e.hidden);
    let scored;
    if (tag) {
      scored = files.filter((e) => {
        const text = contentCache.get(e.path);
        if (!text) return false;
        const fm = MD.parseFrontmatter(text).attrs;
        const tags = fm ? [].concat(fm.tags || fm.tag || []) : [];
        return tags.some((t) => String(t).toLowerCase() === tag);
      }).map((e) => ({ e, m: { score: 10, marks: [] } }));
    } else {
      scored = files.map((e) => {
        const label = rel(e.path);
        const m = q ? fuzzy(q, label) : { score: 0, marks: [] };
        return m ? { e, m, label } : null;
      }).filter(Boolean).sort((a, b) => b.m.score - a.m.score);
    }

    if (scored.length) {
      list.appendChild(el('div', { class: 'p-group', text: tag ? 'Tagged #' + tag : 'Files' }));
      scored.slice(0, 40).forEach(({ e, m }) => {
        const label = rel(e.path);
        const name = U.isMd(e.path) ? U.stem(e.name) : e.name;
        const dir = U.dirname(label);
        addRow(list, U.isMd(e.path) ? 'note' : (U.fileKind(e.path) === 'image' ? 'image' : 'file'),
          q && !tag ? highlight(label, m.marks) : document.createTextNode(name),
          q && !tag ? '' : dir, () => openPath(e.path));
      });
    }

    // --- matches inside note text we've already read ---
    if (q.length >= 2 && !tag) {
      const hits = [];
      contentCache.forEach((text, path) => {
        if (!state.byPath.has(path)) return;
        const idx = text.toLowerCase().indexOf(q.toLowerCase());
        if (idx === -1) return;
        const plain = MD.plainText(text);
        const pIdx = plain.toLowerCase().indexOf(q.toLowerCase());
        const snippet = pIdx === -1 ? plain.slice(0, 90)
          : plain.slice(Math.max(0, pIdx - 34), pIdx + 60);
        hits.push({ path, snippet: (pIdx > 34 ? '…' : '') + snippet + '…' });
      });
      if (hits.length) {
        list.appendChild(el('div', { class: 'p-group', text: 'In note text' }));
        hits.slice(0, 12).forEach((h) => addRow(list, 'search',
          document.createTextNode(U.stem(U.basename(h.path))), h.snippet, () => openPath(h.path)));
      }
      if (contentCache.size < state.entries.filter((e) => e.kind === 'note').length) {
        list.appendChild(el('div', { class: 'p-group', text: 'Deeper search' }));
        addRow(list, 'bolt', document.createTextNode('Search inside every note…'),
          'reads each note once, then searches instantly', () => indexAllNotes(true, q));
      }
    }

    if (q && !scored.length) {
      list.appendChild(el('div', { class: 'p-group', text: 'Create' }));
      addRow(list, 'plus', document.createTextNode('New note “' + q + '”'), '', () => createFromPalette(q));
    }
    if (!q) {
      list.appendChild(el('div', { class: 'p-group', text: 'Commands — type > to filter' }));
      commands().slice(0, 5).forEach((c) => addRow(list, c.icon, document.createTextNode(c.label), '', c.run));
    }
    markSelection();
  }

  function addRow(list, ic, labelNode, sub, run) {
    const row = el('div', { class: 'p-item' }, [icon(ic), el('span', { class: 'p-name' })]);
    row.querySelector('.p-name').appendChild(labelNode);
    if (sub) row.appendChild(el('span', { class: 'p-path', text: sub }));
    const index = paletteItems.length;
    row.addEventListener('click', () => { closePalette(); run(); });
    row.addEventListener('mousemove', () => {
      paletteIndex = index;
      $$('#palette-list .p-item').forEach((r, i) => r.classList.toggle('sel', i === index));
    });
    list.appendChild(row);
    paletteItems.push({ run });
  }

  function markSelection() {
    const rows = $$('#palette-list .p-item');
    rows.forEach((r, i) => r.classList.toggle('sel', i === paletteIndex));
  }

  async function createFromPalette(q) {
    closePalette();
    const name = U.sanitizeName(q.replace(/^[>#]/, '').trim());
    if (!name) return newNote();
    await newNote();
    if (!state.doc) return;
    const text = '# ' + name + '\n\n';
    $('#editor').value = text;
    state.doc.text = text;
    markDirty();
    updateCount();
    $('#editor').setSelectionRange(text.length, text.length);
  }

  /** Read every note once so content search is instant afterwards. */
  async function indexAllNotes(announce, thenQuery) {
    const notes = state.entries.filter((e) => e.kind === 'note' && !e.pending && !e.hidden && !contentCache.has(e.path));
    if (!notes.length) {
      if (announce) toast('All notes are already indexed', 'ok');
      if (thenQuery !== undefined) renderPalette(thenQuery);
      return;
    }
    const done = busy('Indexing ' + notes.length + ' notes…');
    const note = toast('Indexing 0 of ' + notes.length + '…', 'info', { sticky: true, spinner: true });
    let n = 0;
    for (const item of notes) {
      try { contentCache.set(item.path, await GH.getBlobText(item.sha)); n++; }
      catch (_) { /* skip unreadable blobs */ }
      note.update('Indexing ' + n + ' of ' + notes.length + '…');
    }
    done();
    note.done('Indexed ' + n + (n === 1 ? ' note' : ' notes') + ' — search is live now');
    if (thenQuery !== undefined) renderPalette(thenQuery);
  }

  /* =======================================================================
     Drag & drop — OS files in, notes between folders
     ======================================================================= */
  const DRAG_TYPE = 'application/x-mpf-path';
  let internalDrag = null;

  function makeDraggable(row, path, isFolder) {
    row.addEventListener('dragstart', (e) => {
      internalDrag = path;
      e.dataTransfer.setData(DRAG_TYPE, path);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      internalDrag = null;
      $$('.node.dropping').forEach((n) => n.classList.remove('dropping'));
    });
    if (!isFolder) return;

    row.addEventListener('dragover', (e) => {
      const hasFiles = Array.from(e.dataTransfer.types || []).includes('Files');
      if (!hasFiles && !internalDrag) return;
      if (internalDrag && (internalDrag === path || path.startsWith(internalDrag + '/'))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move';
      row.classList.add('dropping');
    });
    row.addEventListener('dragleave', () => row.classList.remove('dropping'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('dropping');
      $('#drop-overlay').hidden = true;
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        state.open.add(path);
        return uploadFiles(e.dataTransfer.files, path);
      }
      const src = e.dataTransfer.getData(DRAG_TYPE) || internalDrag;
      internalDrag = null;
      if (!src || src === path) return;
      const entry = state.byPath.get(src);
      if (!entry) return;
      const target = U.joinPath(path, entry.name);
      if (state.byPath.has(target)) return toast('“' + entry.name + '” is already in that folder', 'err');
      state.open.add(path);
      await movePaths(entry, target, 'Move ' + rel(src) + ' → ' + rel(target));
    });
  }

  function wireDnD() {
    let depth = 0;
    const overlay = $('#drop-overlay');
    const hasFiles = (e) => Array.from(e.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !state.ready) return;
      depth++;
      $('#drop-target').textContent = rel(currentDir()) || GH.cfg.root;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      uploadFiles(e.dataTransfer.files, currentDir());
    });

    // Drop onto blank sidebar space → vault root
    $('#tree').addEventListener('dragover', (e) => {
      if (e.target !== e.currentTarget) return;
      if (!hasFiles(e) && !internalDrag) return;
      e.preventDefault();
    });
    $('#tree').addEventListener('drop', async (e) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();
      overlay.hidden = true;
      if (e.dataTransfer.files && e.dataTransfer.files.length) return uploadFiles(e.dataTransfer.files, vaultRoot());
      const src = e.dataTransfer.getData(DRAG_TYPE) || internalDrag;
      internalDrag = null;
      const entry = src && state.byPath.get(src);
      if (!entry || entry.dir === vaultRoot()) return;
      const target = U.joinPath(vaultRoot(), entry.name);
      if (state.byPath.has(target)) return toast('“' + entry.name + '” is already at the root', 'err');
      await movePaths(entry, target, 'Move ' + rel(src) + ' → ' + rel(target));
    });
  }

  /* =======================================================================
     Settings
     ======================================================================= */
  function openSettings() {
    const accents = ['indigo', 'violet', 'emerald', 'amber', 'rose', 'cyan'];
    const colors = { indigo: '#6d8cff', violet: '#a978ff', emerald: '#2fd4a0', amber: '#f0a742', rose: '#ff7a9c', cyan: '#3fc9e8' };

    const accentRow = el('div', { class: 'accent-row' },
      accents.map((a) => el('button', {
        class: 'accent-dot' + (ui.accent === a ? ' active' : ''),
        style: 'background:' + colors[a], title: a, type: 'button',
        onclick: (e) => {
          applyAccent(a);
          e.target.parentNode.querySelectorAll('.accent-dot').forEach((d) => d.classList.remove('active'));
          e.target.classList.add('active');
        }
      })));

    const rate = GH.rate
      ? GH.rate.remaining + ' / ' + GH.rate.limit + ' API calls left this hour'
      : 'API usage unknown';

    const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' }, [
      el('div', { class: 'file-meta', style: 'grid-template-columns:1fr 1fr' }, [
        el('dl', {}, [el('dt', { text: 'Repository' }), el('dd', { text: GH.repoPath })]),
        el('dl', {}, [el('dt', { text: 'Branch' }), el('dd', { text: GH.cfg.branch })]),
        el('dl', {}, [el('dt', { text: 'Vault folder' }), el('dd', { text: GH.cfg.root || '(repo root)' })]),
        el('dl', {}, [el('dt', { text: 'GitHub API' }), el('dd', { text: rate })])
      ]),
      el('div', {}, [
        el('div', { class: 'field', style: 'margin-bottom:8px' }, [el('span', { text: 'Accent colour' })]),
        accentRow
      ]),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn sm', type: 'button',
          onclick: () => { U.closeMenus(); indexAllNotes(true); }
        }, [icon('bolt'), el('span', { text: 'Index notes for search' })]),
        el('button', {
          class: 'btn sm', type: 'button',
          onclick: () => window.open(GH.repoUrl + '/commits/' + GH.cfg.branch, '_blank')
        }, [icon('clock'), el('span', { text: 'Vault history' })])
      ]),
      el('div', { class: 'alert info' }, [
        el('span', { text: 'Your token lives only in this browser. Signing out erases it from this device.' })
      ])
    ]);

    modal({
      title: 'Settings', icon: 'settings', wide: true, body,
      actions: [
        { label: 'Sign out', value: 'signout', kind: 'danger' },
        { label: 'Done', value: 'done', kind: 'primary', primary: true }
      ]
    }).then((res) => {
      if (res === 'signout') signOut();
    });
  }

  async function signOut() {
    if (state.doc && state.doc.dirty) {
      const ok = await confirmModal({
        title: 'Sign out with unsaved changes?',
        subtitle: 'Your draft stays in this browser, but it is not on GitHub yet.',
        confirmText: 'Sign out anyway'
      });
      if (!ok) return;
    }
    state.assetUrls.forEach((url) => URL.revokeObjectURL(url));
    state.assetUrls.clear();
    contentCache.clear();
    GH.clearConfig();
    state.entries = [];
    state.doc = null;
    state.current = null;
    ui.last = '';
    saveUI();
    showSetup('Signed out. Your notes are safe in the repo.', 'info');
  }

  /* =======================================================================
     Shortcuts
     ======================================================================= */
  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      const inEditor = document.activeElement.id === 'editor';

      if (e.key === 'Escape') {
        if (!$('#palette').hidden) return closePalette();
        if (!$('#lightbox').hidden) return ($('#lightbox').hidden = true);
        U.closeMenus();
        $('#sidebar').classList.remove('open');
        return;
      }

      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); return saveNote(); }
      if (meta && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); return openPalette(); }
      if (meta && e.key.toLowerCase() === 'k' && !inEditor) { e.preventDefault(); return openPalette(); }
      if (meta && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        if (!state.doc) return;
        return setMode(state.mode === 'edit' ? 'preview' : 'edit');
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); return newNote(); }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); return pickFiles(); }

      if (!inField && !meta) {
        if (e.key === '/') { e.preventDefault(); return $('#tree-filter').focus(); }
        if (e.key === 'r') return refresh();
      }
    });
  }

  /* ------------------------------------------------------------------- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
