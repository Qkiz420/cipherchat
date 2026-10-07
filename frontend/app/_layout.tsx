import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, LogBox, Modal, Platform, Pressable, Text, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AuthProvider, useAuth } from "@/src/auth";
import { ErrorBoundary } from "@/src/components/error-boundary";
import { LockGate, LockProvider } from "@/src/lock";
import { registerForPush } from "@/src/push";
import { queryClient } from "@/src/query-client";
import { realtime } from "@/src/realtime";
import { colors, fonts, radius, spacing } from "@/src/theme";
import { storage } from "@/src/utils/storage";

// Disable logbox errors etc so that users can see the app
// and agent works as expected.
LogBox.ignoreAllLogs(true)

// Push: foreground display handler (module scope, native only).
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// Push: Android channel (module scope).
if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

const PUSH_NUDGE_KEY = "pushNudgeAt";

/** Live socket, chat-list refresh and push registration for the signed-in session. */
function SessionEffects() {
  const { status, token, user } = useAuth();
  const pushedFor = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "in" || !token) {
      realtime.stop();
      return;
    }
    realtime.start(token);
    const off = realtime.on((e) => {
      if (e.type === "message" || e.type === "chat") {
        queryClient.invalidateQueries({ queryKey: ["chats"] });
        if (e.type === "chat") queryClient.invalidateQueries({ queryKey: ["chat", e.chat_id] });
      }
    });
    return off;
  }, [status, token]);

  useEffect(() => {
    if (status === "in" && user && pushedFor.current !== user.id) {
      pushedFor.current = user.id;
      registerForPush(user.id);
    }
  }, [status, user]);

  return null;
}

export default function RootLayout() {
  const [loaded] = useFonts({
    "Rajdhani-Medium": require("../assets/fonts/Rajdhani-Medium.ttf"),
    "Rajdhani-Regular": require("../assets/fonts/Rajdhani-Regular.ttf"),
    "Satoshi-Regular": require("../assets/fonts/Satoshi-Regular.otf"),
    "Satoshi-Medium": require("../assets/fonts/Satoshi-Medium.otf"),
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });
  const router = useRouter();
  const [nudge, setNudge] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const go = (data: any) => {
      const url = data?.deeplink || data?.action_url;
      if (!url || typeof url !== "string") return;
      if (url.startsWith("http")) Linking.openURL(url);
      else router.push(url as any);
    };
    // Warm tap
    const tapSub = Notifications.addNotificationResponseReceivedListener((response) =>
      go(response.notification.request.content.data),
    );
    // Cold-start tap
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) go(response.notification.request.content.data);
    });
    // Weekly nudge if permission is permanently denied
    (async () => {
      try {
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (status !== "denied" || canAskAgain) return;
        const last = await storage.getItem(PUSH_NUDGE_KEY, 0);
        if (last && Date.now() - Number(last) <= 7 * 24 * 60 * 60 * 1000) return;
        setNudge(true);
      } catch {}
    })();
    return () => tapSub.remove();
  }, [router]);

  const closeNudge = async (openSettings: boolean) => {
    await storage.setItem(PUSH_NUDGE_KEY, Date.now());
    setNudge(false);
    if (openSettings) Linking.openSettings();
  };

  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  // One app level ErrorBoundary; a render crash shows a reload screen
  // instead of a blank app.
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <KeyboardProvider>
          <AuthProvider>
            <LockProvider>
              <SessionEffects />
              <StatusBar style="light" />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }}>
                <Stack.Screen name="new-chat" options={{ presentation: "modal" }} />
                <Stack.Screen name="set-pin" options={{ presentation: "modal" }} />
                <Stack.Screen name="add-members/[id]" options={{ presentation: "modal" }} />
              </Stack>
              <LockGate />
              <Modal visible={nudge} transparent animationType="fade" onRequestClose={() => closeNudge(false)}>
                <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.xl }}>
                  <View testID="push-nudge" style={{ backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.xl }}>
                    <Text style={{ fontFamily: fonts.display, fontSize: 22, color: colors.onSurface }}>Notifications are off</Text>
                    <Text style={{ fontFamily: fonts.text, fontSize: 14, color: colors.muted, marginTop: spacing.sm, lineHeight: 20 }}>
                      Turn them on in Settings to know when a new message arrives. Alerts never include message content.
                    </Text>
                    <Pressable testID="push-nudge-open-settings" onPress={() => closeNudge(true)} style={{ height: 48, backgroundColor: colors.brandPrimary, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", marginTop: spacing.xl }}>
                      <Text style={{ fontFamily: fonts.display, fontSize: 16, letterSpacing: 1.5, color: colors.onBrandPrimary }}>OPEN SETTINGS</Text>
                    </Pressable>
                    <Pressable testID="push-nudge-later" onPress={() => closeNudge(false)} style={{ height: 44, alignItems: "center", justifyContent: "center", marginTop: spacing.xs }}>
                      <Text style={{ fontFamily: fonts.textMedium, fontSize: 14, color: colors.muted }}>Later</Text>
                    </Pressable>
                  </View>
                </View>
              </Modal>
            </LockProvider>
          </AuthProvider>
        </KeyboardProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
