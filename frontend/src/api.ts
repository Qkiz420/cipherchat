import type { WireMessage } from "./crypto";

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;
export const WS_URL = `${BASE.replace(/^http/, "ws")}/ws`;

let token: string | null = null;
export const getToken = () => token;
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("Connection interrupted. Check your network.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && onUnauthorized) onUnauthorized();
    const detail = data?.detail;
    const msg = typeof detail === "string" ? detail : Array.isArray(detail) ? detail[0]?.msg : "Request failed";
    throw new ApiError(msg ?? "Request failed", res.status);
  }
  return data as T;
}

export type PublicUser = {
  id: string;
  username: string;
  display_name: string;
  box_pub: string;
  sign_pub: string;
};
export type MeUser = PublicUser & { vault: string; vault_nonce: string };
export type ChatT = {
  id: string;
  type: "direct" | "group";
  name: string | null;
  created_by: string;
  disappear_seconds: number;
  key_epoch: number;
  members: PublicUser[];
  last_message: WireMessage | null;
  created_at: string;
  updated_at: string;
};
