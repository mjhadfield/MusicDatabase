/*
 * Music Database frontend.
 *
 * No build step, no framework -- sql.js (SQLite compiled to WASM) loads
 * site/public/music.sqlite (a slim export built by etl/build_public_db.py,
 * with the bulky raw-JSON staging tables stripped out) directly in the
 * browser and every view below is just a SQL query run against it. Hash
 * routing (#/artist/1, #/song/2, ...) keeps navigation linkable and
 * back-button friendly without any router library.
 */

let db;
const app = document.getElementById("app");

// Bumped on every render() so an async enrichment fetch that resolves
// after the user has already navigated elsewhere knows to discard itself
// instead of writing into a page that's no longer showing.
let renderToken = 0;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function query(sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function statCard(kind, value, label, href) {
  return `<a class="stat-card ${kind}" href="${href}"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div></a>`;
}

function renderNotFound(kind) {
  app.innerHTML = `<div class="error-box">${esc(kind)} not found. <a href="#/">Go home</a></div>`;
}

// ---------------------------------------------------------------------
// Theme toggle (light / dark / system, persisted in localStorage)
// ---------------------------------------------------------------------
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    /* ignore */
  }
  applyTheme(stored);

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.dataset.theme || (prefersDark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
    render(); // re-render so any chart currently on screen redraws in the new theme's colors
  });
}

// ---------------------------------------------------------------------
// Small shared helpers for the browse/list pages
// ---------------------------------------------------------------------
function paginationHtml(page, totalPages) {
  return `
    <div class="pagination">
      <button data-action="prev" ${page <= 1 ? "disabled" : ""}>← Prev</button>
      <span>Page ${page.toLocaleString()} of ${totalPages.toLocaleString()}</span>
      <button data-action="next" ${page >= totalPages ? "disabled" : ""}>Next →</button>
    </div>
  `;
}

function wirePagination(state, totalPages, rerender) {
  const prev = app.querySelector('.pagination button[data-action="prev"]');
  const next = app.querySelector('.pagination button[data-action="next"]');
  if (prev) prev.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); rerender(); window.scrollTo(0, 0); });
  if (next) next.addEventListener("click", () => { state.page = Math.min(totalPages, state.page + 1); rerender(); window.scrollTo(0, 0); });
}

function wireSortableHeaders(state, rerender, ascByDefault = []) {
  app.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = ascByDefault.includes(key) ? "asc" : "desc";
      }
      state.page = 1;
      rerender();
    });
  });
}

function wireSearchInput(id, state, rerender) {
  const input = document.getElementById(id);
  if (!input) return;
  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = input.value.trim();
      state.page = 1;
      rerender();
    }, 200);
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function sortHeader(key, label, state, numeric = false) {
  const active = state.sort === key;
  const arrow = active ? `<span class="arrow">${state.dir === "asc" ? "↑" : "↓"}</span>` : "";
  return `<th data-sort="${key}" class="${numeric ? "num " : ""}${active ? "sorted" : ""}">${esc(label)}${arrow}</th>`;
}

