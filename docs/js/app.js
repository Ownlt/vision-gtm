const EMPTY_DATA = {
  meta: { containerName: '', publicId: '', counts: { tags: 0, triggers: 0, variables: 0, builtins: 0, folders: 0, pausedTags: 0 } },
  folders: {}, tags: {}, triggers: {}, variables: {}, builtins: {},
};
let DATA = window.GTM_DATA || EMPTY_DATA;
const KIND_COLOR = { tag: 'var(--series-tag)', trigger: 'var(--series-trigger)', variable: 'var(--series-var)', builtin: 'var(--series-builtin)' };
const KIND_COLOR_HEX = {}; // resolved after paint

function resolveColor(varName) {
  const el = document.querySelector('.viz-root');
  return getComputedStyle(el).getPropertyValue(varName).trim();
}

// =====================================================================
// GTM container-export → VisionGTM data model
// (JS port of the Python preprocessing used to build the initial dataset,
// so a freshly-imported export.json gets the same tags/triggers/variables
// summaries, human-readable conditions, and cross-reference graph.)
// =====================================================================
const OP_LABEL = {
  MATCH_REGEX: 'matches regex', CONTAINS: 'contains', EQUALS: 'equals',
  STARTS_WITH: 'starts with', ENDS_WITH: 'ends with', CSS_SELECTOR: 'matches CSS selector',
  GREATER: '>', LESS: '<', GREATER_OR_EQUALS: '>=', LESS_OR_EQUALS: '<=',
};
const TRIGGER_TYPE_LABEL = {
  CUSTOM_EVENT: 'Custom Event', CLICK: 'Click - All Elements', LINK_CLICK: 'Click - Just Links',
  WINDOW_LOADED: 'Window Loaded', DOM_READY: 'DOM Ready', HISTORY_CHANGE: 'History Change',
  TIMER: 'Timer', YOU_TUBE_VIDEO: 'YouTube Video', PAGEVIEW: 'Page View',
  FORM_SUBMISSION: 'Form Submission', SCROLL_DEPTH: 'Scroll Depth', ELEMENT_VISIBILITY: 'Element Visibility',
};
const TAG_TYPE_LABEL = {
  gaawe: 'GA4 Event', html: 'Custom HTML', googtag: 'Google Tag (gtag.js) Config',
  flc: 'Floodlight Counter', gclidw: 'Conversion Linker', pntr: 'Pinterest Tag',
  awct: 'Google Ads Conversion Tracking', sp: 'Google Ads Remarketing', ua: 'Universal Analytics',
};
const VAR_TYPE_LABEL = {
  v: 'Data Layer Variable', jsm: 'Custom JavaScript', u: 'URL', smm: 'Lookup Table',
  c: 'Constant', gas: 'Google Analytics Settings', d: 'DOM Element', gtes: 'Google Tag: Event Settings',
  j: 'JavaScript Variable', k: '1st Party Cookie', f: 'HTTP Referrer', vis: 'Element Visibility',
};
const SYSTEM_TRIGGERS = {
  '2147479553': 'All Pages',
  '2147479572': 'Consent Initialization - All Pages',
  '2147479573': 'Initialization - All Pages',
};
const VAR_REF_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function findVarRefs(obj, found) {
  if (typeof obj === 'string') {
    let m;
    VAR_REF_RE.lastIndex = 0;
    while ((m = VAR_REF_RE.exec(obj))) found.add(m[1].trim());
  } else if (Array.isArray(obj)) {
    obj.forEach(v => findVarRefs(v, found));
  } else if (obj && typeof obj === 'object') {
    Object.values(obj).forEach(v => findVarRefs(v, found));
  }
}

function paramsToDict(plist) {
  const out = {};
  if (!plist) return out;
  plist.forEach(p => {
    const key = p.key;
    if (key == null) return;
    if (p.type === 'LIST') {
      out[key] = (p.list || []).map(item => item.type === 'MAP' ? paramsToDict(item.map || []) : item.value);
    } else if (p.type === 'MAP') {
      out[key] = paramsToDict(p.map || []);
    } else {
      out[key] = p.value;
    }
  });
  return out;
}

function consentTypesOf(consentSettings) {
  // GTM's "Additional Consent Checks" list — the specific consent signals (ad_storage,
  // analytics_storage, ad_user_data, ...) this tag is gated on, beyond the basic consentStatus.
  const ct = (consentSettings && consentSettings.consentType) || {};
  const out = [];
  if (ct.type === 'LIST') {
    (ct.list || []).forEach(item => {
      if (item.type === 'MAP') {
        const d = paramsToDict(item.map || []);
        const v = d.consentType || d.value;
        if (v) out.push(v);
      } else if (item.value) {
        out.push(item.value);
      }
    });
  }
  return out;
}

function filterToText(f) {
  const p = paramsToDict(f.parameter || []);
  const arg0 = p.arg0 == null ? '?' : p.arg0;
  const arg1 = p.arg1 == null ? '' : p.arg1;
  const negate = String(p.negate || '').toLowerCase() === 'true';
  const op = OP_LABEL[f.type] || (f.type || '').toLowerCase();
  let txt = arg1 !== '' ? `${arg0} ${op} “${arg1}”` : `${arg0} ${op}`;
  if (negate) txt = 'NOT (' + txt + ')';
  return txt;
}
function filtersToLines(flist) { return (flist || []).map(filterToText); }

function triggerSummary(t) {
  const lines = [];
  const p = paramsToDict(t.parameter || []);
  const ttype = t.type;
  if (ttype === 'CUSTOM_EVENT') {
    (t.customEventFilter || []).forEach(cef => lines.push(filterToText(cef)));
  }
  if (ttype === 'TIMER' && p.interval) {
    lines.push(`Every ${p.interval}ms` + (p.limit ? `, limit ${p.limit}` : ''));
  }
  if (ttype === 'YOU_TUBE_VIDEO') {
    const caps = Object.keys(p).filter(k => k.startsWith('capture') && String(p[k]).toLowerCase() === 'true')
      .map(k => k.replace('capture', ''));
    if (caps.length) lines.push('Captures: ' + caps.join(', '));
  }
  if (t.autoEventFilter) lines.push(...filtersToLines(t.autoEventFilter));
  if (t.filter) lines.push(...filtersToLines(t.filter));
  if (!lines.length) lines.push('Fires on ' + (TRIGGER_TYPE_LABEL[ttype] || ttype) + ' (no extra conditions)');
  return lines;
}

