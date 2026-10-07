"""CipherChat backend.

The server is a "blind relay": it only ever stores public keys, an encrypted
key vault (sealed client-side with a password-derived key the server never
sees) and message ciphertext. It cannot read any message content.
"""
import asyncio
import base64
import binascii
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Dict, List, Literal, Optional, Set

import httpx
import jwt
import requests
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt.exceptions import InvalidTokenError
from motor.motor_asyncio import AsyncIOMotorClient
from pwdlib import PasswordHash
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from pymongo.errors import DuplicateKeyError
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

client = AsyncIOMotorClient(os.environ["MONGO_URL"], tz_aware=True)
db = client[os.environ["DB_NAME"]]

JWT_SECRET = os.environ["JWT_SECRET"]
TOKEN_MINUTES = int(os.environ["ACCESS_TOKEN_MINUTES"])
JWT_ALG = "HS256"
JWT_ISS = "cipherchat"
JWT_AUD = "cipherchat-app"
MAX_FAILED_LOGINS = 10
LOCK_WINDOW = timedelta(minutes=15)

hasher = PasswordHash.recommended()
DUMMY_HASH = hasher.hash("never-valid-dummy-auth-hash")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ------------------------------------------------- object storage (blobs) ----
STORAGE_BASE = (os.environ.get("INTEGRATION_PROXY_URL") or "").strip() or "https://integrations.emergentagent.com"
STORAGE_URL = STORAGE_BASE.rstrip("/") + "/objstore/api/v1/storage"
EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY")
APP_NAME = "cipherchat"
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 + 1024
storage_key: Optional[str] = None


def init_storage() -> str:
    global storage_key
    if storage_key:
        return storage_key
    resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": EMERGENT_KEY}, timeout=30)
    resp.raise_for_status()
    storage_key = resp.json()["storage_key"]
    return storage_key


def _storage_call(method: str, path: str, **kw) -> requests.Response:
    global storage_key
    for attempt in range(2):
        resp = requests.request(method, f"{STORAGE_URL}/objects/{path}",
                                headers={"X-Storage-Key": init_storage(), **kw.pop("headers", {})}, **kw)
        if resp.status_code == 503 and attempt == 0:
            storage_key = None
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError("unreachable")


def put_object(path: str, data: bytes) -> dict:
    return _storage_call("PUT", path, headers={"Content-Type": "application/octet-stream"}, data=data, timeout=120).json()


def get_object(path: str) -> bytes:
    return _storage_call("GET", path, timeout=60).content


# ------------------------------------------------------- push (Emergent) ----
PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
push_client = httpx.AsyncClient(base_url=PUSH_BASE_URL, headers={"X-Push-Key": PUSH_KEY}, timeout=10.0)


async def send_push(recipients: List[str], data: dict, idempotency_key: Optional[str] = None) -> None:
    if not recipients:
        return
    if "title" not in data or "message" not in data:
        raise ValueError("data must include title and message")
    for i in range(0, len(recipients), 100):
        payload: dict = {"recipients": recipients[i:i + 100], "data": data}
        if idempotency_key:
            payload["$idempotency_key"] = f"{idempotency_key}-{i}"
        resp = await push_client.post("/api/v1/push/trigger", json=payload)
        if resp.status_code == 401:
            raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
        if resp.status_code >= 500:
            raise HTTPException(502, "Push provider unavailable")
        resp.raise_for_status()


async def notify_new_message(recipients: List[str], chat_id: str, msg_id: str) -> None:
    # Content-free by design: the server can't read messages and the user chose maximum privacy.
    try:
        await send_push(recipients, {"title": "CipherChat", "message": "New message",
                                     "action_url": f"/chat/{chat_id}"}, idempotency_key=msg_id)
    except Exception as e:  # never block messaging on push failure
        logger.warning(f"Push failed (non-blocking): {e}")


