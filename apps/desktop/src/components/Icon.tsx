/** A small, consistent line-icon set (16px grid, 1.5px stroke). Decorative by default. */
import type { SVGProps } from "react";

const paths = {
  check: "M3.5 8.5l3 3 6-7",
  cross: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  question: "M6.2 6.2a1.9 1.9 0 113 1.6c-.8.5-1.2.9-1.2 1.7M8 11.6v.1",
  minus: "M4 8h8",
  folder: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z",
  library: "M3 3v10M6 3v10M9.2 3.4l3.3 9.3",
  refresh: "M12.5 6.5A4.6 4.6 0 004 5.2M3.5 9.5A4.6 4.6 0 0012 10.8M4 2.8v2.6h2.6M12 13.2v-2.6H9.4",
  plus: "M8 3.5v9M3.5 8h9",
  chevronRight: "M6.5 4l4 4-4 4",
  chevronDown: "M4 6.5l4 4 4-4",
  arrowLeft: "M12.5 8h-9M7 4.5L3.5 8 7 11.5",
  external: "M9.5 3h3.5v3.5M13 3L8 8M11.5 9.5V13H3V4.5h3.5",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  warning: "M8 3l5.5 9.5h-11zM8 7v2.5M8 11.2v.1",
  info: "M8 13.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM8 7.3V11M8 5v.1",
  branch: "M5 3v10M5 9c0-2 6-1 6-4M11 3.5v1.6",
  terminal: "M3 4.5l3 3.5-3 3.5M7.5 11.5h5.5",
  search: "M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM10.3 10.3L13.5 13.5",
  command:
    "M6 6V4.5a1.5 1.5 0 10-1.5 1.5H6zm0 0h4m-4 0v4m4-4V4.5A1.5 1.5 0 1111.5 6H10zm0 0v4m0 0h1.5A1.5 1.5 0 1110 11.5V10zm0 0H6m0 0v1.5A1.5 1.5 0 114.5 10H6z",
  settings:
    "M2.5 4.5h6M11.5 4.5h2M2.5 8h1.5M7 8h6.5M2.5 11.5h6M11.5 11.5h2M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM5.5 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM10 10a1.5 1.5 0 110 3 1.5 1.5 0 010-3z",
  history: "M3 8a5 5 0 105-5c-1.6 0-3 .7-4 1.9M3.5 2.5v2.8h2.8M8 5.5V8l1.8 1.5",
  share: "M8 2.5v7.5M5 5.5l3-3 3 3M3.5 9v4h9V9",
  download: "M8 2.5V10M5 7l3 3 3-3M3.5 12.5h9",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  dot: "M8 9a1 1 0 100-2 1 1 0 000 2z",
  thread: "M2 8c2-3 4 3 6 0s4 3 6 0",
  play: "M5 3.5l7 4.5-7 4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  layers: "M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8L8 11l5.5-3M2.5 10.5L8 13.5l5.5-3",
  pencil: "M10.5 3l2.5 2.5L6 12.5H3.5V10z",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z",
  more: "M3.5 8h.1M8 8h.1M12.5 8h.1",
  panel: "M2.5 3.5h11v9h-11zM10 3.5v9",
  outline: "M3 4h10M5.5 8h7.5M5.5 12h7.5",
  upload: "M8 10.5V3M5 6l3-3 3 3M3.5 12.5h9",
} as const;

export type IconName = keyof typeof paths;

type Props = Omit<SVGProps<SVGSVGElement>, "name"> & { name: IconName; size?: number; label?: string };

export function Icon({ name, size = 16, label, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** The Habi mark: two warps and a weft forming an interlaced H. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <rect width="1024" height="1024" rx="232" fill="var(--ink)" />
      <g fill="none">
        <line
          x1="268"
          y1="520"
          x2="756"
          y2="520"
          stroke="var(--thread)"
          strokeWidth="76"
          strokeLinecap="round"
        />
        <line
          x1="660"
          y1="236"
          x2="660"
          y2="788"
          stroke="var(--paper)"
          strokeWidth="76"
          strokeLinecap="round"
        />
        <line x1="614" y1="520" x2="706" y2="520" stroke="var(--ink)" strokeWidth="124" />
        <line x1="606" y1="520" x2="714" y2="520" stroke="var(--thread)" strokeWidth="76" />
        <line x1="364" y1="466" x2="364" y2="574" stroke="var(--ink)" strokeWidth="124" />
        <line
          x1="364"
          y1="236"
          x2="364"
          y2="788"
          stroke="var(--paper)"
          strokeWidth="76"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
