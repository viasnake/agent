const paths = {
  sidebar: "M3 4h18v16H3zM9 4v16",
  memory:
    "M4 3h6a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H4zM13 6a3 3 0 0 1 3-3h5v15h-5a3 3 0 0 0-3 3",
  calendar: "M4 5h16v16H4zM4 10h16M8 3v4M16 3v4M8 14h2M14 14h2M8 18h2",
  quote: "M10 5H3v8h6v2a4 4 0 0 1-4 4M21 5h-7v8h6v2a4 4 0 0 1-4 4",
  pin: "m8 3 8 0-1 6 4 5H5l4-5zM12 14v7",
  archive: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  edit: "m15 4 5 5M4 16 16 4a3 3 0 0 1 4 4L8 20l-5 1z",
  chat: "M21 11a9 9 0 0 1-9 9H3l2-4a9 9 0 1 1 16-5",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  copy: "M8 8h13v13H8zM16 8V3H3v13h5",
  expand: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  stop: "M5 5h14v14H5z",
  fork: "M7 3v12a5 5 0 0 0 5 5h5M7 10h6a4 4 0 0 0 4-4V3M4 6l3-3 3 3M14 6l3-3 3 3",
  retry: "M20 7v5h-5M20 12a8 8 0 1 0-2 6",
  chevron: "m7 10 5 5 5-5",
  left: "m14 6-6 6 6 6",
  right: "m10 6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  agent: "M12 3v3M8 3h8M5 8h14v12H5zM8 12h.01M16 12h.01M9 16h6M2 12v4M22 12v4",
  plus: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  send: "M12 19V5m-6 6 6-6 6 6",
  attach: "m8 12 7-7a3 3 0 0 1 4 4L9 19a5 5 0 0 1-7-7L12 2m-4 10 7-7",
  file: "M14 2H5v20h14V7zm0 0v5h5M8 12h8M8 16h6",
  down: "M12 4v16m-6-6 6 6 6-6",
  terminal: "m4 6 6 6-6 6m9 0h7",
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
