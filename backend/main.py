from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from neo4j import GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Neo4j Graph Editor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")

try:
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    driver.verify_connectivity()
    print(f"✅ Connected to Neo4j at {NEO4J_URI}")
except Exception as e:
    print(f"⚠️  Neo4j connection failed: {e}")
    driver = None


def get_driver():
    if driver is None:
        raise HTTPException(status_code=503, detail="Neo4j not connected")
    return driver


# ── Models ──────────────────────────────────────────────────────────────────

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


# ── Helpers ──────────────────────────────────────────────────────────────────

def serialize_node(n):
    return {
        "id": n.element_id,
        "labels": list(n.labels),
        "properties": dict(n),
    }

def serialize_rel(r, source_id=None, target_id=None):
    return {
        "id": r.element_id,
        "source": source_id if source_id is not None else r.start_node.element_id,
        "target": target_id if target_id is not None else r.end_node.element_id,
        "type": r.type,
        "properties": dict(r),
    }


# ── Graph ────────────────────────────────────────────────────────────────────

@app.get("/api/graph")
def get_graph(label: Optional[str] = None, limit: int = Query(200, le=1000)):
    drv = get_driver()
    with drv.session() as session:
        nodes: Dict[str, dict] = {}
        rels: Dict[str, dict] = {}

        # 查节点
        node_cypher = (
            f"MATCH (n:`{label}`) RETURN n LIMIT $limit" if label
            else "MATCH (n) RETURN n LIMIT $limit"
        )
        for rec in session.run(node_cypher, limit=limit):
            n = rec["n"]
            nodes[n.element_id] = serialize_node(n)

        # 查关系（独立查询，避免 OPTIONAL MATCH driver 兼容问题）
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


# ── Nodes ────────────────────────────────────────────────────────────────────

@app.post("/api/nodes", status_code=201)
def create_node(node: NodeCreate):
    drv = get_driver()
    labels_str = ":".join(f"`{l}`" for l in node.labels) if node.labels else "Node"
    with drv.session() as session:
        result = session.run(
            f"CREATE (n:{labels_str} $props) RETURN n",
            props=node.properties,
        )
        rec = result.single()
        if not rec:
            raise HTTPException(status_code=500, detail="Node creation failed")
        return serialize_node(rec["n"])


@app.get("/api/nodes/{node_id}")
def get_node(node_id: str):
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "MATCH (n) WHERE elementId(n) = $id RETURN n", id=node_id
        )
        rec = result.single()
        if not rec:
            raise HTTPException(status_code=404, detail="Node not found")
        return serialize_node(rec["n"])


@app.put("/api/nodes/{node_id}")
def update_node(node_id: str, node: NodeUpdate):
    drv = get_driver()
    with drv.session() as session:
        # Update properties
        if node.properties is not None:
            session.run(
                "MATCH (n) WHERE elementId(n) = $id SET n = $props",
                id=node_id, props=node.properties,
            )
        # Update labels
        if node.labels is not None:
            existing = session.run(
                "MATCH (n) WHERE elementId(n) = $id RETURN labels(n) as lbls", id=node_id
            ).single()
            if existing:
                for lbl in existing["lbls"]:
                    session.run(
                        f"MATCH (n) WHERE elementId(n) = $id REMOVE n:`{lbl}`", id=node_id
                    )
            for lbl in node.labels:
                session.run(
                    f"MATCH (n) WHERE elementId(n) = $id SET n:`{lbl}`", id=node_id
                )
        result = session.run(
            "MATCH (n) WHERE elementId(n) = $id RETURN n", id=node_id
        )
        rec = result.single()
        if not rec:
            raise HTTPException(status_code=404, detail="Node not found")
        return serialize_node(rec["n"])


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: str):
    drv = get_driver()
    with drv.session() as session:
        session.run(
            "MATCH (n) WHERE elementId(n) = $id DETACH DELETE n", id=node_id
        )
    return {"ok": True}


# ── Relationships ─────────────────────────────────────────────────────────────

@app.post("/api/relationships", status_code=201)
def create_relationship(rel: RelationshipCreate):
    drv = get_driver()
    rel_type = rel.type.replace("`", "")
    with drv.session() as session:
        result = session.run(
            f"MATCH (a), (b) "
            f"WHERE id(a) = $src AND id(b) = $tgt "
            f"CREATE (a)-[r:`{rel_type}` $props]->(b) RETURN r",
            src=rel.source_id, tgt=rel.target_id, props=rel.properties,
        )
        rec = result.single()
        if not rec:
            raise HTTPException(status_code=404, detail="Source or target node not found")
        return serialize_rel(rec["r"])


@app.post("/api/relationships/by-element-id", status_code=201)
def create_relationship_by_element_id(
    source_element_id: str,
    target_element_id: str,
    type: str = "RELATES_TO",
    properties: Dict[str, Any] = {},
):
    drv = get_driver()
    rel_type = type.replace("`", "")
    with drv.session() as session:
        result = session.run(
            f"MATCH (a), (b) "
            f"WHERE elementId(a) = $src AND elementId(b) = $tgt "
            f"CREATE (a)-[r:`{rel_type}` $props]->(b) RETURN r",
            src=source_element_id, tgt=target_element_id, props=properties,
        )
        rec = result.single()
        if not rec:
            raise HTTPException(status_code=404, detail="Source or target node not found")
        return serialize_rel(rec["r"], source_element_id, target_element_id)


@app.put("/api/relationships/{rel_id}")
def update_relationship(rel_id: str, rel: RelationshipUpdate):
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
            raise HTTPException(status_code=404, detail="Relationship not found")
        return serialize_rel(rec["r"])


@app.delete("/api/relationships/{rel_id}")
def delete_relationship(rel_id: str):
    drv = get_driver()
    with drv.session() as session:
        session.run(
            "MATCH ()-[r]->() WHERE elementId(r) = $id DELETE r", id=rel_id
        )
    return {"ok": True}


# ── Search & Metadata ─────────────────────────────────────────────────────────

@app.get("/api/search")
def search_nodes(q: str, limit: int = Query(50, le=200)):
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "MATCH (n) "
            "WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS toLower($q)) "
            "RETURN n LIMIT $limit",
            q=q, limit=limit,
        )
        return [serialize_node(rec["n"]) for rec in result]


@app.get("/api/labels")
def get_labels():
    drv = get_driver()
    with drv.session() as session:
        result = session.run("CALL db.labels() YIELD label RETURN label ORDER BY label")
        return [rec["label"] for rec in result]


@app.get("/api/relationship-types")
def get_rel_types():
    drv = get_driver()
    with drv.session() as session:
        result = session.run(
            "CALL db.relationshipTypes() YIELD relationshipType "
            "RETURN relationshipType ORDER BY relationshipType"
        )
        return [rec["relationshipType"] for rec in result]


@app.get("/api/node-neighbors/{node_id}")
def get_neighbors(node_id: str, limit: int = 50):
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


# ── Serve frontend ────────────────────────────────────────────────────────────

frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
