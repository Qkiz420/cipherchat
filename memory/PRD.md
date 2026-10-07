# CipherChat — PRD

## Original problem statement
Build a mobile app: Create an encrypted app similar to Telegram, using a cipher that only this specific app can decode.

User choices: real E2E (NaCl), username+password JWT, 1-to-1 + user search + polling, group chats, disappearing messages, dark sleek "secure" look, "better than end-to-end" encryption.

## Architecture
- Expo Router (SDK 57) frontend, FastAPI + MongoDB backend acting as a "blind relay": it stores only ciphertext.
- Crypto (src/crypto.ts, tweetnacl + expo-crypto PRNG):
  - Zero-knowledge login: password → SHA-512 ×3000 KDF → authHash (sent, Argon2id on server) + masterKey (never leaves the device)
  - X25519 + Ed25519 identity keys; private keys sealed in a vault with masterKey (so you can log in on another device)
  - Each message gets its own random key (XSalsa20-Poly1305), wrapped per recipient with a one-time ephemeral X25519 key
  - Ed25519 signature on every message; 128-byte length padding
  - Safety numbers and key fingerprints
  - Self-destruct timers; Mongo TTL index deletes expired messages
- JWT (HS256, 30 days), login lockout after 10 failed attempts in 15 min

## Implemented (2026-06)
- Auth screen (login/register), chat list with decrypted previews, new chat (direct/group), chat screen (polling 2s, optimistic send, retry, verified shield, timer sheet), chat info (safety number, member fingerprints, protocol), settings (fingerprint copy, security layers, logout with confirm)
- Backend tests: /app/backend/tests/test_cipherchat_backend.py (22 pass)

## Iteration 2 (2026-06)
- Encrypted attachments (photos/files, one-time key, Emergent object storage)
- WebSocket /api/ws instant delivery + typing indicators (polling fallback 8s)
- App lock: 6-digit PIN, biometrics, screenshot blocking (native builds only)
- Group admin: add/remove/leave, key_epoch rotation, system messages, sealed-audience visibility
- Emergent push notifications ("New message" only, no content). google-services.json NOT yet provided.
- Deployment fixes: removed TTL indexes (expired messages purged on chat open), quoted env, N+1 fix, .gitignore env rules removed
- Backend tests: 39 pass

## Backlog
- P0: Add google-services.json for Android push; in-app account deletion (Apple review)
- P1: Real-time WebSockets, unread counts, typing indicators
- P1: App lock (PIN/biometric), screenshot protection (native build)
- P2: Encrypted image/file attachments (object storage), Double Ratchet for full forward secrecy, group admin (add/remove members + key rotation), message delete for everyone