function firstCodeComment(code) {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') && line.length > 2) return line.replace(/^\/+/, '').trim();
  }
  return null;
}

function tagSummary(tag) {
  const p = paramsToDict(tag.parameter || []);
  const ttype = tag.type;
  const lines = [];
  let code = null;
  if (ttype === 'gaawe') {
    lines.push(`event: ${p.eventName || '?'}`);
    if (p.measurementIdOverride) lines.push(`measurement ID: ${p.measurementIdOverride}`);
    if (String(p.sendEcommerceData || '').toLowerCase() === 'true') lines.push('sends ecommerce data');
    if (p.eventSettingsVariable) lines.push(`event settings: ${p.eventSettingsVariable}`);
    ['eventSettingsTable', 'eventParameters'].forEach(tableKey => {
      const rows = p[tableKey] || [];
      if (rows.length) {
        const params = rows.filter(r => r && typeof r === 'object')
          .map(r => `${r.parameter != null ? r.parameter : r.name}=${r.parameterValue != null ? r.parameterValue : r.value}`)
          .join(', ');
        lines.push(`${rows.length} event parameter(s): ${params}`);
      }
    });
    (p.userProperties || []).forEach(r => { if (r && typeof r === 'object') lines.push(`user property: ${r.name || '?'} = ${r.value || '?'}`); });
  } else if (ttype === 'googtag') {
    lines.push(`tag ID: ${p.tagId || '?'}`);
    (p.configSettingsTable || []).forEach(row => { if (row && typeof row === 'object') lines.push(`${row.parameter} = ${row.parameterValue}`); });
  } else if (ttype === 'flc') {
    lines.push(`advertiser: ${p.advertiserId || '?'} / group: ${p.groupTag || '?'} / activity: ${p.activityTag || '?'}`);
  } else if (ttype === 'gclidw') {
    lines.push('cross-domain linking' + (p.linkerDomains ? ': ' + String(p.linkerDomains).slice(0, 120) + '...' : ''));
  } else if (ttype === 'pntr') {
    lines.push(`pixel ID: ${p.tagId || '?'}` + (p.eventName ? `, event: ${p.eventName}` : ''));
  } else if (ttype === 'html') {
    code = p.html || '';
    const comment = firstCodeComment(code);
    const names = new Set();
    const nameRe = /event_name['"]?\s*[:=]\s*['"]([a-zA-Z0-9_\-]+)/g;
    let m;
    while ((m = nameRe.exec(code))) names.add(m[1]);
    if (comment) lines.push(comment);
    if (names.size) lines.push('events: ' + Array.from(names).sort().join(', '));
    if (!lines.length) {
      const firstLine = code.split('\n').map(l => l.trim()).find(l => l && !l.includes('<script')) || '';
      lines.push(firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : (firstLine || 'Custom HTML/JS'));
    }
  }
  if (!lines.length) lines.push(TAG_TYPE_LABEL[ttype] || ttype);
  return [lines, code];
}

function varSummary(v) {
  const p = paramsToDict(v.parameter || []);
  const vtype = v.type;
  const lines = [];
  let code = null;
  if (vtype === 'v') {
    lines.push(`dataLayer.${p.name || '?'}`);
    if (p.defaultValue) lines.push(`default: ${p.defaultValue}`);
  } else if (vtype === 'jsm') {
    code = p.javascript || '';
    const firstLine = code.split('\n').map(l => l.trim()).find(l => l) || '';
    lines.push('Custom JS: ' + firstLine.slice(0, 80));
  } else if (vtype === 'u') {
    const comp = p.component || 'URL';
    lines.push(`URL component: ${comp}` + (comp === 'QUERY' && p.queryKey ? ` (query key: ${p.queryKey})` : ''));
  } else if (vtype === 'smm') {
    const table = p.map || [];
    lines.push(`Maps ${p.input || '?'} → ${table.length} entries`);
  } else if (vtype === 'c') {
    lines.push(`= ${p.value != null ? p.value : ''}`);
  } else if (vtype === 'gas') {
    lines.push(`UA tracking ID: ${p.trackingId || '?'}`);
  } else if (vtype === 'd') {
    lines.push(`${p.selectorType || 'CSS'} selector: ${p.elementSelector || '?'}`);
  } else if (vtype === 'gtes') {
    const ups = p.userProperties || [], eps = p.eventParameters || [];
    if (ups.length) lines.push(`${ups.length} user propert${ups.length === 1 ? 'y' : 'ies'}: ` +
      ups.slice(0, 6).map(row => (row && typeof row === 'object') ? (row.name || '?') : String(row)).join(', '));
    if (eps.length) lines.push(`${eps.length} event parameter(s)`);
  }
  if (!lines.length) lines.push(VAR_TYPE_LABEL[vtype] || vtype);
  return [lines, code];
}

function transformGtmExport(raw) {
  const cv = raw.containerVersion;
  if (!cv) throw new Error('No containerVersion found — is this a GTM container export?');
  const containerName = (cv.container && cv.container.name) || 'GTM container';
  const publicId = (cv.container && cv.container.publicId) || '';

  const folders = {};
  (cv.folder || []).forEach(f => { folders[f.folderId] = f.name; });

  const varByName = {};
  const variables = {};
  (cv.variable || []).forEach(v => {
    const vid = 'var:' + v.variableId;
    varByName[v.name] = vid;
    const [summary, code] = varSummary(v);
    variables[vid] = {
      id: vid, kind: 'variable', gtmId: v.variableId, name: v.name, type: v.type,
      typeLabel: VAR_TYPE_LABEL[v.type] || v.type, folder: folders[v.parentFolderId] || null,
      summary, code, _raw: v, usedBy: [], refsTo: [],
    };
  });

  const builtinByName = {};
  const builtins = {};
  (cv.builtInVariable || []).forEach(b => {
    const bid = 'builtin:' + b.type;
    builtinByName[b.name] = bid;
    builtins[bid] = {
      id: bid, kind: 'builtin', gtmId: b.type, name: b.name, type: b.type,
      typeLabel: 'Built-in Variable', folder: null, summary: ['Built-in: ' + b.name],
      code: null, usedBy: [], refsTo: [],
    };
  });

  const nameToId = Object.assign({}, varByName, builtinByName);

  Object.values(variables).forEach(v => {
    const refs = new Set();
    findVarRefs(v._raw.parameter || [], refs);
    refs.forEach(r => { const target = nameToId[r]; if (target && target !== v.id) v.refsTo.push(target); });
    delete v._raw;
  });

  const triggers = {};
  (cv.trigger || []).forEach(t => {
    const tid = 'trigger:' + t.triggerId;
    const refs = new Set();
    findVarRefs(t, refs);
    const refIds = Array.from(new Set(Array.from(refs).map(r => nameToId[r]).filter(Boolean))).sort();
    triggers[tid] = {
      id: tid, kind: 'trigger', gtmId: t.triggerId, name: t.name, type: t.type,
      typeLabel: TRIGGER_TYPE_LABEL[t.type] || t.type, folder: folders[t.parentFolderId] || null,
      summary: triggerSummary(t), refsTo: refIds, usedByTags: [],
    };
    refIds.forEach(rid => { if (variables[rid]) variables[rid].usedBy.push(tid); else if (builtins[rid]) builtins[rid].usedBy.push(tid); });
  });

  Object.entries(SYSTEM_TRIGGERS).forEach(([tidRaw, tname]) => {
    const tid = 'trigger:' + tidRaw;
    if (!triggers[tid]) {
      triggers[tid] = {
        id: tid, kind: 'trigger', gtmId: tidRaw, name: tname, type: 'SYSTEM',
        typeLabel: 'Built-in System Trigger', folder: null,
        summary: ['GTM built-in trigger (fires on ' + tname.split(' - ')[0].toLowerCase() + ')'],
        refsTo: [], usedByTags: [],
      };
    }
  });

  const tags = {};
  (cv.tag || []).forEach(tag => {
    const gid = 'tag:' + tag.tagId;
    const refs = new Set();
    findVarRefs(tag.parameter || [], refs);
    const refIds = Array.from(new Set(Array.from(refs).map(r => nameToId[r]).filter(Boolean))).sort();
    const firing = (tag.firingTriggerId || []).map(x => 'trigger:' + x);
    const [summary, code] = tagSummary(tag);
    const consentSettings = tag.consentSettings || {};
    tags[gid] = {
      id: gid, kind: 'tag', gtmId: tag.tagId, name: tag.name, type: tag.type,
      typeLabel: TAG_TYPE_LABEL[tag.type] || tag.type, folder: folders[tag.parentFolderId] || null,
      paused: !!tag.paused, firingOption: tag.tagFiringOption,
      consentStatus: consentSettings.consentStatus || null,
      consentTypes: consentTypesOf(consentSettings),
      summary, code, firingTriggers: firing, refsTo: refIds,
    };
    refIds.forEach(rid => { if (variables[rid]) variables[rid].usedBy.push(gid); else if (builtins[rid]) builtins[rid].usedBy.push(gid); });
    firing.forEach(trg => { if (triggers[trg]) triggers[trg].usedByTags.push(gid); });
  });

  return {
    meta: {
      containerName, publicId,
      counts: {
        tags: Object.keys(tags).length,
        triggers: Object.keys(triggers).length,
        variables: Object.keys(variables).length,
        builtins: Object.keys(builtins).length,
        folders: Object.keys(folders).length,
        pausedTags: Object.values(tags).filter(t => t.paused).length,
      },
    },
    folders, tags, triggers, variables, builtins,
  };
}

// ---------------- state ----------------
let allNodes = [];
let allLinks = [];
let nodeById = new Map();
const activeKinds = new Set(['tag','trigger','variable','builtin']);
let activeFolder = '';
let pauseFilter = 'all'; // 'all' | 'hide' | 'only'
let orphansOnly = false; // true = show only nodes with zero connections (no dependencies)
let searchTerm = '';
let focusedId = null;

// ---------------- build node/link arrays ----------------
function kindOf(id) {
  if (id.startsWith('tag:')) return 'tag';
  if (id.startsWith('trigger:')) return 'trigger';
  if (id.startsWith('var:')) return 'variable';
  if (id.startsWith('builtin:')) return 'builtin';
  return 'unknown';
}

function buildGraph() {
  allNodes = [];
  allLinks = [];
  nodeById = new Map();

  function pushNode(rec, kind) {
    const n = { id: rec.id, kind, name: rec.name, folder: rec.folder || null, typeLabel: rec.typeLabel, paused: !!rec.paused, degree: 0 };
    allNodes.push(n);
    nodeById.set(n.id, n);
  }
  Object.values(DATA.tags).forEach(t => pushNode(t, 'tag'));
  Object.values(DATA.triggers).forEach(t => pushNode(t, 'trigger'));
  Object.values(DATA.variables).forEach(v => pushNode(v, 'variable'));
  Object.values(DATA.builtins).forEach(v => pushNode(v, 'builtin'));

  function addLink(source, target, type) {
    if (!nodeById.has(source) || !nodeById.has(target)) return;
    allLinks.push({ source, target, type });
    nodeById.get(source).degree++;
    nodeById.get(target).degree++;
  }
  Object.values(DATA.tags).forEach(t => {
    (t.firingTriggers || []).forEach(trg => addLink(t.id, trg, 'fires'));
    (t.refsTo || []).forEach(v => addLink(t.id, v, 'refs'));
  });
  Object.values(DATA.triggers).forEach(t => {
    (t.refsTo || []).forEach(v => addLink(t.id, v, 'refs'));
  });
  Object.values(DATA.variables).forEach(v => {
    (v.refsTo || []).forEach(v2 => addLink(v.id, v2, 'refs'));
  });
}
buildGraph();

// ---------------- folder options ----------------
const folderSelect = document.getElementById('folder-select');
function populateFolderOptions() {
  folderSelect.innerHTML = '<option value="">All folders</option>';
  const folderNames = Array.from(new Set(allNodes.map(n => n.folder).filter(Boolean))).sort();
  folderNames.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f;
    folderSelect.appendChild(opt);
  });
  const noFolderOpt = document.createElement('option');
  noFolderOpt.value = '__none__'; noFolderOpt.textContent = '(no folder)';
  folderSelect.appendChild(noFolderOpt);
}
populateFolderOptions();