// ---------------------------------------------------------------------
// Home: overview stats + a headline chart + jump-in points
// ---------------------------------------------------------------------
function renderHome() {
  const stats = query(`
    SELECT
      (SELECT count(*) FROM artists) AS artists,
      (SELECT count(*) FROM vinyl_holdings) AS vinyl,
      (SELECT count(*) FROM scrobbles) AS scrobbles,
      (SELECT count(*) FROM setlists) AS setlists,
      (SELECT count(*) FROM songs) AS songs,
      (SELECT count(*) FROM venues) AS venues
  `)[0];

  const topArtists = query(`
    SELECT ar.id, ar.name, count(*) AS plays
    FROM scrobbles s JOIN artists ar ON ar.id = s.artist_id
    GROUP BY ar.id ORDER BY plays DESC LIMIT 12
  `);

  const recentVinyl = query(`
    SELECT al.title, ar.name AS artist_name, ar.id AS artist_id, v.date_added, v.format
    FROM vinyl_holdings v
    JOIN albums al ON al.id = v.album_id
    JOIN artists ar ON ar.id = al.artist_id
    WHERE v.date_added IS NOT NULL AND v.date_added != ''
    ORDER BY v.date_added DESC LIMIT 6
  `);

  const scrobblesByYear = query(`
    SELECT strftime('%Y', played_at) AS year, count(*) AS c
    FROM scrobbles GROUP BY year ORDER BY year
  `);

  app.innerHTML = `
    <div class="stat-grid">
      ${statCard("vinyl", stats.vinyl, "Records owned", "#/vinyl")}
      ${statCard("scrobble", stats.scrobbles.toLocaleString(), "Scrobbles", "#/scrobbles")}
      ${statCard("live", stats.setlists, "Shows attended", "#/shows")}
      ${statCard("", stats.artists.toLocaleString(), "Artists", "#/artists")}
      ${statCard("", stats.songs.toLocaleString(), "Songs", "#/scrobbles")}
      ${statCard("", stats.venues, "Venues", "#/shows")}
    </div>

    <div class="section">
      <h2>Listening activity by year</h2>
      <div id="home-chart"></div>
    </div>

    <div class="section">
      <h2>Most played</h2>
      <div class="pill-list">
        ${topArtists.map((a) => `
          <a class="pill" href="#/artist/${a.id}">${esc(a.name)} <span class="count">${a.plays.toLocaleString()}</span></a>
        `).join("")}
      </div>
    </div>

    <div class="section">
      <h2>Recently added to the shelf</h2>
      ${recentVinyl.map((v) => `
        <div class="list-item" onclick="location.hash='#/artist/${v.artist_id}'">
          <div>
            <div class="list-title">${esc(v.title)}</div>
            <div class="list-sub">${esc(v.artist_name)} · ${esc(v.format || "")}</div>
          </div>
          <div class="list-right">${esc((v.date_added || "").slice(0, 10))}</div>
        </div>
      `).join("") || '<div class="subtle">No dated additions yet.</div>'}
    </div>
  `;

  renderBarChart(
    document.getElementById("home-chart"),
    scrobblesByYear.map((r) => ({ label: r.year, value: r.c })),
    { color: "var(--accent-scrobble)" }
  );
}

// ---------------------------------------------------------------------
// Browse: Artists (#/artists) -- searchable, sortable, paginated
// ---------------------------------------------------------------------
const artistsState = { q: "", sort: "scrobbles", dir: "desc", page: 1 };

