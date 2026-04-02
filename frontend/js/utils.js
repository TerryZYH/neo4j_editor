// ── Utility functions ─────────────────────────────────────────────────────────

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Status indicator ──────────────────────────────────────────────────────────
function setConnectionStatus(connected) {
  document.getElementById('status-dot').className = 'status-dot ' + (connected ? 'ok' : 'err');
  document.getElementById('status-text').textContent = connected ? '已连接' : '已断线';
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  try {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {}),
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(API + path, opts);
    if (resp.status === 401) {
      doLogout();
      throw new Error('登录已过期，请重新登录');
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || resp.statusText);
    }
    return await resp.json();
  } catch (e) {
    toast('❌ ' + e.message, 'err');
    throw e;
  }
}
