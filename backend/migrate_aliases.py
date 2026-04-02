"""
迁移脚本：将别名节点合并到品类节点的 aliases 字段（列表类型），然后删除别名节点及相关关系。

使用方法（在 backend/ 目录下运行）:
    python migrate_aliases.py [--dry-run]

--dry-run: 只预览，不写入
"""
import sys
import os
import sqlite3
import json
from pathlib import Path
from dotenv import load_dotenv
from neo4j import GraphDatabase

load_dotenv(Path(__file__).parent / ".env", override=True)

NEO4J_URI      = os.getenv("NEO4J_URI",      "bolt://localhost:7687")
NEO4J_USER     = os.getenv("NEO4J_USER",     "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
SCHEMA_DB_PATH = Path(os.getenv("DATA_DIR", str(Path(__file__).parent))) / "schemas.db"

DRY_RUN = "--dry-run" in sys.argv


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    driver.verify_connectivity()
    print(f"✅ 已连接 Neo4j: {NEO4J_URI}")

    with driver.session() as session:
        # ── 1. 探查别名节点及其与品类的关系 ────────────────────────────────
        probe = session.run("""
            MATCH (a:Breed_Alias)
            OPTIONAL MATCH (p:Breed)-[r]-(a)
            RETURN count(a) AS alias_cnt,
                   count(p) AS linked_category_cnt,
                   collect(DISTINCT type(r)) AS rel_types,
                   collect(DISTINCT keys(a)) AS alias_keys
            LIMIT 1
        """).single()

        alias_cnt = probe["alias_cnt"]
        linked_cnt = probe["linked_category_cnt"]
        rel_types = probe["rel_types"]
        all_alias_keys = []
        for kl in probe["alias_keys"]:
            all_alias_keys.extend(kl)
        alias_keys = list(dict.fromkeys(all_alias_keys))  # deduplicate, preserve order

        print(f"\n📊 探查结果:")
        print(f"   别名节点总数:   {alias_cnt}")
        print(f"   关联品类节点数: {linked_cnt}")
        print(f"   关系类型:       {rel_types}")
        print(f"   别名节点属性:   {alias_keys}")

        if alias_cnt == 0:
            print("\n⚠️  没有找到 :别名 节点，跳过迁移。")
            driver.close()
            return

        # 确定用哪个属性作为别名文本（优先 name/alias/label）
        name_key = None
        for candidate in ["name", "alias", "label", "value", "text"]:
            if candidate in alias_keys:
                name_key = candidate
                break
        if name_key is None and alias_keys:
            name_key = alias_keys[0]
        if name_key is None:
            print("❌ 别名节点没有任何属性，无法提取别名文本，终止。")
            driver.close()
            return
        print(f"   使用属性 '{name_key}' 作为别名文本")

        # ── 2. 收集每个品类节点的别名列表 ──────────────────────────────────
        rows = session.run(f"""
            MATCH (p:Breed)-[r:HAS_ALIAS]-(a:Breed_Alias)
            WITH p, collect(COALESCE(a.`{name_key}`, '')) AS aliases
            WHERE size(aliases) > 0
            RETURN elementId(p) AS pid,
                   p.name AS pname,
                   aliases
            ORDER BY pname
        """).data()

        if not rows:
            print("\n⚠️  没有找到 品类 ↔ 别名 的关联，仅会删除孤立的别名节点。")
        else:
            print(f"\n📋 将迁移 {len(rows)} 个品类节点：")
            for r in rows:
                print(f"   [{r['pname']}]  aliases = {r['aliases']}")

        # 找出孤立的别名节点（没有连接品类的）
        orphan_cnt = session.run("""
            MATCH (a:Breed_Alias)
            WHERE NOT (a)-[]->(:Breed) AND NOT (:Breed)-[]->(a)
            RETURN count(a) AS cnt
        """).single()["cnt"]
        if orphan_cnt:
            print(f"\n⚠️  有 {orphan_cnt} 个别名节点未关联任何品类，将直接删除。")

        if DRY_RUN:
            print("\n🔍 [DRY RUN] 以上为预览，未写入任何数据。去掉 --dry-run 参数执行实际迁移。")
            driver.close()
            return

        print("\n🚀 开始迁移...")

        # ── 3. 将别名列表写入品类节点 ───────────────────────────────────────
        for r in rows:
            session.run(
                "MATCH (p) WHERE elementId(p) = $pid SET p.aliases = $aliases",
                pid=r["pid"], aliases=r["aliases"],
            )
        print(f"   ✅ 已为 {len(rows)} 个品类节点写入 aliases 属性")

        # ── 4. 删除所有别名节点（及其关系）───────────────────────────────────
        deleted = session.run("""
            MATCH (a:Breed_Alias)
            WITH a, elementId(a) AS aid
            DETACH DELETE a
            RETURN count(aid) AS cnt
        """).single()["cnt"]
        print(f"   ✅ 已删除 {deleted} 个别名节点及其所有关系")

    driver.close()

    # ── 5. 清理 SQLite ontology schemas 中的别名相关记录 ─────────────────
    if SCHEMA_DB_PATH.exists():
        with sqlite3.connect(SCHEMA_DB_PATH) as conn:
            # 删除别名 class schema
            r = conn.execute("DELETE FROM class_schemas WHERE label_name='Breed_Alias'")
            if r.rowcount:
                print(f"   ✅ 已删除 class_schemas 中的 'Breed_Alias' 类定义 ({r.rowcount} 条)")

            # 删除涉及别名的 relation schemas
            r = conn.execute(
                "DELETE FROM relation_schemas WHERE source_label='Breed_Alias' OR target_label='Breed_Alias'"
            )
            if r.rowcount:
                print(f"   ✅ 已删除 relation_schemas 中涉及 'Breed_Alias' 的关系定义 ({r.rowcount} 条)")

            # 删除别名节点的 property schemas
            r = conn.execute("DELETE FROM property_schemas WHERE entity_label='Breed_Alias'")
            if r.rowcount:
                print(f"   ✅ 已删除 property_schemas 中 'Breed_Alias' 的字段定义 ({r.rowcount} 条)")

            # 确保 Breed 节点有 aliases 字段的 schema 定义
            now = __import__("datetime").datetime.utcnow().isoformat() + "Z"
            try:
                conn.execute(
                    """INSERT INTO property_schemas
                       (entity_type, entity_label, prop_key, prop_type, is_id,
                        enum_values, regex_pattern, required, default_val, description,
                        created_by, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    ("node", "Breed", "aliases", "list", 0, "[]", None, 0, None,
                     "品类别名列表", "migration", now),
                )
                print("   ✅ 已在 property_schemas 中为 'Breed' 添加 aliases (list) 字段定义")
            except sqlite3.IntegrityError:
                conn.execute(
                    "UPDATE property_schemas SET prop_type='list', updated_at=? "
                    "WHERE entity_type='node' AND entity_label='Breed' AND prop_key='aliases'",
                    (now,),
                )
                print("   ✅ 已更新 'Breed'.aliases 字段定义为 list 类型")

            conn.commit()

    print("\n🎉 迁移完成！")


if __name__ == "__main__":
    main()
