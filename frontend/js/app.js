// ── Double click edit ─────────────────────────────────────────────────────────
function onDoubleClick(params) {
  if (params.nodes.length === 1) openEditNodeModal(params.nodes[0]);
  else if (params.edges.length === 1) openEditEdgeModal(params.edges[0]);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (id === 'node-modal') {
    if (currentEditingNodeId) { releaseLock(currentEditingNodeId); currentEditingNodeId = null; }
    if (pendingNodeCallback) { pendingNodeCallback(null); pendingNodeCallback = null; }
  }
  if (id === 'edge-modal') {
    if (currentEditingEdgeId) { releaseLock(currentEditingEdgeId); currentEditingEdgeId = null; }
    if (pendingEdgeCallback) { pendingEdgeCallback(null); pendingEdgeCallback = null; }
  }
}

function addPropRow(editorId, key = '', val = '', schema = null) {
  const editor = document.getElementById(editorId);
  const row = document.createElement('div');
  row.className = 'prop-edit-row';

  const isRequired = schema && schema.required;
  const hasEnum    = schema && schema.enum_values && schema.enum_values.length > 0;
  const isList     = schema && schema.prop_type === 'list';
  const tip        = schema && schema.description ? ` title="${schema.description}"` : '';

  if (isList) row.dataset.propType = 'list';

  // Normalize display value for list type
  const displayVal = isList
    ? (Array.isArray(val) ? val.join(', ') : String(val === '' ? '' : val))
    : String(val);

  let valHtml;
  if (hasEnum) {
    const opts = schema.enum_values.map(v =>
      `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${v}</option>`
    ).join('');
    valHtml = `<select class="prop-val-input">${opts}</select>`;
  } else if (isList) {
    valHtml = `<input type="text" placeholder="用逗号分隔，如: 手机, 移动电话" value="${displayVal}" class="prop-val-input" style="font-style:italic" />`;
  } else {
    valHtml = `<input type="text" placeholder="值" value="${displayVal}" class="prop-val-input" />`;
  }

  const keyStyle = isRequired ? 'font-weight:600;color:var(--accent)' : '';
  const delBtn   = isRequired
    ? `<button class="prop-del-btn" disabled style="opacity:.3" title="必填项">×</button>`
    : `<button class="prop-del-btn" onclick="this.parentElement.remove()">×</button>`;

  row.innerHTML = `
    <input type="text" placeholder="键" value="${key}" class="prop-key-input"
      ${isRequired ? 'readonly' : ''} style="${keyStyle}"${tip} />
    ${valHtml}
    ${delBtn}
  `;
  editor.appendChild(row);
}

function collectProps(editorId) {
  const props = {};
  document.querySelectorAll(`#${editorId} .prop-edit-row`).forEach(row => {
    const k = row.querySelector('.prop-key-input').value.trim();
    const valEl = row.querySelector('.prop-val-input');
    const v = valEl ? valEl.value.trim() : '';
    if (k) {
      if (row.dataset.propType === 'list') {
        props[k] = v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
      } else {
        props[k] = v;
      }
    }
  });
  return props;
}

function clearPropsEditor(editorId) {
  document.getElementById(editorId).innerHTML = '';
}

// ── Create node ───────────────────────────────────────────────────────────────
async function openCreateNodeModal() {
  document.getElementById('node-modal-title').textContent = '新建节点';
  document.getElementById('node-labels').value = '';
  // Populate datalist from ontology class definitions
  const dl = document.getElementById('node-labels-list');
  dl.innerHTML = ontology.classes.map(c =>
    `<option value="${c.label_name}">${c.display_name || c.label_name}</option>`
  ).join('');
  clearPropsEditor('node-props-editor');
  addPropRow('node-props-editor', 'name', '');
  document.getElementById('node-modal').classList.remove('hidden');
  document.getElementById('node-modal-save').onclick = saveNewNode;
  document.getElementById('node-labels').focus();
}

