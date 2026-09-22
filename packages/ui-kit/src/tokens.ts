/**
 * GSI design tokens — the single source of truth for brand colours and typography.
 * Consumed by:
 *   - apps/web (injected as CSS custom properties via <ThemeStyle />)
 *   - apps/api PDF templates (injected as CSS custom properties into the letterhead HTML)
 *
 * Nothing else in the codebase may hard-code brand colours; use var(--gsi-…) instead.
 *
 * ASSUMPTION: HEX values are reconstructed from the public website (docs/00-overview.md) and are
 * pending the official GSI brand guideline (docs/07-open-questions.md #1). When the brandbook
 * arrives, only this file needs to change.
 */
export const tokens = {
  color: {
    // Primary (navy): #0B1F3A – #132C52
    primary: '#0B1F3A',
    primaryHover: '#132C52',
    onPrimary: '#FFFFFF',
    // Accent (amber / gold): #C89B3C – #D4A94A
    accent: '#C89B3C',
    accentLight: '#D4A94A',
    onAccent: '#0B1F3A',
    // Neutrals
    surface: '#FFFFFF',
    background: '#F4F5F7',
    text: '#1D2430',
    // ASSUMPTION: the tokens below are not in the brief; derived neutrals / semantic colours
    // chosen to sit with the navy + gold palette. Replace from the brandbook.
    textMuted: '#5B6475',
    border: '#D9DDE3',
    borderStrong: '#B8BFC9',
    success: '#1E7A4C',
    successBg: '#E3F3EA',
    warning: '#9A6A00',
    warningBg: '#FBF1D9',
    danger: '#B42318',
    dangerBg: '#FDE8E6',
    info: '#1F5AA6',
    infoBg: '#E4EDF9',
  },
  font: {
    // ASSUMPTION: brand typeface unknown ("гротеск без засечек"); neutral grotesque stack.
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
    sm: '4px',
    md: '6px',
    lg: '10px',
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
    card: '0 1px 2px rgba(11, 31, 58, 0.06), 0 1px 3px rgba(11, 31, 58, 0.08)',
  },
} as const;

export type Tokens = typeof tokens;

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Flattens tokens to CSS custom properties: tokens.color.primary → --gsi-color-primary. */
export function tokenVariables(t: Tokens = tokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, values] of Object.entries(t)) {
    for (const [name, value] of Object.entries(values as Record<string, string>)) {
      out[`--gsi-${kebab(group)}-${kebab(name)}`] = String(value);
    }
  }
  return out;
}

/** Renders tokens as a CSS rule, e.g. `:root { --gsi-color-primary: #0B1F3A; … }`. */
export function toCssVariables(t: Tokens = tokens, selector = ':root'): string {
  const body = Object.entries(tokenVariables(t))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}
