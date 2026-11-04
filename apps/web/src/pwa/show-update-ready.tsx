import { UpdateReadyBar } from '@dfai/ui';
import { createRoot } from 'react-dom/client';

/** The "Update ready" line in a root of its own beside the app's, as the sign-out is (start-web.tsx). */
export function showUpdateReady(page: Pick<Window, 'document'>, onReload: () => void): void {
  const host = page.document.createElement('div');
  page.document.body.append(host);
  createRoot(host).render(<UpdateReadyBar onReload={onReload} />);
}
