import {
  CODE_GRAMMARS,
  CODE_GRAMMAR_IMPORTS,
  createCodeLanguages,
  type CodeGrammar,
} from '@dfai/ui';
import { importAgain } from './chunk-files.ts';
import { chunkOf, type Chunk } from './on-first-use.ts';

/*
 * The code blocks' grammars, each a chunk fetched the first time a shown
 * block is in its language (#265). Each recovers from a failed load as a page
 * does (`pages-on-first-use.ts`): asked again, a grammar that would not run is
 * imported under a fresh address. A grammar's chunk imports nothing, so no
 * chunk is shared under it (#552). The build names each after its file.
 */

type GrammarModule = Awaited<ReturnType<(typeof CODE_GRAMMAR_IMPORTS)[CodeGrammar]>>;

const grammarChunks = new Map<CodeGrammar, Chunk<GrammarModule>>(
  CODE_GRAMMARS.map((grammar) => [
    grammar,
    chunkOf({ load: CODE_GRAMMAR_IMPORTS[grammar], loadAgain: importAgain(grammar) }),
  ]),
);

/** The app's one code highlighting, which every editor and reading draws with. */
export const codeLanguages = createCodeLanguages(async (grammar, { fresh }) => {
  const chunk = grammarChunks.get(grammar);
  if (chunk === undefined) throw new Error(`No chunk for the ${grammar} grammar`);
  return (await chunk.load({ fresh })).default;
});
