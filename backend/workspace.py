"""
Workspace API — personal subgraph views.

Each user can own multiple workspaces.  A workspace is a named whitelist of
Neo4j node element-IDs.  Only nodes in the whitelist (and edges between them)
are shown on the canvas.  The full graph is never modified.

Tables (in users.db):
  workspaces       (id, name, owner_id, created_at, updated_at)
  workspace_nodes  (id, workspace_id, node_element_id, added_by, added_at)
  workspace_layouts(workspace_id, node_element_id, x, y, updated_at)
"""

import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Depends
from pydantic import BaseModel

from auth import get_current_user, require_admin, DB_PATH
from graph_db import get_driver, serialize_node, serialize_rel

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


# ── DB init ────────────────────────────────────────────────────────────────────

def init_workspace_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL,
                owner_id   INTEGER NOT NULL,
                created_at TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspace_nodes (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id     INTEGER NOT NULL,
                node_element_id  TEXT    NOT NULL,
                added_by         TEXT    NOT NULL DEFAULT 'manual',
                added_at         TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(workspace_id, node_element_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspace_layouts (
                workspace_id     INTEGER NOT NULL,
                node_element_id  TEXT    NOT NULL,
                x                REAL    NOT NULL DEFAULT 0,
                y                REAL    NOT NULL DEFAULT 0,
                updated_at       TEXT    NOT NULL,
                PRIMARY KEY(workspace_id, node_element_id)
            )
        """)
        conn.commit()


# ── Request models ─────────────────────────────────────────────────────────────

class WorkspaceCreate(BaseModel):
    name: str

class WorkspaceRename(BaseModel):
    name: str

class FilterReq(BaseModel):
    filter_type: str = "property"   # "property" | "label"
    prop_key: Optional[str] = None  # used when filter_type == "property"
    prop_value: Optional[str] = None
    label: Optional[str] = None     # used when filter_type == "label"

class AddNodesReq(BaseModel):
    node_ids: List[str]


# ── Helpers ────────────────────────────────────────────────────────────────────

def _check_owner(workspace_id: int, user_id: int):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT owner_id FROM workspaces WHERE id = ?", (workspace_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "工作空间不存在")
    if row[0] != user_id:
        raise HTTPException(403, "无权操作此工作空间")


def _get_node_ids(workspace_id: int) -> List[str]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT node_element_id FROM workspace_nodes WHERE workspace_id = ?",
            (workspace_id,),
        ).fetchall()
    return [r[0] for r in rows]


def _clean_stale(workspace_id: int, stale: set):
    """Remove element IDs that no longer exist in Neo4j."""
    if not stale:
        return
    with sqlite3.connect(DB_PATH) as conn:
        for sid in stale:
            conn.execute(
                "DELETE FROM workspace_nodes "
                "WHERE workspace_id = ? AND node_element_id = ?",
                (workspace_id, sid),
            )
            conn.execute(
                "DELETE FROM workspace_layouts "
                "WHERE workspace_id = ? AND node_element_id = ?",
                (workspace_id, sid),
            )
        conn.commit()


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.get("")
def list_workspaces(user=Depends(get_current_user)):
    uid = int(user["sub"])
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT w.id, w.name, w.created_at, w.updated_at,
                      (SELECT COUNT(*) FROM workspace_nodes wn
                       WHERE wn.workspace_id = w.id) AS node_count
               FROM workspaces w
               WHERE w.owner_id = ?
               ORDER BY w.updated_at DESC""",
            (uid,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("", status_code=201)
def create_workspace(data: WorkspaceCreate, user=Depends(get_current_user)):
    if not data.name.strip():
        raise HTTPException(400, "工作空间名称不能为空")
    uid = int(user["sub"])
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(
            "INSERT INTO workspaces (name, owner_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (data.name.strip(), uid, now, now),
        )
        conn.commit()
        wid = cur.lastrowid
    return {"id": wid, "name": data.name.strip(),
            "created_at": now, "updated_at": now, "node_count": 0}


@router.put("/{workspace_id}")
def rename_workspace(workspace_id: int, data: WorkspaceRename,
                     user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    if not data.name.strip():
        raise HTTPException(400, "名称不能为空")
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
            (data.name.strip(), now, workspace_id),
        )
        conn.commit()
    return {"ok": True}


@router.delete("/{workspace_id}")
def delete_workspace(workspace_id: int, user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM workspace_nodes   WHERE workspace_id = ?", (workspace_id,))
        conn.execute("DELETE FROM workspace_layouts WHERE workspace_id = ?", (workspace_id,))
        conn.execute("DELETE FROM workspaces        WHERE id = ?",           (workspace_id,))
        conn.commit()
    return {"ok": True}


# ── Subgraph ───────────────────────────────────────────────────────────────────

@router.get("/{workspace_id}/graph")
def get_workspace_graph(workspace_id: int, user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))

    node_ids = _get_node_ids(workspace_id)
    if not node_ids:
        return {"nodes": [], "edges": []}

    drv = get_driver()
    nodes: Dict[str, dict] = {}
    edges: Dict[str, dict] = {}
    valid_ids: set = set()

    with drv.session() as session:
        for rec in session.run(
            "MATCH (n) WHERE elementId(n) IN $ids RETURN n",
            ids=node_ids,
        ):
            n = rec["n"]
            nodes[n.element_id] = serialize_node(n)
            valid_ids.add(n.element_id)

        # Clean up stale IDs (nodes deleted from Neo4j)
        _clean_stale(workspace_id, set(node_ids) - valid_ids)

        if valid_ids:
            for rec in session.run(
                "MATCH (a)-[r]->(b) "
                "WHERE elementId(a) IN $ids AND elementId(b) IN $ids "
                "RETURN a, r, b",
                ids=list(valid_ids),
            ):
                a, r, b = rec["a"], rec["r"], rec["b"]
                if r.element_id not in edges:
                    edges[r.element_id] = serialize_rel(r, a.element_id, b.element_id)

    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


# ── Filter-based batch add ─────────────────────────────────────────────────────

@router.post("/{workspace_id}/filter")
def filter_add_nodes(workspace_id: int, req: FilterReq,
                     user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    drv = get_driver()
    node_ids = []

    with drv.session() as session:
        if req.filter_type == "label":
            if not req.label:
                raise HTTPException(400, "label 不能为空")
            safe_label = req.label.replace("`", "")
            result = session.run(
                f"MATCH (n:`{safe_label}`) RETURN elementId(n) AS eid"
            )
            for rec in result:
                node_ids.append(rec["eid"])

        else:  # property
            if not req.prop_key or req.prop_value is None:
                raise HTTPException(400, "prop_key 和 prop_value 不能为空")
            safe_key = req.prop_key.replace("`", "")
            result = session.run(
                f"MATCH (n) WHERE n.`{safe_key}` = $val RETURN elementId(n) AS eid",
                val=req.prop_value,
            )
            for rec in result:
                node_ids.append(rec["eid"])

    if not node_ids:
        return {"added": 0, "message": "未找到匹配节点"}

    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        for nid in node_ids:
            conn.execute(
                "INSERT OR IGNORE INTO workspace_nodes "
                "(workspace_id, node_element_id, added_by, added_at) "
                "VALUES (?, ?, 'filter', ?)",
                (workspace_id, nid, now),
            )
        # Touch updated_at
        conn.execute(
            "UPDATE workspaces SET updated_at = ? WHERE id = ?",
            (now, workspace_id),
        )
        conn.commit()

    return {"added": len(node_ids)}


# ── Manual node add / remove ───────────────────────────────────────────────────

@router.post("/{workspace_id}/nodes")
def add_nodes(workspace_id: int, req: AddNodesReq,
              user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        for nid in req.node_ids:
            conn.execute(
                "INSERT OR IGNORE INTO workspace_nodes "
                "(workspace_id, node_element_id, added_by, added_at) "
                "VALUES (?, ?, 'manual', ?)",
                (workspace_id, nid, now),
            )
        conn.execute(
            "UPDATE workspaces SET updated_at = ? WHERE id = ?",
            (now, workspace_id),
        )
        conn.commit()
    return {"ok": True}


@router.delete("/{workspace_id}/nodes/{node_element_id:path}")
def remove_node(workspace_id: int, node_element_id: str,
                user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "DELETE FROM workspace_nodes "
            "WHERE workspace_id = ? AND node_element_id = ?",
            (workspace_id, node_element_id),
        )
        conn.execute(
            "DELETE FROM workspace_layouts "
            "WHERE workspace_id = ? AND node_element_id = ?",
            (workspace_id, node_element_id),
        )
        conn.commit()
    return {"ok": True}


# ── Per-workspace layout ───────────────────────────────────────────────────────

@router.get("/{workspace_id}/layout")
def get_layout(workspace_id: int, user=Depends(get_current_user)):
    _check_owner(workspace_id, int(user["sub"]))
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT node_element_id, x, y FROM workspace_layouts "
            "WHERE workspace_id = ?",
            (workspace_id,),
        ).fetchall()
    return {r["node_element_id"]: {"x": r["x"], "y": r["y"]} for r in rows}


@router.put("/{workspace_id}/layout")
def save_layout(
    workspace_id: int,
    positions: Dict[str, Any] = Body(...),
    user=Depends(get_current_user),
):
    _check_owner(workspace_id, int(user["sub"]))
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        for node_id, pos in positions.items():
            if not isinstance(pos, dict):
                continue
            conn.execute(
                "INSERT INTO workspace_layouts "
                "(workspace_id, node_element_id, x, y, updated_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(workspace_id, node_element_id) DO UPDATE SET "
                "  x=excluded.x, y=excluded.y, updated_at=excluded.updated_at",
                (workspace_id, node_id,
                 pos.get("x", 0), pos.get("y", 0), now),
            )
        conn.commit()
    return {"ok": True}


# ── Admin view ────────────────────────────────────────────────────────────────

@router.get("/admin/all")
def admin_list_all(admin=Depends(require_admin)):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT w.id, w.name, w.created_at, w.updated_at,
                      u.username AS owner,
                      (SELECT COUNT(*) FROM workspace_nodes wn
                       WHERE wn.workspace_id = w.id) AS node_count
               FROM workspaces w
               JOIN users u ON u.id = w.owner_id
               ORDER BY w.updated_at DESC""",
        ).fetchall()
    return [dict(r) for r in rows]
