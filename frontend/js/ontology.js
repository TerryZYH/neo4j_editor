const API = 'http://localhost:8000/api';
let authToken = localStorage.getItem('auth_token');

// ── Auth check ─────────────────────────────────────────────────────────────────
if (!authToken) { location.href = '/'; }

// ── State ──────────────────────────────────────────────────────────────────────
let classes   = [];
let relations = [];
let vmode     = 'warn';
let currentRole = null;
let editingClassId = null;
let editingRelId   = null;
let ontologyNetwork = null;
// Field management state
let fieldSchemas = [];          // all loaded field schemas
let fieldModalCtx = { entityType: 'node', entityLabel: '' };
let editingFieldId = null;

// ── API helper ─────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(API + path, opts);
  if (resp.status === 401) { location.href = '/'; return; }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || resp.statusText);
  }
  return resp.json();
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'relations') renderOntologyGraph();
}

// ── Field management ───────────────────────────────────────────────────────────

function openFieldModal(entityType, entityLabel, displayLabel) {
  fieldModalCtx = { entityType, entityLabel };
  editingFieldId = null;
  const typeLabel = entityType === 'node' ? '节点' : '关系';
  document.getElementById('field-modal-title').textContent =
    `${displayLabel}（${typeLabel}）· 字段定义`;
  cancelFieldForm();
  renderFieldList();
  document.getElementById('field-modal').classList.remove('hidden');
}

