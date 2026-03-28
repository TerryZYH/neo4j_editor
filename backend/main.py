from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, Depends, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import os, json
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

import sqlite3
from auth import init_db, get_current_user, decode_token, require_admin, DB_PATH, router as auth_router
from ws_manager import manager
from admin import router as admin_router
from schemas import init_schema_db, router as schemas_router, SCHEMA_DB_PATH
from ontology import (
    init_ontology_db, router as ontology_router,
    get_validation_mode, validate_node_labels, validate_relation_triple,
)
from graph_db import init_driver, get_driver, serialize_node, serialize_rel, NEO4J_URI
from workspace import init_workspace_db, router as workspace_router

load_dotenv()

app = FastAPI(title="Neo4j Graph Editor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(schemas_router)
app.include_router(ontology_router)
app.include_router(workspace_router)

init_db()
init_schema_db()
init_ontology_db()
init_workspace_db()
init_driver()


# ── Models ────────────────────────────────────────────────────────────────────

class NodeCreate(BaseModel):
    labels: List[str] = ["Node"]
    properties: Dict[str, Any] = {}

class NodeUpdate(BaseModel):
    labels: Optional[List[str]] = None
    properties: Optional[Dict[str, Any]] = None

class RelationshipCreate(BaseModel):
    source_id: int
    target_id: int
    type: str = "RELATES_TO"
    properties: Dict[str, Any] = {}

class RelationshipUpdate(BaseModel):
    type: Optional[str] = None
    properties: Optional[Dict[str, Any]] = None

class CypherQuery(BaseModel):
    query: str
    params: Dict[str, Any] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def serialize_node(n):
    return {"id": n.element_id, "labels": list(n.labels), "properties": dict(n)}

def serialize_rel(r, source_id=None, target_id=None):
    return {
        "id": r.element_id,
        "source": source_id if source_id is not None else r.start_node.element_id,
        "target": target_id if target_id is not None else r.end_node.element_id,
        "type": r.type,
        "properties": dict(r),
    }


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, token: str = ""):
    try:
        payload = decode_token(token)
    except HTTPException:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    user_id = payload["sub"]
    username = payload["username"]
    await manager.connect(websocket, user_id, username)

    try:
        while True:
            data = await websocket.receive_json()
            t = data.get("type", "")

            if t == "lock_entity":
                eid = data.get("entity_id", "")
                ok = manager.try_lock(eid, user_id, username)
                lk = manager.get_lock(eid)
                await websocket.send_json({
                    "type": "lock_result",
                    "entity_id": eid,
                    "success": ok,
                    "locked_by": lk["username"] if not ok and lk else None,
                })
                if ok:
                    await manager.broadcast(
                        {"type": "entity_locked", "entity_id": eid,
                         "user_id": user_id, "username": username,
                         "color": manager._color(user_id)},
                        exclude=user_id,
                    )

            elif t == "unlock_entity":
                eid = data.get("entity_id", "")
                if manager.release_lock(eid, user_id):
                    await manager.broadcast({"type": "entity_unlocked", "entity_id": eid})

            elif t == "heartbeat":
                manager.heartbeat(user_id)
                await websocket.send_json({"type": "heartbeat_ack"})

    except WebSocketDisconnect:
        await manager.disconnect(user_id)
    except Exception:
        await manager.disconnect(user_id)


# ── Graph ─────────────────────────────────────────────────────────────────────

@app.get("/api/graph")
async def get_graph(
    label: Optional[str] = None,
    limit: int = Query(200, le=1000),
    _=Depends(get_current_user),
):
    drv = get_driver()
    with drv.session() as session:
        nodes: Dict[str, dict] = {}
        rels: Dict[str, dict] = {}

        node_cypher = (
            f"MATCH (n:`{label}`) RETURN n LIMIT $limit" if label
            else "MATCH (n) RETURN n LIMIT $limit"
        )
        for rec in session.run(node_cypher, limit=limit):
            n = rec["n"]
            nodes[n.element_id] = serialize_node(n)

        rel_cypher = (
            f"MATCH (a:`{label}`)-[r]->(b) RETURN a, r, b LIMIT $limit" if label
            else "MATCH (a)-[r]->(b) RETURN a, r, b LIMIT $limit"
        )
        for rec in session.run(rel_cypher, limit=limit):
            a, r, b = rec["a"], rec["r"], rec["b"]
            if a.element_id not in nodes:
                nodes[a.element_id] = serialize_node(a)
            if b.element_id not in nodes:
                nodes[b.element_id] = serialize_node(b)
            if r.element_id not in rels:
                rels[r.element_id] = serialize_rel(r, a.element_id, b.element_id)

        return {"nodes": list(nodes.values()), "edges": list(rels.values())}


