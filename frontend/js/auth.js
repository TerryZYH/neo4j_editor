// ── Auth functions ────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('form-login').style.display    = tab === 'login'    ? 'flex' : 'none';
  document.getElementById('form-register').style.display = tab === 'register' ? 'flex' : 'none';
  document.getElementById('auth-error').classList.remove('show');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.add('show');
}

async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { showAuthError('请填写用户名和密码'); return; }
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { showAuthError(data.detail || '登录失败'); return; }
    onLoginSuccess(data);
  } catch (e) { showAuthError('无法连接到服务器'); }
}

async function doRegister() {
  const username = document.getElementById('reg-username').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !email || !password) { showAuthError('请填写所有字段'); return; }
  try {
    const res = await fetch(API + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) { showAuthError(data.detail || '注册失败'); return; }
    onLoginSuccess(data);
  } catch (e) { showAuthError('无法连接到服务器'); }
}

function onLoginSuccess(data) {
  authToken = data.token;
  currentUser = { username: data.username, role: data.role };
  localStorage.setItem('auth_token', authToken);
  document.getElementById('auth-overlay').classList.add('hidden');
  initUserUI();
  connectWS();
  initNetwork();
  refreshLabels();
  loadOntology();
  loadWorkspaces().then(() => loadCurrentView());
}

function doLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('auth_token');
  if (ws) { ws.close(); ws = null; }
  document.getElementById('auth-overlay').classList.remove('hidden');
  // Reset UI
  document.getElementById('user-chip').style.display = 'none';
  document.getElementById('btn-logout').style.display = 'none';
  document.getElementById('admin-link').style.display = 'none';
  document.getElementById('ontology-link').style.display = 'none';
  document.getElementById('btn-export').style.display = 'none';
  document.getElementById('btn-import').style.display = 'none';
  document.getElementById('online-users').innerHTML = '';
}

function initUserUI() {
  if (!currentUser) return;
  // User chip
  const chip = document.getElementById('user-chip');
  chip.style.display = 'flex';
  document.getElementById('user-chip-name').textContent = currentUser.username;
  const roleEl = document.getElementById('user-chip-role');
  roleEl.textContent = currentUser.role === 'admin' ? '管理员' : '用户';
  roleEl.className = 'role-badge ' + currentUser.role;
  // Color the dot
  const fakeId = currentUser.username;
  const colors = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63","#00bcd4","#ff5722"];
  const color = colors[Math.abs(hashCode(fakeId)) % colors.length];
  document.getElementById('user-chip-dot').style.background = color;
  // Logout & admin
  document.getElementById('btn-logout').style.display = 'flex';
  document.getElementById('ontology-link').style.display = 'flex';
  if (currentUser.role === 'admin') {
    document.getElementById('admin-link').style.display = 'flex';
    document.getElementById('btn-export').style.display = 'flex';
    document.getElementById('btn-import').style.display = 'flex';
  }
}
