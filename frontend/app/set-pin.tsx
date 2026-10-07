import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PinPad } from "@/src/components/pin-pad";
import { useLock } from "@/src/lock";
import { makeStyles, spacing, useTheme } from "@/src/theme";
import { Ionicons } from "@/src/ui";

export default function SetPinScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { enable } = useLock();
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onComplete = async (pin: string) => {
    if (!first) {
      setFirst(pin);
      setError(null);
      return;
    }
    if (pin !== first) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFirst(null);
      setError("PINs didn't match. Start again.");
      return;
    }
    await enable(pin);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.lg }]}>
      <Pressable testID="set-pin-close-button" onPress={() => router.back()} style={styles.close}>
        <Ionicons name="close" size={24} color={colors.onSurface} />
      </Pressable>
      <View style={styles.body}>
        <PinPad
          key={first ? "confirm" : "enter"}
          testIDPrefix="set-pin"
          title={first ? "CONFIRM PIN" : "CREATE APP PIN"}
          subtitle={first ? "Enter the same 6 digits again" : "Required every time CipherChat opens"}
          error={error}
          onComplete={onComplete}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: spacing.sm },
  body: { flex: 1, justifyContent: "center" },
}));