# ------------------------------------------------------ realtime hub (ws) ----
class Hub:
    def __init__(self):
        self.conns: Dict[str, Set[WebSocket]] = {}

    def add(self, uid: str, ws: WebSocket):
        self.conns.setdefault(uid, set()).add(ws)

    def remove(self, uid: str, ws: WebSocket):
        self.conns.get(uid, set()).discard(ws)
        if not self.conns.get(uid):
            self.conns.pop(uid, None)

    async def send(self, uid: str, payload: dict):
        for ws in list(self.conns.get(uid, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                self.remove(uid, ws)

    async def send_many(self, uids: List[str], payload: dict):
        await asyncio.gather(*(self.send(u, payload) for u in uids))


hub = Hub()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


# ---------------------------------------------------------------- models ----
PyObjectId = Annotated[str, BeforeValidator(lambda v: str(v) if isinstance(v, ObjectId) else v)]


class BaseDocument(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: Optional[PyObjectId] = Field(default=None, alias="_id")

    @classmethod
    def from_mongo(cls, doc: Optional[dict]):
        return cls.model_validate(doc) if doc else None

    def to_mongo(self) -> dict:
        data = self.model_dump(exclude={"id"})
        if self.id:
            data["_id"] = ObjectId(self.id)
        return data


class User(BaseDocument):
    username: str
    display_name: str
    auth_hash: str
    box_pub: str
    sign_pub: str
    vault: str
    vault_nonce: str
    created_at: datetime = Field(default_factory=now_utc)


class Chat(BaseDocument):
    type: Literal["direct", "group"]
    name: Optional[str] = None
    member_ids: List[str]
    created_by: str
    disappear_seconds: int = 0
    key_epoch: int = 0
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Message(BaseDocument):
    chat_id: str
    sender_id: str
    kind: Literal["msg", "system"] = "msg"
    system_text: Optional[str] = None
    ciphertext: str = ""
    nonce: str = ""
    epk: str = ""
    keys: Dict[str, Dict[str, str]] = {}
    sig: str = ""
    audience: List[str] = []
    ttl: int = 0
    created_at: datetime = Field(default_factory=now_utc)
    expires_at: Optional[datetime] = None


class Attachment(BaseDocument):
    chat_id: str
    owner_id: str
    storage_path: str
    size: int
    created_at: datetime = Field(default_factory=now_utc)
    expires_at: Optional[datetime] = None


B64 = r"^[A-Za-z0-9+/=]+$"


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    display_name: str = Field(min_length=1, max_length=48)
    auth_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    box_pub: str = Field(pattern=B64, max_length=64)
    sign_pub: str = Field(pattern=B64, max_length=64)
    vault: str = Field(pattern=B64, max_length=1024)
    vault_nonce: str = Field(pattern=B64, max_length=64)


class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    auth_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class ChatCreateIn(BaseModel):
    type: Literal["direct", "group"]
    member_ids: List[str] = Field(min_length=1, max_length=100)
    name: Optional[str] = Field(default=None, max_length=64)


class ChatUpdateIn(BaseModel):
    disappear_seconds: int = Field(ge=0, le=7 * 24 * 3600)


class WrappedKey(BaseModel):
    n: str = Field(pattern=B64, max_length=64)
    k: str = Field(pattern=B64, max_length=128)


class MessageIn(BaseModel):
    ciphertext: str = Field(pattern=B64, max_length=200_000)
    nonce: str = Field(pattern=B64, max_length=64)
    epk: str = Field(pattern=B64, max_length=64)
    keys: Dict[str, WrappedKey]
    sig: str = Field(pattern=B64, max_length=128)


class MembersIn(BaseModel):
    user_ids: List[str] = Field(min_length=1, max_length=50)


class AttachmentIn(BaseModel):
    data: str = Field(max_length=14_500_000)


class RegisterPushBody(BaseModel):
    user_id: Optional[str] = None
    platform: Literal["android", "ios"]
    device_token: str = Field(min_length=10, max_length=4096)


# --------------------------------------------------------------- helpers ----
def public_user(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name,
            "box_pub": u.box_pub, "sign_pub": u.sign_pub}


def me_user(u: User) -> dict:
    return {**public_user(u), "vault": u.vault, "vault_nonce": u.vault_nonce}


def message_out(m: Message, viewer_id: str) -> dict:
    return {"id": m.id, "chat_id": m.chat_id, "sender_id": m.sender_id, "kind": m.kind,
            "system_text": m.system_text, "ciphertext": m.ciphertext, "nonce": m.nonce, "epk": m.epk,
            "key": m.keys.get(viewer_id), "sig": m.sig, "ttl": m.ttl,
            "created_at": iso(m.created_at), "expires_at": iso(m.expires_at)}


def visible_query(chat_id: str, uid: str) -> dict:
    """Members only see messages sealed for them: joiners can't read history, removed members can't read new ones."""
    return {"chat_id": chat_id, "$and": [not_expired(), {"$or": [{"audience": uid}, {f"keys.{uid}": {"$exists": True}}]}]}


def oid(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(404, "Not found")


def not_expired() -> dict:
    return {"$or": [{"expires_at": None}, {"expires_at": {"$gt": now_utc()}}]}


def issue_token(user_id: str) -> str:
    n = now_utc()
    return jwt.encode({"sub": user_id, "iss": JWT_ISS, "aud": JWT_AUD, "iat": n,
                       "exp": n + timedelta(minutes=TOKEN_MINUTES)}, JWT_SECRET, algorithm=JWT_ALG)


async def current_user(creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(bearer)]) -> User:
    if not creds or creds.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")
    return await user_from_token(creds.credentials)


async def user_from_token(token: str) -> User:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG], issuer=JWT_ISS, audience=JWT_AUD)
        user = User.from_mongo(await db.users.find_one({"_id": ObjectId(payload["sub"])}))
    except (InvalidTokenError, InvalidId, KeyError, TypeError):
        raise HTTPException(401, "Invalid or expired session")
    if not user:
        raise HTTPException(401, "User not found")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def get_member_chat(chat_id: str, user: User) -> Chat:
    chat = Chat.from_mongo(await db.chats.find_one({"_id": oid(chat_id), "member_ids": user.id}))
    if not chat:
        raise HTTPException(404, "Chat not found")
    return chat


async def users_by_ids(ids: List[str]) -> Dict[str, User]:
    docs = await db.users.find({"_id": {"$in": [ObjectId(i) for i in ids]}}).to_list(500)
    return {u.id: u for u in (User.from_mongo(d) for d in docs)}


async def last_messages(chat_ids: List[str], uid: str) -> Dict[str, Message]:
    """One aggregation for the latest visible message of every chat (avoids N+1)."""
    pipeline = [
        {"$match": {"chat_id": {"$in": chat_ids}, "$and": [
            not_expired(), {"$or": [{"audience": uid}, {f"keys.{uid}": {"$exists": True}}]}]}},
        {"$sort": {"created_at": -1}},
        {"$group": {"_id": "$chat_id", "doc": {"$first": "$$ROOT"}}},
    ]
    rows = await db.messages.aggregate(pipeline).to_list(len(chat_ids) or 1)
    return {r["_id"]: Message.from_mongo(r["doc"]) for r in rows}


_UNSET: Any = object()


async def chat_out(chat: Chat, viewer: User, members: Optional[Dict[str, User]] = None, last: Any = _UNSET) -> dict:
    members = members or await users_by_ids(chat.member_ids)
    if last is _UNSET:
        last = Message.from_mongo(await db.messages.find_one(
            visible_query(chat.id, viewer.id), sort=[("created_at", -1)]))
    return {"id": chat.id, "type": chat.type, "name": chat.name, "created_by": chat.created_by,
            "disappear_seconds": chat.disappear_seconds, "key_epoch": chat.key_epoch,
            "members": [public_user(members[m]) for m in chat.member_ids if m in members],
            "last_message": message_out(last, viewer.id) if last else None,
            "created_at": iso(chat.created_at), "updated_at": iso(chat.updated_at)}


# ---------------------------------------------------------------- routes ----
app = FastAPI()
api = APIRouter(prefix="/api")


@api.get("/")
async def root():
    return {"message": "CipherChat relay online"}


@api.post("/auth/register", status_code=201)
async def register(body: RegisterIn):
    username = body.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_]{3,32}", username):
        raise HTTPException(422, "Username may only contain letters, numbers and _")
    user = User(username=username, display_name=body.display_name.strip(), auth_hash=hasher.hash(body.auth_hash),
                box_pub=body.box_pub, sign_pub=body.sign_pub, vault=body.vault, vault_nonce=body.vault_nonce)
    try:
        res = await db.users.insert_one(user.to_mongo())
    except DuplicateKeyError:
        raise HTTPException(409, "Username is already taken")
    user.id = str(res.inserted_id)
    return {"token": issue_token(user.id), "user": me_user(user)}


