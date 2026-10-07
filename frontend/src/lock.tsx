// App lock (PIN + optional Face ID / fingerprint) and screenshot blocking.
import * as LocalAuthentication from "expo-local-authentication";
import * as ScreenCapture from "expo-screen-capture";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "./auth";
import { PinPad } from "./components/pin-pad";
import { hashPin, randomSalt } from "./crypto";
import { useTheme } from "./theme";
import { storage } from "./utils/storage";

const K = { enabled: "lock_enabled", bio: "lock_bio", shots: "block_screenshots", pin: "lock_pin" };
const MAX_TRIES = 5;

type LockState = {
  ready: boolean;
  enabled: boolean;
  bio: boolean;
  bioAvailable: boolean;
  blockShots: boolean;
  locked: boolean;
  enable: (pin: string) => Promise<void>;
  disable: () => Promise<void>;
  setBio: (v: boolean) => Promise<boolean>;
  setBlockShots: (v: boolean) => Promise<void>;
  unlockWithPin: (pin: string) => Promise<boolean>;
  unlockWithBio: () => Promise<boolean>;
};

const LockContext = createContext<LockState | null>(null);

export function LockProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [bio, setBioState] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [blockShots, setShots] = useState(true);
  const [locked, setLocked] = useState(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    (async () => {
      const e = (await storage.getItem(K.enabled, false as boolean)) === true;
      const b = (await storage.getItem(K.bio, false as boolean)) === true;
      const s = (await storage.getItem(K.shots, true as boolean)) !== false;
      if (Platform.OS !== "web") {
        try {
          setBioAvailable((await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()));
        } catch {}
      }
      enabledRef.current = e;
      setEnabled(e);
      setBioState(b);
      setShots(s);
      setLocked(e);
      setReady(true);
    })();
  }, []);

  // Re-lock whenever the app goes to the background.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background" && enabledRef.current) setLocked(true);
    });
    return () => sub.remove();
  }, []);

  // Screenshot + screen-recording blocking (native builds only).
  useEffect(() => {
    if (Platform.OS === "web" || !ready) return;
    (async () => {
      try {
        if (blockShots && status === "in") {
          await ScreenCapture.preventScreenCaptureAsync("cipherchat");
          if (Platform.OS === "ios") await ScreenCapture.enableAppSwitcherProtectionAsync(0.9);
        } else {
          await ScreenCapture.allowScreenCaptureAsync("cipherchat");
          if (Platform.OS === "ios") await ScreenCapture.disableAppSwitcherProtectionAsync();
        }
      } catch {}
    })();
  }, [blockShots, ready, status]);

  const disable = useCallback(async () => {
    await storage.setItem(K.enabled, false);
    await storage.setItem(K.bio, false);
    await storage.secureRemove(K.pin);
    enabledRef.current = false;
    setEnabled(false);
    setBioState(false);
    setLocked(false);
  }, []);

  // Signing out wipes the lock config with the session.
  useEffect(() => {
    if (status === "out" && enabledRef.current) disable();
  }, [status, disable]);

  const enable = useCallback(async (pin: string) => {
    const salt = randomSalt();
    await storage.secureSet(K.pin, JSON.stringify({ salt, h: hashPin(pin, salt), tries: 0 }));
    await storage.setItem(K.enabled, true);
    enabledRef.current = true;
    setEnabled(true);
  }, []);

  const unlockWithBio = useCallback(async () => {
    if (Platform.OS === "web") return false;
    try {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock CipherChat", disableDeviceFallback: true, cancelLabel: "Use PIN" });
      if (r.success) setLocked(false);
      return r.success;
    } catch {
      return false;
    }
  }, []);

  const setBio = useCallback(async (v: boolean) => {
    if (v) {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Confirm to enable biometric unlock" }).catch(() => null);
      if (!r?.success) return false;
    }
    await storage.setItem(K.bio, v);
    setBioState(v);
    return true;
  }, []);

  const setBlockShots = useCallback(async (v: boolean) => {
    await storage.setItem(K.shots, v);
    setShots(v);
  }, []);

  const unlockWithPin = useCallback(async (pin: string) => {
    const raw = await storage.secureGet(K.pin, null);
    if (typeof raw !== "string") {
      setLocked(false);
      return true;
    }
    const rec = JSON.parse(raw) as { salt: string; h: string; tries: number };
    if (hashPin(pin, rec.salt) === rec.h) {
      await storage.secureSet(K.pin, JSON.stringify({ ...rec, tries: 0 }));
      setLocked(false);
      return true;
    }
    await storage.secureSet(K.pin, JSON.stringify({ ...rec, tries: (rec.tries ?? 0) + 1 }));
    return false;
  }, []);

  const value = useMemo<LockState>(
    () => ({ ready, enabled, bio, bioAvailable, blockShots, locked, enable, disable, setBio, setBlockShots, unlockWithPin, unlockWithBio }),
    [ready, enabled, bio, bioAvailable, blockShots, locked, enable, disable, setBio, setBlockShots, unlockWithPin, unlockWithBio],
  );
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useLock() {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error("useLock must be used within LockProvider");
  return ctx;
}

/** Full-screen overlay shown while the app is locked. */
export function LockGate() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { status } = useAuth();
  const { ready, locked, enabled, bio, bioAvailable, unlockWithPin, unlockWithBio } = useLock();
  const [error, setError] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const [coolUntil, setCoolUntil] = useState(0);
  const [, tick] = useState(0);
  const show = status === "in" && (!ready || (enabled && locked));
  const useBio = bio && bioAvailable;

  useEffect(() => {
    if (show && ready && useBio) unlockWithBio();
  }, [show, ready, useBio, unlockWithBio]);

  useEffect(() => {
    if (coolUntil <= Date.now()) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [coolUntil]);

  if (!show) return null;
  const cooling = coolUntil > Date.now();

  const onPin = async (pin: string) => {
    if (await unlockWithPin(pin)) {
      setError(null);
      setFails(0);
      return;
    }
    const f = fails + 1;
    setFails(f);
    if (f >= MAX_TRIES) {
      setCoolUntil(Date.now() + 30000);
      setFails(0);
      setError("Too many attempts. Wait 30 seconds.");
    } else {
      setError(`Wrong PIN · ${MAX_TRIES - f} tries left`);
    }
  };

  return (
    <View
      testID="lock-screen"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.surface,
        justifyContent: "center",
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      {ready && (
        <PinPad
          testIDPrefix="lock-pin"
          title="CIPHERCHAT LOCKED"
          subtitle="Enter your 6-digit PIN"
          error={cooling ? `Too many attempts. Wait ${Math.ceil((coolUntil - Date.now()) / 1000)}s.` : error}
          disabled={cooling}
          onComplete={onPin}
          onBiometric={useBio ? () => unlockWithBio() : undefined}
        />
      )}
    </View>
  );
}
