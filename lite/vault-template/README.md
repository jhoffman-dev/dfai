Setting up a DFAI Lite vault: a private GitHub repo that the app syncs and Claude reads. Delete this file once the vault is running.

## 1. Make the private repo

The template is a folder in the public DFAI repo, so copy it rather than using GitHub's "Use this template":

```sh
gh repo create notes --private          # any name; keep it private
git clone https://github.com/<you>/notes.git ~/vaults/notes
cp -R lite/vault-template/. ~/vaults/notes/   # run from a DFAI checkout
cd ~/vaults/notes
git add -A && git commit -m "Vault: start from the DFAI Lite template" && git push
```

Coming from DFAI? Skip the `cp` and migrate instead (step 4).

## 2. A token for the app

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:

- **Repository access:** Only select repositories → the vault repo, nothing else.
- **Permissions → Repository → Contents:** Read and write. (Metadata: read is added for you.) No other permission.
- Pick an expiry you will notice; paste the token into the app's settings. It stays in that browser only.

## 3. Turn on the index Action

`.github/workflows/index.yml` rebuilds `_index/` when anyone but the app pushes (Claude, an edit on github.com). In the repo:

- **Actions** tab → enable workflows if GitHub asks.
- **Settings → Actions → General → Workflow permissions:** if the Action's push fails with a 403, choose "Read and write permissions".

It needs no secret: it checks out the public DFAI repo for the index writer.

## 4. Migrate a DFAI vault

Needs Node 22.18 or later. From a DFAI checkout, into a new empty folder (the DFAI vault is only read, never changed):

```sh
node lite/tools/migrate-from-dfai.ts ~/path/to/dfai-vault ~/vaults/notes-new
```

It strips frontmatter (tags become inline `#tags`, other properties a `- Key: value` list, favourites go to `.dfai-lite/favorites.json`), moves meetings to `Meetings/<YYYY>/<MM>/` and people to `People/`, adds `CLAUDE.md` and the Action, writes `_index/`, and prints every property it dropped and every name clash. Read the report, then push the folder to the private repo:

```sh
cd ~/vaults/notes-new
git init -b main && git add -A && git commit -m "Vault: migrated from DFAI"
git remote add origin https://github.com/<you>/notes.git && git push -u origin main
```

To rebuild the index by hand at any time: `node lite/tools/build-index.ts ~/vaults/notes`.
