import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT } from "@/src/api";
import { useSession } from "@/src/auth";
import { decryptMessage } from "@/src/crypto";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, chatTitle, fmtTime, fmtTtl, Ionicons } from "@/src/ui";

export default function ChatsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, identity } = useSession();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["chats"],
    queryFn: () => api<ChatT[]>("/chats"),
    refetchInterval: 3000,
  });

  const preview = (chat: ChatT) => {
    const m = chat.last_message;
    if (!m) return "No messages yet";
    const sender = chat.members.find((x) => x.id === m.sender_id);
    const dec = decryptMessage(m, identity, sender?.sign_pub);
    if (!dec) return "Unable to decrypt";
    const prefix = m.sender_id === user.id ? "You: " : chat.type === "group" ? `${sender?.display_name ?? "?"}: ` : "";
    return prefix + dec.text;
  };

  const renderItem = ({ item }: { item: ChatT }) => {
    const title = chatTitle(item, user.id);
    return (
      <Pressable
        testID={`chat-row-${item.id}`}
        onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id } })}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceSecondary }]}
      >
        <Avatar name={title} group={item.type === "group"} />
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Ionicons name="lock-closed" size={12} color={colors.brandPrimary} />
            <Text style={styles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            {item.disappear_seconds > 0 && (
              <View style={styles.ttlBadge}>
                <Ionicons name="timer-outline" size={10} color={colors.onBrandTertiary} />
                <Text style={styles.ttlText}>{fmtTtl(item.disappear_seconds)}</Text>
              </View>
            )}
            <Text style={styles.time}>{fmtTime(item.last_message?.created_at ?? item.updated_at)}</Text>
          </View>
          <Text style={styles.preview} numberOfLines={1}>
            {preview(item)}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>CIPHERCHAT</Text>
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <Text style={styles.status} testID="encryption-status">E2E · ZERO-KNOWLEDGE · SIGNED</Text>
          </View>
        </View>
        <Pressable
          testID="new-chat-button"
          onPress={() => router.push("/new-chat")}
          style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.8 }]}
        >
          <Ionicons name="create-outline" size={22} color={colors.onBrandPrimary} />
        </Pressable>
      </View>

      {isError && (
        <Pressable testID="chats-error-banner" onPress={() => refetch()} style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={colors.error} />
          <Text style={styles.errorText}>Connection interrupted · Tap to retry</Text>
        </Pressable>
      )}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} testID="chats-loading" />
        </View>
      ) : (
        <FlatList
          testID="chats-list"
          data={data ?? []}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          contentContainerStyle={{ paddingBottom: bottomChrome + spacing.lg, flexGrow: 1 }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="chats-empty">
              <View style={styles.emptyIcon}>
                <Ionicons name="key-outline" size={32} color={colors.brandPrimary} />
              </View>
              <Text style={styles.emptyTitle}>No secure channels yet</Text>
              <Text style={styles.emptyText}>
                Find someone by username. Every message is sealed on this device before it leaves.
              </Text>
              <Pressable testID="empty-new-chat-button" onPress={() => router.push("/new-chat")} style={styles.emptyCta}>
                <Text style={styles.emptyCtaText}>INITIATE SECURE CONNECTION</Text>
              </Pressable>
            </View>
          }
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  title: { fontFamily: fonts.display, fontSize: 28, color: c.onSurface, letterSpacing: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.brandPrimary },
  status: { fontFamily: fonts.mono, fontSize: 10, color: c.brandPrimary },
  newBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  errorBanner: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderLeftWidth: 3,
    borderLeftColor: c.error,
  },
  errorText: { fontFamily: fonts.text, color: c.onSurface, fontSize: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2 },
  rowTitle: { flex: 1, fontFamily: fonts.display, fontSize: 18, color: c.onSurface },
  ttlBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: c.brandTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
  },
  ttlText: { fontFamily: fonts.mono, fontSize: 10, color: c.onBrandTertiary },
  time: { fontFamily: fonts.text, fontSize: 12, color: c.muted },
  preview: { fontFamily: fonts.text, fontSize: 14, color: c.onSurfaceTertiary, marginTop: 2 },
  divider: { height: 1, backgroundColor: c.divider, marginLeft: 72 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  emptyTitle: { fontFamily: fonts.display, fontSize: 22, color: c.onSurface },
  emptyText: { fontFamily: fonts.text, fontSize: 14, color: c.muted, textAlign: "center", marginTop: spacing.sm, lineHeight: 20 },
  emptyCta: {
    marginTop: spacing.xl,
    height: 48,
    paddingHorizontal: spacing.xl,
    backgroundColor: c.brandPrimary,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyCtaText: { fontFamily: fonts.display, fontSize: 16, letterSpacing: 1.5, color: c.onBrandPrimary },
}));