# ── Nodes ─────────────────────────────────────────────────────────────────────

def _check_labels(labels: list):
    """Validate labels against ontology; raise 422 in strict mode."""
    valid, msg = validate_node_labels(labels)
    if not valid and get_validation_mode() == "strict":
        raise HTTPException(422, f"[本体校验] {msg}")
    return valid, msg

def _check_triple(src_labels: list, rel_type: str, tgt_labels: list):
    valid, msg = validate_relation_triple(src_labels, rel_type, tgt_labels)
    if not valid and get_validation_mode() == "strict":
        raise HTTPException(422, f"[本体校验] {msg}")
    return valid, msg


def _check_id_uniqueness(session, labels: list, properties: dict, exclude_id: str = None):
    """Raise 409 if any is_id field value already exists on a node with the same label."""
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        for label in labels:
            rows = conn.execute(
                "SELECT prop_key FROM property_schemas "
                "WHERE entity_type='node' AND entity_label=? AND is_id=1",
                (label,),
            ).fetchall()
            for row in rows:
                key = row["prop_key"]
                if key not in properties:
                    continue
                val = properties[key]
                if exclude_id:
                    cnt = session.run(
                        f"MATCH (n:`{label}`) WHERE n.`{key}` = $v "
                        "AND elementId(n) <> $excl RETURN count(n) AS cnt",
                        v=val, excl=exclude_id,
                    ).single()["cnt"]
                else:
                    cnt = session.run(
                        f"MATCH (n:`{label}`) WHERE n.`{key}` = $v RETURN count(n) AS cnt",
                        v=val,
                    ).single()["cnt"]
                if cnt > 0:
                    raise HTTPException(
                        409,
                        f"[唯一性校验] 标签「{label}」下已存在 {key}={val!r} 的节点",
                    )


@app.post("/api/nodes", status_code=201)
async def create_node(node: NodeCreate, user=Depends(get_current_user)):
    _check_labels(node.labels)
    drv = get_driver()
    labels_str = ":".join(f"`{l}`" for l in node.labels) if node.labels else "Node"
    with drv.session() as session:
        _check_id_uniqueness(session, node.labels, node.properties)
        result = session.run(
            f"CREATE (n:{labels_str} $props) RETURN n", props=node.properties
        )
        rec = result.single()
        if not rec:
            raise HTTPException(500, "Node creation failed")
        data = serialize_node(rec["n"])
    await manager.broadcast(
        {"type": "entity_created", "entity_type": "node", "entity": data},
        exclude=user["sub"],
    )
    return data


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str, _=Depends(get_current_user)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run("MATCH (n) WHERE elementId(n) = $id RETURN n", id=node_id)
        rec = result.single()
        if not rec:
            raise HTTPException(404, "Node not found")
        return serialize_node(rec["n"])


