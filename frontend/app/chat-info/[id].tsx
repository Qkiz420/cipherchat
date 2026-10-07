import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT } from "@/src/api";
import { useSession, withSession } from "@/src/auth";
import { keyFingerprint, safetyNumber } from "@/src/crypto";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, chatTitle, fmtTtl, Ionicons, otherMember } from "@/src/ui";

export default withSession(ChatInfoScreen);

function ChatInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useSession();
  const { data: chat } = useQuery({ queryKey: ["chat", id], queryFn: () => api<ChatT>(`/chats/${id}`) });
  const qc = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isGroup = chat?.type === "group";
  const isAdmin = isGroup && chat?.created_by === user.id;

  const removeMember = async (memberId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/chats/${id}/members/${memberId}`, { method: "DELETE" });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setConfirmId(null);
      qc.invalidateQueries({ queryKey: ["chats"] });
      if (memberId === user.id) {
        qc.removeQueries({ queryKey: ["chat", id] });
        router.dismissAll();
        router.replace("/(tabs)");
      } else {
        await qc.invalidateQueries({ queryKey: ["chat", id] });
      }
    } catch (e: any) {
      setErr(e?.message ?? "Action failed");
    } finally {
      setBusy(false);
    }
  };

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

          <View style={styles.sectionRow}>
            <Text style={styles.sectionInline}>MEMBERS · IDENTITY KEYS</Text>
            {isAdmin && (
              <Pressable
                testID="add-members-button"
                onPress={() => router.push({ pathname: "/add-members/[id]", params: { id } })}
                style={styles.addBtn}
              >
                <Ionicons name="person-add-outline" size={14} color={colors.onBrandTertiary} />
                <Text style={styles.addText}>Add</Text>
              </Pressable>
            )}
          </View>
          {isGroup && (
            <Text style={styles.epoch} testID="key-epoch">
              Key epoch {chat.key_epoch} · keys rotate whenever members change
            </Text>
          )}
          {err && <Text style={styles.err} testID="chat-info-error">{err}</Text>}
          <View style={styles.card}>
            {chat.members.map((m, i) => (
              <View key={m.id} style={[styles.member, i > 0 && styles.memberBorder]} testID={`member-${m.username}`}>
                <Avatar name={m.display_name} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.memberName}>
                    {m.display_name}
                    {m.id === user.id ? " (you)" : ""}
                    {isGroup && m.id === chat.created_by ? "  · ADMIN" : ""}
                  </Text>
                  <Text style={styles.fp}>{keyFingerprint(m.box_pub, m.sign_pub)}</Text>
                </View>
                {isAdmin && m.id !== user.id &&
                  (confirmId === m.id ? (
                    <Pressable testID={`confirm-remove-${m.username}`} disabled={busy} onPress={() => removeMember(m.id)} style={styles.removeConfirm}>
                      <Text style={styles.removeConfirmText}>{busy ? "…" : "Remove"}</Text>
                    </Pressable>
                  ) : (
                    <Pressable testID={`remove-member-${m.username}`} onPress={() => setConfirmId(m.id)} style={styles.removeBtn}>
                      <Ionicons name="person-remove-outline" size={18} color={colors.error} />
                    </Pressable>
                  ))}
              </View>
            ))}
          </View>
          {isGroup && (
            <Pressable
              testID={confirmId === user.id ? "confirm-leave-group" : "leave-group-button"}
              disabled={busy}
              onPress={() => (confirmId === user.id ? removeMember(user.id) : setConfirmId(user.id))}
              style={[styles.leave, confirmId === user.id && { backgroundColor: colors.error }]}
            >
              <Ionicons name="exit-outline" size={18} color={confirmId === user.id ? colors.onError : colors.error} />
              <Text style={[styles.leaveText, confirmId === user.id && { color: colors.onError }]}>
                {confirmId === user.id ? "CONFIRM · LEAVE GROUP" : "LEAVE GROUP"}
              </Text>
            </Pressable>
          )}

          <Text style={styles.section}>PROTOCOL</Text>
          <View style={styles.block}>
            {[
              ["Key exchange", "X25519 (ephemeral per message)"],
              ["Cipher", "XSalsa20-Poly1305 · 256-bit"],
              ["Attachments", "One-time key per file"],
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
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xl, marginBottom: spacing.sm },
  sectionInline: { fontFamily: fonts.display, fontSize: 13, letterSpacing: 1.5, color: c.muted },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, height: 36, paddingHorizontal: spacing.md, borderRadius: radius.sm, backgroundColor: c.brandTertiary },
  addText: { fontFamily: fonts.textMedium, fontSize: 13, color: c.onBrandTertiary },
  epoch: { fontFamily: fonts.mono, fontSize: 10, color: c.brandPrimary, marginBottom: spacing.sm },
  err: { fontFamily: fonts.text, fontSize: 13, color: c.error, marginBottom: spacing.sm },
  removeBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  removeConfirm: { height: 36, paddingHorizontal: spacing.md, borderRadius: radius.sm, backgroundColor: c.error, alignItems: "center", justifyContent: "center" },
  removeConfirmText: { fontFamily: fonts.textMedium, fontSize: 13, color: c.onError },
  leave: { marginTop: spacing.lg, height: 48, borderRadius: radius.sm, borderWidth: 1, borderColor: c.error, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
  leaveText: { fontFamily: fonts.display, fontSize: 15, letterSpacing: 1.5, color: c.error },
  fp: { fontFamily: fonts.mono, fontSize: 10, color: c.muted, marginTop: 2 },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  k: { fontFamily: fonts.text, fontSize: 13, color: c.muted },
  v: { fontFamily: fonts.mono, fontSize: 11, color: c.onSurface },
}));
