/**
 * martzmakes design tokens — TypeScript port of `tokens-core.css`.
 *
 * Single source of truth for colors, type, spacing, radii, motion across
 * web + iOS + Android. Components import from here; nothing should hardcode
 * a hex value or px number.
 *
 * Brand override: edit `theme.colors.accent*` and `theme.colors.brandName`
 * in this file. Per-project brand tokens live in `./brand.ts` (optional).
 *
 * Reference: design system docs at `docs/design-system.md`.
 */

import { Platform } from "react-native";

// ─── Colors ──────────────────────────────────────────────────────────
export const colors = {
  // Near-black surfaces, slight cool shift (hue ~220).
  // Layering by surface tint, not shadow — each surface 4–8% lighter than below.
  bg0: "#07090C", // page background, deeper than surfaces
  bg1: "#0B0E13", // default surface
  surface1: "#11151C", // cards, panels
  surface2: "#171C25", // raised cards, popovers
  surface3: "#1E2430", // menus, modals
  surface4: "#262D3B", // hover on surface-2, inputs

  // Hairlines — structural, not decorative.
  line1: "rgba(255,255,255,0.06)", // subtle dividers
  line2: "rgba(255,255,255,0.10)", // default borders
  line3: "rgba(255,255,255,0.16)", // emphasized borders
  lineStrong: "rgba(255,255,255,0.24)", // focus rings, selected

  // Foregrounds — warm-white sits well on cool surfaces.
  fg1: "#EEF1F6", // primary text
  fg2: "#B8C0CC", // body / secondary
  fg3: "#8892A0", // tertiary, captions
  fg4: "#5D6674", // disabled, placeholder
  fg5: "#3E4653", // muted, marks

  // Accent — single electric blue. Used sparingly: primary buttons,
  // active nav, focus rings, one signal element per screen.
  accent: "#3B82FF",
  accentHover: "#5897FF",
  accentPress: "#2B6BE6",
  accentSoft: "rgba(59,130,255,0.12)",
  accentLine: "rgba(59,130,255,0.32)",
  accentFg: "#BFD4FF",

  // Semantic — desaturated to sit alongside the blue without competing.
  success: "#3DCF8E",
  successSoft: "rgba(61,207,142,0.12)",
  warn: "#E9B949",
  warnSoft: "rgba(233,185,73,0.12)",
  danger: "#F26D6D",
  dangerSoft: "rgba(242,109,109,0.12)",

  // Aliases — prefer these over raw scale tokens in components.
  bg: "#0B0E13",
  bgElevated: "#11151C",
  bgOverlay: "rgba(6,8,11,0.72)",
  text: "#EEF1F6",
  textMuted: "#B8C0CC",
  textDim: "#8892A0",
  textFaint: "#5D6674",
  border: "rgba(255,255,255,0.10)",
  borderSoft: "rgba(255,255,255,0.06)",
  borderLoud: "rgba(255,255,255,0.16)",

  brandName: "Local Bridge",
} as const;

// ─── Type ────────────────────────────────────────────────────────────
// Web loads General Sans + JetBrains Mono via CDN (see web fonts injected
// in deploy.yml). Native falls back to the system stack — RN doesn't load
// CDN webfonts. To use the brand fonts on native, bundle the .ttf files
// via expo-font.
const sansStack = Platform.select({
  web: "'General Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  ios: "System",
  android: "Roboto",
  default: "System",
});

const monoStack = Platform.select({
  web: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

export const fonts = {
  sans: sansStack as string,
  mono: monoStack as string,
  display: sansStack as string,
} as const;

// Geometric ramp tuned for dense technical UIs.
export const fontSizes = {
  xs: 12,
  sm: 13,
  base: 14,
  md: 15,
  lg: 16,
  lg2: 18,
  xl: 20,
  xl2: 24,
  xl3: 28,
  xl4: 34,
  display1: 44,
  display2: 56,
  display3: 72,
} as const;

export const lineHeights = {
  xs: 16,
  sm: 18,
  base: 20,
  md: 22,
  lg: 24,
  lg2: 26,
  xl: 28,
  xl2: 32,
  xl3: 36,
  xl4: 40,
  display1: 48,
  display2: 60,
  display3: 76,
} as const;

export const fontWeights = {
  regular: "400",
  medium: "500",
  semi: "600",
  bold: "700",
} as const;

// Tracking — tighter at display, neutral on mono, wide on UPPERCASE labels.
export const tracking = {
  tight: -0.7, // ~ -0.02em at 34px
  snug: -0.15, // ~ -0.01em at 15px
  normal: 0,
  wide: 0.3,
  ucase: 1, // ~ +0.08em at 12px (eyebrow labels)
} as const;

// ─── Spacing — strict 4px grid ───────────────────────────────────────
export const space = {
  s0: 0,
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
  s16: 64,
  s20: 80,
  s24: 96,
} as const;

// ─── Radii — moderate, never balloon-soft ────────────────────────────
export const radii = {
  r1: 4, // buttons, chips
  r2: 6, // inputs, small cards
  r3: 8, // cards
  r4: 10, // large panels
  r5: 14, // hero surfaces
  full: 999,
} as const;

// ─── Elevation — surface tint first, shadow second & subtle ──────────
// React Native shadows differ web vs native. These produce the closest
// equivalent on each platform.
export const shadows = {
  s1: Platform.select({
    web: {
      boxShadow:
        "0 1px 0 rgba(255,255,255,0.02) inset, 0 1px 2px rgba(0,0,0,0.40)",
    },
    default: {
      shadowColor: "#000",
      shadowOpacity: 0.4,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
  }),
  s2: Platform.select({
    web: {
      boxShadow:
        "0 1px 0 rgba(255,255,255,0.03) inset, 0 4px 12px rgba(0,0,0,0.45)",
    },
    default: {
      shadowColor: "#000",
      shadowOpacity: 0.45,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
  }),
  s3: Platform.select({
    web: {
      boxShadow:
        "0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 28px rgba(0,0,0,0.55)",
    },
    default: {
      shadowColor: "#000",
      shadowOpacity: 0.55,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 10 },
      elevation: 10,
    },
  }),
} as const;

// ─── Motion — crisp 150-250ms ────────────────────────────────────────
export const motion = {
  dur1: 120,
  dur2: 180,
  dur3: 240,
  // CSS easing strings — used in transition/animation declarations on web.
  easeOut: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  easeIn: "cubic-bezier(0.4, 0, 0.8, 0.2)",
  easeIo: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

// ─── Layout ──────────────────────────────────────────────────────────
export const layout = {
  container: 1200,
  containerWide: 1320,
  containerNarrow: 860,
  navHeight: 56,
} as const;

// ─── Aggregate ───────────────────────────────────────────────────────
export const theme = {
  colors,
  fonts,
  fontSizes,
  lineHeights,
  fontWeights,
  tracking,
  space,
  radii,
  shadows,
  motion,
  layout,
} as const;

export type Theme = typeof theme;
