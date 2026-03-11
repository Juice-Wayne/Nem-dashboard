export function Logo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="6" fill="currentColor" opacity="0.1" />
      <path
        d="M18 4L8 18h6l-2 10 10-14h-6z"
        fill="#facc15"
        stroke="#eab308"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
