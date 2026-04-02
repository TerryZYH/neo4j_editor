// ── History / Version ─────────────────────────────────────────────────────────
let _historyActiveTab = 'log';

const OP_LABELS = {
  create_node: '创建节点', update_node: '编辑节点', delete_node: '删除节点',
  create_edge: '创建关系', update_edge: '编辑关系', delete_edge: '删除关系',
};
const OP_COLORS = {
  create_node: 'var(--success)', create_edge: 'var(--success)',
  update_node: 'var(--accent)',  update_edge: 'var(--accent)',
  delete_node: 'var(--danger)',  delete_edge: 'var(--danger)',
};

function openHistoryModal() {
  document.getElementById('history-modal').classList.remove('hidden');
  switchHistoryTab(_historyActiveTab);
}

function switchHistoryTab(tab) {
  _historyActiveTab = tab;
  document.getElementById('htab-log').classList.toggle('active', tab === 'log');
  document.getElementById('htab-checkpoints').classList.toggle('active', tab === 'checkpoints');
  document.getElementById('history-pane-log').style.display         = tab === 'log'         ? '' : 'none';
  document.getElementById('history-pane-checkpoints').style.display = tab === 'checkpoints' ? '' : 'none';
  if (tab === 'log')         loadOperations();
  if (tab === 'checkpoints') { loadArchiveConfig().then(loadCheckpoints); }
}

// ── Time formatting (UTC → local) ──────────────────────────────────────────────
function fmtLocalTime(isoStr, includeSeconds = true) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  const parts = [
    d.getFullYear(), '-', pad(d.getMonth()+1), '-', pad(d.getDate()),
    ' ', pad(d.getHours()), ':', pad(d.getMinutes()),
  ];
  if (includeSeconds) parts.push(':', pad(d.getSeconds()));
  return parts.join('');
}

// ── Operation filter builder ───────────────────────────────────────────────────
const OP_FILTER_FIELDS = [
  { key: 'username',    label: '操作人',   type: 'text' },
  { key: 'operated_at', label: '操作时间', type: 'datetime' },
  { key: 'summary',     label: '操作摘要', type: 'text' },
];
const OP_FILTER_OPS = {
  text: [
    { key: 'eq',          label: '等于' },
    { key: 'neq',         label: '不等于' },
    { key: 'contains',    label: '包含' },
    { key: 'not_contains',label: '不包含' },
    { key: 'starts',      label: '开头为' },
  ],
  datetime: [
    { key: 'gte', label: '≥ (开始于)' },
    { key: 'lte', label: '≤ (结束于)' },
    { key: 'gt',  label: '> (晚于)' },
    { key: 'lt',  label: '< (早于)' },
  ],
};

let _opFilterSeq = 0;

function addOpFilterRow(field = '', op = '', val = '') {
  const id = ++_opFilterSeq;
  const row = document.createElement('div');
  row.id = `op-filter-row-${id}`;
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';

  // Field selector
  const fSel = document.createElement('select');
  fSel.style.cssText = 'width:84px;padding:4px 4px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;outline:none';
  fSel.innerHTML = OP_FILTER_FIELDS.map(f =>
    `<option value="${f.key}" ${f.key===field?'selected':''}>${f.label}</option>`).join('');

  // Operator selector (rebuilt when field changes)
  const oSel = document.createElement('select');
  oSel.style.cssText = 'width:90px;padding:4px 4px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;outline:none';

  function rebuildOps(selectedOp) {
    const ftype = OP_FILTER_FIELDS.find(f => f.key === fSel.value)?.type || 'text';
    oSel.innerHTML = OP_FILTER_OPS[ftype].map(o =>
      `<option value="${o.key}" ${o.key===selectedOp?'selected':''}>${o.label}</option>`).join('');
    rebuildVal(ftype);
  }

  // Value input (rebuilt based on field type)
  const vWrap = document.createElement('span');
  let vInput;
  function rebuildVal(ftype) {
    vWrap.innerHTML = '';
    vInput = document.createElement('input');
    vInput.type = ftype === 'datetime' ? 'datetime-local' : 'text';
    vInput.style.cssText = 'padding:4px 6px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;outline:none;color-scheme:dark';
    vInput.style.width = ftype === 'datetime' ? '168px' : '140px';
    if (val) vInput.value = val;
    vWrap.appendChild(vInput);
    row._getVal = () => vInput.value;
  }

  fSel.addEventListener('change', () => rebuildOps(''));
  rebuildOps(op);  // initial build

  // Remove button
  const del = document.createElement('button');
  del.className = 'btn';
  del.textContent = '×';
  del.style.cssText = 'font-size:13px;padding:2px 8px;line-height:1';
  del.onclick = () => row.remove();

  row._getField = () => fSel.value;
  row._getOp    = () => oSel.value;

  row.append(fSel, oSel, vWrap, del);
  document.getElementById('op-filter-builder').appendChild(row);
}