function renderFieldList() {
  const fields = fieldSchemas.filter(
    f => f.entity_type === fieldModalCtx.entityType && f.entity_label === fieldModalCtx.entityLabel
  );
  const body = document.getElementById('field-list-body');
  if (!fields.length) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:28px 0">暂无字段定义，点击「新增字段」添加</div>';
    return;
  }
  // Sort: ID first, then required, then constrained, then by name
  const sorted = [...fields].sort((a, b) => {
    if (a.is_id !== b.is_id) return b.is_id - a.is_id;
    if (a.required !== b.required) return b.required - a.required;
    const aCon = !!(a.enum_values?.length || a.regex_pattern);
    const bCon = !!(b.enum_values?.length || b.regex_pattern);
    if (aCon !== bCon) return bCon - aCon;
    return a.prop_key.localeCompare(b.prop_key);
  });
  body.innerHTML = `
    <table class="fields-table">
      <thead><tr>
        <th>字段名</th><th>类型</th><th>分类</th><th>约束值</th><th>默认值</th><th></th>
      </tr></thead>
      <tbody>${sorted.map(f => {
        const constraintHtml = (f.enum_values && f.enum_values.length)
          ? `<span style="font-size:11px;color:var(--text-muted)">[${f.enum_values.slice(0,4).join(', ')}${f.enum_values.length > 4 ? ' …' : ''}]</span>`
          : f.regex_pattern
          ? `<code style="font-size:11px;color:var(--text-muted)">${f.regex_pattern}</code>`
          : '<span style="color:var(--text-muted)">—</span>';
        return `<tr>
          <td>
            <b>${f.prop_key}</b>
            ${f.description ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${f.description}</div>` : ''}
          </td>
          <td><span class="type-pill">${TYPE_LABELS[f.prop_type] || f.prop_type}</span></td>
          <td>${fieldCategoryBadges(f)}</td>
          <td>${constraintHtml}</td>
          <td style="color:var(--text-muted);font-size:12px">${f.default_val ?? '—'}</td>
          <td style="white-space:nowrap">
            <button class="btn sm" onclick="openEditFieldForm(${f.id})">编辑</button>
            <button class="btn sm danger" style="margin-left:4px" onclick="deleteField(${f.id},'${f.prop_key}')">删除</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function toggleFieldForm() {
  editingFieldId = null;
  document.getElementById('field-form-editing-hint').style.display = 'none';
  clearFieldForm();
  document.getElementById('ff-key').readOnly = false;
  const w = document.getElementById('field-form-wrap');
  w.style.display = w.style.display === 'none' ? 'block' : 'none';
  if (w.style.display === 'block') document.getElementById('ff-key').focus();
}

function openEditFieldForm(fid) {
  const f = fieldSchemas.find(x => x.id === fid);
  if (!f) return;
  editingFieldId = fid;
  document.getElementById('ff-key').value     = f.prop_key;
  document.getElementById('ff-key').readOnly  = true;
  document.getElementById('ff-type').value    = f.prop_type || 'string';
  document.getElementById('ff-id').checked    = !!f.is_id;
  document.getElementById('ff-required').checked = !!f.required;
  document.getElementById('ff-enum').value    = (f.enum_values || []).join('\n');
  document.getElementById('ff-regex').value   = f.regex_pattern || '';
  document.getElementById('ff-default').value = f.default_val || '';
  document.getElementById('ff-desc').value    = f.description || '';
  const hint = document.getElementById('field-form-editing-hint');
  hint.textContent = `正在编辑「${f.prop_key}」`;
  hint.style.display = 'inline';
  document.getElementById('field-form-wrap').style.display = 'block';
  document.getElementById('field-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelFieldForm() {
  editingFieldId = null;
  clearFieldForm();
  document.getElementById('field-form-wrap').style.display = 'none';
  document.getElementById('field-form-editing-hint').style.display = 'none';
}

function clearFieldForm() {
  ['ff-key','ff-enum','ff-regex','ff-default','ff-desc'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('ff-type').value = 'string';
  document.getElementById('ff-id').checked = false;
  document.getElementById('ff-required').checked = false;
}

function onIdCheckChange(cb) {
  // ID field is implicitly required
  if (cb.checked) document.getElementById('ff-required').checked = true;
}

async function saveField() {
  const key = document.getElementById('ff-key').value.trim();
  if (!key) { toast('请填写字段名', 'err'); return; }
  const body = {
    entity_type:   fieldModalCtx.entityType,
    entity_label:  fieldModalCtx.entityLabel,
    prop_key:      key,
    prop_type:     document.getElementById('ff-type').value,
    is_id:         document.getElementById('ff-id').checked,
    required:      document.getElementById('ff-required').checked,
    enum_values:   document.getElementById('ff-enum').value.split('\n').map(s => s.trim()).filter(Boolean),
    regex_pattern: document.getElementById('ff-regex').value.trim() || null,
    default_val:   document.getElementById('ff-default').value.trim() || null,
    description:   document.getElementById('ff-desc').value.trim() || null,
  };
  try {
    if (editingFieldId) {
      const updated = await api('PUT', `/schemas/${editingFieldId}`, body);
      const idx = fieldSchemas.findIndex(f => f.id === editingFieldId);
      if (idx >= 0) fieldSchemas[idx] = updated;
      toast('✅ 字段已更新');
    } else {
      const created = await api('POST', '/schemas', body);
      fieldSchemas.push(created);
      toast('✅ 字段已创建');
    }
    cancelFieldForm();
    renderFieldList();
    renderClasses();
    renderRelations();
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}

async function deleteField(fid, key) {
  if (!confirm(`确定删除字段「${key}」？`)) return;
  try {
    await api('DELETE', `/schemas/${fid}`);
    fieldSchemas = fieldSchemas.filter(f => f.id !== fid);
    toast('✅ 已删除');
    renderFieldList();
    renderClasses();
    renderRelations();
  } catch (e) { toast('删除失败: ' + e.message, 'err'); }
}

// ── Load everything ────────────────────────────────────────────────────────────
async function loadAll() {
  try {
    const [data, me, schemas] = await Promise.all([
      api('GET', '/ontology'),
      api('GET', '/auth/me'),
      api('GET', '/schemas'),
    ]);
    classes      = data.classes   || [];
    relations    = data.relations || [];
    vmode        = data.validation_mode || 'warn';
    currentRole  = me.role || 'user';
    fieldSchemas = schemas || [];
    renderClasses();
    renderRelations();
    renderConfigTab();
    updateModeBadge();
  } catch (e) { toast('加载失败: ' + e.message, 'err'); }
}

function updateModeBadge() {
  const b = document.getElementById('mode-badge');
  if (vmode === 'strict') {
    b.textContent = '严格模式'; b.className = 'mode-badge strict';
  } else {
    b.textContent = '宽松模式'; b.className = 'mode-badge warn';
  }
}

// ── Field helpers ──────────────────────────────────────────────────────────────
const TYPE_LABELS = { string: '文本', number: '数字', boolean: '布尔', date: '日期', list: '列表' };

function fieldCountBadges(entityType, entityLabel) {
  const fields = fieldSchemas.filter(f => f.entity_type === entityType && f.entity_label === entityLabel);
  if (!fields.length) return '<span style="color:var(--text-muted);font-size:12px">未定义</span>';
  const idCnt  = fields.filter(f => f.is_id).length;
  const reqCnt = fields.filter(f => f.required).length;
  const conCnt = fields.filter(f => (f.enum_values && f.enum_values.length) || f.regex_pattern).length;
  const parts = [];
  if (idCnt)  parts.push(`<span class="fbadge fbadge-id">🔑 ${idCnt}</span>`);
  if (reqCnt) parts.push(`<span class="fbadge fbadge-required">★ ${reqCnt}</span>`);
  if (conCnt) parts.push(`<span class="fbadge fbadge-constrained">⚡ ${conCnt}</span>`);
  if (!parts.length) parts.push(`<span style="color:var(--text-muted);font-size:12px">${fields.length} 个字段</span>`);
  return `<div class="field-count-wrap">${parts.join('')}</div>`;
}

function fieldCategoryBadges(f) {
  const b = [];
  if (f.is_id) b.push('<span class="fbadge fbadge-id">🔑 ID</span>');
  if (f.required && !f.is_id) b.push('<span class="fbadge fbadge-required">★ 必填</span>');
  if (f.is_id) b.push('<span class="fbadge fbadge-required">★ 必填</span>');  // ID implies required
  if ((f.enum_values && f.enum_values.length) || f.regex_pattern)
    b.push('<span class="fbadge fbadge-constrained">⚡ 约束</span>');
  if (!b.length) b.push('<span class="fbadge fbadge-normal">普通</span>');
  return b.join(' ');
}

// ── Render classes ─────────────────────────────────────────────────────────────
function renderClasses() {
  const tbody = document.getElementById('class-tbody');
  if (!classes.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">暂无类定义，点击「新建类」添加</td></tr>';
    return;
  }
  tbody.innerHTML = classes.map(c => `
    <tr>
      <td><b>${c.icon || '⬡'} ${c.label_name}</b></td>
      <td>${c.display_name || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span class="color-dot" style="background:${c.color || '#4C8EDA'}"></span> <code style="font-size:11px">${c.color || ''}</code></td>
      <td style="color:var(--text-muted)">${c.description || '—'}</td>
      <td>${fieldCountBadges('node', c.label_name)}</td>
      <td style="color:var(--text-muted);font-size:12px">${c.created_by}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" onclick="openFieldModal('node','${c.label_name}','${(c.display_name||c.label_name).replace(/'/g,'&#39;')}')">字段</button>
        <button class="btn sm" style="margin-left:4px" onclick="openClassModal(${c.id})">编辑</button>
        <button class="btn sm danger" style="margin-left:4px" onclick="deleteClass(${c.id},'${c.label_name}')">删除</button>
      </td>
    </tr>
  `).join('');
}

// ── Render relations ───────────────────────────────────────────────────────────
function renderRelations() {
  const tbody = document.getElementById('rel-tbody');
  if (!relations.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">暂无关系约束，点击「新建关系约束」添加</td></tr>';
    return;
  }
  tbody.innerHTML = relations.map(r => {
    const srcColor = classColor(r.source_label);
    const tgtColor = classColor(r.target_label);
    const tripleHtml = `
      <div class="triple">
        <span class="triple-node" style="border-color:${srcColor}44;color:${srcColor}">${r.source_label}</span>
        <div class="triple-arrow">──<span class="triple-rel">${r.rel_type}</span>──▶</div>
        <span class="triple-node" style="border-color:${tgtColor}44;color:${tgtColor}">${r.target_label}</span>
      </div>`;
    return `<tr>
      <td>${tripleHtml}</td>
      <td>${r.display_name || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="color:var(--text-muted)">${r.description || '—'}</td>
      <td>${fieldCountBadges('edge', r.rel_type)}</td>
      <td style="color:var(--text-muted);font-size:12px">${r.created_by}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" onclick="openFieldModal('edge','${r.rel_type}','${(r.display_name||r.rel_type).replace(/'/g,'&#39;')}')">字段</button>
        <button class="btn sm" style="margin-left:4px" onclick="openRelModal(${r.id})">编辑</button>
        <button class="btn sm danger" style="margin-left:4px" onclick="deleteRelation(${r.id},'${r.rel_type}')">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function classColor(label) {
  const c = classes.find(x => x.label_name === label);
  return c ? c.color : '#8b949e';
}

// ── Ontology graph visualization ───────────────────────────────────────────────
function renderOntologyGraph() {
  const wrap = document.getElementById('ontology-graph-wrap');
  if (!classes.length && !relations.length) {
    wrap.innerHTML = '<div class="graph-empty">暂无本体数据，定义类和关系后显示可视化图</div>';
    return;
  }

  // Collect all labels mentioned (classes + wildcard refs in relations)
  const labelSet = new Set(classes.map(c => c.label_name));
  relations.forEach(r => { labelSet.add(r.source_label); labelSet.add(r.target_label); });

  const visNodes = [...labelSet].map(lbl => {
    const cls = classes.find(c => c.label_name === lbl);
    const color = cls ? cls.color : '#8b949e';
    return {
      id: lbl,
      label: (cls ? (cls.icon || '⬡') + ' ' : '') + lbl + (cls && cls.display_name ? '\n' + cls.display_name : ''),
      color: { background: color, border: color, highlight: { background: color, border: '#fff' } },
      font: { color: '#fff', size: 13, face: 'sans-serif' },
      borderWidth: 2, shape: 'dot', size: 22,
      shadow: { enabled: true, color: 'rgba(0,0,0,.4)', size: 8 },
    };
  });

  const visEdges = relations.map((r, i) => ({
    id: i,
    from: r.source_label,
    to: r.target_label,
    label: r.display_name || r.rel_type,
    arrows: 'to',
    color: { color: '#58a6ff', highlight: '#79c0ff' },
    font: { color: '#8b949e', size: 11, align: 'middle' },
    smooth: { type: 'curvedCW', roundness: 0.2 },
  }));

  wrap.innerHTML = '<div id="ontology-graph"></div>';
  const container = document.getElementById('ontology-graph');
  if (ontologyNetwork) { ontologyNetwork.destroy(); ontologyNetwork = null; }
  ontologyNetwork = new vis.Network(container,
    { nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) },
    {
      physics: { barnesHut: { gravitationalConstant: -6000, springLength: 160 }, stabilization: { iterations: 100 } },
      interaction: { hover: true, tooltipDelay: 200 },
      manipulation: { enabled: false },
    }
  );
  ontologyNetwork.on('stabilizationIterationsDone', () =>
    ontologyNetwork.setOptions({ physics: { enabled: false } })
  );
}

