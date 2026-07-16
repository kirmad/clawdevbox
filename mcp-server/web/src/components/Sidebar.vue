<script setup lang="ts">
/**
 * Sidebar — project info, MCP URL, tunnel pill (click → QR dialog), push
 * controls. The xterm Main Agent button etc. live in the pane tabs, not
 * here, but the agent live-status pill stays in the sidebar so it's
 * always visible.
 */
import { computed, ref } from 'vue';
import { useUiStore } from '../stores/ui';
import TunnelQrDialog from './TunnelQrDialog.vue';

const store = useUiStore();
const tunnelPillState = computed(() => {
  const t = store.tunnel;
  if (t.kind === 'none') return 'off';
  if (t.error) return 'error';
  if (t.url) return 'live';
  return 'pending';
});

const pushBadgeSeverity = computed(() => {
  switch (store.push.state) {
    case 'live': return 'success';
    case 'pending': return 'info';
    case 'error': return 'danger';
    default: return 'secondary';
  }
});

const qrDialogOpen = ref(false);
function openQr(): void {
  if (store.tunnel.url) qrDialogOpen.value = true;
}

const liveState = computed(() => store.liveState);
const agentBadgeSeverity = computed(() => store.agent.running ? 'success' : (store.agent.exited ? 'danger' : 'secondary'));
</script>

<template>
  <aside class="app-sidebar">
    <div class="brand">clawdevbox</div>

    <div class="meta">
      <div class="label">project</div>
      <code class="value" :title="store.boot.projectDir">{{ store.boot.projectDir }}</code>

      <div class="label">mcp (local)</div>
      <code class="value" :title="store.boot.mcpUrl">{{ store.boot.mcpUrl }}</code>

      <div class="label row">
        <span>tunnel</span>
        <span class="pill" :data-state="tunnelPillState">
          {{ tunnelPillState === 'pending' ? '…' : tunnelPillState }}
        </span>
      </div>
      <div class="value tunnel-line">
        <template v-if="store.tunnel.kind === 'none'">not configured</template>
        <template v-else-if="store.tunnel.error">{{ store.tunnel.error }}</template>
        <template v-else-if="store.tunnel.url">
          <a :href="store.tunnel.url" target="_blank" rel="noopener noreferrer">{{ store.tunnel.url }}</a>
          <Button
            icon="pi pi-qrcode"
            severity="secondary"
            text
            rounded
            aria-label="Show QR code"
            class="qr-btn"
            @click="openQr"
          />
        </template>
        <template v-else>
          {{ store.tunnel.name || 'tunnel' }} starting…
        </template>
      </div>

      <div class="label row">
        <span>push</span>
        <Badge :value="store.push.state" :severity="pushBadgeSeverity" />
      </div>
      <div class="value push-hint">{{ store.push.hint }}</div>
      <div v-if="store.push.subscribed" class="push-actions">
        <Button label="Disable" size="small" severity="secondary" outlined @click="store.unsubscribePush()" />
        <Button label="Send test" size="small" severity="secondary" outlined @click="store.testPush().then(msg => store.push.hint = msg)" />
      </div>
      <div v-else-if="store.pushReady && !store.push.permissionDenied" class="push-actions">
        <Button label="Enable" size="small" severity="primary" @click="store.subscribePush()" />
      </div>

      <div class="label row">
        <span>live</span>
        <span class="live-dot" :data-state="liveState" />
        <span class="muted">{{ liveState === 'live' ? 'connected' : 'reconnecting' }}</span>
      </div>

      <div class="label row">
        <span>main agent</span>
        <Badge :value="store.agent.running ? 'running' : (store.agent.exited ? 'exited' : 'unknown')" :severity="agentBadgeSeverity" />
      </div>
    </div>

    <TunnelQrDialog v-model:visible="qrDialogOpen" :url="store.tunnel.url || ''" />
  </aside>
</template>

<style scoped>
.app-sidebar { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.brand { font-weight: 600; color: var(--p-primary-color); font-size: 13px; letter-spacing: 0.04em; }
.meta { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.label { color: #88c0d0; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 8px; display: flex; align-items: center; gap: 6px; }
.label.row { justify-content: flex-start; }
.value { color: var(--p-text-color); word-break: break-all; font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11.5px; }
.tunnel-line { display: flex; gap: 6px; align-items: center; }
.tunnel-line a { color: var(--p-primary-color); text-decoration: none; word-break: break-all; }
.qr-btn { width: 22px; height: 22px; padding: 0; }
.push-hint { color: var(--p-text-color-secondary); font-family: inherit; font-size: 11.5px; min-height: 1em; }
.push-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.muted { color: var(--p-text-color-secondary); }
</style>
