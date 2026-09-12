/* =========================================================================
   markdown.js — render + enhance

   render()  turns markdown into sanitized HTML with a deliberate treatment
             for every block type (code, table, quote/callout, task list,
             media, heading, link…).
   enhance() wires the live behaviour those blocks need once they're in the
             DOM: copy buttons, private-repo image loading, internal links,
             checkbox write-back, lightbox, mermaid.
   ========================================================================= */
(function (global) {
  'use strict';

  const MERMAID_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js';
  const ALERTS = {
    NOTE: { cls: 'note', icon: 'info', title: 'Note' },
    TIP: { cls: 'tip', icon: 'bolt', title: 'Tip' },
    IMPORTANT: { cls: 'important', icon: 'alert', title: 'Important' },
    WARNING: { cls: 'warning', icon: 'alert', title: 'Warning' },
    CAUTION: { cls: 'caution', icon: 'alert', title: 'Caution' }
  };

  let slugCounts = Object.create(null);
  let headings = [];

  const esc = (s) => String(s)
    .replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ------------------------------------------------------------ renderer */
  const renderer = {
    /* ---- fenced code: language badge, copy, highlight, mermaid ---- */
    code(code, infostring) {
      const lang = (infostring || '').match(/\S*/)[0].toLowerCase();

      if (lang === 'mermaid') {
        return '<div class="mermaid-block" data-mermaid="1"><pre hidden>' + esc(code) + '</pre></div>';
      }

      let body;
      let shown = lang;
      try {
        if (lang && global.hljs && hljs.getLanguage(lang)) {
          body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } else if (global.hljs && !lang && code.length < 12000) {
          const auto = hljs.highlightAuto(code);
          body = auto.value;
          shown = auto.language || 'text';
        } else {
          body = esc(code);
        }
      } catch (_) { body = esc(code); }

      return '<div class="code-block">' +
        '<div class="code-head">' +
          '<span class="code-lang">' + esc(shown || 'text') + '</span>' +
          '<span class="grow"></span>' +
          '<button class="code-btn" type="button" data-act="wrap" title="Toggle soft wrap">wrap</button>' +
          '<button class="code-btn" type="button" data-act="copy">copy</button>' +
        '</div>' +
        '<pre><code class="hljs' + (lang ? ' language-' + esc(lang) : '') + '">' + body + '</code></pre>' +
      '</div>';
    },

    /* ---- headings: stable ids + hover anchor + TOC entry ---- */
    heading(text, level, raw) {
      const base = U.slugify(String(raw).replace(/<[^>]+>/g, ''));
      slugCounts[base] = (slugCounts[base] || 0) + 1;
      const id = slugCounts[base] > 1 ? base + '-' + slugCounts[base] : base;
      headings.push({ id, level, text: String(raw).replace(/<[^>]+>/g, '').replace(/[#*`_]/g, '').trim() });
      return '<h' + level + ' id="' + id + '">' +
        '<a class="anchor" href="#' + id + '" aria-label="Link to this section">#</a>' +
        text + '</h' + level + '>';
    },

    /* ---- tables scroll inside their own box ---- */
    table(header, body) {
      return '<div class="table-wrap"><table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>';
    },

    /* ---- blockquote, upgraded to a callout for GitHub alert syntax ---- */
    blockquote(quote) {
      const m = quote.match(/^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>|\n)?/i);
      if (!m) return '<blockquote>' + quote + '</blockquote>';
      const a = ALERTS[m[1].toUpperCase()];
      let rest = quote.slice(m[0].length);
      if (!/^\s*<\/p>/.test(rest)) rest = '<p>' + rest;
      else rest = rest.replace(/^\s*<\/p>\s*/, '');
      return '<div class="callout ' + a.cls + '" data-icon="' + a.icon + '">' +
        '<div class="cal-body"><div class="cal-title">' + a.title + '</div>' + rest + '</div></div>';
    },

    checkbox(checked) {
      return '<input type="checkbox" ' + (checked ? 'checked ' : '') + 'data-task="1">';
    },

    listitem(text, task, checked) {
      if (!task) return '<li>' + text + '</li>';
      const m = text.match(/^\s*<input[^>]*>/);
      const box = m ? m[0] : '';
      const rest = m ? text.slice(m[0].length) : text;
      return '<li class="task-item' + (checked ? ' done' : '') + '">' + box + '<span>' + rest + '</span></li>';
    },

    list(body, ordered, start) {
      const tag = ordered ? 'ol' : 'ul';
      const cls = body.indexOf('task-item') !== -1 ? ' class="task-list"' : '';
      const st = ordered && start !== 1 ? ' start="' + start + '"' : '';
      return '<' + tag + cls + st + '>' + body + '</' + tag + '>';
    },

    /* ---- links: external vs in-vault ---- */
    link(href, title, text) {
      const h = String(href || '');
      const t = title ? ' title="' + esc(title) + '"' : '';
      if (/^#/.test(h)) return '<a href="' + esc(h) + '"' + t + '>' + text + '</a>';
      if (/^(https?:|mailto:|tel:)/i.test(h)) {
        return '<a class="ext-link" href="' + esc(h) + '"' + t + ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
      }
      // Relative — resolved against the note's folder when it's clicked.
      return '<a class="internal" href="#" data-rel="' + esc(h) + '"' + t + '>' + text + '</a>';
    },

    /* ---- images / media stored in the repo ---- */
    image(href, title, text) {
      const h = String(href || '');
      const alt = esc(text || '');
      const cap = title ? '<figcaption class="md-img-cap">' + esc(title) + '</figcaption>' : '';
      const kind = U.fileKind(h);

      if (/^(https?:|data:)/i.test(h)) {
        return '<figure><img class="md-img" src="' + esc(h) + '" alt="' + alt + '" loading="lazy">' + cap + '</figure>';
      }
      if (kind === 'video') return '<video class="md-video" controls preload="metadata" data-src="' + esc(h) + '"></video>';
      if (kind === 'audio') return '<audio class="md-audio" controls preload="metadata" data-src="' + esc(h) + '"></audio>';
      return '<figure><img class="md-img loading" alt="' + alt + '" data-src="' + esc(h) + '"></figure>';
    }
  };

  if (global.marked) {
    marked.use({ gfm: true, breaks: false, pedantic: false, renderer });
  }

  /* ------------------------------------------------------------ frontmatter */
  /** Minimal YAML frontmatter: scalars, inline [a, b] lists and `- item` lists. */
  function parseFrontmatter(text) {
    const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { attrs: null, body: text, length: 0 };
    const attrs = {};
    let key = null;
    m[1].split(/\r?\n/).forEach((line) => {
      if (/^\s*#/.test(line) || !line.trim()) return;
      const item = line.match(/^\s*-\s+(.*)$/);
      if (item && key) {
        if (!Array.isArray(attrs[key])) attrs[key] = attrs[key] ? [attrs[key]] : [];
        attrs[key].push(unquote(item[1]));
        return;
      }
      const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!kv) return;
      key = kv[1];
      const val = kv[2].trim();
      if (val === '') { attrs[key] = ''; return; }
      const inline = val.match(/^\[(.*)\]$/);
      attrs[key] = inline
        ? inline[1].split(',').map((s) => unquote(s.trim())).filter(Boolean)
        : unquote(val);
    });
    return { attrs, body: text.slice(m[0].length), length: m[0].length };
  }

  const unquote = (s) => String(s).replace(/^['"]|['"]$/g, '').trim();

  /* ------------------------------------------------------------ render */
  function render(markdown) {
    slugCounts = Object.create(null);
    headings = [];

    const fm = parseFrontmatter(markdown || '');
    const src = fm.body;

    if (!src.trim()) {
      return { html: '<div class="md-empty">This note is empty — switch to the editor and start writing.</div>',
               headings: [], attrs: fm.attrs };
    }

    let raw;
    try {
      raw = marked.parse(src);
    } catch (err) {
      raw = '<div class="callout caution" data-icon="alert"><div class="cal-body">' +
            '<div class="cal-title">Could not render this note</div><p>' + esc(err.message) + '</p></div></div>';
    }

    const html = global.DOMPurify
      ? DOMPurify.sanitize(raw, {
          ADD_TAGS: ['video', 'audio', 'source', 'figure', 'figcaption'],
          ADD_ATTR: ['target', 'rel', 'loading', 'controls', 'preload', 'align', 'start', 'checked', 'id'],
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
          FORBID_ATTR: ['srcset', 'formaction', 'style']
        })
      : raw;

    return { html, headings: headings.slice(), attrs: fm.attrs };
  }

  /* ------------------------------------------------------------ enhance */
  /**
   * ctx: { dir, resolveAsset(path)->Promise<url|null>, openPath(path),
   *        onToggleTask(index, checked) }
   */
  function enhance(root, ctx) {
    ctx = ctx || {};

    /* callout icons (added here so the sanitizer never sees inline SVG) */
    U.$$('.callout[data-icon]', root).forEach((c) => {
      if (c.querySelector('.cal-icon')) return;
      const ic = U.icon(c.dataset.icon, 'cal-icon');
      c.insertBefore(ic, c.firstChild);
    });
    U.$$('a.ext-link', root).forEach((a) => {
      if (!a.querySelector('.i')) a.appendChild(U.icon('ext'));
    });

    /* code block buttons */
    U.$$('.code-block', root).forEach((block) => {
      block.addEventListener('click', async (e) => {
        const btn = e.target.closest('.code-btn');
        if (!btn) return;
        if (btn.dataset.act === 'wrap') {
          block.classList.toggle('wrap');
          btn.classList.toggle('done', block.classList.contains('wrap'));
          return;
        }
        const code = block.querySelector('code');
        const ok = await U.copyText(code ? code.textContent : '');
        btn.textContent = ok ? 'copied' : 'failed';
        btn.classList.toggle('done', ok);
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('done'); }, 1400);
      });
    });

    /* in-repo media: fetch through the API so private repos work */
    if (ctx.resolveAsset) {
      U.$$('[data-src]', root).forEach(async (node) => {
        const rel = node.dataset.src;
        const path = U.resolvePath(ctx.dir || '', rel);
        try {
          const url = await ctx.resolveAsset(path);
          if (!url) throw new Error('missing');
          node.src = url;
          node.classList.remove('loading');
        } catch (_) {
          node.classList.remove('loading');
          const miss = U.el('a', {
            class: 'md-file-link broken', href: '#',
            onclick: (e) => { e.preventDefault(); U.toast('Not in this vault: ' + path, 'err'); }
          }, [U.icon('alert'), U.el('span', { text: 'Missing file: ' + rel })]);
          node.replaceWith(miss);
        }
      });
    }

    /* lightbox for images */
    U.$$('img.md-img', root).forEach((img) => {
      img.addEventListener('click', () => {
        if (!img.src) return;
        const lb = U.$('#lightbox');
        U.$('#lb-img').src = img.src;
        lb.hidden = false;
      });
    });

    /* internal links open inside the app */
    U.$$('a.internal', root).forEach((a) => {
      const rel = a.dataset.rel || '';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const [p, hash] = rel.split('#');
        if (!p && hash) {
          const t = root.querySelector('#' + CSS.escape(hash));
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (ctx.openPath) ctx.openPath(U.resolvePath(ctx.dir || '', p), hash);
      });
    });

    /* task checkboxes write straight back to the markdown source */
    const boxes = U.$$('input[data-task]', root);
    boxes.forEach((box, i) => {
      box.disabled = !ctx.onToggleTask;
      box.addEventListener('change', () => {
        box.closest('.task-item').classList.toggle('done', box.checked);
        if (ctx.onToggleTask) ctx.onToggleTask(i, box.checked);
      });
    });

    /* anchors scroll rather than navigate */
    U.$$('a.anchor', root).forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.getAttribute('href').slice(1);
        const t = root.querySelector('#' + CSS.escape(id));
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        U.copyText(location.href.split('#')[0] + '#' + id);
      });
    });

    /* mermaid, loaded only if the note actually uses it */
    const diagrams = U.$$('.mermaid-block[data-mermaid]', root);
    if (diagrams.length) renderMermaid(diagrams);
  }

  /* ------------------------------------------------------------ mermaid */
  let mermaidPromise = null;
  function loadMermaid() {
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise((resolve, reject) => {
      if (global.mermaid) return resolve(global.mermaid);
      const s = document.createElement('script');
      s.src = MERMAID_CDN;
      s.onload = () => resolve(global.mermaid);
      s.onerror = () => reject(new Error('offline'));
      document.head.appendChild(s);
    }).then((m) => {
      m.initialize({
        startOnLoad: false, theme: 'dark', securityLevel: 'strict',
        themeVariables: { fontFamily: 'inherit', background: '#12161e', primaryColor: '#1b212c' }
      });
      return m;
    });
    return mermaidPromise;
  }

  async function renderMermaid(blocks) {
    let m;
    try { m = await loadMermaid(); } catch (_) {
      blocks.forEach((b) => showMermaidSource(b, 'Diagrams need an internet connection to render.'));
      return;
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const src = block.querySelector('pre') ? block.querySelector('pre').textContent : '';
      try {
        const out = await m.render('mmd-' + Date.now() + '-' + i, src);
        block.innerHTML = out.svg;
      } catch (err) {
        showMermaidSource(block, 'Diagram error: ' + (err && err.message ? err.message.split('\n')[0] : 'invalid syntax'));
      }
    }
  }

  function showMermaidSource(block, msg) {
    const pre = block.querySelector('pre');
    const src = pre ? pre.textContent : '';
    block.innerHTML = '<div class="mermaid-err">' + esc(msg) + '</div><pre style="text-align:left;margin-top:10px">' + esc(src) + '</pre>';
  }

  /* ------------------------------------------------------------ text tools */
  /** Flip the n-th `- [ ]` / `- [x]` in the source. */
  function toggleTaskInSource(text, index, checked) {
    const re = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;
    let i = 0;
    return text.replace(re, (full, pre, mark, post) =>
      (i++ === index) ? pre + (checked ? 'x' : ' ') + post : full);
  }

  function firstHeading(text) {
    // Blank out fenced code first: a '# comment' in a snippet is not the title.
    const body = parseFrontmatter(text).body.replace(/^```[\s\S]*?^```/gm, '');
    const h = body.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
    if (h) return h[1].replace(/[*_`\[\]]/g, '').trim();
    const line = body.split(/\r?\n/).find((l) => l.trim());
    return line ? line.replace(/^[#>\-*\s]+/, '').replace(/[*_`\[\]]/g, '').trim().slice(0, 60) : '';
  }

  /** Rough plain text for search snippets. */
  function plainText(text) {
    return parseFrontmatter(text).body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[>\-*+#\s]+/gm, ' ')
      .replace(/[*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function countWords(text) {
    const t = plainText(text);
    return t ? t.split(/\s+/).length : 0;
  }

  global.MD = {
    render, enhance, parseFrontmatter, toggleTaskInSource,
    firstHeading, plainText, countWords
  };
})(window);
