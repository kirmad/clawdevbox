<script setup lang="ts">
/**
 * ArtifactPanel — embeds an artifact via the standalone host page at
 * `/artifact/<id>`. The iframe is `sandbox`-ed so renderer code can't
 * navigate the parent SPA. `allow-same-origin` is required because
 * renderer modules are loaded from the same origin via dynamic import
 * inside the host page.
 *
 * If the artifact tab was opened from an inbox attachment click, a
 * "← back" button in the top-left navigates back to the parent inbox
 * view (master-detail pane or popped-out tab — see `returnTo`).
 *
 * The floating fullscreen button (top-right) expands the panel to
 * cover the entire viewport via CSS.
 */
import { useFullscreen } from '../composables/useFullscreen';
import { useUiStore } from '../stores/ui';
import type { OpenArtifactTab } from '../stores/ui';

const props = defineProps<{
  id: string;
  url: string;
  title?: string;
  returnTo?: OpenArtifactTab['returnTo'];
}>();

const store = useUiStore();
const { isFullscreen, toggle } = useFullscreen(`artifact:${props.id}`);

function goBack(): void {
  if (props.returnTo) store.navigateBackFromArtifact(props.returnTo);
}
</script>

<template>
  <section class="panel" :class="{ 'fs-pane': isFullscreen }">
    <Button
      v-if="returnTo"
      icon="pi pi-arrow-left"
      severity="secondary"
      text
      rounded
      size="small"
      class="back-btn"
      :title="`Back to ${returnTo.kind === 'inbox-tab' ? 'inbox item' : 'mail'}`"
      aria-label="Back to inbox item"
      @click="goBack"
    />
    <Button
      :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
      text
      rounded
      size="small"
      severity="secondary"
      :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
      :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
      class="fs-btn"
      @click="toggle"
    />
    <iframe
      :src="url"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      loading="lazy"
      referrerpolicy="same-origin"
      :title="title || 'artifact'"
    />
  </section>
</template>

<style scoped>
.panel {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
iframe { flex: 1; width: 100%; border: 0; background: #15171d; }

.back-btn, .fs-btn {
  position: absolute;
  top: 6px;
  z-index: 10;
  width: 30px;
  height: 30px;
  background: rgba(20, 22, 27, 0.85);
  backdrop-filter: blur(4px);
}
.back-btn { left: 8px; }
.back-btn:hover, .fs-btn:hover { background: rgba(20, 22, 27, 0.95); }
.fs-btn { right: 8px; }
</style>
