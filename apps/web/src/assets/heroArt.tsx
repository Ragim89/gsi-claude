/**
 * Original abstract port/vessel line art used as the Dashboard hero's background layer when no
 * `heroImageUrl` is supplied by the active client profile (see components/DashboardHero.tsx and
 * docs/WHITE_LABEL.md). Drawn from scratch for this project — not a stock photo — so there is no
 * licensing concern in using it as the built-in, white-label-safe default.
 */
export function HeroPortArt(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 1200 400"
      preserveAspectRatio="xMidYMax slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g opacity="0.9" fill="none" stroke="currentColor" strokeWidth="2">
        {/* Waterline */}
        <path d="M0 300 Q 150 288 300 300 T 600 300 T 900 300 T 1200 300" strokeWidth="1.5" opacity="0.5" />
        <path d="M0 320 Q 150 310 300 320 T 600 320 T 900 320 T 1200 320" strokeWidth="1.5" opacity="0.35" />

        {/* Container vessel hull + stacked containers */}
        <path d="M60 300 L 120 300 L 140 275 L 430 275 L 450 300 L 60 300 Z" fill="currentColor" opacity="0.12" />
        <g opacity="0.8">
          <rect x="150" y="235" width="40" height="30" />
          <rect x="192" y="235" width="40" height="30" />
          <rect x="234" y="235" width="40" height="30" />
          <rect x="150" y="205" width="40" height="28" />
          <rect x="192" y="205" width="40" height="28" />
          <rect x="276" y="235" width="40" height="30" />
          <rect x="318" y="235" width="40" height="30" />
          <rect x="360" y="235" width="40" height="30" />
        </g>
        <path d="M470 260 L 470 150 M 470 150 L 520 150 M 470 175 L 505 175" opacity="0.7" />

        {/* Quay cranes, right side */}
        <g opacity="0.75">
          <path d="M900 320 L900 90 L 1010 90 L 1010 320" />
          <path d="M900 110 L 1090 60" />
          <path d="M900 130 L 960 130" />
          <path d="M1090 60 L 1090 80" />
          <circle cx="1090" cy="80" r="4" fill="currentColor" />
        </g>
        <g opacity="0.55">
          <path d="M1030 320 L1030 130 L 1110 130 L 1110 320" />
          <path d="M1030 145 L 1170 105" />
          <circle cx="1170" cy="105" r="4" fill="currentColor" />
        </g>

        {/* Distant vessel silhouette */}
        <path d="M650 305 L 700 305 L 712 292 L 830 292 L 842 305 L 650 305 Z" opacity="0.3" fill="currentColor" />
        <path d="M735 292 L 735 260 L 765 260" opacity="0.3" />
      </g>
    </svg>
  );
}
