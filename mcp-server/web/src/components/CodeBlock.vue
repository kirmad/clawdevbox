<script setup lang="ts">
/**
 * CodeBlock — syntax-highlighted, line-numbered code viewer.
 *
 * Features:
 *   - Tree-shaken highlight.js: only the languages we register at module-
 *     load time are bundled. Add new ones in `LANGUAGES` below.
 *   - Line numbers in a sticky left gutter; click a number to highlight
 *     that line (helps when discussing "what does line 42 do?").
 *   - Toolbar: language tag, line count, Copy button (clipboard),
 *     Wrap toggle.
 *   - Horizontal scroll for long lines (wrap off by default; click Wrap
 *     to switch).
 *   - Browser Ctrl/Cmd+F search works as expected — code is real DOM,
 *     not a canvas.
 *
 * Use:
 *   <CodeBlock :source="..." runtime="tsx" :max-height="500" />
 */
import { computed, ref, watch } from 'vue';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import 'highlight.js/styles/github-dark.css';

// Register exactly the languages we support. Adding a new one means
// importing it here AND adding the runtime → hljs-lang mapping below.
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('json', json);

const props = withDefaults(defineProps<{
  source: string;
  /**
   * Runtime hint — maps onto a highlight.js language. Pass the trigger
   * runtime ('tsx' | 'node' | 'python' | 'bash') or a raw hljs language
   * name. Falls back to plain text if unrecognized.
   */
  runtime?: string;
  /** Optional explicit hljs language name; overrides runtime mapping. */
  language?: string;
  /** Max height in px before vertical scroll kicks in. Default 500. */
  maxHeight?: number;
  /** When true, long lines wrap instead of horizontal-scrolling. */
  wrap?: boolean;
}>(), {
  runtime: undefined,
  language: undefined,
  maxHeight: 500,
  wrap: false,
});

const RUNTIME_TO_LANG: Record<string, string> = {
  tsx: 'typescript',
  ts: 'typescript',
  node: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  python: 'python',
  py: 'python',
  bash: 'bash',
  sh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
};

const resolvedLang = computed<string | null>(() => {
  if (props.language && hljs.getLanguage(props.language)) return props.language;
  const fromRuntime = props.runtime ? RUNTIME_TO_LANG[props.runtime.toLowerCase()] : null;
  if (fromRuntime && hljs.getLanguage(fromRuntime)) return fromRuntime;
  return null;
});

const highlighted = computed(() => {
  const lang = resolvedLang.value;
  if (!lang) return escapeHtml(props.source);
  try {
    return hljs.highlight(props.source, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(props.source);
  }
});

const lines = computed<string[]>(() => {
  // Splitting AFTER highlighting preserves multi-line span ranges across
  // newlines (highlight.js emits well-formed nested spans that don't break
  // across `\n`s in practice for the languages we use).
  const split = highlighted.value.split('\n');
  // hljs sometimes emits a trailing empty entry from a final newline;
  // strip it so the gutter line count matches what the user sees.
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  return split;
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Interactive features ──────────────────────────────────────────────────
const wrapInternal = ref(props.wrap);
watch(() => props.wrap, (v) => { wrapInternal.value = v; });

const selectedLine = ref<number | null>(null);
function toggleSelectLine(n: number): void {
  selectedLine.value = selectedLine.value === n ? null : n;
}

const copyState = ref<'idle' | 'ok' | 'err'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyAll(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.source);
    copyState.value = 'ok';
  } catch {
    copyState.value = 'err';
  }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyState.value = 'idle'; }, 1500);
}
</script>

<template>
  <div class="code-block">
    <div class="code-toolbar">
      <span class="code-lang">{{ resolvedLang ?? 'text' }}</span>
      <span class="code-meta">{{ lines.length }} line{{ lines.length === 1 ? '' : 's' }}</span>
      <span class="code-spacer" />
      <button
        type="button"
        class="code-action"
        :class="{ active: wrapInternal }"
        :aria-pressed="wrapInternal"
        title="Wrap long lines"
        @click="wrapInternal = !wrapInternal"
      >
        <i class="pi pi-align-justify" /> wrap
      </button>
      <button
        type="button"
        class="code-action"
        :class="{ ok: copyState === 'ok', err: copyState === 'err' }"
        title="Copy entire script to clipboard"
        @click="copyAll"
      >
        <i :class="copyState === 'ok' ? 'pi pi-check' : 'pi pi-copy'" />
        {{ copyState === 'ok' ? 'copied' : copyState === 'err' ? 'failed' : 'copy' }}
      </button>
    </div>
    <div
      class="code-scroll hljs"
      :class="{ 'code-wrap': wrapInternal }"
      :style="{ maxHeight: `${maxHeight}px` }"
    >
      <div class="code-grid">
        <div
          v-for="(line, i) in lines"
          :key="i"
          class="code-row"
          :class="{ 'code-row-selected': selectedLine === i + 1 }"
        >
          <button
            type="button"
            class="code-gutter"
            :title="`Highlight line ${i + 1}`"
            @click="toggleSelectLine(i + 1)"
          >{{ i + 1 }}</button>
          <pre class="code-line"><code v-html="line || ' '" /></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-block {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 4px;
  background: #0d1117; /* matches github-dark.css */
  overflow: hidden;
}

.code-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: #161b22;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  font-size: 11px;
  color: var(--p-text-color-secondary);
}
.code-lang {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-color);
  font-weight: 500;
  padding: 1px 6px;
  background: #21262d;
  border-radius: 3px;
  font-size: 10px;
}
.code-meta { color: var(--p-text-color-secondary); font-size: 11px; }
.code-spacer { flex: 1; }
.code-action {
  background: transparent;
  border: 1px solid transparent;
  color: var(--p-text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.code-action:hover { background: #21262d; color: var(--p-text-color); }
.code-action.active { background: #21262d; color: var(--p-text-color); border-color: #30363d; }
.code-action.ok { color: #4ade80; }
.code-action.err { color: #f87171; }
.code-action i { font-size: 10px; }

.code-scroll {
  overflow: auto;
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.code-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  /* width:max-content lets horizontal scroll work for unwrapped long lines */
  width: max-content;
  min-width: 100%;
}

.code-row {
  display: contents;
}
.code-row-selected .code-gutter {
  background: #1f6feb33;
  color: #58a6ff;
  font-weight: 600;
}
.code-row-selected .code-line {
  background: #1f6feb1a;
}

.code-gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  background: #0d1117;
  border: none;
  border-right: 1px solid #21262d;
  color: #6e7681;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  text-align: right;
  padding: 0 10px 0 12px;
  user-select: none;
  min-width: 38px;
  line-height: 1.55;
}
.code-gutter:hover { color: #c9d1d9; background: #161b22; }

.code-line {
  margin: 0;
  padding: 0 14px 0 12px;
  background: transparent;
  font: inherit;
  color: inherit;
  white-space: pre;
  overflow: visible;
}
.code-line code { font: inherit; background: transparent; padding: 0; }

.code-wrap .code-grid { width: 100%; }
.code-wrap .code-line { white-space: pre-wrap; word-break: break-word; }
</style>
