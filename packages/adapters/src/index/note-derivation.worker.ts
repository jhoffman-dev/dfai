import { remarkMarkdown } from '../markdown/markdown-port.ts';
import {
  isChunkRequest,
  serveNoteChunking,
  type ChunkRequest,
} from '../embeddings/note-chunking.ts';
import {
  serveNoteDerivation,
  type DerivationAnswer,
  type DerivationRequest,
} from './worker-note-deriver.ts';

/**
 * The worker the index's notes are read in (#135): the markdown reader and
 * the rules of the index, on a thread that is not the window's. It is given
 * note text and answers with rows; it touches no file and no host. The same
 * script, started again under another name, cuts notes into the passages
 * that semantic search embeds (`serveNoteChunking`): parsing a long note is
 * not work for the window's thread either.
 */
const serve = serveNoteDerivation({
  markdown: remarkMarkdown,
  answer: (answer: DerivationAnswer) => postMessage(answer),
});

const chunk = serveNoteChunking({
  markdown: remarkMarkdown,
  answer: (answer) => postMessage(answer),
});

addEventListener('message', (event: MessageEvent<DerivationRequest | ChunkRequest>) => {
  if (isChunkRequest(event.data)) chunk(event.data);
  else serve(event.data);
});
