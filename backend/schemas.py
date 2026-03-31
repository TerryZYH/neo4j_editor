import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List

from auth import get_current_user

_data_dir = Path(os.getenv("DATA_DIR", str(Path(__file__).parent)))
SCHEMA_DB_PATH = _data_dir / "schemas.db"


# ── DB init ────────────────────────────────────────────────────────────────────

def init_schema_db():
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS property_schemas (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type   TEXT NOT NULL DEFAULT 'node',
                entity_label  TEXT NOT NULL,
                prop_key      TEXT NOT NULL,
                prop_type     TEXT NOT NULL DEFAULT 'string',
                is_id         INTEGER DEFAULT 0,
                enum_values   TEXT NOT NULL DEFAULT '[]',
                regex_pattern TEXT,
                required      INTEGER DEFAULT 0,
                default_val   TEXT,
                description   TEXT,
                created_by    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                UNIQUE(entity_type, entity_label, prop_key)
            )
        """)
        # Migrate existing DBs: add new columns if missing
        for col_def in [
            "prop_type TEXT NOT NULL DEFAULT 'string'",
            "is_id INTEGER DEFAULT 0",
            "regex_pattern TEXT",
        ]:
            try:
                conn.execute(f"ALTER TABLE property_schemas ADD COLUMN {col_def}")
            except sqlite3.OperationalError:
                pass  # column already exists
        conn.commit()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["enum_values"] = json.loads(d["enum_values"])
    d["required"] = bool(d["required"])
    d["is_id"] = bool(d.get("is_id", 0))
    d["prop_type"] = d.get("prop_type") or "string"
    return d


# ── Models ─────────────────────────────────────────────────────────────────────

VALID_PROP_TYPES = {"string", "number", "boolean", "date", "list"}

class SchemaCreate(BaseModel):
    entity_type:   str = "node"          # "node" or "edge"
    entity_label:  str                   # label / rel-type / "*"
    prop_key:      str
    prop_type:     str = "string"        # string | number | boolean | date
    is_id:         bool = False
    enum_values:   List[str] = []
    regex_pattern: Optional[str] = None
    required:      bool = False
    default_val:   Optional[str] = None
    description:   Optional[str] = None

class SchemaUpdate(BaseModel):
    prop_type:     Optional[str] = None
    is_id:         Optional[bool] = None
    enum_values:   Optional[List[str]] = None
    regex_pattern: Optional[str] = None
    required:      Optional[bool] = None
    default_val:   Optional[str] = None
    description:   Optional[str] = None


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
    if data.prop_type not in VALID_PROP_TYPES:
        raise HTTPException(400, f"prop_type 必须是 {'/'.join(VALID_PROP_TYPES)}")

    now = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(SCHEMA_DB_PATH) as conn:
            conn.execute(
                """INSERT INTO property_schemas
                   (entity_type, entity_label, prop_key, prop_type, is_id,
                    enum_values, regex_pattern, required, default_val, description,
                    created_by, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    data.entity_type,
                    data.entity_label.strip(),
                    data.prop_key.strip(),
                    data.prop_type,
                    1 if data.is_id else 0,
                    json.dumps(data.enum_values, ensure_ascii=False),
                    data.regex_pattern or None,
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
    if data.prop_type is not None:
        if data.prop_type not in VALID_PROP_TYPES:
            raise HTTPException(400, f"prop_type 必须是 {'/'.join(VALID_PROP_TYPES)}")
        updates.append("prop_type = ?"); params.append(data.prop_type)
    if data.is_id is not None:
        updates.append("is_id = ?"); params.append(1 if data.is_id else 0)
    if data.enum_values is not None:
        updates.append("enum_values = ?")
        params.append(json.dumps(data.enum_values, ensure_ascii=False))
    if data.regex_pattern is not None:
        updates.append("regex_pattern = ?"); params.append(data.regex_pattern or None)
    if data.required is not None:
        updates.append("required = ?"); params.append(1 if data.required else 0)
    if data.default_val is not None:
        updates.append("default_val = ?"); params.append(data.default_val)
    if data.description is not None:
        updates.append("description = ?"); params.append(data.description)
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
