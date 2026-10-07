// Encrypted attachments: bytes are sealed on-device with a one-time key before upload.
import { Image } from "expo-image";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "./api";
import { AttachmentMeta, b64, decryptBytes, encryptBytes, unb64 } from "./crypto";
import { fonts, makeStyles, radius, spacing, useTheme } from "./theme";
import { Ionicons } from "./ui";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type Picked = { bytes: Uint8Array; name: string; mime: string; kind: "image" | "file"; w?: number; h?: number };

export async function readUri(uri: string): Promise<Uint8Array> {
  if (Platform.OS === "web") return new Uint8Array(await (await fetch(uri)).arrayBuffer());
  return new File(uri).bytes();
}

export async function uploadEncrypted(chatId: string, p: Picked): Promise<AttachmentMeta> {
  const { ct, k, n } = encryptBytes(p.bytes);
  const res = await api<{ id: string }>(`/chats/${chatId}/attachments`, { method: "POST", body: { data: b64(ct) } });
  return { id: res.id, k, n, name: p.name, mime: p.mime, size: p.bytes.length, kind: p.kind, w: p.w, h: p.h };
}

const cache = new Map<string, Uint8Array>();

async function fetchDecrypted(att: AttachmentMeta): Promise<Uint8Array> {
  const hit = cache.get(att.id);
  if (hit) return hit;
  const res = await api<{ data: string }>(`/attachments/${att.id}`);
  const plain = decryptBytes(unb64(res.data), att.k, att.n);
  if (!plain) throw new Error("Attachment failed integrity check");
  cache.set(att.id, plain);
  return plain;
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentImage({ att, testID }: { att: AttachmentMeta; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [uri, setUri] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(false);
  const w = 220;
  const h = att.w && att.h ? Math.min(300, Math.max(120, (w * att.h) / att.w)) : 180;

  useEffect(() => {
    let alive = true;
    fetchDecrypted(att)
      .then((bytes) => alive && setUri(`data:${att.mime};base64,${b64(bytes)}`))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [att]);

  return (
    <>
      <Pressable testID={testID} onPress={() => uri && setOpen(true)} style={[styles.imgBox, { width: w, height: h }]}>
        {uri ? (
          <Image source={{ uri }} style={{ width: w, height: h }} contentFit="cover" />
        ) : err ? (
          <View style={styles.center}>
            <Ionicons name="alert-circle" size={22} color={colors.error} />
            <Text style={styles.small}>Unavailable</Text>
          </View>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brandPrimary} />
            <Text style={styles.small}>Decrypting…</Text>
          </View>
        )}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.viewer}>
          <Pressable testID="image-viewer-close" onPress={() => setOpen(false)} style={[styles.close, { top: insets.top + spacing.sm }]}>
            <Ionicons name="close" size={26} color={colors.onSurface} />
          </Pressable>
          {uri && <Image source={{ uri }} style={{ flex: 1 }} contentFit="contain" />}
        </View>
      </Modal>
    </>
  );
}

export function AttachmentFile({ att, testID }: { att: AttachmentMeta; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setErr(null);
    try {
      const bytes = await fetchDecrypted(att);
      if (Platform.OS === "web") {
        const g: any = globalThis;
        const url = g.URL.createObjectURL(new g.Blob([bytes], { type: att.mime }));
        const a = g.document.createElement("a");
        a.href = url;
        a.download = att.name;
        a.click();
        setTimeout(() => g.URL.revokeObjectURL(url), 5000);
      } else {
        const f = new File(Paths.cache, att.name.replace(/[^\w.\- ]/g, "_"));
        if (f.exists) f.delete();
        f.create();
        f.write(bytes);
        await Sharing.shareAsync(f.uri, { mimeType: att.mime });
      }
    } catch (e: any) {
      setErr(e?.message ?? "Could not open file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable testID={testID} onPress={open} style={styles.file}>
      <View style={styles.fileIcon}>
        {busy ? <ActivityIndicator color={colors.brandPrimary} /> : <Ionicons name="document-lock-outline" size={22} color={colors.brandPrimary} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.fileName} numberOfLines={1}>{att.name}</Text>
        <Text style={styles.small}>{err ?? `${fmtSize(att.size)} · encrypted · tap to open`}</Text>
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  imgBox: { borderRadius: radius.sm, overflow: "hidden", backgroundColor: c.surface, marginBottom: spacing.xs },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xs },
  small: { fontFamily: fonts.text, fontSize: 11, color: c.muted },
  viewer: { flex: 1, backgroundColor: c.surface },
  close: { position: "absolute", right: spacing.lg, zIndex: 1, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  file: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 200, marginBottom: spacing.xs },
  fileIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: c.surface, alignItems: "center", justifyContent: "center" },
  fileName: { fontFamily: fonts.textMedium, fontSize: 14, color: c.onSurface },
}));