// Rebuild props editor when user changes labels (debounced)
let _labelChangeTimer;
document.addEventListener('DOMContentLoaded', () => {
  const labelsInput = document.getElementById('node-labels');
  if (labelsInput) {
    labelsInput.addEventListener('input', () => {
      clearTimeout(_labelChangeTimer);
      _labelChangeTimer = setTimeout(async () => {
        const labels = labelsInput.value.split(',').map(l => l.trim()).filter(Boolean);
        if (!labels.length) return;
        const current = collectProps('node-props-editor');
        await buildSchemaEditor('node-props-editor', 'node', labels, current);
      }, 600);
    });
  }
});

async function saveNewNode() {
  const labelsRaw = document.getElementById('node-labels').value.trim();
  const labels = labelsRaw ? labelsRaw.split(',').map(l => l.trim()).filter(Boolean) : ['Node'];
  if (!checkOntologyLabels(labels) ) return;
  const properties = collectProps('node-props-editor');
  try {
    const n = await api('POST', '/nodes', { labels, properties });
    visNodes.add(makeVisNode(n));
    updateStats(); updateEmptyState();
    closeModal('node-modal');
    toast('✅ 节点已创建');
    refreshLabels();
    setTimeout(() => { network.selectNodes([n.id]); network.focus(n.id, { animation: true, scale: 1.2 }); showNodeInspector(n); graph3dFocusNode(n.id); }, 100);
  } catch {}
}

// ── Edit node ─────────────────────────────────────────────────────────────────
async function openEditNodeModal(nodeId) {
  const lk = lockedEntities.get(nodeId);
  if (lk) { toast(`🔒 该节点正在被「${lk.username}」编辑`, 'err'); return; }

  const acquired = await acquireLock(nodeId);
  if (!acquired) return;
  currentEditingNodeId = nodeId;

  const visNode = visNodes.get(nodeId);
  if (!visNode) { releaseLock(nodeId); currentEditingNodeId = null; return; }
  const n = visNode._data;

  document.getElementById('node-modal-title').textContent = '编辑节点';
  document.getElementById('node-labels').value = (n.labels || []).join(', ');
  await buildSchemaEditor('node-props-editor', 'node', n.labels || [], n.properties || {});
  document.getElementById('node-modal').classList.remove('hidden');
  document.getElementById('node-modal-save').onclick = () => saveEditNode(nodeId);
}

async function saveEditNode(nodeId) {
  const labelsRaw = document.getElementById('node-labels').value.trim();
  const labels = labelsRaw ? labelsRaw.split(',').map(l => l.trim()).filter(Boolean) : ['Node'];
  if (!checkOntologyLabels(labels)) return;
  const properties = collectProps('node-props-editor');
  try {
    const n = await api('PUT', `/nodes/${nodeId}`, { labels, properties });
    visNodes.update(makeVisNode(n));
    currentEditingNodeId = null;  // prevent closeModal from double-releasing
    releaseLock(nodeId);
    closeModal('node-modal');
    toast('✅ 节点已更新');
    showNodeInspector(n);
    refreshLabels();
  } catch {}
}

// ── Delete node ───────────────────────────────────────────────────────────────
async function deleteNode(nodeId) {
  const lk = lockedEntities.get(nodeId);
  if (lk) { toast(`🔒 该节点正在被「${lk.username}」编辑，无法删除`, 'err'); return; }
  if (!confirm('确定删除这个节点及其所有关系吗？')) return;
  try {
    await api('DELETE', `/nodes/${nodeId}`);
    const connectedEdges = _getConnectedEdges(nodeId);
    visEdges.remove(connectedEdges);
    visNodes.remove(nodeId);
    hideInspector(); updateStats(); updateEmptyState();
    toast('✅ 节点已删除');
    refreshLabels(); renderRelTypeList();
  } catch {}
}

