# HarmReduce

A single-page harm-reduction toolkit. Drug interaction checker, dose log, inventory, taper scheduler, drug library, friend-shared inventory, realtime chat, and a daily-rate-limited bulletin board.

> **Not medical advice.** This is an educational / harm-reduction tool. Information is best-effort, sourced from public databases (TripSit, openFDA), and may be incomplete or out of date. Cross-reference anything that matters. Be careful out there.

## Features

| View | What it does |
|---|---|
| Drug Interaction Checker | Pairwise check against TripSit's combos DB (local) + openFDA drug labels (live). |
| Taper Scheduler | Generate a linear step-down schedule for a substance. |
| Drug Library | Browse TripSit's full DB: dose ranges by route, timing, harm-reduction notes, combos, links. |
| Inventory | Track what you have. Optionally sync to cloud so accepted friends can view it. |
| Dose Entry | One log for doses AND notes. Doses can deduct from inventory automatically. Editable. |
| Bulletin Board | Shared posts between signed-in users. Rate-limited (30s cooldown, 10/day) with a rolling 200-post cap. |
| Account & Friends | Anonymous handle accounts, friend graph (request / accept / remove). |
| Chat | Realtime 1:1 messaging with accepted friends. |

Everything works **offline / local-only** without setting up the cloud. Sign-in-required views (Friends, Chat, Bulletin Board, friend's inventory) need Supabase configured.

## Tech

- Vanilla JS, no build step. Pure HTML/CSS/JS files.
- `localStorage` for local data.
- [Supabase](https://supabase.com) free tier for auth + Postgres + realtime (optional, for multi-user features).
- TripSit drug database bundled locally (~1.5 MB).
- openFDA public API for FDA drug interaction labels (live, no key).

## Run locally

Just open `index.html` in a browser. No server required, works from `file://`.

## Setup cloud features (optional)

1. Sign up at [supabase.com](https://supabase.com) (free, no card)
2. Create a new project
3. SQL Editor → paste contents of `supabase-schema.sql` → Run
4. Authentication → Sign In / Providers → enable **Anonymous Sign-Ins** → Save
5. Database → Extensions → enable **pg_cron** (for the bulletin post cleanup trigger)
6. Project Settings → API → copy the **Project URL** and **anon key**
7. `cp cloud-config.example.js cloud-config.js` and paste the values in
8. Open `index.html` again — Account & Friends, Chat, and Bulletin Board now work

## Deploy to Netlify

```
1. Push this repo to GitHub
2. netlify.com → New site from Git → pick your repo
3. Build command: (leave blank)
4. Publish directory: . (or /)
5. Deploy
```

After deploying, the URL gets HTTPS automatically. The `_headers` file in this repo configures sensible cache lifetimes.

## Project structure

```
HarmReduce/
  index.html              Skeleton + script loads
  styles.css              Dark theme + layout
  app.js                  All views, router, store wrapper
  cloud.js                Supabase wrapper (auth, friends, chat, bulletin)
  cloud-config.js         (gitignored) Your Supabase URL + anon key
  cloud-config.example.js Template for the above
  tripsit-drugs.js        Bundled TripSit drug DB as a JS global
  supabase-schema.sql     One-time DB setup
  _headers                Netlify cache rules
```

## Data sources

- **TripSit drugs DB** — [github.com/TripSit/drugs](https://github.com/TripSit/drugs) (Creative Commons). Bundled here as `tripsit-drugs.js`; refresh manually when you want newer data.
- **openFDA drug labels** — [open.fda.gov](https://open.fda.gov). Live API, no key, has CORS.

## Privacy / threat model

Cloud-synced data (inventory, friend graph, messages, bulletin posts) lives in **plaintext** on your Supabase project. Supabase admins, a breach, or a subpoena could expose it. Accounts use random handles (no email/PII) — no identity tied to the data, but if you opt to share inventory with friends or post on the bulletin, your handle is visible.

Anonymous accounts have **no recovery**. Clearing your browser data permanently loses the account and its data.

## License

MIT (add a `LICENSE` file with the standard MIT text).
