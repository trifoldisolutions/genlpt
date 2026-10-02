// Cytoscape wrapper: root → 4 branches → words (and child words). Updated incrementally.
import { BRANCHES, COLORS } from './i18n.js';

const LAYOUT = {
  name: 'cose',
  animate: true,
  animationDuration: 500,
  randomize: false,
  nodeDimensionsIncludeLabels: true,
  idealEdgeLength: () => 60,
  nodeRepulsion: () => 8000,
  edgeElasticity: () => 80,
  gravity: 0.6,
  numIter: 1200,
  padding: 30,
};

const FONT = '"SUSE", ui-sans-serif, system-ui, sans-serif';
// Type scale shared with the CSS theme (--type-base / --type-ratio in src/input.css).
const TYPE_BASE = 14;
const TYPE_RATIO = 1.2;
const TEXT_SM = TYPE_BASE / TYPE_RATIO; // ~11.7
const TEXT_XS = TYPE_BASE / TYPE_RATIO ** 2; // ~9.7
const INK = {
  canvas: '#fafafa', // zinc-50
  edge: '#d4d4d8', // zinc-300
  muted: '#a1a1aa', // zinc-400
  label: '#52525b', // zinc-600
  strong: '#3f3f46', // zinc-700
  brand: '#de247d', // cerise-600
  halo: '#fcceea', // cerise-200
};

function style() {
  return [
    {
      selector: 'node',
      style: {
        shape: 'ellipse',
        label: 'data(label)',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'ellipsis',
        'text-max-width': 140,
        'text-outline-color': INK.canvas,
        'text-outline-width': 1.5,
        'font-family': FONT,
        'font-size': TEXT_XS,
        color: INK.label,
        'min-zoomed-font-size': 7,
        'border-width': 0,
        'transition-property': 'opacity, background-color, border-width, border-color',
        'transition-duration': 150,
      },
    },
    {
      selector: 'node[type="root"]',
      style: {
        label: '',
        width: 28,
        height: 28,
        'background-color': INK.brand,
        'border-width': 6,
        'border-color': INK.halo,
        'border-opacity': 0.5,
      },
    },
    {
      selector: 'node[type="branch"]',
      style: {
        width: 18,
        height: 18,
        'background-color': 'data(color)',
        'font-size': TEXT_SM,
        'font-weight': 600,
        color: INK.strong,
      },
    },
    {
      selector: 'node[type="word"]',
      style: {
        width: (e) => 10 + Math.min(e.degree(), 6) * 1.5,
        height: (e) => 10 + Math.min(e.degree(), 6) * 1.5,
        'background-color': 'data(color)',
      },
    },
    {
      selector: 'node[type="word"].off',
      style: {
        'background-color': '#fff',
        'border-width': 1.5,
        'border-color': 'data(color)',
        'border-opacity': 0.5,
        color: INK.muted,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': INK.edge,
        opacity: 0.9,
        'curve-style': 'straight',
        'transition-property': 'opacity, line-color',
        'transition-duration': 150,
      },
    },
    { selector: 'edge.near', style: { 'line-color': 'data(color)', opacity: 1 } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: '.dim', style: { opacity: 0.12 } },
    { selector: 'node.hl, node.active', style: { 'border-width': 2, 'border-color': INK.brand, 'border-opacity': 1, 'z-index': 10 } },
  ];
}

// Resolves once the UI font is usable on canvas, so label widths are measured correctly.
function fontsLoaded() {
  if (!document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`400 ${TEXT_XS}px ${FONT}`),
    document.fonts.load(`600 ${TEXT_SM}px ${FONT}`),
  ]).then(() => document.fonts.ready).catch(() => {});
}

