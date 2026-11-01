/**
 * Keeps a file dropped anywhere but a drop zone from replacing the app.
 *
 * The host's own drag-and-drop is off (`dragDropEnabled: false`) so that a
 * page can be dropped on New artifact or on an artifact's note as an ordinary
 * HTML drop. The webview's default for a file dropped anywhere else is to
 * navigate to it — the whole app gone, and a stranger's page in its place.
 * This refuses that default everywhere a drop zone did not already take the
 * drop, and shows the no-drop cursor there. A link dragged in from a browser
 * (`text/uri-list`) is refused the same way: dropped where nothing takes it,
 * the webview loads it. Drags of anything else — text in the editor, a row in
 * Pages — are left alone.
 */
export function guardStrayFileDrops(target: Window): () => void {
  const onDragOver = (event: DragEvent) => {
    if (!wouldNavigate(event) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (event: DragEvent) => {
    if (wouldNavigate(event)) event.preventDefault();
  };
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  const stopMarking = markDragsOver(target);
  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
    stopMarking();
  };
}

/**
 * Sets `data-dragging` on the root while such a drag is over the window. A
 * frame's document hears a drop on it, not this window, so the stylesheet
 * turns frames' pointer events off then, and the drop lands where it is
 * refused. Counted, since every child entered and left fires its own pair.
 */
function markDragsOver(target: Window): () => void {
  const root = target.document.documentElement;
  let depth = 0;
  const clear = () => {
    depth = 0;
    delete root.dataset['dragging'];
  };
  const onEnter = (event: DragEvent) => {
    if (!wouldNavigate(event)) return;
    depth += 1;
    root.dataset['dragging'] = '';
  };
  const onLeave = (event: DragEvent) => {
    if (!wouldNavigate(event)) return;
    depth -= 1;
    if (depth <= 0) clear();
  };
  const events = [
    ['dragenter', onEnter],
    ['dragleave', onLeave],
    ['drop', clear],
    ['dragend', clear],
  ] as const;
  for (const [type, listener] of events) target.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of events) target.removeEventListener(type, listener);
    clear();
  };
}

const wouldNavigate = (event: DragEvent) =>
  NAVIGATING_TYPES.some((type) => event.dataTransfer?.types.includes(type) === true);

/** What a webview navigates to when it is dropped on a page that did not take it. */
const NAVIGATING_TYPES = ['Files', 'text/uri-list'];
