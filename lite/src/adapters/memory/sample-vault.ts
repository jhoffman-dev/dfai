import { FAVORITES_PATH } from '../../domain/favorites/index.ts';
import type { VaultPath } from '../../domain/vault/index.ts';
import { MemoryNoteStore } from '../../application/testing/index.ts';

/**
 * A small fictional vault: what `pnpm dev` and the e2e smoke run on when no
 * repository is connected. Every name in it is made up.
 */
export const SAMPLE_VAULT: Readonly<Record<VaultPath, string>> = {
  'Inbox/Ideas for the offsite.md':
    'A few things to raise at the team offsite. #idea\n\n- Ask [[Tobias Fenn]] about the release train.\n- A shared glossary for [[Larkspur Payroll]].\n',
  'Inbox/Reading list.md':
    'Articles and books to get to. #reading\n\n- The design of everyday things\n- [[Weekly review]] checklist ideas\n',
  'People/Mara Quill.md':
    'Mara Quill leads payroll operations at Larkspur. #person\n\n- Prefers written updates before meetings.\n- Owns [[Larkspur Payroll]] go-live.\n',
  'People/Tobias Fenn.md':
    'Tobias Fenn is the engineering lead on the payroll integration. #person\n\nWorks closely with [[Mara Quill]].\n',
  'Projects/Larkspur Payroll.md':
    'Moving Larkspur onto the new payroll system by the end of the quarter. #project/active\n\n## Goals\n\n- Parallel run for two pay cycles.\n- Sign-off from [[Mara Quill]].\n\n## Links\n\n- [[2026-11-14 Larkspur kickoff]]\n- [[2026-11-21 Weekly sync]]\n- [[Data migration plan]]\n',
  'Projects/Data migration plan.md':
    'How employee records move from the old system. #project/active #payroll\n\n1. Export from the old system.\n2. Validate with [[Tobias Fenn]].\n3. Load into staging.\n\n```\n#not-a-tag inside code\n```\n',
  'Projects/Garden shed.md':
    'Building a shed at the bottom of the garden. #project/someday\n\nNeeds a [[Materials list]].\n',
  'Meetings/2026/11/2026-11-14 Larkspur kickoff.md':
    'Kicked off the payroll move and agreed the timeline. #meeting\n\n- When: 2026-11-14 10:00–11:00\n- With: [[Mara Quill]], [[Tobias Fenn]]\n- About: [[Larkspur Payroll]]\n\n## Decisions\n\n- Two parallel pay cycles before cutover.\n',
  'Meetings/2026/11/2026-11-21 Weekly sync.md':
    'Reviewed the migration dry run. #meeting\n\n- When: 2026-11-21 10:00–10:30\n- With: [[Mara Quill]]\n- About: [[Larkspur Payroll]]\n\n## Next steps\n\n- [[Mara Quill]] sends the revised plan by Friday.\n',
  'Areas/Health.md':
    'Keeping fit and sleeping well. #area/health\n\n- Walk every morning.\n- See [[Weekly review]].\n',
  'Resources/Weekly review.md':
    'A checklist for the Friday review. #process\n\n- Empty the Inbox.\n- Check [[Larkspur Payroll]] next steps.\n- Plan next week.\n',
  'Welcome.md':
    'Welcome to DFAI Lite, a fast notes app over a GitHub repository. #help\n\nLinks look like [[Larkspur Payroll]], tags like #idea. Following a link to a note that does not exist, such as [[Materials list]], creates it.\n',
  [FAVORITES_PATH]: '[\n  "Projects/Larkspur Payroll.md",\n  "Welcome.md"\n]\n',
};

/** A fresh in-memory store holding the sample vault, every file clean. */
export function sampleNoteStore(): MemoryNoteStore {
  return MemoryNoteStore.of(SAMPLE_VAULT);
}
