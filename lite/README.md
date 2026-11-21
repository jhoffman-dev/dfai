# DFAI Lite

A fast, local-first markdown notes app over a GitHub repository. Notes are
plain `.md` files (title = file name, no frontmatter), linked with
`[[wikilinks]]` and tagged inline with `#tags`. The vault's rules are in
[`vault-template/CLAUDE.md`](vault-template/CLAUDE.md); how to work here is in
[`CLAUDE.md`](CLAUDE.md).

## Commands

```sh
export PATH="/opt/homebrew/bin:$PATH"
pnpm install
pnpm dev        # the app, on a sample vault in memory unless a repo is connected
pnpm check      # typecheck + lint + format:check + unit tests + build
pnpm test       # unit tests only
pnpm e2e        # build, then the Playwright smoke (Chromium)
pnpm index <path-to-vault>   # write _index/ for a vault folder
```

## Layout

| Where              | What                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `src/domain/`      | The rules, pure: `links/`, `tags/`, `vault/`, `index/`, `favorites/`, `sync/`                     |
| `src/application/` | `ports/` (the interfaces adapters implement), `session/`, `use-cases/`, `sync/`, `testing/` fakes |
| `src/adapters/`    | Implementations of the ports; `memory/` holds the sample vault                                    |
| `src/ui/`          | React components                                                                                  |
| `src/app/`         | The composition root                                                                              |
| `tools/`           | Node scripts reusing `src/domain`                                                                 |
| `e2e/`             | The Playwright smoke                                                                              |

Each module is imported through its `index.ts`; ESLint holds the layer
direction (domain → nothing, application → domain, adapters → both, UI →
application and domain types).
