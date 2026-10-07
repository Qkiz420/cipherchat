// Design tokens for CipherChat. Dark-first utility theme (from /app/design_guidelines.json).
// The app ships a single dark palette; both scheme slots point to it.

import { useMemo } from "react";
import { Appearance, StyleSheet } from "react-native";

export type ColorScheme = "light" | "dark";

const dark = {
  surface: "#090A0B",
  onSurface: "#FFFFFF",
  surfaceSecondary: "#141517",
  onSurfaceSecondary: "#EAEBEB",
  surfaceTertiary: "#1C1D20",
  onSurfaceTertiary: "#C0C2C4",
  surfaceInverse: "#FFFFFF",
  onSurfaceInverse: "#090A0B",
  muted: "#787A7D",

  brand: "#CCFF00",
  onBrand: "#090A0B",
  brandPrimary: "#CCFF00",
  onBrandPrimary: "#090A0B",
  brandSecondary: "#1C1D20",
  onBrandSecondary: "#CCFF00",
  brandTertiary: "#262F00",
  onBrandTertiary: "#CCFF00",

  success: "#00E676",
  onSuccess: "#002D15",
  warning: "#FFB000",
  onWarning: "#332300",
  error: "#FF3B30",
  onError: "#4A0704",
  info: "#787A7D",
  onInfo: "#FFFFFF",

  border: "#2A2B2D",
  borderStrong: "#3C3D40",
  divider: "#1F2022",
  overlay: "rgba(0,0,0,0.6)",
};

export type ThemeColors = typeof dark;

export const defaultScheme = "dark" satisfies ColorScheme;

export const themes: { light: ThemeColors; dark: ThemeColors } = { light: dark, dark };

export const colors = dark;

export function setColorScheme(scheme: ColorScheme | null) {
  Appearance.setColorScheme?.(scheme ?? "unspecified");
}

// Dark-only app: keep native chrome dark.
setColorScheme?.("dark");

export function useTheme(): { scheme: ColorScheme; colors: ThemeColors } {
  return { scheme: "dark", colors: dark };
}

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors: c } = useTheme();
    return useMemo(() => StyleSheet.create(factory(c)), [c]);
  };
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 };
export const fonts = {
  display: "Rajdhani-Medium",
  displayRegular: "Rajdhani-Regular",
  text: "Satoshi-Regular",
  textMedium: "Satoshi-Medium",
  mono: "SpaceMono",
};
