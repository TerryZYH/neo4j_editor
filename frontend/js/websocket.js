// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  if (!authToken) return;
  clearTimeout(wsReconnectTimer);
  try {
    ws = new WebSocket(`${WS_URL}?token=${authToken}`);
    ws.onopen = () => {
      console.log('WS connected');
      setConnectionStatus(true);
      if (wsEverConnected) {
        // 断线重连后自动刷新图谱，补齐断线期间的变更
        loadCurrentView();
      }
      wsEverConnected = true;
    };
    ws.onmessage = (e) => {
      try { handleWSMessage(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = (e) => {
      if (e.code === 4001) { doLogout(); return; }
      setConnectionStatus(false);
      // Reconnect after 3s
      wsReconnectTimer = setTimeout(connectWS, 3000);
    };
    ws.onerror = () => {};
  } catch {}
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'init':
      // Populate online users and locks from server state
      onlineUsers.clear();
      msg.users.forEach(u => { if (u.username !== currentUser?.username) onlineUsers.set(u.user_id, u); });
      lockedEntities.clear();
      Object.values(msg.locks || {}).forEach(lk => lockedEntities.set(lk.entity_id, lk));
      renderOnlineUsers();
      // Apply existing locks visually
      lockedEntities.forEach((lk, eid) => applyLockVisual(eid, true, lk.username, lk.color));
      break;

    case 'user_joined':
      if (msg.user.username !== currentUser?.username) {
        onlineUsers.set(msg.user.user_id, msg.user);
        renderOnlineUsers();
        toast(`👤 ${msg.user.username} 加入了编辑`);
      }
      break;

    case 'user_left':
      const u = onlineUsers.get(msg.user_id);
      if (u) { toast(`👤 ${u.username} 离开了编辑`); }
      onlineUsers.delete(msg.user_id);
      renderOnlineUsers();
      break;

    case 'lock_result': {
      const cb = lockCallbacks.get(msg.entity_id);
      if (cb) {
        lockCallbacks.delete(msg.entity_id);
        if (!msg.success) {
          toast(`🔒 ${msg.locked_by ? `正在被「${msg.locked_by}」编辑` : '锁定失败，请稍后重试'}`, 'err');
        }
        cb(msg.success);
      }
      break;
    }

    case 'entity_locked':
      lockedEntities.set(msg.entity_id, { user_id: msg.user_id, username: msg.username, color: msg.color });
      applyLockVisual(msg.entity_id, true, msg.username, msg.color);
      // Refresh inspector if this entity is open
      refreshInspectorLock(msg.entity_id, true, msg.username);
      break;

    case 'entity_unlocked':
      lockedEntities.delete(msg.entity_id);
      applyLockVisual(msg.entity_id, false);
      refreshInspectorLock(msg.entity_id, false);
      break;

    case 'entity_created':
      if (msg.entity_type === 'node') {
        // In workspace mode only add if whitelisted
        if (!visNodes.get(msg.entity.id) &&
            (!currentWorkspace || workspaceNodeIds.has(msg.entity.id))) {
          visNodes.add(makeVisNode(msg.entity));
        }
      } else {
        // Edge: add only if both endpoints are visible
        if (!visEdges.get(msg.entity.id) &&
            visNodes.get(msg.entity.source) && visNodes.get(msg.entity.target)) {
          visEdges.add(makeVisEdge(msg.entity));
        }
      }
      updateStats(); updateEmptyState();
      break;

    case 'entity_updated':
      if (msg.entity_type === 'node') {
        const lk = lockedEntities.get(msg.entity.id);
        if (visNodes.get(msg.entity.id)) {
          visNodes.update(lk ? makeVisNodeLocked(msg.entity, lk.username, lk.color) : makeVisNode(msg.entity));
          if (selectedNodeIds.includes(msg.entity.id)) showNodeInspector(msg.entity);
        }
      } else {
        const existingE = visEdges.get(msg.entity.id);
        if (existingE) {
          visEdges.update(makeVisEdge(msg.entity));
          if (selectedEdgeIds.includes(msg.entity.id)) showEdgeInspector(msg.entity);
        }
      }
      break;

    case 'entity_deleted':
      if (msg.entity_type === 'node') {
        // Also remove from workspace whitelist
        workspaceNodeIds.delete(msg.entity_id);
        const connEdges = network ? network.getConnectedEdges(msg.entity_id) : [];
        visEdges.remove(connEdges);
        visNodes.remove(msg.entity_id);
        if (selectedNodeIds.includes(msg.entity_id)) hideInspector();
      } else {
        visEdges.remove(msg.entity_id);
        if (selectedEdgeIds.includes(msg.entity_id)) hideInspector();
      }
      updateStats(); updateEmptyState();
      break;

    case 'checkpoint_restored':
      toast(`✅ 存档「${msg.checkpoint_name}」已由 ${msg.restored_by} 恢复，图谱正在刷新…`);
      loadGraph();
      break;

    case 'operation_undone':
      toast(`↩ 「${msg.summary}」已由 ${msg.undone_by} 撤销，图谱正在刷新…`);
      loadGraph();
      break;
  }
}

// Heartbeat to keep locks alive
setInterval(() => wsSend({ type: 'heartbeat' }), 25000);

// ── Lock helpers ──────────────────────────────────────────────────────────────
function acquireLock(entityId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('⚠️ 未连接到协作服务器，将以本地模式编辑', 'err');
    return Promise.resolve(true);  // allow editing offline
  }
  return new Promise((resolve) => {
    lockCallbacks.set(entityId, resolve);
    wsSend({ type: 'lock_entity', entity_id: entityId });
    setTimeout(() => {
      if (lockCallbacks.has(entityId)) {
        lockCallbacks.delete(entityId);
        toast('⚠️ 锁定请求超时', 'err');
        resolve(false);
      }
    }, 5000);
  });
}

