# Silent Feed

A private, chronological feed of people you want to follow **without following
them**. Their posts and replies in one page - no algorithm, no ads, no
recommendations - with a direct link back to the real post whenever you want to
reply.

Runs on your own machine, in your own browser session. No server, no database,
no cost.

---

## Why it is built this way

X cannot be read from a hosted backend. It has blocked datacenter IP ranges
since January 2025, so a Vercel function calling x.com gets a 403 within a
request or two no matter what cookies it sends. The page cannot call x.com
either: CORS blocks it, and the `auth_token` cookie is HttpOnly + SameSite, so
it would never be attached.

So the work is split. **The UI is hosted; the fetching is not.**

```
  your-app.vercel.app                x.com  (any tab, any time)
  static React SPA                   userscript, half two
  feed · search · unread             watches X's own requests and
  alerts · IndexedDB                 records how to reproduce them
          │                                    │
          │ postMessage RPC                    │ GM_setValue
          ▼                                    ▼
  userscript, half one  ◄───────  shared Tampermonkey storage
  GM_xmlhttpRequest → x.com
  (your cookies, your IP)
```

One userscript, two `@match` blocks, one shared storage area.

The **x.com half** watches the requests X's own frontend makes and records a
*recipe* for each: the rotating `queryId`, the bearer token, the required
feature flags, the `ct0` cookie. The **app half** replays those recipes through
`GM_xmlhttpRequest`, which issues the call from your real browser, on your real
IP, with your real cookie jar.

That indirection is what makes it durable. X rotates `queryId` on every
frontend deploy and periodically renames operations outright - `UserTweets`
became `UserOriginalsTimeline` during development. Nothing about those names is
hardcoded: the bridge matches a *shape* of operation, enumerates whatever it
has actually captured, and discards any recipe X starts rejecting so the
harvester relearns it.

**The page never sees your session token.** It asks for an operation by name;
the userscript owns every credential. And the operation allowlist is read-only
by construction - `CreateTweet`, `FollowUser`, `SendDM` and the like cannot
match it, so this tool cannot post, follow, or delete anything even if the page
asked it to.

---

## Deploy to Vercel

The site is fully static - no serverless functions, no cron, no edge
middleware. It fits the Hobby tier with room to spare.

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project**, import the repo, and deploy. Everything is
   preconfigured in `vercel.json`; no build settings or environment variables
   to fill in.
3. Open `https://<your-app>.vercel.app/silentfeed.user.js` and confirm the
   Tampermonkey install prompt.

There is **no post-deploy configuration step**. The build reads
`VERCEL_PROJECT_PRODUCTION_URL`, so the userscript it serves already trusts your
domain and already points `@updateURL` at it - every future deploy updates the
bridge on its own, with no reinstall.

A production build deliberately does **not** trust `localhost`, so nothing you
happen to run on that port can reach your X session through the bridge.

---

## First run

1. **Install [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)**
   (free) in the Chrome profile that has your X account logged in.

2. **Allow user scripts.** Chrome gates this since Tampermonkey moved to
   Manifest V3. Go to `chrome://extensions` → Tampermonkey → **Details** →
   turn on **Allow User Scripts**. If you don't see the toggle, enable
   **Developer mode** first (top right).

   > Skipping this is the single most common failure. Tampermonkey will install
   > and list scripts normally while injecting nothing, anywhere.

3. **Install the bridge** from `/silentfeed.user.js` on your deployed site.

4. **Teach it X's request format.** Open x.com, click into any profile, scroll
   their posts, and open one post. The bridge learns from X's own traffic; it
   cannot work until it has seen each kind of request once.

5. **Add usernames** in the left rail and press **Sync all**.

If anything is missing, **Settings → Connection** shows exactly what has been
captured, what hasn't, and a link that triggers each missing one.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:5173
```

Install the userscript from `http://localhost:5173/silentfeed.user.js`. The dev
build trusts `localhost` and `127.0.0.1` on port 5173 and has auto-update off,
so **reinstall it manually after any change under `userscript/`**. Changes to
`src/` hot-reload as usual.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the userscript, then start Vite |
| `npm run build` | Userscript + typecheck + production build |
| `npm run build:userscript` | Rebuild only the userscript |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

### Layout

```
src/
  bridge/client.ts     page-side RPC to the userscript
  x/                   GraphQL operations, response parsing, domain types
  db/                  IndexedDB schema, queries, local search index
  sync/                concurrency pool, rate-limit guard, keyword alerts
  ui/                  React app
userscript/
  src/harvester.ts     runs on x.com, records request recipes
  src/bridge.ts        runs on the app origin, replays them
  build.mjs            esbuild → public/silentfeed.user.js
shared/protocol.ts     wire contract between page and userscript
```

---

## How it behaves

**Nothing syncs on a timer.** Sync runs when you load the page or press
**Sync all**, never otherwise. There is no alarm, no cron and no service
worker. On load the cached feed paints immediately from IndexedDB, then
accounts older than the staleness window refresh through a bounded concurrency
pool and stream in as they land.

**Request volume is kept low on purpose.** One page of 20 posts per account per
sync, four requests in flight, randomized gaps, a shared rate-limit guard that
pauses every worker when `x-rate-limit-remaining` runs low, and a hard stop on
a rejected session. Comment threads are fetched only when you expand a post, so
they cost nothing while idle.

**Search never touches X.** It runs against your own archive. That is partly
privacy and partly practical: `SearchTimeline` is the one read endpoint that
hard-requires an `x-client-transaction-id`, so not calling it removes the most
fragile dependency in the design.

**Your data is yours.** Posts, read state and alerts live in IndexedDB on your
machine. Removing someone deletes their archived posts and cached threads too.

Known, deliberate behaviour: pinned posts are skipped, since they would float
an old post to the top of a reverse-chron feed on every sync; a post reposted
by two tracked accounts appears twice, matching X; and a newly added alert rule
does not retroactively tag posts already in the archive.

---

## Cost

Zero, with no path to becoming non-zero. There is no payment method attached to
anything, so the worst failure mode is "the feed stops updating", never a bill.

| | |
| --- | --- |
| Vercel Hobby | Static only - no functions, no cron. Personal use qualifies. |
| Data access | Your existing browser session. No API key exists to bill against. |
| Database | None. IndexedDB in your browser. |
| Dependencies | React, Vite, `idb`, `minisearch`, esbuild - all MIT/Apache. |

The official X API is not used: it went pay-per-use in February 2026 with no
free tier, at roughly $180/month for 60 accounts.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Userscript not detected" | **Allow User Scripts** is off in `chrome://extensions` → Tampermonkey → Details. This is nearly always it. |
| "has not learned how X requests timelines yet" | Open a profile on x.com and scroll their posts. See Settings → Connection. |
| "Session expired - open x.com to re-login" | Your `ct0` cookie rotated. Open x.com; the bridge recaptures it. |
| Accounts fail with no obvious reason | Settings → Connection shows every operation the harvester has observed. An empty list means it is not seeing X's traffic at all. |

Both halves log to the console under `[silent-feed:harvest]` and
`[silent-feed:bridge]`.

---

## One caveat

Automated requests from a logged-in account are against X's Terms of Service
and carry some risk to that account. This is built to be gentle - low volume,
human-shaped pacing, a real browser fingerprint, read-only operations - but the
risk is not zero. Point it at an account you can afford to lose.
