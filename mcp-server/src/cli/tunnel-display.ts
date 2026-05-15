/**
 * cli/tunnel-display.ts
 *
 * Shared helper for printing the tunnel URL + an ASCII QR code so a phone
 * can join the tunnel without typing the URL by hand. Used by both
 * `clawdevbox init` (after a successful service install) and
 * `clawdevbox status`.
 *
 * `qrcode-terminal` writes directly to stdout via a callback; we redirect
 * its output through the standard logger / stdout path so it lines up with
 * the rest of the CLI's output. Small / quiet mode keeps the block under
 * ~25 lines on a typical terminal.
 */

import qrcode from 'qrcode-terminal';

export interface RenderTunnelInfoArgs {
  /** The full https://… tunnel URL. */
  url: string;
  /** Optional bearer token to surface alongside the URL (init only). */
  token?: string;
  /** Print the inspect URL too when present. */
  inspectUrl?: string | null;
}

/**
 * Print URL + QR to stdout. Synchronous wrapper around `qrcode-terminal`'s
 * callback-based API.
 */
export function renderTunnelInfo(args: RenderTunnelInfoArgs): void {
  process.stdout.write(`\nTunnel URL: ${args.url}\n`);
  if (args.inspectUrl) {
    process.stdout.write(`Inspect:    ${args.inspectUrl}\n`);
  }
  if (args.token) {
    process.stdout.write(
      `Auth:       Authorization: Bearer ${maskToken(args.token)}\n`,
    );
  }
  process.stdout.write('\n');
  // qrcode-terminal does not return the rendered string — it calls the
  // callback. We forward to stdout so the block prints inline with the
  // rest of the CLI output (no extra newlines, no buffering surprises).
  qrcode.generate(args.url, { small: true }, (qr) => {
    process.stdout.write(qr + '\n');
  });
  process.stdout.write(
    `Scan the QR with your phone to open the home page over the tunnel.\n`,
  );
}

/**
 * Reveal the first 4 + last 2 characters of a token so the user knows it's
 * the same one in `<globalDir>/config.json`, without committing the whole
 * value to terminal scrollback / screen recordings.
 */
function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}
