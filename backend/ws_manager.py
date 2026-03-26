from fastapi import WebSocket
from typing import Dict, Optional
from datetime import datetime

LOCK_TTL_SECONDS = 60  # Auto-release locks after 60s of inactivity


class WSManager:
    COLORS = [
        "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
        "#9b59b6", "#1abc9c", "#e67e22", "#e91e63",
        "#00bcd4", "#ff5722",
    ]

    def __init__(self):
        self._sockets: Dict[str, WebSocket] = {}   # user_id -> ws
        self._users: Dict[str, dict] = {}           # user_id -> user info
        self._locks: Dict[str, dict] = {}           # entity_id -> lock info

    def _color(self, user_id: str) -> str:
        return self.COLORS[abs(hash(user_id)) % len(self.COLORS)]

    # ── Connection lifecycle ───────────────────────────────────────────────────

    async def connect(self, ws: WebSocket, user_id: str, username: str):
        await ws.accept()
        self._sockets[user_id] = ws
        self._users[user_id] = {
            "user_id": user_id,
            "username": username,
            "color": self._color(user_id),
        }
        # Send current state to the new user
        await ws.send_json({
            "type": "init",
            "users": list(self._users.values()),
            "locks": self._locks,
        })
        # Announce arrival to others
        await self.broadcast(
            {"type": "user_joined", "user": self._users[user_id]},
            exclude=user_id,
        )

    async def disconnect(self, user_id: str):
        self._sockets.pop(user_id, None)
        self._users.pop(user_id, None)
        released = [eid for eid, lk in list(self._locks.items()) if lk["user_id"] == user_id]
        for eid in released:
            del self._locks[eid]
        await self.broadcast({"type": "user_left", "user_id": user_id})
        for eid in released:
            await self.broadcast({"type": "entity_unlocked", "entity_id": eid})

    # ── Broadcast ──────────────────────────────────────────────────────────────

    async def broadcast(self, msg: dict, exclude: Optional[str] = None):
        dead = []
        for uid, ws in list(self._sockets.items()):
            if uid == exclude:
                continue
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(uid)
        for uid in dead:
            await self.disconnect(uid)

    # ── Lock management ────────────────────────────────────────────────────────

    def _purge_expired(self):
        now = datetime.utcnow()
        expired = [
            eid for eid, lk in list(self._locks.items())
            if (now - datetime.fromisoformat(lk["locked_at"])).total_seconds() > LOCK_TTL_SECONDS
        ]
        for eid in expired:
            del self._locks[eid]
        return expired

    def try_lock(self, entity_id: str, user_id: str, username: str) -> bool:
        self._purge_expired()
        existing = self._locks.get(entity_id)
        if existing and existing["user_id"] != user_id:
            return False
        self._locks[entity_id] = {
            "entity_id": entity_id,
            "user_id": user_id,
            "username": username,
            "color": self._color(user_id),
            "locked_at": datetime.utcnow().isoformat(),
        }
        return True

    def release_lock(self, entity_id: str, user_id: str) -> bool:
        lk = self._locks.get(entity_id)
        if lk and lk["user_id"] == user_id:
            del self._locks[entity_id]
            return True
        return False

    def force_release(self, entity_id: str):
        self._locks.pop(entity_id, None)

    def heartbeat(self, user_id: str):
        """Refresh TTL for all locks held by this user."""
        now = datetime.utcnow().isoformat()
        for lk in self._locks.values():
            if lk["user_id"] == user_id:
                lk["locked_at"] = now

    def get_lock(self, entity_id: str) -> Optional[dict]:
        return self._locks.get(entity_id)

    # ── State accessors ────────────────────────────────────────────────────────

    def active_users(self):
        return list(self._users.values())

    def active_locks(self):
        return list(self._locks.values())


manager = WSManager()