@api.post("/auth/login")
async def login(body: LoginIn):
    username = body.username.strip().lower()
    since = now_utc() - LOCK_WINDOW
    if await db.login_failures.count_documents({"username": username, "at": {"$gt": since}}) >= MAX_FAILED_LOGINS:
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")
    user = User.from_mongo(await db.users.find_one({"username": username}))
    valid = hasher.verify(body.auth_hash, user.auth_hash if user else DUMMY_HASH)
    if not user or not valid:
        await db.login_failures.insert_one({"username": username, "at": now_utc()})
        raise HTTPException(401, "Incorrect username or password")
    await db.login_failures.delete_many({"username": username})
    return {"token": issue_token(user.id), "user": me_user(user)}


@api.get("/auth/me")
async def me(user: CurrentUser):
    return me_user(user)


@api.get("/users/search")
async def search_users(user: CurrentUser, q: str = Query("", max_length=32)):
    q = q.strip().lower()
    if not q:
        return []
    rx = {"$regex": "^" + re.escape(q), "$options": "i"}
    docs = await db.users.find({"_id": {"$ne": ObjectId(user.id)},
                                "$or": [{"username": rx}, {"display_name": rx}]}).to_list(25)
    return [public_user(User.from_mongo(d)) for d in docs]


@api.get("/chats")
async def list_chats(user: CurrentUser):
    docs = await db.chats.find({"member_ids": user.id}).sort("updated_at", -1).to_list(200)
    chats = [Chat.from_mongo(d) for d in docs]
    members = await users_by_ids(list({m for c in chats for m in c.member_ids}))
    lasts = await last_messages([c.id for c in chats], user.id)
    return [await chat_out(c, user, members, lasts.get(c.id)) for c in chats]