@app.put("/api/nodes/{node_id}")
async def update_node(node_id: str, node: NodeUpdate, user=Depends(get_current_user)):
    lk = manager.get_lock(node_id)
    if lk and lk["user_id"] != user["sub"]:
        raise HTTPException(423, f"该节点正在被 {lk['username']} 编辑")
    if node.labels:
        _check_labels(node.labels)

    drv = get_driver()
    with drv.session() as session:
        if node.properties is not None:
            # Resolve effective labels for uniqueness check
            effective_labels = node.labels if node.labels else list(
                session.run(
                    "MATCH (n) WHERE elementId(n) = $id RETURN labels(n) AS lbls", id=node_id
                ).single()["lbls"]
            )
            _check_id_uniqueness(session, effective_labels, node.properties, exclude_id=node_id)
            session.run(
                "MATCH (n) WHERE elementId(n) = $id SET n = $props",
                id=node_id, props=node.properties,
            )
        if node.labels is not None:
            existing = session.run(
                "MATCH (n) WHERE elementId(n) = $id RETURN labels(n) as lbls", id=node_id
            ).single()
            if existing:
                for lbl in existing["lbls"]:
                    session.run(f"MATCH (n) WHERE elementId(n) = $id REMOVE n:`{lbl}`", id=node_id)
            for lbl in node.labels:
                session.run(f"MATCH (n) WHERE elementId(n) = $id SET n:`{lbl}`", id=node_id)
        result = session.run("MATCH (n) WHERE elementId(n) = $id RETURN n", id=node_id)
        rec = result.single()
        if not rec:
            raise HTTPException(404, "Node not found")
        data = serialize_node(rec["n"])
    await manager.broadcast(
        {"type": "entity_updated", "entity_type": "node", "entity": data},
        exclude=user["sub"],
    )
    return data


@app.delete("/api/nodes/{node_id}")
async def delete_node(node_id: str, user=Depends(get_current_user)):
    lk = manager.get_lock(node_id)
    if lk and lk["user_id"] != user["sub"]:
        raise HTTPException(423, f"该节点正在被 {lk['username']} 编辑")
    drv = get_driver()
    with drv.session() as session:
        session.run("MATCH (n) WHERE elementId(n) = $id DETACH DELETE n", id=node_id)
    await manager.broadcast(
        {"type": "entity_deleted", "entity_type": "node", "entity_id": node_id},
        exclude=user["sub"],
    )
    return {"ok": True}


# ── Relationships ─────────────────────────────────────────────────────────────

@app.post("/api/relationships", status_code=201)
async def create_relationship(rel: RelationshipCreate, user=Depends(get_current_user)):
    drv = get_driver()
    rel_type = rel.type.replace("`", "")
    with drv.session() as session:
        result = session.run(
            f"MATCH (a), (b) WHERE id(a) = $src AND id(b) = $tgt "
            f"CREATE (a)-[r:`{rel_type}` $props]->(b) RETURN r",
            src=rel.source_id, tgt=rel.target_id, props=rel.properties,
        )
        rec = result.single()
        if not rec:
            raise HTTPException(404, "Source or target node not found")
        data = serialize_rel(rec["r"])
    await manager.broadcast(
        {"type": "entity_created", "entity_type": "edge", "entity": data},
        exclude=user["sub"],
    )
    return data


@app.post("/api/relationships/by-element-id", status_code=201)
async def create_relationship_by_element_id(
    source_element_id: str,
    target_element_id: str,
    type: str = "RELATES_TO",
    properties: Dict[str, Any] = {},
    user=Depends(get_current_user),
):
    drv = get_driver()
    rel_type = type.replace("`", "")
    with drv.session() as session:
        # Fetch source/target labels for ontology validation
        src_rec = session.run("MATCH (n) WHERE elementId(n)=$id RETURN labels(n) AS lbls", id=source_element_id).single()
        tgt_rec = session.run("MATCH (n) WHERE elementId(n)=$id RETURN labels(n) AS lbls", id=target_element_id).single()
        src_labels = list(src_rec["lbls"]) if src_rec else []
        tgt_labels = list(tgt_rec["lbls"]) if tgt_rec else []
        _check_triple(src_labels, rel_type, tgt_labels)

        result = session.run(
            f"MATCH (a), (b) WHERE elementId(a) = $src AND elementId(b) = $tgt "
            f"CREATE (a)-[r:`{rel_type}` $props]->(b) RETURN r",
            src=source_element_id, tgt=target_element_id, props=properties,
        )
        rec = result.single()
        if not rec:
            raise HTTPException(404, "Source or target node not found")
        data = serialize_rel(rec["r"], source_element_id, target_element_id)
    await manager.broadcast(
        {"type": "entity_created", "entity_type": "edge", "entity": data},
        exclude=user["sub"],
    )
    return data


