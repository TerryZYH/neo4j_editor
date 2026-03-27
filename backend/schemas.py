import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List

from auth import get_current_user

SCHEMA_DB_PATH = Path(__file__).parent / "schemas.db"


# ── DB init ────────────────────────────────────────────────────────────────────

def init_schema_db():
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS property_schemas (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type  TEXT NOT NULL DEFAULT 'node',
                entity_label TEXT NOT NULL,
                prop_key     TEXT NOT NULL,
                enum_values  TEXT NOT NULL DEFAULT '[]',
                required     INTEGER DEFAULT 0,
                default_val  TEXT,
                description  TEXT,
                created_by   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                UNIQUE(entity_type, entity_label, prop_key)
            )
        """)
        conn.commit()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["enum_values"] = json.loads(d["enum_values"])
    d["required"] = bool(d["required"])
    return d


# ── Models ─────────────────────────────────────────────────────────────────────

class SchemaCreate(BaseModel):
    entity_type:  str = "node"          # "node" or "edge"
    entity_label: str                   # label / rel-type / "*"
    prop_key:     str                   # property key or "__rel_type__"
    enum_values:  List[str] = []
    required:     bool = False
    default_val:  Optional[str] = None
    description:  Optional[str] = None

class SchemaUpdate(BaseModel):
    enum_values: Optional[List[str]] = None
    required:    Optional[bool] = None
    default_val: Optional[str] = None
    description: Optional[str] = None


# ── Router ─────────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/schemas", tags=["schemas"])


@router.get("")
def list_schemas(
    entity_type:  Optional[str] = None,
    entity_label: Optional[str] = None,
    user=Depends(get_current_user),
):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        sql, params = "SELECT * FROM property_schemas WHERE 1=1", []
        if entity_type:
            sql += " AND entity_type = ?"
            params.append(entity_type)
        if entity_label:
            sql += " AND (entity_label = ? OR entity_label = '*')"
            params.append(entity_label)
        sql += " ORDER BY entity_type, entity_label, prop_key"
        return [_to_dict(r) for r in conn.execute(sql, params).fetchall()]


@router.post("", status_code=201)
def create_schema(data: SchemaCreate, user=Depends(get_current_user)):
    if data.entity_type not in ("node", "edge"):
        raise HTTPException(400, "entity_type 必须是 node 或 edge")
    if not data.entity_label.strip():
        raise HTTPException(400, "entity_label 不能为空")
    if not data.prop_key.strip():
        raise HTTPException(400, "prop_key 不能为空")

    now = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(SCHEMA_DB_PATH) as conn:
            conn.execute(
                """INSERT INTO property_schemas
                   (entity_type, entity_label, prop_key, enum_values,
                    required, default_val, description, created_by, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    data.entity_type,
                    data.entity_label.strip(),
                    data.prop_key.strip(),
                    json.dumps(data.enum_values, ensure_ascii=False),
                    1 if data.required else 0,
                    data.default_val,
                    data.description,
                    user["username"],
                    now,
                ),
            )
            conn.commit()
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT * FROM property_schemas WHERE rowid = last_insert_rowid()"
            ).fetchone()
            return _to_dict(row)
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该 (entity_type, entity_label, prop_key) 组合已存在")


@router.put("/{schema_id}")
def update_schema(schema_id: int, data: SchemaUpdate, user=Depends(get_current_user)):
    now = datetime.now(timezone.utc).isoformat()
    updates, params = [], []
    if data.enum_values is not None:
        updates.append("enum_values = ?")
        params.append(json.dumps(data.enum_values, ensure_ascii=False))
    if data.required is not None:
        updates.append("required = ?")
        params.append(1 if data.required else 0)
    if data.default_val is not None:
        updates.append("default_val = ?")
        params.append(data.default_val)
    if data.description is not None:
        updates.append("description = ?")
        params.append(data.description)
    if not updates:
        raise HTTPException(400, "无可更新字段")
    updates.append("updated_at = ?")
    params.append(now)
    params.append(schema_id)

    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(
            f"UPDATE property_schemas SET {', '.join(updates)} WHERE id = ?", params
        )
        conn.commit()
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM property_schemas WHERE id = ?", (schema_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Schema 不存在")
        return _to_dict(row)


@router.delete("/{schema_id}")
def delete_schema(schema_id: int, user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM property_schemas WHERE id = ?", (schema_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Schema 不存在")
        row = _to_dict(row)
        if row["created_by"] != user["username"] and user.get("role") != "admin":
            raise HTTPException(403, "只有创建者或管理员可以删除")
        conn.execute("DELETE FROM property_schemas WHERE id = ?", (schema_id,))
        conn.commit()
    return {"ok": True}
