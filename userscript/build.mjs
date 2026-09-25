/**
 * Bundles the userscript to public/silentfeed.user.js.
 *
 * Vite copies public/ verbatim into dist/, so the built script is served at
 * <app-origin>/silentfeed.user.js. @updateURL points back at that same URL,
 * which means every Vercel deploy ships a bridge update that Tampermonkey
 * picks up on its own - there is never a manual reinstall step.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const config = JSON.parse(readFileSync(resolve(root, 'app.config.json'), 'utf8'));

/**
 * Building on Vercel? Take the app origin from the platform.
 *
 * This is both more convenient and safer than the config file: the production
 * URL is issued to this project, so it is a domain the deploying user
 * provably controls - no guessing at a name someone else might register.
 * Preview deployments deliberately still point at the production domain
 * rather than their own ephemeral URL.
 */
const vercelProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const onVercel = Boolean(process.env.VERCEL);

const appOrigin = vercelProductionUrl
  ? `https://${vercelProductionUrl}`
  : String(config.appOrigin ?? '').replace(/\/+$/, '');

// A production build must not trust localhost. Otherwise anything a user
// happens to be running on that port could drive their X session through the
// bridge.
const devOrigin = onVercel ? '' : String(config.devOrigin ?? '').replace(/\/+$/, '');

// Until you actually own appOrigin, trusting it is a live hazard: whoever
// registers that hostname could drive your X session through the bridge, and
// @updateURL would pull code from their server. So it stays inert unless you
// confirm it, or unless Vercel told us the domain itself.
const confirmed =
  Boolean(vercelProductionUrl) || (config.appOriginConfirmed === true && Boolean(appOrigin));

if (appOrigin.includes('*')) {
  throw new Error(
    'appOrigin must be an exact origin, never a wildcard. A wildcard would let any ' +
      'site on that domain drive your X session through the bridge.',
  );
}
if (confirmed && !/^https:\/\//.test(appOrigin)) {
  throw new Error(`A confirmed appOrigin must be https, got: ${appOrigin || '(empty)'}`);
}

/**
 * localhost and 127.0.0.1 are different origins as far as the browser is
 * concerned, and it is easy to end up on whichever one you did not configure.
 * Trust both for the dev origin so that is never the thing that is broken.
 */
function devVariants(origin) {
  if (!origin) return [];
  const url = new URL(origin);
  const loopback = ['localhost', '127.0.0.1'];
  if (!loopback.includes(url.hostname)) return [origin];
  return loopback.map((host) => `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`);
}

/** Origins the bridge will answer. Exact matches only. */
const appOrigins = [
  ...(confirmed ? [appOrigin] : []),
  ...devVariants(devOrigin),
];
if (appOrigins.length === 0) {
  throw new Error('No trusted origin configured - set devOrigin or confirm appOrigin.');
}

// Tampermonkey only fetches an update when the version string increases, so
// stamp it with the build minute. Guarantees deploys propagate.
const now = new Date();
const stamp =
  now.getUTCFullYear().toString() +
  String(now.getUTCMonth() + 1).padStart(2, '0') +
  String(now.getUTCDate()).padStart(2, '0') +
  String(now.getUTCHours()).padStart(2, '0') +
  String(now.getUTCMinutes()).padStart(2, '0');

/**
 * Chrome's match-pattern grammar has no place for a port: `http://localhost:5173/*`
 * is simply invalid, and Tampermonkey's tolerance for it varies by version.
 * For a ported origin we therefore emit a port-less @match (which matches the
 * host on every port) plus an @include, whose glob syntax does accept ports.
 *
 * This only widens where the script *runs*. What it will actually talk to is
 * still the exact origin list in __APP_ORIGINS__, checked on every message.
 */
function siteDirectives(origin) {
  const url = new URL(origin);
  if (!url.port) return [`// @match        ${url.protocol}//${url.hostname}/*`];
  return [
    `// @match        ${url.protocol}//${url.hostname}/*`,
    `// @include      ${origin}/*`,
  ];
}

const banner = [
  '// ==UserScript==',
  '// @name         Silent Feed Bridge',
  '// @namespace    https://github.com/silent-feed',
  `// @version      ${pkg.version}.${stamp}`,
  '// @description  Lets the Silent Feed app read X through your own logged-in browser session.',
  '// @author       you',
  '// @match        https://x.com/*',
  ...appOrigins.flatMap(siteDirectives),
  '// @connect      x.com',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_setValue',
  '// @grant        GM_getValue',
  // Lets the bridge enumerate stored recipes instead of probing a fixed list
  // of operation names, which is what makes renames survivable.
  '// @grant        GM_listValues',
  // Lets the bridge evict a recipe X has stopped accepting, so the harvester
  // relearns it instead of us retrying a dead queryId forever.
  '// @grant        GM_deleteValue',
  // Required to patch the page's real fetch. Assigning to the sandbox's
  // `window` leaves X's own code calling the untouched original.
  '// @grant        unsafeWindow',
  // document-start is load-bearing: the harvester must replace window.fetch
  // before X's own bundle executes, or it sees none of X's requests.
  '// @run-at       document-start',
  '// @noframes',
  // Auto-update only from a domain you have confirmed you own.
  ...(confirmed
    ? [
        `// @updateURL    ${appOrigin}/silentfeed.user.js`,
        `// @downloadURL  ${appOrigin}/silentfeed.user.js`,
      ]
    : []),
  '// ==/UserScript==',
  '',
].join('\n');

const outfile = resolve(root, 'public/silentfeed.user.js');
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  write: false,
  legalComments: 'none',
  define: {
    __APP_ORIGINS__: JSON.stringify(appOrigins),
  },
});

const [output] = result.outputFiles;
writeFileSync(outfile, banner + output.text, 'utf8');

console.log(`userscript -> public/silentfeed.user.js`);
console.log(`  version     ${pkg.version}.${stamp}`);
console.log(`  origin from ${vercelProductionUrl ? 'Vercel (VERCEL_PROJECT_PRODUCTION_URL)' : 'app.config.json'}`);
console.log(`  trusts      ${appOrigins.join(', ')}`);
console.log(`  auto-update ${confirmed ? `${appOrigin}/silentfeed.user.js` : 'off (appOriginConfirmed is false)'}`);