async function deleteSelected() {
  if (!selectedNodeIds.length) return;
  const locked = selectedNodeIds.filter(id => lockedEntities.has(id));
  if (locked.length) { toast(`🔒 ${locked.length} 个节点正被编辑，无法删除`, 'err'); return; }
  if (!confirm(`确定删除选中的 ${selectedNodeIds.length} 个节点吗？`)) return;
  try {
    for (const id of selectedNodeIds) {
      await api('DELETE', `/nodes/${id}`);
      visEdges.remove(_getConnectedEdges(id));
    }
    visNodes.remove(selectedNodeIds);
    hideInspector(); updateStats(); updateEmptyState();
    toast(`✅ 已删除 ${selectedNodeIds.length} 个节点`);
    refreshLabels(); renderRelTypeList();
  } catch {}
}

// ── Create edge ───────────────────────────────────────────────────────────────
async function openCreateEdgeModal() {
  if (selectedNodeIds.length !== 2) { toast('⚠️ 请先选中两个节点（按住 Ctrl 多选）', 'err'); return; }
  document.getElementById('edge-modal-title').textContent = '新建关系';
  await Promise.all([loadOntology(), loadSchemasCache(), loadRelTypes()]);

  // Determine valid rel_types from ontology based on selected node labels
  const srcNode = visNodes.get(selectedNodeIds[0]);
  const tgtNode = visNodes.get(selectedNodeIds[1]);
  const srcLabels = srcNode ? (srcNode._data.labels || []) : [];
  const tgtLabels = tgtNode ? (tgtNode._data.labels || []) : [];
  const validTypes = getValidRelTypes(srcLabels, tgtLabels);

  if (validTypes !== null && !validTypes.length) {
    toast('⚠️ 本体中没有这两类节点之间允许的关系类型', 'err');
  }

  // Pass ontology-valid types directly to setupEdgeTypeField so they appear as a select
  const initialType = setupEdgeTypeField('', validTypes);
  if (initialType) {
    await buildSchemaEditor('edge-props-editor', 'edge', [initialType], {});
  } else {
    clearPropsEditor('edge-props-editor');
  }
  document.getElementById('edge-modal').classList.remove('hidden');
  document.getElementById('edge-modal-save').onclick = () => saveNewEdge(selectedNodeIds[0], selectedNodeIds[1], srcLabels, tgtLabels);
}

// ── Create linked node ────────────────────────────────────────────────────────
let _lnSourceId = null;
let _lnNodeLabelTimer, _lnRelTypeTimer;

async function openCreateLinkedNodeModal(nodeId) {
  _lnSourceId = nodeId;
  await Promise.all([loadOntology(), loadSchemasCache()]);

  document.getElementById('ln-labels-list').innerHTML = ontology.classes.map(c =>
    `<option value="${c.label_name}">${c.display_name || c.label_name}</option>`
  ).join('');

  document.getElementById('ln-direction').value = 'out';
  document.getElementById('ln-node-labels').value = '';
  clearPropsEditor('ln-node-props-editor');
  addPropRow('ln-node-props-editor', 'name', '');

  _lnUpdateRelTypes();

  document.getElementById('ln-node-labels').oninput = () => {
    _lnUpdateRelTypes(); // immediate: rel types depend on node label
    clearTimeout(_lnNodeLabelTimer);
    _lnNodeLabelTimer = setTimeout(async () => {
      const labels = document.getElementById('ln-node-labels').value.split(',').map(l => l.trim()).filter(Boolean);
      if (labels.length) {
        const cur = collectProps('ln-node-props-editor');
        await buildSchemaEditor('ln-node-props-editor', 'node', labels, cur);
      }
    }, 400);
  };

  document.getElementById('ln-save').onclick = saveLinkedNode;
  document.getElementById('linked-node-modal').classList.remove('hidden');
  document.getElementById('ln-node-labels').focus();
}

function onLnDirectionChange() { _lnUpdateRelTypes(); }