@api.post("/chats", status_code=201)
async def create_chat(body: ChatCreateIn, user: CurrentUser):
    ids = list(dict.fromkeys([user.id] + [m for m in body.member_ids if m != user.id]))
    if len(ids) < 2:
        raise HTTPException(422, "Pick at least one other person")
    found = await users_by_ids(ids)
    if len(found) != len(ids):
        raise HTTPException(404, "Some users were not found")
    if body.type == "direct":
        if len(ids) != 2:
            raise HTTPException(422, "Direct chats have exactly two people")
        existing = Chat.from_mongo(await db.chats.find_one(
            {"type": "direct", "member_ids": {"$all": ids, "$size": 2}}))
        if existing:
            return await chat_out(existing, user, found)
    elif not (body.name or "").strip():
        raise HTTPException(422, "Group name is required")
    chat = Chat(type=body.type, name=(body.name or "").strip() or None, member_ids=ids, created_by=user.id)
    res = await db.chats.insert_one(chat.to_mongo())
    chat.id = str(res.inserted_id)
    return await chat_out(chat, user, found)


@api.get("/chats/{chat_id}")
async def get_chat(chat_id: str, user: CurrentUser):
    return await chat_out(await get_member_chat(chat_id, user), user)


@api.patch("/chats/{chat_id}")
async def update_chat(chat_id: str, body: ChatUpdateIn, user: CurrentUser):
    chat = await get_member_chat(chat_id, user)
    await db.chats.update_one({"_id": ObjectId(chat.id)},
                              {"$set": {"disappear_seconds": body.disappear_seconds, "updated_at": now_utc()}})
    chat.disappear_seconds = body.disappear_seconds
    await hub.send_many(chat.member_ids, {"type": "chat", "chat_id": chat.id})
    return await chat_out(chat, user)


async def add_system_message(chat: Chat, text: str) -> None:
    msg = Message(chat_id=chat.id, sender_id="system", kind="system", system_text=text, audience=chat.member_ids)
    res = await db.messages.insert_one(msg.to_mongo())
    msg.id = str(res.inserted_id)
    for uid in chat.member_ids:
        await hub.send(uid, {"type": "message", "chat_id": chat.id, "message": message_out(msg, uid)})


