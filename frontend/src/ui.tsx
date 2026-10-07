import { Ionicons } from "@react-native-vector-icons/ionicons";
import React from "react";
import { Text, View } from "react-native";

import type { ChatT, PublicUser } from "./api";
import { fonts, makeStyles, useTheme } from "./theme";

export { Ionicons };

export const TTL_OPTIONS = [0, 30, 300, 3600, 86400, 604800];

export function fmtTtl(sec: number): string {
  if (!sec) return "Off";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  if (sec < 604800) return `${Math.round(sec / 86400)}d`;
  return `${Math.round(sec / 604800)}w`;
}

export function fmtTime(isoStr: string): string {
  const d = new Date(isoStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function chatTitle(chat: ChatT, myId: string): string {
  if (chat.type === "group") return chat.name ?? "Group";
  return chat.members.find((m) => m.id !== myId)?.display_name ?? "Unknown";
}

export function otherMember(chat: ChatT, myId: string): PublicUser | undefined {
  return chat.members.find((m) => m.id !== myId);
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

export function Avatar({ name, size = 44, group = false }: { name: string; size?: number; group?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {group ? (
        <Ionicons name="people" size={size * 0.45} color={colors.onBrandTertiary} />
      ) : (
        <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initials(name)}</Text>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  avatar: {
    backgroundColor: c.brandTertiary,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: c.onBrandTertiary, fontFamily: fonts.display },
}));
