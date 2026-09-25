/**
 * Single userscript, two personalities. Which one runs is decided by the page
 * it finds itself on - they share Tampermonkey storage, and that shared
 * storage is what carries request recipes from x.com to the app.
 */

import { startBridge } from './bridge';
import { startHarvester } from './harvester';

declare const __APP_ORIGINS__: string[];

const { hostname, origin } = location;

// Unconditional, and first: if this line is missing from the console the
// script was never injected, which is a completely different problem from the
// script running and declining to activate.
console.debug(
  '%c[silent-feed]%c userscript loaded on %s',
  'color:#1d9bf0;font-weight:bold',
  '',
  origin,
);

if (hostname === 'x.com' || hostname === 'www.x.com') {
  startHarvester();
} else if (__APP_ORIGINS__.includes(origin)) {
  startBridge();
} else {
  console.warn(
    `[silent-feed] Running on ${origin}, which is not a trusted app origin. ` +
      `Expected one of: ${__APP_ORIGINS__.join(', ')}. ` +
      'Set appOrigin/devOrigin in app.config.json and rebuild.',
  );
}