// ── Config tab ─────────────────────────────────────────────────────────────────
function renderConfigTab() {
  const isAdmin = currentRole === 'admin';
  document.querySelectorAll('input[name="vmode"]').forEach(r => {
    r.checked   = r.value === vmode;
    r.disabled  = !isAdmin;
  });
  document.querySelectorAll('.radio-option').forEach(el => {
    el.style.cursor  = isAdmin ? 'pointer' : 'not-allowed';
    el.style.opacity = isAdmin ? '1' : '0.55';
  });
  document.getElementById('opt-warn').classList.toggle('selected',   vmode === 'warn');
  document.getElementById('opt-strict').classList.toggle('selected', vmode === 'strict');

  const hint = document.getElementById('config-admin-hint');
  if (!isAdmin) {
    if (!hint) {
      const h = document.createElement('p');
      h.id = 'config-admin-hint';
      h.style.cssText = 'margin-top:12px;font-size:12px;color:var(--text-muted)';
      h.textContent = '仅管理员可修改校验模式。';
      document.querySelector('.config-card').appendChild(h);
    }
  } else if (hint) {
    hint.remove();
  }
}

async function saveConfig(mode) {
  try {
    await api('PUT', '/ontology/config', { validation_mode: mode });
    vmode = mode;
    updateModeBadge();
    renderConfigTab();
    toast(mode === 'strict' ? '✅ 已切换为严格模式' : '✅ 已切换为宽松模式');
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}

// ── Class modal ────────────────────────────────────────────────────────────────
function openClassModal(id) {
  editingClassId = id;
  const c = id ? classes.find(x => x.id === id) : null;
  document.getElementById('class-modal-title').textContent = id ? '编辑类' : '新建类';
  document.getElementById('cm-label').value   = c ? c.label_name   : '';
  document.getElementById('cm-display').value = c ? (c.display_name || '') : '';
  document.getElementById('cm-color').value   = c ? (c.color || '#4C8EDA') : '#4C8EDA';
  document.getElementById('cm-color-picker').value = c ? (c.color || '#4C8EDA') : '#4C8EDA';
  document.getElementById('cm-icon').value    = c ? (c.icon || '') : '';
  document.getElementById('cm-desc').value    = c ? (c.description || '') : '';
  document.getElementById('cm-label').readOnly = !!id;  // can't rename label
  document.getElementById('class-modal').classList.remove('hidden');
}

function syncColor(picker) {
  document.getElementById('cm-color').value = picker.value;
}
function syncColorPicker(input) {
  if (/^#[0-9a-fA-F]{6}$/.test(input.value))
    document.getElementById('cm-color-picker').value = input.value;
}

async function saveClass() {
  const label   = document.getElementById('cm-label').value.trim();
  const display = document.getElementById('cm-display').value.trim() || null;
  const color   = document.getElementById('cm-color').value.trim() || '#4C8EDA';
  const icon    = document.getElementById('cm-icon').value.trim() || '⬡';
  const desc    = document.getElementById('cm-desc').value.trim() || null;
  if (!label) { toast('请填写标签名', 'err'); return; }
  try {
    if (editingClassId) {
      await api('PUT', `/ontology/classes/${editingClassId}`, { display_name: display, description: desc, color, icon });
      toast('✅ 已更新');
    } else {
      await api('POST', '/ontology/classes', { label_name: label, display_name: display, description: desc, color, icon });
      toast('✅ 已创建');
    }
    closeModal('class-modal');
    await loadAll();
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}

async function deleteClass(id, label) {
  if (!confirm(`确定删除类「${label}」？\n关联的关系约束也会一并删除。`)) return;
  try {
    await api('DELETE', `/ontology/classes/${id}`);
    toast('✅ 已删除');
    await loadAll();
  } catch (e) { toast('删除失败: ' + e.message, 'err'); }
}

// ── Relation modal ─────────────────────────────────────────────────────────────
function openRelModal(id) {
  editingRelId = id || null;
  const r = id ? relations.find(x => x.id === id) : null;
  const isEdit = !!r;

  document.getElementById('rel-modal-title').textContent = isEdit ? '编辑关系约束' : '新建关系约束';

  // Triple fields: readonly in edit mode
  ['rm-triple-group', 'rm-rel-group', 'rm-tgt-group'].forEach(gid => {
    document.getElementById(gid).style.opacity = isEdit ? '0.5' : '1';
  });
  const srcEl = document.getElementById('rm-src');
  const relEl = document.getElementById('rm-rel');
  const tgtEl = document.getElementById('rm-tgt');
  srcEl.value    = r ? r.source_label : '';
  relEl.value    = r ? r.rel_type     : '';
  tgtEl.value    = r ? r.target_label : '';
  srcEl.readOnly = isEdit;
  relEl.readOnly = isEdit;
  tgtEl.readOnly = isEdit;

  document.getElementById('rm-display').value = r ? (r.display_name || '') : '';
  document.getElementById('rm-desc').value    = r ? (r.description  || '') : '';

  // Populate datalists
  const opts = ['<option value="*">',
    ...classes.map(c => `<option value="${c.label_name}">`)].join('');
  document.getElementById('rm-src-list').innerHTML = opts;
  document.getElementById('rm-tgt-list').innerHTML = opts;

  document.getElementById('rel-modal').classList.remove('hidden');
  document.getElementById('rm-display').focus();
}

async function saveRelation() {
  const display = document.getElementById('rm-display').value.trim() || null;
  const desc    = document.getElementById('rm-desc').value.trim() || null;

  try {
    if (editingRelId) {
      await api('PUT', `/ontology/relations/${editingRelId}`, { display_name: display, description: desc });
      toast('✅ 已更新');
    } else {
      const src = document.getElementById('rm-src').value.trim();
      const rel = document.getElementById('rm-rel').value.trim().toUpperCase();
      const tgt = document.getElementById('rm-tgt').value.trim();
      if (!src || !rel || !tgt) { toast('起点、关系类型、终点均为必填', 'err'); return; }
      await api('POST', '/ontology/relations', { rel_type: rel, source_label: src, target_label: tgt, display_name: display, description: desc });
      toast('✅ 关系约束已创建');
    }
    closeModal('rel-modal');
    await loadAll();
    renderOntologyGraph();
  } catch (e) { toast('保存失败: ' + e.message, 'err'); }
}

async function deleteRelation(id, rel) {
  if (!confirm(`确定删除关系约束「${rel}」？`)) return;
  try {
    await api('DELETE', `/ontology/relations/${id}`);
    toast('✅ 已删除');
    await loadAll();
    renderOntologyGraph();
  } catch (e) { toast('删除失败: ' + e.message, 'err'); }
}

// ── Modal helpers ──────────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) closeModal(o.id); })
);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(o => closeModal(o.id));
});

// ── Init ───────────────────────────────────────────────────────────────────────
loadAll();
