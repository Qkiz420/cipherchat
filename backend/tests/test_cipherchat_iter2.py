"""CipherChat iteration-2 tests: attachments, websocket realtime, group admin, push."""
import asyncio
import base64
import json
import os
import secrets
import uuid
from pathlib import Path

import pytest
import requests
import websockets
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL")
if not BASE_URL:
    for ln in open("/app/frontend/.env"):
        if ln.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = ln.split("=", 1)[1].strip()
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"
WSS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/api/ws"


def b64rand(n): return base64.b64encode(secrets.token_bytes(n)).decode()
def hex64(): return secrets.token_hex(32)
def tag(): return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def register(session, prefix="t"):
    username = f"test_{prefix}_{tag()}"
    body = {"username": username, "display_name": f"T {prefix}", "auth_hash": hex64(),
            "box_pub": b64rand(32), "sign_pub": b64rand(32),
            "vault": b64rand(80), "vault_nonce": b64rand(24)}
    r = session.post(f"{API}/auth/register", json=body)
    assert r.status_code == 201, r.text
    d = r.json()
    return {"token": d["token"], "user": d["user"], "username": username}


def hdr(tok): return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def mk_direct(session):
    a, b = register(session, "a"), register(session, "b")
    r = session.post(f"{API}/chats", json={"type": "direct", "member_ids": [b["user"]["id"]]}, headers=hdr(a["token"]))
    return a, b, r.json()


def mk_group(session, extra=0):
    a, b = register(session, "ga"), register(session, "gb")
    extras = [register(session, f"gx{i}") for i in range(extra)]
    r = session.post(f"{API}/chats",
                     json={"type": "group", "name": f"G {tag()}",
                           "member_ids": [b["user"]["id"]] + [e["user"]["id"] for e in extras]},
                     headers=hdr(a["token"]))
    assert r.status_code == 201, r.text
    return a, b, extras, r.json()


def msg_payload(member_ids):
    return {"ciphertext": b64rand(128), "nonce": b64rand(24), "epk": b64rand(32),
            "keys": {mid: {"n": b64rand(24), "k": b64rand(48)} for mid in member_ids},
            "sig": b64rand(64)}


# ----------------------------------------------------- Attachments
class TestAttachments:
    def test_upload_and_download(self, session):
        a, b, chat = mk_direct(session)
        payload = base64.b64encode(b"hello cipherchat attachment").decode()
        r = session.post(f"{API}/chats/{chat['id']}/attachments", json={"data": payload}, headers=hdr(a["token"]))
        assert r.status_code == 201, r.text
        att_id = r.json()["id"]
        assert r.json()["size"] == 27
        # B (member) downloads
        rd = session.get(f"{API}/attachments/{att_id}", headers=hdr(b["token"]))
        assert rd.status_code == 200
        assert base64.b64decode(rd.json()["data"]) == b"hello cipherchat attachment"

    def test_non_member_download_404(self, session):
        a, b, chat = mk_direct(session)
        c = register(session, "nmatt")
        payload = base64.b64encode(b"x").decode()
        r = session.post(f"{API}/chats/{chat['id']}/attachments", json={"data": payload}, headers=hdr(a["token"]))
        att_id = r.json()["id"]
        rd = session.get(f"{API}/attachments/{att_id}", headers=hdr(c["token"]))
        assert rd.status_code == 404

    def test_too_large_413(self, session):
        a, b, chat = mk_direct(session)
        big = base64.b64encode(secrets.token_bytes(10 * 1024 * 1024 + 2048)).decode()
        r = session.post(f"{API}/chats/{chat['id']}/attachments", json={"data": big}, headers=hdr(a["token"]))
        assert r.status_code == 413, r.status_code

    def test_bad_attachment_id_404(self, session):
        a = register(session, "attbad")
        r = session.get(f"{API}/attachments/not-an-id", headers=hdr(a["token"]))
        assert r.status_code == 404


