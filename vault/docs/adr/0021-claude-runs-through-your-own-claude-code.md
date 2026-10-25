---
type: adr
status: accepted
date: 2026-09-27
---

# Claude in Atlas runs through your own Claude Code, and proposes every write

## Context

U-26 asks for a chat inside Atlas that uses James's Claude login (or acts as an
embedded agent), knows the window it was opened on, can reach everything in the
vault, and can edit the page when asked. A local model may come later.

Three things had to be decided: how Atlas reaches a model without holding a
login it has no business holding, how the model reaches the vault, and how a
model's words are kept from becoming writes nobody agreed to.

## Decision

### A `ModelProvider` port, and two providers behind it

`packages/application/src/chat/ports.ts` declares one port: send the system
prompt, the conversation and the tools; receive a stream of text and tool calls;
cancel with an `AbortSignal`; and say whether the provider can be used right now
(`status()`), with how to fix it when it cannot. The conversation is Atlas's own
data (`packages/domain/src/chat`), not any vendor's message format. A local
model behind an OpenAI-compatible endpoint is a third implementation of the
same port; nothing above the adapters would change.

1. **Claude Code (the default).** Atlas runs the `claude` CLI the person already
   installed and logged into, in print mode with `stream-json` output. **Atlas
   never sees, stores or forwards an OAuth token**: Claude Code keeps its own
   login in its own Keychain item, and Atlas only starts the program. If it is
   not installed, or `claude auth status` says it is not logged in, the panel
   says so and shows the command that fixes it (`claude auth login`).
2. **Anthropic API (the fallback).** A key kept as an ordinary Atlas secret
   (ADR-0017), bound to `https://api.anthropic.com`. TypeScript sends a request
   that _names_ the secret; the host fills it in as the request leaves and
   strikes it from anything that comes back. The key never reaches the webview.
   This provider answers whole rather than token by token: the host's HTTP
   command returns a finished body, and streaming it would need a second,
   long-lived channel for a path that is only the fallback.

The model is configurable in Settings → Claude; the default is
`claude-opus-5-5`, the latest at the time of writing.

### Why the CLI rather than the Agent SDK

The Agent SDK is a Node library that itself spawns the same CLI. Atlas has no
Node runtime at run time, so using it would mean bundling one as a sidecar in
order to spawn the program Atlas can spawn directly.

### The host spawns what it is handed, and vets it

The Rust host (`model_process.rs`) starts a program **named `claude`** from
where Claude Code installs, writes the prompt to its stdin, emits each line of
its stdout to the webview as an event, and kills it on cancel. It decides
nothing about what the lines mean (ADR-0005): decoding `stream-json` and every
rule after it are TypeScript.

The webview is still the untrusted side (ADR-0017), and "spawn a process" is
the most dangerous thing it could be allowed to ask for. So the host holds a
fixed shape, as it holds the origins a secret is bound to — obeying a rule, not
having one (the ADR-0014 nuance):

- the program's file name is `claude`, found only in the host's own list of
  install locations;
- the arguments are either `auth status` or a turn's whole fixed argument list,
  which includes **`--tools ""`**, turning off every Claude Code tool — no
  Bash, no file reads, no web fetch. Anything else is refused before anything
  runs;
- the child runs in the system temp directory, so no project's files or
  `CLAUDE.md` are near it, with `--setting-sources ""` and
  `--strict-mcp-config` so no user settings, hooks or MCP servers load.

### What the host holds fixed (A27-01)

The review of Phase 27 found the host checking less than the list above says:
it accepted a turn missing `--strict-mcp-config`, `--setting-sources ""` or
`--no-session-persistence`, it searched whatever directories the webview named,
it handed the child its whole environment, nothing bounded a run, and the
fallback's POST could carry any bound secret to that secret's site. Each of
these is now a constant in Rust. The host decides nothing with them (ADR-0005);
it refuses what does not match, as it refuses a secret for an unbound site.

