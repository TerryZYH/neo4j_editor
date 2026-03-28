import sqlite3
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

from auth import get_current_user, require_admin
from schemas import SCHEMA_DB_PATH


# ── DB init ────────────────────────────────────────────────────────────────────

def init_ontology_db():
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS class_schemas (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                label_name   TEXT UNIQUE NOT NULL,
                display_name TEXT,
                description  TEXT,
                color        TEXT DEFAULT '#4C8EDA',
                icon         TEXT DEFAULT '⬡',
                created_by   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS relation_schemas (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                rel_type      TEXT NOT NULL,
                source_label  TEXT NOT NULL,
                target_label  TEXT NOT NULL,
                display_name  TEXT,
                description   TEXT,
                created_by    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                UNIQUE(rel_type, source_label, target_label)
            );
            CREATE TABLE IF NOT EXISTS ontology_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        conn.execute("INSERT OR IGNORE INTO ontology_config VALUES ('validation_mode', 'warn')")
        conn.commit()


# ── Validation helpers (imported by main.py) ──────────────────────────────────

def get_validation_mode() -> str:
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        row = conn.execute(
            "SELECT value FROM ontology_config WHERE key='validation_mode'"
        ).fetchone()
        return row[0] if row else "warn"


def validate_node_labels(labels: list) -> tuple:
    """Returns (is_valid, error_message)."""
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        if not conn.execute("SELECT COUNT(*) FROM class_schemas").fetchone()[0]:
            return True, ""
        for lbl in labels:
            if not conn.execute(
                "SELECT id FROM class_schemas WHERE label_name=?", (lbl,)
            ).fetchone():
                return False, f"标签「{lbl}」未在本体中定义"
    return True, ""


def validate_relation_triple(src_labels: list, rel_type: str, tgt_labels: list) -> tuple:
    """Returns (is_valid, error_message)."""
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        if not conn.execute("SELECT COUNT(*) FROM relation_schemas").fetchone()[0]:
            return True, ""
        for src in src_labels:
            for tgt in tgt_labels:
                if conn.execute(
                    """SELECT id FROM relation_schemas
                       WHERE rel_type=?
                       AND (source_label=? OR source_label='*')
                       AND (target_label=? OR target_label='*')""",
                    (rel_type, src, tgt),
                ).fetchone():
                    return True, ""
    return False, f"关系 ({'/'.join(src_labels)})-[{rel_type}]->({'/'.join(tgt_labels)}) 未在本体中定义"


# ── Models ─────────────────────────────────────────────────────────────────────

class ClassCreate(BaseModel):
    label_name:   str
    display_name: Optional[str] = None
    description:  Optional[str] = None
    color:        str = "#4C8EDA"
    icon:         str = "⬡"

class ClassUpdate(BaseModel):
    display_name: Optional[str] = None
    description:  Optional[str] = None
    color:        Optional[str] = None
    icon:         Optional[str] = None

class RelationCreate(BaseModel):
    rel_type:     str
    source_label: str
    target_label: str
    display_name: Optional[str] = None
    description:  Optional[str] = None

class RelationUpdate(BaseModel):
    display_name: Optional[str] = None
    description:  Optional[str] = None

class ConfigUpdate(BaseModel):
    validation_mode: str   # "warn" or "strict"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _row(conn, sql, *params):
    conn.row_factory = sqlite3.Row
    r = conn.execute(sql, params).fetchone()
    return dict(r) if r else None

def _rows(conn, sql, *params):
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, params).fetchall()]

def _now():
    return datetime.now(timezone.utc).isoformat()


# ── Router ─────────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/ontology", tags=["ontology"])


