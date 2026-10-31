/**
 * The longest a prompt note may be: a rule's instructions, not a document. A
 * skill's instructions are held to the same length (ADR-0050), since either
 * is handed to the model as one argument (ADR-0021), so both are counted as
 * that argument is: in UTF-16 units, `.length`, where an emoji is two. In the
 * chat's module, which neither automations nor skills is, so both share it.
 */
export const MAX_PROMPT_CHARACTERS = 20_000;
