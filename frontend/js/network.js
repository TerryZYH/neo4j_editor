// ── Node display ──────────────────────────────────────────────────────────────
function nodeLabel(n) {
  const p = n.properties || {};
  const name = p.name || p.title || p.label || p.id || p.code || p.key;
  if (name) return String(name).slice(0, 30);
  const keys = Object.keys(p);
  if (keys.length) return String(p[keys[0]]).slice(0, 20);
  return (n.labels && n.labels[0]) || 'Node';
}

function makeVisNode(n) {
  const color = getLabelColor(n.labels[0] || 'Node');
  return {
    id: n.id,
    label: nodeLabel(n),
    title: formatTooltip(n.labels, n.properties),
    color: { background: color, border: color, highlight: { background: color, border: '#fff' } },
    font: { color: '#fff', size: 12, face: 'sans-serif' },
    borderWidth: 2,
    shapeProperties: { borderDashes: false },
    _data: n,
  };
}

function makeVisNodeLocked(n, username, lockColor) {
  const color = getLabelColor(n.labels[0] || 'Node');
  return {
    id: n.id,
    label: `${nodeLabel(n)}\n🔒 ${username}`,
    title: (() => { const el = document.createElement('div'); el.style.cssText = 'max-width:220px;padding:8px 10px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:12px;color:#c9d1d9;'; el.textContent = `🔒 正在被「${username}」编辑`; return el; })(),
    color: { background: color, border: lockColor, highlight: { background: color, border: lockColor } },
    font: { color: '#fff', size: 12, face: 'sans-serif' },
    borderWidth: 4,
    shapeProperties: { borderDashes: [6, 3] },
    _data: n,
  };
}

function makeVisEdge(e) {
  return {
    id: e.id,
    from: e.source,
    to: e.target,
    label: e.type,
    arrows: 'to',
    color: { color: '#8b949e', highlight: '#58a6ff' },
    font: { color: '#8b949e', size: 11, align: 'middle' },
    smooth: { type: 'curvedCW', roundness: 0.1 },
    _data: e,
  };
}

function formatTooltip(labels, props) {
  const entries = Object.entries(props || {});
  const el = document.createElement('div');
  el.style.cssText = 'max-width:220px;padding:8px 10px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:12px;line-height:1.6;color:#c9d1d9;pointer-events:none;';
  const header = document.createElement('div');
  header.style.cssText = 'font-weight:600;color:#58a6ff;margin-bottom:4px;';
  header.textContent = `[${(labels || []).join(', ')}]`;
  el.appendChild(header);
  entries.forEach(([k, v]) => {
    const row = document.createElement('div');
    const key = document.createElement('span');
    key.style.cssText = 'color:#8b949e;';
    key.textContent = k + ': ';
    const val = document.createElement('span');
    val.textContent = String(v);
    row.appendChild(key);
    row.appendChild(val);
    el.appendChild(row);
  });
  return el;
}

// ── Build network ─────────────────────────────────────────────────────────────
function initNetwork() {
  if (network) return;
  const container = document.getElementById('graph-canvas');
  const options = {
    nodes: { shape: 'dot', size: 20, borderWidth: 2, shadow: { enabled: true, color: 'rgba(0,0,0,.4)', size: 8 } },
    edges: { width: 1.5, shadow: false, selectionWidth: 3 },
    physics: {
      enabled: true,
      barnesHut: { gravitationalConstant: -8000, springLength: 120, springConstant: 0.04, damping: 0.09 },
      stabilization: { iterations: 150, updateInterval: 20 },
    },
    interaction: { hover: true, tooltipDelay: 300, multiselect: true, selectConnectedEdges: false },
    manipulation: { enabled: false },
  };

  network = new vis.Network(container, { nodes: visNodes, edges: visEdges }, options);
  network.on('selectNode', onSelectNode);
  network.on('selectEdge', onSelectEdge);
  network.on('deselectNode', onDeselect);
  network.on('deselectEdge', onDeselect);
  network.on('doubleClick', onDoubleClick);
  network.on('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
  });
  network.on('dragStart', params => {
    if (params.nodes.length > 0) {
      network.setOptions({ physics: { enabled: false } });
    }
  });
  network.on('dragEnd', params => { if (params.nodes.length > 0) saveNodePositions(); });
  updateEmptyState();
}

