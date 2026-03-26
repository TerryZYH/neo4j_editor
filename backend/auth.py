import sqlite3
import os
from pathlib import Path
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from passlib.context import CryptContext
from jose import jwt, JWTError

SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production-please")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24 * 7  # 1 week

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()
DB_PATH = Path(__file__).parent / "users.db"


# ── DB init ────────────────────────────────────────────────────────────────────

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT UNIQUE NOT NULL,
                email      TEXT UNIQUE NOT NULL,
                hashed_pw  TEXT NOT NULL,
                role       TEXT NOT NULL DEFAULT 'user',
                is_active  INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.commit()


# ── DB helpers ─────────────────────────────────────────────────────────────────

def _row(conn, sql, *params):
    conn.row_factory = sqlite3.Row
    return conn.execute(sql, params).fetchone()

def get_by_username(username: str):
    with sqlite3.connect(DB_PATH) as conn:
        r = _row(conn, "SELECT * FROM users WHERE username = ?", username)
        return dict(r) if r else None

def get_by_id(user_id: int):
    with sqlite3.connect(DB_PATH) as conn:
        r = _row(conn, "SELECT * FROM users WHERE id = ?", user_id)
        return dict(r) if r else None

def count_users() -> int:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


# ── JWT ────────────────────────────────────────────────────────────────────────

def create_token(user_id: int, username: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    return jwt.encode(
        {"sub": str(user_id), "username": username, "role": role, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM,
    )

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    return decode_token(creds.credentials)

def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


# ── Request models ─────────────────────────────────────────────────────────────

class RegisterReq(BaseModel):
    username: str
    email: str
    password: str

class LoginReq(BaseModel):
    username: str
    password: str


# ── Router ─────────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
def register(data: RegisterReq):
    if len(data.username.strip()) < 2:
        raise HTTPException(400, "用户名至少 2 个字符")
    if len(data.password) < 6:
        raise HTTPException(400, "密码至少 6 个字符")

    # First registered user becomes admin automatically
    role = "admin" if count_users() == 0 else "user"
    hashed = pwd_context.hash(data.password)

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO users (username, email, hashed_pw, role) VALUES (?, ?, ?, ?)",
                (data.username.strip(), data.email.strip(), hashed, role),
            )
            conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名或邮箱已存在")

    u = get_by_username(data.username.strip())
    return {"token": create_token(u["id"], u["username"], u["role"]),
            "username": u["username"], "role": u["role"]}


@router.post("/login")
def login(data: LoginReq):
    u = get_by_username(data.username)
    if not u or not pwd_context.verify(data.password, u["hashed_pw"]):
        raise HTTPException(401, "用户名或密码错误")
    if not u["is_active"]:
        raise HTTPException(403, "账号已被禁用")
    return {"token": create_token(u["id"], u["username"], u["role"]),
            "username": u["username"], "role": u["role"]}


@router.get("/me")
def get_me(user: dict = Depends(get_current_user)):
    return user