function _lnUpdateRelTypes() {
  const direction = document.getElementById('ln-direction').value;
  const srcNode = visNodes.get(_lnSourceId);
  const nodeLabels = srcNode ? (srcNode._data.labels || []) : [];
  const newLabels = (document.getElementById('ln-node-labels').value || '')
    .split(',').map(l => l.trim()).filter(Boolean);

  // Get valid types: filter ontology by current node side; optionally also filter by new node side
  let validTypes = null;
  if (ontology.relations.length) {
    const valid = new Set();
    ontology.relations.forEach(r => {
      const myOk = direction === 'out'
        ? (r.source_label === '*' || nodeLabels.some(l => l === r.source_label))
        : (r.target_label === '*' || nodeLabels.some(l => l === r.target_label));
      if (!myOk) return;
      if (newLabels.length) {
        const otherOk = direction === 'out'
          ? (r.target_label === '*' || newLabels.some(l => l === r.target_label))
          : (r.source_label === '*' || newLabels.some(l => l === r.source_label));
        if (!otherOk) return;
      }
      valid.add(r.rel_type);
    });
    validTypes = [...valid];
    // If filtering by new labels makes it empty, fall back to just filtering by current node
    if (!validTypes.length && newLabels.length) {
      ontology.relations.forEach(r => {
        const myOk = direction === 'out'
          ? (r.source_label === '*' || nodeLabels.some(l => l === r.source_label))
          : (r.target_label === '*' || nodeLabels.some(l => l === r.target_label));
        if (myOk) valid.add(r.rel_type);
      });
      validTypes = [...valid];
    }
  }

  const wrap = document.getElementById('ln-rel-type-wrap');
  const prevType = document.getElementById('ln-rel-type') ? document.getElementById('ln-rel-type').value : '';

  if (validTypes && validTypes.length) {
    const selected = validTypes.includes(prevType) ? prevType : validTypes[0];
    const opts = validTypes.map(v =>
      `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`
    ).join('');
    wrap.innerHTML = `<label>关系类型</label><select id="ln-rel-type">${opts}</select>`;
    document.getElementById('ln-rel-type').addEventListener('change', async () => {
      const type = document.getElementById('ln-rel-type').value;
      if (type) await buildSchemaEditor('ln-edge-props-editor', 'edge', [type], collectProps('ln-edge-props-editor'));
    });
    buildSchemaEditor('ln-edge-props-editor', 'edge', [selected], collectProps('ln-edge-props-editor'));
  } else {
    wrap.innerHTML = `<label>关系类型</label><input type="text" id="ln-rel-type" placeholder="例: KNOWS" value="${prevType}" />`;
    document.getElementById('ln-rel-type').addEventListener('input', () => {
      clearTimeout(_lnRelTypeTimer);
      _lnRelTypeTimer = setTimeout(async () => {
        const type = document.getElementById('ln-rel-type').value.trim().toUpperCase();
        if (type) await buildSchemaEditor('ln-edge-props-editor', 'edge', [type], collectProps('ln-edge-props-editor'));
      }, 400);
    });
    if (prevType) buildSchemaEditor('ln-edge-props-editor', 'edge', [prevType], collectProps('ln-edge-props-editor'));
    else clearPropsEditor('ln-edge-props-editor');
  }
}