@app.put("/api/relationships/{rel_id}")
async def update_relationship(rel_id: str, rel: RelationshipUpdate, user=Depends(get_current_user)):
    lk = manager.get_lock(rel_id)
    if lk and lk["user_id"] != user["sub"]:
        raise HTTPException(423, f"该关系正在被 {lk['username']} 编辑")
    drv = get_driver()
    with drv.session() as session:
        if rel.properties is not None:
            session.run(
                "MATCH ()-[r]->() WHERE elementId(r) = $id SET r = $props",
                id=rel_id, props=rel.properties,
            )
        result = session.run(
            "MATCH ()-[r]->() WHERE elementId(r) = $id RETURN r", id=rel_id
        )
        rec = result.single()
        if not rec:
            raise HTTPException(404, "Relationship not found")
        data = serialize_rel(rec["r"])
    await manager.broadcast(
        {"type": "entity_updated", "entity_type": "edge", "entity": data},
        exclude=user["sub"],
    )
    return data


@app.delete("/api/relationships/{rel_id}")
async def delete_relationship(rel_id: str, user=Depends(get_current_user)):
    lk = manager.get_lock(rel_id)
    if lk and lk["user_id"] != user["sub"]:
        raise HTTPException(423, f"该关系正在被 {lk['username']} 编辑")
    drv = get_driver()
    with drv.session() as session:
        session.run("MATCH ()-[r]->() WHERE elementId(r) = $id DELETE r", id=rel_id)
    await manager.broadcast(
        {"type": "entity_deleted", "entity_type": "edge", "entity_id": rel_id},
        exclude=user["sub"],
    )
    return {"ok": True}


# ── Search & Metadata ─────────────────────────────────────────────────────────

@app.get("/api/search")
async def search_nodes(q: str, limit: int = Query(50, le=200), _=Depends(get_current_user)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "MATCH (n) WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS toLower($q)) "
            "RETURN n LIMIT $limit",
            q=q, limit=limit,
        )
        return [serialize_node(rec["n"]) for rec in result]


