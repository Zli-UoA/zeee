type Props = {
  className?: string;
};

export function ZeeeLogo({ className }: Props) {
  return (
    <svg
      viewBox="0 0 339 92"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M153 81H103V68.9179L135.215 24.0821H103.873V12H152.127V24.0821L119.958 68.9179H153V81Z"
        fill="currentColor"
      />
      <path
        d="M215 81H165V12H215V23.9877H183.409V39.1375H212.803V51.1252H183.409V68.9179H215V81Z"
        fill="currentColor"
      />
      <path
        d="M277 81H227V12H277V23.9877H245.409V39.1375H274.803V51.1252H245.409V68.9179H277V81Z"
        fill="currentColor"
      />
      <path
        d="M339 81H289V12H339V23.9877H307.409V39.1375H336.803V51.1252H307.409V68.9179H339V81Z"
        fill="currentColor"
      />
      <rect
        y="45.9619"
        width="65"
        height="65"
        rx="5"
        transform="rotate(-45 0 45.9619)"
        fill="currentColor"
      />
    </svg>
  );
}
