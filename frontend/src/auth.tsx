import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, MeUser, setToken, setUnauthorizedHandler } from "./api";
import { deriveKeys, generateIdentity, Identity, openVault, sealVault } from "./crypto";
import { queryClient } from "./query-client";
import { storage } from "./utils/storage";

const SESSION_KEY = "cipherchat_session";

type Session = { token: string; user: MeUser; identity: Identity };
type AuthState = {
  status: "loading" | "out" | "in";
  user: MeUser | null;
  identity: Identity | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

// Yield to the UI so the "deriving keys" state paints before the CPU-heavy KDF.
const nextFrame = () => new Promise((r) => setTimeout(r, 50));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  const persist = useCallback(async (s: Session) => {
    setToken(s.token);
    await storage.secureSet(SESSION_KEY, JSON.stringify(s));
    setSession(s);
    setStatus("in");
  }, []);

  const logout = useCallback(async () => {
    setToken(null);
    await storage.secureRemove(SESSION_KEY);
    queryClient.clear();
    setSession(null);
    setStatus("out");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void logout());
    (async () => {
      const raw = await storage.secureGet(SESSION_KEY, null);
      if (typeof raw !== "string") return setStatus("out");
      try {
        const s: Session = JSON.parse(raw);
        setToken(s.token);
        setSession(s);
        setStatus("in");
      } catch {
        setStatus("out");
      }
    })();
  }, [logout]);

  const login = useCallback(
    async (username: string, password: string) => {
      await nextFrame();
      const { authHash, masterKey } = deriveKeys(username, password);
      const res = await api<{ token: string; user: MeUser }>("/auth/login", {
        method: "POST",
        body: { username, auth_hash: authHash },
      });
      const identity = openVault(res.user.vault, res.user.vault_nonce, masterKey, res.user.box_pub, res.user.sign_pub);
      if (!identity) throw new Error("Could not unlock your key vault.");
      await persist({ token: res.token, user: res.user, identity });
    },
    [persist],
  );

  const register = useCallback(
    async (username: string, displayName: string, password: string) => {
      await nextFrame();
      const { authHash, masterKey } = deriveKeys(username, password);
      const identity = generateIdentity();
      const sealed = sealVault(identity, masterKey);
      const res = await api<{ token: string; user: MeUser }>("/auth/register", {
        method: "POST",
        body: {
          username,
          display_name: displayName,
          auth_hash: authHash,
          box_pub: identity.boxPub,
          sign_pub: identity.signPub,
          ...sealed,
        },
      });
      await persist({ token: res.token, user: res.user, identity });
    },
    [persist],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      user: session?.user ?? null,
      identity: session?.identity ?? null,
      login,
      register,
      logout,
    }),
    [status, session, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** For screens rendered only when signed in. */
export function useSession() {
  const { user, identity } = useAuth();
  return { user: user!, identity: identity! };
}
