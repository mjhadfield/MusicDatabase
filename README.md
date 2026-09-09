# Music Database

A personal, visual database linking three sides of a music life:

- **Physical** — vinyl collection (~250 records), via Discogs CSV export
- **Digital** — listening history (~100k scrobbles), via the Last.fm API
- **Live** — gig history (367 setlists), via the Setlist.fm API

Goal: look up a song and see everywhere it shows up — owned on vinyl,
heard live 6 times, full setlists from each show, personal notes — plus
open-ended stats and "rabbit hole" browsing. Eventually: reviews/journal
entries per band/album/song, and Spotify integration (playlists, playback).

## Architecture

**SQLite is the database, full stop.** `data/music.sqlite` (gitignored,
built by the ETL scripts) is the single source of truth, queryable
directly with SQL locally.

The plan for hosting: ship that same `.sqlite` file as a static asset and
query it **in the browser** via `sql.js` (SQLite compiled to WebAssembly).
That means the whole site can live on free static hosting (GitHub Pages) —
no backend, no server costs — while still giving "real SQL" queries like
*"songs heard live ≥5 times that I also own on vinyl"* as simple JOINs
rather than bespoke app logic. Periodic updates happen via a GitHub
Actions cron job that re-runs the ETL scripts, rebuilds the DB, commits it,
and lets Pages redeploy.

See [`schema.sql`](schema.sql) for the full data model. Short version:
canonical `artists` / `albums` / `songs` tables (keyed by MusicBrainz ID
where known — that's what lets the same song matched from Discogs,
Last.fm, and Setlist.fm resolve to *one* row), linked out to
`vinyl_holdings`, `scrobbles`, and `setlists` / `setlist_songs`. Raw pulls
from each source are kept untouched in `staging_*` tables so re-running
matching logic doesn't require re-hitting the APIs. `alias_overrides`
is a manual fixup table for anything automatic name-matching gets wrong.

## Project layout

```
schema.sql              -- the data model (source of truth for structure)
etl/
  init_db.py             -- builds/rebuilds data/music.sqlite from schema.sql
  common.py                -- shared get-or-create matching helpers + .env loading
  discogs_import.py       -- imports a Discogs collection CSV export
  lastfm_pull.py           -- pulls scrobble history from the Last.fm API
  setlistfm_pull.py         -- pulls attended setlists from the Setlist.fm API
  (entity_resolution.py -- coming next)
data/
  raw/                   -- raw exports (gitignored except the sample)
  music.sqlite            -- the actual database (gitignored)
imports/                 -- your real personal exports (gitignored entirely)
site/                    -- frontend (React + sql.js), not started yet
.github/workflows/       -- cron-based refresh automation, not started yet
.env                     -- real API keys (gitignored; see .env.example)
```

## Status

- [x] Schema designed
- [x] Discogs CSV import (naive artist/album matching — good enough to get
      data in the door; MusicBrainz-based entity resolution across all
      three sources is a later pass)
- [x] Last.fm scrobble pull (`etl/lastfm_pull.py` — incremental by default,
      `--full` for a from-scratch history pull; 97,500 scrobbles imported)
- [x] Setlist.fm setlist pull (`etl/setlistfm_pull.py` — always does a full
      re-pull since setlists get edited after the fact and the dataset is
      small; 367 setlists / 4,832 song entries imported, covers resolved
      to their original artist)
- [ ] Entity resolution / MBID matching pass
- [ ] Static frontend (sql.js + GitHub Pages)
- [ ] Stats & drill-down browsing
- [ ] Notes/journal writing UI
- [ ] GitHub Actions cron refresh
- [ ] Spotify integration

## Getting started (current state)

```bash
cp .env.example .env             # then fill in your API keys/username

python3 etl/init_db.py --fresh          # build data/music.sqlite from schema.sql
python3 etl/discogs_import.py imports/your-export.csv   # Discogs collection CSV
python3 etl/lastfm_pull.py --full                        # full scrobble history
python3 etl/lastfm_pull.py                                # later: incremental top-up
python3 etl/setlistfm_pull.py                             # attended setlists (always a full re-pull)
```

To import your real Discogs collection: export it from discogs.com →
Collection → Export → CSV, drop it in `imports/` (gitignored) or
`data/raw/` (also gitignored), and point `discogs_import.py` at it.

Last.fm needs a free API key from last.fm/api/account/create — only a
plain key is required, no OAuth/callback flow, since we only read public
scrobble history.