export function createGraph(container, { onWordTap, onWordMenu, onBranchTap, onViewportChange, onBackgroundTap, getVisibleRect }) {
  const cy = window.cytoscape({
    container,
    style: style(),
    wheelSensitivity: 0.3,
    minZoom: 0.2,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: 'single',
    autounselectify: true,
  });

  cy.add({ data: { id: 'root', type: 'root', label: '' }, position: { x: 0, y: 0 } });
  BRANCHES.forEach((b, i) => {
    const angle = (Math.PI / 2) * i - Math.PI / 4;
    cy.add({ data: { id: `b-${b}`, type: 'branch', branch: b, color: COLORS[b], label: b }, position: { x: Math.cos(angle) * 160, y: Math.sin(angle) * 160 } });
    cy.add({ data: { id: `e-b-${b}`, source: 'root', target: `b-${b}`, color: COLORS[b] } });
  });

  // A long-press opens the menu; ignore the tap that may follow it.
  let heldAt = 0;
  cy.on('tap', 'node[type="word"]', (evt) => {
    if (Date.now() - heldAt < 800) return;
    onWordTap?.(evt.target.id());
  });
  cy.on('taphold', 'node[type="word"]', (evt) => {
    heldAt = Date.now();
    onWordMenu?.(evt.target.id());
  });
  cy.on('cxttap', 'node[type="word"]', (evt) => onWordMenu?.(evt.target.id()));
  cy.on('tap cxttap', 'node[type="branch"]', (evt) => onBranchTap?.(evt.target.data('branch')));
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    onViewportChange?.();
    onBackgroundTap?.();
  });
  cy.on('pan zoom', () => onViewportChange?.());
  cy.on('grab', 'node', () => onViewportChange?.());

  // Hover: keep the node's neighborhood, fade the rest.
  cy.on('mouseover', 'node', (evt) => {
    const hood = evt.target.closedNeighborhood();
    cy.batch(() => {
      cy.elements().not(hood).addClass('faded');
      hood.edges().addClass('near');
    });
  });
  cy.on('mouseout', 'node', () => cy.batch(() => cy.elements().removeClass('faded near')));

  // Track whether the user moved the viewport, so automatic refits don't fight them.
  let userMoved = false;
  let autoUntil = 0;
  cy.on('viewport', () => { if (performance.now() > autoUntil) userMoved = true; });

  function visibleRect() {
    const r = getVisibleRect?.();
    if (r && r.w > 40 && r.h > 40) return r;
    return { x: 0, y: 0, w: cy.width(), h: cy.height() };
  }

  // Fit all elements inside the part of the canvas not covered by the panel or sheet.
  function fitToVisible({ animate = true, padding = 40 } = {}) {
    const eles = cy.elements();
    if (eles.empty() || !cy.width() || !cy.height()) return;
    const r = visibleRect();
    const bb = eles.boundingBox();
    const pad = Math.min(padding, r.w / 6, r.h / 6);
    const zoomFit = Math.min((r.w - 2 * pad) / Math.max(bb.w, 1), (r.h - 2 * pad) / Math.max(bb.h, 1));
    const zoom = Math.max(cy.minZoom(), Math.min(1.6, cy.maxZoom(), zoomFit));
    const pan = {
      x: r.x + r.w / 2 - ((bb.x1 + bb.x2) / 2) * zoom,
      y: r.y + r.h / 2 - ((bb.y1 + bb.y2) / 2) * zoom,
    };
    const duration = animate ? 300 : 0;
    autoUntil = performance.now() + duration + 80;
    cy.stop();
    if (animate) cy.animate({ zoom, pan }, { duration });
    else cy.viewport({ zoom, pan });
  }

  let firstLayout = true;
  let layout = null;
  let fontsReady = false;
  let queued = null;

  function runLayout({ fit = false } = {}) {
    if (!fontsReady) { queued = { fit: fit || !!queued?.fit }; return; }
    layout?.stop();
    const doFit = fit || firstLayout || !userMoved;
    if (firstLayout) fitToVisible({ animate: false }); // start centered, not at the canvas origin
    layout = cy.layout({ ...LAYOUT, fit: false });
    if (doFit) layout.one('layoutstop', () => fitToVisible());
    layout.run();
    firstLayout = false;
  }

  fontsLoaded().then(() => {
    fontsReady = true;
    cy.style().update();
    if (queued) { const q = queued; queued = null; runLayout(q); }
  });

  function parentNodeId(w, ids) {
    return w.parentId && ids.has(String(w.parentId)) ? String(w.parentId) : `b-${w.branch}`;
  }

  // words: session.words. Adds/updates/removes elements; re-runs layout when nodes were added.
  function syncWords(words) {
    const ids = new Set(words.map((w) => String(w._id)));
    let added = 0;
    let removed = 0;

    cy.batch(() => {
      cy.nodes('[type="word"]').forEach((n) => {
        if (!ids.has(n.id())) { cy.remove(n); removed++; }
      });

      // Parents before children so new children can be placed near them.
      const pending = [...words];
      const placed = new Set(cy.nodes('[type="word"]').map((n) => n.id()));
      let guard = pending.length + 1;
      while (pending.length && guard-- > 0) {
        for (let i = pending.length - 1; i >= 0; i--) {
          const w = pending[i];
          const id = String(w._id);
          const parent = parentNodeId(w, ids);
          if (parent !== `b-${w.branch}` && !placed.has(parent)) continue;
          pending.splice(i, 1);
          const existing = cy.getElementById(id);
          if (existing.nonempty()) {
            existing.data('label', w.text);
            existing.toggleClass('off', !w.selected);
            const edge = cy.getElementById(`e-${id}`);
            if (edge.nonempty() && edge.data('source') !== parent) {
              cy.remove(edge);
              cy.add({ data: { id: `e-${id}`, source: parent, target: id, color: COLORS[w.branch] } });
            }
          } else {
            const p = cy.getElementById(parent).position();
            cy.add({
              data: { id, type: 'word', branch: w.branch, color: COLORS[w.branch], label: w.text },
              classes: w.selected ? '' : 'off',
              position: { x: p.x + (Math.random() - 0.5) * 80, y: p.y + (Math.random() - 0.5) * 80 },
            });
            cy.add({ data: { id: `e-${id}`, source: parent, target: id, color: COLORS[w.branch] } });
            added++;
          }
          placed.add(id);
        }
      }
    });

    if (added || removed) cy.style().update(); // node size depends on degree
    if (added) runLayout();
    else if (removed && firstLayout) runLayout();
    return { added, removed };
  }

  function setLabels({ root, branches }) {
    cy.getElementById('root').data('label', root);
    BRANCHES.forEach((b) => cy.getElementById(`b-${b}`).data('label', branches[b]));
  }

  function highlight(wordIds) {
    const set = new Set(wordIds.map(String));
    cy.batch(() => {
      cy.elements().addClass('dim');
      cy.getElementById('root').removeClass('dim');
      set.forEach((id) => {
        const n = cy.getElementById(id);
        if (n.empty()) return;
        n.removeClass('dim').addClass('hl');
        n.predecessors().removeClass('dim');
      });
    });
  }

  function clearHighlight() {
    cy.batch(() => cy.elements().removeClass('dim hl'));
  }

  function setActive(id) {
    cy.nodes('.active').removeClass('active');
    if (id) cy.getElementById(id).addClass('active');
  }

  // Viewport (client) coordinates of a node's right edge, for the floating panel.
  function nodeClientRect(id) {
    const n = cy.getElementById(id);
    if (n.empty()) return null;
    const box = n.renderedBoundingBox();
    const rect = container.getBoundingClientRect();
    return { left: rect.left + box.x1, right: rect.left + box.x2, top: rect.top + box.y1, bottom: rect.top + box.y2 };
  }

  return {
    cy,
    syncWords,
    setLabels,
    highlight,
    clearHighlight,
    setActive,
    nodeClientRect,
    fitToVisible,
    fit: () => { userMoved = false; fitToVisible(); },
    zoom: (factor) => {
      userMoved = true;
      const r = visibleRect();
      cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: r.x + r.w / 2, y: r.y + r.h / 2 } });
    },
    relayout: () => { userMoved = false; runLayout({ fit: true }); },
    resize: () => cy.resize(),
    // The visible area changed (panel, sheet, sidebar, viewport): refit unless the user took over.
    visibleChanged: ({ animate = false } = {}) => {
      cy.resize();
      if (!userMoved && !firstLayout) fitToVisible({ animate });
    },
  };
}
