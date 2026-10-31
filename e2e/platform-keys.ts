/**
 * The platform's own editing keys, where WebKit's differ by platform. The app's
 * shortcuts are not here: they press `ControlOrMeta`, the app's command key on
 * each platform (`runsOnMac` in app-shortcuts.ts, ProseMirror's `Mod`).
 *
 * A line's end and start: in WebKit on macOS, End and Home scroll and leave the
 * caret where it was (#448), and ⌘→ and ⌘← are the Mac's end and start of line.
 * In WebKit on Linux, End and Home move the caret, and ⌘ does nothing.
 */
const onMac = process.platform === 'darwin';

export const LINE_END = onMac ? 'Meta+ArrowRight' : 'End';
export const LINE_START = onMac ? 'Meta+ArrowLeft' : 'Home';
