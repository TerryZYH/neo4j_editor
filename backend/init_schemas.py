"""
根据 Neo4j 现有图谱数据，自动初始化本体（ontology）和属性模板（property_schemas）。

规则：
  class_schemas    ← 每个 Neo4j label 创建一条类定义
  relation_schemas ← 每个实际出现的 (src_label, rel_type, tgt_label) 三元组创建约束
  property_schemas ← 节点/边属性：distinct 值 2~20 且 distinct/total < 0.7 → 枚举 schema
                     + 关系类型枚举 (__rel_type__)

用法：
  conda run -n neo4j_editor python init_schemas.py <TOKEN>
"""

import os, sys, json
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from pathlib import Path
from neo4j import GraphDatabase
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / '.env')

NEO4J_URI  = os.getenv('NEO4J_URI', 'bolt://localhost:7687')
NEO4J_USER = os.getenv('NEO4J_USER', 'neo4j')
NEO4J_PASS = os.getenv('NEO4J_PASSWORD', 'password')
API        = 'http://localhost:8000/api'
ENUM_MAX         = 20    # 枚举候选上限：distinct 值超过此数跳过
UNIQUENESS_RATIO = 0.7   # distinct/total 超过此比率视为唯一标识字段，跳过

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ''
HEADERS = {
    'Authorization': f'Bearer {TOKEN}',
    'Content-Type': 'application/json',
}


PALETTE = [
    '#4C8EDA','#DA4C4C','#4CDA7A','#DAB44C',
    '#9B4CDA','#4CDADA','#DA4C9B','#DA8E4C',
]

def post(path: str, body: dict) -> tuple[int, str]:
    data = json.dumps(body, ensure_ascii=False).encode()
    req  = Request(f'{API}{path}', data=data, headers=HEADERS, method='POST')
    try:
        with urlopen(req) as resp:
            return resp.status, resp.read().decode()
    except HTTPError as e:
        return e.code, e.read().decode()

def post_schema(body):  return post('/schemas', body)
def post_class(body):   return post('/ontology/classes', body)
def post_relation(body):return post('/ontology/relations', body)

def upsert(label, post_fn, body, key_desc):
    code, text = post_fn(body)
    if code == 201:
        print(f'  ✅ {key_desc}')
        return 'ok'
    elif code == 400 and '已存在' in text:
        print(f'  ⏭  已存在 {key_desc}')
        return 'skip'
    else:
        print(f'  ❌ {code} {key_desc} → {text[:120]}')
        return 'err'


driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))
prop_schemas  = []
class_schemas = []
rel_schemas   = []