@api.post("/chats/{chat_id}/members")
async def add_members(chat_id: str, body: MembersIn, user: CurrentUser):
    chat = await get_member_chat(chat_id, user)
    if chat.type != "group":
        raise HTTPException(422, "Only groups have members to manage")
    if chat.created_by != user.id:
        raise HTTPException(403, "Only the group admin can add members")
    new_ids = [u for u in dict.fromkeys(body.user_ids) if u not in chat.member_ids]
    found = await users_by_ids(new_ids) if new_ids else {}
    if len(found) != len(new_ids):
        raise HTTPException(404, "Some users were not found")
    if not new_ids:
        return await chat_out(chat, user)
    chat.member_ids += new_ids
    chat.key_epoch += 1
    await db.chats.update_one({"_id": ObjectId(chat.id)}, {"$set": {
        "member_ids": chat.member_ids, "key_epoch": chat.key_epoch, "updated_at": now_utc()}})
    names = ", ".join(found[u].display_name for u in new_ids)
    await add_system_message(chat, f"{user.display_name} added {names} · keys rotated (epoch {chat.key_epoch})")
    await hub.send_many(chat.member_ids, {"type": "chat", "chat_id": chat.id})
    return await chat_out(chat, user)


@api.delete("/chats/{chat_id}/members/{member_id}")
async def remove_member(chat_id: str, member_id: str, user: CurrentUser):
    chat = await get_member_chat(chat_id, user)
    if chat.type != "group":
        raise HTTPException(422, "Only groups have members to manage")
    leaving = member_id == user.id
    if not leaving and chat.created_by != user.id:
        raise HTTPException(403, "Only the group admin can remove members")
    if member_id not in chat.member_ids:
        raise HTTPException(404, "Not a member")
    target = (await users_by_ids([member_id])).get(member_id)
    old_members = list(chat.member_ids)
    chat.member_ids = [m for m in chat.member_ids if m != member_id]
    if not chat.member_ids:
        await db.chats.delete_one({"_id": ObjectId(chat.id)})
        await db.messages.delete_many({"chat_id": chat.id})
        return {"ok": True, "deleted": True}
    if chat.created_by == member_id:
        chat.created_by = chat.member_ids[0]
    chat.key_epoch += 1
    await db.chats.update_one({"_id": ObjectId(chat.id)}, {"$set": {
        "member_ids": chat.member_ids, "created_by": chat.created_by,
        "key_epoch": chat.key_epoch, "updated_at": now_utc()}})
    who = target.display_name if target else "A member"
    text = f"{who} left" if leaving else f"{user.display_name} removed {who}"
    await add_system_message(chat, f"{text} · keys rotated (epoch {chat.key_epoch})")
    await hub.send_many(old_members, {"type": "chat", "chat_id": chat.id})
    return {"ok": True, "deleted": False}


@api.get("/chats/{chat_id}/messages")
async def list_messages(chat_id: str, user: CurrentUser, after: Optional[str] = None):
    chat = await get_member_chat(chat_id, user)
    # Self-destruct: purge this chat's expired messages/attachments when a member opens it.
    expired = {"chat_id": chat.id, "expires_at": {"$ne": None, "$lte": now_utc()}}
    await db.messages.delete_many(expired)
    await db.attachments.delete_many(expired)
    query: Dict[str, Any] = visible_query(chat.id, user.id)
    if after:
        try:
            query["created_at"] = {"$gt": datetime.fromisoformat(after)}
        except ValueError:
            raise HTTPException(422, "Invalid 'after' timestamp")
    docs = await db.messages.find(query).sort("created_at", -1).limit(300).to_list(300)
    return [message_out(Message.from_mongo(d), user.id) for d in reversed(docs)]


