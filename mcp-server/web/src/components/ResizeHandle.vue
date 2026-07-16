<script setup lang="ts">
/**
 * ResizeHandle — vertical drag handle for adjusting the width of an
 * adjacent flex child. Emits `update:width` as the user drags.
 *
 * Usage:
 *   <div :style="{ flexBasis: leftWidth + 'px' }">…left…</div>
 *   <ResizeHandle :width="leftWidth" :min="200" :max="600"
 *                 @update:width="(w) => leftWidth = w" />
 *   <div style="flex: 1">…right…</div>
 *
 * The handle measures pageX deltas while the user is dragging, so the
 * resized side can be on either edge — pass `side="right"` (default)
 * when the handle sits on the RIGHT edge of the resized element, or
 * `side="left"` when it's on the LEFT edge.
 */
import { ref } from 'vue';

interface Props {
  width: number;
  min?: number;
  max?: number;
  side?: 'left' | 'right';
}
const props = withDefaults(defineProps<Props>(), {
  min: 100,
  max: 1000,
  side: 'right',
});
const emit = defineEmits<{ (e: 'update:width', value: number): void }>();

const dragging = ref(false);
let startX = 0;
let startWidth = 0;

function onMouseDown(ev: MouseEvent): void {
  dragging.value = true;
  startX = ev.pageX;
  startWidth = props.width;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(ev: MouseEvent): void {
  if (!dragging.value) return;
  const delta = ev.pageX - startX;
  // When the handle is on the RIGHT edge of the resized element, dragging
  // right enlarges; when on the LEFT edge, dragging right shrinks.
  const sign = props.side === 'right' ? 1 : -1;
  const next = Math.max(props.min, Math.min(props.max, startWidth + sign * delta));
  emit('update:width', next);
}

function onMouseUp(): void {
  dragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}
</script>

<template>
  <div
    class="resize-handle"
    :class="{ dragging }"
    @mousedown.prevent="onMouseDown"
  />
</template>

<style scoped>
.resize-handle {
  flex: 0 0 4px;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 100ms ease;
  position: relative;
  z-index: 2;
}
.resize-handle:hover,
.resize-handle.dragging {
  background: #4a8be8;
}
</style>
