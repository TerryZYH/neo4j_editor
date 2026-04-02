// ══════════════════════════════════════════════════════════════════════════════
// 3D Graph Implementation
// ══════════════════════════════════════════════════════════════════════════════

// ── 2D label overlay (always-visible labels via canvas projection) ────────────
let _labelOverlayCtx = null;
let _labelLoopActive = false;
let _labelTmpCanvas = null; // offscreen canvas for per-label occlusion masking
let _labelTmpCtx = null;

function _initLabelOverlay(container) {
  const prev = container.querySelector('.g3d-lbl');
  if (prev) prev.remove();
  const cvs = document.createElement('canvas');
  cvs.className = 'g3d-lbl';
  // z-index:10 — must be below the tooltip (z-index:20) which 3d-force-graph
  // appends into the same wrapper div after us, making them true siblings so
  // z-index comparison works correctly.
  cvs.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
  cvs.width  = container.offsetWidth  || 800;
  cvs.height = container.offsetHeight || 600;
  // Append into 3d-force-graph's own wrapper div (first child of container)
  // so the canvas and the tooltip are siblings in the same stacking context.
  const wrapper = container.querySelector(':scope > div') || container;
  wrapper.appendChild(cvs);
  _labelOverlayCtx = cvs.getContext('2d');
  new ResizeObserver(() => {
    cvs.width  = container.offsetWidth;
    cvs.height = container.offsetHeight;
  }).observe(container);
}

// Pure-JS 3D→2D projection using matrix elements directly (no THREE dependency)
function _proj3D(x, y, z, camera, W, H) {
  try {
    const mw = camera.matrixWorldInverse.elements; // Float32Array, col-major
    const mp = camera.projectionMatrix.elements;
    // view transform
    const vx = mw[0]*x + mw[4]*y + mw[8]*z  + mw[12];
    const vy = mw[1]*x + mw[5]*y + mw[9]*z  + mw[13];
    const vz = mw[2]*x + mw[6]*y + mw[10]*z + mw[14];
    const vw = mw[3]*x + mw[7]*y + mw[11]*z + mw[15];
    // projection
    const cx = mp[0]*vx + mp[4]*vy + mp[8]*vz  + mp[12]*vw;
    const cy = mp[1]*vx + mp[5]*vy + mp[9]*vz  + mp[13]*vw;
    const cz = mp[2]*vx + mp[6]*vy + mp[10]*vz + mp[14]*vw;
    const cw = mp[3]*vx + mp[7]*vy + mp[11]*vz + mp[15]*vw;
    if (Math.abs(cw) < 1e-6) return null;
    const nx = cx / cw, ny = cy / cw, nz = cz / cw;
    if (nz > 1 || nz < -1) return null; // outside clip range
    return { x: (nx + 1) / 2 * W, y: (-ny + 1) / 2 * H };
  } catch { return null; }
}

