// A back arrow for pages built with Polaris. Shows an icon only (the label is for screen readers).
export default function BackButton({ href, label }) {
  return <s-button variant="tertiary" icon="arrow-left" href={href} accessibilityLabel={label} />;
}

// The same arrow for the full-screen editors, drawn inline so it matches their own styling.
export function ArrowLeft({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M11.5 4.5 6 10l5.5 5.5M6.5 10h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
