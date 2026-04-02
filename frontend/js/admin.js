const API = 'http://localhost:8000/api';
let token = localStorage.getItem('auth_token');

// ── Auth check ─────────────────────────────────────────────────────────────
async function checkAuth() {
  if (!token) { location.href = '/'; return; }
  try {
    const res = await fetch(API + '/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { location.href = '/'; return; }
    const user = await res.json();
    if (user.role !== 'admin') { alert('需要管理员权限'); location.href = '/'; return; }
    document.getElementById('admin-name').textContent = user.username;
  } catch { location.href = '/'; }
}

function doLogout() {
  localStorage.removeItem('auth_token');
  location.href = '/';
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function apiFetch(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    const names = ['users','sessions','locks'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'users')    loadUsers();
  if (name === 'sessions') loadSessions();
  if (name === 'locks')    loadLocks();
}

// ── Users ──────────────────────────────────────────────────────────────────
const USER_COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63","#00bcd4","#ff5722"];
function userColor(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = Math.imul(31, h) + username.charCodeAt(i) | 0;
  return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

async function loadUsers() {
  try {
    const users = await apiFetch('GET', '/admin/users');
    const tbody = document.getElementById('users-table');
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无用户</td></tr>'; return; }
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>
          <span class="user-dot" style="background:${userColor(u.username)}"></span>
          <strong>${u.username}</strong>
        </td>
        <td style="color:var(--text-muted)">${u.email}</td>
        <td><span class="badge ${u.role}">${u.role === 'admin' ? '管理员' : '普通用户'}</span></td>
        <td><span class="badge ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? '启用' : '禁用'}</span></td>
        <td style="color:var(--text-muted);font-size:12px">${u.created_at.slice(0,16)}</td>
        <td>
          <div class="actions">
            <button class="btn sm" onclick="openEditModal(${u.id},'${u.username}','${u.email}','${u.role}',${u.is_active})">编辑</button>
            <button class="btn sm danger" onclick="deleteUser(${u.id},'${u.username}')">删除</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function deleteUser(id, username) {
  if (!confirm(`确定删除用户「${username}」吗？`)) return;
  try {
    await apiFetch('DELETE', `/admin/users/${id}`);
    toast('✅ 用户已删除');
    loadUsers();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// ── User modal ─────────────────────────────────────────────────────────────
function openCreateModal() {
  document.getElementById('modal-title').textContent = '新建用户';
  document.getElementById('modal-user-id').value = '';
  document.getElementById('modal-username').value = '';
  document.getElementById('modal-email').value = '';
  document.getElementById('modal-password').value = '';
  document.getElementById('modal-role').value = 'user';
  document.getElementById('modal-pw-label').textContent = '密码';
  document.getElementById('modal-email-group').style.display = '';
  document.getElementById('modal-active-group').style.display = 'none';
  document.getElementById('modal-username').readOnly = false;
  document.getElementById('user-modal').classList.remove('hidden');
}

function openEditModal(id, username, email, role, isActive) {
  document.getElementById('modal-title').textContent = '编辑用户';
  document.getElementById('modal-user-id').value = id;
  document.getElementById('modal-username').value = username;
  document.getElementById('modal-username').readOnly = true;
  document.getElementById('modal-email').value = email;
  document.getElementById('modal-password').value = '';
  document.getElementById('modal-role').value = role;
  document.getElementById('modal-active').value = isActive ? '1' : '0';
  document.getElementById('modal-pw-label').textContent = '新密码（留空不修改）';
  document.getElementById('modal-email-group').style.display = 'none';
  document.getElementById('modal-active-group').style.display = '';
  document.getElementById('user-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('user-modal').classList.add('hidden');
}

async function saveUser() {
  const userId = document.getElementById('modal-user-id').value;
  const isEdit = !!userId;

  try {
    if (isEdit) {
      const body = {
        role: document.getElementById('modal-role').value,
        is_active: document.getElementById('modal-active').value === '1',
      };
      const pw = document.getElementById('modal-password').value;
      if (pw) body.password = pw;
      await apiFetch('PUT', `/admin/users/${userId}`, body);
      toast('✅ 用户已更新');
    } else {
      const username = document.getElementById('modal-username').value.trim();
      const email    = document.getElementById('modal-email').value.trim();
      const password = document.getElementById('modal-password').value;
      const role     = document.getElementById('modal-role').value;
      await apiFetch('POST', '/admin/users', { username, email, password, role });
      toast('✅ 用户已创建');
    }
    closeModal();
    loadUsers();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// ── Sessions ───────────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await apiFetch('GET', '/admin/sessions');
    const tbody = document.getElementById('sessions-table');
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">当前无在线用户</td></tr>';
      return;
    }
    tbody.innerHTML = sessions.map(s => `
      <tr>
        <td><span class="user-dot" style="background:${s.color}"></span>${s.username}</td>
        <td><span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${s.color};vertical-align:middle"></span> ${s.color}</td>
      </tr>
    `).join('');
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// ── Locks ──────────────────────────────────────────────────────────────────
async function loadLocks() {
  try {
    const locks = await apiFetch('GET', '/admin/locks');
    const tbody = document.getElementById('locks-table');
    if (!locks.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">当前无编辑锁</td></tr>';
      return;
    }
    tbody.innerHTML = locks.map(lk => `
      <tr>
        <td style="font-size:12px;color:var(--text-muted);font-family:monospace">${lk.entity_id.slice(-16)}</td>
        <td><span class="user-dot" style="background:${lk.color}"></span>${lk.username}</td>
        <td style="color:var(--text-muted);font-size:12px">${lk.locked_at.slice(0,19).replace('T',' ')}</td>
        <td>
          <button class="btn sm danger" onclick="forceUnlock('${lk.entity_id}','${lk.username}')">强制解锁</button>
        </td>
      </tr>
    `).join('');
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

async function forceUnlock(entityId, username) {
  if (!confirm(`强制解除「${username}」持有的编辑锁？`)) return;
  try {
    await apiFetch('DELETE', `/admin/locks/${encodeURIComponent(entityId)}`);
    toast('✅ 编辑锁已解除');
    loadLocks();
  } catch (e) { toast('❌ ' + e.message, 'err'); }
}

// ── Init ───────────────────────────────────────────────────────────────────
checkAuth().then(() => loadUsers());
