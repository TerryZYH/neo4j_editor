// ── Selection ─────────────────────────────────────────────────────────────────
function onSelectNode(params) {
  selectedNodeIds = params.nodes;
  selectedEdgeIds = [];
  if (params.nodes.length === 1) {
    const n = visNodes.get(params.nodes[0]);
    if (n) showNodeInspector(n._data);
  } else if (params.nodes.length > 1) {
    showMultiInspector(params.nodes.length, 0);
  }
}

function onSelectEdge(params) {
  selectedEdgeIds = params.edges;
  selectedNodeIds = [];
  if (params.edges.length === 1) {
    const e = visEdges.get(params.edges[0]);
    if (e) showEdgeInspector(e._data);
  }
}

function onDeselect() {
  selectedNodeIds = [];
  selectedEdgeIds = [];
  hideInspector();
}

// ── Inspector ─────────────────────────────────────────────────────────────────
function showNodeInspector(n) {
  _inspectorNodeId = n.id;

  document.getElementById('inspector-icon').textContent = '📦';
  document.getElementById('inspector-title').textContent = nodeLabel(n);

  _renderNodePropsTab(n);
  document.getElementById('inspector').classList.remove('hidden');
}

function _renderNodePropsTab(n) {
  const body   = document.getElementById('inspector-body');
  const footer = document.getElementById('inspector-footer');
  const lk     = lockedEntities.get(n.id);
  const inWs   = currentWorkspace && workspaceNodeIds.has(n.id);

  const labelTags = (n.labels || []).map(l =>
    `<span class="tag" style="background:${getLabelColor(l)}22;color:${getLabelColor(l)};border:1px solid ${getLabelColor(l)}44">${l}</span>`
  ).join('');

  const propsHtml = Object.entries(n.properties || {}).map(([k, v]) => {
    const valHtml = Array.isArray(v)
      ? (v.length ? v.map(item => `<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 7px;margin:2px 3px 0 0;font-size:12px">${item}</span>`).join('') : '<span style="color:var(--text-muted);font-size:12px;">（空列表）</span>')
      : v;
    return `<div class="prop-row"><div class="prop-key">${k}</div><div class="prop-val">${valHtml}</div></div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:12px;">无属性</div>';

  body.innerHTML = `
    ${lk ? `<div id="inspector-lock-notice" class="lock-notice">🔒 正在被「${lk.username}」编辑，暂不可修改</div>` : ''}
    ${currentWorkspace && !inWs ? `<div class="lock-notice" style="background:#58a6ff15;border-color:#58a6ff40;color:#58a6ff">此节点不在当前工作空间</div>` : ''}
    <div class="prop-section"><div class="prop-section-title">标签</div><div class="tag-list">${labelTags}</div></div>
    <div class="prop-section"><div class="prop-section-title">属性</div>${propsHtml}</div>
    <div class="prop-section"><div class="prop-section-title">ID</div><div class="prop-val" style="font-size:11px;word-break:break-all">${n.id}</div></div>
  `;

  const disabled = lk ? 'disabled style="opacity:.4"' : '';
  const wsBtn = currentWorkspace
    ? (inWs
        ? `<button class="btn" onclick="removeNodeFromWorkspace('${n.id}')" style="font-size:12px">移出空间</button>`
        : `<button class="btn primary" onclick="addNodeToWorkspace('${n.id}')" style="font-size:12px">加入空间</button>`)
    : '';
  footer.innerHTML = `
    ${wsBtn}
    <button class="btn primary" onclick="openCreateLinkedNodeModal('${n.id}')">＋ 关联</button>
    <button class="btn" onclick="openEditNodeModal('${n.id}')" ${disabled}>✏️</button>
    <button class="btn danger" onclick="deleteNode('${n.id}')" ${disabled}>🗑</button>
  `;
}

function showEdgeInspector(e) {
  document.getElementById('inspector-icon').textContent = '🔗';
  document.getElementById('inspector-title').textContent = e.type;

  const body   = document.getElementById('inspector-body');
  const footer = document.getElementById('inspector-footer');
  const lk = lockedEntities.get(e.id);

  const propsHtml = Object.entries(e.properties || {}).map(([k, v]) => {
    const valHtml = Array.isArray(v)
      ? (v.length ? v.map(item => `<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 7px;margin:2px 3px 0 0;font-size:12px">${item}</span>`).join('') : '<span style="color:var(--text-muted);font-size:12px;">（空列表）</span>')
      : v;
    return `<div class="prop-row"><div class="prop-key">${k}</div><div class="prop-val">${valHtml}</div></div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:12px;">无属性</div>';

  body.innerHTML = `
    ${lk ? `<div id="inspector-lock-notice" class="lock-notice">🔒 正在被「${lk.username}」编辑，暂不可修改</div>` : ''}
    <div class="prop-section"><div class="prop-section-title">关系类型</div>
      <span class="tag" style="background:#58a6ff22;color:#58a6ff;border:1px solid #58a6ff44">${e.type}</span>
    </div>
    <div class="prop-section"><div class="prop-section-title">属性</div>${propsHtml}</div>
  `;

  const disabled = lk ? 'disabled style="opacity:.4"' : '';
  footer.innerHTML = `
    <button class="btn" onclick="openEditEdgeModal('${e.id}')" ${disabled}>✏️ 编辑</button>
    <button class="btn danger" onclick="deleteEdge('${e.id}')" ${disabled}>🗑 删除</button>
  `;

  document.getElementById('inspector').classList.remove('hidden');
}

function showMultiInspector(nodeCount) {
  document.getElementById('inspector-icon').textContent = '☰';
  document.getElementById('inspector-title').textContent = '多选';
  document.getElementById('inspector-body').innerHTML =
    `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">已选中 ${nodeCount} 个节点</div>`;
  document.getElementById('inspector-footer').innerHTML =
    `<button class="btn danger" onclick="deleteSelected()">🗑 批量删除</button>`;
  document.getElementById('inspector').classList.remove('hidden');
}

function hideInspector() {
  document.getElementById('inspector').classList.add('hidden');
}
