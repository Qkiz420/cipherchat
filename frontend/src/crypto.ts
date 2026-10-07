// CipherChat cryptography (all client-side, server never sees plaintext or private keys).
//
// Layers:
// 1. Zero-knowledge login: password -> iterated SHA-512 KDF -> {authHash, masterKey}.
//    Only authHash is sent; masterKey (never leaves device) seals the private-key vault.
// 2. Identity: X25519 (encryption) + Ed25519 (signing) keypairs per user.
// 3. Per-message: fresh random 256-bit message key (XSalsa20-Poly1305) + fresh
//    ephemeral X25519 keypair that wraps the message key for each recipient.
// 4. Every message is Ed25519-signed by the sender (tamper/impersonation proof).
// 5. Plaintext is padded to 128-byte buckets so the server can't infer message length.
import * as ExpoCrypto from "expo-crypto";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

nacl.setPRNG((x: Uint8Array, n: number) => {
  const r = ExpoCrypto.getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = r[i];
});

const { decodeUTF8, encodeUTF8, encodeBase64: b64, decodeBase64: unb64 } = naclUtil;
const KDF_ITERATIONS = 3000;
const PAD_BLOCK = 128;

export type Identity = { boxPub: string; boxSec: string; signPub: string; signSec: string };
export type PublicMember = { id: string; box_pub: string; sign_pub: string };
export type EncryptedMessage = {
  ciphertext: string;
  nonce: string;
  epk: string;
  keys: Record<string, { n: string; k: string }>;
  sig: string;
};
export type WireMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  key: { n: string; k: string } | null;
  sig: string;
  ttl: number;
  created_at: string;
  expires_at: string | null;
};
export type Decrypted = { text: string; verified: boolean } | null;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function deriveKeys(username: string, password: string) {
  const salt = decodeUTF8(`cipherchat-v1:${username.trim().toLowerCase()}`);
  const pw = decodeUTF8(password);
  let h = nacl.hash(concat(salt, pw));
  for (let i = 0; i < KDF_ITERATIONS; i++) h = nacl.hash(concat(h, pw, salt));
  return { authHash: hex(h.slice(0, 32)), masterKey: h.slice(32, 64) };
}

export function generateIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    boxPub: b64(box.publicKey),
    boxSec: b64(box.secretKey),
    signPub: b64(sign.publicKey),
    signSec: b64(sign.secretKey),
  };
}

export function sealVault(id: Identity, masterKey: Uint8Array) {
  const nonce = nacl.randomBytes(24);
  const data = decodeUTF8(JSON.stringify({ b: id.boxSec, s: id.signSec }));
  return { vault: b64(nacl.secretbox(data, nonce, masterKey)), vault_nonce: b64(nonce) };
}

export function openVault(
  vault: string,
  nonce: string,
  masterKey: Uint8Array,
  boxPub: string,
  signPub: string,
): Identity | null {
  const opened = nacl.secretbox.open(unb64(vault), unb64(nonce), masterKey);
  if (!opened) return null;
  const { b, s } = JSON.parse(encodeUTF8(opened));
  return { boxPub, signPub, boxSec: b, signSec: s };
}

function pad(data: Uint8Array): Uint8Array {
  const len = Math.ceil((data.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(len);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  return data.slice(0, i);
}

const sigPayload = (chatId: string, ct: string, nonce: string, epk: string) =>
  decodeUTF8(`${chatId}|${ct}|${nonce}|${epk}`);

export function encryptMessage(
  text: string,
  chatId: string,
  members: PublicMember[],
  me: Identity,
): EncryptedMessage {
  const msgKey = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  const body = pad(decodeUTF8(JSON.stringify({ t: text, ts: Date.now() })));
  const ciphertext = b64(nacl.secretbox(body, nonce, msgKey));
  const eph = nacl.box.keyPair();
  const keys: EncryptedMessage["keys"] = {};
  for (const m of members) {
    const n = nacl.randomBytes(24);
    keys[m.id] = { n: b64(n), k: b64(nacl.box(msgKey, n, unb64(m.box_pub), eph.secretKey)) };
  }
  const epk = b64(eph.publicKey);
  const nonceB64 = b64(nonce);
  const sig = b64(nacl.sign.detached(sigPayload(chatId, ciphertext, nonceB64, epk), unb64(me.signSec)));
  return { ciphertext, nonce: nonceB64, epk, keys, sig };
}

const cache = new Map<string, Decrypted>();

export function decryptMessage(msg: WireMessage, me: Identity, senderSignPub?: string): Decrypted {
  if (cache.has(msg.id)) return cache.get(msg.id)!;
  let result: Decrypted = null;
  try {
    if (msg.key) {
      const msgKey = nacl.box.open(unb64(msg.key.k), unb64(msg.key.n), unb64(msg.epk), unb64(me.boxSec));
      const plain = msgKey && nacl.secretbox.open(unb64(msg.ciphertext), unb64(msg.nonce), msgKey);
      if (plain) {
        const { t } = JSON.parse(encodeUTF8(unpad(plain)));
        const verified =
          !!senderSignPub &&
          nacl.sign.detached.verify(
            sigPayload(msg.chat_id, msg.ciphertext, msg.nonce, msg.epk),
            unb64(msg.sig),
            unb64(senderSignPub),
          );
        result = { text: String(t), verified };
      }
    }
  } catch {
    result = null;
  }
  if (result) cache.set(msg.id, result);
  return result;
}

/** Short fingerprint of one identity (hex groups). */
export function keyFingerprint(boxPub: string, signPub: string): string {
  const h = nacl.hash(concat(unb64(boxPub), unb64(signPub)));
  return (hex(h.slice(0, 16)).toUpperCase().match(/.{4}/g) ?? []).join(" ");
}

/** Signal-style 60-digit safety number shared by two users. */
export function safetyNumber(a: { box_pub: string; sign_pub: string }, b: { box_pub: string; sign_pub: string }) {
  const parts = [a.box_pub + a.sign_pub, b.box_pub + b.sign_pub].sort();
  const h = nacl.hash(decodeUTF8(parts.join("|")));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = ((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0;
    groups.push(String(v % 100000).padStart(5, "0"));
  }
  return groups;
}