async function saveLinkedNode() {
  const labelsRaw = document.getElementById('ln-node-labels').value.trim();
  const labels = labelsRaw ? labelsRaw.split(',').map(l => l.trim()).filter(Boolean) : ['Node'];
  if (!checkOntologyLabels(labels)) return;

  const relTypeEl = document.getElementById('ln-rel-type');
  const relType = (relTypeEl ? relTypeEl.value.trim().toUpperCase() : '') || 'RELATES_TO';
  const direction = document.getElementById('ln-direction').value;

  const srcNode = visNodes.get(_lnSourceId);
  const srcLabels = srcNode ? (srcNode._data.labels || []) : [];
  if (direction === 'out') { if (!checkOntologyTriple(srcLabels, relType, labels)) return; }
  else                     { if (!checkOntologyTriple(labels, relType, srcLabels)) return; }

  const nodeProps = collectProps('ln-node-props-editor');
  const edgeProps = collectProps('ln-edge-props-editor');
  try {
    const result = await api('POST', '/linked-node', {
      labels, properties: nodeProps,
      source_id: _lnSourceId, direction,
      rel_type: relType, rel_properties: edgeProps,
    });
    const { node: newNode, edge } = result;

    const srcPos = network ? network.getPosition(_lnSourceId) : null;
    const newVisNode = makeVisNode(newNode);
    if (srcPos) {
      const angle = Math.random() * 2 * Math.PI;
      const dist = 150 + Math.random() * 50;
      newVisNode.x = srcPos.x + Math.cos(angle) * dist;
      newVisNode.y = srcPos.y + Math.sin(angle) * dist;
    }
    visNodes.add(newVisNode);
    visEdges.add(makeVisEdge(edge));

    updateStats();
    closeModal('linked-node-modal');
    toast('✅ 关联节点已创建');
    network.selectNodes([newNode.id]);
    setTimeout(() => { network.focus(newNode.id, { scale: 1.2, animation: true }); graph3dFocusNode(newNode.id); }, 100);
  } catch (e) { toast('创建失败: ' + (e.message || e), 'err'); }
}

async function loadRelTypes() {
  try {
    window._cachedRelTypes = await api('GET', '/relationship-types');
    const dl = document.getElementById('rel-types-list');
    if (dl) dl.innerHTML = window._cachedRelTypes.map(t => `<option value="${t}">`).join('');
  } catch {}
}

async function saveNewEdge(sourceId, targetId, srcLabels = [], tgtLabels = []) {
  const typeEl = document.getElementById('edge-type');
  const type = (typeEl ? typeEl.value.trim().toUpperCase() : '') || 'RELATES_TO';
  if (!checkOntologyTriple(srcLabels, type, tgtLabels)) return;
  const properties = collectProps('edge-props-editor');
  try {
    const e = await api('POST', '/relationships/by-element-id?' +
      new URLSearchParams({ source_element_id: sourceId, target_element_id: targetId, type }));
    // Also patch properties if any
    if (Object.keys(properties).length) {
      await api('PUT', `/relationships/${e.id}`, { properties });
    }
    const final = Object.keys(properties).length ? { ...e, properties } : e;
    visEdges.add(makeVisEdge(final));
    updateStats();
    renderRelTypeList();
    closeModal('edge-modal');
    toast('✅ 关系已创建');
  } catch {}
}

// ── Edit edge ─────────────────────────────────────────────────────────────────
async function openEditEdgeModal(edgeId) {
  const lk = lockedEntities.get(edgeId);
  if (lk) { toast(`🔒 该关系正在被「${lk.username}」编辑`, 'err'); return; }

  const acquired = await acquireLock(edgeId);
  if (!acquired) return;
  currentEditingEdgeId = edgeId;

  const visEdge = visEdges.get(edgeId);
  if (!visEdge) { releaseLock(edgeId); currentEditingEdgeId = null; return; }
  const e = visEdge._data;

  document.getElementById('edge-modal-title').textContent = '编辑关系';
  await Promise.all([loadOntology(), loadSchemasCache(), loadRelTypes()]);
  setupEdgeTypeField(e.type || '');
  await buildSchemaEditor('edge-props-editor', 'edge', [e.type || ''], e.properties || {});
  document.getElementById('edge-modal').classList.remove('hidden');
  document.getElementById('edge-modal-save').onclick = () => saveEditEdge(edgeId);
}

async function saveEditEdge(edgeId) {
  const properties = collectProps('edge-props-editor');
  try {
    const e = await api('PUT', `/relationships/${edgeId}`, { properties });
    visEdges.update(makeVisEdge(e));
    currentEditingEdgeId = null;
    releaseLock(edgeId);
    closeModal('edge-modal');
    toast('✅ 关系已更新');
    showEdgeInspector(e);
  } catch {}
}

