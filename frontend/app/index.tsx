import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/src/auth";
import { useTheme } from "@/src/theme";

export default function Index() {
  const { status } = useAuth();
  const { colors } = useTheme();
  if (status === "loading") {
    return (
      <View
        testID="app-loading"
        style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }}
      >
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }
  return <Redirect href={status === "in" ? "/(tabs)" : "/auth"} />;
}