**The arguments.** Exactly one of two shapes, compared slot by slot:

- `auth status`;
- a turn, these fifteen arguments in this order, where only the model and the
  system prompt vary (the model must be non-empty and not start with `-`):

  ```text
  -p --output-format stream-json --verbose --include-partial-messages
  --model <model> --tools "" --system-prompt <system>
  --no-session-persistence --setting-sources "" --strict-mcp-config
  ```

  This is what `claudeCodeArgs` builds; a change on either side must be made on
  both. `--version` is not a shape: Atlas never asks it.

**Which `claude`.** The request names no directory. The host looks, in order,
in `~/.local/bin` (the native installer), `~/.claude/local` (its older local
install), `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`,
`~/.bun/bin` and `~/.volta/bin`, with `~/` the home folder. The program name is
the bare `claude`; a directory — or a home folder — holding `:` is refused,
since each directory joins the child's `PATH`.

**The environment.** The child's environment is cleared, then given:

- `PATH`: the install locations above, then `/usr/bin:/bin:/usr/sbin:/sbin`,
  so an npm install's `#!/usr/bin/env node` finds node;
- `HOME`: where Claude Code keeps its login and settings;
- `USER` and `LOGNAME`: the account whose Keychain holds Claude Code's login;
- `LANG`: so its text stays UTF-8;
- `TMPDIR`: macOS's per-user temp folder.

The last four are passed only when the host has them. Nothing else reaches
the child — no API key, proxy setting or `NODE_OPTIONS` from wherever Atlas
was started.

**Time.** The host stops a run that has gone on too long, killing its process
group: 30 seconds for `auth status`, 15 minutes for a turn. The webview times
each out first with an `AbortSignal` — 15 seconds for `auth status`, 10 minutes
for one round of a turn (`CLAUDE_CODE_TIMEOUTS`) — and says so as a failure,
not as a Stop; the host's limit is the backstop for a run nothing else stops. A stopped run ends like a cancelled one (no exit code),
with `Atlas stopped claude: it ran longer than <limit>.` at the end of its
stderr.

**Cancel and output.** A cancel reaches every live run with that id, so a
reused id cannot leave a run beyond reach. A line longer than 4 MiB is cut
there and the rest of it dropped, never handed on as further lines.

**The fallback's POST.** `model_http_post` goes to exactly
`https://api.anthropic.com/v1/messages` and carries the `anthropic` secret and
no other. A secret's binding is the person's to widen for GET fetches (a GitHub
token for a source), so it cannot be what limits a POST whose body the webview
writes. Redaction of the key from what comes back, and following no redirect,
are unchanged.

### Tools are Atlas's, run by the app, through the API's use-cases

With Claude Code's own tools off, the model's tools are Atlas's. Claude Code has
no way to be handed arbitrary tool definitions short of an MCP server, and an
MCP server here would either write behind the panes or need its own channel
back into the app. So for this provider Atlas describes its tools in the system
prompt and reads a tool call out of the streamed text
(`<atlas_tool>{"name": …, "input": …}</atlas_tool>`, parsed by the domain's
`scanToolCalls`). The API provider uses the API's native tool use instead. Both
yield the same `tool_call` events.

Every read tool is answered by `routeApiRequest` — the exact handlers the local
API and the MCP server reach — in-process, with the app's own `ApiRouterDeps`.
So the chat sees what an MCP client sees, archived notes are left out unless
the model asks for them (which it is told to do only when the person does), and
a vault switch mid-turn refuses rather than answering from the wrong vault.
The chat's tools are a fixed list of read routes; none of the API's write
routes is reachable from it.

### Every write is a proposal the person accepts

