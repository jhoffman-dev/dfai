/** Small line icons, drawn inline so nothing is fetched. Decorative: the control carries the label. */

const PATHS = {
  plus: 'M8 3v10M3 8h10',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.5-1.5L14 14',
  star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z',
  chevron: 'M6 4l4 4-4 4',
  tag: 'M2 2h5.5L14 8.5 8.5 14 2 7.5Zm3 3h.01',
  graph:
    'M4 4l8 2M4 4l2 8m6-6l-6 6M4 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm8 2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-6 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-8.5v2m0 9v2M1.5 8h2m9 0h2M3.4 3.4l1.4 1.4m6.4 6.4 1.4 1.4m0-9.2-1.4 1.4m-6.4 6.4-1.4 1.4',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Zm6.5 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  pencil: 'M10.5 2.5l3 3L6 13H3v-3Z',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, filled = false }: { name: IconName; filled?: boolean }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.4 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
