<script setup lang="ts">
/**
 * InboxComposePanel — full detail-pane compose experience.
 * Rich textarea with inline image paste, markdown support, and
 * send/draft actions. Images are pasted inline at cursor position
 * as markdown image references and shown as inline previews.
 */
import { ref, computed } from 'vue';
import { composeInboxSession } from '../api';
import { useUiStore } from '../stores/ui';

const emit = defineEmits<{
  (e: 'sent', itemId: string): void;
  (e: 'cancel'): void;
}>();

const store = useUiStore();

const body = ref('');
const images = ref<{ id: string; data: string; preview: string }[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);

let imageCounter = 0;

function handlePaste(ev: ClipboardEvent): void {
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const b64 = dataUrl.split(',')[1] ?? '';
        const id = `img-${++imageCounter}`;
        images.value = [...images.value, { id, data: b64, preview: dataUrl }];
        // Insert inline marker at cursor
        const ta = document.querySelector('.compose-body') as HTMLTextAreaElement | null;
        if (ta) {
          const pos = ta.selectionStart ?? body.value.length;
          const before = body.value.slice(0, pos);
          const after = body.value.slice(pos);
          body.value = `${before}\n![${id}](paste://${id})\n${after}`;
        } else {
          body.value += `\n![${id}](paste://${id})\n`;
        }
      };
      reader.readAsDataURL(file);
    }
  }
}

function removeImage(id: string): void {
  images.value = images.value.filter((img) => img.id !== id);
  // Remove the inline reference
  body.value = body.value.replace(new RegExp(`\\n?!\\[${id}\\]\\(paste://${id}\\)\\n?`, 'g'), '\n');
}

const canSend = computed(() => body.value.trim().length > 0);

async function send(draft: boolean): Promise<void> {
  if (!draft && !canSend.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await composeInboxSession({
      prompt: body.value.trim(),
      images: images.value.map((img) => img.data),
      draft,
    });
    await store.refreshInbox();
    const itemId = (result.item as any)?.id;
    emit('sent', itemId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="compose-panel">
    <header class="compose-header">
      <h2 class="compose-title"><i class="pi pi-pencil" /> New message to agent</h2>
      <div class="compose-header-actions">
        <button class="action-btn" :disabled="busy" @click="send(true)" title="Save as draft">
          <i class="pi pi-save" /> Draft
        </button>
        <button class="action-btn send-btn" :disabled="busy || !canSend" @click="send(false)" title="Send (Ctrl+Enter)">
          <i class="pi pi-send" /> Send
        </button>
        <button class="action-btn cancel-btn" @click="emit('cancel')" title="Cancel">
          <i class="pi pi-times" />
        </button>
      </div>
    </header>

    <div class="compose-body-wrap">
      <textarea
        v-model="body"
        class="compose-body"
        placeholder="Write your message… (Markdown supported, paste images inline)"
        @paste="handlePaste"
        @keydown.ctrl.enter="send(false)"
        @keydown.meta.enter="send(false)"
      />
    </div>

    <!-- Inline image previews -->
    <div v-if="images.length > 0" class="compose-images">
      <div v-for="img in images" :key="img.id" class="compose-img-card">
        <img :src="img.preview" class="compose-img-thumb" />
        <span class="compose-img-label">{{ img.id }}</span>
        <button class="compose-img-rm" @click="removeImage(img.id)" title="Remove">×</button>
      </div>
    </div>

    <div v-if="error" class="compose-error">
      <i class="pi pi-exclamation-circle" /> {{ error }}
    </div>

    <footer class="compose-footer">
      <span class="compose-hint">Ctrl+Enter to send · Paste images inline · Markdown supported</span>
    </footer>
  </div>
</template>

<style scoped>
.compose-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 20px;
  gap: 12px;
}
.compose-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}
.compose-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--p-text-color);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.compose-title i { font-size: 14px; color: var(--p-text-color-secondary); }
.compose-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  background: transparent;
  color: var(--p-text-color-secondary);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.action-btn:hover:not(:disabled) { background: rgba(255,255,255,0.05); color: var(--p-text-color); }
.action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.send-btn {
  background: #4a8ae8;
  border-color: #4a8ae8;
  color: #fff;
}
.send-btn:hover:not(:disabled) { background: #3a7ad8; }
.cancel-btn { border: none; font-size: 14px; }

.compose-body-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
.compose-body {
  width: 100%;
  height: 100%;
  min-height: 200px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 13px;
  line-height: 1.6;
  padding: 12px 14px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 8px;
  background: var(--p-surface-ground, #0f1115);
  color: var(--p-text-color);
  resize: none;
}
.compose-body:focus { outline: 1px solid #4a8ae8; border-color: #4a8ae8; }
.compose-body::placeholder { color: var(--p-text-color-secondary); opacity: 0.6; }

.compose-images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.compose-img-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
}
.compose-img-thumb {
  width: 36px; height: 36px;
  object-fit: cover;
  border-radius: 4px;
}
.compose-img-label {
  font-size: 11px;
  color: var(--p-text-color-secondary);
}
.compose-img-rm {
  width: 18px; height: 18px;
  border-radius: 50%;
  background: rgba(229,68,68,0.15);
  color: #e44;
  border: none;
  font-size: 12px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.compose-img-rm:hover { background: rgba(229,68,68,0.3); }

.compose-error {
  font-size: 12px;
  color: #f59e9e;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.compose-footer {
  flex-shrink: 0;
}
.compose-hint {
  font-size: 11px;
  color: var(--p-text-color-secondary);
  opacity: 0.7;
}
</style>
