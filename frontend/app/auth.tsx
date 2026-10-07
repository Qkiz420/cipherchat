import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Ionicons } from "@/src/ui";

export default function AuthScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  const submit = async () => {
    setError(null);
    const u = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(u)) return setError("Username: 3-32 letters, numbers or _");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (isRegister && !displayName.trim()) return setError("Enter a display name");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    try {
      if (isRegister) await register(u, displayName.trim(), password);
      else await login(u, password);
      router.replace("/(tabs)");
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.xxxl, paddingBottom: insets.bottom + spacing.xl }]}
      >
        <View style={styles.logo}>
          <Ionicons name="shield-checkmark" size={32} color={colors.onBrandPrimary} />
        </View>
        <Text style={styles.title} testID="auth-title">CIPHERCHAT</Text>
        <Text style={styles.subtitle}>
          Zero-knowledge, end-to-end encrypted messaging. Your password never leaves this device.
        </Text>

        <View style={styles.segment}>
          {(["login", "register"] as const).map((m) => (
            <Pressable
              key={m}
              testID={`auth-mode-${m}`}
              onPress={() => {
                setMode(m);
                setError(null);
              }}
              style={[styles.segmentItem, mode === m && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
                {m === "login" ? "Unlock" : "Create identity"}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>USERNAME</Text>
        <TextInput
          testID="auth-username-input"
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="e.g. agent_47"
          placeholderTextColor={colors.muted}
        />
        {isRegister && (
          <>
            <Text style={styles.label}>DISPLAY NAME</Text>
            <TextInput
              testID="auth-display-name-input"
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="How others see you"
              placeholderTextColor={colors.muted}
            />
          </>
        )}
        <Text style={styles.label}>MASTER PASSWORD</Text>
        <TextInput
          testID="auth-password-input"
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="At least 8 characters"
          placeholderTextColor={colors.muted}
          onSubmitEditing={submit}
        />
        {isRegister && (
          <View style={styles.notice}>
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.noticeText}>
              Your password encrypts your private keys. It cannot be reset — if you lose it, your identity is gone.
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.errorBox} testID="auth-error">
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Pressable
          testID="auth-submit-button"
          disabled={busy}
          onPress={submit}
          style={({ pressed }) => [styles.cta, (pressed || busy) && { opacity: 0.8 }]}
        >
          {busy ? (
            <View style={styles.row}>
              <ActivityIndicator color={colors.onBrandPrimary} />
              <Text style={styles.ctaText}>{isRegister ? "GENERATING KEYS…" : "DERIVING KEYS…"}</Text>
            </View>
          ) : (
            <Text style={styles.ctaText}>{isRegister ? "GENERATE IDENTITY" : "UNLOCK"}</Text>
          )}
        </Pressable>
        {busy && (
          <Text style={styles.mono} testID="auth-progress">
            {isRegister
              ? "› X25519 + Ed25519 keypairs\n› sealing vault with master key"
              : "› stretching password (SHA-512 ×3000)\n› opening key vault"}
          </Text>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  content: { paddingHorizontal: spacing.xl },
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: { fontFamily: fonts.display, fontSize: 36, color: c.onSurface, letterSpacing: 3 },
  subtitle: { fontFamily: fonts.text, fontSize: 14, color: c.muted, marginTop: spacing.xs, lineHeight: 20 },
  segment: {
    flexDirection: "row",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.xs,
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  segmentItem: { flex: 1, height: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: c.brandTertiary },
  segmentText: { fontFamily: fonts.textMedium, fontSize: 14, color: c.muted },
  segmentTextActive: { color: c.onBrandTertiary },
  label: {
    fontFamily: fonts.display,
    fontSize: 12,
    color: c.muted,
    letterSpacing: 1.5,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    height: 48,
    backgroundColor: c.surfaceTertiary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    color: c.onSurface,
    fontFamily: fonts.text,
    fontSize: 16,
  },
  notice: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, alignItems: "flex-start" },
  noticeText: { flex: 1, fontFamily: fonts.text, fontSize: 12, color: c.onSurfaceTertiary, lineHeight: 18 },
  errorBox: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderLeftWidth: 3,
    borderLeftColor: c.error,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginTop: spacing.lg,
  },
  errorText: { flex: 1, fontFamily: fonts.text, color: c.onSurface, fontSize: 14 },
  cta: {
    height: 52,
    backgroundColor: c.brandPrimary,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xl,
  },
  ctaText: { fontFamily: fonts.display, fontSize: 18, letterSpacing: 2, color: c.onBrandPrimary },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  mono: { fontFamily: fonts.mono, fontSize: 12, color: c.brandPrimary, marginTop: spacing.md, lineHeight: 20 },
}));
