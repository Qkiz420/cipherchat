import * as Haptics from "expo-haptics";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { fonts, makeStyles, radius, spacing, useTheme } from "../theme";
import { Ionicons } from "../ui";

export const PIN_LENGTH = 6;

type Props = {
  title: string;
  subtitle?: string;
  error?: string | null;
  disabled?: boolean;
  onComplete: (pin: string) => void;
  onBiometric?: () => void;
  testIDPrefix: string;
};

export function PinPad({ title, subtitle, error, disabled, onComplete, onBiometric, testIDPrefix }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [pin, setPin] = useState("");

  useEffect(() => {
    if (error) setPin("");
  }, [error]);

  const press = (d: string) => {
    if (disabled || pin.length >= PIN_LENGTH) return;
    Haptics.selectionAsync();
    const next = pin + d;
    setPin(next);
    if (next.length === PIN_LENGTH) {
      setTimeout(() => {
        onComplete(next);
        setPin("");
      }, 120);
    }
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <View style={styles.wrap}>
      <Ionicons name="lock-closed" size={28} color={colors.brandPrimary} />
      <Text style={styles.title} testID={`${testIDPrefix}-title`}>{title}</Text>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      <View style={styles.dots}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <View key={i} style={[styles.dot, i < pin.length && styles.dotOn]} />
        ))}
      </View>
      <Text style={styles.error} testID={`${testIDPrefix}-error`}>{error ?? " "}</Text>
      <View style={styles.grid}>
        {keys.map((k) => (
          <Pressable key={k} testID={`${testIDPrefix}-key-${k}`} onPress={() => press(k)} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
            <Text style={styles.keyText}>{k}</Text>
          </Pressable>
        ))}
        {onBiometric ? (
          <Pressable testID={`${testIDPrefix}-biometric`} onPress={onBiometric} style={styles.keyGhost}>
            <Ionicons name="scan-outline" size={26} color={colors.brandPrimary} />
          </Pressable>
        ) : (
          <View style={styles.keyGhost} />
        )}
        <Pressable testID={`${testIDPrefix}-key-0`} onPress={() => press("0")} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
          <Text style={styles.keyText}>0</Text>
        </Pressable>
        <Pressable testID={`${testIDPrefix}-backspace`} onPress={() => setPin((p) => p.slice(0, -1))} style={styles.keyGhost}>
          <Ionicons name="backspace-outline" size={24} color={colors.onSurface} />
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: "center", paddingHorizontal: spacing.xl },
  title: { fontFamily: fonts.display, fontSize: 24, letterSpacing: 1.5, color: c.onSurface, marginTop: spacing.md },
  subtitle: { fontFamily: fonts.text, fontSize: 13, color: c.muted, textAlign: "center", marginTop: spacing.xs },
  dots: { flexDirection: "row", gap: spacing.md, marginTop: spacing.xl },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: c.borderStrong },
  dotOn: { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary },
  error: { fontFamily: fonts.text, fontSize: 13, color: c.error, marginTop: spacing.md, minHeight: 18 },
  grid: { flexDirection: "row", flexWrap: "wrap", width: 264, gap: 12, marginTop: spacing.md, justifyContent: "center" },
  key: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center" },
  keyPressed: { backgroundColor: c.brandTertiary },
  keyGhost: { width: 72, height: 72, alignItems: "center", justifyContent: "center" },
  keyText: { fontFamily: fonts.display, fontSize: 28, color: c.onSurface },
}));
