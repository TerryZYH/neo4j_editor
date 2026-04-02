// ── Config ────────────────────────────────────────────────────────────────────
const API              = 'http://localhost:8000/api';
const WS_URL           = 'ws://localhost:8000/ws';
const PHYSICS_SETTLE_MS = 3000;

// ── Ontology cache ────────────────────────────────────────────────────────────
let ontology = { classes: [], relations: [], validation_mode: 'warn' };

async function loadOntology() {
  try {
    ontology = await api('GET', '/ontology');
    // Refresh node colors if graph is already loaded
    if (visNodes) {
      const updates = visNodes.get().map(n => {
        const color = getLabelColor((n._data && n._data.labels && n._data.labels[0]) || 'Node');
        return { id: n.id, color: { background: color, border: color, highlight: { background: color, border: '#fff' } } };
      });
      if (updates.length) visNodes.update(updates);
      refreshLabels();
    }
  } catch { /* ignore */ }
}

// Get valid rel_types for a given (src_labels, tgt_labels) pair
function getValidRelTypes(srcLabels, tgtLabels) {
  if (!ontology.relations.length) return null; // no constraint → anything goes
  const valid = new Set();
  ontology.relations.forEach(r => {
    const srcOk = r.source_label === '*' || srcLabels.some(l => l === r.source_label);
    const tgtOk = r.target_label === '*' || tgtLabels.some(l => l === r.target_label);
    if (srcOk && tgtOk) valid.add(r.rel_type);
  });
  return [...valid];
}

// Validate a node label against ontology (warn or block)
function checkOntologyLabels(labels) {
  if (!ontology.classes.length) return true;
  const defined = new Set(ontology.classes.map(c => c.label_name));
  const bad = labels.filter(l => !defined.has(l));
  if (!bad.length) return true;
  const msg = `标签「${bad.join(', ')}」未在本体中定义`;
  if (ontology.validation_mode === 'strict') { toast('❌ ' + msg, 'err'); return false; }
  toast('⚠️ ' + msg, 'err');
  return true; // warn: allow but warn
}

// Validate a relation triple
function checkOntologyTriple(srcLabels, relType, tgtLabels) {
  if (!ontology.relations.length) return true;
  const ok = ontology.relations.some(r => {
    const srcOk = r.source_label === '*' || srcLabels.some(l => l === r.source_label);
    const tgtOk = r.target_label === '*' || tgtLabels.some(l => l === r.target_label);
    return srcOk && tgtOk && r.rel_type === relType;
  });
  if (ok) return true;
  const msg = `关系 [${relType}] 不在本体定义的合法三元组中`;
  if (ontology.validation_mode === 'strict') { toast('❌ ' + msg, 'err'); return false; }
  toast('⚠️ ' + msg, 'err');
  return true;
}

// ── Schema cache ──────────────────────────────────────────────────────────────
let schemasCache = [];   // full list, refreshed on open

// ── Auth state ────────────────────────────────────────────────────────────────
let authToken   = localStorage.getItem('auth_token');
let currentUser = null;  // { sub, username, role }

// ── WebSocket state ───────────────────────────────────────────────────────────
let ws              = null;
let wsReconnectTimer = null;
let wsEverConnected  = false;
const onlineUsers   = new Map();   // user_id -> { username, color }
const lockedEntities = new Map();  // entity_id -> { user_id, username, color }
const lockCallbacks  = new Map();  // entity_id -> resolve fn (Promise)
let currentEditingNodeId = null;
let currentEditingEdgeId = null;

// ── Color palette ─────────────────────────────────────────────────────────────
const PALETTE = [
  '#4C8EDA','#DA4C4C','#4CDA7A','#DAB44C',
  '#9B4CDA','#4CDADA','#DA4C9B','#DA8E4C',
  '#6EDAA0','#A04CDA','#4CA8DA','#DA6E4C',
];
const labelColorMap = {};
let colorIdx = 0;
function getLabelColor(label) {
  // Prefer ontology-defined color
  const cls = ontology.classes && ontology.classes.find(c => c.label_name === label);
  if (cls && cls.color) return cls.color;
  // Fall back to stable palette assignment
  if (!labelColorMap[label]) {
    labelColorMap[label] = PALETTE[colorIdx++ % PALETTE.length];
  }
  return labelColorMap[label];
}

// ── Workspace state ───────────────────────────────────────────────────────────
let currentWorkspace  = null;   // { id, name } | null = global mode
let workspaceNodeIds  = new Set();  // element IDs whitelisted in current workspace
let _workspaces       = [];     // cached list from server
let _inspectorNodeId  = null;   // node currently shown in inspector

// ── Graph state ───────────────────────────────────────────────────────────────
let network = null;
let visNodes = new vis.DataSet();
let visEdges = new vis.DataSet();
let selectedNodeIds = [];
let selectedEdgeIds = [];
let pendingEdgeCallback = null;
let pendingNodeCallback = null;

// ── 3D state ─────────────────────────────────────────────────────────────────
let is3DMode = false;
let graph3d = null;
let _3dSelected = new Set();
let _3dClickTimer = null;
let _3dClickNodeId = null;
let _3dLinkClickTimer = null;
let _3dClickLinkId = null;
