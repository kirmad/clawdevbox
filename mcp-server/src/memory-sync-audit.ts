/**
 * memory-sync-audit.ts
 *
 * Scans a git diff (unified format, added lines only) for content
 * that should block an automatic pull into the memory vault.
 */

export interface AuditConcern {
  rule: 'prompt_injection' | 'credential' | 'encoded_payload' | 'executable_content';
  line: string;
  description: string;
}

export interface AuditResult {
  safe: boolean;
  concerns: AuditConcern[];
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*prompt/i,
  /\[INST\]/i,
  /<\|system\|>/i,
  /BEGIN\s+SYSTEM\s+MESSAGE/i,
  /OVERRIDE:\s/i,
  /jailbreak/i,
];

const CREDENTIAL_PATTERNS = [
  /(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)\s*[=:]\s*\S{8,}/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /sk-[A-Za-z0-9]{32,}/,
  /AKIA[0-9A-Z]{16}/,
];

const ENCODED_PAYLOAD_THRESHOLD = 2000;

const EXECUTABLE_PATTERNS = [
  /```(?:bash|sh|powershell|cmd|bat)\s*\n.*(?:rm\s+-rf|del\s+\/[fqs]|curl.*\|\s*(?:bash|sh)|wget.*\|\s*(?:bash|sh))/is,
  /eval\s*\(/,
  /exec\s*\(/,
  /\$\(.*\)/,
];

export function auditDiff(diff: string): AuditResult {
  const concerns: AuditConcern[] = [];
  const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const rawLine of addedLines) {
    const line = rawLine.slice(1);

    for (const pat of PROMPT_INJECTION_PATTERNS) {
      if (pat.test(line)) {
        concerns.push({ rule: 'prompt_injection', line: line.slice(0, 120), description: `Matches prompt injection pattern: ${pat.source}` });
        break;
      }
    }

    for (const pat of CREDENTIAL_PATTERNS) {
      if (pat.test(line)) {
        concerns.push({ rule: 'credential', line: line.slice(0, 120), description: `Matches credential pattern: ${pat.source}` });
        break;
      }
    }

    const b64Match = line.match(/[A-Za-z0-9+/=]{100,}/);
    if (b64Match && b64Match[0].length > ENCODED_PAYLOAD_THRESHOLD) {
      concerns.push({ rule: 'encoded_payload', line: line.slice(0, 120), description: `Large encoded payload (${b64Match[0].length} chars)` });
    }
  }

  const fullAdded = addedLines.map(l => l.slice(1)).join('\n');
  for (const pat of EXECUTABLE_PATTERNS) {
    if (pat.test(fullAdded)) {
      concerns.push({ rule: 'executable_content', line: '(multiline match)', description: `Matches executable content pattern: ${pat.source}` });
    }
  }

  return { safe: concerns.length === 0, concerns };
}
