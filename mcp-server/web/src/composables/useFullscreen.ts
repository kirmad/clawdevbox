/**
 * useFullscreen — minimal CSS-fullscreen composable.
 *
 * Returns `isFullscreen` ref + `toggle()` + `enter()` + `exit()`. When
 * `isFullscreen` is true the host component should apply the `.fs-pane`
 * class to its root element (defined in style.css).
 *
 * We deliberately don't use the browser Fullscreen API. CSS fullscreen
 * has fewer cross-platform quirks (mobile Safari, iframe sandboxing) and
 * lets us co-render with Toast/ConfirmDialog which use their own
 * z-index layer.
 *
 * Only one pane is fullscreen at a time — `fullscreenPaneId` in the
 * Pinia store coordinates that. This composable is the per-component glue.
 */

import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';

export function useFullscreen(paneId: string) {
  const store = useUiStore();
  const isFullscreen = ref(false);

  function update(): void {
    isFullscreen.value = store.fullscreenPaneId === paneId;
  }

  function enter(): void {
    store.fullscreenPaneId = paneId;
  }
  function exit(): void {
    if (store.fullscreenPaneId === paneId) store.fullscreenPaneId = null;
  }
  function toggle(): void {
    if (isFullscreen.value) exit();
    else enter();
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && isFullscreen.value) {
      exit();
      ev.stopPropagation();
    }
  }

  let unwatch: (() => void) | null = null;
  onMounted(() => {
    update();
    unwatch = watch(() => store.fullscreenPaneId, update);
    window.addEventListener('keydown', onKey);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKey);
    unwatch?.();
    // Don't auto-exit on unmount — keep state until the next toggle.
  });

  return { isFullscreen, enter, exit, toggle };
}
