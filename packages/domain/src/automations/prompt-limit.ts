/**
 * The longest a prompt note may be: a rule's instructions, not a document. A
 * skill's instructions are held to the same length (ADR-0050), since either
 * is handed to the model as one argument (ADR-0021). Its own module so the
 * Claude step and the skills' rules share it without importing each other.
 */
export const MAX_PROMPT_CHARACTERS = 20_000;