// ---------------- stat tiles ----------------
const statsEl = document.getElementById('stats');
function renderStats() {
  const c = DATA.meta.counts;
  const statDefs = [
    ['tag', c.tags, 'Tags'],
    ['trigger', c.triggers, 'Triggers'],
    ['var', c.variables, 'Variables'],
    ['', c.builtins, 'Built-ins'],
    ['', c.folders, 'Folders'],
    ['', c.pausedTags, 'Paused tags'],
  ];
  statsEl.innerHTML = statDefs.map(([cls, n, l]) => `<div class="stat-tile ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}
renderStats();
updateHeaderSub();

function updateHeaderSub() {
  document.getElementById('header-sub').textContent = DATA.meta.containerName
    ? `${DATA.meta.containerName} · ${DATA.meta.publicId} · generated from container export`
    : 'No container loaded · import a GTM export JSON';
  document.title = DATA.meta.containerName ? `VisionGTM — ${DATA.meta.containerName}` : 'VisionGTM';
  document.getElementById('clear-btn').style.display = DATA.meta.containerName ? '' : 'none';
}

// ---------------- filter predicate ----------------
function nodeVisible(n) {
  if (!activeKinds.has(n.kind)) return false;
  if (activeFolder === '__none__' && n.folder) return false;
  if (activeFolder && activeFolder !== '__none__' && n.folder !== activeFolder) return false;
  if (n.kind === 'tag') {
    if (pauseFilter === 'only' && !n.paused) return false;
    if (pauseFilter === 'hide' && n.paused) return false;
  }
  if (orphansOnly && n.degree !== 0) return false;
  return true;
}

function isOrphanRecord(kind, r) {
  if (kind === 'tag') return (r.firingTriggers || []).length === 0 && (r.refsTo || []).length === 0;
  if (kind === 'trigger') return (r.usedByTags || []).length === 0 && (r.refsTo || []).length === 0;
  return (r.usedBy || []).length === 0 && (r.refsTo || []).length === 0; // variable / builtin
}
function matchesSearch(n) {
  if (!searchTerm) return false;
  return n.name.toLowerCase().includes(searchTerm);
}

// ================== MAP VIEW (D3 force graph) ==================
const svg = d3.select('#graph-svg');
const gRoot = svg.append('g');
const linkLayer = gRoot.append('g').attr('class', 'links');
const nodeLayer = gRoot.append('g').attr('class', 'nodes');
const tooltip = document.getElementById('graph-tooltip');
let simulation = null;

function currentSize() {
  // .graph-pane (not #map-view) is the element the svg actually fills — #map-view still
  // spans the full width even when the detail panel is open as its flex sibling.
  const el = document.getElementById('graph-pane');
  return { w: el.clientWidth || 800, h: el.clientHeight || 600 };
}

const zoomBehavior = d3.zoom().scaleExtent([0.15, 4]).on('zoom', (ev) => {
  gRoot.attr('transform', ev.transform);
});
svg.call(zoomBehavior);
document.getElementById('zoom-in').onclick = () => svg.transition().call(zoomBehavior.scaleBy, 1.4);
document.getElementById('zoom-out').onclick = () => svg.transition().call(zoomBehavior.scaleBy, 1/1.4);

// Dragging nodes pins them (fx/fy) and, since the simulation has already cooled down,
// they just stay wherever they were dropped — this restores the original force layout,
// clears any focus/dim state, and recenters the zoom/pan.
function resetView() {
  // d3-force only re-runs its spiral initial-placement for a node when x/y is NaN —
  // `null` coerces to 0 and is treated as a real (collapsed-at-origin) coordinate,
  // which was quietly producing a different, worse equilibrium. Use undefined instead.
  allNodes.forEach(n => { n.x = undefined; n.y = undefined; n.vx = undefined; n.vy = undefined; n.fx = null; n.fy = null; });
  focusedId = null;
  closeDetail();
  renderGraph({ instant: true });
  svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);
}
document.getElementById('zoom-reset').onclick = resetView;
document.getElementById('reset-view-btn').onclick = resetView;
document.getElementById('hint-close').onclick = () => { document.getElementById('hint-box').style.display = 'none'; };

function radiusFor(n) {
  const base = n.kind === 'tag' ? 6 : n.kind === 'trigger' ? 5.5 : 4;
  return Math.min(base + Math.sqrt(n.degree || 0) * 1.1, 16);
}
function colorFor(kind) {
  return { tag: 'var(--series-tag)', trigger: 'var(--series-trigger)', variable: 'var(--series-var)', builtin: 'var(--series-builtin)' }[kind];
}

let nodeSel, linkSel, labelSel;

function computeVisibleIds() {
  const base = allNodes.filter(nodeVisible);
  if (pauseFilter !== 'only') return new Set(base.map(n => n.id));
  // Paused-tags-only: keep paused tags, plus only the triggers/variables directly
  // connected to one of them (otherwise unrelated nodes float with no context).
  const baseIds = new Set(base.map(n => n.id));
  const pausedTagIds = new Set(base.filter(n => n.kind === 'tag' && n.paused).map(n => n.id));
  const keep = new Set(pausedTagIds);
  allLinks.forEach(l => {
    const sid = l.source.id || l.source, tid = l.target.id || l.target;
    if (pausedTagIds.has(sid) && baseIds.has(tid)) keep.add(tid);
    if (pausedTagIds.has(tid) && baseIds.has(sid)) keep.add(sid);
  });
  return keep;
}

function renderGraph(opts) {
  document.getElementById('graph-empty').classList.toggle('active', allNodes.length === 0);
  if (allNodes.length === 0) {
    if (simulation) { simulation.stop(); simulation = null; }
    linkLayer.selectAll('line').remove();
    nodeLayer.selectAll('circle').remove();
    nodeLayer.selectAll('text.node-label').remove();
    return;
  }

  const instant = !!(opts && opts.instant);
  const { w, h } = currentSize();
  svg.attr('viewBox', [0, 0, w, h]);

  const visibleIds0 = computeVisibleIds();
  const visibleNodes = allNodes.filter(n => visibleIds0.has(n.id));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleLinks = allLinks.filter(l => visibleIds.has(typeof l.source === 'object' ? l.source.id : l.source) && visibleIds.has(typeof l.target === 'object' ? l.target.id : l.target));

  // reset positions lightly retained via id map
  const prevPos = new Map((simulation ? simulation.nodes() : []).map(n => [n.id, n]));
  visibleNodes.forEach(n => {
    const prev = prevPos.get(n.id);
    if (prev) { n.x = prev.x; n.y = prev.y; n.vx = prev.vx; n.vy = prev.vy; }
  });

  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(visibleNodes)
    .force('link', d3.forceLink(visibleLinks).id(d => d.id).distance(l => l.type === 'fires' ? 55 : 34).strength(0.35))
    .force('charge', d3.forceManyBody().strength(-70).distanceMax(340))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide().radius(d => radiusFor(d) + 3))
    .alpha(1).alphaDecay(0.045);

  linkSel = linkLayer.selectAll('line').data(visibleLinks, d => (d.source.id || d.source) + '>' + (d.target.id || d.target));
  linkSel.exit().remove();
  const linkEnter = linkSel.enter().append('line')
    .attr('stroke-width', d => d.type === 'fires' ? 1.3 : 0.8)
    .attr('stroke', d => d.type === 'fires' ? 'var(--series-trigger)' : 'var(--baseline)')
    .attr('stroke-opacity', d => d.type === 'fires' ? 0.55 : 0.35);
  linkSel = linkEnter.merge(linkSel);

  nodeSel = nodeLayer.selectAll('circle').data(visibleNodes, d => d.id);
  nodeSel.exit().remove();
  const nodeEnter = nodeSel.enter().append('circle')
    .attr('r', radiusFor)
    .attr('fill', d => colorFor(d.kind))
    .attr('stroke', 'var(--surface-1)')
    .attr('stroke-width', 1.2)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('mouseenter', (ev, d) => showTooltip(ev, d))
    .on('mousemove', (ev) => moveTooltip(ev))
    .on('mouseleave', hideTooltip)
    .on('click', (ev, d) => { ev.stopPropagation(); selectNode(d.id); });
  nodeSel = nodeEnter.merge(nodeSel).attr('r', radiusFor).attr('fill', d => colorFor(d.kind));

  labelSel = nodeLayer.selectAll('text.node-label').data(visibleNodes.filter(d => d.degree >= 6 || d.kind === 'tag'), d => d.id);
  labelSel.exit().remove();
  const labelEnter = labelSel.enter().append('text').attr('class', 'node-label').attr('dy', 3);
  labelSel = labelEnter.merge(labelSel).text(d => d.name.length > 24 ? d.name.slice(0, 22) + '…' : d.name);

  applyFocusStyles();

  function ticked() {
    linkSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);
    labelSel.attr('x', d => d.x + radiusFor(d) + 3).attr('y', d => d.y);
  }
  simulation.on('tick', ticked);

  if (instant) {
    // "Reset view": fast-forward the physics synchronously instead of animating the
    // settle — the layout is deterministic (no RNG in d3-force's init or forces), so
    // this reliably snaps back to the same arrangement rather than replaying an explosion.
    simulation.stop();
    for (let i = 0; i < 300; i++) simulation.tick();
    ticked();
  }
}

function neighborsOf(id) {
  const s = new Set([id]);
  allLinks.forEach(l => {
    const sid = l.source.id || l.source, tid = l.target.id || l.target;
    if (sid === id) s.add(tid);
    if (tid === id) s.add(sid);
  });
  return s;
}

function applyFocusStyles() {
  if (!nodeSel) return;
  const hasSearch = !!searchTerm;
  let focusSet = null;
  if (focusedId) focusSet = neighborsOf(focusedId);

  nodeSel.attr('opacity', d => {
    if (focusSet) return focusSet.has(d.id) ? 1 : 0.12;
    if (hasSearch) return matchesSearch(d) ? 1 : 0.15;
    return 1;
  }).attr('stroke', d => (focusedId === d.id) ? 'var(--text-primary)' : (hasSearch && matchesSearch(d) ? 'var(--text-primary)' : 'var(--surface-1)'))
    .attr('stroke-width', d => (focusedId === d.id || (hasSearch && matchesSearch(d))) ? 2.5 : 1.2);

  if (labelSel) {
    labelSel.attr('opacity', d => {
      if (focusSet) return focusSet.has(d.id) ? 1 : 0;
      if (hasSearch) return matchesSearch(d) ? 1 : 0;
      return d.kind === 'tag' ? 0.85 : 0.55;
    });
  }
  if (linkSel) {
    linkSel.attr('opacity', d => {
      if (!focusSet) return 1;
      const sid = d.source.id || d.source, tid = d.target.id || d.target;
      return (focusSet.has(sid) && focusSet.has(tid)) ? 1 : 0.05;
    });
  }
}

function showTooltip(ev, d) {
  tooltip.style.display = 'block';
  tooltip.innerHTML = `<div class="tt-type">${d.kind === 'variable' ? 'Variable' : d.kind === 'builtin' ? 'Built-in Variable' : d.kind.charAt(0).toUpperCase()+d.kind.slice(1)} · ${d.typeLabel || ''}</div><div>${escapeHtml(d.name)}</div>`;
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const rect = document.getElementById('map-view').getBoundingClientRect();
  tooltip.style.left = (ev.clientX - rect.left + 14) + 'px';
  tooltip.style.top = (ev.clientY - rect.top + 10) + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }

svg.on('click', () => { focusedId = null; closeDetail(); applyFocusStyles(); });

window.addEventListener('resize', () => { if (document.getElementById('map-view').classList.contains('active') || document.getElementById('map-view').offsetParent) renderGraph(); });

// ================== detail panel ==================
const detailPanel = document.getElementById('detail-panel');
function recordFor(id) {
  const kind = kindOf(id);
  const table = kind === 'tag' ? DATA.tags : kind === 'trigger' ? DATA.triggers : kind === 'variable' ? DATA.variables : DATA.builtins;
  return table[id];
}
function chip(id) {
  const rec = recordFor(id);
  if (!rec) return '';
  const kind = kindOf(id);
  return `<span class="link-chip ${kind}" data-goto="${id}">${escapeHtml(rec.name)}</span>`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ---- lightweight JS/HTML syntax highlighting for tag & variable code (no external libs) ----
const JS_KEYWORDS = new Set(['var','let','const','function','return','if','else','for','while','do','new',
  'typeof','instanceof','in','of','try','catch','finally','throw','switch','case','default','break','continue',
  'null','undefined','true','false','this','void','delete','class','extends','super','yield','async','await',
  'import','export','from','static']);

function highlightTag(tagText) {
  return tagText.replace(/^(<\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?>)$/, (m, open, name, attrs, close) => {
    const attrsHl = attrs.replace(/([\w:-]+)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
      (am, aname, eq, aval) => `<span class="tok-attr">${escapeHtml(aname)}</span>${escapeHtml(eq)}<span class="tok-string">${escapeHtml(aval)}</span>`);
    return `<span class="tok-tag">${escapeHtml(open + name)}</span>${attrsHl}<span class="tok-tag">${escapeHtml(close)}</span>`;
  });
}

function highlightCode(raw) {
  const tokenRe = /(<!--[\s\S]*?-->)|(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|(<\/?[a-zA-Z][\w:-]*(?:\s+(?:[^<>"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?)?\/?>)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/g;
  let out = '', last = 0, m;
  while ((m = tokenRe.exec(raw))) {
    out += escapeHtml(raw.slice(last, m.index));
    const full = m[0];
    if (m[1] || m[2] || m[3]) out += `<span class="tok-comment">${escapeHtml(full)}</span>`;
    else if (m[4] || m[5] || m[6]) out += `<span class="tok-string">${escapeHtml(full)}</span>`;
    else if (m[7]) out += highlightTag(full);
    else if (m[8]) out += `<span class="tok-number">${escapeHtml(full)}</span>`;
    else if (m[9]) out += JS_KEYWORDS.has(m[9]) ? `<span class="tok-keyword">${escapeHtml(full)}</span>` : escapeHtml(full);
    last = tokenRe.lastIndex;
  }
  out += escapeHtml(raw.slice(last));
  return out;
}

function codeBlockHtml(rec) {
  if (!rec.code) return '';
  const lang = rec.kind === 'variable' ? 'JavaScript' : 'HTML';
  return `<div class="section-title">Code</div>
    <div class="code-block">
      <div class="code-head"><span>${lang}</span><button class="code-copy" type="button">Copy</button></div>
      <pre><code>${highlightCode(rec.code)}</code></pre>
    </div>`;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
  } else {
    fallbackCopyText(text);
  }
}
function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* clipboard unavailable — nothing more we can do */ }
  document.body.removeChild(ta);
}
function wireCopyButtons(root) {
  root.querySelectorAll('.code-copy').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const codeEl = btn.closest('.code-block').querySelector('code');
      copyText(codeEl.textContent);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1200);
    };
  });
}

function selectNode(id) {
  focusedId = id;
  applyFocusStyles();
  openDetail(id);
  // gently re-center on node if it has coordinates
  const n = nodeById.get(id);
  if (n && n.x != null) {
    const { w, h } = currentSize();
    const t = d3.zoomIdentity.translate(w/2 - n.x, h/2 - n.y);
    // don't force zoom scale changes, just keep current scale by reading current transform
  }
}

function openDetail(id) {
  const rec = recordFor(id);
  if (!rec) return;
  const kind = kindOf(id);
  const kindLabel = kind === 'variable' ? 'Variable' : kind === 'builtin' ? 'Built-in Variable' : kind.charAt(0).toUpperCase() + kind.slice(1);
  let html = `<button class="close-btn" id="detail-close">✕</button>`;
  html += `<span class="kind-badge" style="background:${colorFor(kind)}">${kindLabel}</span>`;
  html += `<h2>${escapeHtml(rec.name)}</h2>`;
  html += `<div class="meta-line">${escapeHtml(rec.typeLabel || '')}${rec.folder ? ' · ' + escapeHtml(rec.folder) : ''}</div>`;

  if (kind === 'tag') {
    if (rec.paused) html += `<span class="flag paused">Paused</span>`;
    if (rec.firingOption) html += `<span class="flag">${escapeHtml(rec.firingOption)}</span>`;
    if (rec.consentStatus) {
      const typesTxt = (rec.consentTypes && rec.consentTypes.length) ? ' (' + rec.consentTypes.join(', ') + ')' : '';
      html += `<span class="flag">Consent: ${escapeHtml(rec.consentStatus + typesTxt)}</span>`;
    }
  }

  html += `<div class="section-title">What it does</div><ul class="summary-list">${(rec.summary||[]).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;

  if (kind === 'tag') {
    html += `<div class="section-title">Fires on trigger${(rec.firingTriggers||[]).length===1?'':'s'} (${(rec.firingTriggers||[]).length})</div><div class="chiplist">${(rec.firingTriggers||[]).map(chip).join('') || '<span class="meta-line">none</span>'}</div>`;
    html += `<div class="section-title">Uses variable${(rec.refsTo||[]).length===1?'':'s'} (${(rec.refsTo||[]).length})</div><div class="chiplist">${(rec.refsTo||[]).map(chip).join('') || '<span class="meta-line">none</span>'}</div>`;
  }
  if (kind === 'trigger') {
    html += `<div class="section-title">Fires tag${(rec.usedByTags||[]).length===1?'':'s'} (${(rec.usedByTags||[]).length})</div><div class="chiplist">${(rec.usedByTags||[]).map(chip).join('') || '<span class="meta-line">none</span>'}</div>`;
    html += `<div class="section-title">Uses variable${(rec.refsTo||[]).length===1?'':'s'} (${(rec.refsTo||[]).length})</div><div class="chiplist">${(rec.refsTo||[]).map(chip).join('') || '<span class="meta-line">none</span>'}</div>`;
  }
  if (kind === 'variable' || kind === 'builtin') {
    html += `<div class="section-title">Used by (${(rec.usedBy||[]).length})</div><div class="chiplist">${(rec.usedBy||[]).map(chip).join('') || '<span class="meta-line">nothing currently</span>'}</div>`;
    if (rec.refsTo && rec.refsTo.length) {
      html += `<div class="section-title">References</div><div class="chiplist">${rec.refsTo.map(chip).join('')}</div>`;
    }
  }
  html += codeBlockHtml(rec);

  detailPanel.innerHTML = html;
  detailPanel.classList.add('open');
  detailPanel.querySelector('#detail-close').onclick = () => { focusedId = null; closeDetail(); applyFocusStyles(); };
  detailPanel.querySelectorAll('[data-goto]').forEach(el => {
    el.onclick = () => selectNode(el.getAttribute('data-goto'));
  });
  wireCopyButtons(detailPanel);
}
function closeDetail() { detailPanel.classList.remove('open'); detailPanel.innerHTML = ''; }

// ================== table views ==================
function kindKeyOfTable(view) { return { tags: 'tag', triggers: 'trigger', variables: 'variable', builtins: 'builtin' }[view]; }

function buildTable(view, records, columns) {
  const container = document.getElementById(view + '-table');
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'data';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  let sortKey = null, sortDir = 1; // 1 = ascending, -1 = descending

  function updateSortIndicators() {
    headRow.querySelectorAll('th').forEach(th => {
      const arrowEl = th.querySelector('.sort-arrow');
      if (!arrowEl) return;
      arrowEl.textContent = th.dataset.key === sortKey ? (sortDir === 1 ? '▲' : '▼') : '';
    });
  }

  columns.forEach(col => {
    const th = document.createElement('th');
    th.dataset.key = col.key;
    th.innerHTML = `${escapeHtml(col.label)}<span class="sort-arrow"></span>`;
    th.addEventListener('click', () => {
      if (sortKey === col.key) sortDir = -sortDir;
      else { sortKey = col.key; sortDir = 1; }
      updateSortIndicators();
      paint();
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.innerHTML = '';
  container.appendChild(wrap);

  function paint() {
    const kind = kindKeyOfTable(view);
    const term = searchTerm;
    const rows = records.filter(r => {
      if (activeFolder === '__none__' && r.folder) return false;
      if (activeFolder && activeFolder !== '__none__' && r.folder !== activeFolder) return false;
      if (kind === 'tag') {
        if (pauseFilter === 'only' && !r.paused) return false;
        if (pauseFilter === 'hide' && r.paused) return false;
      }
      if (orphansOnly && !isOrphanRecord(kind, r)) return false;
      if (term && !r.name.toLowerCase().includes(term)) return false;
      return true;
    });
    if (sortKey) {
      const col = columns.find(c => c.key === sortKey);
      if (col && col.sort) {
        rows.sort((a, b) => {
          const av = col.sort(a), bv = col.sort(b);
          if (typeof av === 'string' || typeof bv === 'string') {
            const as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
            return as < bs ? -sortDir : as > bs ? sortDir : 0;
          }
          return (av - bv) * sortDir;
        });
      }
    }
    tbody.innerHTML = '';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.innerHTML = columns.map(col => `<td>${col.render(r)}</td>`).join('');
      const dr = document.createElement('tr');
      dr.className = 'detail-row';
      const dtd = document.createElement('td');
      dtd.colSpan = columns.length;
      dr.appendChild(dtd);
      tr.onclick = () => {
        const wasOpen = dr.classList.contains('open');
        container.querySelectorAll('tr.detail-row.open').forEach(o => o.classList.remove('open'));
        if (!wasOpen) {
          dtd.innerHTML = detailInline(r);
          dtd.querySelectorAll('[data-goto]').forEach(el => {
            el.onclick = (e) => {
              e.stopPropagation();
              switchTab('map-view');
              selectNode(el.getAttribute('data-goto'));
            };
          });
          wireCopyButtons(dtd);
          dr.classList.add('open');
        }
      };
      tbody.appendChild(tr);
      tbody.appendChild(dr);
    });
  }
  paint();
  return paint;
}

function detailInline(rec) {
  const kind = rec.kind;
  let left = `<div class="section-title">What it does</div><ul class="summary-list">${(rec.summary||[]).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
  let right = '';
  if (kind === 'tag') {
    right = `<div class="section-title">Fires on (${(rec.firingTriggers||[]).length})</div><div class="chiplist">${(rec.firingTriggers||[]).map(chip).join('') || '—'}</div>
      <div class="section-title">Uses variables (${(rec.refsTo||[]).length})</div><div class="chiplist">${(rec.refsTo||[]).map(chip).join('') || '—'}</div>`;
  } else if (kind === 'trigger') {
    right = `<div class="section-title">Fires tags (${(rec.usedByTags||[]).length})</div><div class="chiplist">${(rec.usedByTags||[]).map(chip).join('') || '—'}</div>
      <div class="section-title">Uses variables (${(rec.refsTo||[]).length})</div><div class="chiplist">${(rec.refsTo||[]).map(chip).join('') || '—'}</div>`;
  } else if (kind === 'variable' || kind === 'builtin') {
    right = `<div class="section-title">Used by (${(rec.usedBy||[]).length})</div><div class="chiplist">${(rec.usedBy||[]).map(chip).join('') || '—'}</div>`;
  }
  const code = codeBlockHtml(rec);
  return `<div class="detail-grid"><div>${left}${code}</div><div>${right}</div></div>`;
}

let repaintTags, repaintTriggers, repaintVariables, repaintBuiltins;
function initTables() {
  repaintTags = buildTable('tags', Object.values(DATA.tags), [
    { key: 'name', label: 'Name', sort: r => r.name, render: r => `<span class="name-cell"><span class="kind-dot" style="background:var(--series-tag)"></span>${escapeHtml(r.name)}</span>${r.paused ? ' <span class=\"flag paused\">paused</span>' : ''}` },
    { key: 'type', label: 'Type', sort: r => r.typeLabel, render: r => escapeHtml(r.typeLabel) },
    { key: 'folder', label: 'Folder', sort: r => r.folder || '', render: r => `<span class="muted-cell">${escapeHtml(r.folder || '—')}</span>` },
    { key: 'summary', label: 'Summary', sort: r => (r.summary||[]).join(' '), render: r => `<span class="summary-cell">${escapeHtml((r.summary||[]).join(' · '))}</span>` },
    { key: 'triggers', label: 'Triggers', sort: r => (r.firingTriggers||[]).length, render: r => (r.firingTriggers||[]).length },
    { key: 'vars', label: 'Variables', sort: r => (r.refsTo||[]).length, render: r => (r.refsTo||[]).length },
    { key: 'consent', label: 'Consent', sort: r => (r.consentTypes||[]).join(' ') || (r.consentStatus || ''),
      render: r => {
        const types = r.consentTypes || [];
        if (types.length) return `<span class="summary-cell">${escapeHtml((r.consentStatus ? r.consentStatus + ': ' : '') + types.join(', '))}</span>`;
        return `<span class="muted-cell">${escapeHtml(r.consentStatus || '—')}</span>`;
      } },
    { key: 'consentCount', label: 'Consent #', sort: r => (r.consentTypes||[]).length, render: r => (r.consentTypes||[]).length },
  ]);
  repaintTriggers = buildTable('triggers', Object.values(DATA.triggers), [
    { key: 'name', label: 'Name', sort: r => r.name, render: r => `<span class="name-cell"><span class="kind-dot" style="background:var(--series-trigger)"></span>${escapeHtml(r.name)}</span>` },
    { key: 'type', label: 'Type', sort: r => r.typeLabel, render: r => escapeHtml(r.typeLabel) },
    { key: 'folder', label: 'Folder', sort: r => r.folder || '', render: r => `<span class="muted-cell">${escapeHtml(r.folder || '—')}</span>` },
    { key: 'summary', label: 'Condition', sort: r => (r.summary||[]).join(' '), render: r => `<span class="summary-cell">${escapeHtml((r.summary||[]).join(' · '))}</span>` },
    { key: 'tags', label: 'Used by tags', sort: r => (r.usedByTags||[]).length, render: r => (r.usedByTags||[]).length },
  ]);
  repaintVariables = buildTable('variables', Object.values(DATA.variables), [
    { key: 'name', label: 'Name', sort: r => r.name, render: r => `<span class="name-cell"><span class="kind-dot" style="background:var(--series-var)"></span>${escapeHtml(r.name)}</span>` },
    { key: 'type', label: 'Type', sort: r => r.typeLabel, render: r => escapeHtml(r.typeLabel) },
    { key: 'folder', label: 'Folder', sort: r => r.folder || '', render: r => `<span class="muted-cell">${escapeHtml(r.folder || '—')}</span>` },
    { key: 'summary', label: 'Definition', sort: r => (r.summary||[]).join(' '), render: r => `<span class="summary-cell">${escapeHtml((r.summary||[]).join(' · '))}</span>` },
    { key: 'usedBy', label: 'Used by', sort: r => (r.usedBy||[]).length, render: r => (r.usedBy||[]).length },
  ]);
  repaintBuiltins = buildTable('builtins', Object.values(DATA.builtins), [
    { key: 'name', label: 'Name', sort: r => r.name, render: r => `<span class="name-cell"><span class="kind-dot" style="background:var(--series-builtin)"></span>${escapeHtml(r.name)}</span>` },
    { key: 'type', label: 'Type', sort: r => r.typeLabel, render: r => escapeHtml(r.typeLabel) },
    { key: 'folder', label: 'Folder', sort: r => r.folder || '', render: r => `<span class="muted-cell">${escapeHtml(r.folder || '—')}</span>` },
    { key: 'summary', label: 'Definition', sort: r => (r.summary||[]).join(' '), render: r => `<span class="summary-cell">${escapeHtml((r.summary||[]).join(' · '))}</span>` },
    { key: 'usedBy', label: 'Used by', sort: r => (r.usedBy||[]).length, render: r => (r.usedBy||[]).length },
  ]);
}
initTables();

function repaintAll() {
  if (repaintTags) repaintTags();
  if (repaintTriggers) repaintTriggers();
  if (repaintVariables) repaintVariables();
  if (repaintBuiltins) repaintBuiltins();
  renderGraph();
}

// ================== controls wiring ==================
document.getElementById('search').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  focusedId = null;
  closeDetail();
  applyFocusStyles();
  repaintAll();
});
document.getElementById('folder-select').addEventListener('change', (e) => {
  activeFolder = e.target.value;
  repaintAll();
});
document.getElementById('pause-filter').addEventListener('change', (e) => {
  pauseFilter = e.target.value;
  repaintAll();
});
document.getElementById('orphans-only').addEventListener('change', (e) => {
  orphansOnly = e.target.checked;
  repaintAll();
});
document.querySelectorAll('.chip[data-kind]').forEach(chipEl => {
  chipEl.addEventListener('click', () => {
    const k = chipEl.getAttribute('data-kind');
    if (activeKinds.has(k)) { activeKinds.delete(k); chipEl.classList.add('off'); }
    else { activeKinds.add(k); chipEl.classList.remove('off'); }
    repaintAll();
  });
});
function switchTab(view) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-view') === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === view));
  if (view === 'map-view') setTimeout(renderGraph, 0);
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.getAttribute('data-view'))));

// The CSS dark-mode rules key off `:root[data-theme="dark"]` / `:not([data-theme="light"])`
// — "`:root`" in CSS means the <html> element, so the attribute must be set there
// (not on the .viz-root div) for the manual toggle to override the OS preference.
const htmlEl = document.documentElement;
function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
let manualTheme = null; // null = follow OS setting; 'light' | 'dark' = explicit override
function isDarkNow() { return manualTheme ? manualTheme === 'dark' : systemPrefersDark(); }
function updateThemeToggleLabel() {
  document.getElementById('theme-toggle').textContent = isDarkNow() ? 'Light mode' : 'Dark mode';
}
updateThemeToggleLabel();
document.getElementById('theme-toggle').addEventListener('click', () => {
  manualTheme = isDarkNow() ? 'light' : 'dark';
  htmlEl.setAttribute('data-theme', manualTheme);
  updateThemeToggleLabel();
  setTimeout(renderGraph, 0);
});

// ================== import container JSON ==================
const importBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');
const mapLoading = document.getElementById('map-loading');
const mapLoadingMsg = document.getElementById('map-loading-msg');

function showLoading(msg, isError) {
  mapLoadingMsg.textContent = msg;
  mapLoadingMsg.className = isError ? 'err' : 'msg';
  mapLoading.classList.add('active');
}
function hideLoading() { mapLoading.classList.remove('active'); }

importBtn.addEventListener('click', () => { importFile.value = ''; importFile.click(); });
document.getElementById('empty-import-btn').addEventListener('click', () => { importFile.value = ''; importFile.click(); });

importFile.addEventListener('change', async () => {
  const file = importFile.files && importFile.files[0];
  if (!file) return;

  // Switch to the map tab so the loading state (per the request, "in the canvas") is visible,
  // then paint the spinner before the (synchronous) parse/transform work blocks the main thread.
  switchTab('map-view');
  showLoading(`Loading ${file.name}…`);
  await new Promise(r => setTimeout(r, 30));

  let parsed, transformed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    showLoading('Could not read that file — is it valid JSON?', true);
    setTimeout(hideLoading, 2500);
    return;
  }
  try {
    transformed = transformGtmExport(parsed);
  } catch (err) {
    showLoading('That JSON doesn’t look like a GTM container export: ' + err.message, true);
    setTimeout(hideLoading, 3000);
    return;
  }

  loadData(transformed);
  hideLoading();
});

document.getElementById('clear-btn').addEventListener('click', () => {
  loadData(EMPTY_DATA);
});

function loadData(newData) {
  DATA = newData;
  buildGraph();
  populateFolderOptions();
  renderStats();
  updateHeaderSub();

  // reset filters/UI state to a clean view of the newly-loaded container
  activeKinds.clear();
  ['tag', 'trigger', 'variable', 'builtin'].forEach(k => activeKinds.add(k));
  document.querySelectorAll('.chip[data-kind]').forEach(chipEl => chipEl.classList.remove('off'));
  activeFolder = '';
  folderSelect.value = '';
  pauseFilter = 'all';
  document.getElementById('pause-filter').value = 'all';
  orphansOnly = false;
  document.getElementById('orphans-only').checked = false;
  searchTerm = '';
  document.getElementById('search').value = '';
  focusedId = null;
  closeDetail();
  svg.call(zoomBehavior.transform, d3.zoomIdentity);

  initTables();
  renderGraph();
}

renderGraph();
