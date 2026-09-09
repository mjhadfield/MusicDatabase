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

function statCard(kind, value, label) {
  return `<div class="stat-card ${kind}"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function renderNotFound(kind) {
  app.innerHTML = `<div class="error-box">${esc(kind)} not found. <a href="#/">Go home</a></div>`;
}

// ---------------------------------------------------------------------
// Home: overview stats + jump-in points (top artists, recent additions)
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

  app.innerHTML = `
    <div class="stat-grid">
      ${statCard("vinyl", stats.vinyl, "Records owned")}
      ${statCard("scrobble", stats.scrobbles.toLocaleString(), "Scrobbles")}
      ${statCard("live", stats.setlists, "Shows attended")}
      ${statCard("", stats.artists.toLocaleString(), "Artists")}
      ${statCard("", stats.songs.toLocaleString(), "Songs")}
      ${statCard("", stats.venues, "Venues")}
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
    SELECT DISTINCT al.id AS album_id, al.title, al.year, v.format, v.media_condition
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
            <div class="title">${esc(v.title)}${v.year ? ` <span class="subtle">(${v.year})</span>` : ""}</div>
            <div class="meta">${esc(v.format || "")}${v.media_condition ? " · " + esc(v.media_condition) : ""}</div>
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
  const hash = location.hash || "#/";
  const artistMatch = hash.match(/^#\/artist\/(\d+)/);
  const songMatch = hash.match(/^#\/song\/(\d+)/);
  const setlistMatch = hash.match(/^#\/setlist\/(\d+)/);
  if (artistMatch) return renderArtist(Number(artistMatch[1]));
  if (songMatch) return renderSong(Number(songMatch[1]));
  if (setlistMatch) return renderSetlist(Number(setlistMatch[1]));
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
