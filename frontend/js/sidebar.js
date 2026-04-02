// ── Relationship type filter ───────────────────────────────────────────────────
let _activeRelFilter = new Set(); // empty = no filter active

function _renderFilterList({ listId, items, activeSet, onToggle, badgeId, clearBtnId, emptyText }) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">${emptyText}</div>`;
  } else {
    items.forEach(({ name, count, extra = '' }) => {
      const isChecked = activeSet.has(name);
      const item = document.createElement('div');
      item.className = 'rel-filter-item' + (isChecked ? ' checked' : '');
      item.innerHTML =
        `<div class="rel-filter-check">${isChecked ? '✓' : ''}</div>` +
        extra +
        `<span class="label-name">${name}</span>` +
        `<span class="label-count">${count}</span>`;
      item.onclick = () => onToggle(name);
      list.appendChild(item);
    });
  }
  const active = activeSet.size > 0;
  const badge = document.getElementById(badgeId);
  const clearBtn = document.getElementById(clearBtnId);
  if (badge) badge.style.display = active ? 'inline-block' : 'none';
  if (clearBtn) clearBtn.style.display = active ? 'inline-block' : 'none';
}

function renderRelTypeList() {
  const typeCounts = {};
  visEdges.get().forEach(e => {
    const t = (e._data && e._data.type) || e.label || '';
    if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  _renderFilterList({
    listId: 'rel-type-list',
    items: Object.keys(typeCounts).sort().map(name => ({ name, count: typeCounts[name] })),
    activeSet: _activeRelFilter,
    onToggle: toggleRelFilter,
    badgeId: 'rel-filter-badge',
    clearBtnId: 'rel-filter-clear-btn',
    emptyText: '暂无关系',
  });
}

function toggleRelFilter(type) {
  if (_activeRelFilter.has(type)) {
    _activeRelFilter.delete(type);
  } else {
    _activeRelFilter.add(type);
  }
  applyRelFilter();
  renderRelTypeList();
}

function clearRelFilter() {
  _activeRelFilter.clear();
  applyRelFilter();
  renderRelTypeList();
}

function applyRelFilter() {
  const noLabelFilter = _activeLabelFilter.size === 0;
  const noRelFilter = _activeRelFilter.size === 0;

  if (noLabelFilter && noRelFilter) {
    const nu = visNodes.get().map(n => ({ id: n.id, hidden: false }));
    const eu = visEdges.get().map(e => ({ id: e.id, hidden: false }));
    if (nu.length) visNodes.update(nu);
    if (eu.length) visEdges.update(eu);
    return;
  }

  // Step 1: nodes passing label filter
  const labelOkNodes = new Set();
  visNodes.get().forEach(n => {
    if (noLabelFilter) { labelOkNodes.add(n.id); return; }
    const labels = (n._data && n._data.labels) || [];
    if (labels.some(l => _activeLabelFilter.has(l))) labelOkNodes.add(n.id);
  });

  // Step 2: edges passing rel filter whose both endpoints pass label filter
  const relVisibleNodes = new Set();
  const eu = visEdges.get().map(e => {
    const type = (e._data && e._data.type) || e.label || '';
    const relOk = noRelFilter || _activeRelFilter.has(type);
    const endOk = labelOkNodes.has(e.from) && labelOkNodes.has(e.to);
    const visible = relOk && endOk;
    if (visible) { relVisibleNodes.add(e.from); relVisibleNodes.add(e.to); }
    return { id: e.id, hidden: !visible };
  });

  // Step 3: node visible = passes label AND (no rel filter OR has a visible edge)
  const nu = visNodes.get().map(n => ({
    id: n.id,
    hidden: !(labelOkNodes.has(n.id) && (noRelFilter || relVisibleNodes.has(n.id)))
  }));

  visEdges.update(eu);
  visNodes.update(nu);
}

function refreshLabels() {
  const labelCounts = {};
  visNodes.get().forEach(n => {
    ((n._data && n._data.labels) || []).forEach(l => {
      labelCounts[l] = (labelCounts[l] || 0) + 1;
    });
  });
  _renderFilterList({
    listId: 'label-list',
    items: Object.keys(labelCounts).sort().map(name => ({
      name, count: labelCounts[name],
      extra: `<div class="label-dot" style="background:${getLabelColor(name)};flex-shrink:0"></div>`,
    })),
    activeSet: _activeLabelFilter,
    onToggle: toggleLabelFilter,
    badgeId: 'label-filter-badge',
    clearBtnId: 'label-filter-clear-btn',
    emptyText: '暂无标签',
  });
}

let _activeLabelFilter = new Set();

function toggleLabelFilter(lbl) {
  if (_activeLabelFilter.has(lbl)) {
    _activeLabelFilter.delete(lbl);
  } else {
    _activeLabelFilter.add(lbl);
  }
  applyRelFilter();
  refreshLabels();
}

function clearLabelFilter() {
  _activeLabelFilter.clear();
  applyRelFilter();
  refreshLabels();
}
