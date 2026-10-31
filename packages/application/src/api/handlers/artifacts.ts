import type { ARTIFACT_ROUTES } from '../contract/artifacts.ts';
import { artifactFileRoute, artifactThumbnailRoute, saveArtifactRoute } from '../artifacts.ts';
import { type HandlerTable, vaultRoute, vaultWrite } from './route-handler.ts';

/** What answers each route for saved artifacts. */
export const ARTIFACT_HANDLERS: HandlerTable<typeof ARTIFACT_ROUTES> = {
  'POST /v1/artifacts': vaultWrite(saveArtifactRoute),
  'PUT /v1/artifacts/{path}/files/{name}': vaultRoute(artifactFileRoute),
  'POST /v1/artifacts/{path}/thumbnail': vaultRoute(artifactThumbnailRoute),
};