// ── Delete edge ───────────────────────────────────────────────────────────────
async function deleteEdge(edgeId) {
  const lk = lockedEntities.get(edgeId);
  if (lk) { toast(`🔒 该关系正在被「${lk.username}」编辑，无法删除`, 'err'); return; }
  if (!confirm('确定删除这条关系吗？')) return;
  try {
    await api('DELETE', `/relationships/${edgeId}`);
    visEdges.remove(edgeId);
    hideInspector(); updateStats();
    renderRelTypeList();
    toast('✅ 关系已删除');
  } catch {}
}

// ── Delete selected (keyboard) ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    if (selectedNodeIds.length) deleteSelected();
    else if (selectedEdgeIds.length === 1) deleteEdge(selectedEdgeIds[0]);
  }
  if (e.key === 'Escape') { closeModal('node-modal'); closeModal('edge-modal'); }
});

// Auth overlay keyboard
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { document.getElementById('search-results').classList.add('hidden'); return; }
  searchTimer = setTimeout(() => doSearch(q), 300);
});

document.getElementById('search-input').addEventListener('blur', () => {
  setTimeout(() => document.getElementById('search-results').classList.add('hidden'), 200);
});

async function doSearch(q) {
  try {
    const results = await api('GET', `/search?q=${encodeURIComponent(q)}&limit=20`);
    const el = document.getElementById('search-results');
    if (!results.length) {
      el.innerHTML = '<div class="search-result-item" style="color:var(--text-muted)">无结果</div>';
    } else {
      el.innerHTML = results.map(n => {
        const color = getLabelColor(n.labels[0] || 'Node');
        return `<div class="search-result-item" onclick="focusNode('${n.id}')">
          <span class="result-label-tag" style="background:${color}33;color:${color}">${n.labels[0] || 'Node'}</span>
          <span class="result-name">${nodeLabel(n)}</span>
        </div>`;
      }).join('');
    }
    el.classList.remove('hidden');
  } catch {}
}

async function focusNode(nodeId) {
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-input').value = '';
  if (!visNodes.get(nodeId)) {
    try {
      const data = await api('GET', `/node-neighbors/${nodeId}`);
      const newNodes = data.nodes.filter(n => !visNodes.get(n.id));
      const newEdges = data.edges.filter(e => !visEdges.get(e.id));
      if (newNodes.length) visNodes.add(newNodes.map(makeVisNode));
      if (newEdges.length) visEdges.add(newEdges.map(makeVisEdge));
      updateStats(); updateEmptyState();
    } catch {}
  }
  if (visNodes.get(nodeId)) {
    network.selectNodes([nodeId]);
    network.focus(nodeId, { animation: { duration: 500 }, scale: 1.3 });
    graph3dFocusNode(nodeId);
    const n = visNodes.get(nodeId);
    if (n) showNodeInspector(n._data);
  }
}


// ── Schema management ─────────────────────────────────────────────────────────

async function loadSchemasCache() {
  try { schemasCache = await api('GET', '/schemas'); } catch { schemasCache = []; }
}

function getSchemaFor(entityType, entityLabel, propKey) {
  // exact label match first, then '*'
  return schemasCache.find(s => s.entity_type === entityType && s.entity_label === entityLabel && s.prop_key === propKey)
      || schemasCache.find(s => s.entity_type === entityType && s.entity_label === '*' && s.prop_key === propKey)
      || null;
}

function getSchemasFor(entityType, entityLabel) {
  return schemasCache.filter(s =>
    s.entity_type === entityType && (s.entity_label === entityLabel || s.entity_label === '*')
  );
}

// ── Schema-aware prop editor ───────────────────────────────────────────────────

// Render props editor with schema awareness
async function buildSchemaEditor(editorId, entityType, entityLabels, existingProps) {
  clearPropsEditor(editorId);
  await loadSchemasCache();

  const applicable = getSchemasForLabels(entityType, entityLabels)
    .filter(s => s.prop_key !== '__rel_type__');
  const schemaByKey = {};
  applicable.forEach(s => { schemaByKey[s.prop_key] = s; });

  // Existing props first
  const added = new Set();
  for (const [k, v] of Object.entries(existingProps)) {
    addPropRow(editorId, k, String(v), schemaByKey[k] || null);
    added.add(k);
  }
  // All schema-defined props not yet present
  for (const s of applicable) {
    if (!added.has(s.prop_key)) {
      addPropRow(editorId, s.prop_key, s.default_val || '', s);
    }
  }
}