@api.post("/chats/{chat_id}/messages", status_code=201)
async def send_message(chat_id: str, body: MessageIn, user: CurrentUser):
    chat = await get_member_chat(chat_id, user)
    if set(body.keys.keys()) != set(chat.member_ids):
        raise HTTPException(409, "Message must be sealed for every current member")
    created = now_utc()
    ttl = chat.disappear_seconds
    msg = Message(chat_id=chat.id, sender_id=user.id, ciphertext=body.ciphertext, nonce=body.nonce, epk=body.epk,
                  keys={k: v.model_dump() for k, v in body.keys.items()}, sig=body.sig, ttl=ttl,
                  audience=chat.member_ids,
                  created_at=created, expires_at=created + timedelta(seconds=ttl) if ttl else None)
    res = await db.messages.insert_one(msg.to_mongo())
    msg.id = str(res.inserted_id)
    await db.chats.update_one({"_id": ObjectId(chat.id)}, {"$set": {"updated_at": created}})
    for uid in chat.member_ids:
        await hub.send(uid, {"type": "message", "chat_id": chat.id, "message": message_out(msg, uid)})
    others = [m for m in chat.member_ids if m != user.id]
    asyncio.create_task(notify_new_message(others, chat.id, msg.id))
    return message_out(msg, user.id)


@api.post("/chats/{chat_id}/attachments", status_code=201)
async def upload_attachment(chat_id: str, body: AttachmentIn, user: CurrentUser):
    """Stores an already-encrypted blob. The key lives only inside the E2E message."""
    chat = await get_member_chat(chat_id, user)
    try:
        raw = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "Attachment must be base64")
    if not raw or len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, "Attachment too large (max 10 MB)")
    path = f"{APP_NAME}/uploads/{user.id}/{uuid.uuid4()}.bin"
    try:
        result = await run_in_threadpool(put_object, path, raw)
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 0
        logger.warning(f"Storage upload failed: {code}")
        if code == 402:
            raise HTTPException(402, "Storage is out of credits. Try again later.")
        raise HTTPException(502, "Storage unavailable")
    ttl = chat.disappear_seconds
    att = Attachment(chat_id=chat.id, owner_id=user.id, storage_path=result.get("path", path), size=len(raw),
                     expires_at=now_utc() + timedelta(seconds=ttl + 600) if ttl else None)
    res = await db.attachments.insert_one(att.to_mongo())
    return {"id": str(res.inserted_id), "size": att.size}


@api.get("/attachments/{att_id}")
async def download_attachment(att_id: str, user: CurrentUser):
    att = Attachment.from_mongo(await db.attachments.find_one({"_id": oid(att_id), **not_expired()}))
    if not att:
        raise HTTPException(404, "Attachment not found or expired")
    await get_member_chat(att.chat_id, user)
    try:
        data = await run_in_threadpool(get_object, att.storage_path)
    except requests.HTTPError:
        raise HTTPException(502, "Storage unavailable")
    return {"data": base64.b64encode(data).decode()}


@api.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody, user: CurrentUser):
    payload = {"user_id": user.id, "platform": body.platform, "device_token": body.device_token}
    resp = await push_client.post("/api/v1/push/users/register", json=payload)
    if resp.status_code == 401:
        raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
    if resp.status_code >= 500:
        raise HTTPException(502, "Push provider unavailable")
    resp.raise_for_status()
    return {"status": "registered"}


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query("")):
    try:
        user = await user_from_token(token)
    except HTTPException:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.add(user.id, ws)
    try:
        while True:
            data = await ws.receive_json()
            kind = data.get("type")
            if kind == "ping":
                await ws.send_json({"type": "pong"})
            elif kind == "typing":
                try:
                    chat = Chat.from_mongo(await db.chats.find_one(
                        {"_id": ObjectId(str(data.get("chat_id"))), "member_ids": user.id}))
                except InvalidId:
                    chat = None
                if chat:
                    await hub.send_many([m for m in chat.member_ids if m != user.id],
                                        {"type": "typing", "chat_id": chat.id, "user_id": user.id,
                                         "name": user.display_name})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.info(f"ws closed: {e}")
    finally:
        hub.remove(user.id, ws)


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=False, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def startup():
    await db.users.create_index("username", unique=True)
    await db.chats.create_index([("member_ids", 1), ("updated_at", -1)])
    await db.messages.create_index([("chat_id", 1), ("created_at", 1)])
    await db.messages.create_index([("chat_id", 1), ("expires_at", 1)])
    await db.login_failures.create_index([("username", 1), ("at", 1)])
    await db.attachments.create_index([("chat_id", 1), ("expires_at", 1)])
    try:
        await run_in_threadpool(init_storage)
        logger.info("Object storage ready")
    except Exception as e:
        logger.warning(f"Object storage init failed: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
