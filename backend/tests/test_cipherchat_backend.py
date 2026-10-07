"""CipherChat backend tests - blind relay, auth, chats, messages, disappearing."""
import base64
import os
import secrets
import time
import uuid
from datetime import datetime

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") if os.environ.get("EXPO_PUBLIC_BACKEND_URL") else None
if not BASE_URL:
    # fallback: read frontend .env
    for ln in open("/app/frontend/.env"):
        if ln.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = ln.split("=", 1)[1].strip().rstrip("/")

API = f"{BASE_URL}/api"
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


def b64rand(n: int) -> str:
    return base64.b64encode(secrets.token_bytes(n)).decode()


def hex64() -> str:
    return secrets.token_hex(32)


def tag() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def register_user(session, prefix="test"):
    username = f"test_{prefix}_{tag()}"
    body = {
        "username": username,
        "display_name": f"T {prefix}",
        "auth_hash": hex64(),
        "box_pub": b64rand(32),
        "sign_pub": b64rand(32),
        "vault": b64rand(80),
        "vault_nonce": b64rand(24),
    }
    r = session.post(f"{API}/auth/register", json=body)
    assert r.status_code == 201, r.text
    data = r.json()
    return {"token": data["token"], "user": data["user"], "auth_hash": body["auth_hash"], "username": username}


def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ----------------------------------------------------- Health
class TestHealth:
    def test_root(self, session):
        r = session.get(f"{API}/")
        assert r.status_code == 200
        assert "online" in r.json()["message"].lower()


# ----------------------------------------------------- Auth
class TestAuth:
    def test_register_and_me(self, session):
        u = register_user(session, "reg")
        r = session.get(f"{API}/auth/me", headers=auth_headers(u["token"]))
        assert r.status_code == 200
        assert r.json()["username"] == u["username"]
        assert "vault" in r.json() and "box_pub" in r.json()

    def test_duplicate_username(self, session):
        u = register_user(session, "dup")
        body = {
            "username": u["username"],
            "display_name": "X",
            "auth_hash": hex64(),
            "box_pub": b64rand(32), "sign_pub": b64rand(32),
            "vault": b64rand(80), "vault_nonce": b64rand(24),
        }
        r = session.post(f"{API}/auth/register", json=body)
        assert r.status_code == 409

    def test_me_requires_token(self, session):
        r = session.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_me_bad_token(self, session):
        r = session.get(f"{API}/auth/me", headers={"Authorization": "Bearer not.a.jwt"})
        assert r.status_code == 401

    def test_login_success(self, session):
        u = register_user(session, "login")
        r = session.post(f"{API}/auth/login", json={"username": u["username"], "auth_hash": u["auth_hash"]})
        assert r.status_code == 200
        assert "token" in r.json()

    def test_login_wrong_password(self, session):
        u = register_user(session, "wrong")
        r = session.post(f"{API}/auth/login", json={"username": u["username"], "auth_hash": hex64()})
        assert r.status_code == 401

    def test_login_lockout_429(self, session):
        u = register_user(session, "lock")
        statuses = []
        for _ in range(11):
            r = session.post(f"{API}/auth/login", json={"username": u["username"], "auth_hash": hex64()})
            statuses.append(r.status_code)
        assert 429 in statuses, f"Expected lockout 429, got {statuses}"

    def test_register_rejects_bad_username(self, session):
        body = {
            "username": "Bad User!",
            "display_name": "x", "auth_hash": hex64(),
            "box_pub": b64rand(32), "sign_pub": b64rand(32),
            "vault": b64rand(80), "vault_nonce": b64rand(24),
        }
        r = session.post(f"{API}/auth/register", json=body)
        assert r.status_code == 422


# ----------------------------------------------------- Users / Search
class TestSearch:
    def test_search_finds_other_user(self, session):
        a = register_user(session, "sa")
        b = register_user(session, "sb")
        # Search by prefix of b's username
        prefix = b["username"][:10]
        r = session.get(f"{API}/users/search", params={"q": prefix}, headers=auth_headers(a["token"]))
        assert r.status_code == 200
        ids = [u["id"] for u in r.json()]
        assert b["user"]["id"] in ids

    def test_search_excludes_self(self, session):
        a = register_user(session, "self")
        r = session.get(f"{API}/users/search", params={"q": a["username"]}, headers=auth_headers(a["token"]))
        assert r.status_code == 200
        ids = [u["id"] for u in r.json()]
        assert a["user"]["id"] not in ids

    def test_search_empty_returns_empty(self, session):
        a = register_user(session, "emp")
        r = session.get(f"{API}/users/search", params={"q": ""}, headers=auth_headers(a["token"]))
        assert r.status_code == 200
        assert r.json() == []


# ----------------------------------------------------- Chats
class TestChats:
    def test_create_direct_and_dedup(self, session):
        a = register_user(session, "ca")
        b = register_user(session, "cb")
        body = {"type": "direct", "member_ids": [b["user"]["id"]]}
        r1 = session.post(f"{API}/chats", json=body, headers=auth_headers(a["token"]))
        assert r1.status_code == 201
        chat1 = r1.json()
        assert chat1["type"] == "direct"
        assert len(chat1["members"]) == 2

        r2 = session.post(f"{API}/chats", json=body, headers=auth_headers(a["token"]))
        assert r2.status_code in (200, 201)
        assert r2.json()["id"] == chat1["id"], "Duplicate direct chat should be reused"

    def test_group_requires_name(self, session):
        a = register_user(session, "ga")
        b = register_user(session, "gb")
        r = session.post(f"{API}/chats", json={"type": "group", "member_ids": [b["user"]["id"]]},
                         headers=auth_headers(a["token"]))
        assert r.status_code == 422

    def test_create_group(self, session):
        a = register_user(session, "gg1")
        b = register_user(session, "gg2")
        c = register_user(session, "gg3")
        r = session.post(f"{API}/chats",
                         json={"type": "group", "name": "Test Grp", "member_ids": [b["user"]["id"], c["user"]["id"]]},
                         headers=auth_headers(a["token"]))
        assert r.status_code == 201
        assert r.json()["name"] == "Test Grp"
        assert len(r.json()["members"]) == 3

    def test_get_chat_non_member_404(self, session):
        a = register_user(session, "nm1")
        b = register_user(session, "nm2")
        c = register_user(session, "nm3")
        r1 = session.post(f"{API}/chats", json={"type": "direct", "member_ids": [b["user"]["id"]]},
                          headers=auth_headers(a["token"]))
        chat_id = r1.json()["id"]
        r2 = session.get(f"{API}/chats/{chat_id}", headers=auth_headers(c["token"]))
        assert r2.status_code == 404


