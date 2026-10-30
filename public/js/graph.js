// Cytoscape wrapper: root → 4 branches → words (and child words). Updated incrementally. Two layouts:
// 'network' (force-directed dots, the default) and 'org' (an org chart: the branches in a row under the root, each
// with its words listed below it, in boxes joined by elbow lines).
import { BRANCHES } from './i18n.js';

export const LAYOUTS = ['network', 'org'];

// Network: runs synchronously (animate: false); the motion afterwards is ours, see animateFrom().
const LAYOUT = {
  name: 'cose',
  animate: false,
  randomize: false,
  nodeDimensionsIncludeLabels: true,
  idealEdgeLength: () => 60,
  nodeRepulsion: () => 8000,
  edgeElasticity: () => 80,
  gravity: 0.6,
  numIter: 1200,
  padding: 30,
};

// After a layout, nodes that were already shown glide to their new spots; new ones grow out of their
// parent: the root pops in, then each level follows once its parent has (nearly) arrived.
const MOTION = {
  glide: 450,
  pop: 380,
  grow: 420,
  step: 260, // a child starts this long after its parent
  sibling: 45, // stagger between siblings, swept around their parent from 12 o'clock...
  spread: 220, // ...squeezed to fit this window when there are many
};
const POP_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // slight overshoot
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

const FONT = '"SUSE", ui-sans-serif, system-ui, sans-serif';
// Type scale shared with the CSS theme (--type-base / --type-ratio in src/input.css).
const TYPE_BASE = 14;
const TYPE_RATIO = 1.2;
const TEXT_SM = TYPE_BASE / TYPE_RATIO; // ~11.7
const TEXT_XS = TYPE_BASE / TYPE_RATIO ** 2; // ~9.7
// Per theme (data-theme on <html>): the palette's shades and branch colors from src/input.css, in hex since
// Cytoscape can't read CSS variables, or their oklch and color-mix() values
const SPECTRUM = { who: '#6366f1', what: '#10b981', how: '#f59e0b', why: '#0ea5e9' };
const INKS = {
  light: {
    canvas: '#fafafa', // zinc-50
    surface: '#fff',
    edge: '#d4d4d8', // zinc-300
    muted: '#a1a1aa', // zinc-400
    label: '#52525b', // zinc-600
    strong: '#3f3f46', // zinc-700
    brand: '#de247d', // brand
    halo: '#fcceea', // cerise-200
    branch: SPECTRUM, // --color-who…
  },
  dark: {
    canvas: '#141416',
    surface: '#1c1c1f',
    edge: '#44444b',
    muted: '#6e6e78',
    label: '#b9b9c2',
    strong: '#d1d1d7',
    brand: '#de247d',
    halo: '#802557',
    branch: SPECTRUM,
  },
  gold: {
    canvas: '#070707',
    surface: '#0f0f0f',
    edge: '#383838',
    muted: '#6b6b6b',
    label: '#b8b8b8',
    strong: '#d2d2d2',
    brand: '#d6a53c',
    halo: '#6e5725',
    branch: { who: '#f2f2f2', what: '#ecd08a', how: '#d6a53c', why: '#9f7628' },
  },
};
const inkOf = (theme) => INKS[theme] || INKS.light;
// A node's branch color; an edge's is its child's
const branchColor = (ink) => (ele) => ink.branch[(ele.isEdge() ? ele.target() : ele).data('branch')];

// Org chart spacing; a box is as wide as its label (up to maxLabel, then an ellipsis) plus padX on each side
const ORG = {
  rankGap: 44, // from the root down to the branches
  colGap: 32, // between branch columns
  rowGap: 8, // between a box and the next one in a list
  arm: 16, // from a list's line to its boxes
  padX: 10,
  maxLabel: 160,
  radius: 6, // rounded-md
};
const ORG_FONT = {
  branch: `600 ${TYPE_BASE}px ${FONT}`,
  word: `400 ${TEXT_SM}px ${FONT}`,
};

// Label widths, measured in the font they're drawn in; cleared once the UI font has loaded
const measurer = document.createElement('canvas').getContext('2d');
const labelWidths = new Map();
function labelWidth(text, font) {
  const key = `${font}|${text}`;
  if (!labelWidths.has(key)) {
    measurer.font = font;
    labelWidths.set(key, measurer.measureText(text).width);
  }
  return labelWidths.get(key);
}
const boxWidth = (font) => (n) => Math.min(labelWidth(n.data('label') || '', font), ORG.maxLabel) + 2 * ORG.padX;

const baseStyle = (ink) => [
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
      'text-outline-color': ink.canvas,
      'text-outline-width': 1.5,
      'font-family': FONT,
      'font-size': TEXT_XS,
      color: ink.label,
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
      'background-color': ink.brand,
      'border-width': 6,
      'border-color': ink.halo,
      'border-opacity': 0.5,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1,
      'line-color': ink.edge,
      opacity: 0.9,
      'curve-style': 'straight',
      'transition-property': 'opacity, line-color',
      'transition-duration': 150,
    },
  },
];

