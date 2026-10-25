---
type: adr
id: ADR-0031
title: Embeddings are a disposable local cache, made on this Mac
status: proposed
date: 2026-10-07
---

# ADR-0031 — Embeddings are a disposable local cache, made on this Mac

## Context

James wants related-note suggestions, a trail through a line of thought, and
"what did <colleague> say about X" answered semantically, in the app and over MCP.
That needs vector embeddings of blocks. Work notes must not leave the Mac for
a third-party embedding API without James choosing that.

## Decision

**Embeddings are derived and disposable, like the index (ADR-0005):** a
`block_embeddings` table in `.atlas-cache/` keyed by note path, block
ordinal and a digest of the block's text, rebuilt from the files, never
synced, never in a note. Every block is embedded, not only those with a
`^id` (the index's `blocks` table holds only those); a block id is written
only when a suggestion or answer is accepted and needs to cite one
(ADR-0022's "written only when first referred to" holds).

**They are computed locally** by a small open embedding model run by the
host. The host loads the model and returns vectors; which blocks to embed,
chunking, ranking and thresholds are TypeScript. Search is brute-force cosine
over the vault's blocks until measured to be too slow.

**The model is Snowflake Arctic Embed XS** (`Snowflake/snowflake-arctic-embed-xs`,
Apache-2.0, 22M parameters, 384 dimensions, 512-token window), chosen by the
spike below: the best of three on the questions, inside the 100 MB budget, and
about a millisecond per block slower than the fastest.

**A suggestion is never a link until accepted.** "Related notes" proposes;
Accept writes a real `[[link]]` through the normal save.

## The spike (P32-01, 2026-10-08)

Three small open BERT-family models, each run through the code the app ships
(`src-tauri/examples/embedding_spike.rs`, which calls the same `Embedder`):

- **all-MiniLM-L6-v2** — the usual small default; mean pooling; 256-token window.
- **bge-small-en-v1.5** — a stronger retriever, but 134 MB, over the budget;
  there to show what the extra size buys.
- **snowflake-arctic-embed-xs** — a newer retriever at MiniLM's size.

**Corpus.** A copy of James's vault, outside the repository: about 100 Markdown
files, of which 32 notes have body text, cut into 2,099 blocks (313 KB). Blocks
approximate the app's: the body after frontmatter, cut at blank lines and at
each list item. A block longer than a model reads was halved at a space until
it fit: 10 blocks for the 512-token models, 20 for MiniLM.

**Questions.** 20 questions, each naming the note and a phrase of the block
that answers it, worded to share few words with the answer. A hit is an
answering block in the top _k_ by cosine. Questions and corpus stay on James's
Mac; only these totals are recorded.

| Model               | Download | Block recall@5 | @10  |   MRR@10 | Note recall@5 | ms / block |  32 blocks | One query | Peak memory |
| ------------------- | -------: | -------------: | ---- | -------: | ------------: | ---------: | ---------: | --------: | ----------: |
| all-MiniLM-L6-v2    |    91 MB |           0.75 | 0.80 |     0.54 |          1.00 |        4.4 |   58–60 ms |   3.3–3.6 |  240–350 MB |
| bge-small-en-v1.5   |   134 MB |           0.75 | 0.85 |     0.52 |          0.95 |  10.7–11.2 | 139–142 ms |   9.3–9.9 |  350–510 MB |
| **arctic-embed-xs** |    91 MB |       **0.80** | 0.85 | **0.59** |          0.95 |    5.5–5.9 |   71–74 ms |   4.5–4.7 |  310–430 MB |

- Apple M5, 10 cores, 24 GB, CPU with Apple's Accelerate. **The machine was
  heavily loaded** by parallel builds for these runs: load averages of 12 to
  40 on 10 cores, up to 160 earlier. Each figure is the range over two or three
  runs. Arctic, measured again three times at a load average of about 4, gave
  the same: 5.5–5.6 ms a block, 70–73 ms for 32 blocks, 4.4–4.6 ms a query.
- _ms / block_ is the whole corpus embedded in calls of 64, in vault order.
  _32 blocks_ is the median of five calls with the corpus's first 32 blocks;
  _one query_ is in milliseconds. Loading took 25–50 ms with the files in the
  OS cache; reading them cold adds the disk.
- Peak memory is the process's peak resident size after embedding the corpus;
  about 200 MB of it (290 MB for bge) is the model once loaded.
- Recall at 5 and 10 did not move between runs or pass sizes. At other pass
  sizes, float rounding moved one answer by a place for bge and Arctic
  (MRR ±0.03).

**What decided it.** Arctic answered one more question in the top five than
either other model and ranked answers higher (MRR 0.59 against 0.54 and 0.52),
at MiniLM's size and about 1.3× its time. Its 512-token window also halves the
blocks that need splitting. bge-small bought nothing on these questions for
1.5× the download and twice Arctic's time.

**Limits of the spike.** The questions were written by an agent from the copy's
content, not by James, so they are a guess at what James asks. Twenty questions
make each one worth 0.05: the gap between Arctic and MiniLM is one question at
_k_ = 5, which a different question set could reverse. Re-running the harness
on questions James writes is cheap (the command is in the file's header) and
is the way to revisit the choice.

**Pass size.** The host runs the model in passes of at most 256 tokens,
padding included, grouping texts of similar length. Measured with Arctic: 256
and 512 were equally fast per block, and peak memory rose with the pass — about
0.35 GB at 256, 0.5 at 512, 0.74 at 1,024 and 2.5 GB at 8,192, which was also
twice as slow.

## The host command

`embed(texts, purpose)` (`src-tauri/src/embeddings.rs`), behind
`EmbeddingPort` in the application layer and `tauriEmbeddings` in adapters.

- **One unit-length vector per text, in order**, so cosine similarity is a dot
  product. `purpose` is `query` or `passage`: Arctic reads a query behind the
  prefix it was trained with, and the host adds it, since it is the model's
  contract, not a choice about the vault.
- **Budget, on this Mac: 100 ms for a call of 32 blocks and 10 ms for one
  query**; measured at 70–74 ms and 4.4–4.7 ms, loaded or quiet. The first
  build of the cache for a vault this size is about 12 s.
- **Refusals, before any work**: more than 256 texts or 1 MB of text in one
  call, and any one text the model cannot read whole. A refusal is
  `{ message, textIndex, reason }` — the text's position from 0 and one of
  three reasons, both null when the whole call was refused — and reaches
  TypeScript as an `EmbeddingError` whose `refused` names the text, so the
  chunker (P32-02) can split it or leave it out. A text is never cut or read
  past quietly: either would embed it as if part of it were not there.
  - `too-long`: more than 512 tokens.
  - `nothing-readable`: no token but the model's markers and `[UNK]` — empty,
    whitespace, control or zero-width characters, a lone emoji, or a script the
    vocabulary lacks (Khmer, some Thai). Only the text's own words count,
    never a query's prefix.
  - `unreadable-run`: one `[UNK]` standing for more than 24 characters.
    WordPiece reads any word over 100 characters, and any word of a script it
    has no pieces for, as a single `[UNK]`, so a pasted base64 blob or an
    unspaced sentence inside an English paragraph would vanish from its
    vector. 24 lets an emoji or a rare symbol through — the longest tried, a
    family emoji, is one `[UNK]` of 7 characters — and stops a phrase.
    Chinese, Japanese, Cyrillic, Arabic, hex digests and Markdown table rules
    are read, not refused.
- **The model is fetched on first use, not bundled.** 91 MB from its pinned
  Hugging Face revision (`d8c86521100d`) into
  `~/Library/Application Support/dev.jhoffman.atlas/models/`, kept per Mac,
  never in a vault and never synced. Each file streams into a temporary file of
  its own in that folder, is checked against its pinned size and SHA-256 as it
  is written, and is named only if it matches, by a rename that never replaces
  a file. Two Atlas processes fetching at once therefore cannot mix their bytes
  (the in-process lock does not reach across processes), and an interrupted
  fetch leaves nothing under the file's name.
- **The files on disk are checked before every load**, once per launch: each
  is read back and hashed — 165–177 ms for the 91 MB, measured, on a blocking
  thread, beside a load of 25–50 ms. One that does not match is removed and
  fetched again; offline, the error says it was removed. No stamp lets a launch
  skip the check: a stamp keyed on size and time would trust those over the
  bytes, and a fraction of a second once a launch, before the first semantic
  feature answers, is a small price.
- **Slow lines**: the fetch gives up only when the server sends nothing for
  60 s, not after a fixed time, so a slow line finishes. It does not resume a
  broken fetch with a range request: each fetch's staging file is its own,
  and 91 MB again is a small price for never sharing one.
- **The load lock is held through a first fetch.** Every call to embed needs
  the model, so a second call would wait for it either way, and nothing else
  takes that lock.
- **Offline**: once fetched, nothing touches the network. A first use with no
  network fails with a message that says so, and the next call tries again.

**Dependencies.** Candle 0.11 (`candle-core`, `candle-nn`,
`candle-transformers`, MIT or Apache-2.0) and `tokenizers` 0.22 (Apache-2.0),
Hugging Face's own pure-Rust framework and tokenizer: they read the
safetensors and tokenizer files these models publish as they are, and build
offline from the crate cache. `tempfile`, already a test dependency, now
stages the fetch. Chosen over ONNX Runtime (`ort`, `fastembed`), which
downloads a native library at build time and ships it beside the app;
`tract` (pure-Rust ONNX) was not measured. Candle adds 78 crates to the lock
file, all under MIT, Apache-2.0, BSD or Zlib terms; the release `atlas` binary
grows from 18.1 MB to 22.1 MB. Metal was not tried: the CPU met the budget.

## Consequences

- First build of the cache takes seconds to minutes depending on the vault; it
  runs in the background and resumes.
- The app download does not grow by the model. The first semantic feature used
  on a Mac waits for a 91 MB download, and does not work on a Mac that has
  never been online since installing Atlas.
- The integration tests that run the real model fetch it the first time, into
  `ATLAS_TEST_MODEL_DIR` or else the build's temporary folder, so a first
  `cargo test` on a machine needs the network. CI points the variable at a
  folder it caches under the model's revision (`gate.yml`), so a warm run never
  touches the network; a new revision fetches once. The test that races two
  fetches through a local proxy needs the network every time and is ignored by
  default: `cargo test --test embeddings_fetch_race -- --ignored`.
- A remote embedding provider can be a second implementation of the port,
  off by default.
- Changing the model means a new pinned revision and digests, and every cached
  vector is rebuilt: vectors from two models are not comparable.

## Amendment — the cache, the chunks and the build (P32-02, 2026-10-23)

**The cache is a file of its own**, `.atlas-cache/embeddings.sqlite`, beside
the index rather than a table in `index.sqlite`. Both are derived and
disposable; what differs is how often each is thrown away. The index has
changed shape twenty times and is discarded whenever it does, which costs
seconds; discarding the embeddings with it would cost minutes of model time
for a change that never touched a vector. A file of its own also keeps 384
floats a block out of the index that queries a note writes are run against
(ADR-0019), and gives the build a lock of its own, so its writes never wait
behind the index's on the typing path. It holds three tables: `meta` (the
generation), `notes` (each note's path, the digest of its text, its title)
and `block_embeddings`, keyed by path and ordinal, with each block's digest,
`^id`, heading, excerpt and vector (null when the model would not read it,
so it is known and not sent again). The **generation** is the chunking rules'
version, named by TypeScript (`chunks-1`), joined in Rust with the model's
pinned revision: a cache of another generation is discarded on open, so a new
model or new rules rebuild it, as the Consequences above require. Rust stores
and reads back; one command loads the whole cache as bytes (a JSON header,
then the vectors as little-endian f32s) and the blocks' words are read only
for the hits a search shows.

**A chunk is one block as a link names it** (`blockChunks`, domain): a
heading, a paragraph, a list item's own lines (nested items are chunks of
their own), and a quote, callout, table or piece of code whole. Query blocks,
raw markdown, rules and embeds are passed over, and so is a heading that only
repeats the note's title. Each chunk is embedded as `title`, the heading it
sits under, then its words, so a block is found by what its note and section
are about; a renamed note or heading therefore re-embeds its blocks. A block
over 1,200 characters is cut at spaces; one the model still refuses as too
long is halved, and one it cannot read is kept without a vector. Its digest
is 64 bits (`passageDigest`): the 32-bit `digestOf` would give two of 50,000
blocks the same digest about one time in three. A block whose digest the cache
already holds is never sent to the model again — moved, unchanged, or
repeated in another note.

**Which notes**: the user's own space, Archive included (a search leaves it
out unless asked, as the word search does); never `.atlas/` or a hidden
folder (`isEmbeddableNote`).

**The build** runs in the window, a note per idle moment, its writes whole
notes at a time, so a quit at any point leaves only notes it had not reached;
the next build starts from the difference between the index's digests and the
cache's (`embeddingWork`). After that the change feed (P28-03) keeps it in
step. Nothing is built until semantic search is first used in a vault on this
Mac — the first use fetches the 91 MB model, which is the user's to ask for —
and from then on the build resumes at each launch once the index is ready.

**Ranking** is brute-force cosine in TypeScript (`topByCosine`) over a copy
of the cache held in the window; at 50,000 blocks it was measured in the PR
for P32-02 (#33). The model's vectors are unit length, so cosine is a dot
product.

### Review round (2026-10-23)

**Privacy: `%%…%%` comments are never embedded or shown.** Text inside an
Obsidian comment, in a block or across blocks, is not a chunk's words; so it is
not sent to the model, not kept as an excerpt and not shown in a hit or by the
API. A paragraph that is only a comment is not a chunk, and an unclosed `%%`
hides the rest of the note, as Obsidian does. Code is code: a `%%` in a code
block is not a comment. A callout's title is part of its chunk (a callout with
only a title is a chunk of its title), and an `![[embed]]` is passed over.

**The API and MCP never opt a vault in.** Turning search by meaning on fetches
a 91 MB model, which is the person's to ask for from the app (⌘K, "By
meaning"). `GET /v1/search?mode=semantic` on a vault that has not been opted in
answers `semantic_off` (409) and asks nothing; once it is on, the caller shares
the palette's cache and build. `q` is at most 1000 characters there, and the
in-process seam cuts a longer question to what the model reads rather than
failing; its `limit` is held to 1–100 (20 when not a number).

**A damaged cache is thrown away, never a dead end.** Opening a file that is
torn or no database discards it and makes it afresh; one met damaged later is
made again and the window starts over from the notes. A load that cannot be
read back whole (vectors of different lengths, not whole numbers), or vectors
that are not the model's length at search time, clear the cache and rebuild.
`put` refuses vectors of mixed lengths; the connection waits up to 2 s for a
lock (`busy_timeout`).

**The window.** A passage's vector is found by digest wherever it is held, and
for a while after its last block is gone, so moving a note or folder embeds
nothing. A hit's excerpt is read `AND digest = ?`, so it can never show another
block's words; a search ranks again when a block changed under it. Hit links
resolve against every note the index holds, not only those embedded. Notes are
parsed in the index's worker, and the load is a header of lines read between
frames, padded so the vectors are viewed in place: no frame over 50 ms during
the first build (long notes included) or a relaunch with 50,000 cached blocks.
Cutting is at user-perceived characters (`Intl.Segmenter`), so a chunk, excerpt
or half never ends in half an emoji; a note that cannot be written alone is
held without blocks rather than stop the build.
