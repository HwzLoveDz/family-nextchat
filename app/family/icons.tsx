import type { CSSProperties } from "react";

const paths = {
  panel:
    "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  plus: "M12 5v14M5 12h14",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z",
  message: "M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4Z",
  archive: "M4 8h16v13H4V8ZM3 3h18v5H3V3Zm6 9h6",
  pin: "m9 3 6 0-1 5 4 4v2H6v-2l4-4-1-5Zm3 11v7",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  file: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8",
  voice: "M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4",
  arrowUp: "M12 20V4m-7 7 7-7 7 7",
  arrowDown: "M12 4v16m-7-7 7 7 7-7",
  close: "m6 6 12 12M6 18 18 6",
  logout: "M9 3H4v18h5m5-14 5 5-5 5m-6-5h13",
} as const;

export function FamilyIcon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "dots" ? 4 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={paths[name]} />
    </svg>
  );
}
