import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT, PublicUser } from "@/src/api";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, Ionicons } from "@/src/ui";

export default function AddMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const chat = qc.getQueryData<ChatT>(["chat", id]);
  const memberIds = new Set(chat?.members.map((m) => m.id) ?? []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api<PublicUser[]>(`/users/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });

  const add = useMutation({
    mutationFn: () => api<ChatT>(`/chats/${id}/members`, { method: "POST", body: { user_ids: selected.map((s) => s.id) } }),
    onSuccess: (updated) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.setQueryData(["chat", id], updated);
      qc.invalidateQueries({ queryKey: ["chats"] });
      router.back();
    },
    onError: (e: any) => setError(e?.message ?? "Could not add members"),
  });

  const toggle = (u: PublicUser) => {
    Haptics.selectionAsync();
    setSelected((s) => (s.some((x) => x.id === u.id) ? s.filter((x) => x.id !== u.id) : [...s, u]));
  };

  const results = (debounced ? search.data ?? [] : []).filter((u) => !memberIds.has(u.id));

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable testID="add-members-close-button" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>ADD MEMBERS</Text>
      </View>
      <View style={styles.note}>
        <Ionicons name="key-outline" size={14} color={colors.brandPrimary} />
        <Text style={styles.noteText}>New members can’t read earlier messages. Keys rotate automatically.</Text>
      </View>
      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          testID="add-members-search-input"
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
      {error && <Text style={styles.error} testID="add-members-error">{error}</Text>}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          data={results}
          keyExtractor={(u) => u.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: spacing.lg }}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          renderItem={({ item }) => {
            const sel = selected.some((s) => s.id === item.id);
            return (
              <Pressable testID={`add-member-result-${item.username}`} onPress={() => toggle(item)} style={styles.row}>
                <Avatar name={item.display_name} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{item.display_name}</Text>
                  <Text style={styles.rowSub}>@{item.username}</Text>
                </View>
                <Ionicons name={sel ? "checkbox" : "square-outline"} size={22} color={sel ? colors.brandPrimary : colors.muted} />
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              {search.isFetching ? (
                <ActivityIndicator color={colors.brandPrimary} />
              ) : (
                <Text style={styles.hint}>{debounced ? "No one new found" : "Type a username to find people"}</Text>
              )}
            </View>
          }
        />
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <Pressable
            testID="add-members-submit-button"
            disabled={!selected.length || add.isPending}
            onPress={() => add.mutate()}
            style={[styles.cta, (!selected.length || add.isPending) && { opacity: 0.5 }]}
          >
            {add.isPending ? (
              <ActivityIndicator color={colors.onBrandPrimary} />
            ) : (
              <Text style={styles.ctaText}>ADD {selected.length || ""} & ROTATE KEYS</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: fonts.display, fontSize: 20, letterSpacing: 1.5, color: c.onSurface },
  note: { flexDirection: "row", gap: spacing.sm, alignItems: "center", marginHorizontal: spacing.lg, marginTop: spacing.md },
  noteText: { flex: 1, fontFamily: fonts.text, fontSize: 12, color: c.muted },
  searchBox: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, height: 48, paddingHorizontal: spacing.md, backgroundColor: c.surfaceTertiary, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
  searchInput: { flex: 1, color: c.onSurface, fontFamily: fonts.text, fontSize: 16, height: 48 },
  error: { fontFamily: fonts.text, color: c.error, fontSize: 14, marginHorizontal: spacing.lg, marginTop: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowTitle: { fontFamily: fonts.display, fontSize: 17, color: c.onSurface },
  rowSub: { fontFamily: fonts.mono, fontSize: 11, color: c.muted },
  divider: { height: 1, backgroundColor: c.divider, marginLeft: 68 },
  empty: { flex: 1, alignItems: "center", paddingTop: spacing.xxl },
  hint: { fontFamily: fonts.text, fontSize: 14, color: c.muted },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
  cta: { height: 52, backgroundColor: c.brandPrimary, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  ctaText: { fontFamily: fonts.display, fontSize: 16, letterSpacing: 1.5, color: c.onBrandPrimary },
}));
