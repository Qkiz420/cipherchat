import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT } from "@/src/api";
import { useSession } from "@/src/auth";
import { keyFingerprint, safetyNumber } from "@/src/crypto";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, chatTitle, fmtTtl, Ionicons, otherMember } from "@/src/ui";

export default function ChatInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useSession();
  const { data: chat } = useQuery({ queryKey: ["chat", id], queryFn: () => api<ChatT>(`/chats/${id}`) });

  const other = chat ? otherMember(chat, user.id) : undefined;
  const safety = chat?.type === "direct" && other ? safetyNumber(user, other) : null;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable testID="chat-info-back-button" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>ENCRYPTION INFO</Text>
      </View>
      {!chat ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}>
          <View style={styles.top}>
            <Avatar name={chatTitle(chat, user.id)} size={64} group={chat.type === "group"} />
            <Text style={styles.name} testID="chat-info-title">{chatTitle(chat, user.id)}</Text>
            <View style={styles.pill}>
              <Ionicons name="timer-outline" size={12} color={colors.onBrandTertiary} />
              <Text style={styles.pillText} testID="chat-info-timer">Self-destruct: {fmtTtl(chat.disappear_seconds)}</Text>
            </View>
          </View>

          {safety && (
            <>
              <Text style={styles.section}>SAFETY NUMBER</Text>
              <View style={styles.block} testID="safety-number">
                <View style={styles.grid}>
                  {safety.map((g, i) => (
                    <Text key={i} style={styles.digits}>{g}</Text>
                  ))}
                </View>
                <Text style={styles.hint}>
                  Compare this number with {other?.display_name} in person or on a call. If it matches on both devices,
                  nobody is intercepting your conversation.
                </Text>
              </View>
            </>
          )}

          <Text style={styles.section}>MEMBERS · IDENTITY KEYS</Text>
          <View style={styles.card}>
            {chat.members.map((m, i) => (
              <View key={m.id} style={[styles.member, i > 0 && styles.memberBorder]} testID={`member-${m.username}`}>
                <Avatar name={m.display_name} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.memberName}>
                    {m.display_name}
                    {m.id === user.id ? " (you)" : ""}
                  </Text>
                  <Text style={styles.fp}>{keyFingerprint(m.box_pub, m.sign_pub)}</Text>
                </View>
              </View>
            ))}
          </View>

          <Text style={styles.section}>PROTOCOL</Text>
          <View style={styles.block}>
            {[
              ["Key exchange", "X25519 (ephemeral per message)"],
              ["Cipher", "XSalsa20-Poly1305 · 256-bit"],
              ["Signatures", "Ed25519"],
              ["Padding", "128-byte blocks"],
              ["Server access", "Ciphertext only"],
            ].map(([k, v]) => (
              <View key={k} style={styles.kv}>
                <Text style={styles.k}>{k}</Text>
                <Text style={styles.v}>{v}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: fonts.display, fontSize: 20, letterSpacing: 1.5, color: c.onSurface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  top: { alignItems: "center", gap: spacing.sm },
  name: { fontFamily: fonts.display, fontSize: 24, color: c.onSurface },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.brandTertiary, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 4 },
  pillText: { fontFamily: fonts.mono, fontSize: 11, color: c.onBrandTertiary },
  section: { fontFamily: fonts.display, fontSize: 13, letterSpacing: 1.5, color: c.muted, marginTop: spacing.xl, marginBottom: spacing.sm },
  block: { backgroundColor: c.surfaceTertiary, borderRadius: radius.md, borderWidth: 1, borderColor: c.borderStrong, padding: spacing.lg },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, justifyContent: "space-between" },
  digits: { width: "28%", fontFamily: fonts.mono, fontSize: 17, color: c.brandPrimary, textAlign: "center" },
  hint: { fontFamily: fonts.text, fontSize: 12, color: c.muted, marginTop: spacing.md, lineHeight: 18 },
  card: { backgroundColor: c.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
  member: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  memberBorder: { borderTopWidth: 1, borderTopColor: c.divider },
  memberName: { fontFamily: fonts.textMedium, fontSize: 14, color: c.onSurface },
  fp: { fontFamily: fonts.mono, fontSize: 10, color: c.muted, marginTop: 2 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  k: { fontFamily: fonts.text, fontSize: 13, color: c.muted },
  v: { fontFamily: fonts.mono, fontSize: 11, color: c.onSurface },
}));