// ── Load graph ────────────────────────────────────────────────────────────────

/** Load the correct view depending on whether we're in workspace mode or global mode. */
async function loadCurrentView() {
  if (currentWorkspace) {
    await loadWorkspaceGraph(currentWorkspace.id);
  } else {
    await loadGraph();
  }
}

async function _applyGraphData(data, toastMsg) {
  _activeRelFilter.clear();
  _activeLabelFilter.clear();
  visNodes.clear();
  visEdges.clear();

  const savedPositions = await loadNodePositions();
  let hasNewNodes = false;

  if (data.nodes.length) visNodes.add(data.nodes.map(n => {
    const lk = lockedEntities.get(n.id);
    const visNode = lk ? makeVisNodeLocked(n, lk.username, lk.color) : makeVisNode(n);
    const pos = savedPositions[n.id];
    if (pos) { visNode.x = pos.x; visNode.y = pos.y; visNode.physics = false; }
    else { hasNewNodes = true; }
    return visNode;
  }));
  if (data.edges.length) visEdges.add(data.edges.map(makeVisEdge));

  if (hasNewNodes) {
    network.setOptions({ physics: { enabled: true } });
    setTimeout(() => { network.setOptions({ physics: { enabled: false } }); saveNodePositions(); }, PHYSICS_SETTLE_MS);
  } else {
    network.setOptions({ physics: { enabled: false } });
  }

  updateStats(); updateEmptyState();
  toast(toastMsg);
  refreshLabels();
  renderRelTypeList();
}

async function loadGraph(labelFilter = '') {
  const url = labelFilter
    ? `/graph?label=${encodeURIComponent(labelFilter)}&limit=300`
    : '/graph?limit=300';
  const data = await api('GET', url);
  await _applyGraphData(data, `✅ 已加载 ${data.nodes.length} 节点, ${data.edges.length} 关系`);
}

async function loadWorkspaceGraph(workspaceId) {
  const data = await api('GET', `/workspaces/${workspaceId}/graph`);
  workspaceNodeIds = new Set(data.nodes.map(n => n.id));
  const name = currentWorkspace ? currentWorkspace.name : '';
  await _applyGraphData(data, `✅ 工作空间「${name}」已加载 ${data.nodes.length} 节点, ${data.edges.length} 关系`);
}

// ── Position persistence (server-side per user) ───────────────────────────────
// _allPositions caches the full set of node positions across all label filters.
// When only a subset of nodes is loaded, we merge into this cache so positions
// of currently-hidden nodes are never overwritten.
let _allPositions = {};

async function saveNodePositions() {
  if (is3DMode) return; // 3D positions managed by force simulation
  if (!network || !currentUser) return;
  const positions = network.getPositions();
  if (currentWorkspace) {
    try { await api('PUT', `/workspaces/${currentWorkspace.id}/layout`, positions); } catch {}
  } else {
    Object.assign(_allPositions, positions);
    try { await api('PUT', '/auth/positions', _allPositions); } catch {}
  }
}
async function loadNodePositions() {
  if (!currentUser) return {};
  try {
    if (currentWorkspace) {
      return await api('GET', `/workspaces/${currentWorkspace.id}/layout`) || {};
    } else {
      _allPositions = await api('GET', '/auth/positions') || {};
      return _allPositions;
    }
  } catch { return {}; }
}
async function clearNodePositions() {
  if (!currentUser) return;
  if (currentWorkspace) {
    try { await api('PUT', `/workspaces/${currentWorkspace.id}/layout`, {}); } catch {}
  } else {
    _allPositions = {};
    try { await api('PUT', '/auth/positions', {}); } catch {}
  }
}

// ── Stats & labels ────────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-nodes').textContent = visNodes.length;
  document.getElementById('stat-edges').textContent = visEdges.length;
}

function updateEmptyState() {
  document.getElementById('empty-state').classList.toggle('hidden', visNodes.length > 0);
}
