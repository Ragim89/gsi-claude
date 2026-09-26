/**
 * GSI design tokens — the single source of truth for brand colours and typography.
 * Consumed by:
 *   - apps/web (injected as CSS custom properties via <ThemeStyle />)
 *   - apps/api PDF templates (injected as CSS custom properties into the letterhead HTML)
 *
 * Nothing else in the codebase may hard-code brand colours; use var(--gsi-…) instead.
 *
 * Colours are sampled from the official logo files in ./assets (globe icon and the
 * "General Survey Inspection Co." wordmark): the globe's deep blue #105098, the wordmark's
 * mid blue #5888C0 and its light tint #D0E0F0, with black type.
 * The earlier navy/gold guess from the website reconstruction is gone.
 */
export const tokens = {
  color: {
    // Brand blue — the globe (#105098), with a darker shade for depth and hover.
    primary: '#105098',
    primaryHover: '#0C3E76',
    primaryDeep: '#0A3260',
    onPrimary: '#FFFFFF',
    // Secondary brand blue — the wordmark's globe and rule (#5888C0) and its light tint.
    accent: '#5888C0',
    accentLight: '#80A8D0',
    accentSoft: '#D0E0F0',
    onAccent: '#FFFFFF',
    // Neutrals — the wordmark's type is black; the UI softens it slightly for long reading.
    surface: '#FFFFFF',
    background: '#F3F6FA',
    text: '#14181F',
    // ASSUMPTION: muted/semantic colours are not defined by the logo; these are derived to sit
    // with the brand blues while keeping status colours distinguishable.
    textMuted: '#5A6474',
    border: '#D8DFE8',
    borderStrong: '#B4BFCD',
    success: '#1E7A4C',
    successBg: '#E3F3EA',
    warning: '#9A6A00',
    warningBg: '#FBF1D9',
    danger: '#B42318',
    dangerBg: '#FDE8E6',
    info: '#105098',
    infoBg: '#E4EDF9',
    // Sidebar shell — a fixed deep-navy base for the "premium enterprise" shell chrome.
    // Deliberately not part of the brand override: the organization's primary/accent still
    // drive the active-item highlight and logo, but the shell itself stays one consistent navy
    // across every deployment so white-labelled tenants don't end up with a sidebar in an
    // arbitrary brand hue that clashes with its own logo.
    sidebar: '#0B1B33',
    sidebarHover: '#122A4D',
    sidebarBorder: 'rgba(255, 255, 255, 0.08)',
    sidebarText: '#EAF0FA',
    sidebarTextMuted: '#93A2BD',
  },
  /**
   * Data-visualisation palette, kept separate from UI colours.
   * Validated with the dataviz validator against a #FFFFFF chart surface:
   * categorical trio passes CVD separation (worst adjacent ΔE 11.0 deutan) and the
   * normal-vision floor (26.6); the sequential ramp is single-hue, monotone in lightness
   * and clears the light-end contrast floor. `series3` sits below 3:1 against the surface,
   * so every chart using it also ships a legend, direct labels and a table view.
   * Re-run the validator if these values change.
   */
  viz: {
    series1: '#105098', // brand blue — revenue / primary measure
    series2: '#C05621', // expense / outflow
    series3: '#1BAF7A', // profit / inflow
    seq1: '#9BB6DC',
    seq2: '#719BD0',
    seq3: '#4878B8',
    seq4: '#2A5695',
    seq5: '#143A70',
    grid: '#E3E7EC',
    axis: '#8A93A1',
  },
  /**
   * KPI card accents — Dashboard Visual Upgrade 2.0. A calm, distinct hue per card family
   * (Jobs/Inspections/Samples/Reports/Revenue), used only for a small icon badge and a hairline
   * accent, never for body text or large fills. Kept separate from `viz` (the validated chart
   * palette) so this purely decorative set can evolve without re-running the dataviz validator.
   */
  kpi: {
    blue: '#105098',
    blueBg: '#E4EDF9',
    cyan: '#0E7A88',
    cyanBg: '#DEF2F4',
    green: '#1E7A4C',
    greenBg: '#E3F3EA',
    purple: '#6B3FA0',
    purpleBg: '#EEE6F6',
    amber: '#9A6A00',
    amberBg: '#FBF1D9',
  },
  font: {
    // ASSUMPTION: the wordmark is set in a bold italic grotesque; the exact typeface is not
    // supplied, so the UI uses a neutral grotesque stack and only the logo carries the lettering.
    // 'Noto Sans' / 'DejaVu Sans' are installed in the API container so Turkish glyphs render in PDFs.
    family: "'Inter', 'Noto Sans', 'Segoe UI', 'Helvetica Neue', 'DejaVu Sans', Arial, sans-serif",
    familyMono: "'JetBrains Mono', 'Consolas', 'DejaVu Sans Mono', monospace",
    sizeXs: '11px',
    sizeSm: '13px',
    sizeMd: '14px',
    sizeLg: '16px',
    sizeXl: '20px',
    size2xl: '26px',
    weightRegular: '400',
    weightMedium: '500',
    weightBold: '700',
  },
  radius: {
    sm: '6px',
    md: '8px',
    lg: '12px',
  },
  space: {
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '24px',
    6: '32px',
    7: '48px',
  },
  shadow: {
    // Kept deliberately light — "premium enterprise" reads as flat surfaces with a hairline
    // border doing most of the separation, not drop shadows.
    card: '0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 2px rgba(16, 24, 40, 0.06)',
  },
} as const;

export type Tokens = typeof tokens;

/**
 * Same shape as `Tokens`, but every leaf is a plain `string` rather than the literal type
 * `as const` gives the built-in palette — what an organization-branded override (PHASE 13.5,
 * ThemeStyle's `brand` prop) actually is: the same groups, with a couple of values replaced by
 * whatever hex string the organization configured.
 */
export type TokensLike = { [G in keyof Tokens]: Record<string, string> };

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Flattens tokens to CSS custom properties: tokens.color.primary → --gsi-color-primary. */
export function tokenVariables(t: TokensLike = tokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, values] of Object.entries(t)) {
    for (const [name, value] of Object.entries(values as Record<string, string>)) {
      out[`--gsi-${kebab(group)}-${kebab(name)}`] = String(value);
    }
  }
  return out;
}

/** Renders tokens as a CSS rule, e.g. `:root { --gsi-color-primary: #0B1F3A; … }`. */
export function toCssVariables(t: TokensLike = tokens, selector = ':root'): string {
  const body = Object.entries(tokenVariables(t))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}
