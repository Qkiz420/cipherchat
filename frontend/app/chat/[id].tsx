import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeInUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatT } from "@/src/api";
import { useSession } from "@/src/auth";
import { decryptMessage, encryptMessage, WireMessage } from "@/src/crypto";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { Avatar, chatTitle, fmtTtl, Ionicons, TTL_OPTIONS } from "@/src/ui";

type Item = WireMessage & { local?: "sending" | "failed"; plain?: string };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const { user, identity } = useSession();
  const [messages, setMessages] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [timerOpen, setTimerOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lastTs = useRef<string | null>(null);

  const chatQ = useQuery({
    queryKey: ["chat", id],
    queryFn: () => api<ChatT>(`/chats/${id}`),
    refetchInterval: 5000,
  });
  const chat = chatQ.data;

  const merge = useCallback((incoming: WireMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      const next = [...prev, ...incoming.filter((m) => !ids.has(m.id))];
      next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return next;
    });
    const latest = incoming[incoming.length - 1].created_at;
    if (!lastTs.current || latest > lastTs.current) lastTs.current = latest;
  }, []);

  // Poll for new ciphertext.
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const q = lastTs.current ? `?after=${encodeURIComponent(lastTs.current)}` : "";
        const res = await api<WireMessage[]>(`/chats/${id}/messages${q}`);
        if (alive) merge(res);
      } catch {}
      if (alive) setLoaded(true);
    };
    pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, merge]);

  // Tick for disappearing countdowns + local purge.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(
    () => messages.filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now).slice().reverse(),
    [messages, now],
  );

  const send = async (body: string, retryId?: string) => {
    if (!chat) return;
    const tempId = retryId ?? `local-${Date.now()}`;
    const optimistic: Item = {
      id: tempId, chat_id: chat.id, sender_id: user.id, ciphertext: "", nonce: "", epk: "", key: null, sig: "",
      ttl: chat.disappear_seconds, created_at: new Date().toISOString(), expires_at: null, local: "sending", plain: body,
    };
    setMessages((prev) => [...prev.filter((m) => m.id !== tempId), optimistic]);
    try {
      const payload = encryptMessage(body, chat.id, chat.members, identity);
      const saved = await api<WireMessage>(`/chats/${chat.id}/messages`, { method: "POST", body: payload });
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      merge([saved]);
      qc.invalidateQueries({ queryKey: ["chats"] });
    } catch (e: any) {
      if (e?.status === 409) chatQ.refetch();
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, local: "failed" } : m)));
    }
  };

  const onSend = () => {
    const body = text.trim();
    if (!body) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setText("");
    send(body);
  };

  const setTimer = async (sec: number) => {
    Haptics.selectionAsync();
    setTimerOpen(false);
    const updated = await api<ChatT>(`/chats/${id}`, { method: "PATCH", body: { disappear_seconds: sec } });
    qc.setQueryData(["chat", id], updated);
    qc.invalidateQueries({ queryKey: ["chats"] });
  };

  const title = chat ? chatTitle(chat, user.id) : "";

  const renderItem = ({ item }: { item: Item }) => {
    const mine = item.sender_id === user.id;
    const sender = chat?.members.find((m) => m.id === item.sender_id);
    const dec = item.local ? { text: item.plain ?? "", verified: true } : decryptMessage(item, identity, sender?.sign_pub);
    const remaining = item.expires_at ? Math.max(0, Math.round((new Date(item.expires_at).getTime() - now) / 1000)) : 0;
    return (
      <Animated.View entering={FadeInUp.duration(200)} style={[styles.bubbleWrap, mine ? styles.right : styles.left]}>
        <View testID={`message-bubble-${item.id}`} style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
          {!mine && chat?.type === "group" && <Text style={styles.sender}>{sender?.display_name ?? "Unknown"}</Text>}
          {dec ? (
            <Text style={styles.msgText}>{dec.text}</Text>
          ) : (
            <Text style={styles.undecryptable}>⚠ Unable to decrypt</Text>
          )}
          <View style={styles.meta}>
            {item.expires_at && (
              <View style={styles.metaItem}>
                <Ionicons name="timer-outline" size={11} color={colors.brandPrimary} />
                <Text style={styles.metaTtl}>{fmtTtl(remaining)}</Text>
              </View>
            )}
            <Text style={styles.metaTime}>
              {new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
            {item.local === "sending" ? (
              <Ionicons name="time-outline" size={12} color={colors.muted} />
            ) : item.local === "failed" ? null : dec?.verified ? (
              <Ionicons name="shield-checkmark" size={12} color={colors.success} />
            ) : (
              <Ionicons name="shield-outline" size={12} color={colors.error} />
            )}
          </View>
        </View>
        {item.local === "failed" && (
          <Pressable testID={`retry-message-${item.id}`} onPress={() => send(item.plain ?? "", item.id)} style={styles.retry}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
          </Pressable>
        )}
      </Animated.View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable testID="chat-back-button" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Pressable
          testID="chat-header-info"
          style={styles.headerMid}
          onPress={() => router.push({ pathname: "/chat-info/[id]", params: { id } })}
        >
          <Avatar name={title || "?"} size={36} group={chat?.type === "group"} />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1} testID="chat-title">
              {title}
            </Text>
            <View style={styles.headerSubRow}>
              <Ionicons name="lock-closed" size={10} color={colors.brandPrimary} />
              <Text style={styles.headerSub} numberOfLines={1}>
                E2E ENCRYPTED{chat?.type === "group" ? ` · ${chat.members.length} MEMBERS` : ""}
              </Text>
            </View>
          </View>
        </Pressable>
        <Pressable testID="disappear-timer-button" onPress={() => setTimerOpen(true)} style={styles.timerBtn}>
          <Ionicons name="timer-outline" size={20} color={chat?.disappear_seconds ? colors.brandPrimary : colors.muted} />
          {!!chat?.disappear_seconds && <Text style={styles.timerLabel}>{fmtTtl(chat.disappear_seconds)}</Text>}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "translate-with-padding"}
        style={{ flex: 1 }}
      >
        {!loaded || !chat ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brandPrimary} testID="chat-loading" />
          </View>
        ) : (
          <FlatList
            testID="messages-list"
            inverted={visible.length > 0}
            data={visible}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            contentContainerStyle={{ padding: spacing.md, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={styles.empty} testID="chat-empty">
                <Ionicons name="lock-closed" size={28} color={colors.brandPrimary} />
                <Text style={styles.emptyTitle}>End-to-end encrypted</Text>
                <Text style={styles.emptyText}>
                  Keys generated. Messages are sealed on your device with a fresh key each time and signed by you.
                </Text>
              </View>
            }
          />
        )}
        <View style={[styles.inputBar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <TextInput
            testID="message-input"
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Encrypted message"
            placeholderTextColor={colors.muted}
            multiline
          />
          <Pressable
            testID="send-message-button"
            onPress={onSend}
            disabled={!text.trim() || !chat}
            style={({ pressed }) => [styles.sendBtn, (!text.trim() || pressed) && { opacity: 0.5 }]}
          >
            <Ionicons name="send" size={18} color={colors.onBrandPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={timerOpen} transparent animationType="slide" onRequestClose={() => setTimerOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setTimerOpen(false)} testID="timer-sheet-overlay" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} testID="timer-sheet">
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>SELF-DESTRUCT TIMER</Text>
          <Text style={styles.sheetText}>New messages vanish for everyone after this time — erased from the server too.</Text>
          {TTL_OPTIONS.map((sec) => {
            const active = (chat?.disappear_seconds ?? 0) === sec;
            return (
              <Pressable
                key={sec}
                testID={`timer-option-${sec}`}
                onPress={() => setTimer(sec)}
                style={[styles.option, active && styles.optionActive]}
              >
                <Text style={[styles.optionText, active && { color: colors.onBrandTertiary }]}>
                  {sec === 0 ? "Off" : fmtTtl(sec)}
                </Text>
                {active && <Ionicons name="checkmark" size={18} color={colors.brandPrimary} />}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.surfaceSecondary,
  },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerMid: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  headerTitle: { fontFamily: fonts.display, fontSize: 18, color: c.onSurface },
  headerSubRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  headerSub: { fontFamily: fonts.mono, fontSize: 9, color: c.brandPrimary },
  timerBtn: { minWidth: 44, height: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.xs },
  timerLabel: { fontFamily: fonts.mono, fontSize: 9, color: c.brandPrimary },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  bubbleWrap: { flexDirection: "row", alignItems: "center", marginVertical: 3, gap: spacing.xs },
  right: { justifyContent: "flex-end" },
  left: { justifyContent: "flex-start" },
  bubble: { maxWidth: "80%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md },
  mine: { backgroundColor: c.brandTertiary, borderBottomRightRadius: radius.sm / 2 },
  theirs: { backgroundColor: c.surfaceTertiary, borderBottomLeftRadius: radius.sm / 2 },
  sender: { fontFamily: fonts.display, fontSize: 13, color: c.brandPrimary, marginBottom: 2 },
  msgText: { fontFamily: fonts.text, fontSize: 15, color: c.onSurface, lineHeight: 21 },
  undecryptable: { fontFamily: fonts.text, fontSize: 14, color: c.error, fontStyle: "italic" },
  meta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: spacing.xs + 2, marginTop: 4 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 2 },
  metaTtl: { fontFamily: fonts.mono, fontSize: 10, color: c.brandPrimary },
  metaTime: { fontFamily: fonts.text, fontSize: 11, color: c.muted },
  retry: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontFamily: fonts.display, fontSize: 20, color: c.onSurface },
  emptyText: { fontFamily: fonts.text, fontSize: 13, color: c.muted, textAlign: "center", lineHeight: 19 },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surfaceSecondary,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
    paddingTop: 12,
    paddingBottom: 12,
    color: c.onSurface,
    fontFamily: fonts.text,
    fontSize: 15,
  },
  sendBtn: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center" },
  overlay: { flex: 1, backgroundColor: c.overlay },
  sheet: {
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: spacing.md },
  sheetTitle: { fontFamily: fonts.display, fontSize: 20, letterSpacing: 1.5, color: c.onSurface },
  sheetText: { fontFamily: fonts.text, fontSize: 13, color: c.muted, marginTop: spacing.xs, marginBottom: spacing.md, lineHeight: 19 },
  option: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.xs,
    backgroundColor: c.surfaceTertiary,
  },
  optionActive: { backgroundColor: c.brandTertiary },
  optionText: { fontFamily: fonts.textMedium, fontSize: 15, color: c.onSurface },
}));