# ----------------------------------------------------- Group admin
class TestGroupAdmin:
    def test_add_members_admin_only(self, session):
        a, b, extras, chat = mk_group(session)
        c = register(session, "add1")
        # Non-admin cannot add
        r = session.post(f"{API}/chats/{chat['id']}/members", json={"user_ids": [c["user"]["id"]]}, headers=hdr(b["token"]))
        assert r.status_code == 403
        # Admin can
        r2 = session.post(f"{API}/chats/{chat['id']}/members", json={"user_ids": [c["user"]["id"]]}, headers=hdr(a["token"]))
        assert r2.status_code == 200, r2.text
        assert r2.json()["key_epoch"] == 1
        assert c["user"]["id"] in [m["id"] for m in r2.json()["members"]]

    def test_system_message_posted_on_add(self, session):
        a, b, extras, chat = mk_group(session)
        c = register(session, "sm")
        session.post(f"{API}/chats/{chat['id']}/members", json={"user_ids": [c["user"]["id"]]}, headers=hdr(a["token"]))
        rm = session.get(f"{API}/chats/{chat['id']}/messages", headers=hdr(a["token"]))
        assert rm.status_code == 200
        sys_msgs = [m for m in rm.json() if m["kind"] == "system"]
        assert sys_msgs, "Expected system message after add"
        assert "added" in sys_msgs[-1]["system_text"].lower()
        assert "epoch" in sys_msgs[-1]["system_text"].lower()

    def test_new_member_cannot_see_history(self, session):
        a, b, extras, chat = mk_group(session)
        member_ids = [a["user"]["id"], b["user"]["id"]]
        # a sends old message
        session.post(f"{API}/chats/{chat['id']}/messages", json=msg_payload(member_ids), headers=hdr(a["token"]))
        c = register(session, "newmem")
        session.post(f"{API}/chats/{chat['id']}/members", json={"user_ids": [c["user"]["id"]]}, headers=hdr(a["token"]))
        rc = session.get(f"{API}/chats/{chat['id']}/messages", headers=hdr(c["token"]))
        assert rc.status_code == 200
        # new member only sees system msg(s), not the pre-join user msg
        kinds = [m["kind"] for m in rc.json()]
        assert "msg" not in kinds, f"New member should not see pre-join messages; saw: {rc.json()}"

    def test_stale_key_set_returns_409(self, session):
        a, b, extras, chat = mk_group(session)
        c = register(session, "stale")
        session.post(f"{API}/chats/{chat['id']}/members", json={"user_ids": [c["user"]["id"]]}, headers=hdr(a["token"]))
        # Send with stale (pre-add) member list
        payload = msg_payload([a["user"]["id"], b["user"]["id"]])
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=hdr(a["token"]))
        assert r.status_code == 409

    def test_remove_member_and_access_lost(self, session):
        a, b, extras, chat = mk_group(session, extra=1)
        c = extras[0]
        r = session.delete(f"{API}/chats/{chat['id']}/members/{c['user']['id']}", headers=hdr(a["token"]))
        assert r.status_code == 200
        # Removed user: 404 on chat
        rc = session.get(f"{API}/chats/{chat['id']}", headers=hdr(c["token"]))
        assert rc.status_code == 404

    def test_non_admin_cannot_remove_other(self, session):
        a, b, extras, chat = mk_group(session, extra=1)
        c = extras[0]
        r = session.delete(f"{API}/chats/{chat['id']}/members/{c['user']['id']}", headers=hdr(b["token"]))
        assert r.status_code == 403

    def test_self_leave_allowed(self, session):
        a, b, extras, chat = mk_group(session, extra=1)
        # b leaves (self)
        r = session.delete(f"{API}/chats/{chat['id']}/members/{b['user']['id']}", headers=hdr(b["token"]))
        assert r.status_code == 200
        rc = session.get(f"{API}/chats/{chat['id']}", headers=hdr(b["token"]))
        assert rc.status_code == 404

    def test_admin_leaves_transfers_admin(self, session):
        a, b, extras, chat = mk_group(session, extra=1)
        c = extras[0]
        r = session.delete(f"{API}/chats/{chat['id']}/members/{a['user']['id']}", headers=hdr(a["token"]))
        assert r.status_code == 200
        rb = session.get(f"{API}/chats/{chat['id']}", headers=hdr(b["token"]))
        assert rb.status_code == 200
        # b or c is new admin
        assert rb.json()["created_by"] in [b["user"]["id"], c["user"]["id"]]


# ----------------------------------------------------- Register-push
class TestPush:
    def test_register_push_requires_auth(self, session):
        r = session.post(f"{API}/register-push", json={"platform": "ios", "device_token": "x" * 20})
        assert r.status_code == 401

    def test_message_send_still_works_with_placeholder_push(self, session):
        # placeholder push key must not block message send
        a, b, chat = mk_direct(session)
        payload = msg_payload([a["user"]["id"], b["user"]["id"]])
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=hdr(a["token"]))
        assert r.status_code == 201


# ----------------------------------------------------- WebSocket realtime
@pytest.mark.asyncio
class TestWebSocket:
    async def test_invalid_token_closes(self):
        try:
            async with websockets.connect(f"{WSS_URL}?token=bogus", open_timeout=10) as ws:
                # If somehow connected, expect it to close immediately
                await asyncio.wait_for(ws.recv(), timeout=5)
                assert False, "Should not receive messages with bogus token"
        except (websockets.exceptions.InvalidStatusCode, websockets.exceptions.ConnectionClosed,
                websockets.exceptions.InvalidStatus):
            pass  # expected

    async def test_message_delivered_via_ws(self, session):
        a, b, chat = mk_direct(session)
        received = []

        async def listener():
            async with websockets.connect(f"{WSS_URL}?token={b['token']}", open_timeout=10) as ws:
                try:
                    while True:
                        data = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
                        received.append(data)
                        if data.get("type") == "message":
                            return
                except asyncio.TimeoutError:
                    return

        listener_task = asyncio.create_task(listener())
        await asyncio.sleep(1.0)  # let socket establish
        payload = msg_payload([a["user"]["id"], b["user"]["id"]])
        # Use async send via thread (requests is sync)
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: session.post(f"{API}/chats/{chat['id']}/messages",
                                        json=payload, headers=hdr(a["token"])))
        await asyncio.wait_for(listener_task, timeout=10)
        assert any(d.get("type") == "message" and d.get("chat_id") == chat["id"] for d in received), received

    async def test_typing_broadcast(self, session):
        a, b, chat = mk_direct(session)
        received = []

        async def b_listener():
            async with websockets.connect(f"{WSS_URL}?token={b['token']}", open_timeout=10) as ws:
                try:
                    while True:
                        data = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
                        received.append(data)
                        if data.get("type") == "typing":
                            return
                except asyncio.TimeoutError:
                    return

        async def a_sender():
            await asyncio.sleep(1.0)
            async with websockets.connect(f"{WSS_URL}?token={a['token']}", open_timeout=10) as ws:
                await ws.send(json.dumps({"type": "typing", "chat_id": chat["id"]}))
                await asyncio.sleep(2.0)

        await asyncio.gather(b_listener(), a_sender())
        assert any(d.get("type") == "typing" and d.get("chat_id") == chat["id"] for d in received), received