The model has two tools that change the vault: `propose_edit` (exact
find-and-replace spans on a note's body, plus optional property changes) and
`propose_note`. Neither writes. Each is checked when proposed — every span must
match exactly once — and shown as a block-level diff with **Accept** and
**Reject**, under the vault path Accept writes.

A proposal carries its final path and the whole text Accept writes, and the
card is drawn from that text (A27-01). For a new note the path is worked out
before the card is shown: the folder named, or the one its kind files it in (a
view or dashboard would go under `.atlas/`), numbered past the notes already
there; then the full path goes through `chatWriteRefusal`, which refuses hidden
folders and `Chats/`. Accept creates exactly that path, and refuses if it has
been taken since. For an edit, the text is the note's own bytes with the
proposed spans replaced and the frontmatter changed key by key; Accept writes
it as it is — not re-serialized, so a `*` list or a setext heading lands as the
card showed it — and refuses if the note changed since the proposal or is open
with unsaved typing. A proposal is marked accepting before its write, so one
Accept is one write. An accepted change can be undone from the chat in one
step, which puts the previous bytes back if nothing has written the note since.

Model output and tool results are untrusted. Vault text reaches the model
fenced as data, with an instruction that it is not instructions; but the
defence that matters is structural — whatever a note persuades the model to
propose, nothing lands without the person's click.

### Chats are notes

Each conversation is a markdown note in `Chats/`, owned by the person like any
other: created once, then only ever appended to, so an edit made to an old
chat is never rewritten. Tool calls are recorded as quoted lines, every line of
them, so no text a tool line holds can start a turn when the note is read
back. A retried question is written once; only its new answer is appended.

A turn belongs to the conversation it began in. A new chat, an opened chat or
a vault switch moves the session on, and a turn, Accept or Undo still running
from before drops what it finishes with: it touches neither the new
conversation nor its note, nor another vault.

The conversation sent with each question is trimmed: the latest six tool
results go in full, and each older one is cut to its first 400 characters with
a note of how much was left out (`trimTranscript`).

### Ask: the chat as a page, and every answer read for citations (#37)

⌘J opens **Ask**, a page of its own like Today or the Library, with the
question box focused; ⌘J on Ask goes back to where you were, as Back would
(`askShortcut`). ⇧⌘J opens the same chat beside the work in the right
sidebar. Ask and the sidebar draw one chat session, so a question asked on
one is still there on the other, and chats stay notes in `Chats/` — Ask lists
the latest of them as its recent questions.

Each answer is read for citations by a pure domain rule (`citeAnswer`): every
paragraph, list item, quote and table must hold a wiki link — `[[Note]]`,
`[[Note#^id]]` or an embed — that is not in code or escaped, read as the
editor reads links (`scanMarkdown`). Headings, rules and fenced code are
exempt, and so is a line ending in `:` that leads into the list under it. A
web address is not a citation. A block that cites nothing is shown whole and
marked "not cited", never hidden; an answer still arriving, and what the model
says on its way to a tool, are not marked. The system prompt asks for a link
on every paragraph, so the marker is the exception it was told about.

An answer is never drawn as HTML. It is cut into blocks and pieces in the
domain, and the page draws text as text: a citation is a chip that follows
its link through the app's own link following — at the block, or into the
reader for a highlight; ⌘-click opens a new tab — and only an `https://`
address with a host is a web link, opened in the browser. Any other markdown
link stays the text it was written as.

The chat beside the page draws its answers the same way, from the same
reading (#548): the same chips, markers and links, at the sidebar's width.
A past chat that cannot be opened, there or on Ask, says why and the list is
read again; it never fails silently.

## Consequences

- Nothing new holds a credential. Logging out of Claude Code logs Atlas out.
- The Claude Code provider depends on the CLI's `stream-json` format, which is
  decoded in one adapter file with its own tests; a format change breaks there.
- The text tool protocol costs a little reliability against native tool use.
  A malformed call is answered as a tool error the model can correct.
- Each model turn is one process run (the conversation, trimmed, is sent each
  time), which costs a second or two of start-up per turn but leaves no
  long-lived process to supervise.
- No network other than the chosen provider's: the chat's tools are all
  in-process, and Claude Code's own web tools are off.
