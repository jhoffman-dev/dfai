import { test } from './fixtures.ts';
import { openFirstRunByTouch, showPagesInTheDrawerByTouch } from './sidebar-pages-touch.ts';

// #902 on an iPad held upright, where the sidebar is a drawer: Pages, hidden
// on a first run, is shown by touch from the drawer's header.

test('on an iPad upright, Show Pages is reached by touch in the drawer, which stays open', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await openFirstRunByTouch(page);
  await showPagesInTheDrawerByTouch(page);
});
