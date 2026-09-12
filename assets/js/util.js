/* =========================================================================
   util.js — DOM helpers, encoding, toasts, modals, context menus
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------- DOM */
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** Inline SVG referencing the sprite in index.html. */
  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------------------------------------------------- encoding */
  /** UTF-8 safe string -> base64 (GitHub wants base64 payloads). */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /** base64 -> UTF-8 string. */
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** ArrayBuffer -> base64, chunked so large files don't blow the stack. */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  const readFileAsB64 = (file) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(bufToB64(fr.result));
    fr.onerror = () => rej(fr.error || new Error('Could not read ' + file.name));
    fr.readAsArrayBuffer(file);
  });

  /* ---------------------------------------------------------- paths */
  const basename = (p) => String(p).split('/').filter(Boolean).pop() || '';
  const dirname  = (p) => { const parts = String(p).split('/'); parts.pop(); return parts.join('/'); };
  const extname  = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
  const stem     = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
  const isMd     = (p) => /\.(md|markdown|mdown|mkd)$/i.test(p);

  function joinPath() {
    return Array.prototype.slice.call(arguments)
      .filter((s) => s !== null && s !== undefined && s !== '')
      .join('/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
  }

  /** Resolve `rel` against directory `base`, collapsing . and .. */
  function resolvePath(base, rel) {
    if (/^\//.test(rel)) { base = ''; rel = rel.replace(/^\/+/, ''); }
    const out = base ? base.split('/').filter(Boolean) : [];
    rel.split('/').forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') out.pop();
      else out.push(part);
    });
    return out.join('/');
  }

  /** Keep file names safe for git + most filesystems. */
  function sanitizeName(name, opts) {
    const allowSlash = !!(opts && opts.allowSlash);
    let s = String(name || '').trim()
      .replace(/[\\:*?"<>|]/g, '-')          // illegal on Windows / awkward in git
      .replace(/\s+/g, ' ');
    s = allowSlash ? s.replace(/\/{2,}/g, '/') : s.replace(/\//g, '-');
    s = s.replace(/\.{2,}/g, '.')             // kill '..' traversal segments
         .replace(/(^|\/)[.\-\s]+/g, '$1')    // no segment starts with a dot or dash
         .trim();
    if (allowSlash) s = s.replace(/^\/+|\/+$/g, '');
    return s.slice(0, 180).trim();
  }

  function slugify(text) {
    return String(text).toLowerCase().trim()
      .replace(/[^\wÀ-￿\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  }

  /* ---------------------------------------------------------- format */
  function formatBytes(n) {
    if (n === 0 || n === null || n === undefined) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    const v = n / Math.pow(1024, i);
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }

  function timeAgo(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d)) return '';
    const secs = (Date.now() - d.getTime()) / 1000;
    if (secs < 45) return 'just now';
    const steps = [[60, 'min', 60], [24, 'hr', 3600], [7, 'day', 86400], [4.4, 'wk', 604800], [12, 'mo', 2629800]];
    for (const [limit, unit, div] of steps) {
      const v = secs / div;
      if (v < limit) { const r = Math.round(v); return r + ' ' + unit + (r === 1 ? '' : 's') + ' ago'; }
    }
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const fileKind = (path) => {
    const e = extname(path);
    if (isMd(path)) return 'note';
    if (/^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(e)) return 'image';
    if (/^(mp4|webm|mov|m4v|ogv)$/.test(e)) return 'video';
    if (/^(mp3|wav|ogg|m4a|flac|aac)$/.test(e)) return 'audio';
    if (e === 'pdf') return 'pdf';
    if (/^(txt|json|ya?ml|csv|tsv|xml|html?|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|sh|bash|zsh|sql|toml|ini|env|log|conf)$/.test(e)) return 'text';
    return 'other';
  };

  const debounce = (fn, ms) => {
    let t;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  };

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall through to legacy path */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  /* ---------------------------------------------------------- toasts */
  function toast(msg, kind, opts) {
    opts = opts || {};
    const root = $('#toasts');
    if (!root) return;
    const ic = kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info';
    const node = el('div', { class: 'toast ' + (kind || 'info') }, [
      icon(ic),
      el('span', { class: 't-msg', text: msg })
    ]);
    if (opts.action && opts.onAction) {
      node.appendChild(el('span', {
        class: 't-act', text: opts.action,
        onclick: () => { close(); opts.onAction(); }
      }));
    }
    root.appendChild(node);
    let timer = null;
    function close() {
      if (!node.isConnected) return;
      clearTimeout(timer);
      node.classList.add('out');
      setTimeout(() => node.remove(), 200);
    }
    node.addEventListener('click', (e) => { if (!e.target.closest('.t-act')) close(); });
    timer = setTimeout(close, opts.duration || (kind === 'err' ? 6500 : 3200));
    return close;
  }

  /* ---------------------------------------------------------- modal */
  /**
   * Generic modal. `fields` renders labelled inputs; resolves with a map of
   * values, or null when dismissed.
   */
  function modal(opts) {
    return new Promise((resolve) => {
      const fields = opts.fields || [];
      const inputs = {};
      let settled = false;

      const body = el('div', { class: 'modal-body' });
      if (opts.body) body.appendChild(typeof opts.body === 'string'
        ? el('p', { class: 'muted', text: opts.body, style: 'margin:0' })
        : opts.body);

      fields.forEach((f) => {
        const input = el('input', {
          type: f.type || 'text', value: f.value || '',
          placeholder: f.placeholder || '', spellcheck: 'false'
        });
        inputs[f.name] = input;
        body.appendChild(el('label', { class: 'field' }, [
          el('span', { html: f.label + (f.hint ? ' <em class="hint">' + escapeHtml(f.hint) + '</em>' : '') }),
          input
        ]));
        if (f.help) body.appendChild(el('div', { class: 'hint', style: 'margin-top:-6px;font-size:11.5px', text: f.help }));
      });

      const errBox = el('div', { class: 'alert error', hidden: true });
      body.appendChild(errBox);

      const okBtn = el('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'submit' },
        [opts.confirmText || 'Confirm']);
      const cancelBtn = el('button', { class: 'btn', type: 'button', onclick: () => done(null) },
        [opts.cancelText || 'Cancel']);

      // Explicit actions: each resolves with its own value; dismissing still gives null,
      // so Escape can never be mistaken for a destructive choice.
      const footButtons = opts.actions
        ? opts.actions.map((a) => el('button', {
            class: 'btn ' + (a.kind || ''), type: a.primary ? 'submit' : 'button',
            onclick: a.primary ? null : () => done(a.value)
          }, [a.label]))
        : [cancelBtn, okBtn];

      const form = el('form', { class: 'modal ' + (opts.wide ? 'wide' : '') }, [
        el('div', { class: 'modal-head' }, [
          opts.icon ? el('div', { class: 'modal-icon' + (opts.danger ? ' danger' : '') }, [icon(opts.icon)]) : null,
          el('div', {}, [
            el('h3', { text: opts.title || '' }),
            opts.subtitle ? el('p', { text: opts.subtitle }) : null
          ])
        ]),
        body,
        el('div', { class: 'modal-foot' }, footButtons)
      ]);

      const backdrop = el('div', { class: 'modal-backdrop' }, [form]);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = {};
        for (const k in inputs) values[k] = inputs[k].value.trim();
        if (opts.validate) {
          const err = opts.validate(values);
          if (err) {
            errBox.textContent = err;
            errBox.hidden = false;
            return;
          }
        }
        if (opts.actions) {
          const primary = opts.actions.find((a) => a.primary);
          return done(primary ? primary.value : true);
        }
        done(fields.length ? values : {});
      });
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) done(null); });

      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }
      document.addEventListener('keydown', onKey, true);

      function done(val) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(val);
      }

      $('#modal-root').appendChild(backdrop);
      const first = fields.length ? inputs[fields[0].name] : footButtons[footButtons.length - 1];
      setTimeout(() => {
        first.focus();
        if (first.select && fields[0] && fields[0].selectRange) {
          first.setSelectionRange(fields[0].selectRange[0], fields[0].selectRange[1]);
        } else if (first.select) first.select();
      }, 30);
    });
  }

  const confirmModal = (opts) => modal(Object.assign({
    icon: 'alert', danger: true, confirmText: 'Delete'
  }, opts)).then((r) => r !== null);

  /* ---------------------------------------------------------- context menu */
  /** items: [{label, icon, danger, onClick}] or 'sep' or {label, header:true} */
  function contextMenu(anchor, items) {
    closeMenus();
    const menu = el('div', { class: 'menu' });
    items.forEach((it) => {
      if (it === 'sep') { menu.appendChild(el('hr')); return; }
      if (it.header) { menu.appendChild(el('div', { class: 'menu-label', text: it.label })); return; }
      menu.appendChild(el('button', {
        class: it.danger ? 'danger' : '',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); closeMenus(); it.onClick(); }
      }, [it.icon ? icon(it.icon) : null, el('span', { text: it.label })]));
    });

    $('#menu-root').appendChild(menu);

    // Position under the anchor, flipping when it would overflow.
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 10);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 10) top = Math.max(10, r.top - mh - 6);
    menu.style.left = Math.max(10, left) + 'px';
    menu.style.top = top + 'px';

    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('resize', closeMenus);
      window.addEventListener('scroll', closeMenus, true);
    }, 0);

    function onDocDown(e) { if (!menu.contains(e.target)) closeMenus(); }
    function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); } }
    menu._cleanup = () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('resize', closeMenus);
      window.removeEventListener('scroll', closeMenus, true);
    };
    return menu;
  }

  function closeMenus() {
    $$('#menu-root .menu').forEach((m) => { if (m._cleanup) m._cleanup(); m.remove(); });
  }

  global.U = {
    $, $$, el, icon, escapeHtml,
    b64encode, b64decode, bufToB64, readFileAsB64,
    basename, dirname, extname, stem, isMd, joinPath, resolvePath, sanitizeName, slugify,
    formatBytes, timeAgo, fileKind, debounce, copyText,
    toast, modal, confirmModal, contextMenu, closeMenus
  };
})(window);
