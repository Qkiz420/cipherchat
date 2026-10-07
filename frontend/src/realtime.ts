// Live connection (WebSocket) for instant delivery + typing indicators.
// Polling in screens stays as a slow fallback if the socket drops.
import { AppState } from "react-native";

import { WS_URL } from "./api";
import type { WireMessage } from "./crypto";

export type RtEvent =
  | { type: "message"; chat_id: string; message: WireMessage }
  | { type: "typing"; chat_id: string; user_id: string; name: string }
  | { type: "chat"; chat_id: string }
  | { type: "pong" };

type Listener = (e: RtEvent) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(up: boolean) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  connected = false;

  constructor() {
    AppState.addEventListener("change", (s) => {
      if (s === "active" && this.token && !this.connected) this.open();
    });
  }

  start(token: string) {
    if (this.token === token && this.ws) return;
    this.stop();
    this.token = token;
    this.open();
  }

  stop() {
    this.token = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
  }

  private setConnected(v: boolean) {
    this.connected = v;
    this.statusListeners.forEach((l) => l(v));
  }

  private open() {
    if (!this.token) return;
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ type: "ping" }), 25000);
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as RtEvent;
        this.listeners.forEach((l) => l(data));
      } catch {}
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      if (this.ping) clearInterval(this.ping);
      if (!this.token) return;
      const delay = Math.min(10000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(obj: object) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  onStatus(l: (up: boolean) => void) {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  }
}

export const realtime = new Realtime();
