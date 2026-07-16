#!/usr/bin/env node
/**
 * Back-compat entry. The shipping bin is `dist/cli.js` (see package.json
 * `bin.clawdevbox`). This file lets `tsx src/index.ts` and `npm run start`
 * still hit the same CLI dispatcher during local development.
 */
import('./cli/index.ts');