function releaseLock(entityId) {
  wsSend({ type: 'unlock_entity', entity_id: entityId });
}

// ── Lock visual ───────────────────────────────────────────────────────────────
function applyLockVisual(entityId, locked, username = '', color = '') {
  const vn = visNodes.get(entityId);
  if (vn) {
    if (locked) {
      visNodes.update(makeVisNodeLocked(vn._data, username, color));
    } else {
      visNodes.update(makeVisNode(vn._data));
    }
    return;
  }
  const ve = visEdges.get(entityId);
  if (ve) {
    if (locked) {
      visEdges.update({
        id: entityId,
        label: `${ve._data.type} 🔒${username}`,
        color: { color, highlight: color },
        width: 3,
        _data: ve._data,
      });
    } else {
      visEdges.update(makeVisEdge(ve._data));
    }
  }
}

function refreshInspectorLock(entityId, locked, username = '') {
  if (!selectedNodeIds.includes(entityId) && !selectedEdgeIds.includes(entityId)) return;
  const lockDiv = document.getElementById('inspector-lock-notice');
  const footer  = document.getElementById('inspector-footer');
  if (locked) {
    if (!lockDiv) {
      const div = document.createElement('div');
      div.id = 'inspector-lock-notice';
      div.className = 'lock-notice';
      div.textContent = `🔒 正在被「${username}」编辑，暂不可修改`;
      document.getElementById('inspector-body').prepend(div);
    }
    footer.querySelectorAll('.btn').forEach(b => { b.disabled = true; b.style.opacity = '.4'; });
  } else {
    if (lockDiv) lockDiv.remove();
    footer.querySelectorAll('.btn').forEach(b => { b.disabled = false; b.style.opacity = ''; });
  }
}

// ── Online users panel ────────────────────────────────────────────────────────
function renderOnlineUsers() {
  const container = document.getElementById('online-users');
  container.innerHTML = '';
  onlineUsers.forEach(u => {
    const av = document.createElement('div');
    av.className = 'user-avatar';
    av.style.background = u.color;
    av.textContent = u.username.charAt(0).toUpperCase();
    av.title = u.username;
    container.appendChild(av);
  });
}
