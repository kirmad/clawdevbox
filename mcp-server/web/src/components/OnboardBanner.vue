<script setup lang="ts">
/**
 * Onboarding banner — surfaces "Enable notifications" + "Install app" CTAs
 * until both prompts are satisfied (or the user dismisses). Uses
 * PrimeVue's <Message> for visual consistency.
 *
 * Install logic:
 *   - Chrome / Edge / Android Chrome: capture `beforeinstallprompt`, fire
 *     it on click.
 *   - iOS Safari: no install event, so we show a static
 *     "Tap Share → Add to Home Screen" hint.
 *   - Standalone display mode (already installed) suppresses both.
 */
import { computed, onMounted, ref } from 'vue';
import { useStorage } from '@vueuse/core';
import { useUiStore } from '../stores/ui';

const store = useUiStore();
const dismissed = useStorage('clawdevbox-onboard-dismissed-v1', false);

const deferredInstallPrompt = ref<BeforeInstallPromptEvent | null>(null);
const standalone = ref(false);

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function detectStandalone(): boolean {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch { /* ignore */ }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) && !(window as Window & { MSStream?: unknown }).MSStream;
  const webkit = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && webkit;
}
const ios = ref(isIosSafari());

onMounted(() => {
  standalone.value = detectStandalone();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt.value = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt.value = null;
    standalone.value = true;
  });
});

const showNotify = computed(() =>
  !dismissed.value &&
  store.pushReady &&
  !store.push.subscribed &&
  !store.push.permissionDenied,
);

const installable = computed(() => !dismissed.value && !standalone.value && (!!deferredInstallPrompt.value || ios.value));

const visible = computed(() => showNotify.value || installable.value);

async function onEnableNotifications(): Promise<void> {
  try {
    await store.subscribePush();
  } catch {
    /* hint surfaces via store.push.hint */
  }
}

async function onInstallApp(): Promise<void> {
  if (!deferredInstallPrompt.value) return;
  try {
    deferredInstallPrompt.value.prompt();
    const choice = await deferredInstallPrompt.value.userChoice;
    if (choice.outcome === 'accepted') deferredInstallPrompt.value = null;
  } catch {
    /* user cancelled */
  }
}

function onDismiss(): void {
  dismissed.value = true;
}
</script>

<template>
  <Message
    v-if="visible"
    severity="info"
    :closable="true"
    :sticky="true"
    @close="onDismiss"
    class="app-onboard"
  >
    <div class="onboard-row">
      <strong>Get the most out of clawdevbox:</strong>
      <Button
        v-if="showNotify"
        label="Enable notifications"
        icon="pi pi-bell"
        size="small"
        severity="secondary"
        @click="onEnableNotifications"
      />
      <Button
        v-if="installable && !ios"
        label="Install app"
        icon="pi pi-mobile"
        size="small"
        severity="secondary"
        @click="onInstallApp"
      />
      <span v-if="installable && ios" class="ios-hint">
        <i class="pi pi-mobile" /> Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>
      </span>
    </div>
  </Message>
</template>

<style scoped>
.onboard-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ios-hint { color: var(--p-text-color-secondary); font-size: 12px; }
</style>