function renderArtistsBrowse() {
  const st = artistsState;
  const params = [];
  let where = "";
  if (st.q) {
    where = "WHERE ar.name LIKE ? COLLATE NOCASE";
    params.push(`%${st.q}%`);
  }

  const total = query(`SELECT count(*) AS c FROM artists ar ${where}`, params)[0].c;
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  st.page = Math.min(Math.max(1, st.page), totalPages);

  const sortCol = { name: "ar.name", scrobbles: "scrobbles", vinyl: "vinyl_count", shows: "shows" }[st.sort] || "scrobbles";
  const dir = st.dir === "asc" ? "ASC" : "DESC";

  const rows = query(`
    SELECT ar.id, ar.name, ar.mbid,
      (SELECT count(*) FROM scrobbles WHERE artist_id = ar.id) AS scrobbles,
      (SELECT count(DISTINCT v.id) FROM vinyl_holdings v JOIN album_artists aa ON aa.album_id = v.album_id WHERE aa.artist_id = ar.id) AS vinyl_count,
      (SELECT count(*) FROM setlists WHERE artist_id = ar.id) AS shows
    FROM artists ar
    ${where}
    ORDER BY ${sortCol} ${dir}
    LIMIT ${pageSize} OFFSET ${(st.page - 1) * pageSize}
  `, params);

  app.innerHTML = `
    <a class="back-link" href="#/">← Back</a>
    <div class="page-header"><h1>Artists</h1><div class="subtle">${total.toLocaleString()} artists</div></div>
    <div class="filter-bar">
      <input type="text" id="browse-search" placeholder="Search artists…" value="${esc(st.q)}" />
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          ${sortHeader("name", "Artist", st)}
          ${sortHeader("scrobbles", "Scrobbles", st, true)}
          ${sortHeader("vinyl", "Vinyl", st, true)}
          ${sortHeader("shows", "Shows", st, true)}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-id="${r.id}">
              <td class="row-title">${esc(r.name)}</td>
              <td class="num">${r.scrobbles.toLocaleString()}</td>
              <td class="num">${r.vinyl_count}</td>
              <td class="num">${r.shows}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${paginationHtml(st.page, totalPages)}
  `;

  app.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/artist/${tr.dataset.id}`; }));
  wireSortableHeaders(st, renderArtistsBrowse, ["name"]);
  wirePagination(st, totalPages, renderArtistsBrowse);
  wireSearchInput("browse-search", st, renderArtistsBrowse);
}

// ---------------------------------------------------------------------
// Browse: Vinyl (#/vinyl) -- small enough to show in full, with cover art
// ---------------------------------------------------------------------
const vinylState = { q: "", sort: "date_added", dir: "desc" };

function renderVinylBrowse() {
  const st = vinylState;
  const params = [];
  let where = "";
  if (st.q) {
    where = "WHERE al.title LIKE ? COLLATE NOCASE OR ar.name LIKE ? COLLATE NOCASE";
    params.push(`%${st.q}%`, `%${st.q}%`);
  }
  const sortCol = { title: "al.title", artist: "ar.name", year: "al.year", date_added: "v.date_added" }[st.sort] || "v.date_added";
  const dir = st.dir === "asc" ? "ASC" : "DESC";

  const rows = query(`
    SELECT v.id, al.id AS album_id, al.mbid, al.title, al.year, ar.id AS artist_id, ar.name AS artist_name,
           v.format, v.media_condition, v.date_added
    FROM vinyl_holdings v
    JOIN albums al ON al.id = v.album_id
    JOIN artists ar ON ar.id = al.artist_id
    ${where}
    ORDER BY ${sortCol} ${dir} NULLS LAST
  `, params);

  const byYear = query(`
    SELECT substr(date_added, 1, 4) AS year, count(*) AS c
    FROM vinyl_holdings WHERE date_added IS NOT NULL AND date_added != ''
    GROUP BY year ORDER BY year
  `);

  app.innerHTML = `
    <a class="back-link" href="#/">← Back</a>
    <div class="page-header"><h1>Vinyl</h1><div class="subtle">${rows.length.toLocaleString()} records</div></div>
    <div class="section"><h2>Added per year</h2><div id="vinyl-chart"></div></div>
    <div class="filter-bar">
      <input type="text" id="browse-search" placeholder="Search title or artist…" value="${esc(st.q)}" />
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th></th>
          ${sortHeader("title", "Title", st)}
          ${sortHeader("artist", "Artist", st)}
          ${sortHeader("year", "Year", st, true)}
          <th>Format</th>
          <th>Condition</th>
          ${sortHeader("date_added", "Added", st)}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-artist-id="${r.artist_id}">
              <td><img class="cover-thumb" data-mbid="${r.mbid || ""}" alt="" loading="lazy" /></td>
              <td class="row-title">${esc(r.title)}</td>
              <td>${esc(r.artist_name)}</td>
              <td class="num">${r.year || ""}</td>
              <td>${esc(r.format || "")}</td>
              <td>${esc(r.media_condition || "")}</td>
              <td>${esc((r.date_added || "").slice(0, 10))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  app.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/artist/${tr.dataset.artistId}`; }));
  app.querySelectorAll("img.cover-thumb").forEach((img) => attachCoverArt(img, img.dataset.mbid));
  wireSortableHeaders(st, renderVinylBrowse, ["title", "artist"]);
  wireSearchInput("browse-search", st, renderVinylBrowse);

  renderBarChart(document.getElementById("vinyl-chart"), byYear.map((r) => ({ label: r.year, value: r.c })), { color: "var(--accent-vinyl)" });
}

// ---------------------------------------------------------------------
// Browse: Shows attended (#/shows)
// ---------------------------------------------------------------------
const showsState = { q: "", sort: "event_date", dir: "desc" };

function renderShowsBrowse() {
  const st = showsState;
  const params = [];
  let where = "";
  if (st.q) {
    where = "WHERE ar.name LIKE ? COLLATE NOCASE OR ven.name LIKE ? COLLATE NOCASE OR ven.city LIKE ? COLLATE NOCASE";
    params.push(`%${st.q}%`, `%${st.q}%`, `%${st.q}%`);
  }
  const sortCol = { event_date: "sl.event_date", artist: "ar.name", venue: "ven.name" }[st.sort] || "sl.event_date";
  const dir = st.dir === "asc" ? "ASC" : "DESC";

  const rows = query(`
    SELECT sl.id, sl.event_date, ar.id AS artist_id, ar.name AS artist_name,
           ven.name AS venue_name, ven.city, sl.tour_name
    FROM setlists sl
    JOIN artists ar ON ar.id = sl.artist_id
    LEFT JOIN venues ven ON ven.id = sl.venue_id
    ${where}
    ORDER BY ${sortCol} ${dir}
  `, params);

  const byYear = query(`SELECT substr(event_date, 1, 4) AS year, count(*) AS c FROM setlists GROUP BY year ORDER BY year`);

  app.innerHTML = `
    <a class="back-link" href="#/">← Back</a>
    <div class="page-header"><h1>Shows attended</h1><div class="subtle">${rows.length.toLocaleString()} shows</div></div>
    <div class="section"><h2>Shows per year</h2><div id="shows-chart"></div></div>
    <div class="filter-bar">
      <input type="text" id="browse-search" placeholder="Search artist or venue…" value="${esc(st.q)}" />
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          ${sortHeader("event_date", "Date", st)}
          ${sortHeader("artist", "Artist", st)}
          ${sortHeader("venue", "Venue", st)}
          <th>Tour</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-id="${r.id}">
              <td>${esc(r.event_date)}</td>
              <td class="row-title">${esc(r.artist_name)}</td>
              <td>${esc(r.venue_name || "")}${r.city ? `<div class="row-sub">${esc(r.city)}</div>` : ""}</td>
              <td>${esc(r.tour_name || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  app.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/setlist/${tr.dataset.id}`; }));
  wireSortableHeaders(st, renderShowsBrowse, ["artist", "venue"]);
  wireSearchInput("browse-search", st, renderShowsBrowse);

  renderBarChart(document.getElementById("shows-chart"), byYear.map((r) => ({ label: r.year, value: r.c })), { color: "var(--accent-live)" });
}

// ---------------------------------------------------------------------
// Browse: Scrobbles (#/scrobbles) -- the big one, paginated
// ---------------------------------------------------------------------
const scrobblesState = { q: "", sort: "played_at", dir: "desc", page: 1 };

function renderScrobblesBrowse() {
  const st = scrobblesState;
  const params = [];
  let where = "";
  if (st.q) {
    where = "WHERE ar.name LIKE ? COLLATE NOCASE OR so.title LIKE ? COLLATE NOCASE";
    params.push(`%${st.q}%`, `%${st.q}%`);
  }

  const total = query(`
    SELECT count(*) AS c FROM scrobbles s
    JOIN artists ar ON ar.id = s.artist_id
    JOIN songs so ON so.id = s.song_id
    ${where}
  `, params)[0].c;
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  st.page = Math.min(Math.max(1, st.page), totalPages);

  const sortCol = { played_at: "s.played_at", artist: "ar.name", track: "so.title" }[st.sort] || "s.played_at";
  const dir = st.dir === "asc" ? "ASC" : "DESC";

  const rows = query(`
    SELECT s.played_at, ar.id AS artist_id, ar.name AS artist_name, so.id AS song_id, so.title AS track_title
    FROM scrobbles s
    JOIN artists ar ON ar.id = s.artist_id
    JOIN songs so ON so.id = s.song_id
    ${where}
    ORDER BY ${sortCol} ${dir}
    LIMIT ${pageSize} OFFSET ${(st.page - 1) * pageSize}
  `, params);

  const last12Months = query(`
    SELECT strftime('%Y-%m', played_at) AS ym, count(*) AS c
    FROM scrobbles
    WHERE played_at >= strftime('%Y-%m-%d', 'now', '-12 months')
    GROUP BY ym ORDER BY ym
  `);

  app.innerHTML = `
    <a class="back-link" href="#/">← Back</a>
    <div class="page-header"><h1>Scrobbles</h1><div class="subtle">${total.toLocaleString()} plays</div></div>
    <div class="section"><h2>Last 12 months</h2><div id="scrobbles-chart"></div></div>
    <div class="filter-bar">
      <input type="text" id="browse-search" placeholder="Search artist or track…" value="${esc(st.q)}" />
      <div class="filter-count">${total.toLocaleString()} matching</div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          ${sortHeader("played_at", "Played", st)}
          ${sortHeader("artist", "Artist", st)}
          ${sortHeader("track", "Track", st)}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-artist-id="${r.artist_id}" data-song-id="${r.song_id}">
              <td>${esc(r.played_at.replace("T", " ").slice(0, 16))}</td>
              <td>${esc(r.artist_name)}</td>
              <td class="row-title">${esc(r.track_title)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${paginationHtml(st.page, totalPages)}
  `;

  app.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/song/${tr.dataset.songId}`; }));
  wireSortableHeaders(st, renderScrobblesBrowse, ["artist", "track"]);
  wirePagination(st, totalPages, renderScrobblesBrowse);
  wireSearchInput("browse-search", st, renderScrobblesBrowse);

  renderBarChart(document.getElementById("scrobbles-chart"), last12Months.map((r) => ({ label: r.ym.slice(2), value: r.c })), { color: "var(--accent-scrobble)" });
}

// ---------------------------------------------------------------------
// Artist: the hub page -- vinyl owned, most-played songs, shows attended
// ---------------------------------------------------------------------
function renderArtist(id) {
  const artist = query(`SELECT * FROM artists WHERE id = ?`, [id])[0];
  if (!artist) return renderNotFound("Artist");

  const vinylCount = query(`
    SELECT count(*) AS c FROM vinyl_holdings v
    JOIN album_artists aa ON aa.album_id = v.album_id
    WHERE aa.artist_id = ?
  `, [id])[0].c;

  const scrobbleCount = query(`SELECT count(*) AS c FROM scrobbles WHERE artist_id = ?`, [id])[0].c;
  const liveCount = query(`SELECT count(*) AS c FROM setlists WHERE artist_id = ?`, [id])[0].c;

  const topSongs = query(`
    SELECT so.id, so.title, count(*) AS plays
    FROM scrobbles s JOIN songs so ON so.id = s.song_id
    WHERE s.artist_id = ?
    GROUP BY so.id ORDER BY plays DESC LIMIT 10
  `, [id]);
  const maxPlays = topSongs.length ? topSongs[0].plays : 1;

  const vinylRows = query(`
    SELECT DISTINCT al.id AS album_id, al.mbid, al.title, al.year, v.format, v.media_condition
    FROM vinyl_holdings v
    JOIN album_artists aa ON aa.album_id = v.album_id
    JOIN albums al ON al.id = v.album_id
    WHERE aa.artist_id = ?
    ORDER BY al.year
  `, [id]);

  const setlistRows = query(`
    SELECT sl.id, sl.event_date, ven.name AS venue_name, ven.city, sl.tour_name
    FROM setlists sl LEFT JOIN venues ven ON ven.id = sl.venue_id
    WHERE sl.artist_id = ?
    ORDER BY sl.event_date DESC
  `, [id]);

  app.innerHTML = `
    <a class="back-link" href="#/">← Back</a>
    <div class="artist-header">
      <h1>${esc(artist.name)}${artist.mbid ? '<span class="artist-mbid-badge" title="Matched via MusicBrainz">MBID</span>' : ""}</h1>
    </div>
    <div class="badge-row">
      <div class="badge vinyl">${vinylCount} on vinyl</div>
      <div class="badge scrobble">${scrobbleCount.toLocaleString()} scrobbles</div>
      <div class="badge live">Seen live ${liveCount}×</div>
    </div>

    <div id="about-panel"></div>

    ${topSongs.length ? `
      <div class="section">
        <h2>Most played songs</h2>
        ${topSongs.map((s) => `
          <div class="bar-row" onclick="location.hash='#/song/${s.id}'">
            <div>
              <div class="bar-label">${esc(s.title)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${((s.plays / maxPlays) * 100).toFixed(0)}%"></div></div>
            </div>
            <div class="bar-count">${s.plays.toLocaleString()}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}

    ${vinylRows.length ? `
      <div class="section">
        <h2>On the shelf</h2>
        ${vinylRows.map((v) => `
          <div class="vinyl-card">
            <img class="cover-thumb" data-mbid="${v.mbid || ""}" alt="" loading="lazy" />
            <div class="vinyl-body">
              <div class="title">${esc(v.title)}${v.year ? ` <span class="subtle">(${v.year})</span>` : ""}</div>
              <div class="meta">${esc(v.format || "")}${v.media_condition ? " · " + esc(v.media_condition) : ""}</div>
            </div>
          </div>
        `).join("")}
      </div>
    ` : ""}

    ${setlistRows.length ? `
      <div class="section">
        <h2>Shows attended</h2>
        ${setlistRows.map((sl) => `
          <div class="list-item" onclick="location.hash='#/setlist/${sl.id}'">
            <div>
              <div class="list-title">${esc(sl.venue_name || "Unknown venue")}</div>
              <div class="list-sub">${esc(sl.city || "")}${sl.tour_name ? " · " + esc(sl.tour_name) : ""}</div>
            </div>
            <div class="list-right">${esc(sl.event_date)}</div>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;

  app.querySelectorAll("img.cover-thumb").forEach((img) => attachCoverArt(img, img.dataset.mbid));

  // Enrichment is fetched after the rest of the page is already useful --
  // it's supplementary, network-dependent, and shouldn't block or be
  // allowed to clobber a page the user has since navigated away from.
  const token = renderToken;
  const aboutPanel = document.getElementById("about-panel");
  aboutPanel.innerHTML = '<div class="about-skeleton">Loading more about this artist…</div>';
  getArtistEnrichment(artist).then((info) => {
    if (token !== renderToken) return;
    if (!info.extract && !info.tags.length) {
      aboutPanel.innerHTML = "";
      return;
    }
    aboutPanel.innerHTML = `
      <div class="about-panel">
        ${info.thumbnail ? `<img class="about-thumb" src="${esc(info.thumbnail)}" alt="" />` : ""}
        <div>
          ${info.extract ? `<div class="about-text">${esc(info.extract)}</div>` : ""}
          ${info.tags.length ? `<div class="genre-pills">${info.tags.map((t) => `<span class="genre-pill">${esc(t)}</span>`).join("")}</div>` : ""}
          ${info.pageUrl ? `<div class="about-source"><a href="${esc(info.pageUrl)}" target="_blank" rel="noopener">Wikipedia ↗</a></div>` : ""}
        </div>
      </div>
    `;
  });
}

// ---------------------------------------------------------------------
// Song: the "rabbit hole" page -- live count, scrobble count, vinyl status
// ---------------------------------------------------------------------
function renderSong(id) {
  const song = query(`
    SELECT so.*, ar.name AS artist_name
    FROM songs so JOIN artists ar ON ar.id = so.artist_id
    WHERE so.id = ?
  `, [id])[0];
  if (!song) return renderNotFound("Song");

  const scrobbleCount = query(`SELECT count(*) AS c FROM scrobbles WHERE song_id = ?`, [id])[0].c;

  const liveRows = query(`
    SELECT ss.is_cover, ss.cover_of_artist_text, sl.id AS setlist_id, sl.event_date,
           ven.name AS venue_name, ven.city, perf.name AS performer_name
    FROM setlist_songs ss
    JOIN setlists sl ON sl.id = ss.setlist_id
    JOIN artists perf ON perf.id = sl.artist_id
    LEFT JOIN venues ven ON ven.id = sl.venue_id
    WHERE ss.song_id = ?
    ORDER BY sl.event_date DESC
  `, [id]);

  const onVinyl = song.album_id
    ? query(`SELECT 1 FROM vinyl_holdings WHERE album_id = ? LIMIT 1`, [song.album_id]).length > 0
    : false;

  app.innerHTML = `
    <a class="back-link" href="#/artist/${song.artist_id}">← ${esc(song.artist_name)}</a>
    <h1>${esc(song.title)}</h1>
    <div class="subtle">${esc(song.artist_name)}</div>

    <div class="badge-row">
      <div class="badge vinyl">${onVinyl ? "Owned on vinyl" : "Not on vinyl"}</div>
      <div class="badge scrobble">${scrobbleCount.toLocaleString()} scrobbles</div>
      <div class="badge live">Heard live ${liveRows.length}×</div>
    </div>

    ${liveRows.length ? `
      <div class="section">
        <h2>Live performances</h2>
        ${liveRows.map((r) => `
          <div class="list-item" onclick="location.hash='#/setlist/${r.setlist_id}'">
            <div>
              <div class="list-title">${esc(r.venue_name || "Unknown venue")}</div>
              <div class="list-sub">
                ${esc(r.city || "")}
                ${r.is_cover ? ` · cover, originally ${esc(r.cover_of_artist_text || "")}` : ""}
                ${r.performer_name !== song.artist_name ? ` · performed by ${esc(r.performer_name)}` : ""}
              </div>
            </div>
            <div class="list-right">${esc(r.event_date)}</div>
          </div>
        `).join("")}
      </div>
    ` : '<div class="section subtle">Never heard live (yet).</div>'}
  `;
}

// ---------------------------------------------------------------------
// Setlist: full show detail
// ---------------------------------------------------------------------
function renderSetlist(id) {
  const setlist = query(`
    SELECT sl.*, ar.name AS artist_name, ven.name AS venue_name, ven.city, ven.country
    FROM setlists sl
    JOIN artists ar ON ar.id = sl.artist_id
    LEFT JOIN venues ven ON ven.id = sl.venue_id
    WHERE sl.id = ?
  `, [id])[0];
  if (!setlist) return renderNotFound("Setlist");

  const songs = query(`
    SELECT ss.*, so.title
    FROM setlist_songs ss JOIN songs so ON so.id = ss.song_id
    WHERE ss.setlist_id = ?
    ORDER BY ss.position
  `, [id]);

  let lastSetName = Symbol("unset");
  const songsHtml = songs.map((s) => {
    let header = "";
    if (s.set_name !== lastSetName) {
      header = `<div class="set-name-label">${esc(s.set_name || "Set")}</div>`;
      lastSetName = s.set_name;
    }
    return `
      ${header}
      <div class="setlist-song-row" onclick="location.hash='#/song/${s.song_id}'">
        <div class="pos">${s.position}.</div>
        <div>${esc(s.title)} ${s.is_cover ? `<span class="cover-tag">cover of ${esc(s.cover_of_artist_text || "")}</span>` : ""}</div>
      </div>
    `;
  }).join("");

  app.innerHTML = `
    <a class="back-link" href="#/artist/${setlist.artist_id}">← ${esc(setlist.artist_name)}</a>
    <h1>${esc(setlist.artist_name)}</h1>
    <div class="subtle">
      ${esc(setlist.event_date)} · ${esc(setlist.venue_name || "Unknown venue")}${setlist.city ? ", " + esc(setlist.city) : ""}
      ${setlist.tour_name ? " · " + esc(setlist.tour_name) : ""}
    </div>
    <div class="setlist-songs">${songsHtml || '<div class="subtle">No songs recorded for this setlist.</div>'}</div>
  `;
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------
function render() {
  renderToken += 1;
  const hash = location.hash || "#/";
  const artistMatch = hash.match(/^#\/artist\/(\d+)/);
  const songMatch = hash.match(/^#\/song\/(\d+)/);
  const setlistMatch = hash.match(/^#\/setlist\/(\d+)/);
  if (artistMatch) return renderArtist(Number(artistMatch[1]));
  if (songMatch) return renderSong(Number(songMatch[1]));
  if (setlistMatch) return renderSetlist(Number(setlistMatch[1]));
  if (hash.startsWith("#/artists")) return renderArtistsBrowse();
  if (hash.startsWith("#/vinyl")) return renderVinylBrowse();
  if (hash.startsWith("#/shows")) return renderShowsBrowse();
  if (hash.startsWith("#/scrobbles")) return renderScrobblesBrowse();
  return renderHome();
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------
function setupSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const term = input.value.trim();
    if (!term) {
      results.hidden = true;
      return;
    }
    const rows = query(`
      SELECT ar.id, ar.name,
        (SELECT count(*) FROM scrobbles WHERE artist_id = ar.id) AS scrobbles,
        (SELECT count(*) FROM setlists WHERE artist_id = ar.id) AS shows
      FROM artists ar
      WHERE ar.name LIKE ? COLLATE NOCASE
      ORDER BY scrobbles DESC LIMIT 15
    `, [`%${term}%`]);

    results.innerHTML = rows.length
      ? rows.map((r) => `
          <div class="search-result-row" data-id="${r.id}">
            <span>${esc(r.name)}</span>
            <span class="meta">${r.scrobbles.toLocaleString()} plays · ${r.shows} shows</span>
          </div>
        `).join("")
      : '<div class="search-result-row"><span class="meta">No matches</span></div>';
    results.hidden = false;
  });

  results.addEventListener("click", (e) => {
    const row = e.target.closest(".search-result-row");
    if (row && row.dataset.id) {
      location.hash = `#/artist/${row.dataset.id}`;
      results.hidden = true;
      input.value = "";
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) results.hidden = true;
  });
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
  initTheme();
  try {
    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${file}`,
    });
    const resp = await fetch("public/music.sqlite");
    if (!resp.ok) throw new Error(`Fetching database failed: HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    db = new SQL.Database(new Uint8Array(buffer));

    document.getElementById("footer-status").textContent =
      `Database loaded (${(buffer.byteLength / 1e6).toFixed(1)} MB), queried entirely in your browser.`;

    setupSearch();
    window.addEventListener("hashchange", render);
    render();
  } catch (err) {
    app.innerHTML = `<div class="error-box">Couldn't load the database.<br><span class="subtle">${esc(err.message)}</span></div>`;
    console.error(err);
  }
}

boot();
