const paths = {
  agent: "M12 3v3M8 3h8M5 8h14v12H5zM8 12h.01M16 12h.01M9 16h6M2 12v4M22 12v4",
  plus: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  send: "M12 19V5m-6 6 6-6 6 6",
  attach: "m8 12 7-7a3 3 0 0 1 4 4L9 19a5 5 0 0 1-7-7L12 2m-4 10 7-7",
  file: "M14 2H5v20h14V7zm0 0v5h5M8 12h8M8 16h6",
  down: "M12 4v16m-6-6 6 6 6-6",
  terminal: "m4 6 6 6-6 6m9 0h7",
  logout: "M9 4H4v16h5m5-13 5 5-5 5m-6-5h11",
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
