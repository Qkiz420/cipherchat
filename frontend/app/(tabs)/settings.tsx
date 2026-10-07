import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth, useSession } from "@/src/auth";
import { keyFingerprint } from "@/src/crypto";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, Ionicons } from "@/src/ui";

const LAYERS: { icon: any; title: string; text: string }[] = [
  { icon: "eye-off-outline", title: "Zero-knowledge login", text: "Your password is stretched on-device. The server only gets a derived hash and can never decrypt your keys." },
  { icon: "key-outline", title: "End-to-end encryption", text: "X25519 key exchange + XSalsa20-Poly1305. Only members' devices can open messages." },
  { icon: "shuffle-outline", title: "Fresh key per message", text: "Every message gets its own random key and a one-time ephemeral keypair." },
  { icon: "finger-print-outline", title: "Signed messages", text: "Ed25519 signatures prove who sent each message and that nobody altered it." },
  { icon: "resize-outline", title: "Length padding", text: "Messages are padded to fixed-size blocks so their length leaks nothing." },
  { icon: "timer-outline", title: "Self-destruct", text: "Disappearing messages are erased from the server automatically when they expire." },
];

export default function SettingsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { logout } = useAuth();
  const { user, identity } = useSession();
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const fp = keyFingerprint(identity.boxPub, identity.signPub);

  const copy = async () => {
    await Clipboard.setStringAsync(fp);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setToast("Fingerprint copied");
    setTimeout(() => setToast(null), 1800);
  };

  const onLogout = async () => {
    await logout();
    router.replace("/auth");
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>SETTINGS</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: bottomChrome + spacing.xl }}>
        <View style={styles.profile}>
          <Avatar name={user.display_name} size={56} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name} testID="profile-display-name">{user.display_name}</Text>
            <Text style={styles.username} testID="profile-username">@{user.username}</Text>
          </View>
        </View>

        <Text style={styles.section}>IDENTITY KEY FINGERPRINT</Text>
        <Pressable testID="copy-fingerprint-button" onPress={copy} style={styles.fpBlock}>
          <Text style={styles.fp} testID="my-fingerprint">{fp}</Text>
          <View style={styles.copyRow}>
            <Ionicons name="copy-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.copyText}>Tap to copy · compare in person to verify</Text>
          </View>
        </Pressable>

        <Text style={styles.section}>SECURITY LAYERS ACTIVE</Text>
        <View style={styles.card}>
          {LAYERS.map((l, i) => (
            <View key={l.title} style={[styles.layer, i > 0 && styles.layerBorder]}>
              <Ionicons name={l.icon} size={18} color={colors.brandPrimary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.layerTitle}>{l.title}</Text>
                <Text style={styles.layerText}>{l.text}</Text>
              </View>
              <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            </View>
          ))}
        </View>

        {confirm ? (
          <Pressable testID="logout-confirm-button" onPress={onLogout} style={[styles.logout, { backgroundColor: colors.error }]}>
            <Ionicons name="power" size={18} color={colors.onError} />
            <Text style={[styles.logoutText, { color: colors.onError }]}>CONFIRM · DESTROY SESSION</Text>
          </Pressable>
        ) : (
          <Pressable testID="logout-button" onPress={() => setConfirm(true)} style={styles.logout}>
            <Ionicons name="power" size={18} color={colors.error} />
            <Text style={styles.logoutText}>DESTROY SESSION</Text>
          </Pressable>
        )}
        {confirm && (
          <Pressable testID="logout-cancel-button" onPress={() => setConfirm(false)} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        )}
      </ScrollView>

      {toast && (
        <Animated.View entering={FadeInDown} exiting={FadeOut} style={[styles.toast, { bottom: bottomChrome + spacing.lg }]} testID="toast">
          <Ionicons name="checkmark" size={16} color={colors.onSurfaceInverse} />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  title: { fontFamily: fonts.display, fontSize: 28, color: c.onSurface, letterSpacing: 2 },
  profile: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  name: { fontFamily: fonts.display, fontSize: 22, color: c.onSurface },
  username: { fontFamily: fonts.mono, fontSize: 12, color: c.muted },
  section: { fontFamily: fonts.display, fontSize: 13, letterSpacing: 1.5, color: c.muted, marginTop: spacing.xl, marginBottom: spacing.sm },
  fpBlock: { backgroundColor: c.surfaceTertiary, borderRadius: radius.md, borderWidth: 1, borderColor: c.borderStrong, padding: spacing.lg },
  fp: { fontFamily: fonts.mono, fontSize: 16, color: c.brandPrimary, letterSpacing: 1, lineHeight: 26 },
  copyRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  copyText: { fontFamily: fonts.text, fontSize: 12, color: c.muted },
  card: { backgroundColor: c.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  layer: { flexDirection: "row", gap: spacing.md, padding: spacing.md, alignItems: "flex-start" },
  layerBorder: { borderTopWidth: 1, borderTopColor: c.divider },
  layerTitle: { fontFamily: fonts.textMedium, fontSize: 14, color: c.onSurface },
  layerText: { fontFamily: fonts.text, fontSize: 12, color: c.muted, marginTop: 2, lineHeight: 17 },
  logout: {
    marginTop: spacing.xl,
    height: 52,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.error,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  logoutText: { fontFamily: fonts.display, fontSize: 16, letterSpacing: 1.5, color: c.error },
  cancel: { height: 44, alignItems: "center", justifyContent: "center", marginTop: spacing.xs },
  cancelText: { fontFamily: fonts.textMedium, fontSize: 14, color: c.muted },
  toast: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: c.surfaceInverse,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  toastText: { fontFamily: fonts.textMedium, fontSize: 14, color: c.onSurfaceInverse },
}));