const networkStyle = (ink) => [
  {
    selector: 'node[type="branch"]',
    style: {
      width: 18,
      height: 18,
      'background-color': branchColor(ink),
      'font-size': TEXT_SM,
      'font-weight': 600,
      color: ink.strong,
    },
  },
  {
    selector: 'node[type="word"]',
    style: {
      width: (e) => 10 + Math.min(e.degree(), 6) * 1.5,
      height: (e) => 10 + Math.min(e.degree(), 6) * 1.5,
      'background-color': branchColor(ink),
    },
  },
  {
    selector: 'node[type="word"].off',
    style: {
      'background-color': ink.surface,
      'border-width': 1.5,
      'border-color': branchColor(ink),
      'border-opacity': 0.5,
      color: ink.muted,
    },
  },
];

// The root stays the brand dot; the branches are tinted boxes, the words white ones edged in their branch's color
// (dashed and grey when deselected). A list's line drops from the middle of its parent's box: round-taxi edges
// at a 100% turn fall back to an L (down, then across into the box's side).
const orgStyle = (ink) => [
  {
    selector: 'node[type="branch"], node[type="word"]',
    style: {
      shape: 'round-rectangle',
      'corner-radius': ORG.radius,
      'text-valign': 'center',
      'text-margin-y': 0,
      'text-max-width': ORG.maxLabel,
      'text-outline-width': 0,
      color: ink.strong,
    },
  },
  {
    selector: 'node[type="branch"]',
    style: {
      width: boxWidth(ORG_FONT.branch),
      height: 28,
      'background-color': branchColor(ink),
      'background-opacity': 0.14,
      'border-width': 1.5,
      'border-color': branchColor(ink),
      'font-size': TYPE_BASE,
      'font-weight': 600,
    },
  },
  {
    selector: 'node[type="word"]',
    style: {
      width: boxWidth(ORG_FONT.word),
      height: 24,
      'background-color': ink.surface,
      'border-width': 1,
      'border-color': branchColor(ink),
      'border-opacity': 0.6,
      'font-size': TEXT_SM,
    },
  },
  {
    selector: 'node[type="word"].off',
    style: { 'border-style': 'dashed', 'border-color': ink.muted, color: ink.muted },
  },
  {
    selector: 'edge',
    style: {
      width: 1.25,
      opacity: 1, // lines in a list overlap: see-through ones would darken where they do
      'curve-style': 'round-taxi',
      'taxi-direction': 'downward',
      'taxi-turn': '100%',
      'taxi-radius': ORG.radius,
    },
  },
  { selector: 'edge[source = "root"]', style: { 'taxi-turn': '50%', 'taxi-radius': 8 } },
];

// Last, so they beat the layout's own rules
const stateStyle = (ink) => [
  { selector: 'edge.near', style: { 'line-color': branchColor(ink), opacity: 1 } },
  { selector: '.faded', style: { opacity: 0.12 } },
  { selector: '.dim', style: { opacity: 0.12 } },
  { selector: 'node.hl, node.active', style: { 'border-width': 2, 'border-color': ink.brand, 'border-opacity': 1, 'z-index': 10 } },
  // Added but not revealed yet; last so it beats .faded / .dim / .near.
  { selector: '.unborn', style: { opacity: 0, events: 'no' } },
];

const style = (layout, ink) => [...baseStyle(ink), ...(layout === 'org' ? orgStyle(ink) : networkStyle(ink)), ...stateStyle(ink)];

// Resolves once the UI font is usable on canvas, so label widths are measured correctly.
function fontsLoaded() {
  if (!document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`400 ${TEXT_XS}px ${FONT}`),
    document.fonts.load(`600 ${TEXT_SM}px ${FONT}`),
    document.fonts.load(ORG_FONT.branch),
    document.fonts.load(ORG_FONT.word),
  ]).then(() => document.fonts.ready).catch(() => {});
}

