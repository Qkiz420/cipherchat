import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT, PublicUser } from "@/src/api";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, Ionicons } from "@/src/ui";

export default function NewChatScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api<PublicUser[]>(`/users/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });

  const create = useMutation({
    mutationFn: (body: { type: string; member_ids: string[]; name?: string }) =>
      api<ChatT>("/chats", { method: "POST", body }),
    onSuccess: (chat) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      router.replace({ pathname: "/chat/[id]", params: { id: chat.id } });
    },
    onError: (e: any) => setError(e?.message ?? "Could not create chat"),
  });

  const onPick = (u: PublicUser) => {
    setError(null);
    if (mode === "direct") return create.mutate({ type: "direct", member_ids: [u.id] });
    Haptics.selectionAsync();
    setSelected((s) => (s.some((x) => x.id === u.id) ? s.filter((x) => x.id !== u.id) : [...s, u]));
  };

  const createGroup = () => {
    if (!groupName.trim()) return setError("Give your group a name");
    if (selected.length < 1) return setError("Add at least one member");
    create.mutate({ type: "group", member_ids: selected.map((s) => s.id), name: groupName.trim() });
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable testID="new-chat-close-button" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>NEW SECURE CHANNEL</Text>
      </View>

      <View style={styles.segment}>
        {(["direct", "group"] as const).map((m) => (
          <Pressable
            key={m}
            testID={`new-chat-mode-${m}`}
            onPress={() => {
              setMode(m);
              setError(null);
            }}
            style={[styles.segmentItem, mode === m && styles.segmentActive]}
          >
            <Ionicons name={m === "direct" ? "person-outline" : "people-outline"} size={16} color={mode === m ? colors.onBrandTertiary : colors.muted} />
            <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
              {m === "direct" ? "Direct" : "Group"}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === "group" && (
        <View style={styles.groupBox}>
          <TextInput
            testID="group-name-input"
            style={styles.input}
            value={groupName}
            onChangeText={setGroupName}
            placeholder="Group name"
            placeholderTextColor={colors.muted}
          />
          <View style={styles.chipRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipContent}>
              {selected.length === 0 ? (
                <Text style={styles.hint}>Search and tap people to add them</Text>
              ) : (
                selected.map((s) => (
                  <Pressable key={s.id} testID={`selected-chip-${s.username}`} onPress={() => onPick(s)} style={styles.chip}>
                    <Text style={styles.chipText}>{s.display_name}</Text>
                    <Ionicons name="close" size={14} color={colors.onBrandTertiary} />
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      )}

      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          testID="user-search-input"
          style={styles.searchInput}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Search by username or name"
          placeholderTextColor={colors.muted}
          autoFocus
        />
      </View>

      {error && (
        <Text style={styles.error} testID="new-chat-error">
          {error}
        </Text>
      )}

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          testID="user-search-results"
          data={debounced ? search.data ?? [] : []}
          keyExtractor={(u) => u.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: spacing.lg, flexGrow: 1 }}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          renderItem={({ item }) => {
            const isSel = selected.some((s) => s.id === item.id);
            return (
              <Pressable
                testID={`user-result-${item.username}`}
                onPress={() => onPick(item)}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceSecondary }]}
              >
                <Avatar name={item.display_name} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{item.display_name}</Text>
                  <Text style={styles.rowSub}>@{item.username}</Text>
                </View>
                {mode === "group" ? (
                  <Ionicons name={isSel ? "checkbox" : "square-outline"} size={22} color={isSel ? colors.brandPrimary : colors.muted} />
                ) : (
                  <Ionicons name="lock-closed-outline" size={18} color={colors.brandPrimary} />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              {search.isFetching || create.isPending ? (
                <ActivityIndicator color={colors.brandPrimary} />
              ) : (
                <Text style={styles.hint} testID="search-empty">
                  {debounced ? "No users found" : "Type a username to find people"}
                </Text>
              )}
            </View>
          }
        />
        {mode === "group" && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
            <Pressable
              testID="create-group-button"
              onPress={createGroup}
              disabled={create.isPending}
              style={({ pressed }) => [styles.cta, (pressed || create.isPending) && { opacity: 0.8 }]}
            >
              {create.isPending ? (
                <ActivityIndicator color={colors.onBrandPrimary} />
              ) : (
                <Text style={styles.ctaText}>CREATE ENCRYPTED GROUP ({selected.length + 1})</Text>
              )}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: fonts.display, fontSize: 20, letterSpacing: 1.5, color: c.onSurface },
  segment: {
    flexDirection: "row",
    margin: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.xs,
  },
  segmentItem: { flex: 1, height: 40, flexDirection: "row", gap: spacing.xs, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: c.brandTertiary },
  segmentText: { fontFamily: fonts.textMedium, fontSize: 14, color: c.muted },
  segmentTextActive: { color: c.onBrandTertiary },
  groupBox: { paddingHorizontal: spacing.lg },
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
    marginTop: spacing.sm,
  },
  chipRow: { height: 56, justifyContent: "center" },
  chipContent: { gap: spacing.sm, alignItems: "center" },
  chip: {
    height: 36,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: c.brandTertiary,
    borderRadius: radius.sm,
  },
  chipText: { fontFamily: fonts.textMedium, fontSize: 14, color: c.onBrandTertiary },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.md,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
  },
  searchInput: { flex: 1, color: c.onSurface, fontFamily: fonts.text, fontSize: 16, height: 48 },
  error: { fontFamily: fonts.text, color: c.error, fontSize: 14, marginHorizontal: spacing.lg, marginTop: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowTitle: { fontFamily: fonts.display, fontSize: 17, color: c.onSurface },
  rowSub: { fontFamily: fonts.mono, fontSize: 11, color: c.muted },
  divider: { height: 1, backgroundColor: c.divider, marginLeft: 68 },
  empty: { flex: 1, alignItems: "center", paddingTop: spacing.xxl },
  hint: { fontFamily: fonts.text, fontSize: 14, color: c.muted },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface },
  cta: { height: 52, backgroundColor: c.brandPrimary, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  ctaText: { fontFamily: fonts.display, fontSize: 16, letterSpacing: 1.5, color: c.onBrandPrimary },
}));
