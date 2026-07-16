import { h } from 'vue';
import InboxTerminalPanel from './InboxTerminalPanel.vue';

void h(InboxTerminalPanel, {
  sessionIds: ['session-a'],
  onClose: () => {},
});

void h(InboxTerminalPanel, {
  sessionIds: ['session-a', 'session-b'],
  sessionLabels: ['Session A', 'Session B'],
  onClose: () => {},
});

type InboxTerminalPanelInstance = InstanceType<typeof InboxTerminalPanel>;

declare const panel: InboxTerminalPanelInstance;

panel.$emit('close');
