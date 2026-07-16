/**
 * useMobileHistory — wires history.pushState/popstate to a "detail open"
 * boolean so the OS / browser Back gesture closes a mobile detail view
 * instead of leaving the SPA.
 *
 * Usage:
 *   const { open, close, isOpen } = useMobileHistory({
 *     key: 'inbox-detail',
 *     onClose: () => store.selectedInboxId = null,
 *   });
 *
 * We push a synthetic state with a marker; on popstate, if the marker
 * goes away, we invoke onClose. Multiple consumers can coexist —
 * each only reacts to its own key.
 */

import { onBeforeUnmount, onMounted, ref } from 'vue';

interface Options {
  key: string;
  onClose: () => void;
}

export function useMobileHistory(opts: Options) {
  const isOpen = ref(false);

  function popHandler(ev: PopStateEvent): void {
    const stillOurs = (ev.state && (ev.state as { cdbDetail?: string }).cdbDetail) === opts.key;
    if (isOpen.value && !stillOurs) {
      isOpen.value = false;
      opts.onClose();
    }
  }

  function open(): void {
    if (isOpen.value) return;
    isOpen.value = true;
    try {
      history.pushState({ cdbDetail: opts.key }, '', location.href);
    } catch {
      /* private mode / sandbox can throw — degrade silently */
    }
  }

  function close(): void {
    if (!isOpen.value) return;
    isOpen.value = false;
    if (
      history.state &&
      (history.state as { cdbDetail?: string }).cdbDetail === opts.key
    ) {
      try {
        history.back();
      } catch {
        /* ignore */
      }
    }
    opts.onClose();
  }

  onMounted(() => {
    window.addEventListener('popstate', popHandler);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('popstate', popHandler);
  });

  return { isOpen, open, close };
}
