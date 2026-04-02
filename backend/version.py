import sqlite3
import json
from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_current_user, require_admin
from schemas import SCHEMA_DB_PATH
from graph_db import get_driver, serialize_node, serialize_rel
from ws_manager import manager


router = APIRouter(prefix="/api/version", tags=["version"])


# ── DB init ────────────────────────────────────────────────────────────────────

def init_version_db():
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS operations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                summary     TEXT NOT NULL,
                user_id     TEXT NOT NULL,
                username    TEXT NOT NULL,
                operated_at TEXT NOT NULL,
                changes     TEXT NOT NULL,
                is_undo     INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Migrate existing tables that lack is_undo / undone
        for col_sql in [
            "ALTER TABLE operations ADD COLUMN is_undo INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE operations ADD COLUMN undone   INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(col_sql)
            except Exception:
                pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS checkpoints (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                name             TEXT NOT NULL,
                description      TEXT,
                created_by       TEXT NOT NULL,
                created_at       TEXT NOT NULL,
                graph_snapshot   TEXT NOT NULL,
                schemas_snapshot TEXT NOT NULL
            )
        """)
        conn.commit()


# ── Auto-checkpoint ────────────────────────────────────────────────────────────

def auto_checkpoint():
    """Create a daily auto-checkpoint before the first write of the day (lazy)."""
    today = datetime.now(timezone.utc).date().isoformat()
    name = f"自动存档 {today}"
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        row = conn.execute(
            "SELECT id FROM checkpoints WHERE name=?", (name,)
        ).fetchone()
        if row:
            return  # Already created today
    # Take snapshot and persist
    graph, schemas = _take_snapshot()
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(
            """INSERT OR IGNORE INTO checkpoints
               (name, description, created_by, created_at, graph_snapshot, schemas_snapshot)
               VALUES (?,?,?,?,?,?)""",
            (name, "系统自动存档", "system", now,
             json.dumps(graph, ensure_ascii=False),
             json.dumps(schemas, ensure_ascii=False)),
        )
        conn.commit()


# ── Operation log ──────────────────────────────────────────────────────────────

def log_operation(summary: str, changes: list, user_id: str, username: str, is_undo: bool = False):
    """Record one user operation (may contain multiple entity changes)."""
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(
            """INSERT INTO operations (summary, user_id, username, operated_at, changes, is_undo)
               VALUES (?,?,?,?,?,?)""",
            (summary, user_id, username,
             datetime.now(timezone.utc).isoformat(),
             json.dumps(changes, ensure_ascii=False),
             1 if is_undo else 0),
        )
        conn.commit()


# ── Snapshot helpers ───────────────────────────────────────────────────────────

def _take_snapshot() -> tuple:
    drv = get_driver()
    nodes: dict = {}
    edges:  dict = {}
    with drv.session() as session:
        for rec in session.run("MATCH (n) RETURN n"):
            n = rec["n"]
            nodes[n.element_id] = serialize_node(n)
        for rec in session.run("MATCH (a)-[r]->(b) RETURN a, r, b"):
            a, r, b = rec["a"], rec["r"], rec["b"]
            for nd in (a, b):
                if nd.element_id not in nodes:
                    nodes[nd.element_id] = serialize_node(nd)
            if r.element_id not in edges:
                edges[r.element_id] = serialize_rel(r, a.element_id, b.element_id)
    graph = {"nodes": list(nodes.values()), "edges": list(edges.values())}

    schemas: dict = {}
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        schemas["property_schemas"] = [dict(r) for r in conn.execute("SELECT * FROM property_schemas")]
        schemas["class_schemas"]    = [dict(r) for r in conn.execute("SELECT * FROM class_schemas")]
        schemas["relation_schemas"] = [dict(r) for r in conn.execute("SELECT * FROM relation_schemas")]
        schemas["ontology_config"]  = {
            r[0]: r[1] for r in conn.execute("SELECT key, value FROM ontology_config")
        }
    return graph, schemas


def _apply_snapshot(graph: dict, schemas: dict, admin_username: str):
    """Destructive restore — mirrors /api/import logic."""
    drv = get_driver()
    id_map: dict = {}
    with drv.session() as session:
        session.run("MATCH (n) DETACH DELETE n")
        for node in graph.get("nodes", []):
            labels = node.get("labels") or ["Node"]
            labels_str = ":".join(f"`{l}`" for l in labels)
            rec = session.run(
                f"CREATE (n:{labels_str} $props) RETURN elementId(n) AS eid",
                props=node.get("properties", {}),
            ).single()
            if rec:
                id_map[node["id"]] = rec["eid"]
        for edge in graph.get("edges", []):
            src = id_map.get(edge.get("source", ""))
            tgt = id_map.get(edge.get("target", ""))
            if not src or not tgt:
                continue
            rel_type = (edge.get("type") or "RELATES_TO").replace("`", "")
            session.run(
                f"MATCH (a),(b) WHERE elementId(a)=$src AND elementId(b)=$tgt "
                f"CREATE (a)-[r:`{rel_type}` $props]->(b)",
                src=src, tgt=tgt, props=edge.get("properties", {}),
            )

    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("DELETE FROM property_schemas")
        conn.execute("DELETE FROM class_schemas")
        conn.execute("DELETE FROM relation_schemas")
        for r in schemas.get("property_schemas", []):
            conn.execute(
                "INSERT OR IGNORE INTO property_schemas "
                "(entity_type,entity_label,prop_key,prop_type,is_id,enum_values,"
                " regex_pattern,required,default_val,description,created_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (r.get("entity_type","node"), r["entity_label"], r["prop_key"],
                 r.get("prop_type","string"), r.get("is_id",0),
                 r.get("enum_values","[]") if isinstance(r.get("enum_values"), str)
                     else json.dumps(r.get("enum_values",[])),
                 r.get("regex_pattern"), r.get("required",0),
                 r.get("default_val"), r.get("description"),
                 r.get("created_by", admin_username), r.get("updated_at", now)),
            )
        for r in schemas.get("class_schemas", []):
            conn.execute(
                "INSERT OR IGNORE INTO class_schemas "
                "(label_name,display_name,description,color,icon,created_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (r["label_name"], r.get("display_name"), r.get("description"),
                 r.get("color","#4C8EDA"), r.get("icon","⬡"),
                 r.get("created_by", admin_username), r.get("updated_at", now)),
            )
        for r in schemas.get("relation_schemas", []):
            conn.execute(
                "INSERT OR IGNORE INTO relation_schemas "
                "(rel_type,source_label,target_label,display_name,description,created_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (r["rel_type"], r["source_label"], r["target_label"],
                 r.get("display_name"), r.get("description"),
                 r.get("created_by", admin_username), r.get("updated_at", now)),
            )
        for key, value in schemas.get("ontology_config", {}).items():
            conn.execute(
                "INSERT OR REPLACE INTO ontology_config (key,value) VALUES (?,?)", (key, value)
            )
        conn.commit()


# ── Models ─────────────────────────────────────────────────────────────────────

class CheckpointCreate(BaseModel):
    name: str
    description: Optional[str] = None


# ── Undo helper ────────────────────────────────────────────────────────────────

def _undo_changes(session, changes: list) -> tuple[list, dict]:
    """
    Apply reverse of each change in reverse order.
    Returns (undo_changes_log, id_map) where id_map maps old_id -> new_id
    for any nodes that were re-created.
    """
    id_map: dict = {}   # old element_id → new element_id (for re-created nodes)
    undo_log = []

    for change in reversed(changes):
        op          = change["op"]
        entity_id   = change["entity_id"]
        before      = change.get("before")
        after       = change.get("after")

        if op == "update_node" and before is not None:
            cur = session.run(
                "MATCH (n) WHERE elementId(n)=$id RETURN labels(n) AS lbls", id=entity_id
            ).single()
            if cur:
                for lbl in cur["lbls"]:
                    session.run(f"MATCH (n) WHERE elementId(n)=$id REMOVE n:`{lbl}`", id=entity_id)
                for lbl in before.get("labels", []):
                    session.run(f"MATCH (n) WHERE elementId(n)=$id SET n:`{lbl}`", id=entity_id)
                session.run(
                    "MATCH (n) WHERE elementId(n)=$id SET n=$props",
                    id=entity_id, props=before.get("properties", {}),
                )
                rec = session.run("MATCH (n) WHERE elementId(n)=$id RETURN n", id=entity_id).single()
                if rec:
                    undo_log.append({"op": "update_node", "entity_type": "node",
                                     "entity_id": entity_id, "before": after, "after": before})

        elif op == "delete_node" and before is not None:
            labels = before.get("labels") or ["Node"]
            labels_str = ":".join(f"`{l}`" for l in labels)
            rec = session.run(
                f"CREATE (n:{labels_str} $props) RETURN elementId(n) AS eid",
                props=before.get("properties", {}),
            ).single()
            if rec:
                new_id = rec["eid"]
                id_map[entity_id] = new_id
                undo_log.append({"op": "create_node", "entity_type": "node",
                                 "entity_id": new_id, "before": None, "after": before})

        elif op == "create_node":
            cur_id = id_map.get(entity_id, entity_id)
            session.run("MATCH (n) WHERE elementId(n)=$id DETACH DELETE n", id=cur_id)
            undo_log.append({"op": "delete_node", "entity_type": "node",
                             "entity_id": cur_id, "before": after, "after": None})

        elif op == "update_edge" and before is not None:
            cur = session.run(
                "MATCH ()-[r]->() WHERE elementId(r)=$id RETURN r", id=entity_id
            ).single()
            if cur:
                session.run(
                    "MATCH ()-[r]->() WHERE elementId(r)=$id SET r=$props",
                    id=entity_id, props=before.get("properties", {}),
                )
                undo_log.append({"op": "update_edge", "entity_type": "edge",
                                 "entity_id": entity_id, "before": after, "after": before})

        elif op == "delete_edge" and before is not None:
            src = id_map.get(before["source"], before["source"])
            tgt = id_map.get(before["target"], before["target"])
            rel_type = (before.get("type") or "RELATES_TO").replace("`", "")
            rec = session.run(
                f"MATCH (a),(b) WHERE elementId(a)=$src AND elementId(b)=$tgt "
                f"CREATE (a)-[r:`{rel_type}` $props]->(b) RETURN r",
                src=src, tgt=tgt, props=before.get("properties", {}),
            ).single()
            if rec:
                undo_log.append({"op": "create_edge", "entity_type": "edge",
                                 "entity_id": rec["r"].element_id, "before": None, "after": before})

        elif op == "create_edge":
            cur_id = id_map.get(entity_id, entity_id)
            session.run("MATCH ()-[r]->() WHERE elementId(r)=$id DELETE r", id=cur_id)
            undo_log.append({"op": "delete_edge", "entity_type": "edge",
                             "entity_id": cur_id, "before": after, "after": None})

    return undo_log, id_map


# ── Routes: operations ─────────────────────────────────────────────────────────

# Allowed fields and their permitted operators (whitelist to prevent injection)
_FILTER_FIELD_TYPES = {
    "username":    "text",
    "summary":     "text",
    "operated_at": "datetime",
}
_ALLOWED_OPS = {
    "text":     {"eq", "neq", "contains", "not_contains", "starts"},
    "datetime": {"gte", "lte", "gt", "lt"},
}
_OP_SQL = {
    "eq":          ("{field} = ?",     lambda v: v),
    "neq":         ("{field} != ?",    lambda v: v),
    "contains":    ("{field} LIKE ?",  lambda v: f"%{v}%"),
    "not_contains":("{field} NOT LIKE ?", lambda v: f"%{v}%"),
    "starts":      ("{field} LIKE ?",  lambda v: f"{v}%"),
    "gte":         ("{field} >= ?",    lambda v: v),
    "lte":         ("{field} <= ?",    lambda v: v),
    "gt":          ("{field} > ?",     lambda v: v),
    "lt":          ("{field} < ?",     lambda v: v),
}


@router.get("/operations")
def list_operations(
    limit: int = 200,
    filters: str = "",
    _=Depends(get_current_user),
):
    """Return operation list.  filters is a JSON array of {field, op, val} objects."""
    conditions: list[str] = []
    params: list = []

    if filters:
        try:
            filter_list = json.loads(filters)
        except Exception:
            raise HTTPException(400, "filters 参数格式错误，需为 JSON 数组")
        for f in filter_list:
            field = f.get("field", "")
            op    = f.get("op", "")
            val   = f.get("val", "")
            if field not in _FILTER_FIELD_TYPES or not val:
                continue
            ftype = _FILTER_FIELD_TYPES[field]
            if op not in _ALLOWED_OPS.get(ftype, set()):
                continue
            sql_tpl, transform = _OP_SQL[op]
            conditions.append(sql_tpl.format(field=field))
            params.append(transform(val))

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params.append(limit)
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            f"SELECT id, summary, username, operated_at, is_undo, undone FROM operations {where} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/operations/{op_id}")
def get_operation(op_id: int, _=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM operations WHERE id=?", (op_id,)).fetchone()
    if not row:
        raise HTTPException(404, "操作记录不存在")
    d = dict(row)
    d["changes"] = json.loads(d["changes"])
    return d


@router.post("/operations/{op_id}/undo")
async def undo_operation(op_id: int, admin=Depends(require_admin)):
    locks = manager.active_locks()
    if locks:
        names = ", ".join({lk["username"] for lk in locks})
        raise HTTPException(409, f"有用户正在编辑中（{names}），请等待锁释放后再撤销")

    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM operations WHERE id=?", (op_id,)).fetchone()
    if not row:
        raise HTTPException(404, "操作记录不存在")

    op = dict(row)
    if op["is_undo"]:
        raise HTTPException(400, "撤销操作本身不支持再次撤销")

    changes = json.loads(op["changes"])

    drv = get_driver()
    with drv.session() as session:
        undo_log, _ = _undo_changes(session, changes)

    log_operation(f"撤销：{op['summary']}", undo_log, admin["sub"], admin["username"], is_undo=True)

    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("UPDATE operations SET undone=1 WHERE id=?", (op_id,))
        conn.commit()

    await manager.broadcast({
        "type":       "operation_undone",
        "summary":    op["summary"],
        "undone_by":  admin["username"],
    })
    return {"ok": True}


# ── Routes: checkpoints ────────────────────────────────────────────────────────

@router.get("/checkpoints")
def list_checkpoints(_=Depends(get_current_user)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, name, description, created_by, created_at "
            "FROM checkpoints ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/checkpoints", status_code=201)
def create_checkpoint(data: CheckpointCreate, user=Depends(get_current_user)):
    graph, schemas = _take_snapshot()
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute(
            """INSERT INTO checkpoints
               (name, description, created_by, created_at, graph_snapshot, schemas_snapshot)
               VALUES (?,?,?,?,?,?)""",
            (data.name.strip(), data.description, user["username"], now,
             json.dumps(graph, ensure_ascii=False),
             json.dumps(schemas, ensure_ascii=False)),
        )
        conn.commit()
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, name, description, created_by, created_at "
            "FROM checkpoints WHERE rowid=last_insert_rowid()"
        ).fetchone()
    return dict(row)


@router.delete("/checkpoints/{checkpoint_id}")
def delete_checkpoint(checkpoint_id: int, _admin=Depends(require_admin)):
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        if not conn.execute("SELECT id FROM checkpoints WHERE id=?", (checkpoint_id,)).fetchone():
            raise HTTPException(404, "存档点不存在")
        conn.execute("DELETE FROM checkpoints WHERE id=?", (checkpoint_id,))
        conn.commit()
    return {"ok": True}


@router.post("/checkpoints/{checkpoint_id}/restore")
async def restore_checkpoint(checkpoint_id: int, admin=Depends(require_admin)):
    locks = manager.active_locks()
    if locks:
        names = ", ".join({lk["username"] for lk in locks})
        raise HTTPException(409, f"有用户正在编辑中（{names}），请等待锁释放后再恢复存档")

    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM checkpoints WHERE id=?", (checkpoint_id,)).fetchone()
    if not row:
        raise HTTPException(404, "存档点不存在")
    cp = dict(row)

    _apply_snapshot(json.loads(cp["graph_snapshot"]), json.loads(cp["schemas_snapshot"]), admin["username"])

    # Remove operations that occurred after this checkpoint (they are now stale)
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.execute("DELETE FROM operations WHERE operated_at > ?", (cp["created_at"],))
        conn.commit()

    await manager.broadcast({
        "type":            "checkpoint_restored",
        "checkpoint_name": cp["name"],
        "restored_by":     admin["username"],
    })
    return {"ok": True, "checkpoint_name": cp["name"]}