function getSchemasForLabels(entityType, entityLabels) {
  const result = [], seen = new Set();
  for (const lbl of entityLabels) {
    for (const s of schemasCache) {
      if (s.entity_type === entityType && (s.entity_label === lbl || s.entity_label === '*')) {
        if (!seen.has(s.prop_key)) { result.push(s); seen.add(s.prop_key); }
      }
    }
  }
  return result;
}

// Set edge-type field: select if ontology types or __rel_type__ schema available, otherwise plain input
// ontologyTypes: string[] | null  (null = no constraint; [] = no valid types; [...] = constrained list)
let _edgeTypeTimer;
function setupEdgeTypeField(currentType, ontologyTypes) {
  const wrap = document.getElementById('edge-type-wrap');

  // Priority: ontology-valid types > __rel_type__ enum schema > free text input
  let selectOptions = null;
  if (ontologyTypes && ontologyTypes.length > 0) {
    selectOptions = ontologyTypes;
  } else {
    const relTypeSchema = schemasCache.find(s =>
      s.entity_type === 'edge' && s.prop_key === '__rel_type__' && s.enum_values.length > 0
    );
    if (relTypeSchema) selectOptions = relTypeSchema.enum_values;
  }

  const isSelect = !!selectOptions;
  if (isSelect) {
    const opts = selectOptions.map(v =>
      `<option value="${v}" ${v === currentType ? 'selected' : ''}>${v}</option>`
    ).join('');
    wrap.innerHTML = `<select id="edge-type">${opts}</select>`;
  } else {
    const types = (ontologyTypes === null ? (window._cachedRelTypes || []) : []);
    const dl = types.map(t => `<option value="${t}">`).join('');
    wrap.innerHTML = `
      <input type="text" id="edge-type" placeholder="例: KNOWS, WORKS_AT" value="${currentType}" list="rel-types-list" />
      <datalist id="rel-types-list">${dl}</datalist>`;
  }
  const el = document.getElementById('edge-type');
  if (isSelect) {
    el.addEventListener('change', async () => {
      const type = el.value;
      if (type) await buildSchemaEditor('edge-props-editor', 'edge', [type], collectProps('edge-props-editor'));
    });
  } else {
    el.addEventListener('input', () => {
      clearTimeout(_edgeTypeTimer);
      _edgeTypeTimer = setTimeout(async () => {
        const type = el.value.trim().toUpperCase();
        if (type) await buildSchemaEditor('edge-props-editor', 'edge', [type], collectProps('edge-props-editor'));
      }, 400);
    });
  }
  return el.value;
}

