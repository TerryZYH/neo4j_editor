"""
Shared Neo4j driver module.
Imported by main.py and workspace.py to avoid circular dependencies.
"""
from neo4j import GraphDatabase
import os
from fastapi import HTTPException
from dotenv import load_dotenv

load_dotenv()

NEO4J_URI      = os.getenv("NEO4J_URI",      "bolt://localhost:7687")
NEO4J_USER     = os.getenv("NEO4J_USER",     "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")

_driver = None


def init_driver():
    global _driver
    try:
        _driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        _driver.verify_connectivity()
        print(f"✅ Connected to Neo4j at {NEO4J_URI}")
    except Exception as e:
        print(f"⚠️  Neo4j connection failed: {e}")
        _driver = None
    return _driver


def get_driver():
    if _driver is None:
        raise HTTPException(status_code=503, detail="Neo4j not connected")
    return _driver


def serialize_node(n):
    return {"id": n.element_id, "labels": list(n.labels), "properties": dict(n)}


def serialize_rel(r, source_id=None, target_id=None):
    return {
        "id":         r.element_id,
        "source":     source_id     if source_id     is not None else r.start_node.element_id,
        "target":     target_id     if target_id     is not None else r.end_node.element_id,
        "type":       r.type,
        "properties": dict(r),
    }
