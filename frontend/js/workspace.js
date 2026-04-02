// ── Workspace functions ────────────────────────────────────────────────────────

async function loadWorkspaces() {
  try {
    _workspaces = await api('GET', '/workspaces');
    _renderWorkspaceSelect();
  } catch { _workspaces = []; }
}

function _renderWorkspaceSelect() {
  const sel = document.getElementById('workspace-select');
  const current = currentWorkspace ? String(currentWorkspace.id) : '';
  sel.innerHTML = '<option value="">全图模式</option>' +
    _workspaces.map(w =>
      `<option value="${w.id}" ${String(w.id) === current ? 'selected' : ''}>` +
      `${w.name} (${w.node_count ?? 0}节点)</option>`
    ).join('');
}

async function onWorkspaceSelectChange(val) {
  if (!val) {
    currentWorkspace = null;
    workspaceNodeIds = new Set();
    document.getElementById('ws-controls').style.display = 'none';
    await loadGraph();
  } else {
    const ws = _workspaces.find(w => String(w.id) === val);
    if (!ws) return;
    currentWorkspace = { id: ws.id, name: ws.name };
    document.getElementById('ws-controls').style.display = 'flex';
    await loadWorkspaceGraph(ws.id);
  }
  hideInspector();
}

function openCreateWorkspaceModal() {
  document.getElementById('ws-name-input').value = '';
  document.getElementById('ws-create-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('ws-name-input').focus(), 50);
}

async function createWorkspace() {
  const name = document.getElementById('ws-name-input').value.trim();
  if (!name) { toast('请输入工作空间名称', 'err'); return; }
  try {
    const ws = await api('POST', '/workspaces', { name });
    _workspaces.unshift({ ...ws });
    currentWorkspace = { id: ws.id, name: ws.name };
    workspaceNodeIds = new Set();
    _renderWorkspaceSelect();
    document.getElementById('ws-controls').style.display = 'flex';
    closeModal('ws-create-modal');
    visNodes.clear(); visEdges.clear();
    updateStats(); updateEmptyState();
    toast(`✅ 工作空间「${name}」已创建，使用「按条件筛选加入」或搜索节点后加入`);
  } catch {}
}

function renameCurrentWorkspace() {
  if (!currentWorkspace) return;
  document.getElementById('ws-rename-input').value = currentWorkspace.name;
  document.getElementById('ws-rename-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('ws-rename-input').focus(), 50);
}

async function confirmRenameWorkspace() {
  const name = document.getElementById('ws-rename-input').value.trim();
  if (!name || !currentWorkspace) return;
  try {
    await api('PUT', `/workspaces/${currentWorkspace.id}`, { name });
    currentWorkspace.name = name;
    const ws = _workspaces.find(w => w.id === currentWorkspace.id);
    if (ws) ws.name = name;
    _renderWorkspaceSelect();
    closeModal('ws-rename-modal');
    toast(`✅ 已重命名为「${name}」`);
  } catch {}
}

async function deleteCurrentWorkspace() {
  if (!currentWorkspace) return;
  if (!confirm(`确认删除工作空间「${currentWorkspace.name}」？\n图谱数据不受影响。`)) return;
  try {
    await api('DELETE', `/workspaces/${currentWorkspace.id}`);
    _workspaces = _workspaces.filter(w => w.id !== currentWorkspace.id);
    currentWorkspace = null;
    workspaceNodeIds = new Set();
    _renderWorkspaceSelect();
    document.getElementById('ws-controls').style.display = 'none';
    hideInspector();
    await loadGraph();
    toast('✅ 工作空间已删除，已切换至全图模式');
  } catch {}
}

function openFilterModal() {
  if (!currentWorkspace) return;
  // Populate label datalist
  api('GET', '/labels').then(labels => {
    const dl = document.getElementById('ws-filter-labels-list');
    dl.innerHTML = labels.map(l => `<option value="${l}">`).join('');
  }).catch(() => {});
  document.getElementById('ws-filter-type').value = 'label';
  onFilterTypeChange();
  document.getElementById('ws-filter-label').value = '';
  document.getElementById('ws-filter-prop-key').value = '';
  document.getElementById('ws-filter-prop-value').value = '';
  document.getElementById('ws-filter-modal').classList.remove('hidden');
}

function onFilterTypeChange() {
  const t = document.getElementById('ws-filter-type').value;
  document.getElementById('ws-filter-label-row').style.display  = t === 'label'    ? '' : 'none';
  document.getElementById('ws-filter-prop-rows').style.display  = t === 'property' ? '' : 'none';
}

async function applyWorkspaceFilter() {
  if (!currentWorkspace) return;
  const filterType = document.getElementById('ws-filter-type').value;
  const btn = document.getElementById('ws-filter-confirm-btn');
  btn.disabled = true; btn.textContent = '筛选中…';

  let body;
  if (filterType === 'label') {
    const label = document.getElementById('ws-filter-label').value.trim();
    if (!label) { toast('请填写节点标签', 'err'); btn.disabled = false; btn.textContent = '筛选并加入'; return; }
    body = { filter_type: 'label', label };
  } else {
    const prop_key   = document.getElementById('ws-filter-prop-key').value.trim();
    const prop_value = document.getElementById('ws-filter-prop-value').value.trim();
    if (!prop_key || !prop_value) { toast('请填写属性键和属性值', 'err'); btn.disabled = false; btn.textContent = '筛选并加入'; return; }
    body = { filter_type: 'property', prop_key, prop_value };
  }

  try {
    const result = await api('POST', `/workspaces/${currentWorkspace.id}/filter`, body);
    closeModal('ws-filter-modal');
    if (result.added === 0) {
      toast('未找到匹配节点', 'err'); return;
    }
    toast(`✅ 已加入 ${result.added} 个节点`);
    // Refresh workspace graph
    const ws = _workspaces.find(w => w.id === currentWorkspace.id);
    if (ws) ws.node_count = (ws.node_count || 0) + result.added;
    _renderWorkspaceSelect();
    await loadWorkspaceGraph(currentWorkspace.id);
  } catch {
  } finally {
    btn.disabled = false; btn.textContent = '筛选并加入';
  }
}

// Add / remove single node from current workspace
async function _syncWorkspaceGraph(toastMsg) {
  const data = await api('GET', `/workspaces/${currentWorkspace.id}/graph`);
  workspaceNodeIds = new Set(data.nodes.map(n => n.id));
  data.nodes.forEach(n => {
    if (!visNodes.get(n.id)) {
      const lk = lockedEntities.get(n.id);
      visNodes.add(lk ? makeVisNodeLocked(n, lk.username, lk.color) : makeVisNode(n));
    }
  });
  data.edges.forEach(e => { if (!visEdges.get(e.id)) visEdges.add(makeVisEdge(e)); });
  const ws = _workspaces.find(w => w.id === currentWorkspace.id);
  if (ws) ws.node_count = data.nodes.length;
  _renderWorkspaceSelect();
  network.setOptions({ physics: { enabled: true } });
  setTimeout(() => { network.setOptions({ physics: { enabled: false } }); saveNodePositions(); }, PHYSICS_SETTLE_MS);
  updateStats(); updateEmptyState();
  refreshLabels(); renderRelTypeList();
  toast(toastMsg);
}

async function addNodeToWorkspace(nodeId) {
  if (!currentWorkspace) return;
  try {
    await api('POST', `/workspaces/${currentWorkspace.id}/nodes`, { node_ids: [nodeId] });
    await _syncWorkspaceGraph('✅ 已加入工作空间');
    // Refresh inspector props tab buttons (加入→移出)
    const vn = visNodes.get(nodeId);
    if (vn && selectedNodeIds.includes(nodeId)) _renderNodePropsTab(vn._data);
  } catch {}
}

async function removeNodeFromWorkspace(nodeId) {
  if (!currentWorkspace) return;
  try {
    await api('DELETE', `/workspaces/${currentWorkspace.id}/nodes/${encodeURIComponent(nodeId)}`);
    workspaceNodeIds.delete(nodeId);
    const ws = _workspaces.find(w => w.id === currentWorkspace.id);
    if (ws && ws.node_count > 0) ws.node_count--;
    _renderWorkspaceSelect();
    // Remove from canvas
    const connEdges = _getConnectedEdges(nodeId);
    visEdges.remove(connEdges);
    visNodes.remove(nodeId);
    updateStats(); updateEmptyState();
    refreshLabels(); renderRelTypeList();
    hideInspector();
    toast('✅ 已从工作空间移除');
  } catch {}
}
