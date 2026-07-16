<script setup lang="ts">
/**
 * RecipeFlow — dependency-graph visualization of a recipe's steps.
 *
 * Steps declare `depends: string[]`. We topologically layer them (a step
 * sits one row below its deepest dependency) and draw the flow top→down:
 * HTML node cards positioned absolutely over an SVG edge layer that draws
 * a bezier from each dependency's bottom to the dependent's top.
 *
 * No graph library — pure layout math + SVG, so it stays tree-shakeable
 * and themable with the rest of the app.
 *
 * Clicking a node highlights it plus its incoming/outgoing edges and
 * emits `select` so the parent can scroll the matching step into view.
 */
import { computed, ref } from 'vue';
import type { LibraryRecipeStep } from '../api';

const props = defineProps<{ steps: LibraryRecipeStep[] }>();
const emit = defineEmits<{ (e: 'select', id: string): void }>();

const NODE_W = 190;
const NODE_H = 66;
const H_GAP = 34;
const V_GAP = 58;
const PAD = 16;

interface Positioned extends LibraryRecipeStep {
  layer: number;
  col: number;
  x: number;
  y: number;
}

const activeId = ref<string | null>(null);

const known = computed(() => new Set(props.steps.map((s) => s.id).filter(Boolean)));

/** Layer each step = 1 + max(layer of its known deps); cycles are capped. */
const layered = computed<Positioned[]>(() => {
  const steps = props.steps.filter((s) => s.id);
  const layerOf = new Map<string, number>();
  for (const s of steps) layerOf.set(s.id, 0);
  const maxIter = steps.length + 1;
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const s of steps) {
      let want = 0;
      for (const d of s.depends) {
        if (!layerOf.has(d)) continue;
        want = Math.max(want, (layerOf.get(d) ?? 0) + 1);
      }
      if (want !== layerOf.get(s.id)) {
        layerOf.set(s.id, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Group by layer, preserve declaration order within a layer.
  const byLayer = new Map<number, LibraryRecipeStep[]>();
  for (const s of steps) {
    const l = layerOf.get(s.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s);
  }
  const out: Positioned[] = [];
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  for (const l of layers) {
    const row = byLayer.get(l)!;
    row.forEach((s, col) => {
      out.push({
        ...s,
        layer: l,
        col,
        x: PAD + col * (NODE_W + H_GAP),
        y: PAD + l * (NODE_H + V_GAP),
      });
    });
  }
  return out;
});

const posById = computed<Record<string, Positioned>>(() => {
  const m: Record<string, Positioned> = {};
  for (const p of layered.value) m[p.id] = p;
  return m;
});

const canvas = computed(() => {
  let maxCols = 1;
  const byLayer = new Map<number, number>();
  for (const p of layered.value) byLayer.set(p.layer, (byLayer.get(p.layer) ?? 0) + 1);
  for (const c of byLayer.values()) maxCols = Math.max(maxCols, c);
  const layerCount = byLayer.size || 1;
  return {
    width: PAD * 2 + maxCols * NODE_W + (maxCols - 1) * H_GAP,
    height: PAD * 2 + layerCount * NODE_H + (layerCount - 1) * V_GAP,
  };
});

interface Edge { from: string; to: string; d: string }

const edges = computed<Edge[]>(() => {
  const out: Edge[] = [];
  for (const p of layered.value) {
    for (const dep of p.depends) {
      if (!known.value.has(dep)) continue;
      const a = posById.value[dep];
      const b = posById.value[p.id];
      if (!a || !b) continue;
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const midY = (y1 + y2) / 2;
      out.push({ from: dep, to: p.id, d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}` });
    }
  }
  return out;
});

/** Edge is highlighted when either endpoint is the active node. */
function edgeActive(e: Edge): boolean {
  return activeId.value !== null && (e.from === activeId.value || e.to === activeId.value);
}
function nodeDimmed(id: string): boolean {
  if (activeId.value === null) return false;
  if (id === activeId.value) return false;
  // connected to active?
  const connected = edges.value.some(
    (e) => (e.from === activeId.value && e.to === id) || (e.to === activeId.value && e.from === id),
  );
  return !connected;
}

function onNode(id: string): void {
  activeId.value = activeId.value === id ? null : id;
  emit('select', id);
}

function goalText(s: LibraryRecipeStep): string {
  return s.goal || '(no goal)';
}

function gateTitle(s: LibraryRecipeStep): string {
  const gates = s.validation?.gates ?? [];
  if (gates.length > 1) {
    return `Validation-gated (${gates.length} gates: ${gates.map((g) => g.mode).join(', ')}). Independent verifiers must confirm this step's outcome before it can complete.`;
  }
  return `Validation-gated (mode: ${gates[0]?.mode ?? '—'}). An independent verifier must confirm this step's outcome before it can complete.`;
}
</script>

<template>
  <div v-if="layered.length === 0" class="flow-empty">
    This recipe declares no steps.
  </div>
  <div v-else class="flow-wrap">
    <div class="flow-canvas" :style="{ width: canvas.width + 'px', height: canvas.height + 'px' }">
      <svg class="flow-edges" :width="canvas.width" :height="canvas.height">
        <defs>
          <marker id="rf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="rf-arrow-head" />
          </marker>
          <marker id="rf-arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="rf-arrow-head hot" />
          </marker>
        </defs>
        <path
          v-for="(e, i) in edges"
          :key="i"
          :d="e.d"
          class="rf-edge"
          :class="{ hot: edgeActive(e), dim: activeId !== null && !edgeActive(e) }"
          :marker-end="edgeActive(e) ? 'url(#rf-arrow-hot)' : 'url(#rf-arrow)'"
          fill="none"
        />
      </svg>
      <button
        v-for="p in layered"
        :key="p.id"
        type="button"
        class="flow-node"
        :class="{ active: activeId === p.id, dimmed: nodeDimmed(p.id), gated: !!p.validation }"
        :style="{ left: p.x + 'px', top: p.y + 'px', width: NODE_W + 'px', height: NODE_H + 'px' }"
        :title="p.goal"
        @click="onNode(p.id)"
      >
        <span class="flow-node__id">
          <span class="flow-node__badge">{{ p.layer + 1 }}</span>
          {{ p.id }}
          <span v-if="p.validation?.gates?.length" class="flow-node__gate" :title="gateTitle(p)">
            <i class="pi pi-shield" /><template v-if="p.validation.gates.length > 1">×{{ p.validation.gates.length }}</template><template v-else>{{ p.validation.gates[0]?.mode }}</template>
          </span>
          <i v-if="p.has_ai_instructions" class="pi pi-sparkles flow-node__ai" title="Has AI instructions" />
        </span>
        <span class="flow-node__goal">{{ goalText(p) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.flow-empty { color: var(--p-text-color-secondary); font-size: 13px; padding: 16px; }
.flow-wrap { overflow: auto; padding: 4px; background:
  radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0);
  background-size: 22px 22px; border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 8px; max-height: 60vh;
}
.flow-canvas { position: relative; margin: 0 auto; }
.flow-edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.rf-edge { stroke: #4b5262; stroke-width: 1.6; transition: stroke 0.15s, opacity 0.15s; }
.rf-edge.hot { stroke: var(--p-primary-color, #88c0d0); stroke-width: 2.4; }
.rf-edge.dim { opacity: 0.28; }
.rf-arrow-head { fill: #4b5262; }
.rf-arrow-head.hot { fill: var(--p-primary-color, #88c0d0); }

.flow-node {
  position: absolute; text-align: left; display: flex; flex-direction: column; gap: 4px;
  background: #1c1f27; border: 1px solid #2f3542; border-left: 3px solid var(--p-primary-color, #88c0d0);
  border-radius: 7px; color: var(--p-text-color); padding: 8px 10px; cursor: pointer;
  font: inherit; overflow: hidden; transition: transform 0.1s, box-shadow 0.15s, opacity 0.15s, border-color 0.15s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
.flow-node:hover { background: #232733; transform: translateY(-1px); box-shadow: 0 4px 10px rgba(0,0,0,0.4); }
.flow-node.active { border-color: var(--p-primary-color, #88c0d0); box-shadow: 0 0 0 2px var(--p-primary-color, #88c0d0)55; }
.flow-node.dimmed { opacity: 0.4; }
.flow-node:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

.flow-node__id {
  display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px;
  font-family: ui-monospace, Consolas, Menlo, monospace; color: var(--p-text-color);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.flow-node__badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px;
  padding: 0 4px; border-radius: 8px; background: #2f3542; color: var(--p-text-color-secondary);
  font-size: 10px; font-weight: 700;
}
.flow-node__ai { color: #d0a24c; font-size: 10px; margin-left: auto; }
.flow-node.gated { border-left-color: #a78bfa; }
.flow-node__gate {
  display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0;
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
  color: #c4b5fd; background: rgba(167, 139, 250, 0.16); border-radius: 8px; padding: 0 5px; height: 14px;
}
.flow-node__gate i { font-size: 9px; }
.flow-node__goal {
  font-size: 11px; line-height: 1.35; color: var(--p-text-color-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
</style>
