/**
 * Original port/vessel + laboratory line art used as the Dashboard hero's background layer when
 * no `heroImageUrl` is supplied by the active client profile (see components/DashboardHero.tsx and
 * docs/WHITE_LABEL.md). Drawn from scratch for this project — not a stock photo — so there is no
 * licensing concern in using it as the built-in, white-label-safe default.
 *
 * Colour comes from a small set of literal hex values lifted from the validated KPI accent
 * palette (packages/ui-kit/src/tokens.ts `kpi`) rather than `currentColor`, so the illustration
 * reads as a light, modern flat-line drawing with tasteful accents against the hero's brand-blue
 * gradient. The waterline and hull stay on `currentColor` (set by `.dash-hero__art`) so they keep
 * tracking the card's own tint regardless of the organization's brand colours.
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
      <g fill="none" stroke="currentColor" strokeWidth="2" opacity="0.9">
        {/* Waterline */}
        <path d="M0 300 Q 150 288 300 300 T 600 300 T 900 300 T 1200 300" strokeWidth="1.5" opacity="0.5" />
        <path d="M0 320 Q 150 310 300 320 T 600 320 T 900 320 T 1200 320" strokeWidth="1.5" opacity="0.35" />

        {/* Container vessel hull — kept as quiet line art: this sits directly behind the
            headline, under the scrim's darkest stop, so it stays a backdrop rather than
            competing with the text for attention. */}
        <path d="M60 300 L 120 300 L 140 275 L 430 275 L 450 300 L 60 300 Z" fill="currentColor" opacity="0.14" />
        <g opacity="0.55">
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
        <g opacity="0.6">
          <path d="M900 320 L900 90 L 1010 90 L 1010 320" />
          <path d="M900 110 L 1090 60" />
          <path d="M900 130 L 960 130" />
          <path d="M1090 60 L 1090 80" />
        </g>
        <g opacity="0.4">
          <path d="M1030 320 L1030 130 L 1110 130 L 1110 320" />
          <path d="M1030 145 L 1170 105" />
        </g>

        {/* Distant vessel silhouette */}
        <path d="M650 305 L 700 305 L 712 292 L 830 292 L 842 305 L 650 305 Z" opacity="0.3" fill="currentColor" />
        <path d="M735 292 L 735 260 L 765 260" opacity="0.3" />
      </g>

      {/* Colour accents: kept in the right third of the frame, past the text safe-zone and
          past the scrim's darkest stop (see .dash-hero__scrim), so they read as clean colour
          instead of being crushed under the overlay that guarantees the headline's contrast. */}
      <g opacity="0.95">
        <rect x="850" y="238" width="36" height="28" rx="2" fill="#1E7A4C" />
        <rect x="890" y="238" width="36" height="28" rx="2" fill="#C2760C" />
        <rect x="850" y="208" width="36" height="26" rx="2" fill="#0E7A88" />
        <rect x="890" y="208" width="36" height="26" rx="2" fill="#E8F1FB" opacity="0.9" />
        <circle cx="1090" cy="80" r="5" fill="#C2760C" />
        <circle cx="1170" cy="105" r="5" fill="#0E7A88" />
      </g>

      {/* Laboratory flask — the client's other business, set beside the container stacks */}
      <g transform="translate(955 220)" opacity="0.98">
        <path
          d="M14 4v22.4L2.4 51a7 7 0 0 0 6.3 10h30.6a7 7 0 0 0 6.3-10L34 26.4V4"
          fill="#E8F1FB"
          fillOpacity="0.18"
          stroke="#E8F1FB"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M10 4h28" stroke="#E8F1FB" strokeWidth="2.2" strokeLinecap="round" />
        <path
          d="M8.5 40h31c1.6 3 2.7 5.2 3.3 7.4a5.6 5.6 0 0 1-5.3 6.6H10.5a5.6 5.6 0 0 1-5.3-6.6c.6-2.2 1.7-4.4 3.3-7.4Z"
          fill="#0E7A88"
        />
        <circle cx="18" cy="34" r="2" fill="#C2760C" />
        <circle cx="26" cy="29" r="1.6" fill="#FFFFFF" opacity="0.8" />
        <circle cx="30" cy="38" r="2.2" fill="#FFFFFF" opacity="0.65" />
      </g>
    </svg>
  );
}
