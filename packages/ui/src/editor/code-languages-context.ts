import { createContext, useContext } from 'react';
import type { CodeLanguages } from './code-languages.ts';

/**
 * The app's code highlighting, which every editor and reading of a note
 * colours its code blocks with. Until the app provides it, code blocks are
 * drawn as their plain text.
 */
const CodeLanguagesContext = createContext<CodeLanguages | null>(null);

export const CodeLanguagesProvider = CodeLanguagesContext.Provider;

export function useCodeLanguages(): CodeLanguages | null {
  return useContext(CodeLanguagesContext);
}
