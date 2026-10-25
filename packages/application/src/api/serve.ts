import type { HostVaultFsPort } from '../vault/ports.ts';
import type { ApiBridgePort, ApiRouterDeps, OpenNotes } from './ports.ts';
import { routeApiRequest } from './router.ts';

/**
 * Answers the local API's requests as they arrive, until the returned function
 * is called.
 *
 * `onWrote` runs after each write a request makes lands — a file created or
 * written, or properties saved through a pane — so the sidebar, the views and
 * the index catch up the way they do after a write from the app itself. Reads
 * do not run it: every refresh moves the index on, and a tool that only
 * queries would otherwise keep every view on screen re-running.
 */
export function serveApi({
  bridge,
  deps,
  onWrote,
}: {
  bridge: ApiBridgePort;
  deps: ApiRouterDeps;
  onWrote: () => void;
}): Promise<() => void> {
  const noticed = noticingWrites({ deps, onWrote });
  return bridge.serve((request) => routeApiRequest(request, noticed));
}

/**
 * The router's deps, with `onWrote` run after each write lands: what the
 * host's requests are answered through, and the chat's drafting tools, which
 * reach the same routes in-process (P32-05).
 */
export function noticingWrites({
  deps,
  onWrote,
}: {
  deps: ApiRouterDeps;
  onWrote: () => void;
}): ApiRouterDeps {
  return {
    ...deps,
    fs: noticingFs(deps.fs, onWrote),
    openNotes: noticingOpenNotes(deps.openNotes, onWrote),
  };
}

/** Runs `onWrote` once `written` lands, and passes on what it settled to either way. */
async function afterLanding<T>(written: Promise<T>, onWrote: () => void): Promise<T> {
  const value = await written;
  onWrote();
  return value;
}

function noticingFs(fs: HostVaultFsPort, onWrote: () => void): HostVaultFsPort {
  return {
    listDirectory: (path) => fs.listDirectory(path),
    listNotes: (options) => fs.listNotes(options),
    listFiles: (options) => fs.listFiles(options),
    readNotes: (paths) => fs.readNotes(paths),
    readTextFile: (path) => fs.readTextFile(path),
    readBinaryFile: (path) => fs.readBinaryFile(path),
    createNote: (args) => afterLanding(fs.createNote(args), onWrote),
    createFolder: (args) => afterLanding(fs.createFolder(args), onWrote),
    moveEntry: (args) => afterLanding(fs.moveEntry(args), onWrote),
    trashEntry: (args) => afterLanding(fs.trashEntry(args), onWrote),
    writeTextFile: (args) => afterLanding(fs.writeTextFile(args), onWrote),
    writeBinaryFile: (args) => afterLanding(fs.writeBinaryFile(args), onWrote),
  };
}

function noticingOpenNotes(openNotes: OpenNotes, onWrote: () => void): OpenNotes {
  return {
    state: (path) => openNotes.state(path),
    reload: (path) => openNotes.reload(path),
    setPropertiesIfOpen: async (args) => {
      const taken = await openNotes.setPropertiesIfOpen(args);
      if (taken) onWrote();
      return taken;
    },
  };
}
