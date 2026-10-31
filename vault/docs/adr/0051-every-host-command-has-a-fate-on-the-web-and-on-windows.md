---
type: adr
id: ADR-0051
title: Every host command has a fate on the web and on Windows
status: proposed
date: 2026-10-31
---

# Every host command has a fate on the web and on Windows

## Context

DFAI is a macOS app: a React webview over a Rust host that reads and writes
the vault, runs the index, runs git, keeps secrets and reaches the system
(ADR-0005: the host decides nothing). The DFAI-everywhere plan (epic #678)
adds a web build for an iPad, a phone layout of it, and a Windows app. Before
a second platform is built, each of the host's commands — every name in
`generate_handler!` in `apps/desktop/src-tauri/src/lib.rs` — needs a written
answer to two questions: what does it become in a browser, and does it work
as it is on Windows? This record is that answer (issue #655, phase P1).

The web build these fates are written for:

- **A PWA on an iPad**, installed to the Home Screen (#668), **mostly online**,
  with a cache of the notes recently used (#667). It is not a whole vault
  offline.
- **The vault is a private GitHub repository.** The desktop app keeps a clone
  and syncs it by git, as now (ADR-0025). The web build reads the tree and the
  notes through the GitHub API and **writes each save as a commit**, sent with
  the blob it expects to replace (or the head it expects to build on); GitHub
  refuses it when that moved, and the save becomes a conflict copy, as
  ADR-0048's copies are (#664, #665).
- **The index is SQLite compiled to WebAssembly, in a worker, on OPFS**, built
  from the one schema file the desktop uses,
  `apps/desktop/src-tauri/src/index_schema.sql` (#666). It is derived and
  disposable, as on the desktop.
- **Sign-in is a GitHub App installed on the vault repository alone**; the
  code is exchanged for a token in a Firebase Function, which holds the App's
  secret (#663). **No server stores notes**: the Function sees a sign-in, never
  a note, and GitHub is the only place a note leaves the device for.

## Decision

1. **The vault model: each person has their own vault.** A vault is one
   private repository, one person's. The web build opens the one repository
   its sign-in reaches, and the desktop app opens it as a clone. **Sharing a
   vault, or a note, between people is out of scope for now**: nothing here
   is built for two people writing to one repository, and nothing is ruled
   out for later either.

2. **A command's web fate is one of three:**
   - **browser** — an adapter in the web build does the same job with what a
     browser has: OPFS, IndexedDB, the SQLite worker, `window.open`, a
     download.
   - **server** — a call over the network: the GitHub API for the vault, the
     Firebase Function for the sign-in. It is still an adapter behind the same
     port; only where the bytes come from changes.
   - **absent** — the web build has no such thing in v1, and the capability
     it serves is `false` in `WEB_CAPABILITIES`, so the screen hides it
     (#657). Most absences have one cause: a browser has no place to keep a
     secret out of the page's reach (ADR-0017), cannot start a process, and
     cannot reach the system. A server that did it for the page would be a
     server that sees notes or holds the person's keys, which this plan
     rules out.

3. **A command's Windows fate is one of two:**
   - **same** — the Rust compiles and behaves the same on Windows; it still
     runs under the Windows e2e (#674).
   - **port** — the code is macOS-only today, or relies on a behaviour
     Windows does not share, and needs Windows code before the Windows app
     ships. Most of the ports are #673's.

4. **What the UI reads is a capability, not a command.** A command serves a
   capability the person can see, named in `PLATFORM_CAPABILITIES`
   (`packages/domain/src/platform`), or "—" when every platform needs it.
   `DESKTOP_CAPABILITIES` and `WEB_CAPABILITIES` are the two values today; a
   Windows value comes with the Windows app, since Kindle, thumbnails and
   PDFs are macOS code until they are ported.

5. **The table is held to the code.** `apps/desktop/src/ipc-contract.test.ts`
   fails when a command in `generate_handler!` has no row below, when a row
   names a command that is gone, or when a row's fate or capability is not
   one this record names. A new host command cannot land unmapped.

## The commands

Each row: the command, the capability it serves, its web fate, its Windows
fate, and why.

### Errors and the activity log

| Command            | Capability | Web     | Windows | Why                                                                                                                                             |
| ------------------ | ---------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `report_error`     | —          | browser | same    | A caught webview error is logged. In a browser it goes to the console; there is no host log to write to.                                        |
| `activity_append`  | —          | browser | same    | The Activity log is the device's, never synced (U-28). A file per vault in OPFS keeps that; the rules on its bounds are already TypeScript's.   |
| `activity_read`    | —          | browser | same    | As `activity_append`: read back from OPFS.                                                                                                      |
| `activity_replace` | —          | browser | same    | As `activity_append`: the kept text written whole to OPFS. On Windows `fs::rename` over the old file replaces it, which is what this one wants. |

### Opening a vault and reading it

| Command            | Capability       | Web     | Windows | Why                                                                                                                                                                                           |
| ------------------ | ---------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pick_vault`       | localFolderVault | absent  | same    | There is no folder to pick in a browser. The web build's vault is the repository its sign-in reaches (#663), chosen when the GitHub App is installed.                                         |
| `open_vault`       | —                | browser | port    | Opening becomes "use this repository" plus its OPFS cache and index. On Windows the path guard every vault command shares must handle drive letters, `\\?\` paths, case and junctions (#673). |
| `current_vault`    | —                | browser | same    | The signed-in repository, kept in the browser's storage.                                                                                                                                      |
| `list_directory`   | —                | server  | same    | One folder of the repository's tree, from the GitHub API (or the tree already fetched), cached.                                                                                               |
| `list_notes`       | —                | server  | same    | The whole tree in one recursive GitHub trees call, filtered by the same domain rules the host is handed (ADR-0014).                                                                           |
| `list_vault_files` | —                | server  | same    | As `list_notes`, for another extension.                                                                                                                                                       |
| `read_text_file`   | —                | server  | same    | The note's blob from the GitHub API, kept in the cache of recently used notes (#667); offline, read from that cache or refused.                                                               |
| `read_notes`       | —                | server  | same    | Many blobs for the index. In a browser this is a batch of API calls bounded by the rate limit, which is why the web index fills as notes are used rather than all at once (#666).             |
| `read_binary_file` | —                | server  | same    | An attachment's blob, as bytes, cached like a note.                                                                                                                                           |

### Writing the vault

| Command             | Capability  | Web     | Windows | Why                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_text_file`   | —           | server  | port    | A save is a commit naming the blob it replaces; GitHub refuses it when that moved, and the save becomes a conflict copy (#664, #665). This is the web's version of the host's "changed on disk" check. On Windows the replacing `fs::rename` works, but a file another program holds open refuses it; that needs a retry or `ReplaceFileW` (#673). |
| `write_binary_file` | —           | server  | port    | An artifact's file as a blob and a commit, under the same expected-head check. Windows as `write_text_file`.                                                                                                                                                                                                                                       |
| `create_note`       | —           | server  | port    | A commit adding the file, refused when the path is already in the tree at the head it was based on. On Windows `rename_exclusive` falls back to a check and then `fs::rename`, which **replaces**: it needs `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`, and a test that races two creations of one name (#673).                             |
| `create_folder`     | —           | browser | same    | Git keeps no empty folder, so a folder made on the web lives in the client until a note is saved into it — as an empty folder made on the desktop never reaches another device either.                                                                                                                                                             |
| `move_entry`        | —           | server  | port    | One commit whose tree drops the old paths and adds the new, refused when the head moved, so a move is whole or not at all. On Windows it is `rename_exclusive` again (#673), and a case-only rename has to be tested on a case-insensitive volume.                                                                                                 |
| `trash_entry`       | systemTrash | server  | port    | On the web a delete is a commit removing the entry; the repository's history is where it can be recovered from, and there is no system Trash. On Windows the `trash` crate's Recycle Bin backend replaces the macOS `NSFileManager` method and needs its own test (#673).                                                                          |

### The index

| Command               | Capability | Web     | Windows | Why                                                                                                                   |
| --------------------- | ---------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `index_open`          | —          | browser | same    | SQLite (WebAssembly) in a worker, its file in OPFS, its tables from `index_schema.sql` — the same schema file (#666). |
| `index_clear`         | —          | browser | same    | The OPFS file deleted and made again: the index is disposable everywhere.                                             |
| `index_manifest`      | —          | browser | same    | The same SQL, in the worker.                                                                                          |
| `index_put`           | —          | browser | same    | The same SQL, in the worker; the rows come from the same TypeScript.                                                  |
| `index_remove`        | —          | browser | same    | The same SQL, in the worker.                                                                                          |
| `index_search`        | —          | browser | same    | The same full-text query, in the worker; the WebAssembly build must include FTS5.                                     |
| `index_backlinks`     | —          | browser | same    | The same SQL, in the worker.                                                                                          |
| `index_notes_of_type` | —          | browser | same    | The same SQL, in the worker.                                                                                          |
| `index_rebuild_views` | —          | browser | same    | The same SQL, in the worker.                                                                                          |
| `index_query`         | —          | browser | same    | The Query page's guard (one read-only statement, a step budget, a row cap) moves into the worker with it.             |
| `index_stats`         | —          | browser | same    | The same SQL, in the worker.                                                                                          |

### Watching and sync

| Command                 | Capability       | Web     | Windows | Why                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch_vault`           | fileWatching     | absent  | same    | There is no folder to watch. Changes made on another device arrive by asking for the branch's head, not by events (#665). `notify` uses `ReadDirectoryChangesW` on Windows; its renames arrive as two events, which the e2e must cover (#674).                                                                          |
| `git_run`               | syncByGit        | server  | port    | The web build runs no git: the GitHub API replaces the whole sync engine, through the same ports (#664). On Windows `GIT_DIRS` names Homebrew's folders; it needs Git for Windows' install folders, `git.exe`, and line endings held to LF (#673).                                                                      |
| `git_run_in`            | syncByGit        | absent  | port    | Git in a folder picked for a clone. Nothing is cloned on the web. Windows as `git_run`.                                                                                                                                                                                                                                 |
| `git_pick_clone_folder` | localFolderVault | absent  | same    | The native dialog, for a folder to clone into: nothing to clone into on the web.                                                                                                                                                                                                                                        |
| `git_folder_on_disk`    | localFolderVault | absent  | port    | The folder as the disk spells it. On Windows that spelling includes case and the verbatim `\\?\` prefix `canonicalize` adds (#673).                                                                                                                                                                                     |
| `git_sync_file_read`    | syncByGit        | absent  | same    | `journal.json` and `exclude` are git sync's own files; the web build saves by commit and needs neither.                                                                                                                                                                                                                 |
| `git_sync_file_write`   | syncByGit        | absent  | same    | As `git_sync_file_read`. It writes through the same replacing rename as `write_text_file`.                                                                                                                                                                                                                              |
| `gh_repo_create`        | repoCreation     | absent  | port    | A GitHub App scoped to one repository cannot make repositories, and the vault is set up from the desktop (#671). On Windows `GH_DIRS` needs `gh.exe`'s install folders (#673).                                                                                                                                          |
| `gh_repo_list`          | syncByGit        | server  | port    | The repositories the App's installation reaches — the one vault — from the GitHub API. Windows as `gh_repo_create`.                                                                                                                                                                                                     |
| `this_mac_name`         | —                | browser | port    | The device's name, which names conflict copies and commits. A browser cannot read it: the person names the iPad once and the name is kept in its storage. On Windows `scutil` is gone; the computer name comes from `GetComputerNameExW` (#673).                                                                        |
| `host_asleep_ms`        | syncByGit        | absent  | port    | Sleep since boot, so a pull that slept is not acted on (ADR-0035). The web build pulls nothing: each save is checked against the head at commit time. On Windows there is no reading, which never lets a synced vault act; the difference of `QueryInterruptTime` and `QueryUnbiasedInterruptTime` is the same reading. |

### Secrets and connected services

| Command                   | Capability        | Web    | Windows | Why                                                                                                                                                                                                                                             |
| ------------------------- | ----------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_list`             | heldSecrets       | absent | port    | A secret lives only where the page cannot read it (ADR-0017). A browser has no such place, and a server that held it would hold the person's keys. On Windows the Keychain store becomes the Credential Manager store of `keyring-core` (#673). |
| `secret_set`              | heldSecrets       | absent | port    | As `secret_list`.                                                                                                                                                                                                                               |
| `secret_bind`             | heldSecrets       | absent | port    | As `secret_list`.                                                                                                                                                                                                                               |
| `secret_delete`           | heldSecrets       | absent | port    | As `secret_list`.                                                                                                                                                                                                                               |
| `http_get`                | webFetch          | absent | same    | Feeds and pages from other sites: most refuse a browser's cross-origin request, and a secret a request names cannot be filled in. A proxy would be a server that reads the vault's sources. Windows needs only the secrets port.                |
| `model_http_post`         | heldSecrets       | absent | same    | The chat's model-API fallback sends the person's key, pinned to the Messages API (ADR-0021). With no place to keep the key, it is absent. Windows needs only the secrets port.                                                                  |
| `model_process_start`     | claudeCodeChat    | absent | port    | Starts Claude Code, a process: a browser cannot. On Windows `INSTALL_DIRS` must find `claude.exe`, and a run that has gone on too long must be ended with its children.                                                                         |
| `model_process_cancel`    | claudeCodeChat    | absent | port    | As `model_process_start`.                                                                                                                                                                                                                       |
| `google_status`           | googleCalendar    | absent | same    | The host keeps the refresh token and sends the calls (ADR-0030). A browser cannot keep it out of the page's reach; a token broker in the Function is a later decision, not v1. The loopback sign-in works on Windows.                           |
| `google_connect`          | googleCalendar    | absent | same    | As `google_status`.                                                                                                                                                                                                                             |
| `google_connect_cancel`   | googleCalendar    | absent | same    | As `google_status`.                                                                                                                                                                                                                             |
| `google_disconnect`       | googleCalendar    | absent | same    | As `google_status`.                                                                                                                                                                                                                             |
| `google_calendar_request` | googleCalendar    | absent | same    | As `google_status`. The meeting notes it makes still reach the web build, as notes in the repository synced from the desktop.                                                                                                                   |
| `google_drive_request`    | googleDriveExport | absent | same    | A note exported to Google Drive (#501) under the same sign-in the host keeps, with `drive.file`. Absent with that sign-in.                                                                                                                      |
| `granola_status`          | granola           | absent | same    | The host keeps Granola's API key and adds it to each call. No place to keep it on the web; the notes it imports reach the web as files.                                                                                                         |
| `granola_set_key`         | granola           | absent | same    | As `granola_status`.                                                                                                                                                                                                                            |
| `granola_forget_key`      | granola           | absent | same    | As `granola_status`.                                                                                                                                                                                                                            |
| `granola_request`         | granola           | absent | same    | As `granola_status`.                                                                                                                                                                                                                            |
| `slack_status`            | slack             | absent | same    | The host keeps the Slack token (ADR-0049). No place to keep it on the web; captured messages reach the web as Inbox notes.                                                                                                                      |
| `slack_connect`           | slack             | absent | same    | As `slack_status`.                                                                                                                                                                                                                              |
| `slack_disconnect`        | slack             | absent | same    | As `slack_status`.                                                                                                                                                                                                                              |
| `slack_request`           | slack             | absent | same    | As `slack_status`.                                                                                                                                                                                                                              |
| `kindle_connect`          | kindle            | absent | port    | A sign-in window and a hidden webview on Amazon's site, with a data store of their own (ADR-0044). A page cannot open either. On Windows the session is `WKWebView` code; WebView2 needs its own, or Kindle stays macOS-only.                   |
| `kindle_disconnect`       | kindle            | absent | port    | As `kindle_connect`.                                                                                                                                                                                                                            |
| `kindle_fetch_notebook`   | kindle            | absent | port    | As `kindle_connect`.                                                                                                                                                                                                                            |

### Local models

| Command                    | Capability  | Web    | Windows | Why                                                                                                                                                                                                                  |
| -------------------------- | ----------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embed`                    | localModels | absent | port    | A 91 MB model run on the device (ADR-0031): too large to fetch and run on an iPad that is mostly online. On Windows `candle` builds, but the macOS build uses Accelerate; Windows runs on the CPU and must be timed. |
| `embedding_cache_open`     | localModels | absent | same    | The cache of what `embed` made: nothing to cache without it.                                                                                                                                                         |
| `embedding_cache_clear`    | localModels | absent | same    | As `embedding_cache_open`.                                                                                                                                                                                           |
| `embedding_cache_load`     | localModels | absent | same    | As `embedding_cache_open`.                                                                                                                                                                                           |
| `embedding_cache_excerpts` | localModels | absent | same    | As `embedding_cache_open`.                                                                                                                                                                                           |
| `embedding_cache_put`      | localModels | absent | same    | As `embedding_cache_open`.                                                                                                                                                                                           |
| `embedding_cache_remove`   | localModels | absent | same    | As `embedding_cache_open`.                                                                                                                                                                                           |

### Reaching the system

| Command                     | Capability     | Web     | Windows | Why                                                                                                                                                                                                                   |
| --------------------------- | -------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `global_capture_status`     | globalCapture  | absent  | port    | A system-wide shortcut belongs to the system (ADR-0033); a page gets keys only while it has focus. On Windows the window must be brought forward without AppKit, and the shortcuts the system keeps are Windows' own. |
| `global_capture_set`        | globalCapture  | absent  | port    | As `global_capture_status`: the vetting backstop names macOS's reserved keys and ⌘.                                                                                                                                   |
| `open_url`                  | —              | browser | same    | `window.open` with `noopener`. `opener.rs` already has a Windows branch.                                                                                                                                              |
| `sqlite_source_query`       | sqliteSources  | absent  | same    | Another program's database, outside the vault, on the device: a browser can reach neither. Read-only `immutable` opening is the same on Windows.                                                                      |
| `pick_sqlite_file`          | sqliteSources  | absent  | same    | As `sqlite_source_query`.                                                                                                                                                                                             |
| `snapshot_page`             | pageThumbnails | absent  | port    | A stranger's page pictured in a webview of its own with no app origin. A browser cannot picture one safely, and the card keeps its placeholder. On Windows it is `WKWebView` code; WebView2 capture is the port.      |
| `export_choose_destination` | markdownExport | browser | same    | No folder to choose: the export becomes a download (a `.md` file, or a zip of a note and its files).                                                                                                                  |
| `export_write_file`         | markdownExport | browser | same    | As `export_choose_destination`: each file goes into the download.                                                                                                                                                     |
| `export_finish`             | markdownExport | browser | same    | As `export_choose_destination`: the download is handed over, or dropped on failure.                                                                                                                                   |
| `export_render_pdf`         | pdfExport      | absent  | port    | Made with the system's WebKit and PDFKit. In v1 the web has no PDF export; the iPad's own print sheet can still save a page. On Windows WebView2's `PrintToPdfAsync` is the port.                                     |

### The local API

| Command               | Capability | Web    | Windows | Why                                                                                                                                                                                                      |
| --------------------- | ---------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_status`          | localApi   | absent | same    | The local API and the MCP server listen on the device's loopback for other programs (ADR-0016). A browser cannot listen, and an iPad has no such programs. On Windows the loopback listener is the same. |
| `api_set_enabled`     | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |
| `api_rotate_token`    | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |
| `api_token`           | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |
| `api_respond`         | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |
| `api_router_register` | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |
| `api_router_ready`    | localApi   | absent | same    | As `api_status`.                                                                                                                                                                                         |

## James to confirm

These were chosen as the recommended answers and are open until James says:

- **Connected services stay on the desktop in v1.** Google Calendar, Granola,
  Slack and Kindle run on the desktop, and what they make reaches the web
  build as notes in the repository. A token broker in the Firebase Function
  could bring Google to the web later; it would be the first server to hold
  a person's key, so it is a decision of its own.
- **A delete on the web is a commit, not a Trash.** The repository's history
  is how it is recovered.
- **Markdown export on the web is a download; PDF export is absent**, short of
  the iPad's own print sheet.
- **The device names itself on the web.** The person types the iPad's name
  once; it names that device's conflict copies.

## Consequences

- The web build needs a browser or server adapter for the vault, the index,
  the activity log, export and opening a link — and nothing else. Everything
  else is absent and hidden by capability.
- No host command needs a server of DFAI's own beyond the sign-in's token
  exchange: every server fate is the GitHub API.
- The Windows app is blocked on #673's ports: the exclusive rename, the
  replacing write under a held file, the Recycle Bin, Credential Manager,
  path spelling, git and `gh` discovery, the computer name and the sleep
  reading. Kindle, thumbnails and PDF export may ship later than the rest.
- A new host command lands with its row here, or the IPC contract test fails.
