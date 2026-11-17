import { test } from './fixtures.ts';
import { openFirstRunByTouch, showPagesInTheDrawerByTouch } from './sidebar-pages-touch.ts';

// #902 on a phone: Pages, hidden on a first run, is shown by thumb from the
// drawer's header.

test('on a phone, Show Pages is reached by touch in the drawer, which stays open', async ({
  page,
}) => {
  await openFirstRunByTouch(page);
  await showPagesInTheDrawerByTouch(page);
});
