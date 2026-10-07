import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { api } from "./api";

/** Registers this device for push. Native builds only (not web / Expo Go). Never throws. */
export async function registerForPush(userId: string) {
  if (Platform.OS === "web" || !Device.isDevice) return;
  if (Constants.executionEnvironment === "storeClient") return; // Expo Go has no push support
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;
    const tokenResp = await Notifications.getDevicePushTokenAsync();
    await api("/register-push", {
      method: "POST",
      body: { user_id: userId, platform: Platform.OS, device_token: String(tokenResp.data) },
    });
  } catch (e) {
    console.warn("Push registration failed", e);
  }
}