@app.get("/api/labels")
async def get_labels(_=Depends(get_current_user)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run("CALL db.labels() YIELD label RETURN label ORDER BY label")
        return [rec["label"] for rec in result]


@app.get("/api/relationship-types")
async def get_rel_types(_=Depends(get_current_user)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN relationshipType ORDER BY relationshipType"
        )
        return [rec["relationshipType"] for rec in result]


@app.get("/api/node-neighbors/{node_id}")
async def get_neighbors(node_id: str, limit: int = 50, _=Depends(get_current_user)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "MATCH (n)-[r]-(m) WHERE elementId(n) = $id RETURN n, r, m LIMIT $limit",
            id=node_id, limit=limit,
        )
        nodes: Dict[str, dict] = {}
        rels: Dict[str, dict] = {}
        for rec in result:
            n, r, m = rec["n"], rec["r"], rec["m"]
            for nd in (n, m):
                if nd and nd.element_id not in nodes:
                    nodes[nd.element_id] = serialize_node(nd)
            if r and r.element_id not in rels:
                src_id = n.element_id if r.start_node.element_id == n.element_id else m.element_id
                tgt_id = m.element_id if src_id == n.element_id else n.element_id
                rels[r.element_id] = serialize_rel(r, src_id, tgt_id)
        return {"nodes": list(nodes.values()), "edges": list(rels.values())}


@app.get("/api/status")
def status():
    try:
        if driver:
            driver.verify_connectivity()
            return {"connected": True, "uri": NEO4J_URI}
    except Exception as e:
        return {"connected": False, "error": str(e)}
    return {"connected": False, "error": "Driver not initialized"}


# ── Export / Import ───────────────────────────────────────────────────────────

@app.get("/api/export")
def export_all(admin=Depends(require_admin)):
    drv = get_driver()

    # 1. Graph data (all nodes + relationships)
    with drv.session() as session:
        nodes: Dict[str, dict] = {}
        edges:  Dict[str, dict] = {}
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

    # 2. Schemas + ontology
    schemas: dict = {}
    with sqlite3.connect(SCHEMA_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        schemas["property_schemas"] = [dict(r) for r in conn.execute("SELECT * FROM property_schemas")]
        schemas["class_schemas"]    = [dict(r) for r in conn.execute("SELECT * FROM class_schemas")]
        schemas["relation_schemas"] = [dict(r) for r in conn.execute("SELECT * FROM relation_schemas")]
        schemas["ontology_config"]  = {r[0]: r[1] for r in conn.execute("SELECT key, value FROM ontology_config")}

    # 3. Node positions for all users
    positions: dict = {}
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT u.username, up.positions FROM user_positions up "
            "JOIN users u ON u.id = up.user_id"
        ).fetchall()
        for username, pos_json in rows:
            try:
                positions[username] = json.loads(pos_json)
            except Exception:
                pass

    return {
        "version": "1.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "exported_by": admin["username"],
        "graph":     {"nodes": list(nodes.values()), "edges": list(edges.values())},
        "schemas":   schemas,
        "positions": positions,
    }


@app.post("/api/import")
def import_all(data: Dict[str, Any] = Body(...), admin=Depends(require_admin)):
    drv = get_driver()
    graph    = data.get("graph", {})
    schemas  = data.get("schemas", {})
    positions = data.get("positions", {})

    # ── 1. Rebuild graph ──────────────────────────────────────────────────────
    id_map: Dict[str, str] = {}   # old element_id → new element_id
    edge_count = 0

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
                f"MATCH (a), (b) WHERE elementId(a)=$src AND elementId(b)=$tgt "
                f"CREATE (a)-[r:`{rel_type}` $props]->(b)",
                src=src, tgt=tgt, props=edge.get("properties", {}),
            )
            edge_count += 1

    # ── 2. Replace schemas ────────────────────────────────────────────────────
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
                     else json.dumps(r.get("enum_values", [])),
                 r.get("regex_pattern"), r.get("required",0),
                 r.get("default_val"), r.get("description"),
                 r.get("created_by", admin["username"]),
                 r.get("updated_at", datetime.now(timezone.utc).isoformat())),
            )

        for r in schemas.get("class_schemas", []):
            conn.execute(
                "INSERT OR IGNORE INTO class_schemas "
                "(label_name,display_name,description,color,icon,created_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (r["label_name"], r.get("display_name"), r.get("description"),
                 r.get("color","#4C8EDA"), r.get("icon","⬡"),
                 r.get("created_by", admin["username"]),
                 r.get("updated_at", datetime.now(timezone.utc).isoformat())),
            )

        for r in schemas.get("relation_schemas", []):
            conn.execute(
                "INSERT OR IGNORE INTO relation_schemas "
                "(rel_type,source_label,target_label,display_name,description,created_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (r["rel_type"], r["source_label"], r["target_label"],
                 r.get("display_name"), r.get("description"),
                 r.get("created_by", admin["username"]),
                 r.get("updated_at", datetime.now(timezone.utc).isoformat())),
            )

        for key, value in schemas.get("ontology_config", {}).items():
            conn.execute(
                "INSERT OR REPLACE INTO ontology_config (key, value) VALUES (?,?)", (key, value)
            )
        conn.commit()

    # ── 3. Remap and restore positions ────────────────────────────────────────
    with sqlite3.connect(DB_PATH) as conn:
        user_rows = conn.execute("SELECT username, id FROM users").fetchall()
        username_to_id = {row[0]: row[1] for row in user_rows}
        now = datetime.now(timezone.utc).isoformat()

        for username, pos_dict in positions.items():
            uid = username_to_id.get(username)
            if not uid:
                continue
            remapped = {id_map[old]: xy for old, xy in pos_dict.items() if old in id_map}
            if not remapped:
                continue
            conn.execute(
                "INSERT INTO user_positions (user_id, positions, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET positions=excluded.positions, updated_at=excluded.updated_at",
                (uid, json.dumps(remapped), now),
            )
        conn.commit()

    return {
        "ok": True,
        "imported_nodes": len(id_map),
        "imported_edges": edge_count,
    }


# ── Serve frontend ────────────────────────────────────────────────────────────

frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
