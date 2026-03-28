import sqlite3
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

from auth import require_admin, DB_PATH, pwd_context
from ws_manager import manager as ws

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _all_users():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, username, email, role, is_active, created_at FROM users ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


# ── Models ─────────────────────────────────────────────────────────────────────

class CreateUserReq(BaseModel):
    username: str
    email: str
    password: str
    role: str = "user"

class UpdateUserReq(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None


# ── User management ────────────────────────────────────────────────────────────

@router.get("/users")
def list_users(_=Depends(require_admin)):
    return _all_users()


@router.post("/users", status_code=201)
def create_user(data: CreateUserReq, _=Depends(require_admin)):
    if len(data.username.strip()) < 2:
        raise HTTPException(400, "用户名至少 2 个字符")
    if len(data.password) < 6:
        raise HTTPException(400, "密码至少 6 个字符")
    if data.role not in ("user", "admin"):
        raise HTTPException(400, "role 必须是 user 或 admin")
    hashed = pwd_context.hash(data.password)
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO users (username, email, hashed_pw, role) VALUES (?, ?, ?, ?)",
                (data.username.strip(), data.email.strip(), hashed, data.role),
            )
            conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名或邮箱已存在")
    return {"ok": True}


@router.put("/users/{user_id}")
def update_user(user_id: int, data: UpdateUserReq, admin=Depends(require_admin)):
    updates, params = [], []
    if data.role is not None:
        if data.role not in ("user", "admin"):
            raise HTTPException(400, "role 必须是 user 或 admin")
        updates.append("role = ?")
        params.append(data.role)
    if data.is_active is not None:
        updates.append("is_active = ?")
        params.append(1 if data.is_active else 0)
    if data.password is not None:
        if len(data.password) < 6:
            raise HTTPException(400, "密码至少 6 个字符")
        updates.append("hashed_pw = ?")
        params.append(pwd_context.hash(data.password))
    if not updates:
        raise HTTPException(400, "无可更新字段")
    params.append(user_id)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, admin=Depends(require_admin)):
    if str(user_id) == admin.get("sub"):
        raise HTTPException(400, "不能删除自己的账号")
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    return {"ok": True}


# ── Sessions & locks ───────────────────────────────────────────────────────────

@router.get("/sessions")
def get_sessions(_=Depends(require_admin)):
    return ws.active_users()


@router.get("/locks")
def get_locks(_=Depends(require_admin)):
    return ws.active_locks()


@router.delete("/locks/{entity_id}")
async def force_unlock(entity_id: str, _=Depends(require_admin)):
    ws.force_release(entity_id)
    await ws.broadcast({"type": "entity_unlocked", "entity_id": entity_id})
    return {"ok": True}


# ── Workspaces overview ────────────────────────────────────────────────────────

@router.get("/workspaces")
def list_all_workspaces(_=Depends(require_admin)):
    """Admin view: all workspaces across all users."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT w.id, w.name, w.created_at, w.updated_at,
                      u.username AS owner,
                      (SELECT COUNT(*) FROM workspace_nodes wn
                       WHERE wn.workspace_id = w.id) AS node_count
               FROM workspaces w
               JOIN users u ON u.id = w.owner_id
               ORDER BY w.updated_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]