function clearOpFilters() {
  document.getElementById('op-filter-builder').innerHTML = '';
  _opFilterSeq = 0;
  loadOperations();
}

async function loadOperations() {
  const el = document.getElementById('history-log-content');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载中…</div>';
  try {
    const filters = [];
    document.querySelectorAll('#op-filter-builder > div').forEach(row => {
      const field = row._getField?.();
      const op    = row._getOp?.();
      const val   = (row._getVal?.() || '').trim();
      if (field && op && val) filters.push({ field, op, val });
    });
    const params = new URLSearchParams({ limit: 200 });
    if (filters.length) params.set('filters', JSON.stringify(filters));
    const ops = await api('GET', `/version/operations?${params}`);
    if (!ops.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">暂无变更记录</div>';
      return;
    }
    const isAdmin = currentUser && currentUser.role === 'admin';
    el.innerHTML = ops.map(op => `
      <div class="cp-item" style="flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px">
          <div style="flex:1;min-width:0">
            <span style="font-size:13px;font-weight:500;color:var(--text)">${_esc(op.summary)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="cp-meta">${_esc(op.username)} · ${fmtLocalTime(op.operated_at)}</span>
            <button class="btn" style="font-size:11px;padding:2px 8px"
                    onclick="toggleOpDetail(${op.id}, this)">详情</button>
            ${isAdmin && !op.is_undo && !op.undone ? `<button class="btn danger" style="font-size:11px;padding:2px 8px"
                    onclick="undoOperation(${op.id},'${_esc(op.summary)}')">撤销</button>` : ''}
          </div>
        </div>
        <div id="op-detail-${op.id}" style="display:none;width:100%"></div>
      </div>`).join('');
  } catch { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载失败</div>'; }
}

async function toggleOpDetail(opId, btn) {
  const el = document.getElementById(`op-detail-${opId}`);
  if (el.style.display !== 'none') { el.style.display = 'none'; btn.textContent = '详情'; return; }
  btn.textContent = '收起';
  if (el.dataset.loaded) { el.style.display = ''; return; }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px 0">加载中…</div>';
  el.style.display = '';
  try {
    const op = await api('GET', `/version/operations/${opId}`);
    el.dataset.loaded = '1';
    el.innerHTML = `<div style="margin-top:6px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
      ${op.changes.map((c, i) => _renderChangeRow(opId, i, c)).join('')}
    </div>`;
  } catch { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">加载失败</div>'; }
}

function _renderChangeRow(opId, idx, c) {
  const color = OP_COLORS[c.op] || 'var(--text)';
  const label = OP_LABELS[c.op] || c.op;
  const typeLabel = c.entity_type === 'node' ? '节点' : '关系';
  const detailId = `cd-${opId}-${idx}`;
  return `<div style="border-bottom:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;cursor:pointer;user-select:none"
         onclick="_toggleChangeDetail('${detailId}',this)">
      <span style="color:${color};font-size:12px;min-width:64px">${_esc(label)}</span>
      <span style="color:var(--text-muted);font-size:11px;min-width:28px">${typeLabel}</span>
      <span style="font-family:monospace;font-size:11px;color:var(--text-muted)"
            title="${_esc(c.entity_id)}">…${c.entity_id.slice(-14)}</span>
      <span style="margin-left:auto;color:var(--text-muted);font-size:10px">▶</span>
    </div>
    <div id="${detailId}" style="display:none;padding:8px 12px;background:rgba(0,0,0,.15);border-top:1px solid var(--border)">
      ${_renderChangeDetail(c)}
    </div>
  </div>`;
}

function _toggleChangeDetail(id, header) {
  const el = document.getElementById(id);
  const arrow = header.querySelector('span:last-child');
  const open = el.style.display === 'none';
  el.style.display = open ? '' : 'none';
  if (arrow) arrow.textContent = open ? '▼' : '▶';
}

function _renderChangeDetail(c) {
  if (c.entity_type === 'node') {
    if (c.op === 'update_node' && c.before && c.after) return _renderNodeDiff(c.before, c.after);
    return _renderNodeView(c.after || c.before);
  } else {
    if (c.op === 'update_edge' && c.before && c.after) return _renderEdgeDiff(c.before, c.after);
    return _renderEdgeView(c.after || c.before);
  }
}

function _propsTable(rows) {
  if (!rows.length) return '<div style="color:var(--text-muted);font-size:11px;padding:2px 0">无属性</div>';
  return `<table class="history-table" style="margin-top:4px">${rows.join('')}</table>`;
}

function _renderNodeView(node) {
  if (!node) return '<div style="color:var(--text-muted);font-size:11px">无数据</div>';
  const labels = `[${(node.labels||[]).map(_esc).join(', ')}]`;
  const rows = Object.entries(node.properties||{}).map(([k,v]) =>
    `<tr><td style="color:var(--text-muted)">${_esc(k)}</td><td>${_esc(String(v))}</td></tr>`);
  return `<div style="font-size:11px;color:var(--accent);margin-bottom:4px">${labels}</div>${_propsTable(rows)}`;
}

function _renderEdgeView(edge) {
  if (!edge) return '<div style="color:var(--text-muted);font-size:11px">无数据</div>';
  const rows = Object.entries(edge.properties||{}).map(([k,v]) =>
    `<tr><td style="color:var(--text-muted)">${_esc(k)}</td><td>${_esc(String(v))}</td></tr>`);
  return `<div style="font-size:11px;color:var(--accent);margin-bottom:4px">${_esc(edge.type||'')}</div>${_propsTable(rows)}`;
}

function _renderNodeDiff(before, after) {
  const bSet = new Set(before.labels||[]), aSet = new Set(after.labels||[]);
  const allLabels = [...new Set([...bSet, ...aSet])];
  const labelHtml = allLabels.map(l => {
    if (!bSet.has(l)) return `<span style="color:var(--success)">+${_esc(l)}</span>`;
    if (!aSet.has(l)) return `<span style="color:var(--danger);text-decoration:line-through">${_esc(l)}</span>`;
    return `<span style="color:var(--text-muted)">${_esc(l)}</span>`;
  }).join(' ');
  const rows = _diffProps(before.properties||{}, after.properties||{});
  return `<div style="font-size:11px;margin-bottom:6px;display:flex;gap:6px;flex-wrap:wrap">${labelHtml}</div>${_propsTable(rows)}`;
}

function _renderEdgeDiff(before, after) {
  const typeHtml = before.type === after.type
    ? `<span style="color:var(--text-muted)">${_esc(before.type)}</span>`
    : `<span style="color:var(--danger);text-decoration:line-through">${_esc(before.type)}</span>`
      + ` → <span style="color:var(--success)">${_esc(after.type)}</span>`;
  const rows = _diffProps(before.properties||{}, after.properties||{});
  return `<div style="font-size:11px;margin-bottom:6px">${typeHtml}</div>${_propsTable(rows)}`;
}

function _diffProps(bProps, aProps) {
  const allKeys = [...new Set([...Object.keys(bProps), ...Object.keys(aProps)])];
  return allKeys.map(k => {
    const bv = bProps[k], av = aProps[k];
    if (JSON.stringify(bv) === JSON.stringify(av))
      return `<tr><td style="color:var(--text-muted)">${_esc(k)}</td><td>${_esc(String(av))}</td></tr>`;
    if (bv === undefined)
      return `<tr style="background:rgba(86,211,100,.08)"><td style="color:var(--success)">+${_esc(k)}</td>`
           + `<td style="color:var(--success)">${_esc(String(av))}</td></tr>`;
    if (av === undefined)
      return `<tr style="background:rgba(248,81,73,.08)"><td style="color:var(--danger)">-${_esc(k)}</td>`
           + `<td style="color:var(--danger);text-decoration:line-through">${_esc(String(bv))}</td></tr>`;
    return `<tr style="background:rgba(88,166,255,.08)"><td>${_esc(k)}</td><td>`
         + `<span style="color:var(--danger);text-decoration:line-through">${_esc(String(bv))}</span>`
         + ` → <span style="color:var(--success)">${_esc(String(av))}</span></td></tr>`;
  });
}

async function undoOperation(id, summary) {
  if (!confirm(`确认撤销操作「${summary}」？\n\n将恢复该操作影响的所有实体至操作前的状态。`)) return;
  try {
    await api('POST', `/version/operations/${id}/undo`);
    toast(`↩ 「${summary}」已撤销`);
    loadOperations();
  } catch {}
}

// ── Archive config ─────────────────────────────────────────────────────────────

let _cpFilter = 'all';
let _archiveCfg = { hourly_hours: 12, daily_days: 7, monthly_months: 0 };

function setCpFilter(f) {
  _cpFilter = f;
  document.querySelectorAll('.cp-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.f === f)
  );
  loadCheckpoints();
}

async function loadArchiveConfig() {
  try {
    _archiveCfg = await api('GET', '/version/archive-config');
    document.getElementById('cfg-hourly-hours').value   = _archiveCfg.hourly_hours;
    document.getElementById('cfg-daily-days').value     = _archiveCfg.daily_days;
    document.getElementById('cfg-monthly-months').value = _archiveCfg.monthly_months;
  } catch {}
}

function toggleArchiveSettings() {
  const panel = document.getElementById('archive-settings-panel');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening) loadArchiveConfig();
}

async function saveArchiveConfig() {
  const cfg = {
    hourly_hours:   Math.max(1, parseInt(document.getElementById('cfg-hourly-hours').value)   || 12),
    daily_days:     Math.max(1, parseInt(document.getElementById('cfg-daily-days').value)     || 7),
    monthly_months: Math.max(0, parseInt(document.getElementById('cfg-monthly-months').value) || 0),
  };
  try {
    _archiveCfg = await api('PUT', '/version/archive-config', cfg);
    const hint = document.getElementById('cfg-save-hint');
    hint.textContent = '✓ 已保存并执行修剪';
    setTimeout(() => { hint.textContent = ''; }, 2500);
    loadCheckpoints();
  } catch {}
}

// ── Checkpoint timeline ────────────────────────────────────────────────────────

async function loadCheckpoints() {
  const el = document.getElementById('history-cp-content');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载中…</div>';

  // Show settings button for admins
  const isAdmin = currentUser && currentUser.role === 'admin';
  document.getElementById('cp-settings-btn-wrap').style.display = isAdmin ? '' : 'none';

  try {
    let cps = await api('GET', '/version/checkpoints');

    // Apply type filter
    if (_cpFilter === 'auto')   cps = cps.filter(c => c.checkpoint_type === 'auto');
    else if (_cpFilter === 'manual') cps = cps.filter(c => c.checkpoint_type !== 'auto');

    if (!cps.length) {
      el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0">${
        _cpFilter === 'all' ? '首次写操作时将自动创建每小时存档' : '无匹配存档'}</div>`;
      return;
    }

    const now = Date.now();
    const hourlyMs = (_archiveCfg.hourly_hours || 12) * 3_600_000;
    const dailyMs  = (_archiveCfg.daily_days   ||  7) * 86_400_000;

    // Zone definitions: [key, label, color, test(ageMs, type)]
    const zones = [
      { key:'hourly', color:'var(--accent)',  items:[],
        label:`⏱ 最近 ${_archiveCfg.hourly_hours || 12} 小时 · 每小时一份` },
      { key:'daily',  color:'#a78bfa',        items:[],
        label:`📅 过去 ${_archiveCfg.daily_days || 7} 天 · 每天一份` },
      { key:'old',    color:'#fb923c',        items:[],
        label:'📆 更早 · 每月一份' },
      { key:'manual', color:'#4ade80',        items:[],
        label:'📌 手动存档' },
    ];

    for (const cp of cps) {
      if (cp.checkpoint_type !== 'auto') {
        zones[3].items.push(cp);
      } else {
        const age = now - new Date(cp.created_at).getTime();
        if (age < hourlyMs)      zones[0].items.push(cp);
        else if (age < dailyMs)  zones[1].items.push(cp);
        else                     zones[2].items.push(cp);
      }
    }

    let html = '';
    for (const zone of zones) {
      if (!zone.items.length) continue;
      html += `<div class="cp-tl-section">
        <div class="cp-tl-label">${_esc(zone.label)}</div>
        <div class="cp-tl-items">`;
      for (const cp of zone.items) {
        const isAuto = cp.checkpoint_type === 'auto';
        const safeName = _esc(cp.name).replace(/'/g, '&#39;');
        html += `<div class="cp-tl-row">
          <div class="cp-tl-dot" style="background:${zone.color}"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;color:var(--text)">${_esc(cp.name)}</div>
            ${cp.description && !isAuto ? `<div class="cp-meta">${_esc(cp.description)}</div>` : ''}
            <div class="cp-meta">by ${_esc(cp.created_by)} · ${fmtLocalTime(cp.created_at, false)}</div>
          </div>
          ${isAdmin ? `<div style="display:flex;gap:5px;flex-shrink:0">
            <button class="btn" style="font-size:12px;padding:3px 10px"
                    onclick="restoreCheckpoint(${cp.id},'${safeName}')">恢复</button>
            <button class="btn danger" style="font-size:12px;padding:3px 8px"
                    onclick="deleteCheckpoint(${cp.id})">删</button>
          </div>` : ''}
        </div>`;
      }
      html += `</div></div>`;
    }
    el.innerHTML = html;
  } catch { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载失败</div>'; }
}

async function createCheckpoint() {
  const nameEl = document.getElementById('cp-name-input');
  const name = nameEl.value.trim();
  if (!name) { toast('请输入存档名称', 'err'); nameEl.focus(); return; }
  try {
    await api('POST', '/version/checkpoints', { name });
    nameEl.value = '';
    toast('✅ 存档创建成功');
    loadCheckpoints();
  } catch {}
}

async function restoreCheckpoint(id, name) {
  if (!confirm(`确认恢复存档「${name}」？\n\n这将用存档内容替换当前所有图数据，操作不可撤销。`)) return;
  try {
    await api('POST', `/version/checkpoints/${id}/restore`);
    toast(`✅ 存档「${name}」恢复成功`);
    closeModal('history-modal');
  } catch {}
}

async function deleteCheckpoint(id) {
  if (!confirm('确认删除此存档点？此操作不可撤销。')) return;
  try {
    await api('DELETE', `/version/checkpoints/${id}`);
    toast('✅ 存档已删除');
    loadCheckpoints();
  } catch {}
}