# Full TBox export (used by frontend to cache everything at once)
@router.get("")
def get_ontology(user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        classes   = _rows(conn, "SELECT * FROM class_schemas ORDER BY label_name")
        relations = _rows(conn, "SELECT * FROM relation_schemas ORDER BY rel_type, source_label")
        mode_row  = conn.execute(
            "SELECT value FROM ontology_config WHERE key='validation_mode'"
        ).fetchone()
        return {
            "classes":         classes,
            "relations":       relations,
            "validation_mode": mode_row[0] if mode_row else "warn",
        }


# ── Class schemas ──────────────────────────────────────────────────────────────

@router.get("/classes")
def list_classes(user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        return _rows(conn, "SELECT * FROM class_schemas ORDER BY label_name")


@router.post("/classes", status_code=201)
def create_class(data: ClassCreate, user=Depends(get_current_user)):
    if not data.label_name.strip():
        raise HTTPException(400, "label_name 不能为空")
    try:
        with sqlite3.connect(SCHEMA_DB_PATH) as conn:
            conn.execute(
                """INSERT INTO class_schemas
                   (label_name, display_name, description, color, icon, created_by, updated_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (data.label_name.strip(), data.display_name, data.description,
                 data.color, data.icon, user["username"], _now()),
            )
            conn.commit()
            return _row(conn, "SELECT * FROM class_schemas WHERE rowid=last_insert_rowid()")
    except sqlite3.IntegrityError:
        raise HTTPException(400, f"标签「{data.label_name}」已存在")


@router.put("/classes/{cid}")
def update_class(cid: int, data: ClassUpdate, user=Depends(get_current_user)):
    updates, params = [], []
    if data.display_name is not None: updates.append("display_name=?"); params.append(data.display_name)
    if data.description  is not None: updates.append("description=?");  params.append(data.description)
    if data.color        is not None: updates.append("color=?");         params.append(data.color)
    if data.icon         is not None: updates.append("icon=?");          params.append(data.icon)
    if not updates:
        raise HTTPException(400, "无可更新字段")
    updates.append("updated_at=?"); params.append(_now()); params.append(cid)
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(f"UPDATE class_schemas SET {','.join(updates)} WHERE id=?", params)
        conn.commit()
        row = _row(conn, "SELECT * FROM class_schemas WHERE id=?", cid)
        if not row: raise HTTPException(404, "Class 不存在")
        return row


@router.delete("/classes/{cid}")
def delete_class(cid: int, user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        if not _row(conn, "SELECT id FROM class_schemas WHERE id=?", cid):
            raise HTTPException(404, "Class 不存在")
        # Cascade: remove relation_schemas that reference this class
        row = _row(conn, "SELECT label_name FROM class_schemas WHERE id=?", cid)
        lbl = row["label_name"]
        conn.execute(
            "DELETE FROM relation_schemas WHERE source_label=? OR target_label=?", (lbl, lbl)
        )
        conn.execute("DELETE FROM class_schemas WHERE id=?", (cid,))
        conn.commit()
    return {"ok": True}


# ── Relation schemas ───────────────────────────────────────────────────────────

@router.get("/relations")
def list_relations(user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        return _rows(conn, "SELECT * FROM relation_schemas ORDER BY rel_type, source_label")


@router.post("/relations", status_code=201)
def create_relation(data: RelationCreate, user=Depends(get_current_user)):
    if not data.rel_type.strip():     raise HTTPException(400, "rel_type 不能为空")
    if not data.source_label.strip(): raise HTTPException(400, "source_label 不能为空")
    if not data.target_label.strip(): raise HTTPException(400, "target_label 不能为空")
    try:
        with sqlite3.connect(SCHEMA_DB_PATH) as conn:
            conn.execute(
                """INSERT INTO relation_schemas
                   (rel_type, source_label, target_label, display_name, description, created_by, updated_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (data.rel_type.strip(), data.source_label.strip(), data.target_label.strip(),
                 data.display_name, data.description, user["username"], _now()),
            )
            conn.commit()
            return _row(conn, "SELECT * FROM relation_schemas WHERE rowid=last_insert_rowid()")
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该关系三元组已存在")


@router.put("/relations/{rid}")
def update_relation(rid: int, data: RelationUpdate, user=Depends(get_current_user)):
    updates, params = [], []
    if data.display_name is not None: updates.append("display_name=?"); params.append(data.display_name)
    if data.description  is not None: updates.append("description=?");  params.append(data.description)
    if not updates:
        raise HTTPException(400, "无可更新字段")
    updates.append("updated_at=?"); params.append(_now()); params.append(rid)
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(f"UPDATE relation_schemas SET {','.join(updates)} WHERE id=?", params)
        conn.commit()
        row = _row(conn, "SELECT * FROM relation_schemas WHERE id=?", rid)
        if not row: raise HTTPException(404, "Relation 不存在")
        return row


@router.delete("/relations/{rid}")
def delete_relation(rid: int, user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        if not _row(conn, "SELECT id FROM relation_schemas WHERE id=?", rid):
            raise HTTPException(404, "Relation 不存在")
        conn.execute("DELETE FROM relation_schemas WHERE id=?", (rid,))
        conn.commit()
    return {"ok": True}


# ── Config ────────────────────────────────────────────────────────────────────

@router.get("/config")
def get_config(user=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        rows = _rows(conn, "SELECT key, value FROM ontology_config")
        return {r["key"]: r["value"] for r in rows}


@router.put("/config")
def update_config(data: ConfigUpdate, user=Depends(require_admin)):
    if data.validation_mode not in ("warn", "strict"):
        raise HTTPException(400, "validation_mode 必须是 warn 或 strict")
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO ontology_config VALUES ('validation_mode', ?)",
            (data.validation_mode,),
        )
        conn.commit()
    return {"validation_mode": data.validation_mode}
