"""CipherChat backend.

The server is a "blind relay": it only ever stores public keys, an encrypted
key vault (sealed client-side with a password-derived key the server never
sees) and message ciphertext. It cannot read any message content.
"""
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Dict, List, Literal, Optional

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
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
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)


class Message(BaseDocument):
    chat_id: str
    sender_id: str
    ciphertext: str
    nonce: str
    epk: str
    keys: Dict[str, Dict[str, str]]
    sig: str
    ttl: int = 0
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


# --------------------------------------------------------------- helpers ----
def public_user(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name,
            "box_pub": u.box_pub, "sign_pub": u.sign_pub}


def me_user(u: User) -> dict:
    return {**public_user(u), "vault": u.vault, "vault_nonce": u.vault_nonce}


def message_out(m: Message, viewer_id: str) -> dict:
    return {"id": m.id, "chat_id": m.chat_id, "sender_id": m.sender_id,
            "ciphertext": m.ciphertext, "nonce": m.nonce, "epk": m.epk,
            "key": m.keys.get(viewer_id), "sig": m.sig, "ttl": m.ttl,
            "created_at": iso(m.created_at), "expires_at": iso(m.expires_at)}


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
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG], issuer=JWT_ISS, audience=JWT_AUD)
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


async def chat_out(chat: Chat, viewer: User, members: Optional[Dict[str, User]] = None) -> dict:
    members = members or await users_by_ids(chat.member_ids)
    last = Message.from_mongo(await db.messages.find_one(
        {"chat_id": chat.id, **not_expired()}, sort=[("created_at", -1)]))
    return {"id": chat.id, "type": chat.type, "name": chat.name, "created_by": chat.created_by,
            "disappear_seconds": chat.disappear_seconds,
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
    return [await chat_out(c, user, members) for c in chats]


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
    return await chat_out(chat, user)


@api.get("/chats/{chat_id}/messages")
async def list_messages(chat_id: str, user: CurrentUser, after: Optional[str] = None):
    chat = await get_member_chat(chat_id, user)
    query: Dict[str, Any] = {"chat_id": chat.id, **not_expired()}
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
                  created_at=created, expires_at=created + timedelta(seconds=ttl) if ttl else None)
    res = await db.messages.insert_one(msg.to_mongo())
    msg.id = str(res.inserted_id)
    await db.chats.update_one({"_id": ObjectId(chat.id)}, {"$set": {"updated_at": created}})
    return message_out(msg, user.id)


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_credentials=False, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def startup():
    await db.users.create_index("username", unique=True)
    await db.chats.create_index([("member_ids", 1), ("updated_at", -1)])
    await db.messages.create_index([("chat_id", 1), ("created_at", 1)])
    await db.messages.create_index("expires_at", expireAfterSeconds=0)
    await db.login_failures.create_index("at", expireAfterSeconds=int(LOCK_WINDOW.total_seconds()))


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