export function createGraph(container, { layout = 'network', theme = 'light', onWordTap, onWordMenu, onBranchTap, onViewportChange, onBackgroundTap, getVisibleRect }) {
  if (!LAYOUTS.includes(layout)) layout = 'network';
  let ink = inkOf(theme);
  const cy = window.cytoscape({
    container,
    style: style(layout, ink),
    wheelSensitivity: 0.3,
    minZoom: 0.2,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: 'single',
    autounselectify: true,
    autoungrabify: layout === 'org', // dragging would undo the chart's order
  });

  cy.add({ data: { id: 'root', type: 'root', label: '' }, classes: 'unborn', position: { x: 0, y: 0 } });
  BRANCHES.forEach((b, i) => {
    const angle = (Math.PI / 2) * i - Math.PI / 4;
    cy.add({ data: { id: `b-${b}`, type: 'branch', branch: b, label: b }, classes: 'unborn', position: { x: Math.cos(angle) * 160, y: Math.sin(angle) * 160 } });
    cy.add({ data: { id: `e-b-${b}`, source: 'root', target: `b-${b}` }, classes: 'unborn' });
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
    const bb = motion?.box || eles.boundingBox(); // mid-motion, fit where nodes are headed
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
  let fontsReady = false;
  let queued = null;
  let motion = null; // { timers, end: Map<id, position>, born, box } while nodes are moving

  // Lay out to the final positions, fit the view to them, then animate there from where nodes were.
  function runLayout({ fit = false } = {}) {
    if (!fontsReady) { queued = { fit: fit || !!queued?.fit }; return; }
    settle();
    const doFit = fit || firstLayout || !userMoved;
    const from = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
    if (layout === 'org') {
      const to = orgPositions();
      cy.nodes().positions((n) => to.get(n.id()));
    } else {
      cy.layout({ ...LAYOUT, fit: false }).run();
    }
    if (doFit) fitToVisible({ animate: !firstLayout });
    firstLayout = false;
    animateFrom(from);
  }

  // The branches side by side under the root (which sits above the middle of their row), each box's words in a
  // list below it, starting `arm` right of the line that drops from the box's middle; then the next list down.
  function orgPositions() {
    const to = new Map();
    const seen = new Set();
    const kids = (n) => n.outgoers('node').sort((a, b) => (a.data('order') ?? 0) - (b.data('order') ?? 0));
    // Places n with its top-left corner at (left, top), then its list; returns how far down and right they reach
    const place = (n, left, top) => {
      seen.add(n.id());
      const w = n.outerWidth();
      const h = n.outerHeight();
      to.set(n.id(), { x: left + w / 2, y: top + h / 2 });
      let bottom = top + h;
      let right = left + w;
      kids(n).forEach((k) => {
        if (seen.has(k.id())) return;
        const r = place(k, left + w / 2 + ORG.arm, bottom + ORG.rowGap);
        bottom = r.bottom;
        right = Math.max(right, r.right);
      });
      return { bottom, right };
    };
    const root = cy.getElementById('root');
    const top = root.outerHeight() / 2 + ORG.rankGap;
    let left = 0;
    BRANCHES.forEach((b) => { left = place(cy.getElementById(`b-${b}`), left, top).right + ORG.colGap; });
    const mid = (to.get(`b-${BRANCHES[0]}`).x + to.get(`b-${BRANCHES.at(-1)}`).x) / 2;
    to.forEach((p) => { p.x -= mid; });
    to.set('root', { x: 0, y: 0 });
    return to;
  }

  function setLayout(next) {
    if (!LAYOUTS.includes(next) || next === layout) return;
    layout = next;
    settle();
    cy.style(style(layout, ink));
    cy.autoungrabify(layout === 'org');
    userMoved = false;
    if (!firstLayout) runLayout({ fit: true }); // nodes glide from one layout to the other
  }

  // Recolors in place: nothing moves
  function setTheme(next) {
    ink = inkOf(next);
    cy.style(style(layout, ink));
  }

  // From 12 o'clock around `center`: dir 1 clockwise, -1 anti-clockwise.
  function sweep(nodes, center, dir) {
    const TAU = Math.PI * 2;
    const turn = (n) => {
      const p = n.position();
      const a = dir * (Math.atan2(p.y - center.y, p.x - center.x) + Math.PI / 2);
      return ((a % TAU) + TAU) % TAU;
    };
    return nodes.toArray().sort((a, b) => turn(a) - turn(b));
  }

  function animateFrom(from) {
    const born = cy.elements('.unborn');
    if (reducedMotion?.matches) { born.removeClass('unborn'); return; }
    const end = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
    const m = { timers: [], end, born, box: cy.elements().boundingBox() };
    motion = m;
    let total = 0;

    let glided = false;
    cy.nodes().not(born).forEach((n) => {
      const a = from.get(n.id());
      const b = end.get(n.id());
      if (!a || (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5)) return;
      n.position(a).animate({ position: b }, { duration: MOTION.glide, easing: 'ease-in-out-cubic' });
      glided = true;
    });
    if (glided) total = MOTION.glide;

    // A born node stays hidden at its final spot until its turn, then starts from its parent's
    // current position (or, for the root, from a dot) and moves out with its edge trailing behind.
    const reveal = (n, parent) => {
      if (cy.destroyed() || n.removed()) return;
      cy.batch(() => n.add(n.incomers('edge')).removeClass('unborn'));
      if (parent) {
        n.position({ ...parent.position() }).animate({ position: end.get(n.id()) }, { duration: MOTION.grow, easing: 'ease-out-cubic' });
        return;
      }
      const size = { width: n.numericStyle('width'), height: n.numericStyle('height'), 'border-width': n.numericStyle('border-width') };
      n.style({ width: 2, height: 2, 'border-width': 0 })
        .animate({ style: size }, { duration: MOTION.pop, easing: POP_EASING, complete: () => n.removeStyle('width height border-width') });
    };
    // Org chart: the branches open left to right, each list top to bottom
    const reading = (nodes) => nodes.toArray().sort((a, b) => {
      const pa = end.get(a.id());
      const pb = end.get(b.id());
      return pa.x - pb.x || pa.y - pb.y;
    });
    const visitKids = (p, t) => {
      // Network: the four branches open clockwise around the root; the words around them anti-clockwise.
      const unborn = p.outgoers('node').filter('.unborn');
      const kids = layout === 'org' ? reading(unborn) : sweep(unborn, end.get(p.id()), p.id() === 'root' ? 1 : -1);
      const gap = kids.length > 1 ? Math.min(MOTION.sibling, MOTION.spread / (kids.length - 1)) : 0;
      kids.forEach((k, i) => visit(k, t + i * gap, p));
    };
    const visit = (n, t, parent) => {
      m.timers.push(setTimeout(() => reveal(n, parent), t));
      total = Math.max(total, t + (parent ? MOTION.grow : MOTION.pop));
      visitKids(n, t + MOTION.step);
    };
    // New words under nodes that were already shown sprout once those have nearly settled.
    const sprout = glided ? MOTION.glide * 0.8 : 0;
    cy.nodes().forEach((n) => {
      if (!n.hasClass('unborn')) visitKids(n, sprout);
      else if (n.incomers('node').empty()) visit(n, 0, null);
    });

    m.timers.push(setTimeout(() => { if (motion === m) motion = null; }, total + 50));
  }

  // Jump any running motion to its end state.
  function settle() {
    if (!motion) return;
    const m = motion;
    motion = null;
    m.timers.forEach(clearTimeout);
    cy.batch(() => {
      cy.nodes().stop(true);
      m.end.forEach((p, id) => cy.getElementById(id).position(p));
      m.born.removeClass('unborn');
      cy.getElementById('root').removeStyle('width height border-width');
    });
  }

  fontsLoaded().then(() => {
    fontsReady = true;
    labelWidths.clear(); // measured in a fallback font until now
    cy.style().update();
    if (queued) { const q = queued; queued = null; runLayout(q); }
  });

  function parentNodeId(w, ids) {
    return w.parentId && ids.has(String(w.parentId)) ? String(w.parentId) : `b-${w.branch}`;
  }

  // words: session.words. Adds/updates/removes elements; re-runs layout when nodes were added.
  function syncWords(words) {
    const ids = new Set(words.map((w) => String(w._id)));
    const order = new Map(words.map((w, i) => [String(w._id), i])); // the org chart lists words in this order
    let added = 0;
    let removed = 0;
    let reshaped = 0; // relabeled, reordered or moved to another parent: the org chart's boxes shift

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
            if (existing.data('label') !== w.text || existing.data('order') !== order.get(id)) reshaped++;
            existing.data({ label: w.text, order: order.get(id) });
            existing.toggleClass('off', !w.selected);
            const edge = cy.getElementById(`e-${id}`);
            if (edge.nonempty() && edge.data('source') !== parent) {
              cy.remove(edge);
              cy.add({ data: { id: `e-${id}`, source: parent, target: id } });
              reshaped++;
            }
          } else {
            const p = cy.getElementById(parent).position();
            cy.add({
              data: { id, type: 'word', branch: w.branch, label: w.text, order: order.get(id) },
              classes: w.selected ? 'unborn' : 'off unborn',
              position: { x: p.x + (Math.random() - 0.5) * 80, y: p.y + (Math.random() - 0.5) * 80 },
            });
            cy.add({ data: { id: `e-${id}`, source: parent, target: id }, classes: 'unborn' });
            added++;
          }
          placed.add(id);
        }
      }
    });

    if (added || removed) cy.style().update(); // node size depends on degree
    if (added) runLayout();
    else if (removed && firstLayout) runLayout();
    else if ((removed || reshaped) && layout === 'org') runLayout(); // close the gaps, refit the columns
    return { added, removed };
  }

  function setLabels({ root, branches }) {
    cy.getElementById('root').data('label', root);
    const relabeled = BRANCHES.filter((b) => cy.getElementById(`b-${b}`).data('label') !== branches[b]);
    relabeled.forEach((b) => cy.getElementById(`b-${b}`).data('label', branches[b]));
    if (relabeled.length && layout === 'org' && !firstLayout) runLayout(); // a branch box's width changed
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
    setLayout,
    setTheme,
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