// ── Button bindings ───────────────────────────────────────────────────────────
document.getElementById('btn-add-node').onclick = openCreateNodeModal;
document.getElementById('btn-add-edge').onclick = openCreateEdgeModal;
document.getElementById('btn-delete').onclick = () => {
  if (selectedNodeIds.length) deleteSelected();
  else if (selectedEdgeIds.length === 1) deleteEdge(selectedEdgeIds[0]);
  else toast('⚠️ 请先选中要删除的元素', 'err');
};
document.getElementById('btn-fit').onclick = () => {
  if (is3DMode) { graph3d && graph3d.zoomToFit(400, 20); }
  else { network && network.fit({ animation: true }); }
};
document.getElementById('btn-layout').onclick = async () => {
  if (is3DMode) {
    if (!graph3d) return;
    // Restart 3D force simulation
    const data = graph3d.graphData();
    data.nodes.forEach(n => { delete n.fx; delete n.fy; delete n.fz; delete n.x; delete n.y; delete n.z; });
    graph3d.graphData({ nodes: [...data.nodes], links: [...data.links] });
    graph3d.zoomToFit(800, 20);
    return;
  }
  if (!network) return;
  await clearNodePositions();
  const updates = visNodes.getIds().map(id => ({ id, physics: true }));
  if (updates.length) visNodes.update(updates);
  network.setOptions({ physics: { enabled: true } });
  setTimeout(() => {
    network.setOptions({ physics: { enabled: false } });
    saveNodePositions();
  }, PHYSICS_SETTLE_MS);
};
document.getElementById('btn-zoom-in').onclick = () => {
  if (is3DMode) {
    if (!graph3d) return;
    const cam = graph3d.camera(); const p = cam.position;
    graph3d.cameraPosition({ x: p.x * 0.7, y: p.y * 0.7, z: p.z * 0.7 }, undefined, 200);
  } else { network && network.moveTo({ scale: network.getScale() * 1.3, animation: true }); }
};
document.getElementById('btn-zoom-out').onclick = () => {
  if (is3DMode) {
    if (!graph3d) return;
    const cam = graph3d.camera(); const p = cam.position;
    graph3d.cameraPosition({ x: p.x * 1.4, y: p.y * 1.4, z: p.z * 1.4 }, undefined, 200);
  } else { network && network.moveTo({ scale: network.getScale() * 0.77, animation: true }); }
};
document.getElementById('inspector-close').onclick = () => {
  hideInspector();
  if (is3DMode) { _3dClearSelection(); }
  else { network && network.unselectAll(); }
};

// ── Export / Import ───────────────────────────────────────────────────────────
let _importPayload = null;

document.getElementById('btn-export').onclick = async () => {
  const btn = document.getElementById('btn-export');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const data = await api('GET', '/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    a.href = url; a.download = `neo4j_export_${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ 导出成功：${data.graph.nodes.length} 节点, ${data.graph.edges.length} 关系`);
  } catch (e) {
    toast(`❌ 导出失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '⬇ 导出';
  }
};

document.getElementById('btn-import').onclick = () => {
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-input').click();
};

document.getElementById('import-file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version || !data.graph) throw new Error('文件格式不正确');
    _importPayload = data;
    const schemaCount =
      (data.schemas?.property_schemas?.length || 0) +
      (data.schemas?.class_schemas?.length || 0) +
      (data.schemas?.relation_schemas?.length || 0);
    document.getElementById('import-filename').textContent = file.name;
    document.getElementById('import-stat-nodes').textContent   = data.graph.nodes?.length || 0;
    document.getElementById('import-stat-edges').textContent   = data.graph.edges?.length || 0;
    document.getElementById('import-stat-schemas').textContent = schemaCount;
    document.getElementById('import-modal').classList.remove('hidden');
  } catch (err) {
    toast(`❌ 文件解析失败：${err.message}`, 'err');
  }
};

async function confirmImport() {
  if (!_importPayload) return;
  const btn = document.getElementById('import-confirm-btn');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const result = await api('POST', '/import', _importPayload);
    closeModal('import-modal');
    _importPayload = null;
    _allPositions = {};
    toast(`✅ 导入完成：${result.imported_nodes} 节点, ${result.imported_edges} 关系`);
    await loadGraph();
  } catch (e) {
    toast(`❌ 导入失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.textContent = '确认导入';
  }
}

// ── History button binding ────────────────────────────────────────────────────
document.getElementById('btn-history').onclick = openHistoryModal;

// ── Modal overlay click-to-close ──────────────────────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  if (!authToken) return; // stay on auth overlay
  // Validate token
  try {
    const res = await fetch(API + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    if (!res.ok) { localStorage.removeItem('auth_token'); authToken = null; return; }
    const data = await res.json();
    currentUser = { username: data.username, role: data.role };
    document.getElementById('auth-overlay').classList.add('hidden');
    initUserUI();
    connectWS();
    initNetwork();
    refreshLabels();
    loadOntology();
    loadWorkspaces().then(() => loadCurrentView());
  } catch {
    // Server might be starting up — stay on overlay
    localStorage.removeItem('auth_token');
    authToken = null;
  }
}

init();
setViewMode(false);
