# My Personal Folder

A personal notes-and-files app that uses **this repository as its database**.
Plain HTML, CSS and JavaScript — no build step, no server, no third-party service.
Every note you write and every file you upload becomes a commit in this repo.

![dark](https://img.shields.io/badge/theme-dark-0b0d12) ![stack](https://img.shields.io/badge/stack-html%20%C2%B7%20css%20%C2%B7%20js-6d8cff) ![deps](https://img.shields.io/badge/build%20step-none-3fd18b)

---

## What it does

| | |
| --- | --- |
| **Write & paste markdown** | Full editor with toolbar, live preview and split view |
| **Upload anything** | Drag and drop files anywhere, or paste an image straight into a note |
| **Full CRUD** | Create, read, rename, move, duplicate and delete notes, files and folders |
| **Search** | `Cmd+K` for fuzzy path search, note contents and tags |
| **Proper markdown** | Code blocks with highlighting and copy, tables, callouts, task lists that write back, mermaid diagrams, in-repo images |
| **Dark, sleek, fast** | One screen, keyboard-driven, six accent colours |

Every write is a real commit, so `git log` is your version history and nothing is
ever silently lost.

## Getting started

### 1. Create a token

GitHub needs to let the page write to this repo on your behalf.

1. Open [**Fine-grained tokens → New token**](https://github.com/settings/personal-access-tokens/new)
2. **Repository access** → *Only select repositories* → pick this repo
3. **Permissions → Repository → Contents** → **Read and write**
4. Generate and copy it

### 2. Open the app

Either:

- **Locally** — clone the repo and serve the folder:

  ```bash
  python3 -m http.server 8787
  ```

  then open <http://localhost:8787>. Opening `index.html` straight from disk
  generally works too (everything is vendored, there is nothing to build), but a
  local server is the dependable option — some browsers restrict storage on
  `file://`.
- **GitHub Pages** — Settings → Pages → deploy from `main` / root, then open
  `https://<you>.github.io/My-Personal-Folder/`. Not enabled by default.
  Read [Privacy](#privacy) first: Pages publishes `vault/` as static files, so a
  public Pages site makes every note public. Publishing a *private* repo to Pages
  (which keeps the site behind a GitHub login) requires a paid plan.

### 3. Connect

Fill in owner, repo, branch and the token. The token is kept in your browser's
local storage and is sent only to `api.github.com`. Untick "keep me signed in"
on a shared machine and it lives for that tab only.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl + K` | Quick open — notes, files, tags, commands |
| `Cmd/Ctrl + S` | Save the current note |
| `Cmd/Ctrl + E` | Toggle editor / preview |
| `Cmd/Ctrl + Shift + N` | New note |
| `Cmd/Ctrl + Shift + U` | Upload files |
| `Cmd/Ctrl + B` / `I` / `K` | Bold / italic / link (in the editor) |
| `/` | Focus the sidebar filter |
| `Esc` | Close whatever is open |

## Layout

```
index.html              the app shell
assets/css/style.css    app chrome, dark theme
assets/css/markdown.css rendered markdown + syntax theme
assets/js/util.js       DOM helpers, encoding, toasts, modals, menus
assets/js/github.js     the storage layer — Contents + Git Data APIs
assets/js/markdown.js   markdown render and live-behaviour wiring
assets/js/app.js        state, tree, editor, CRUD, palette
assets/vendor/          marked, DOMPurify, highlight.js (vendored, no CDN)
vault/                  your notes and files
vault/assets/           pasted and dropped images land here
```

## How storage works

- **Reading** — one recursive `git/trees` call lists the whole vault; blobs are
  fetched by SHA, so private repos render images and files fine.
- **Saving a note** — `PUT /contents/{path}` with the blob SHA you opened. If the
  file changed on GitHub meanwhile, GitHub rejects it and the app offers you both
  versions instead of clobbering one.
- **Uploads, moves and bulk deletes** — built as a single commit through the Git
  Data API (blobs → tree → commit → ref), so a ten-file drop is one commit and a
  rename moves the blob rather than copying it.
- **Folders** — git has no empty directories, so a new folder is seeded with a
  `.gitkeep` that the app keeps out of your way.

Files are capped at 50 MB (the practical ceiling for the GitHub blob API).

## Privacy

The token never leaves your browser — there is no backend to send it to. All
requests go directly from the page to `api.github.com`, and the app shows
nothing until someone supplies a token that can read the repo.

**That guarantee covers the app, not the hosting.** GitHub Pages publishes every
file in the repository as a static file, so on a *public* Pages site your notes
are readable directly at their own URLs — `…/vault/Welcome.md` — with no token
involved. The token gate protects the API, not static hosting.

So pick one:

| Setup | Notes are |
| --- | --- |
| Run it locally (no Pages) | private |
| Private repo + Pages set to **private** visibility (paid plan) | private — viewers must sign in with repo access |
| Public repo + Pages | **public — anyone can read every note** |
| App in a public repo, `vault/` in a separate **private** repo | private — point the app at the private repo at connect time |

That last row is the one to use if you want a shareable URL and private notes:
this repo holds only the app, and you connect it to a second private repo that
holds the vault. Nothing in the code changes — owner and repo are just fields on
the connect screen.

## Licence

MIT — do whatever you like with it.