# ----------------------------------------------------- Messages
class TestMessages:
    def _make_direct(self, session):
        a = register_user(session, "ma")
        b = register_user(session, "mb")
        r = session.post(f"{API}/chats", json={"type": "direct", "member_ids": [b["user"]["id"]]},
                         headers=auth_headers(a["token"]))
        return a, b, r.json()

    def _msg_payload(self, member_ids):
        return {
            "ciphertext": b64rand(128),
            "nonce": b64rand(24),
            "epk": b64rand(32),
            "keys": {mid: {"n": b64rand(24), "k": b64rand(48)} for mid in member_ids},
            "sig": b64rand(64),
        }

    def test_send_and_receive(self, session):
        a, b, chat = self._make_direct(session)
        member_ids = [m["id"] for m in chat["members"]]
        payload = self._msg_payload(member_ids)
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=auth_headers(a["token"]))
        assert r.status_code == 201, r.text
        msg = r.json()
        assert msg["ciphertext"] == payload["ciphertext"]

        # B receives it
        rb = session.get(f"{API}/chats/{chat['id']}/messages", headers=auth_headers(b["token"]))
        assert rb.status_code == 200
        assert len(rb.json()) >= 1
        # B sees own key not A's
        last = rb.json()[-1]
        assert last["key"] == {"n": payload["keys"][b["user"]["id"]]["n"], "k": payload["keys"][b["user"]["id"]]["k"]}

    def test_send_rejects_mismatched_keys_409(self, session):
        a, b, chat = self._make_direct(session)
        payload = self._msg_payload([a["user"]["id"]])  # missing b
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=auth_headers(a["token"]))
        assert r.status_code == 409

    def test_non_member_cannot_send_404(self, session):
        a, b, chat = self._make_direct(session)
        c = register_user(session, "nmc")
        payload = self._msg_payload([a["user"]["id"], b["user"]["id"]])
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=auth_headers(c["token"]))
        assert r.status_code == 404

    def test_non_member_cannot_list_404(self, session):
        a, b, chat = self._make_direct(session)
        c = register_user(session, "nml")
        r = session.get(f"{API}/chats/{chat['id']}/messages", headers=auth_headers(c["token"]))
        assert r.status_code == 404

    @pytest.mark.asyncio
    async def test_mongo_stores_only_ciphertext(self, session):
        a, b, chat = self._make_direct(session)
        member_ids = [m["id"] for m in chat["members"]]
        secret_plain = "SECRET_PLAIN_TEXT_DO_NOT_FIND"
        payload = self._msg_payload(member_ids)
        r = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=auth_headers(a["token"]))
        assert r.status_code == 201

        mclient = AsyncIOMotorClient(MONGO_URL, tz_aware=True)
        try:
            docs = await mclient[DB_NAME].messages.find({"chat_id": chat["id"]}).to_list(50)
            assert docs, "No messages found"
            for d in docs:
                flat = str(d)
                assert secret_plain not in flat
                # Ensure no plaintext fields exist
                for forbidden in ("text", "plaintext", "body"):
                    assert forbidden not in d, f"Unexpected plaintext field: {forbidden}"
                # Required encrypted fields present
                for req in ("ciphertext", "nonce", "epk", "keys", "sig"):
                    assert req in d
        finally:
            mclient.close()


# ----------------------------------------------------- Disappearing
class TestDisappearing:
    def test_disappear_ttl_expires(self, session):
        a = register_user(session, "da")
        b = register_user(session, "db")
        rc = session.post(f"{API}/chats", json={"type": "direct", "member_ids": [b["user"]["id"]]},
                          headers=auth_headers(a["token"]))
        chat = rc.json()
        # Set 2s TTL
        rp = session.patch(f"{API}/chats/{chat['id']}", json={"disappear_seconds": 2},
                           headers=auth_headers(a["token"]))
        assert rp.status_code == 200
        assert rp.json()["disappear_seconds"] == 2
        member_ids = [m["id"] for m in chat["members"]]
        payload = {
            "ciphertext": b64rand(128), "nonce": b64rand(24), "epk": b64rand(32),
            "keys": {mid: {"n": b64rand(24), "k": b64rand(48)} for mid in member_ids},
            "sig": b64rand(64),
        }
        rs = session.post(f"{API}/chats/{chat['id']}/messages", json=payload, headers=auth_headers(a["token"]))
        assert rs.status_code == 201
        msg_id = rs.json()["id"]
        # Immediately visible
        r1 = session.get(f"{API}/chats/{chat['id']}/messages", headers=auth_headers(b["token"]))
        assert any(m["id"] == msg_id for m in r1.json())
        # After TTL
        time.sleep(3.5)
        r2 = session.get(f"{API}/chats/{chat['id']}/messages", headers=auth_headers(b["token"]))
        assert not any(m["id"] == msg_id for m in r2.json()), "Expired message should be excluded"
