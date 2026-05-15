<script setup lang="ts">
/**
 * Tunnel QR dialog — phones can scan and land on the home page over the
 * tunnel without typing the URL. Backed by the `qrcode` package writing
 * to a canvas inside the dialog.
 */
import { ref, watch } from 'vue';
import QRCode from 'qrcode';

const props = defineProps<{ visible: boolean; url: string }>();
const emit = defineEmits<{ 'update:visible': [boolean] }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

async function renderQr(): Promise<void> {
  if (!canvasRef.value || !props.url) return;
  try {
    await QRCode.toCanvas(canvasRef.value, props.url, {
      width: 240,
      margin: 1,
      color: { dark: '#eceff4', light: '#15171d' },
      errorCorrectionLevel: 'M',
    });
  } catch {
    /* surface as a missing canvas — dialog still shows the URL text */
  }
}

watch(() => [props.visible, props.url], async ([v]) => {
  if (!v) return;
  // Wait for the canvas to appear in the DOM (next paint).
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await renderQr();
});

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.url);
  } catch {
    /* clipboard blocked — user can long-press the URL */
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    @update:visible="emit('update:visible', $event)"
    modal
    header="Tunnel"
    :style="{ width: 'min(360px, 90vw)' }"
  >
    <div class="qr-wrap">
      <canvas ref="canvasRef" />
      <div class="url">
        <a :href="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
      </div>
      <div class="actions">
        <Button label="Copy URL" icon="pi pi-copy" size="small" severity="secondary" @click="copy" />
        <Button as="a" :href="url" target="_blank" rel="noopener noreferrer" label="Open" icon="pi pi-external-link" size="small" severity="primary" />
      </div>
      <div class="hint">Scan with your phone to open over the tunnel.</div>
    </div>
  </Dialog>
</template>

<style scoped>
.qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 4px; }
.qr-wrap canvas { background: #15171d; border-radius: 6px; box-shadow: 0 0 0 1px var(--p-content-border-color); }
.url { font-size: 12px; word-break: break-all; text-align: center; }
.url a { color: var(--p-primary-color); }
.actions { display: flex; gap: 8px; }
.hint { color: var(--p-text-color-secondary); font-size: 11.5px; }
</style>