with driver.session() as s:
    labels = [r['label'] for r in s.run('CALL db.labels() YIELD label RETURN label ORDER BY label')]
    rel_types = [r['relationshipType'] for r in s.run(
        'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType'
    )]

    # ── class_schemas: one entry per Neo4j label ───────────────────────────────
    print('\n=== 类定义 (class_schemas) ===')
    for i, lbl in enumerate(labels):
        color = PALETTE[i % len(PALETTE)]
        class_schemas.append({'label_name': lbl, 'color': color, 'icon': '⬡'})
        print(f'  [class] {lbl}  {color}')

    # ── relation_schemas: actual (src_label, rel_type, tgt_label) triples ─────
    print('\n=== 关系三元组 (relation_schemas) ===')
    for rtype in rel_types:
        triples = s.run(
            f'MATCH (a)-[r:`{rtype}`]->(b) '
            f'RETURN DISTINCT labels(a) AS src, labels(b) AS tgt LIMIT 100'
        )
        seen = set()
        for rec in triples:
            for src_lbl in rec['src']:
                for tgt_lbl in rec['tgt']:
                    key = (src_lbl, rtype, tgt_lbl)
                    if key not in seen:
                        seen.add(key)
                        rel_schemas.append({
                            'rel_type': rtype, 'source_label': src_lbl, 'target_label': tgt_lbl,
                            'description': f'从现有图谱中提取',
                        })
                        print(f'  [rel] ({src_lbl})-[{rtype}]->({tgt_lbl})')

    # ── property_schemas: node enumerable properties ───────────────────────────
    print('\n=== 属性枚举 (property_schemas) ===')
    for lbl in labels:
        total_nodes = s.run(f'MATCH (n:`{lbl}`) RETURN count(n) AS c').single()['c']
        keys = [r['k'] for r in s.run(
            f'MATCH (n:`{lbl}`) UNWIND keys(n) AS k RETURN DISTINCT k ORDER BY k'
        )]
        for k in keys:
            vals = [str(r['v']) for r in s.run(
                f'MATCH (n:`{lbl}`) WHERE n.`{k}` IS NOT NULL '
                f'RETURN DISTINCT n.`{k}` AS v LIMIT {ENUM_MAX + 1}'
            )]
            distinct = len(vals)
            ratio = distinct / total_nodes if total_nodes else 1.0
            if distinct < 2 or distinct > ENUM_MAX:
                print(f'  [skip] {lbl}.{k}: {distinct} distinct (out of range)')
            elif ratio >= UNIQUENESS_RATIO:
                print(f'  [skip] {lbl}.{k}: {distinct}/{total_nodes}={ratio:.2f} (唯一标识)')
            else:
                prop_schemas.append({
                    'entity_type': 'node', 'entity_label': lbl, 'prop_key': k,
                    'enum_values': sorted(vals), 'required': False,
                    'description': f'从现有 {lbl} 节点数据中提取',
                })
                print(f'  [node] {lbl}.{k} → {sorted(vals)}')

    # ── property_schemas: __rel_type__ + edge enumerable properties ───────────
    if rel_types:
        prop_schemas.append({
            'entity_type': 'edge', 'entity_label': '*', 'prop_key': '__rel_type__',
            'enum_values': rel_types, 'required': False,
            'description': '从现有图谱中提取的合法关系类型',
        })
        print(f'  [edge] *.__rel_type__ → {rel_types}')

    for rtype in rel_types:
        total_rels = s.run(f'MATCH ()-[r:`{rtype}`]->() RETURN count(r) AS c').single()['c']
        keys = [r['k'] for r in s.run(
            f'MATCH ()-[r:`{rtype}`]->() UNWIND keys(r) AS k RETURN DISTINCT k ORDER BY k'
        )]
        for k in keys:
            vals = [str(r['v']) for r in s.run(
                f'MATCH ()-[r:`{rtype}`]->() WHERE r.`{k}` IS NOT NULL '
                f'RETURN DISTINCT r.`{k}` AS v LIMIT {ENUM_MAX + 1}'
            )]
            distinct = len(vals)
            ratio = distinct / total_rels if total_rels else 1.0
            if distinct < 2 or distinct > ENUM_MAX:
                print(f'  [skip] {rtype}.{k}: {distinct} distinct (out of range)')
            elif ratio >= UNIQUENESS_RATIO:
                print(f'  [skip] {rtype}.{k}: {distinct}/{total_rels}={ratio:.2f} (唯一标识)')
            else:
                prop_schemas.append({
                    'entity_type': 'edge', 'entity_label': rtype, 'prop_key': k,
                    'enum_values': sorted(vals), 'required': False,
                    'description': f'从现有 {rtype} 关系数据中提取',
                })
                print(f'  [edge] {rtype}.{k} → {sorted(vals)}')

driver.close()

# ── Write to API ───────────────────────────────────────────────────────────────
results = {'ok': 0, 'skip': 0, 'err': 0}

print(f'\n\n共写入 {len(class_schemas)} 类 / {len(rel_schemas)} 关系三元组 / {len(prop_schemas)} 属性枚举\n')

print('--- class_schemas ---')
for sc in class_schemas:
    r = upsert(sc['label_name'], post_class, sc, sc['label_name'])
    results[r] += 1

print('\n--- relation_schemas ---')
for sc in rel_schemas:
    key = f"({sc['source_label']})-[{sc['rel_type']}]->({sc['target_label']})"
    r = upsert(key, post_relation, sc, key)
    results[r] += 1

print('\n--- property_schemas ---')
for sc in prop_schemas:
    key = f"{sc['entity_type']}:{sc['entity_label']}:{sc['prop_key']}"
    r = upsert(key, post_schema, sc, key)
    results[r] += 1

print(f'\n完成：{results["ok"]} 创建，{results["skip"]} 跳过，{results["err"]} 失败')