function _drawLabelsOverlay() {
  if (!_labelLoopActive) return;
  requestAnimationFrame(_drawLabelsOverlay);
  if (!is3DMode || !graph3d || !_labelOverlayCtx) return;

  const ctx = _labelOverlayCtx;
  const ovlay = ctx.canvas;

  // Get renderer canvas; compute its offset relative to the overlay canvas.
  // 3d-force-graph inserts a wrapper div, so the renderer canvas may not be
  // at (0,0) within our overlay — we must compensate.
  let rdom;
  try { rdom = graph3d.renderer().domElement; } catch { return; }

  const rRect  = rdom.getBoundingClientRect();
  const oRect  = ovlay.getBoundingClientRect();
  const offX   = rRect.left - oRect.left;
  const offY   = rRect.top  - oRect.top;

  // Keep overlay buffer at the same logical size as the renderer canvas
  const W = rdom.offsetWidth  || ovlay.width;
  const H = rdom.offsetHeight || ovlay.height;
  if (ovlay.width !== W)  ovlay.width  = W;
  if (ovlay.height !== H) ovlay.height = H;

  ctx.clearRect(0, 0, ovlay.width, ovlay.height);


  const { nodes } = graph3d.graphData();
  const camera = graph3d.camera();
  if (!camera) return;
  const camPos = camera.position;

  // 3d-force-graph sphere radius = cbrt(nodeVal) * NODE_REL_SIZE
  const NODE_REL_SIZE = 4;

  function stamp(text, sx, sy, fs) {
    ctx.font = `bold ${fs}px "Segoe UI",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, fs * 0.25);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, sx, sy);
  }

  // Compute the screen-space radius of a sphere by projecting a point that is
  // offset perpendicular to the camera view direction. This avoids relying on
  // camera.fov (which may be stale) and works regardless of camera orientation.
  function screenRadius(nx, ny, nz, worldR, centerP) {
    // Vector from node to camera
    const tcx = camPos.x - nx, tcy = camPos.y - ny, tcz = camPos.z - nz;
    const tcLen = Math.hypot(tcx, tcy, tcz) || 1;
    // Cross with world-up (0,1,0) → right vector perpendicular to view
    // cross((tcx,tcy,tcz)/tcLen, (0,1,0)) = (tcz/tcLen, 0, -tcx/tcLen)
    let rx = tcz / tcLen, ry = 0, rz = -tcx / tcLen;
    const rLen = Math.hypot(rx, ry, rz);
    if (rLen < 1e-6) { rx = 1; ry = 0; rz = 0; } // degenerate: camera directly above
    else { rx /= rLen; ry /= rLen; rz /= rLen; }
    // Project the rim point
    const p2 = graph3d.graph2ScreenCoords(nx + worldR * rx, ny + worldR * ry, nz + worldR * rz);
    return p2 ? Math.hypot(p2.x - centerP.x, p2.y - centerP.y) : 8;
  }

  try {
    // ── Pass 1: project every node, compute screen radius & camera distance ──
    const infos = [];
    nodes.forEach(node => {
      if (node.x == null || !node._data) return;
const lbl = nodeLabel(node._data);
      if (!lbl) return;

      const nx = node.x, ny = node.y || 0, nz = node.z || 0;
      const p = graph3d.graph2ScreenCoords(nx, ny, nz);
      if (!p) return;

      // Discard nodes projected far outside the canvas (behind camera, etc.)
      const sx = p.x + offX, sy = p.y + offY;
      const margin = Math.max(W, H);
      if (sx < -margin || sx > W + margin || sy < -margin || sy > H + margin) return;

      const nVal = lockedEntities.has(node.id) ? 14 : 8;
      const worldR = Math.cbrt(nVal) * NODE_REL_SIZE;
      const dist = Math.hypot(nx - camPos.x, ny - camPos.y, nz - camPos.z);
      const sr = Math.min(screenRadius(nx, ny, nz, worldR, p), Math.max(W, H) * 0.5);

      infos.push({ lbl, sx, sy, screenR: sr, dist });
    });

    // ── Pass 2: sort near→far (index 0 = closest to camera) ─────────────────
    infos.sort((a, b) => a.dist - b.dist);

    // ── Pass 3: draw far→near; mask out closer node spheres per label ────────
    // Use an offscreen canvas + destination-out for correct union masking.
    // (evenodd clip breaks when a label is inside an even number of circles.)
    if (!_labelTmpCanvas) {
      _labelTmpCanvas = document.createElement('canvas');
      _labelTmpCtx = _labelTmpCanvas.getContext('2d');
    }
    if (_labelTmpCanvas.width !== ovlay.width)  _labelTmpCanvas.width  = ovlay.width;
    if (_labelTmpCanvas.height !== ovlay.height) _labelTmpCanvas.height = ovlay.height;
    const tc = _labelTmpCtx;

    for (let i = infos.length - 1; i >= 0; i--) {
      const { lbl, sx, sy, screenR } = infos[i];
      if (screenR < 2) continue; // node too small to label

      const fs = Math.max(4, Math.min(14, screenR * 2 * 0.35));

      // 1. Clear temp canvas and draw the label onto it
      tc.clearRect(0, 0, _labelTmpCanvas.width, _labelTmpCanvas.height);
      tc.globalCompositeOperation = 'source-over';
      tc.font = `bold ${fs}px "Segoe UI",sans-serif`;
      tc.textAlign = 'center';
      tc.textBaseline = 'middle';
      tc.lineWidth = Math.max(2, fs * 0.25);
      tc.strokeStyle = 'rgba(0,0,0,0.8)';
      tc.strokeText(lbl, sx, sy);
      tc.fillStyle = '#ffffff';
      tc.fillText(lbl, sx, sy);

      // 2. Erase every pixel covered by any closer node's sphere.
      //    destination-out is a pixel-wise union: 1 circle or 10 circles —
      //    any overlap erases the label, regardless of parity.
      if (i > 0) {
        tc.globalCompositeOperation = 'destination-out';
        for (let j = 0; j < i; j++) {
          const c = infos[j];
          tc.beginPath();
          tc.arc(c.sx, c.sy, c.screenR, 0, Math.PI * 2);
          tc.fill();
        }
        tc.globalCompositeOperation = 'source-over';
      }

      // 3. Composite the masked label onto the main overlay
      ctx.drawImage(_labelTmpCanvas, 0, 0);
    }
  } catch { /* don't kill the loop */ }

}

// ── Helper: get connected edges in both 2D and 3D mode ────────────────────────
function _getConnectedEdges(nodeId) {
  if (!is3DMode && network) return network.getConnectedEdges(nodeId);
  return visEdges.get().filter(e => e.from === nodeId || e.to === nodeId).map(e => e.id);
}

// ── 3D node color (accounts for selection and lock state) ─────────────────────
function _3dNodeColor(node) {
  if (_3dSelected.has(node.id)) return '#ffffff';
  const lk = lockedEntities.get(node.id);
  if (lk) return lk.color || '#888888';
  return getLabelColor((node._data && node._data.labels && node._data.labels[0]) || 'Node');
}

// ── Clear 3D selection ────────────────────────────────────────────────────────
function _3dClearSelection() {
  _3dSelected.clear();
  selectedNodeIds = [];
  selectedEdgeIds = [];
  if (graph3d) graph3d.nodeColor(n => _3dNodeColor(n));
}

// ── Focus a node in 3D (smooth camera move) ───────────────────────────────────
function graph3dFocusNode(nodeId) {
  if (!is3DMode || !graph3d) return;
  const gd = graph3d.graphData();
  const node = gd.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const dist = 120;
  const nx = node.x || 0, ny = node.y || 0, nz = node.z || 0;
  const len = Math.hypot(nx, ny, nz) || 1;
  graph3d.cameraPosition(
    { x: nx + (nx / len) * dist, y: ny + (ny / len) * dist, z: nz + (nz / len) * dist },
    { x: nx, y: ny, z: nz },
    800
  );
}

// ── Build 3D graph data from vis DataSets (preserving existing positions) ──────
function syncTo3D() {
  if (!graph3d) return;
  // Preserve existing node positions across re-syncs
  const existingPos = new Map();
  graph3d.graphData().nodes.forEach(n => {
    existingPos.set(n.id, { x: n.x, y: n.y, z: n.z, fx: n.fx, fy: n.fy, fz: n.fz });
  });

  const nodes = visNodes.get().map(vn => {
    const pos = existingPos.get(vn.id) || {};
    return Object.assign({ id: vn.id, _data: vn._data, _label: vn.label }, pos);
  });

  const links = visEdges.get().map(ve => ({
    id: ve.id, from: ve.from, to: ve.to, _label: ve.label, _data: ve._data,
  }));

  graph3d.graphData({ nodes, links });
}

// ── Initialize 3D graph ───────────────────────────────────────────────────────
function init3DNetwork() {
  if (graph3d) { syncTo3D(); return; }
  const container = document.getElementById('graph-canvas-3d');
  if (!container.offsetWidth || !container.offsetHeight) {
    // Container not yet laid out, retry
    requestAnimationFrame(() => init3DNetwork()); return;
  }

  const cW = container.offsetWidth, cH = container.offsetHeight;

  graph3d = ForceGraph3D()(container)
    .width(cW).height(cH)
    .backgroundColor('#0d1117')
    .nodeId('id')
    .linkSource('from')
    .linkTarget('to')

    // Node appearance
    .nodeColor(n => _3dNodeColor(n))
    .nodeOpacity(1)
    .nodeResolution(24)
    .nodeVal(n => lockedEntities.has(n.id) ? 14 : 8)
    .nodeLabel('')
    // Link appearance
    .linkColor(() => '#8b949e')
    .linkOpacity(0.7)
    .linkWidth(0.5)
    .linkDirectionalArrowLength(5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(() => '#8b949e')
    .linkLabel(l => l._label || '')

    // Node interactions (click/dblclick via timer)
    .onNodeClick((node, event) => {
      // Double-click detection
      if (_3dClickTimer && _3dClickNodeId === node.id) {
        clearTimeout(_3dClickTimer);
        _3dClickTimer = null;
        _3dClickNodeId = null;
        openEditNodeModal(node.id);
        return;
      }
      _3dClickNodeId = node.id;
      _3dClickTimer = setTimeout(() => {
        _3dClickTimer = null;
        _3dClickNodeId = null;
        // Single click: select
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          if (_3dSelected.has(node.id)) _3dSelected.delete(node.id);
          else _3dSelected.add(node.id);
        } else {
          _3dSelected.clear();
          _3dSelected.add(node.id);
        }
        selectedNodeIds = [..._3dSelected];
        selectedEdgeIds = [];
        graph3d.nodeColor(n => _3dNodeColor(n));

        if (selectedNodeIds.length > 1) {
          showMultiInspector(selectedNodeIds.length);
        } else if (selectedNodeIds.length === 1) {
          const vn = visNodes.get(selectedNodeIds[0]);
          if (vn) showNodeInspector(vn._data);
        } else {
          hideInspector();
        }
      }, 240);
    })

    // Link interactions (click/dblclick via timer)
    .onLinkClick((link) => {
      if (_3dLinkClickTimer && _3dClickLinkId === link.id) {
        clearTimeout(_3dLinkClickTimer);
        _3dLinkClickTimer = null;
        _3dClickLinkId = null;
        openEditEdgeModal(link.id);
        return;
      }
      _3dClickLinkId = link.id;
      _3dLinkClickTimer = setTimeout(() => {
        _3dLinkClickTimer = null;
        _3dClickLinkId = null;
        _3dSelected.clear();
        selectedNodeIds = [];
        selectedEdgeIds = [link.id];
        graph3d.nodeColor(n => _3dNodeColor(n));
        const ve = visEdges.get(link.id);
        if (ve) showEdgeInspector(ve._data);
      }, 240);
    })


    // Background click: deselect
    .onBackgroundClick(() => {
      _3dClearSelection();
      hideInspector();
    })

    // Node drag: fix position, disable orbit controls to prevent view rotation
    .onNodeDrag((node) => {
      node.fx = node.x; node.fy = node.y; node.fz = node.z;
      graph3d.controls().enabled = false;
    })
    .onNodeDragEnd(() => {
      graph3d.controls().enabled = true;
    });

  syncTo3D();
  _initLabelOverlay(container);
  _labelLoopActive = true;
  requestAnimationFrame(_drawLabelsOverlay);

  // Subscribe to DataSet changes for real-time 3D sync
  visNodes.on('*', () => { if (is3DMode && graph3d) syncTo3D(); });
  visEdges.on('*', () => { if (is3DMode && graph3d) syncTo3D(); });

  // Keep canvas dimensions in sync when container resizes
  new ResizeObserver(() => {
    if (!graph3d) return;
    const w = container.offsetWidth, h = container.offsetHeight;
    if (w && h) graph3d.width(w).height(h);
  }).observe(container);
}

// ── Switch between 2D and 3D view ─────────────────────────────────────────────
function setViewMode(enable3D) {
  is3DMode = enable3D;

  document.getElementById('graph-canvas').style.display    = enable3D ? 'none' : '';
  document.getElementById('graph-canvas-3d').style.display = enable3D ? 'block' : 'none';
  document.getElementById('btn-2d').classList.toggle('active', !enable3D);
  document.getElementById('btn-3d').classList.toggle('active', enable3D);
  document.getElementById('canvas-hint').textContent = enable3D
    ? '点击选中 · 双击编辑 · Ctrl+点击多选 · 拖拽旋转'
    : '单击选中 · 双击编辑 · 拖拽移动';

  if (enable3D) {
    if (typeof ForceGraph3D === 'undefined') {
      toast('⚠️ 3D 引擎尚未加载，请稍后重试', 'err');
      setViewMode(false); return;
    }
    // Wait for browser to compute container layout before init
    requestAnimationFrame(() => {
      init3DNetwork();
      // Restart label loop if graph already existed
      if (!_labelLoopActive) { _labelLoopActive = true; requestAnimationFrame(_drawLabelsOverlay); }
    });
  } else {
    // Stop label overlay loop and clear 3D selection state
    _labelLoopActive = false;
    _3dSelected.clear();
  }
  hideInspector();
}
