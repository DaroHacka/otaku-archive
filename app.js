// ============================================================================
// Otaku Archive — Anime & Manga Archive frontend
// ============================================================================

const API_PORT = window.OTAKU_BACKEND_PORT || 9001;
const API_HOST = (window.location.hostname || "localhost") + ":" + API_PORT;
const API = "http://" + API_HOST;
const STATIC_BASE = "http://" + API_HOST;

function toAbs(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return STATIC_BASE + url;
}

// ---------------- state ----------------
const PEOPLE_PAGE_SIZE = 44;

const state = {
  view: "homepage",
  filters: { category: "all", status: null, genre: null, studio: null, decade: null, letter: null, q: null, sort: "title" },
  listMedia: [],
  listIds: [],
  currentMedia: null,
  currentTab: "overview",
  entries: [],
  credits: [],
  franchises: [],
  collections: [],
  allMediaOptions: [],
  currentFranchise: null,
  currentCollection: null,
  genres: [],
  studios: [],
  years: [],
  stats: null,
  metaCandidates: [],
  assignKind: null,
  bulkMode: "missing",
  peopleFilters: { q: "", letter: null, kind: "all", role: "" },
  peoplePage: 1,
  peopleTotal: 0,
  peoplePageSize: PEOPLE_PAGE_SIZE,
  currentPerson: null,
  collabMode: false,
  collabPicked: [],
  collabPickedInfo: {},
  collabTitles: [],
  collabChars: false,
  collabSharedChars: [],
  peopleById: {},
  creditsSections: { cast: true, staff: true },
  creditFiles: {},
  creditPick: { person: null, va: null },
  personEditFile: null,
  entriesNotesFilter: false,
  musicPath: null,
  musicAlbums: [],
  musicAlbumIdx: 0,
  musicTrackIdx: 0,
  musicInfo: false,
  musicFloating: false,
  musicLoaded: false,
  musicOwnerId: null,
  musicCoverSet: false,
  musicLibrary: [],
  musicLibraryLetter: null,
};

let lastTrailerMsg = "";

// ---------------- helpers ----------------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function toast(msg, isError = false) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle("toast-error", isError);
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const url = API + path;
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    reportAPIError(method + " " + url + " - " + msg);
    throw new Error(msg);
  }
  if (!r.ok) {
    let detail = "Request failed";
    try { detail = (await r.json()).detail || detail; } catch (e) {}
    reportAPIError(method + " " + url + " - " + detail);
    throw new Error(detail);
  }
  clearAPIError();
  if (r.status === 204) return null;
  return r.json();
}

async function uploadFileAs(path, file) {
  const fd = new FormData();
  fd.append("file", file);
  const url = API + path;
  let r;
  try {
    r = await fetch(url, { method: "POST", body: fd });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    reportAPIError("POST " + url + " - " + msg);
    throw new Error(msg);
  }
  if (!r.ok) {
    let detail = "Upload failed";
    try { detail = (await r.json()).detail || detail; } catch (e) {}
    reportAPIError("POST " + url + " - " + detail);
    throw new Error(detail);
  }
  clearAPIError();
  return r.json();
}

function reportAPIError(msg) {
  const b = $("#backend-error");
  if (!b) return;
  const t = $("#backend-error-text");
  if (t) t.textContent = msg;
  b.classList.remove("hidden");
  b.setAttribute("aria-hidden", "false");
}

function clearAPIError() {
  const b = $("#backend-error");
  if (!b) return;
  b.classList.add("hidden");
  b.setAttribute("aria-hidden", "true");
}

function showLoading(on = true) { $("#loading-indicator").classList.toggle("hidden", !on); }
function setStatusBar(msg) { $("#bulk-progress-text").textContent = msg || ""; }

function pastelFor(name) {
  const palettes = [
    ["#ff9ecb", "#ff7bad"], ["#9bd1c2", "#6fc3a8"], ["#c3b6f0", "#a68be0"],
    ["#8fc6f5", "#63a9e8"], ["#ffd9a3", "#ffbe6b"], ["#f7b3c3", "#ef8aa5"],
  ];
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const [c1, c2] = palettes[h % palettes.length];
  return `linear-gradient(160deg, ${c1}, ${c2})`;
}

function placeholderCardHTML(title, cls = "") {
  const letter = (title || "?").trim().charAt(0).toUpperCase();
  return `<div class="card-placeholder" style="background:${pastelFor(title)}"><span class="ph-letter">${esc(letter)}</span></div>`;
}

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function catWord(category) { return category === "manga" ? "ch" : "ep"; }

function addHistoryTitle(m) {
  if (!m || !m.category) return "";
  const kind = m.category === "manga" ? "manga" : "anime";
  const count = m.category === "manga" ? m.chapter_count : m.episode_count;
  return `${kind}${count ? " · " + count + " " + catWord(m.category) : ""}`;
}

function mediaCardHTML(m) {
  const cover = m.cover_url ? `<img class="card-cover" src="${toAbs(m.cover_url)}" alt="${esc(m.title)}" loading="lazy"/>` : placeholderCardHTML(m.title);
  const badges = [];
  if (m.is_favorite) badges.push(`<span class="media-badge badge-fav">★ Fav</span>`);
  if (m.is_watching) badges.push(`<span class="media-badge badge-watching">💖 ${m.category === "manga" ? "Reading" : "Watching"}</span>`);
  else if (m.is_on_hold) badges.push(`<span class="media-badge badge-hold">⏸ Hold</span>`);
  else if (m.is_completed) badges.push(`<span class="media-badge badge-completed">🎉 Done</span>`);
  else if (m.is_dropped) badges.push(`<span class="media-badge badge-dropped">🚫 Dropped</span>`);
  if (m.total_entries > 0) badges.push(`<span class="media-badge progress" style="background:#ffffff88;color:#5a4a75;box-shadow:0 1px 4px rgba(0,0,0,.12)">${m.done_count}/${m.total_entries} ${catWord(m.category)}</span>`);
  const year = m.season_year ? m.season_year : "";
  const type = m.type ? m.type : (m.category === "manga" ? "Manga" : "Anime");
  const score = m.personal_score ? ` · ★${m.personal_score}` : "";
  return `
  <div class="media-card" onclick="openDetail(${m.id})" title="${esc(m.title)}">
    <div class="card-cover-wrap">${cover}
      ${badges.length ? `<div class="card-badges">${badges.join("")}</div>` : ""}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-sub">${esc([type, year, score].filter(Boolean).join(" · "))}</div>
    </div>
  </div>`;
}

function uberCardHTML(m) {
  const cover = m.cover_url ? `<img class="card-cover" src="${toAbs(m.cover_url)}" alt="${esc(m.title)}" loading="lazy"/>` : placeholderCardHTML(m.title);
  const badges = [];
  if (m.is_favorite) badges.push(`<span class="media-badge badge-fav">★ Fav</span>`);
  if (m.is_watching) badges.push(`<span class="media-badge badge-watching">💖 ${m.category === "manga" ? "Reading" : "Watching"}</span>`);
  if (m.is_completed) badges.push(`<span class="media-badge badge-completed">🎉 Done</span>`);
  return `
  <div class="media-card" onclick="openDetail(${m.id})" title="${esc(m.title)}">
    <div class="card-cover-wrap">${cover}${badges.length ? `<div class="card-badges">${badges.join("")}</div>` : ""}</div>
  </div>`;
}

// ---------------- view switching ----------------
const SECTIONS = ["homepage", "list-view", "detail-view", "franchises-list-view", "franchise-detail-view", "collections-list-view", "collection-detail-view", "people-list-view", "people-detail-view", "music-list-view"];

function showView(name) {
  destroyTrailerPlayer();
  SECTIONS.forEach((s) => { $("#" + s).classList.add("hidden"); });
  $("#" + name).classList.remove("hidden");
  state.view = name;
  if (name === "detail-view") window.scrollTo({ top: 0 });
  else window.scrollTo({ top: 0 });
}

function goHome() {
  closeDetail(false);
  showView("homepage");
  loadStats();
}

function getFilterParams() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.category !== "all") p.set("category", f.category);
  if (f.status) p.set("status", f.status);
  if (f.genre) p.set("genre", f.genre);
  if (f.studio) p.set("studio", f.studio);
  if (f.decade) p.set("decade", f.decade);
  if (f.letter) p.set("letter", f.letter);
  if (f.q) p.set("q", f.q);
  p.set("sort", f.sort);
  return p.toString();
}

async function loadMediaList() {
  const f = state.filters;
  showLoading(true);
  let title = "All Titles";
  if (f.q) title = `Search: "${f.q}"`;
  else if (f.status) title = statusLabel(f.status);
  else if (f.category !== "all") title = f.category === "anime" ? "🌸 Anime" : "📖 Manga";
  if (f.genre) title += ` — ${f.genre}`;
  if (f.studio) title += ` — ${f.studio}`;
  if (f.decade) title += ` — '${f.decade}s`;
  $("#list-title").textContent = title;

  let items = [];
  try {
    items = await api("GET", "/api/media?" + getFilterParams());
  } catch (e) {
    toast(e.message, true);
  }
  state.listMedia = items;
  state.listIds = items.map((m) => m.id);
  $("#media-grid").innerHTML = items.length
    ? items.map((m) => mediaCardHTML(m)).join("")
    : `<p class="muted" style="text-align:center;margin:40px 0;">Nothing here yet. Add a title with “+ Add title”.</p>`;
  renderAlphaIndex();
  $("#btn-bulk-fetch").style.display = items.length ? "" : "none";
  showView("list-view");
  showLoading(false);
}

function statusLabel(status) {
  return {
    favorite: "⭐ Favorites",
    watching: "💖 Watching / Reading",
    plan_to_watch: "📌 Plan to Watch / Read",
    completed: "🎉 Completed",
    on_hold: "⏸️ On Hold",
    dropped: "🚫 Dropped",
  }[status] || "All Titles";
}

function renderAlphaIndex() {
  const box = $("#alpha-index");
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "#"];
  box.classList.remove("hidden");
  box.innerHTML = `<button class="${state.filters.letter ? "" : "active"}" onclick="applyLetter(null)">All</button>` +
    letters.map((l) => `<button class="${state.filters.letter === l ? "active" : ""}" onclick="applyLetter('${l}')">${l}</button>`).join("");
}

function applyLetter(l) {
  state.filters.letter = l;
  loadMediaList();
}

function sortMediaList(sort) {
  state.filters.sort = sort;
  loadMediaList();
}

function performSearch() {
  const q = $("#global-search-input").value.trim();
  if (!q) return;
  state.filters = { category: "all", status: null, genre: null, studio: null, decade: null, letter: null, q, sort: state.filters.sort };
  loadMediaList();
}

function selectCategory(cat) {
  state.filters.category = cat;
  state.filters.status = null;
  state.filters.letter = null;
  state.filters.genre = null;
  state.filters.studio = null;
  state.filters.decade = null;
  state.filters.q = null;
  updateCategoryButtons();
  loadMediaList();
}

function applyStatusFilter(status) {
  state.filters.category = "all";
  state.filters.status = status;
  state.filters.letter = null;
  state.filters.genre = null;
  state.filters.studio = null;
  state.filters.decade = null;
  state.filters.q = null;
  setActiveSidebar("status", status);
  loadMediaList();
}

function applyGenre(genre) {
  state.filters.category = "all";
  state.filters.status = null;
  state.filters.genre = genre;
  setActiveSidebarList("genre-list", genre);
  loadMediaList();
}

function applyStudio(studio) {
  state.filters.category = "all";
  state.filters.status = null;
  state.filters.studio = studio;
  setActiveSidebarList("studio-list", studio);
  loadMediaList();
}

function applyDecade(decade) {
  state.filters.category = "all";
  state.filters.status = null;
  state.filters.decade = decade;
  setActiveSidebarList("decade-list", decade);
  loadMediaList();
}

function setActiveSidebar(kind, value) {
  $$(".status-filter-item").forEach((li) => li.classList.toggle("active", li.dataset.status === value));
  if (kind !== "status") $$(".status-filter-item").forEach((li) => li.classList.remove("active"));
}

function setActiveSidebarList(listId, value) {
  $$("#" + listId + " li").forEach((li) => li.classList.toggle("active", li.dataset.value === value));
}

function updateCategoryButtons() {
  $("#cat-anime").classList.toggle("active", state.filters.category === "anime");
  $("#cat-manga").classList.toggle("active", state.filters.category === "manga");
}

// ---------------- sidebar ---------------
function toggleSidebarCollapse() {
  const sb = $("#sidebar");
  if (window.innerWidth <= 768) {
    sb.classList.toggle("open");
    $("#sidebar-backdrop").classList.toggle("open", sb.classList.contains("open"));
  } else {
    sb.classList.toggle("collapsed");
  }
}
function closeSidebarOverlay() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-backdrop").classList.remove("open");
}
function toggleSection(id) {
  const el = $("#" + id);
  el.classList.toggle("hidden");
}

function toggleSidebarSection(listId) {
  const list = $("#" + listId);
  list.classList.toggle("hidden");
  const $listener = list.classList.contains("hidden");
}

// status list toggle
function toggleStatusFilter() {
  const list = $("#status-filter-list");
  list.style.display = list.style.display === "none" ? "" : "none";
}

async function loadFacets() {
  try {
    const [g, s, y] = await Promise.all([
      api("GET", "/api/genres"),
      api("GET", "/api/studios"),
      api("GET", "/api/years"),
    ]);
    state.genres = g; state.studios = s; state.years = y;
    renderFacetLists();
  } catch (e) {}
}

function renderFacetLists() {
  const gl = $("#genre-list");
  gl.innerHTML = state.genres.slice(0, 40).map((x) => `<li data-value="${esc(x.name)}" onclick="applyGenre('${esc(x.name.replace(/'/g, "\\'"))}')"><span>${esc(x.name)}</span><span class="sub-count">${x.count}</span></li>`).join("") +
    (state.genres.length > 40 ? `<li class="more-item">+${state.genres.length - 40} more</li>` : "") || `<li class="more-item">No genres yet</li>`;

  const sl = $("#studio-list");
  sl.innerHTML = state.studios.slice(0, 30).map((x) => `<li data-value="${esc(x.name)}" onclick="applyStudio('${esc(x.name.replace(/'/g, "\\'"))}')"><span>${esc(x.name)}</span><span class="sub-count">${x.count}</span></li>`).join("") +
    (state.studios.length > 30 ? `<li class="more-item">+${state.studios.length - 30} more</li>` : "") || `<li class="more-item">No studios yet</li>`;

  const dl = $("#decade-list");
  const decades = {};
  state.years.forEach((y) => {
    const d = Math.floor(y.year / 10) * 10;
    decades[d] = (decades[d] || 0) + y.count;
  });
  dl.innerHTML = Object.keys(decades).sort((a, b) => b - a).map((d) => `<li data-value="${d}" onclick="applyDecade('${d}')"><span>${d}s</span><span class="sub-count">${decades[d]}</span></li>`).join("") || `<li class="more-item">No years yet</li>`;
}

// ---------------- stats / homepage ----------------
async function loadStats() {
  try {
    const s = await api("GET", "/api/stats");
    state.stats = s;
    $("#stat-anime .stat-number").textContent = s.anime_count;
    $("#stat-manga .stat-number").textContent = s.manga_count;
    $("#stat-completed .stat-number").textContent = s.completed;
    $("#stat-favorites .stat-number").textContent = s.favorites;
    $("#stat-watching .stat-number").textContent = s.watching;
    $("#stat-hours .stat-number").textContent = s.hours_watched || 0;
    $("#count-anime").textContent = s.anime_count;
    $("#count-manga").textContent = s.manga_count;
    $("#count-favorite").textContent = s.favorites;
    $("#count-watching").textContent = s.watching;
    $("#count-plan_to_watch").textContent = s.plan_to_watch;
    $("#count-completed").textContent = s.completed;
    $("#count-on_hold").textContent = s.on_hold;
    $("#count-dropped").textContent = s.dropped;

    const rv = $("#recently-viewed-list");
    rv.innerHTML = s.recently_viewed.length
      ? s.recently_viewed.map((m) => uberCardHTML(m)).join("")
      : `<p class="muted">No recently viewed titles yet.</p>`;

    const la = $("#last-added-list");
    la.innerHTML = s.last_added.length
      ? s.last_added.map((m) => uberCardHTML(m)).join("")
      : `<p class="muted">Nothing added yet — click “+ Add title” to begin.</p>`;

    const fl = $("#home-franchises-list");
    fl.innerHTML = s.franchises.length
      ? s.franchises.map((f) => franchiseCardHTML(f)).join("")
      : `<p class="muted">No franchises yet.</p>`;
  } catch (e) {}
}

function toggleGetStarted() {
  const box = $("#get-started-content");
  box.classList.toggle("hidden");
  $("#get-started-icon").textContent = box.classList.contains("hidden") ? "▶" : "▼";
}

// ---------------- add / edit media ----------------

function openAddMediaModal() {
  $("#add-title-input").value = "";
  $("#add-titles-list").value = "";
  switchAddTab("single");
  toggleModal("#modal-add-media", true);
}
function switchAddTab(tab) {
  $$("#modal-add-media .add-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#add-tab-single").classList.toggle("hidden", tab !== "single");
  $("#add-tab-multi").classList.toggle("hidden", tab !== "multi");
}
function updateAddCategory() {
  const cat = $('input[name="add-category"]:checked').value;
  const single = $("#add-title-input").placeholder = cat === "manga" ? "e.g., Berserk" : "e.g., Cowboy Bebop";
}
async function confirmAddMedia() {
  const cat = $('input[name="add-category"]:checked').value;
  const single = $("#add-title-input").value.trim();
  const multi = $("#add-titles-list").value.split("\n").map((s) => s.trim()).filter(Boolean);
  let titles = single ? [single] : multi;
  if (!titles.length) { toast("Enter at least one title", true); return; }
  showLoading(true);
  try {
    if (titles.length === 1) {
      await api("POST", "/api/media", { category: cat, title: titles[0] });
    } else {
      await api("POST", "/api/media/bulk", { category: cat, titles });
    }
    toast(titles.length > 1 ? `Added ${titles.length} titles` : "Title added");
    toggleModal("#modal-add-media", false);
    state.filters = { category: "all", status: null, genre: null, studio: null, decade: null, letter: null, q: null, sort: state.filters.sort };
    updateCategoryButtons();
    await loadStats();
    await loadFacets();
    if (state.view === "homepage") goHome();
  } catch (e) {
    toast(e.message, true);
  }
  showLoading(false);
}

async function openEditMediaModal() {
  const m = state.currentMedia;
  if (!m) return;
  $("#edit-media-id").value = m.id;
  $("#edit-media-title").value = m.title || "";
  $("#edit-media-alt").value = m.alt_titles || "";
  $("#edit-media-type").value = m.type || "";
  $("#edit-media-year").value = m.season_year || "";
  $("#edit-media-studio").value = m.studio || "";
  $("#edit-media-genres").value = m.genres || "";
  $("#edit-ep-col-label").innerHTML = (m.category === "manga" ? "Chapters" : "Episodes") + ' <input type="number" id="edit-media-episodes" min="0" />';
  $("#edit-media-episodes").value = m.category === "manga" ? m.chapter_count || "" : m.episode_count || "";
  if (m.category === "manga") {
    $("#edit-ep-col-label").classList.remove("hidden");
    $("#edit-media-season-block").classList.add("hidden");
  } else {
    $("#edit-ep-col-label").classList.add("hidden");
    $("#edit-media-season-block").classList.remove("hidden");
    const se = (Array.isArray(m.season_episodes) && m.season_episodes.length) ? m.season_episodes : (m.episode_count ? [m.episode_count] : []);
    setSeasonCounts(se);
  }
  $("#edit-media-duration").value = m.duration || "";
  $("#edit-media-desc").value = m.description || "";
  $("#edit-media-trailer").value = m.trailer_site === "youtube" && m.trailer_id
    ? `https://www.youtube.com/watch?v=${m.trailer_id}` : "";
  toggleModal("#modal-edit-media", true);
}

function setSeasonCounts(counts) {
  counts = (Array.isArray(counts) ? counts : []).map((n) => parseInt(n, 10) || 0);
  if (!counts.length) counts = [0];
  $("#edit-media-seasons").value = Math.max(1, Math.min(99, counts.length));
  seasonCountChanged(counts);
}

function seasonCountChanged(fresh) {
  let n = parseInt($("#edit-media-seasons").value, 10);
  if (isNaN(n) || n < 1) n = 1;
  n = Math.min(99, n);
  const rowsEl = $("#edit-media-season-rows");
  const current = Array.isArray(fresh) ? fresh : [...rowsEl.querySelectorAll(".season-ep-input")].map((i) => parseInt(i.value, 10) || 0);
  let html = "";
  for (let i = 0; i < n; i++) {
    const v = current[i] != null ? current[i] : "";
    html += `<label class="season-row">Season ${String(i + 1).padStart(2, "0")} <input type="number" class="season-ep-input" min="0" value="${v}" oninput="seasonTotalUpdate()" /></label>`;
  }
  rowsEl.innerHTML = html;
  seasonTotalUpdate();
}

function seasonTotalUpdate() {
  const t = $("#edit-media-season-total");
  if (!t) return;
  const tot = [...document.querySelectorAll("#edit-media-season-rows .season-ep-input")].reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
  t.textContent = `Total: ${tot} ${tot === 1 ? "episode" : "episodes"}`;
}

function collectSeasonCounts() {
  return [...document.querySelectorAll("#edit-media-season-rows .season-ep-input")].map((i) => parseInt(i.value, 10) || 0);
}

async function saveEditMedia() {
  const id = $("#edit-media-id").value;
  const m = state.currentMedia;
  const isManga = m.category === "manga";
  const seasonCounts = isManga ? null : collectSeasonCounts();
  const body = {
    category: m.category,
    title: $("#edit-media-title").value.trim(),
    alt_titles: $("#edit-media-alt").value,
    type: $("#edit-media-type").value,
    season_year: parseInt($("#edit-media-year").value) || null,
    episode_count: isManga ? 0 : (seasonCounts ? seasonCounts.reduce((a, b) => a + b, 0) : (parseInt($("#edit-media-episodes").value) || 0)),
    chapter_count: isManga ? (parseInt($("#edit-media-episodes").value) || 0) : 0,
    duration: parseInt($("#edit-media-duration").value) || 0,
    description: $("#edit-media-desc").value,
    studio: $("#edit-media-studio").value,
    genres: $("#edit-media-genres").value,
    trailer_url: $("#edit-media-trailer").value.trim(),
  };
  if (seasonCounts !== null) body.season_counts = seasonCounts;
  showLoading(true);
  try {
    await api("PUT", `/api/media/${id}`, body);
    toast("Saved");
    toggleModal("#modal-edit-media", false);
    await openDetail(id, true);
  } catch (e) { toast(e.message, true); }
  showLoading(false);
}

async function deleteCurrentMedia() {
  const m = state.currentMedia;
  if (!confirm(`Delete "${m.title}" from the archive? This cannot be undone.`)) return;
  try {
    await api("DELETE", `/api/media/${m.id}`);
    toast("Deleted");
    closeDetail(false);
    await loadStats();
    if (state.view === "list-view") await loadMediaList();
    else goHome();
  } catch (e) { toast(e.message, true); }
}

// ---------------- detail view ----------------
async function openDetail(id, force = false) {
  showLoading(true);
  try {
    const m = await api("GET", `/api/media/${id}`);
    state.currentMedia = m;
    if (state.musicOwnerId !== id) {
      state.musicAlbums = [];
      state.musicLoaded = false;
      state.musicAlbumIdx = 0;
      state.musicTrackIdx = 0;
      state.musicInfo = false;
      state.musicCoverSet = false;
    }
    state.musicOwnerId = id;
    if (!state.musicFloating) { const p = $("#music-panel"); if (p && p.parentNode !== $("#music-player")) { $("#music-player").appendChild(p); } }
    $("#list-view").classList.add("hidden");
    showView("detail-view");
    renderDetailSplash();
    switchDetailTab("overview");
    api("POST", `/api/media/${id}/view`).catch(() => {});
    state.currentTab = "overview";
    await Promise.all([loadEntries(), loadCredits(), loadFranchiseTab()]);
    if (state.view === "homepage") {}
  } catch (e) {
    toast(e.message, true);
  }
  showLoading(false);
}

function closeDetail(suppress) {
  state.currentMedia = null;
  state.entries = [];
  state.credits = [];
  updateBrowserUrl("");
}

function renderDetailSplash() {
  const m = state.currentMedia;
  const cover = m.cover_url ? `<img id="detail-cover" src="${toAbs(m.cover_url)}" alt="" />` : `<div id="detail-cover" class="detail-placeholder" style="background:${pastelFor(m.title)};width:100%;aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;font-size:3rem;font-weight:900;color:rgba(255,255,255,.9)">${esc(m.title.charAt(0) || "?")}</div>`;
  $("#detail-cover").outerHTML = cover;

  const splash = $("#detail-splash");
  const bpos = (typeof m.banner_pos === "number" ? m.banner_pos : 50);
  if (m.banner_url) {
    splash.style.backgroundImage = `url(${toAbs(m.banner_url)})`;
    splash.style.backgroundSize = "cover";
    splash.style.backgroundPosition = `center ${bpos}%`;
  } else {
    splash.style.backgroundImage = `url(${toAbs(m.cover_url)}), linear-gradient(135deg,#e5dbff,#ffe3ef)`;
    splash.style.backgroundSize = "cover, cover";
    splash.style.backgroundPosition = `center ${bpos}%, center`;
  }

  $("#detail-title").textContent = m.title;
  $("#detail-alt-titles").textContent = m.alt_titles || "";
  const chips = [];
  if (m.type) chips.push(`<span class="chip">${esc(m.type)}</span>`);
  if (m.category === "manga" ? m.chapter_count : m.episode_count) {
    const n = m.category === "manga" ? m.chapter_count : m.episode_count;
    chips.push(`<span class="chip">${n} ${catWord(m.category)}</span>`);
  }
  if (m.season_year) chips.push(`<span class="chip">${m.season_year}</span>`);
  if (m.season_episodes && m.season_episodes.length) {
    chips.push(`<span class="chip">${m.season_episodes.map((e, i) => "S" + (i + 1) + "·" + e).join(" ")}</span>`);
  }
  if (m.studio) chips.push(`<span class="chip">🏢 ${esc(m.studio)}</span>`);
  if (m.genres) m.genres.split(",").forEach((g) => g.trim() && chips.push(`<span class="chip">${esc(g.trim())}</span>`));
  if (m.trailer_site === "youtube" && m.trailer_id) {
    chips.push(`<span class="chip chip-clickable" onclick="switchDetailTab('overview'); window.setTimeout(()=>watchTrailer(), 50)">▶ Trailer</span>`);
  }
  $("#detail-meta-chips").innerHTML = chips.join("");

  renderTrailer();

  const s = m;
  const pills = [
    ["is_watching", `💖 ${m.category === "manga" ? "Reading" : "Watching"}`],
    ["plan_to_watch", "📌 Plan"],
    ["is_completed", "🎉 Done"],
    ["is_on_hold", "⏸️ Hold"],
    ["is_dropped", "🚫 Dropped"],
    ["is_favorite", "⭐ Fav"],
  ];
  $("#detail-status-row").innerHTML = pills.map(([k, label]) =>
    `<button class="status-pill ${s[k] ? "active" : ""}" onclick="toggleStatus('${k}')">${label}</button>`).join("");

  const score = Math.round(m.personal_score || 0);
  $("#detail-personal").innerHTML = `
    <div><span class="label">MY SCORE</span></div>
    <div class="star-rating" id="star-rating">
      ${[1, 2, 3, 4, 5, 6].map((i) =>
        `<button class="star ${i <= score ? "filled" : ""}" onclick="setStars(${i})" aria-label="${i} star${i > 1 ? "s" : ""}" title="${i} star${i > 1 ? "s" : ""}">${i <= score ? "★" : "☆"}</button>`
      ).join("")}
    </div>
    ${score ? `<span class="star-value">${score}/6</span>` : ""}
    <div style="flex:1"></div>`;
  $("#detail-notes").value = m.notes || "";

  $$(".detail-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.currentTab));
  syncOverviewRows();
  renderDescription(m.description || "");
}

// Match the description box height to the adjacent video preview
function syncOverviewRows() {
  const desc = $("#detail-description");
  const player = $("#trailer-player");
  const row = $("#overview-row");
  if (!desc || !row) return;
  if (player && player.offsetHeight > 0 && !player.closest("#detail-trailer").classList.contains("hidden")) {
    desc.style.minHeight = player.offsetHeight + "px";
    row.classList.add("has-trailer");
  } else {
    desc.style.minHeight = "";
    row.classList.remove("has-trailer");
  }
  paginateDescription();
}

let _resizeTimer = null;
window.addEventListener("resize", () => {
  if (state.view !== "detail") return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(syncOverviewRows, 150);
});

// ---------------- description formatting & paging ----------------

let descBlocks = [];
let descPage = 1;
let descPages = [[]];

function insertFormat(id, before, after) {
  const ta = document.getElementById(id);
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(s, e) || "text";
  ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
  const ns = s + before.length;
  ta.focus();
  ta.selectionStart = ns;
  ta.selectionEnd = ns + sel.length;
}

function mdInline(text) {
  let t = esc(text || "").replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return t;
}

function renderDescription(md) {
  const wrap = $("#desc-page-wrap");
  if (!wrap) return;
  descBlocks = [];
  descPage = 1;
  const raw = (md || "").trim();
  if (raw) {
    for (const part of raw.split(/\n{2,}/)) {
      const p = document.createElement("p");
      p.className = "desc-block";
      p.innerHTML = mdInline(part) || "&nbsp;";
      descBlocks.push(p);
    }
  }
  paginateDescription();
}

function paginateDescription() {
  const wrap = $("#desc-page-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!descBlocks.length) {
    descPages = [[]];
    descPage = 1;
    updateDescNav();
    return;
  }
  let available = wrap.clientHeight - 36;
  if (available < 80) {
    descPages = [descBlocks.map((_, i) => i)];
    descPage = 1;
    renderDescPage();
    updateDescNav();
    return;
  }
  const heights = descBlocks.map((b) => {
    wrap.appendChild(b);
    const h = b.offsetHeight;
    wrap.removeChild(b);
    return h;
  });
  const pages = [];
  let cur = [];
  let curH = 0;
  for (let i = 0; i < descBlocks.length; i++) {
    const h = heights[i];
    if (cur.length && curH + h > available) {
      pages.push(cur);
      cur = [];
      curH = 0;
    }
    cur.push(i);
    curH += h;
  }
  if (cur.length) pages.push(cur);
  descPages = pages;
  if (descPage > descPages.length) descPage = 1;
  renderDescPage();
  updateDescNav();
}

function renderDescPage() {
  const wrap = $("#desc-page-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const i of descPages[descPage - 1] || []) {
    const b = typeof i === "number" ? descBlocks[i] : i;
    if (b) wrap.appendChild(b);
  }
}

function updateDescNav() {
  const nav = $("#desc-pagenav");
  if (!nav) return;
  if (descPages.length <= 1) { nav.classList.add("hidden"); return; }
  nav.classList.remove("hidden");
  $("#desc-page-indicator").textContent = `${descPage}/${descPages.length}`;
  $("#desc-pager-prev").disabled = descPage <= 1;
  $("#desc-pager-next").disabled = descPage >= descPages.length;
}

function descGoPage(delta) {
  descPage = Math.max(1, Math.min(descPages.length, descPage + delta));
  renderDescPage();
  updateDescNav();
}

// ---------------- gallery ----------------
const GALLERY_PER_PAGE = 24;
let galleryImages = [];
let galleryPage = 1;
let galleryPages = [[]];

function galleryOrientation(w, h) {
  const ar = h ? w / h : 1;
  if (ar < 0.85) return "portrait";
  if (ar > 1.15) return "landscape";
  return "square";
}

function galleryAspect(w, h) {
  const o = galleryOrientation(w, h);
  if (o === "landscape") return "3 / 2";
  if (o === "portrait") return `${Math.max(+(w || 1), 1)} / ${Math.max(+(h || 1), 1)}`;
  return "1 / 1";
}

async function renderGallery() {
  const m = state.currentMedia;
  const grid = $("#gallery-grid");
  if (!m || !grid) return;
  galleryImages = [];
  galleryPage = 1;
  try {
    galleryImages = await api("GET", `/api/media/${m.id}/images`);
  } catch (e) { toast(e.message, true); }
  galleryPages = [];
  for (let i = 0; i < galleryImages.length; i += GALLERY_PER_PAGE) {
    galleryPages.push(galleryImages.slice(i, i + GALLERY_PER_PAGE));
  }
  if (!galleryPages.length) galleryPages = [[]];
  renderGalleryPage();
}

function renderGalleryPage() {
  const grid = $("#gallery-grid");
  if (!grid) return;
  const page = galleryPages[galleryPage - 1] || [];
  const empty = $("#gallery-empty");
  if (empty) empty.classList.toggle("hidden", galleryImages.length > 0);
  grid.innerHTML = page.map((g) => {
    const o = galleryOrientation(g.width, g.height);
    return `<div class="gallery-cell ${o}" style="aspect-ratio:${galleryAspect(g.width, g.height)}" onclick="openGalleryLightbox(${g.id})" title="View full size">
      <img src="${toAbs(g.url)}" alt="gallery image" loading="lazy" draggable="false" />
      <span class="gallery-del" onclick="event.stopPropagation(); deleteGalleryImage(${g.id})" title="Remove image">×</span>
    </div>`;
  }).join("");
  updateGalleryNav();
}

function updateGalleryNav() {
  const nav = $("#gallery-pagenav");
  if (!nav) return;
  const total = galleryPages.length;
  nav.classList.toggle("hidden", total <= 1);
  $("#gallery-page-indicator").textContent = `${galleryPage}/${total}`;
  $("#gallery-pager-prev").disabled = galleryPage <= 1;
  $("#gallery-pager-next").disabled = galleryPage >= total;
}

function galleryNav(delta) {
  galleryPage = Math.max(1, Math.min(galleryPages.length, galleryPage + delta));
  renderGalleryPage();
}

function openGalleryModal() {
  $("#gallery-file-input").value = "";
  $("#gallery-url-input").value = "";
  switchGalleryTab("upload");
  toggleModal("#modal-gallery", true);
}

function switchGalleryTab(tab) {
  $("#gallery-tab-upload").classList.toggle("hidden", tab !== "upload");
  $("#gallery-tab-url").classList.toggle("hidden", tab !== "url");
}

async function saveGalleryImages() {
  const m = state.currentMedia;
  if (!m) return;
  const files = $("#gallery-file-input").files;
  const urlText = $("#gallery-url-input").value.trim();
  try {
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const r = await fetch(`${API}/api/media/${m.id}/images`, { method: "POST", body: fd });
      if (!r.ok) {
        let detail = "Upload failed";
        try { detail = (await r.json()).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      await r.json();
      toast("Images added");
    } else if (urlText) {
      const urls = urlText.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!urls.length) { toast("Paste at least one URL", true); return; }
      await api("POST", `/api/media/${m.id}/image-from-url`, { urls });
      toast("Images added");
    } else {
      toast("Choose files or paste URLs", true);
      return;
    }
    toggleModal("#modal-gallery", false);
    renderGallery();
  } catch (e) { toast(e.message, true); }
}

async function deleteGalleryImage(id) {
  const m = state.currentMedia;
  if (!m) return;
  if (!confirm("Remove this image from the gallery?")) return;
  try {
    await api("DELETE", `/api/media/${m.id}/images/${id}`);
    toast("Image removed");
    renderGallery();
  } catch (e) { toast(e.message, true); }
}

function openGalleryLightbox(id) {
  const idx = galleryImages.findIndex((g) => g.id === id);
  if (idx < 0) return;
  openImageLightbox(galleryImages[idx].url, { list: galleryImages, index: idx });
}

// ---------------- trailers ----------------

let ytPlayer = null;
let ytApiReady = false;
const _ytPending = [];
window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  while (_ytPending.length) {
    const cb = _ytPending.shift();
    try { cb(); } catch (e) {}
  }
};

function ensureYtApi(cb) {
  if (window.YT && window.YT.Player) { cb(); return; }
  _ytPending.push(cb);
  if (!document.getElementById("yt-iframe-api")) {
    const s = document.createElement("script");
    s.id = "yt-iframe-api";
    s.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(s);
  }
}

function youtubeThumbUrl(m) {
  return m.trailer_site === "youtube" && m.trailer_id
    ? `https://img.youtube.com/vi/${m.trailer_id}/maxresdefault.jpg` : "";
}

function trailerQualityOptions(sel) {
  return ["1080", "720", "480", "360", "320"].map(
    (q) => `<option value="${q}" ${q === sel ? "selected" : ""}>${q}p</option>`
  ).join("");
}

function renderTrailer() {
  const m = state.currentMedia;
  const box = $("#detail-trailer");
  if (!box) return;
  destroyTrailerPlayer();
  const hasLocal = !!m.trailer_file;
  const hasYt = m.trailer_site === "youtube" && !!m.trailer_id;
  if (!hasLocal && !hasYt) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");

  const quality = localStorage.getItem("otaku.trailerQuality") || "720";
  let inner = "";
  if (hasLocal) {
    inner += `<div class="trailer-player"><video id="trailer-local-video" controls preload="metadata" src="${toAbs(m.trailer_file)}"></video></div>`;
  } else if (hasYt) {
    inner += `<div class="trailer-player" id="trailer-yt-box">
      <div class="trailer-thumb" id="trailer-thumb" style="background-image:url('${youtubeThumbUrl(m)}')">
        <button class="play-overlay" onclick="playYoutubeTrailer('${m.trailer_id}')" aria-label="Play trailer">▶</button>
      </div>
      <div id="trailer-player-host" class="hidden"></div>
      <div id="trailer-fallback" class="trailer-fallback hidden"></div>
    </div>`;
  }

  let actions = `<div class="trailer-actions">`;
  if (hasLocal) {
    actions += `<label class="trailer-quality"><span>Quality</span>
      <select id="trailer-quality" onchange="saveTrailerQuality(this.value)">${trailerQualityOptions(quality)}</select></label>`;
    if (hasYt) {
      actions += `<button class="secondary" onclick="downloadTrailer()">⬇ Replace local copy</button>
      <a class="trailer-online-link" href="https://www.youtube.com/watch?v=${m.trailer_id}" target="_blank" rel="noopener">▶ Watch online instead</a>`;
    }
  } else if (hasYt) {
    actions += `<label class="trailer-quality"><span>Quality</span>
      <select id="trailer-quality" onchange="saveTrailerQuality(this.value)">${trailerQualityOptions(quality)}</select></label>
      <button class="secondary" onclick="downloadTrailer()">⬇ Save to disc</button>
      <a class="trailer-online-link" href="https://www.youtube.com/watch?v=${m.trailer_id}" target="_blank" rel="noopener">▶ Open on YouTube</a>`;
  }
  actions += `<button class="secondary trailer-remove" onclick="removeTrailer(${m.id})">🗑 Remove</button></div>`;
  box.innerHTML = inner + actions;
  syncOverviewRows();
}

function saveTrailerQuality(v) { localStorage.setItem("otaku.trailerQuality", v); }

function pauseTrailer() {
  if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch (e) {} }
  const local = $("#trailer-local-video");
  if (local) { try { local.pause(); } catch (e) {} }
}

function destroyTrailerPlayer() {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch (e) {} ytPlayer = null; }
  const host = $("#trailer-player-host");
  if (host) host.innerHTML = "";
  const local = $("#trailer-local-video");
  if (local) { try { local.pause(); local.removeAttribute("src"); local.load(); } catch (e) {} }
  hideTrailerFallback();
}

function hideTrailerFallback() {
  const fb = $("#trailer-fallback");
  if (fb) { fb.classList.add("hidden"); fb.innerHTML = ""; }
}

function playYoutubeTrailer(videoId) {
  const host = $("#trailer-player-host");
  const thumb = $("#trailer-thumb");
  if (!host || !videoId) return;
  destroyTrailerPlayer();
  if (thumb) thumb.classList.add("hidden");
  host.classList.remove("hidden");
  ensureYtApi(() => {
    const h = $("#trailer-player-host");
    if (!h) return;
    destroyTrailerPlayer();
    ytPlayer = new YT.Player("trailer-player-host", {
      videoId: videoId,
      playerVars: { autoplay: 1, playsinline: 1 },
      events: { onError: (e) => onTrailerPlayerError(e) },
    });
  });
}

function onTrailerPlayerError(e) {
  const codes = {
    2: "Invalid video ID",
    5: "The HTML5 player failed to load",
    100: "The video was removed or is private",
    101: "Embedding has been disabled by the video owner",
    150: "Embedding has been disabled by the video owner",
  };
  const reason = codes[e.data] || "This video cannot be played embedded";
  destroyTrailerPlayer();
  const m = state.currentMedia;
  const host = $("#trailer-player-host");
  const fb = $("#trailer-fallback");
  if (host) host.classList.add("hidden");
  if (!fb) return;
  fb.classList.remove("hidden");
  fb.innerHTML = `
    <b>⚠︎ Trailer can't play embedded</b>
    <div class="trailer-fallback-msg">${esc(reason)} — region-locked or embedding is restricted. Download it to watch locally.</div>
    <div class="trailer-fallback-actions">
      <a href="https://www.youtube.com/watch?v=${m ? m.trailer_id : ""}" target="_blank" rel="noopener">▶ Open on YouTube</a>
      <button onclick="downloadTrailer()">⬇ Save to disc</button>
    </div>`;
}

function watchTrailer() {
  const m = state.currentMedia;
  if (!m) return;
  if (!m.trailer_file && !(m.trailer_site === "youtube" && m.trailer_id)) {
    toast("No trailer yet — add one in Edit or Fetch Metadata.", true);
    return;
  }
  switchDetailTab("overview");
  const box = $("#detail-trailer");
  if (!box) return;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  if (m.trailer_file) {
    const v = document.getElementById("trailer-local-video");
    if (v) v.play().catch(() => {});
  } else {
    playYoutubeTrailer(m.trailer_id);
  }
}

async function removeTrailer(id) {
  if (!confirm("Remove this trailer? A downloaded copy on disc will be deleted too.")) return;
  try {
    await api("DELETE", `/api/media/${id}/trailer`);
    state.currentMedia = await api("GET", `/api/media/${id}`);
    toast("Trailer removed");
    renderDetailSplash();
  } catch (e) { toast(e.message, true); }
}

async function downloadTrailer() {
  const m = state.currentMedia;
  if (!m) return;
  const sel = $("#trailer-quality");
  const q = (sel && sel.value) || localStorage.getItem("otaku.trailerQuality") || "720";
  try {
    const res = await api("POST", `/api/media/${m.id}/download-trailer`, { quality: parseInt(q) });
    if (res.status === "started") { toast("Downloading trailer..."); pollTrailerStatus(m.id); }
    else if (res.status === "busy") toast("A download is already in progress.", true);
  } catch (e) { toast(e.message, true); }
}

async function pollTrailerStatus(id) {
  const deadline = Date.now() + 10 * 60 * 1000;
  lastTrailerMsg = "";
  while (Date.now() < deadline) {
    let st;
    try { st = await api("GET", `/api/media/${id}/trailer-download-status`); }
    catch (e) { return; }
    if (st.state === "running") {
      if (st.msg && st.msg !== lastTrailerMsg) { toast(st.msg); lastTrailerMsg = st.msg; }
    } else if (st.state === "done") {
      toast("Trailer saved to disc ✓");
      state.currentMedia = await api("GET", `/api/media/${id}`);
      renderTrailer();
      return;
    } else if (st.state === "error") {
      toast("Download failed: " + (st.msg || "unknown error"), true);
      return;
    } else {
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function toggleStatus(key) {
  const m = state.currentMedia;
  const body = { [key]: m[key] ? 0 : 1 };
  await api("POST", `/api/media/${m.id}/status`, body);
  m[key] = body[key];
  renderDetailSplash();
  updateCardState();
  loadStats();
}

async function setStars(n) {
  if (!state.currentMedia) return;
  const m = state.currentMedia;
  const val = m.personal_score === n ? null : n;
  await api("POST", `/api/media/${m.id}/status`, { personal_score: val });
  m.personal_score = val;
  renderDetailSplash();
  updateCardState();
  loadStats();
}

async function saveDetailNotes() {
  if (!state.currentMedia) return;
  const v = $("#detail-notes").value;
  await api("POST", `/api/media/${state.currentMedia.id}/status`, { notes: v });
  state.currentMedia.notes = v;
}

function updateCardState() {
  const idx = state.listMedia.findIndex((x) => x.id === state.currentMedia.id);
  if (idx >= 0) state.listMedia[idx] = { ...state.listMedia[idx], ...state.currentMedia };
}

function switchDetailTab(tab) {
  state.currentTab = tab;
  $$(".detail-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  ["overview", "entries", "cast", "franchise", "gallery", "music"].forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== tab));
  if (tab !== "overview") pauseTrailer();
  if (tab === "entries") renderEntries();
  if (tab === "cast") renderCredits();
  if (tab === "franchise") renderFranchiseTab();
  if (tab === "gallery") renderGallery();
  if (tab === "music") loadMusicTab();
  if (tab === "overview") paginateDescription();
}

// ---------------- metadata fetching ----------------
async function fetchMetadataForCurrent() {
  const m = state.currentMedia;
  if (!m) return;
  showLoading(true);
  try {
    const res = await api("POST", `/api/media/${m.id}/fetch-metadata`);
    state.metaCandidates = res.candidates || [];
    if (state.metaCandidates.length === 0) {
      toast("No match found on AniList right now.", true);
    } else if (state.metaCandidates.length === 1) {
      await applyMetaCandidate(state.metaCandidates[0].anilist_id);
    } else {
      renderMetaPicker();
      toggleModal("#modal-meta-picker", true);
    }
  } catch (e) {
    toast(e.message, true);
  }
  showLoading(false);
}

function renderMetaPicker() {
  const list = $("#meta-picker-list");
  list.innerHTML = state.metaCandidates.map((c) => `
    <div class="meta-card" onclick="chooseMetaCandidate(${c.anilist_id})">
      <img class="mc-cover" src="${toAbs(c.cover_url) || 'ico/image.svg'}" alt=""/>
      <div class="mc-body">
        <div class="mc-title">${esc(c.title)}</div>
        <div class="mc-sub">${esc([c.type, c.season_year, c.episode_count ? c.episode_count + " ep" : c.chapter_count ? c.chapter_count + " ch" : ""].filter(Boolean).join(" · "))}</div>
      </div>
    </div>`).join("");
}

async function chooseMetaCandidate(anilistId) {
  toggleModal("#modal-meta-picker", false);
  await applyMetaCandidate(anilistId);
}

async function applyMetaCandidate(anilistId) {
  const m = state.currentMedia;
  showLoading(true);
  try {
    await api("POST", `/api/media/${m.id}/apply-metadata`, { anilist_id: anilistId });
    toast("Metadata applied!");
    await openDetail(m.id, true);
    await loadFacets();
  } catch (e) {
    toast(e.message, true);
  }
  showLoading(false);
}

// ---------------- bulk fetch ----------------
let bulkIds = [];
let bulkAbort = false;

function setBulkMode(mode) { state.bulkMode = mode; }

async function openBulkFetch() {
  if (!state.listMedia.length) return;
  bulkIds = state.listMedia.map((m) => m.id);
  if (state.bulkMode === "missing") {
    bulkIds = state.listMedia.filter((m) => !m.metadata_json).map((m) => m.id);
  }
  $("#bulk-progress-fill").style.width = "0%";
  $("#bulk-progress-text").textContent = "0 / " + bulkIds.length;
  $("#bulk-progress-list").innerHTML = "";
  $("#modal-bulk-fetch .progress-track").style.display = bulkIds.length ? "" : "none";
  if (!bulkIds.length) {
    toast("No titles in this list have missing metadata.");
    return;
  }
  $("#btn-bulk-cancel").classList.remove("hidden");
  $("#btn-bulk-close").classList.add("hidden");
  toggleModal("#modal-bulk-fetch", true);
  bulkAbort = false;
  runBulkFetch();
}

async function runBulkFetch() {
  if (!bulkIds.length) return;
  try {
    const resp = await fetch(API + "/api/media/fetch-metadata/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_ids: bulkIds, mode: state.bulkMode }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneCount = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk.startsWith("data: ")) {
          const msg = JSON.parse(chunk.slice(6));
          if (msg.type === "progress") {
            doneCount = msg.done;
            updateBulkProgress(msg);
          } else if (msg.type === "done") {
            $("#btn-bulk-cancel").classList.add("hidden");
            $("#btn-bulk-close").classList.remove("hidden");
            $("#bulk-progress-text").textContent = `${msg.done} processed${msg.skipped ? ` (${msg.skipped} skipped)` : ""}`;
            finalizeBulk();
            return;
          } else if (msg.type === "cancelled") {
            $("#btn-bulk-cancel").classList.add("hidden");
            $("#btn-bulk-close").classList.remove("hidden");
            finalizeBulk();
            return;
          }
        }
      }
    }
    $("#btn-bulk-cancel").classList.add("hidden");
    $("#btn-bulk-close").classList.remove("hidden");
    finalizeBulk();
  } catch (e) {
    $("#btn-bulk-cancel").classList.add("hidden");
    $("#btn-bulk-close").classList.remove("hidden");
    toast("Bulk fetch interrupted", true);
    finalizeBulk();
  }
}

function updateBulkProgress(msg) {
  const el = $("#bulk-progress-fill");
  el.style.width = Math.round((msg.done / msg.total) * 100) + "%";
  $("#bulk-progress-text").textContent = `${msg.done} / ${msg.total}`;
  const row = document.createElement("div");
  row.className = "bpl-row";
  row.textContent = `${msg.applied ? "✅" : "⬜"} ${msg.title}`;
  $("#bulk-progress-list").prepend(row);
  if (!msg.applied) row.style.color = "#c59bd0";
}

function cancelBulkFetch() { bulkAbort = true; api("POST", "/api/media/fetch-metadata/cancel").catch(() => {}); }

function finalizeBulk() {
  loadMediaList().catch(() => {});
  loadStats().catch(() => {});
  loadFacets().catch(() => {});
}

// ---------------- entries ----------------
async function loadEntries() {
  if (!state.currentMedia) return;
  try { state.entries = await api("GET", `/api/media/${state.currentMedia.id}/entries`); }
  catch (e) { state.entries = []; }
  renderEntries();
}

function allEntriesDone() {
  return state.entries.length > 0 && state.entries.every((e) => e.is_done);
}

function seasonBoundaries(seasonEpisodes) {
  const bounds = [];
  let start = 1;
  (seasonEpisodes || []).forEach((n, i) => {
    if (!n || n <= 0) return;
    bounds.push({ label: `Season ${i + 1}`, start, end: start + n - 1, count: n });
    start += n;
  });
  return bounds;
}

function renderEntries() {
  const m = state.currentMedia;
  const list = $("#entries-list");
  if (!m) return;
  const done = state.entries.filter((e) => e.is_done).length;
  const kind = m.category === "manga" ? "ch" : "ep";
  const noteCount = state.entries.filter(hasNote).length;
  const notesBtn = $("#btn-notes-filter");
  const notesCount = $("#notes-count");
  if (notesBtn) notesBtn.classList.toggle("active", state.entriesNotesFilter);
  if (notesCount) notesCount.textContent = String(noteCount);
  $("#entries-progress").textContent = state.entries.length
    ? `${done} / ${state.entries.length} ${state.entries.length > 1 ? kind + "s" : catWord(m.category)} done`
    : `No entries yet — use “Seed episode list” to create one.`;
  const working = state.entriesNotesFilter ? state.entries.filter(hasNote) : state.entries;
  const bounds = (m.category === "anime" && Array.isArray(m.season_episodes) && m.season_episodes.length)
    ? seasonBoundaries(m.season_episodes)
    : null;
  let groups = [];
  if (bounds && bounds.length) {
    groups = bounds.map((b) => ({
      label: b.label,
      entries: working.filter((e) => e.number >= b.start && e.number <= b.end),
    }));
    const extrasStart = bounds[bounds.length - 1].end + 1;
    const extras = working.filter((e) => e.number >= extrasStart);
    if (extras.length) groups.push({ label: "Extras", entries: extras });
    groups = groups.filter((g) => g.entries.length);
  } else if (working.length) {
    groups = [{ label: "", entries: working }];
  }
  list.innerHTML = groups.map((g) => `
    ${g.label ? `<div class="entry-group-label">${g.label}<span class="muted"> · ${g.entries.length} ${g.entries.length > 1 ? kind + "s" : catWord(m.category)}</span></div>` : ""}
    <div class="entry-grid">${g.entries.map((e) => entryTileHTML(e, kind)).join("")}</div>`).join("")
    || (state.entriesNotesFilter
      ? `<p class="muted">No notes on any ${catWord(m.category)} here yet — tap 📝 on an entry.</p>`
      : `<p class="muted">No entries yet.</p>`);
}

function entryTileHTML(e, kind) {
  const note = hasNote(e);
  return `
  <div class="entry-card ${e.is_done ? "done" : ""} ${note ? "has-note" : ""}" id="entry-${e.id}">
    <div class="entry-card-top">
      <span class="entry-check" onclick="toggleEntry(${e.id})">✓</span>
      <span class="entry-num">${kind}${e.number}</span>
      <button class="entry-notes-btn ${note ? "has-note" : ""}" title="${note ? "Edit note" : "Add note"}" onclick="openEntryNote(${e.id})">📝</button>
    </div>
    ${e.title ? `<div class="entry-title">${esc(e.title)}</div>` : ""}
  </div>`;
}

let entryNoteId = null;

function openEntryNote(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  entryNoteId = id;
  const m = state.currentMedia;
  $("#entry-note-title").textContent = `Notes — ${m.category === "manga" ? "Chapter" : "Episode"} ${e.number}`;
  $("#entry-note-text").value = e.notes || "";
  toggleModal("#modal-entry-notes", true);
}

async function saveEntryNote() {
  const id = entryNoteId;
  if (!id) return;
  const text = ($("#entry-note-text").value || "").trim();
  const e = state.entries.find((x) => x.id === id);
  try {
    await api("PUT", `/api/entries/${id}`, { notes: text });
    if (e) e.notes = text;
    toast(text ? "Note saved" : "Note removed");
    toggleModal("#modal-entry-notes", false);
    renderEntries();
  } catch (err) { toast(err.message, true); }
}

function hasNote(e) {
  return !!(e.notes && e.notes.trim());
}

function toggleNotesFilter() {
  state.entriesNotesFilter = !state.entriesNotesFilter;
  renderEntries();
}

async function toggleEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  try {
    const res = await api("PUT", `/api/entries/${id}`, { is_done: e.is_done ? 0 : 1 });
    e.is_done = res.is_done;
    e.done_at = res.done_at;
    renderEntries();
    if (state.currentMedia && state.currentMedia.total_entries) {
      if (state.view === "detail-view") {}
    }
    loadStats();
  } catch (err) { toast(err.message, true); }
}

async function toggleAllEntries(setDone) {
  for (const e of state.entries.filter((x) => x.is_done !== (setDone ? 1 : 0))) {
    await api("PUT", `/api/entries/${e.id}`, { is_done: setDone ? 1 : 0 });
    e.is_done = setDone ? 1 : 0;
  }
  renderEntries();
  loadStats();
}

function seedEntriesPrompt() {
  const m = state.currentMedia;
  const kind = m.category === "manga" ? "chapters" : "episodes";
  const count = prompt(`How many ${kind}?`, m.category === "manga" ? (m.chapter_count || "12") : (m.episode_count || "12"));
  if (count === null) return;
  const n = parseInt(count);
  if (isNaN(n) || n <= 0) { toast("Invalid count", true); return; }
  (async () => {
    try {
      await api("POST", `/api/media/${m.id}/set-entries-count`, { count: n, kind: catWord(m.category) });
      await loadEntries();
      toast(`${n} ${kind} created`);
    } catch (e) { toast(e.message, true); }
  })();
}

// ---------------- music player ----------------
const MusicAudio = new Audio();
MusicAudio.preload = "metadata";

function musicMedia() {
  return state.currentMedia;
}

function musicOwner() {
  const oid = state.musicOwnerId;
  if (oid != null) return { id: oid };
  return state.currentMedia;
}

async function loadMusicTab() {
  const m = musicMedia();
  if (!m) return;
  state.musicOwnerId = m.id;
  const setup = $("#music-setup");
  const player = $("#music-player");
  if (state.musicLoaded || (state.musicAlbums && state.musicAlbums.length)) {
    player.classList.remove("hidden");
    setup.classList.add("hidden");
    renderMusic();
    return;
  }
  try {
    const res = await api("GET", `/api/media/${musicOwner().id}/music`);
    if (res && res.path) {
      state.musicPath = res.path;
      player.classList.remove("hidden");
      setup.classList.add("hidden");
      await loadMusicAlbums(musicAutoplayPref);
    } else {
      setup.classList.remove("hidden");
      player.classList.add("hidden");
    }
  } catch (e) { toast(e.message, true); }
}

async function saveMusicPath() {
  const input = $("#music-path-input");
  const path = (input.value || "").trim();
  if (!path) { toast("Paste the server folder path first", true); return; }
  if (!musicOwner()) return;
  try {
    const res = await api("PUT", `/api/media/${musicOwner().id}/music`, { path: path });
    if (res && res.path) state.musicPath = res.path;
    toast("Soundtrack linked 🎵");
    $("#music-setup").classList.add("hidden");
    $("#music-player").classList.remove("hidden");
    await loadMusicAlbums(musicAutoplayPref);
  } catch (e) { toast(e.message, true); }
}

async function removeMusicPath() {
  if (!musicOwner()) return;
  try {
    await api("DELETE", `/api/media/${musicOwner().id}/music`);
    state.musicPath = null;
    state.musicAlbums = [];
    state.musicLoaded = false;
    MusicAudio.pause();
    MusicAudio.removeAttribute("src");
    MusicAudio.load();
    toast("Soundtrack unlinked");
    renderMusic();
  } catch (e) { toast(e.message, true); }
}

async function loadMusicAlbums(autoplay) {
  const m = musicOwner();
  if (!m) return;
  try {
    const res = await api("GET", `/api/media/${m.id}/music/albums`);
    if (!res || !res.albums || !res.albums.length) { toast("No albums found in that folder", true); return; }
    state.musicAlbums = res.albums;
    state.musicLoaded = true;
    const keepIdx = Math.min(state.musicAlbumIdx, state.musicAlbums.length - 1);
    state.musicAlbumIdx = keepIdx;
    state.musicTrackIdx = 0;
    renderMusic();
    if (autoplay) playMusicTrack(0);
  } catch (e) { toast(e.message, true); }
}

function currentAlbum() {
  return (state.musicAlbums && state.musicAlbums[state.musicAlbumIdx]) || null;
}

function currentTrack() {
  const a = currentAlbum();
  return (a && a.tracks && a.tracks[state.musicTrackIdx]) || null;
}

function renderMusic() {
  const alb = currentAlbum();
  const m = musicMedia();
  const sel = $("#music-album");
  if (sel && state.musicAlbums.length) {
    sel.innerHTML = state.musicAlbums.map((a, i) => `<option value="${i}">${esc(a.name)} · ${a.tracks.length} tracks</option>`).join("");
    sel.selectedIndex = state.musicAlbumIdx;
  }
  const list = $("#music-tracklist");
  if (list && alb) {
    list.innerHTML = alb.tracks.map((t, i) =>
      `<div class="music-track ${i === state.musicTrackIdx ? "active" : ""}" onclick="playMusicTrack(${i})">
        <span class="music-track-num">${String(t.num).padStart(2, "0")}</span>
        <span class="music-track-title">${esc(t.title)}</span>
      </div>`).join("");
  }
  const cover = $("#music-cover");
  if (cover) {
    if (alb && alb.cover_url) {
      cover.src = toAbs(alb.cover_url);
      cover.style.display = "";
      state.musicCoverSet = true;
    } else if (state.musicCoverSet) {
      cover.style.display = "";
    } else {
      cover.removeAttribute("src");
      cover.style.display = "none";
    }
  }
  updateMusicMarquee();
}

function restartMarquee(el) {
  if (!el) return;
  el.classList.remove("anim");
  void el.offsetWidth;
  if (el.textContent) el.classList.add("anim");
}

function updateMusicMarquee() {
  const el = $("#music-marquee-text");
  if (!el) return;
  const t = currentTrack();
  el.textContent = t ? t.title : "";
  if (el.textContent) el.style.animationDuration = `${Math.max(8, Math.round(el.textContent.length / 3) + 6)}s`;
  restartMarquee(el);
}

function musicSwitchAlbum() {
  const sel = $("#music-album");
  if (!sel) return;
  const i = parseInt(sel.value || "0", 10);
  if (isNaN(i) || !state.musicAlbums[i]) return;
  state.musicAlbumIdx = i;
  state.musicTrackIdx = 0;
  renderMusic();
  playMusicTrack(0);
}

function playMusicTrack(i) {
  const a = currentAlbum();
  if (!a || !a.tracks || !a.tracks[i]) return;
  state.musicTrackIdx = i;
  const t = a.tracks[i];
  renderMusic();
  MusicAudio.src = toAbs(t.url);
  MusicAudio.play().catch(() => toast("Could not play track", true));
  $("#music-play").textContent = "⏸";
}

function toggleMusicPlay() {
  if (!currentTrack()) return;
  if (MusicAudio.paused) {
    if (!MusicAudio.src) {
      playMusicTrack(state.musicTrackIdx);
      return;
    }
    MusicAudio.play().catch(() => toast("Could not play", true));
  } else {
    MusicAudio.pause();
  }
  $("#music-play").textContent = MusicAudio.paused ? "▶" : "⏸";
}

function musicStep(dir) {
  const a = currentAlbum();
  if (!a || !a.tracks.length) return;
  const n = a.tracks.length;
  state.musicTrackIdx = (state.musicTrackIdx + dir + n) % n;
  playMusicTrack(state.musicTrackIdx);
}

function musicSeek(v) {
  if (!MusicAudio.duration || isNaN(MusicAudio.duration)) return;
  MusicAudio.currentTime = (v / 1000) * MusicAudio.duration;
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function toggleMusicInfo() {
  state.musicInfo = !state.musicInfo;
  const box = $("#music-info");
  const btn = $("#music-info-btn");
  const txt = $("#music-info-text");
  if (box) box.classList.toggle("hidden", !state.musicInfo);
  if (btn) btn.classList.toggle("active", state.musicInfo);
  if (txt) {
    txt.textContent = (currentAlbum() && currentAlbum().rel_path) ? currentAlbum().rel_path : "";
    if (txt.textContent) txt.style.animationDuration = `${Math.max(10, Math.round(txt.textContent.length / 3) + 8)}s`;
    restartMarquee(txt);
  }
}

async function toggleMusicFloat() {
  const panel = $("#music-panel");
  const wrap = $("#music-player");
  if (!panel) return;
  if (state.view === "music-list-view") {
    const ownerId = state.musicOwnerId || (musicMedia() && musicMedia().id);
    if (!ownerId) { toast("No soundtrack loaded", true); return; }
    await openDetail(ownerId);
    switchDetailTab("music");
    panel.classList.remove("floating");
    if (wrap) wrap.appendChild(panel);
    state.musicFloating = false;
    $("#btn-music-float").textContent = "⎋ Float";
    return;
  }
  state.musicFloating = !state.musicFloating;
  if (state.musicFloating) {
    document.body.appendChild(panel);
    panel.classList.add("floating");
    $("#btn-music-float").textContent = " Into tab";
  } else {
    panel.classList.remove("floating");
    if (wrap) wrap.appendChild(panel);
    $("#btn-music-float").textContent = "⎋ Float";
  }
}

function closeMusic() {
  MusicAudio.pause();
  MusicAudio.removeAttribute("src");
  MusicAudio.load();
  const panel = $("#music-panel");
  if (panel && state.musicFloating) {
    panel.classList.remove("floating");
    const wrap = $("#music-player");
    if (wrap) wrap.appendChild(panel);
    state.musicFloating = false;
  }
  $("#music-play").textContent = "▶";
  const m = musicMedia();
  if (m && state.currentTab === "music") switchDetailTab("overview");
  else {
    const player = $("#music-player");
    if (player) player.classList.add("hidden");
  }
}

MusicAudio.addEventListener("ended", () => musicStep(1));
MusicAudio.addEventListener("play", () => { const p = $("#music-play"); if (p) p.textContent = "⏸"; });
MusicAudio.addEventListener("pause", () => { const p = $("#music-play"); if (p) p.textContent = "▶"; });
MusicAudio.addEventListener("timeupdate", () => {
  const seek = $("#music-seek");
  const t = $("#music-time");
  if (!seek || !t) return;
  if (!MusicAudio.duration || isNaN(MusicAudio.duration)) { t.textContent = "0:00 / 0:00"; return; }
  seek.value = String(Math.round((MusicAudio.currentTime / MusicAudio.duration) * 1000));
  t.textContent = `${fmtTime(MusicAudio.currentTime)} / ${fmtTime(MusicAudio.duration)}`;
});

// ---------------- volume ----------------
function setMusicVolume(v) {
  const val = Math.max(0, Math.min(1, parseFloat(v) || 0));
  MusicAudio.volume = val;
  try { localStorage.setItem("aa_music_volume", String(val)); } catch (e) {}
}

try {
  const storedVol = parseFloat(localStorage.getItem("aa_music_volume"));
  if (isFinite(storedVol) && storedVol >= 0 && storedVol <= 1) {
    MusicAudio.volume = storedVol;
    const volIn = $("#music-volume");
    if (volIn) volIn.value = String(storedVol);
  }
} catch (e) {}

// ---------------- cover zoom (docked player) ----------------
let musicZoomTimer = null;

function musicZoomCover(on) {
  if (state.musicFloating) return;
  const box = $("#music-cover-box");
  const panel = $("#music-panel");
  if (!box || !panel) return;
  if (!on) {
    box.classList.remove("zoomed");
    box.style.transform = "";
    box.style.transformOrigin = "";
    box.style.borderRadius = "";
    return;
  }
  const pr = panel.getBoundingClientRect();
  const cr = box.getBoundingClientRect();
  const s = Math.max(0.001, Math.min(pr.width / cr.width, pr.height / cr.height));
  const tx = pr.left - cr.left + (pr.width - cr.width * s) / 2;
  const ty = pr.top - cr.top + (pr.height - cr.height * s) / 2;
  box.classList.add("zoomed");
  box.style.transformOrigin = "0 0";
  box.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  box.style.borderRadius = "10px";
}

function musicToggleZoomCover() {
  const box = $("#music-cover-box");
  const zoomed = box && box.classList.contains("zoomed");
  musicZoomCover(!zoomed);
  clearTimeout(musicZoomTimer);
  if (!zoomed && window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
    musicZoomTimer = setTimeout(() => musicZoomCover(false), 5000);
  }
}

// ---------------- music library view ----------------
function musicLetterKey(title) {
  const ch = (title || "?").trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

async function showMusicListView() {
  state.musicLibraryLetter = null;
  renderMusicAlphaIndex();
  try {
    const res = await api("GET", "/api/music/library");
    state.musicLibrary = (res && res.items) || [];
  } catch (e) {
    state.musicLibrary = [];
    toast(e.message, true);
  }
  renderMusicLibraryGrid();
  showView("music-list-view");
}

function renderMusicAlphaIndex() {
  const box = $("#music-alpha-index");
  if (!box) return;
  box.classList.remove("hidden");
  box.innerHTML = `<button class="${state.musicLibraryLetter ? "" : "active"}" onclick="applyMusicLibraryLetter(null)">All</button>` +
    PEOPLE_LETTERS.map((l) => `<button class="${state.musicLibraryLetter === l ? "active" : ""}" onclick="applyMusicLibraryLetter('${l}')">${l}</button>`).join("");
}

function applyMusicLibraryLetter(l) {
  state.musicLibraryLetter = l;
  renderMusicAlphaIndex();
  renderMusicLibraryGrid();
}

function musicLibraryCardHTML(m) {
  const cover = m.cover_url ? `<img class="card-cover" src="${toAbs(m.cover_url)}" alt="${esc(m.title)}" loading="lazy"/>` : placeholderCardHTML(m.title);
  const year = m.season_year ? m.season_year : "";
  const type = m.type ? m.type : (m.category === "manga" ? "Manga" : "Anime");
  return `
  <div class="music-square-card" onclick="playMediaMusic(${m.id})" title="Float the player — ${esc(m.title)}">
    <div class="card-cover-wrap square">${cover}<span class="music-play-overlay">♫</span></div>
    <div class="card-body">
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-sub">${esc([type, year].filter(Boolean).join(" · "))}</div>
    </div>
  </div>`;
}

function renderMusicLibraryGrid() {
  const grid = $("#music-library-grid");
  const count = $("#music-library-count");
  const total = (state.musicLibrary || []).length;
  if (count) count.textContent = total ? `${total} soundtrack${total === 1 ? "" : "s"}` : "";
  let items = state.musicLibrary || [];
  if (state.musicLibraryLetter) items = items.filter((m) => musicLetterKey(m.title) === state.musicLibraryLetter);
  grid.innerHTML = items.length
    ? items.map(musicLibraryCardHTML).join("")
    : `<p class="muted">${state.musicLibraryLetter
        ? "No soundtracks under that letter yet."
        : "No soundtracks linked yet — open any title, go to its ♫ Music tab and paste the server folder path to link it."}</p>`;
}

async function playMediaMusic(id) {
  state.musicOwnerId = id;
  state.musicAlbums = [];
  state.musicLoaded = false;
  state.musicAlbumIdx = 0;
  state.musicTrackIdx = 0;
  state.musicInfo = false;
  state.musicCoverSet = false;
  await loadMusicAlbums(true);
  if (!state.musicFloating) {
    const panel = $("#music-panel");
    if (panel) {
      document.body.appendChild(panel);
      panel.classList.add("floating");
      state.musicFloating = true;
      $("#btn-music-float").textContent = " Into tab";
    }
  }
}

// ---------------- credits ----------------
async function loadCredits() {
  if (!state.currentMedia) return;
  try { state.credits = await api("GET", `/api/media/${state.currentMedia.id}/credits`); }
  catch (e) { state.credits = []; }
  renderCredits();
}

function renderCredits() {
  const staff = state.credits.filter((c) => c.kind === "staff");
  const cast = state.credits.filter((c) => c.kind === "cast");
  $("#staff-grid").innerHTML = staff.length ? staff.map(staffCardHTML).join("") : `<p class="muted">No staff/creators added yet.</p>`;
  $("#cast-grid").innerHTML = cast.length ? renderCastGrid(cast) : `<p class="muted">No characters added yet.</p>`;
  renderCreditSections();
}

function renderCreditSections() {
  const castGrid = $("#cast-grid");
  const staffGrid = $("#staff-grid");
  const castBtn = $('[data-section="cast"] .collapse-btn');
  const staffBtn = $('[data-section="staff"] .collapse-btn');
  castGrid.classList.toggle("hidden", !state.creditsSections.cast);
  if (castBtn) {
    castBtn.classList.toggle("collapsed", !state.creditsSections.cast);
    castBtn.textContent = state.creditsSections.cast ? "▾" : "▸";
    castBtn.setAttribute("aria-expanded", state.creditsSections.cast ? "true" : "false");
  }
  staffGrid.classList.toggle("hidden", !state.creditsSections.staff);
  if (staffBtn) {
    staffBtn.classList.toggle("collapsed", !state.creditsSections.staff);
    staffBtn.textContent = state.creditsSections.staff ? "▾" : "▸";
    staffBtn.setAttribute("aria-expanded", state.creditsSections.staff ? "true" : "false");
  }
}

function toggleCastSection() {
  state.creditsSections.cast = !state.creditsSections.cast;
  renderCreditSections();
}

function toggleStaffSection() {
  state.creditsSections.staff = !state.creditsSections.staff;
  renderCreditSections();
}

function diamondHTML() {
  return `<div class="cast-demarc"><img src="ico/green_diamond.png" alt=""/></div>`;
}

function renderCastGrid(cast) {
  const rows = [];
  const sizes = [5, 4];
  let i = 0;
  let rowIndex = 0;
  while (i < cast.length) {
    const n = sizes[rowIndex % 2];
    const parts = cast.slice(i, i + n).map(castCardHTML);
    rows.push(`<div class="cast-row">${parts.join(diamondHTML())}</div>`);
    i += n;
    rowIndex += 1;
  }
  return rows.join("");
}

function portraitImgHTML(url, posX, posY, letter, cls = "person-portrait") {
  if (url) {
    const x = posX != null ? posX : 50;
    const y = posY != null ? posY : 50;
    return `<div class="${cls}" style="background-image:url('${toAbs(url)}'); background-position:${x}% ${y}%;"></div>`;
  }
  return `<div class="${cls} placeholder" style="background:${pastelFor(letter)}"><span>${esc((letter || "?").charAt(0).toUpperCase())}</span></div>`;
}

function creditActionsHTML(id) {
  return `<div class="person-actions">
    <button onclick="openCreditModal(${id})" title="Edit"><img class="icon-img-sm" src="ico/edit.svg" alt=""/></button>
    <button onclick="deleteCredit(${id})" title="Delete"><img class="icon-img-sm" src="ico/trash.svg" alt=""/></button>
  </div>`;
}

function staffCardHTML(c) {
  return `
  <div class="person-card">
    ${portraitImgHTML(c.image_url, c.image_pos_x, c.image_pos_y, c.name || "?")}
    <div class="person-card-body">
      <h4>${esc(c.name || "?")}</h4>
      <p>${esc(c.role || "Staff")}</p>
    </div>
    ${creditActionsHTML(c.id)}
  </div>`;
}

function castCardHTML(c) {
  // New model: person row = the VA (character lives on the credit).
  // Legacy rows may have stored the character as the person + VA in va_* fields.
  const vaName = c.va_name || c.name || "";
  const vaImg = c.image_url || c.va_image || "";
  const vaPosX = c.image_pos_x != null ? c.image_pos_x : c.va_pos_x;
  const vaPosY = c.image_pos_y != null ? c.image_pos_y : c.va_pos_y;
  const charImg = c.character_image || (c.va_image ? c.image_url : "");
  return `
  <div class="cast-couple">
    <div class="cast-tile">
      ${portraitImgHTML(charImg, c.character_pos_x, c.character_pos_y, c.role || "?")}
      <div class="cast-tile-label">
        <h4>${esc(c.role || "?")}</h4>
        <p>Character</p>
      </div>
    </div>
    <div class="cast-tile">
      ${portraitImgHTML(vaImg, vaPosX, vaPosY, vaName || "?")}
      <div class="cast-tile-label">
        <h4>${esc(vaName || "?")}</h4>
        <p>Voice actor</p>
      </div>
    </div>
    ${creditActionsHTML(c.id)}
  </div>`;
}

// ---------------- credit add / edit modal ----------------
// state: three alignment contexts in the modal: 'person' (staff), 'character', 'va' (cast)
const CREDIT_IMG_IDS = {
  person: { url: "#credit-image", file: "#credit-image-file", align: "#credit-person-align", preview: "#credit-person-preview", x: "#credit-person-pos-x", y: "#credit-person-pos-y", xv: "#credit-person-pos-x-val", yv: "#credit-person-pos-y-val" },
  character: { url: "#credit-char-image", file: "#credit-char-image-file", align: "#credit-character-align", preview: "#credit-character-preview", x: "#credit-character-pos-x", y: "#credit-character-pos-y", xv: "#credit-character-pos-x-val", yv: "#credit-character-pos-y-val" },
  va: { url: "#credit-va-image", file: "#credit-va-image-file", align: "#credit-va-align", preview: "#credit-va-preview", x: "#credit-va-pos-x", y: "#credit-va-pos-y", xv: "#credit-va-pos-x-val", yv: "#credit-va-pos-y-val" },
};

function isRealImageRef(s) {
  return !!s && !s.startsWith("blob:");
}

function creditAlignPreview(which) {
  const ids = CREDIT_IMG_IDS[which];
  if (!ids) return;
  const url = $(ids.url).value.trim();
  const align = $(ids.align);
  const preview = $(ids.preview);
  if (isRealImageRef(url)) {
    align.classList.remove("hidden");
    preview.style.backgroundImage = `url('${toAbs(url)}')`;
  } else if (url.startsWith("blob:")) {
    align.classList.remove("hidden");
    preview.style.backgroundImage = `url('${url}')`;
  } else {
    align.classList.add("hidden");
    preview.style.backgroundImage = "";
  }
  creditAlignPos(which);
}

function creditAlignPos(which) {
  const ids = CREDIT_IMG_IDS[which];
  if (!ids) return;
  const x = $(ids.x).value;
  const y = $(ids.y).value;
  $(ids.xv).textContent = x;
  $(ids.yv).textContent = y;
  $(ids.preview).style.backgroundPosition = `${x}% ${y}%`;
}

function creditFileSelected(which, input) {
  if (!input.files[0]) return;
  state.creditFiles[which] = input.files[0];
  $(CREDIT_IMG_IDS[which].url).value = URL.createObjectURL(input.files[0]);
  creditAlignPreview(which);
}

function openCreditModal(creditId = null) {
  state.editCreditId = creditId;
  state.creditFiles = {};
  state.creditPick = { person: null, va: null };
  const c = creditId ? state.credits.find((x) => x.id === creditId) : null;
  const isCast = !!c && c.kind === "cast";
  $('input[name="credit-kind"][value="' + (isCast ? "cast" : "staff") + '"]').checked = true;

  $("#credit-name").value = c ? (isCast ? "" : (c.name || "")) : "";
  $("#credit-role").value = c ? (isCast ? "" : (c.role || "")) : "";
  $("#credit-image").value = c ? (isCast ? "" : (c.image_url || "")) : "";
  $("#credit-person-id").value = c ? (isCast ? "" : (c.person_id || "")) : "";
  $("#credit-char-name").value = c ? (isCast ? (c.role || "") : "") : "";
  $("#credit-char-image").value = c ? (isCast ? (c.character_image || "") : "") : "";
  $("#credit-va").value = c ? (isCast ? (c.va_name || c.name || "") : "") : "";
  $("#credit-va-person-id").value = c ? (isCast ? (c.va_actor_id || c.person_id || "") : "") : "";
  $("#credit-va-image").value = c ? (isCast ? (c.va_image || c.image_url || "") : "") : "";

  $("#credit-person-pos-x").value = isCast ? 50 : (c && c.image_pos_x != null ? c.image_pos_x : 50);
  $("#credit-person-pos-y").value = isCast ? 50 : (c && c.image_pos_y != null ? c.image_pos_y : 50);
  $("#credit-character-pos-x").value = isCast ? (c && c.character_pos_x != null ? c.character_pos_x : 50) : 50;
  $("#credit-character-pos-y").value = isCast ? (c && c.character_pos_y != null ? c.character_pos_y : 50) : 50;
  $("#credit-va-pos-x").value = isCast ? (c && c.va_pos_x != null ? c.va_pos_x : (c ? c.image_pos_x : 50)) : 50;
  $("#credit-va-pos-y").value = isCast ? (c && c.va_pos_y != null ? c.va_pos_y : (c ? c.image_pos_y : 50)) : 50;

  $("#credit-modal-title").textContent = c ? "Edit Cast / Staff" : "Add Cast / Staff";
  updateCreditKind();
  creditAlignPreview("person");
  creditAlignPreview("character");
  creditAlignPreview("va");
  toggleModal("#modal-credit", true);
}

function updateCreditKind() {
  const cast = $('input[name="credit-kind"]:checked').value === "cast";
  $("#credit-staff-fields").classList.toggle("hidden", cast);
  $("#credit-cast-fields").classList.toggle("hidden", !cast);
}

function closeCreditModal() {
  toggleModal("#modal-credit", false);
  state.editCreditId = null;
  state.creditFiles = {};
  state.creditPick = null;
}

async function saveCredit() {
  const kind = $('input[name="credit-kind"]:checked').value;
  const isCast = kind === "cast";

  if (isCast) {
    if (!$("#credit-char-name").value.trim()) { toast("Character name required", true); return; }
    if (!$("#credit-va").value.trim() && !state.editCreditId) { toast("Voice actor name required", true); return; }
  } else {
    if (!$("#credit-name").value.trim()) { toast("Person name required", true); return; }
  }

  const posOf = (xId, yId) => [parseInt($(xId).value, 10) || 50, parseInt($(yId).value, 10) || 50];
  const personPos = posOf("#credit-person-pos-x", "#credit-person-pos-y");
  const charPos = posOf("#credit-character-pos-x", "#credit-character-pos-y");
  const vaPos = posOf("#credit-va-pos-x", "#credit-va-pos-y");

  try {
    let creditId = null;
    let vaPersonId = null;
    if (state.editCreditId) {
      const c = state.credits.find((x) => x.id === state.editCreditId);
      creditId = c.id;
      const curVaId = c.va_actor_id || c.person_id || null;
      if (isCast) {
        const body = { role: $("#credit-char-name").value.trim(), character_pos_x: charPos[0], character_pos_y: charPos[1] };
        const charImg = $("#credit-char-image").value.trim();
        if (isRealImageRef(charImg)) body.character_image = charImg;
        let newVaId = parseInt($("#credit-va-person-id").value, 10) || null;
        const pick = state.creditPick && state.creditPick.va;
        if (pick) newVaId = pick.id;
        if (newVaId && curVaId && newVaId !== curVaId) body.person_id = newVaId;
        await api("PUT", `/api/credits/${creditId}`, body);
        vaPersonId = newVaId || curVaId;
        const vaName = $("#credit-va").value.trim();
        const curVaName = c.va_name || c.name || "";
        const vaImg = $("#credit-va-image").value.trim();
        const personUpdates = {};
        if (vaName && vaName !== curVaName) personUpdates.name = vaName;
        if (isRealImageRef(vaImg) && vaImg !== (c.va_image || c.image_url || "")) personUpdates.image_url = vaImg;
        personUpdates.image_pos_x = vaPos[0];
        personUpdates.image_pos_y = vaPos[1];
        if (vaPersonId) await api("PUT", `/api/people/${vaPersonId}`, personUpdates);
      } else {
        const body = { role: $("#credit-role").value.trim() };
        await api("PUT", `/api/credits/${creditId}`, body);
        const img = $("#credit-image").value.trim();
        const updates = { name: $("#credit-name").value.trim(), image_pos_x: personPos[0], image_pos_y: personPos[1] };
        if (isRealImageRef(img) && img !== c.image_url) updates.image_url = img;
        await api("PUT", `/api/people/${c.person_id}`, updates);
        vaPersonId = c.person_id;
      }
    } else {
      if (isCast) {
        const pick = state.creditPick && state.creditPick.va;
        const vaName = $("#credit-va").value.trim();
        const haveVaImg = state.creditFiles.va || isRealImageRef($("#credit-va-image").value.trim());
        const body = {
          kind: "cast",
          role: $("#credit-char-name").value.trim(),
          language: "Japanese",
          va_actor_name: vaName,
          character_image: isRealImageRef($("#credit-char-image").value.trim()) ? $("#credit-char-image").value.trim() : "",
          character_pos_x: charPos[0],
          character_pos_y: charPos[1],
        };
        const vaImg = $("#credit-va-image").value.trim();
        if (isRealImageRef(vaImg)) body.image_url = vaImg;
        if (pick || haveVaImg) { body.image_pos_x = vaPos[0]; body.image_pos_y = vaPos[1]; }
        if (pick) body.vo_actor_id = pick.id;
        const res = await api("POST", `/api/media/${state.currentMedia.id}/credits`, body);
        creditId = res.id;
        vaPersonId = res.person_id;
      } else {
        const pick = state.creditPick && state.creditPick.person;
        const haveImg = state.creditFiles.person || isRealImageRef($("#credit-image").value.trim());
        const body = {
          kind: "staff",
          name: $("#credit-name").value.trim(),
          role: $("#credit-role").value.trim(),
          image_url: isRealImageRef($("#credit-image").value.trim()) ? $("#credit-image").value.trim() : "",
        };
        if (pick || haveImg) { body.image_pos_x = personPos[0]; body.image_pos_y = personPos[1]; }
        if (pick) body.person_id = pick.id;
        const res = await api("POST", `/api/media/${state.currentMedia.id}/credits`, body);
        creditId = res.id;
        vaPersonId = res.person_id;
      }
    }

    // second phase: upload any locally-selected files
    if (state.creditFiles) {
      if (state.creditFiles.person && vaPersonId) {
        await uploadFileAs(`/api/people/${vaPersonId}/image`, state.creditFiles.person);
        await api("PUT", `/api/people/${vaPersonId}`, { image_pos_x: personPos[0], image_pos_y: personPos[1] });
      }
      if (isCast && state.creditFiles.character && creditId) {
        await uploadFileAs(`/api/credits/${creditId}/character-image`, state.creditFiles.character);
        await api("PUT", `/api/credits/${creditId}`, { character_pos_x: charPos[0], character_pos_y: charPos[1] });
      }
      if (isCast && state.creditFiles.va && vaPersonId) {
        await uploadFileAs(`/api/people/${vaPersonId}/image`, state.creditFiles.va);
        await api("PUT", `/api/people/${vaPersonId}`, { image_pos_x: vaPos[0], image_pos_y: vaPos[1] });
      }
    }

    await loadCredits();
    toast(isCast ? "Cast member saved" : "Staff saved");
    closeCreditModal();
  } catch (e) { toast(e.message, true); }
}

async function deleteCredit(id) {
  if (!confirm("Remove this credit from this title?")) return;
  try { await api("DELETE", `/api/credits/${id}`); await loadCredits(); }
  catch (e) { toast(e.message, true); }
}

// ---------------- people directory ----------------
const PEOPLE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "#"];

async function showPeopleListView() {
  state.peopleFilters = { q: "", letter: null, kind: "all", role: "" };
  state.collabMode = false;
  state.collabPicked = [];
  state.collabPickedInfo = {};
  state.collabTitles = [];
  state.collabChars = false;
  state.collabSharedChars = [];
  state.peoplePage = 1;
  state.peopleTotal = 0;
  renderCollabPanel();
  renderPeopleAlphaIndex();
  const typeSel = $("#people-type-filter");
  if (typeSel) typeSel.value = "all";
  await renderPeopleRoleOptions();
  await peopleLoad();
  showView("people-list-view");
}

async function renderPeopleRoleOptions() {
  const sel = $("#people-role-filter");
  if (!sel) return;
  sel.innerHTML = '<option value="">Any staff role</option>';
  try {
    const roles = await api("GET", "/api/people/roles");
    for (const r of roles) {
      const opt = document.createElement("option");
      opt.value = r.token;
      opt.textContent = `${r.label} (${r.count})`;
      sel.appendChild(opt);
    }
  } catch (e) {}
  sel.value = state.peopleFilters.role || "";
}

function applyPeopleKind(v) {
  state.peopleFilters.kind = v;
  state.peoplePage = 1;
  refreshPeopleList();
}

function applyPeopleRole(v) {
  state.peopleFilters.role = v;
  state.peoplePage = 1;
  refreshPeopleList();
}

function renderPeopleAlphaIndex() {
  const box = $("#people-alpha-index");
  if (!box) return;
  box.classList.remove("hidden");
  box.innerHTML = `<button class="${state.peopleFilters.letter ? "" : "active"}" onclick="applyPeopleLetter(null)">All</button>` +
    PEOPLE_LETTERS.map((l) => `<button class="${state.peopleFilters.letter === l ? "active" : ""}" onclick="applyPeopleLetter('${l}')">${l}</button>`).join("");
}

function applyPeopleLetter(l) {
  state.peopleFilters.letter = l;
  state.peoplePage = 1;
  renderPeopleAlphaIndex();
  refreshPeopleList();
}

function peopleSearch() {
  state.peopleFilters.q = ($("#people-search-input").value || "").trim();
  state.peopleFilters.letter = null;
  state.peoplePage = 1;
  renderPeopleAlphaIndex();
  refreshPeopleList();
}

function refreshPeopleList() {
  if (state.collabMode && state.collabPicked.length) {
    collabQuery();
  } else {
    peopleLoad();
  }
}

function renderPeoplePagination(noun) {
  const wrap = $("#people-pagination");
  if (!wrap) return;
  const size = state.peoplePageSize || PEOPLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil((state.peopleTotal || 0) / size));
  wrap.classList.toggle("hidden", totalPages <= 1);
  if (totalPages <= 1) return;
  $("#people-page-info").textContent = `Page ${state.peoplePage} of ${totalPages} · ${state.peopleTotal} ${noun || "people"}`;
  $("#people-page-prev").disabled = state.peoplePage <= 1;
  $("#people-page-next").disabled = state.peoplePage >= totalPages;
}

function peopleGoPage(delta) {
  const size = state.peoplePageSize || PEOPLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil((state.peopleTotal || 0) / size));
  const next = Math.min(totalPages, Math.max(1, (state.peoplePage || 1) + delta));
  if (next === (state.peoplePage || 1)) return;
  state.peoplePage = next;
  refreshPeopleList();
}

async function peopleLoad() {
  const params = new URLSearchParams();
  if (state.peopleFilters.q) params.set("q", state.peopleFilters.q);
  if (state.peopleFilters.letter) params.set("letter", state.peopleFilters.letter);
  if (state.peopleFilters.kind && state.peopleFilters.kind !== "all") params.set("kind", state.peopleFilters.kind);
  if (state.peopleFilters.role) params.set("role", state.peopleFilters.role);
  params.set("page", String(state.peoplePage || 1));
  params.set("page_size", String(PEOPLE_PAGE_SIZE));
  let res = { people: [], total: 0, page: 1, page_size: PEOPLE_PAGE_SIZE };
  try { res = await api("GET", "/api/people?" + params.toString()); } catch (e) {}
  const people = res.people || [];
  state.peopleTotal = res.total || 0;
  state.peoplePage = res.page || 1;
  state.peoplePageSize = res.page_size || PEOPLE_PAGE_SIZE;
  state.peopleById = {};
  people.forEach((p) => { state.peopleById[p.id] = p; });
  const grid = $("#people-grid");
  grid.innerHTML = people.length ? people.map((p) => personListCardHTML(p, state.collabMode)).join("") : `<p class="muted">No people found.</p>`;
  renderPeoplePagination("people");
}

function personListCardHTML(p, collab = false) {
  const badges = [];
  if (p.cast_count) badges.push(`🎙 ${p.cast_count} ${p.cast_count === 1 ? "role" : "roles"}`);
  if (p.staff_count) badges.push(`🎨 ${p.staff_count} ${p.staff_count === 1 ? "credit" : "credits"}`);
  if (p.collab_count != null) badges.push(`🤝 ${p.collab_count} ${p.collab_count === 1 ? "title" : "titles"}`);
  const onclick = collab ? `collabPick(${p.id})` : `showPersonDetail(${p.id})`;
  return `
  <div class="person-portrait-card" onclick="${onclick}" title="${collab ? "Add to collaboration" : esc(p.name)}">
    ${collab ? `<span class="collab-badge">➕</span>` : ""}
    ${portraitImgHTML(p.image_url, p.image_pos_x, p.image_pos_y, p.name || "?", "person-portrait")}
    <h4>${esc(p.name)}</h4>
    <p>${badges.join(" · ") || "No credits yet"}</p>
  </div>`;
}

function toggleCollabMode() {
  state.collabMode = !state.collabMode;
  if (!state.collabMode) {
    state.collabPicked = [];
    state.collabPickedInfo = {};
    state.collabTitles = [];
    state.collabChars = false;
  }
  renderCollabPanel();
  refreshPeopleList();
}

function collabReset() {
  state.collabPicked = [];
  state.collabPickedInfo = {};
  state.collabTitles = [];
  state.collabChars = false;
  state.peoplePage = 1;
  renderCollabPanel();
  refreshPeopleList();
}

function collabPick(id) {
  if (state.collabPicked.indexOf(id) >= 0) return;
  state.collabPicked.push(id);
  if (!state.collabPickedInfo[id]) {
    state.collabPickedInfo[id] = state.peopleById[id] || null;
  }
  state.peoplePage = 1;
  collabQuery();
}

function collabUnpick(id) {
  state.collabPicked = state.collabPicked.filter((x) => x !== id);
  delete state.collabPickedInfo[id];
  if (state.collabPicked.length < 2) state.collabChars = false;
  state.peoplePage = 1;
  renderCollabPanel();
  refreshPeopleList();
}

async function collabQuery() {
  const body = { person_ids: state.collabPicked };
  if (state.peopleFilters.q) body.q = state.peopleFilters.q;
  if (state.peopleFilters.letter) body.letter = state.peopleFilters.letter;
  if (state.peopleFilters.kind && state.peopleFilters.kind !== "all") body.kind = state.peopleFilters.kind;
  if (state.peopleFilters.role) body.role = state.peopleFilters.role;
  body.page = state.peoplePage || 1;
  body.page_size = PEOPLE_PAGE_SIZE;
  let res = { people: [], shared_titles: [], total: 0, page: 1, page_size: PEOPLE_PAGE_SIZE };
  try { res = await api("POST", "/api/people/collab", body); } catch (e) { toast(e.message, true); }
  state.collabTitles = res.shared_titles || [];
  state.collabSharedChars = res.shared_characters || [];
  state.peopleTotal = res.total || 0;
  state.peoplePage = res.page || 1;
  state.peoplePageSize = res.page_size || PEOPLE_PAGE_SIZE;
  state.peopleById = {};
  (res.people || []).forEach((p) => { state.peopleById[p.id] = p; });
  const grid = $("#people-grid");
  const people = res.people || [];
  grid.innerHTML = people.length ? people.map((p) => personListCardHTML(p, true)).join("") : `<p class="muted">No further collaborators — this is the full constellation.</p>`;
  renderCollabPanel();
  renderPeoplePagination("collaborators");
}

function renderCollabPanel() {
  const panel = $("#collab-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !state.collabMode);
  const toggle = $("#btn-collab-toggle");
  if (toggle) toggle.classList.toggle("active", state.collabMode);
  const chipsEl = $("#collab-chips");
  if (chipsEl) {
    chipsEl.innerHTML = state.collabPicked.map((id) => {
      const p = state.collabPickedInfo[id];
      const name = p ? p.name : (state.peopleById[id] ? state.peopleById[id].name : "?");
      const img = p ? p.image_url : (state.peopleById[id] ? state.peopleById[id].image_url : "");
      const px = p ? p.image_pos_x : (state.peopleById[id] ? state.peopleById[id].image_pos_x : null);
      const py = p ? p.image_pos_y : (state.peopleById[id] ? state.peopleById[id].image_pos_y : null);
      return `<span class="collab-chip">
        ${portraitImgHTML(img, px, py, name || "?", "person-portrait")}
        ${esc(name || "?")}
        <button onclick="collabUnpick(${id})" title="Remove">✕</button>
      </span>`;
    }).join("");
  }
  const titlesWrap = $("#collab-titles-wrap");
  const titlesEl = $("#collab-titles");
  if (titlesWrap && titlesEl) {
    const hasTitles = !!state.collabTitles.length;
    titlesWrap.classList.toggle("hidden", !hasTitles);
    const showChars = state.collabChars && state.collabPicked.length >= 2;
    titlesEl.className = showChars ? "collab-rows" : "media-grid";
    titlesEl.innerHTML = hasTitles ? state.collabTitles.map((t) => collabTitleCardHTML(t, showChars)).join("") : "";
  }
  const charsBtn = $("#btn-collab-chars");
  if (charsBtn) {
    charsBtn.classList.toggle("hidden", state.collabPicked.length < 2);
    charsBtn.textContent = state.collabChars ? "🙈 Hide characters" : "🎭 Show characters";
  }
}

function toggleCollabChars() {
  state.collabChars = !state.collabChars;
  renderCollabPanel();
}

function collabTitleCardHTML(t, withChars = false) {
  if (withChars) return collabCharRowHTML(t);
  const subs = [t.category, t.season_year].filter(Boolean).join(" · ");
  return `
  <div class="media-card" onclick="openDetail(${t.id})">
    <div class="card-cover-wrap">${t.cover_url ? `<img class="card-cover" src="${toAbs(t.cover_url)}" alt=""/>` : placeholderCardHTML(t.title)}</div>
    <div class="card-body">
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${subs}</div>
    </div>
  </div>`;
}

function collabCharRowHTML(t) {
  const coverSrc = t.cover_url ? `<img class="collab-row-cover" src="${toAbs(t.cover_url)}" alt="${esc(t.title)}" onclick="openDetail(${t.id})"/>` : `<div class="collab-row-cover placeholder" onclick="openDetail(${t.id})" style="background:${pastelFor(t.title)}">${esc((t.title || "?").charAt(0))}</div>`;
  const rows = state.collabSharedChars.filter((c) => c.media_id === t.id);
  const chars = rows.map((c) => {
    const p = state.collabPickedInfo[c.person_id];
    const who = p ? p.name : "?";
    const role = c.role || (c.kind === "staff" ? "staff role" : "character");
    const isStaff = c.kind === "staff";
    const thumb = portraitImgHTML(isStaff ? "" : (c.character_image || ""), c.character_pos_x, c.character_pos_y, role, "collab-char-thumb");
    const tip = isStaff ? `Staff role: ${role}` : `Character: ${role}`;
    return `<div class="collab-char-meta" title="${esc(tip)}">
      ${thumb}
      <span class="collab-char-name">${esc(who)}</span>
      <span class="collab-char-role">${esc(role)}</span>
    </div>`;
  }).join("");
  const titleSub = [t.category, t.season_year].filter(Boolean).join(" · ");
  return `
  <div class="collab-row" onclick="openDetail(${t.id})">
    <div class="collab-row-left">${coverSrc}<div class="collab-row-title">${esc(t.title)}</div><div class="collab-row-sub">${esc(titleSub)}</div></div>
    <div class="collab-row-chars">${chars}</div>
  </div>`;
}

async function showPersonDetail(id) {
  try { state.currentPerson = await api("GET", `/api/people/${id}`); }
  catch (e) { toast(e.message, true); return; }
  renderPersonDetail();
  showView("people-detail-view");
}

function backToPeople() { showPeopleListView(); }

function renderPersonDetail() {
  const p = state.currentPerson;
  const castCount = p.credits.filter((cr) => cr.kind === "cast").length;
  const staffCount = p.credits.filter((cr) => cr.kind === "staff").length;
  const chips = [];
  if (castCount) chips.push(`<span class="chip">🎙 Voice actor · ${castCount} ${castCount === 1 ? "role" : "roles"}</span>`);
  if (staffCount) chips.push(`<span class="chip">🎨 Staff · ${staffCount} ${staffCount === 1 ? "credit" : "credits"}</span>`);
  const castCredits = p.credits.filter((cr) => cr.kind === "cast");
  const staffCredits = p.credits.filter((cr) => cr.kind === "staff");
  const castGrid = castCredits.length ? `
    <h3>🎭 Characters</h3>
    <div class="char-appear-grid">${castCredits.map((cr) => `
      <div class="char-appear-card" onclick="openDetail(${cr.media_id})" data-tip-title="${esc(cr.role || "Character")}" data-tip-sub="${esc(cr.title)}">
        ${portraitImgHTML(cr.character_image, cr.character_pos_x, cr.character_pos_y, cr.role || "?", "person-portrait")}
      </div>`).join("")}
    </div>` : "";
  const staffCards = staffCredits.map((cr) => `
    <div class="media-card" onclick="openDetail(${cr.media_id})">
      <div class="card-cover-wrap">${cr.cover_url ? `<img class="card-cover" src="${toAbs(cr.cover_url)}" alt=""/>` : placeholderCardHTML(cr.title)}</div>
      <div class="card-body">
        <div class="card-title">${esc(cr.title)}</div>
        <div class="card-sub">🎨 ${esc(cr.role || "Staff")}</div>
      </div>
    </div>`).join("");
  $("#person-detail-body").innerHTML = `
    <div class="person-detail-header">
      ${portraitImgHTML(p.image_url, p.image_pos_x, p.image_pos_y, p.name || "?", "person-detail-portrait")}
      <div class="person-detail-info">
        <h2>${esc(p.name)}</h2>
        ${p.native_name ? `<p class="detail-alt">${esc(p.native_name)}</p>` : ""}
        <div class="detail-chips">${chips.length ? chips.join("") : `<span class="chip">No credits yet</span>`}</div>
      </div>
      <button class="secondary" onclick="openPersonEditor()"><img src="ico/edit.svg" class="icon-img-sm" alt=""/> Edit profile</button>
    </div>
    <h3>📖 Bio</h3>
    <p class="person-bio">${esc(p.bio) || `<span class="muted">No bio yet — click "Edit profile" to add one.</span>`}</p>
    ${castGrid}
    ${staffCredits.length ? `<h3>📺 Appears in</h3>
    <div class="media-grid">${staffCards}</div>` : ""}`;
}

function openPersonEditor() {
  const p = state.currentPerson;
  $("#person-edit-id").value = p.id;
  $("#person-edit-name").value = p.name || "";
  $("#person-edit-native").value = p.native_name || "";
  $("#person-edit-birth").value = p.birth_date || "";
  $("#person-edit-nationality").value = p.nationality || "";
  $("#person-edit-bio").value = p.bio || "";
  $("#person-edit-image").value = p.image_url || "";
  $("#person-edit-pos-x").value = p.image_pos_x != null ? p.image_pos_x : 50;
  $("#person-edit-pos-y").value = p.image_pos_y != null ? p.image_pos_y : 50;
  state.personEditFile = null;
  personEditorAlignPreview();
  toggleModal("#modal-person", true);
}

function personEditorAlignPreview() {
  const url = $("#person-edit-image").value.trim();
  const align = $("#person-edit-align");
  const preview = $("#person-edit-preview");
  if (url) {
    align.classList.remove("hidden");
    preview.style.backgroundImage = url.startsWith("blob:") ? `url('${url}')` : `url('${toAbs(url)}')`;
  } else {
    align.classList.add("hidden");
    preview.style.backgroundImage = "";
  }
  personEditorAlignPos();
}

function personEditorAlignPos() {
  const x = $("#person-edit-pos-x").value;
  const y = $("#person-edit-pos-y").value;
  $("#person-edit-pos-x-val").textContent = x;
  $("#person-edit-pos-y-val").textContent = y;
  $("#person-edit-preview").style.backgroundPosition = `${x}% ${y}%`;
}

function personEditorFileSelected(input) {
  if (!input.files[0]) return;
  state.personEditFile = input.files[0];
  $("#person-edit-image").value = URL.createObjectURL(input.files[0]);
  personEditorAlignPreview();
}

async function savePersonEditor() {
  const p = state.currentPerson;
  const id = parseInt($("#person-edit-id").value, 10);
  const body = {
    name: $("#person-edit-name").value.trim(),
    native_name: $("#person-edit-native").value.trim(),
    image_url: isRealImageRef($("#person-edit-image").value.trim()) ? $("#person-edit-image").value.trim() : "",
    image_pos_x: parseInt($("#person-edit-pos-x").value, 10) || 50,
    image_pos_y: parseInt($("#person-edit-pos-y").value, 10) || 50,
    bio: $("#person-edit-bio").value,
    birth_date: $("#person-edit-birth").value.trim(),
    nationality: $("#person-edit-nationality").value.trim(),
  };
  try {
    await api("PUT", `/api/people/${id}`, body);
    if (state.personEditFile) await uploadFileAs(`/api/people/${id}/image`, state.personEditFile);
    toast("Profile saved");
    toggleModal("#modal-person", false);
    state.currentPerson = await api("GET", `/api/people/${id}`);
    renderPersonDetail();
  } catch (e) { toast(e.message, true); }
}

// ---------------- franchise tab & views ----------------
async function loadFranchiseTab() {
  if (!state.currentMedia) return;
  try {
    const all = await api("GET", "/api/franchises");
    state.franchises = all;
    const mine = all.find((f) => f.media.some((m) => m.id === state.currentMedia.id));
    state.franchiseOfCurrent = mine || null;
  } catch (e) { state.franchiseOfCurrent = null; }
  renderFranchiseTab();
}

function renderFranchiseTab() {
  const box = $("#detail-franchise-content");
  const f = state.franchiseOfCurrent;
  if (!f) {
    box.innerHTML = `
      <p class="muted">This title is not part of any franchise yet.</p>
      <div class="franchise-add-row">
        <select id="dt-franchise-select"><option value="">Add to franchise...</option></select>
        <button class="secondary" onclick="addCurrentToFranchise()">Add</button>
      </div>`;
    const sel = $("#dt-franchise-select");
    state.franchises.forEach((x) => sel.insertAdjacentHTML("beforeend", `<option value="${x.id}">${esc(x.name)}</option>`));
  } else {
    box.innerHTML = `
      <h3>${esc(f.name)}</h3>
      <p class="muted" style="margin-top:4px;">${esc(f.description || "")}</p>
      <div class="media-grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;">
        ${f.media.map((m) => `<div class="media-card" onclick="openDetail(${m.id})"><div class="card-cover-wrap">
          ${m.cover_url ? `<img class="card-cover" src="${toAbs(m.cover_url)}"/>` : placeholderCardHTML(m.title)}
          ${m.id === state.currentMedia.id ? `<div class="card-badges"><span class="media-badge badge-watching">you</span></div>` : ""}
        </div><div class="card-body"><div class="card-title" style="font-size:.72rem">${esc(m.title)}</div></div></div>`).join("")}
      </div>
      <p style="margin-top:14px;"><button class="secondary" onclick="showFranchiseDetail(${f.id})">Open franchise →</button></p>`;
  }
}

function addCurrentToFranchise() {
  const fid = $("#dt-franchise-select").value;
  if (!fid) { toast("Choose a franchise", true); return; }
  api("POST", `/api/franchises/${fid}/media`, { media_id: state.currentMedia.id }).then(() => {
    toast("Added");
    loadFranchiseTab();
  }).catch((e) => toast(e.message, true));
}

async function showFranchisesListView() {
  try { state.franchises = await api("GET", "/api/franchises"); } catch (e) {}
  const grid = $("#franchises-grid");
  grid.innerHTML = state.franchises.length ? state.franchises.map(franchiseCardHTML).join("") : `<p class="muted">No franchises yet.</p>`;
  showView("franchises-list-view");
}

function franchiseCardHTML(f) {
  const cover = f.cover_url
    ? `<img class="fc-cover" src="${toAbs(f.cover_url)}" alt=""/>`
    : `<div class="fc-cover-text" style="background:${pastelFor(f.name)}">${esc(f.name.charAt(0) || "?")}</div>`;
  return `
  <div class="franchise-card" onclick="showFranchiseDetail(${f.id})">
    <div class="fc-cover-wrap">${cover}</div>
    <h3>🔗 ${esc(f.name)}</h3>
    <p>${f.count} titles · ${esc(f.description || "")}</p>
  </div>`;
}

async function showFranchiseDetail(id) {
  try { state.franchises = await api("GET", "/api/franchises"); } catch (e) {}
  state.currentFranchise = state.franchises.find((f) => f.id === id) || null;
  if (!state.currentFranchise) { toast("Franchise not found", true); return; }
  $("#franchise-detail-title").textContent = state.currentFranchise.name;
  $("#franchise-detail-count").textContent = state.currentFranchise.count + " titles";
  $("#franchise-detail-desc").textContent = state.currentFranchise.description || "";
  const sel = $("#franchise-add-select");
  sel.innerHTML = '<option value="">Add a title to this franchise...</option>';
  state.allMediaOptions.forEach((m) => {
    if (!state.currentFranchise.media.some((x) => x.id === m.id)) {
      sel.insertAdjacentHTML("beforeend", `<option value="${m.id}">${esc(m.title)}</option>`);
    }
  });
  $("#franchise-detail-grid").innerHTML = state.currentFranchise.media.length
    ? state.currentFranchise.media.map((m) => mediaCardHTML(m)).join("")
    : `<p class="muted">No titles in this franchise yet.</p>`;
  showView("franchise-detail-view");
}

function openFranchiseCreateModal() {
  $("#franchise-edit-id").value = "";
  $("#franchise-name").value = "";
  $("#franchise-desc").value = "";
  $("#franchise-modal-title").textContent = "New Franchise";
  toggleModal("#modal-franchise", true);
}

function openFranchiseEditModal() {
  const f = state.currentFranchise;
  if (!f) return;
  $("#franchise-edit-id").value = f.id;
  $("#franchise-name").value = f.name;
  $("#franchise-desc").value = f.description || "";
  $("#franchise-modal-title").textContent = "Edit Franchise";
  toggleModal("#modal-franchise", true);
}

async function saveFranchiseModal() {
  const id = $("#franchise-edit-id").value;
  const body = { name: $("#franchise-name").value.trim(), description: $("#franchise-desc").value };
  if (!body.name) { toast("Name required", true); return; }
  try {
    if (id) { await api("PUT", `/api/franchises/${id}`, body); toast("Saved"); }
    else { await api("POST", "/api/franchises", body); toast("Franchise created"); }
    toggleModal("#modal-franchise", false);
    await showFranchisesListView();
    if (state.view === "franchise-detail-view" && state.currentFranchise) showFranchiseDetail(state.currentFranchise.id);
    loadStats();
  } catch (e) { toast(e.message, true); }
}

async function deleteCurrentFranchise() {
  if (!confirm(`Delete franchise "${state.currentFranchise.name}"?`)) return;
  try { await api("DELETE", `/api/franchises/${state.currentFranchise.id}`); toast("Deleted"); showFranchisesListView(); loadStats(); }
  catch (e) { toast(e.message, true); }
}

async function addMediaToCurrentFranchise() {
  const id = $("#franchise-add-select").value;
  if (!id) { toast("Pick a title", true); return; }
  try { await api("POST", `/api/franchises/${state.currentFranchise.id}/media`, { media_id: parseInt(id) }); showFranchiseDetail(state.currentFranchise.id); }
  catch (e) { toast(e.message, true); }
}

// ---------------- collections ----------------
async function showCollectionsListView() {
  try { state.collections = await api("GET", "/api/collections"); } catch (e) {}
  const grid = $("#collections-grid");
  grid.innerHTML = state.collections.length ? state.collections.map(collectionCardHTML).join("") : `<p class="muted">No collections yet.</p>`;
  showView("collections-list-view");
}

function collectionCardHTML(c) {
  const cover = c.cover_url
    ? `<img class="fc-cover" src="${toAbs(c.cover_url)}" alt=""/>`
    : `<div class="fc-cover-text" style="background:${pastelFor(c.name)}">${esc(c.name.charAt(0) || "?")}</div>`;
  return `
  <div class="collection-card" onclick="showCollectionDetail(${c.id})">
    <div class="fc-cover-wrap">${cover}</div>
    <h3>⭐ ${esc(c.name)}</h3>
    <p>${c.count} titles · ${esc(c.description || "")}</p>
  </div>`;
}

async function showCollectionDetail(id) {
  try { state.collections = await api("GET", "/api/collections"); } catch (e) {}
  state.currentCollection = state.collections.find((c) => c.id === id) || null;
  if (!state.currentCollection) { toast("Collection not found", true); return; }
  $("#collection-detail-title").textContent = state.currentCollection.name;
  $("#collection-detail-count").textContent = state.currentCollection.count + " titles";
  $("#collection-detail-desc").textContent = state.currentCollection.description || "";
  const sel = $("#collection-add-select");
  sel.innerHTML = '<option value="">Add a title to this collection...</option>';
  state.allMediaOptions.forEach((m) => {
    if (!state.currentCollection.media.some((x) => x.id === m.id)) {
      sel.insertAdjacentHTML("beforeend", `<option value="${m.id}">${esc(m.title)}</option>`);
    }
  });
  $("#collection-detail-grid").innerHTML = state.currentCollection.media.length
    ? state.currentCollection.media.map((m) => mediaCardHTML(m)).join("")
    : `<p class="muted">No titles in this collection yet.</p>`;
  showView("collection-detail-view");
}

function openCollectionCreateModal() {
  $("#collection-edit-id").value = "";
  $("#collection-name").value = "";
  $("#collection-desc").value = "";
  $("#collection-modal-title").textContent = "New Collection";
  toggleModal("#modal-collection", true);
}

function openCollectionEditModal() {
  const c = state.currentCollection;
  if (!c) return;
  $("#collection-edit-id").value = c.id;
  $("#collection-name").value = c.name;
  $("#collection-desc").value = c.description || "";
  $("#collection-modal-title").textContent = "Edit Collection";
  toggleModal("#modal-collection", true);
}

async function saveCollectionModal() {
  const id = $("#collection-edit-id").value;
  const body = { name: $("#collection-name").value.trim(), description: $("#collection-desc").value };
  if (!body.name) { toast("Name required", true); return; }
  try {
    if (id) { await api("PUT", `/api/collections/${id}`, body); toast("Saved"); }
    else { await api("POST", "/api/collections", body); toast("Collection created"); }
    toggleModal("#modal-collection", false);
    await showCollectionsListView();
    if (state.view === "collection-detail-view" && state.currentCollection) showCollectionDetail(state.currentCollection.id);
  } catch (e) { toast(e.message, true); }
}

async function deleteCurrentCollection() {
  if (!confirm(`Delete collection "${state.currentCollection.name}"?`)) return;
  try { await api("DELETE", `/api/collections/${state.currentCollection.id}`); toast("Deleted"); showCollectionsListView(); }
  catch (e) { toast(e.message, true); }
}

async function addMediaToCurrentCollection() {
  const id = $("#collection-add-select").value;
  if (!id) { toast("Pick a title", true); return; }
  try { await api("POST", `/api/collections/${state.currentCollection.id}/media`, { media_id: parseInt(id) }); showCollectionDetail(state.currentCollection.id); }
  catch (e) { toast(e.message, true); }
}

// ---------------- modals ----------------
function toggleModal(sel, on) {
  const el = $(sel);
  if (!el) return;
  el.classList.toggle("hidden", !on);
  if (on) {
    const first = el.querySelector("input,textarea,select");
    setTimeout(() => { try { first && first.focus(); } catch (e) {} }, 80);
  }
}

// cover/banner modal
let bannerPos = 50;
let bannerPosDrag = null;

function openCoverModal(target) {
  $("#cover-target").value = target;
  $("#cover-modal-title").textContent = target === "banner" ? "Set Banner" : "Set Cover";
  $("#cover-file-input").value = "";
  $("#cover-url-input").value = "";
  switchCoverTab("upload");
  const panel = $("#banner-pos-panel");
  if (!panel) { toggleModal("#modal-cover", true); return; }
  if (target === "banner") {
    const m = state.currentMedia;
    if (m && m.banner_url) {
      seedBannerPosImage(toAbs(m.banner_url), typeof m.banner_pos === "number" ? m.banner_pos : 50);
    } else {
      panel.classList.add("hidden");
    }
  } else {
    panel.classList.add("hidden");
  }
  toggleModal("#modal-cover", true);
}
function switchCoverTab(tab) {
  $("#cover-tab-upload").classList.toggle("hidden", tab !== "upload");
  $("#cover-tab-url").classList.toggle("hidden", tab !== "url");
}

function previewCoverSelection() {
  if ($("#cover-target").value !== "banner") return;
  const file = $("#cover-file-input").files[0];
  const url = $("#cover-url-input").value.trim();
  if (file) {
    const reader = new FileReader();
    reader.onload = () => seedBannerPosImage(reader.result, 50);
    reader.readAsDataURL(file);
  } else if (url) {
    seedBannerPosImage(url, 50);
  }
}

function seedBannerPosImage(url, pos) {
  const img = $("#banner-pos-img");
  const box = $("#banner-pos-box");
  const panel = $("#banner-pos-panel");
  if (!img || !box || !panel) return;
  img.onload = () => {
    const bw = box.clientWidth || 420;
    const bh = box.clientHeight || Math.round(bw / 2.7);
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH) return;
    const scale = Math.max(bw / natW, bh / natH);
    const w = Math.ceil(natW * scale), h = Math.ceil(natH * scale);
    img.style.width = w + "px";
    img.style.height = h + "px";
    img.style.left = "50%";
    img.style.top = "0";
    img.style.marginLeft = "-" + Math.round(w / 2) + "px";
    bannerPos = Math.max(0, Math.min(100, pos));
    applyBannerPos();
  };
  img.src = url;
  panel.classList.remove("hidden");
  initBannerDrag();
}

function initBannerDrag() {
  const box = $("#banner-pos-box");
  if (!box || box.dataset.wired) return;
  box.dataset.wired = "1";
  box.addEventListener("pointerdown", (e) => {
    bannerPosDrag = { startY: e.clientY, startPos: bannerPos };
    try { box.setPointerCapture(e.pointerId); } catch (err) {}
    box.classList.add("dragging");
  });
  box.addEventListener("pointermove", (e) => {
    if (!bannerPosDrag) return;
    const range = getBannerPosRange();
    if (range <= 0) return;
    const dy = e.clientY - bannerPosDrag.startY;
    bannerPos = Math.max(0, Math.min(100, bannerPosDrag.startPos - (dy / range) * 100));
    applyBannerPos();
  });
  const endDrag = () => { bannerPosDrag = null; box.classList.remove("dragging"); };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);
}

function getBannerPosRange() {
  const box = $("#banner-pos-box"), img = $("#banner-pos-img");
  if (!box || !img || !img.naturalWidth) return 0;
  const bw = box.clientWidth, bh = box.clientHeight;
  const natW = img.naturalWidth, natH = img.naturalHeight;
  if (!bw || !natW) return 0;
  const scale = Math.max(bw / natW, bh / natH);
  return Math.max(0, natH * scale - bh);
}

function applyBannerPos() {
  const img = $("#banner-pos-img"), box = $("#banner-pos-box"), label = $("#banner-pos-label");
  if (!img || !box) return;
  const range = getBannerPosRange();
  img.style.transform = `translateY(${-(bannerPos / 100) * range}px)`;
  if (label) label.textContent = Math.round(bannerPos) + "%";
}

function nudgeBannerPos(delta) {
  bannerPos = Math.max(0, Math.min(100, bannerPos + delta));
  applyBannerPos();
}

async function saveCoverOrBanner() {
  const target = $("#cover-target").value;
  const id = state.currentMedia.id;
  const file = $("#cover-file-input").files[0];
  const url = $("#cover-url-input").value.trim();
  const path = target === "banner" ? "banner" : "cover";
  try {
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API}/api/media/${id}/upload-${path}`, { method: "POST", body: fd });
      if (!r.ok) throw new Error("Upload failed");
      await r.json();
    } else if (url) {
      await api("POST", `/api/media/${id}/${path}-from-url`, { url });
    } else if (target === "banner" && state.currentMedia.banner_url) {
      // reposition existing banner without re-uploading
    } else { toast("Choose a file or paste a URL", true); return; }
    if (target === "banner") {
      await api("PUT", `/api/media/${id}/banner-pos`, { pos: Math.round(bannerPos) }).catch(() => {});
    }
    toast(target === "banner" ? "Banner updated" : "Cover updated");
    toggleModal("#modal-cover", false);
    const fresh = await api("GET", `/api/media/${id}`);
    state.currentMedia = fresh;
    renderDetailSplash();
    updateCardState();
    loadStats();
  } catch (e) { toast(e.message, true); }
}

// lightbox
let lightboxZoomed = false;
let lightboxNavList = null;
let lightboxNavIndex = 0;
let _lightboxSwipe = null;
let _suppressLightboxClick = 0;

function openImageLightbox(url, opts) {
  if (!url) return;
  const img = $("#lightbox-img");
  img.src = toAbs(url);
  lightboxZoomed = false;
  img.classList.remove("zoomed");
  img.style.maxWidth = "";
  img.style.maxHeight = "";
  img.style.width = "";
  img.style.height = "";
  lightboxNavList = (opts && opts.list) ? opts.list : null;
  lightboxNavIndex = (opts && typeof opts.index === "number") ? opts.index : 0;
  const stage = $("#lightbox-stage");
  if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
  const btn = $("#lightbox-zoom-btn");
  if (btn) btn.textContent = "See full size";
  updateLightboxNav();
  $("#image-lightbox").classList.remove("hidden");
}

function updateLightboxNav() {
  const prev = $("#lightbox-prev");
  const next = $("#lightbox-next");
  const stage = $("#lightbox-stage");
  const hasNav = !!(lightboxNavList && lightboxNavList.length > 1);
  if (prev) prev.style.display = hasNav ? "" : "none";
  if (next) next.style.display = hasNav ? "" : "none";
  if (hasNav) {
    if (prev) prev.disabled = lightboxNavIndex <= 0;
    if (next) next.disabled = lightboxNavIndex >= lightboxNavList.length - 1;
  }
  if (stage) stage.dataset.nav = hasNav ? "gallery" : "";
}

function lightboxNav(delta) {
  if (!lightboxNavList || !lightboxNavList.length) return;
  lightboxNavIndex = Math.max(0, Math.min(lightboxNavList.length - 1, lightboxNavIndex + delta));
  const g = lightboxNavList[lightboxNavIndex];
  if (!g) return;
  const img = $("#lightbox-img");
  img.src = toAbs(g.url);
  lightboxZoomed = false;
  img.classList.remove("zoomed");
  img.style.maxWidth = "";
  img.style.maxHeight = "";
  img.style.width = "";
  img.style.height = "";
  updateLightboxNav();
  const stage = $("#lightbox-stage");
  if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
}

function wireLightboxSwipe() {
  const stage = $("#lightbox-stage");
  if (!stage || stage.dataset.swipeWired) return;
  stage.dataset.swipeWired = "1";
  stage.addEventListener("pointerdown", (e) => {
    if (!lightboxNavList) return;
    _lightboxSwipe = { x: e.clientX, y: e.clientY, moved: false };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!_lightboxSwipe) return;
    const dx = e.clientX - _lightboxSwipe.x;
    const dy = e.clientY - _lightboxSwipe.y;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) _lightboxSwipe.moved = true;
  });
  stage.addEventListener("pointerup", (e) => {
    const s = _lightboxSwipe;
    _lightboxSwipe = null;
    if (!s || !s.moved || !lightboxNavList) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
      _suppressLightboxClick = Date.now() + 400;
      lightboxNav(dx < 0 ? 1 : -1);
    }
  });
  stage.addEventListener("pointercancel", () => { _lightboxSwipe = null; });
}

document.addEventListener("click", (e) => {
  if (Date.now() < _suppressLightboxClick) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

function openCoverLightbox() {
  const m = state.currentMedia;
  if (m) openImageLightbox(m.cover_url);
}
function openBannerLightbox() {
  const m = state.currentMedia;
  if (!m) return;
  openImageLightbox(m.banner_url || m.cover_url);
}
function toggleLightboxZoom() {
  const img = $("#lightbox-img");
  if (!img) return;
  const stage = $("#lightbox-stage");
  lightboxZoomed = !lightboxZoomed;
  if (lightboxZoomed) {
    const fittedW = img.clientWidth || (stage ? stage.clientWidth : 0) || 400;
    img.classList.add("zoomed");
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    img.style.width = Math.round(fittedW * 2) + "px";
    img.style.height = "auto";
  } else {
    img.classList.remove("zoomed");
    img.style.maxWidth = "";
    img.style.maxHeight = "";
    img.style.width = "";
    img.style.height = "";
  }
  if (stage) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  const btn = $("#lightbox-zoom-btn");
  if (btn) btn.textContent = lightboxZoomed ? "Fit to screen" : "See full size";
}
function closeLightbox() {
  $("#image-lightbox").classList.add("hidden");
  lightboxZoomed = false;
  lightboxNavList = null;
  lightboxNavIndex = 0;
  _lightboxSwipe = null;
  const img = $("#lightbox-img");
  if (img) img.classList.remove("zoomed");
  const stage = $("#lightbox-stage");
  if (stage) stage.dataset.nav = "";
  const prev = $("#lightbox-prev");
  const next = $("#lightbox-next");
  if (prev) prev.style.display = "none";
  if (next) next.style.display = "none";
}

// ---------------- settings ----------------
let savedHeader = "";
let musicAutoplayPref = true;

async function openSettingsModal() {
  try {
    const s = await api("GET", "/api/settings");
    $("#settings-title").value = s.app_title || "";
    $("#settings-subtitle").value = s.app_subtitle || "";
    $("#settings-accent").value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff8fb2";
    $("#settings-secondary").value = getComputedStyle(document.documentElement).getPropertyValue("--secondary").trim() || "#b8a7ff";
    $("#settings-bg").value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#fbf3fa";
    $("#settings-music-autoplay").checked = musicAutoplayPref;
    savedHeader = s.settings.header_url || "";
  } catch (e) {}
  renderHeaderGallery();
  toggleModal("#modal-settings", true);
}

async function saveSettings() {
  const title = $("#settings-title").value.trim();
  const subtitle = $("#settings-subtitle").value.trim();
  const accent = $("#settings-accent").value;
  const secondary = $("#settings-secondary").value;
  const bg = $("#settings-bg").value;
  await api("PUT", "/api/settings/app-title", { value: title }).catch(() => {});
  await api("PUT", "/api/settings/app-subtitle", { value: subtitle }).catch(() => {});
  await api("PUT", "/api/settings/pref/accent_color", { value: accent }).catch(() => {});
  await api("PUT", "/api/settings/pref/secondary_color", { value: secondary }).catch(() => {});
  await api("PUT", "/api/settings/pref/bg_color", { value: bg }).catch(() => {});
  musicAutoplayPref = !!$("#settings-music-autoplay").checked;
  await api("PUT", "/api/settings/pref/music_autoplay", { value: musicAutoplayPref ? "1" : "0" }).catch(() => {});
  applyThemeColors(accent, secondary, bg);
  applyTitle(title, subtitle);
  const headerUrl = $("#settings-header-url").value.trim();
  if (headerUrl) applyHeaderUrl(headerUrl);
  toast("Settings saved");
  toggleModal("#modal-settings", false);
  loadStats();
}

function applyThemeColors(accent, secondary, bg) {
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-strong", adjustColor(accent, -18));
  root.setProperty("--secondary", secondary);
  root.setProperty("--bg", bg);
}

function adjustColor(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  let r = Math.max(0, Math.min(255, ((n >> 16) & 255) + delta));
  let g = Math.max(0, Math.min(255, ((n >> 8) & 255) + delta));
  let b = Math.max(0, Math.min(255, (n & 255) + delta));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function applyTitle(title, subtitle) {
  $("#app-title").textContent = title;
  $("#homepage-title").textContent = title;
  $("#app-subtitle").textContent = subtitle;
  document.title = title + " — Anime & Manga Archive";
}

async function initSettings() {
  try {
    const s = await api("GET", "/api/settings");
    if (s.app_title) applyTitle(s.app_title, s.app_subtitle || "");
    if (s.accent_color) applyThemeColors(s.accent_color, s.secondary_color || "#b8a7ff", s.bg_color || "#fbf3fa");
    musicAutoplayPref = (s.settings.music_autoplay || "1") !== "0";
    savedHeader = s.settings.header_url || "";
    if (savedHeader) setHeaderImage(toAbs(savedHeader));
  } catch (e) {}
}

function setHeaderImage(url) {
  document.documentElement.style.setProperty("--header-img", `linear-gradient(rgba(255,244,251,0.42), rgba(255,244,251,0.42)), url('${toAbs(url)}')`);
}

function clearHeader() {
  document.documentElement.style.removeProperty("--header-img");
  savedHeader = "";
  api("PUT", "/api/settings/pref/header_url", { value: "" }).catch(() => {});
}

async function applyHeaderUrl(url) {
  if (!url) return;
  const abs = toAbs(url);
  setHeaderImage(abs);
  savedHeader = abs;
  $("#settings-header-url").value = abs;
  let stored = url.replace(STATIC_BASE, "");
  if (stored.indexOf("http://") !== 0 && stored.indexOf("https://") !== 0 && !stored.startsWith("/")) stored = "/" + stored;
  await api("PUT", "/api/settings/pref/header_url", { value: stored }).catch(() => {});
}

async function uploadHeaderFile() {
  const input = $("#settings-header-upload");
  const file = input && input.files[0];
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`${API}/api/headers/upload`, { method: "POST", body: fd });
    if (!r.ok) throw new Error("Upload failed");
    const res = await r.json();
    applyHeaderUrl(res.url);
    renderHeaderGallery();
    toast("Header uploaded");
  } catch (e) { toast(e.message, true); }
  input.value = "";
}

function onHeaderUrlChange() {
  const v = $("#settings-header-url").value.trim();
  if (v) applyHeaderUrl(v);
}

async function renderHeaderGallery() {
  const box = $("#settings-header-gallery");
  if (!box) return;
  try {
    const res = await api("GET", "/api/headers");
    const headers = res.headers || [];
    if (!headers.length) {
      box.innerHTML = '<p class="muted" style="font-size:.8rem;text-align:center;margin:6px 0;">No saved headers yet — every uploaded header is kept here.</p>';
      return;
    }
    box.innerHTML = `<div class="settings-header-gallery-title">Saved headers (kept forever)</div>${headers.map((h) =>
      `<img class="settings-header-thumb ${toAbs(h) === savedHeader ? "active" : ""}" src="${toAbs(h)}" alt="" loading="lazy" onclick="pickHeader('${h.replace(/'/g, "\\'")}')" />`
    ).join("")}`;
  } catch (e) {}
}

async function pickHeader(url) {
  await applyHeaderUrl(url);
  renderHeaderGallery();
}

async function randomHeader() {
  showLoading(true);
  try {
    const res = await api("GET", "/api/headers");
    if (!res.headers.length) { toast("No headers available"); return; }
    const url = res.headers[Math.floor(Math.random() * res.headers.length)];
    applyHeaderUrl(url);
  } catch (e) { toast(e.message, true); }
  showLoading(false);
}
function onRandomHeader() {
  randomHeader();
}

// title rename
function startRenameTitle() {
  $("#title-edit-input").classList.remove("hidden");
  $("#title-edit-input").value = $("#app-title").textContent;
  $("#title-edit-input").focus();
  $("#title-edit-input").select();
  $$(".app-header .title-row h1").forEach((x) => x.classList.add("hidden"));
}
function finishRenameTitle() {
  const input = $("#title-edit-input");
  if (input.classList.contains("hidden")) return;
  const v = input.value.trim();
  if (v && v !== $("#app-title").textContent) {
    api("PUT", "/api/settings/app-title", { value: v }).then(() => {
      applyTitle(v, $("#app-subtitle").textContent);
    }).catch(() => {});
  }
  input.classList.add("hidden");
  $("#app-title").classList.remove("hidden");
  $$(".app-header .title-row h1").forEach((x) => x.classList.remove("hidden"));
}
function handleRenameTitleKey(e) {
  if (e.key === "Enter") { e.preventDefault(); finishRenameTitle(); }
  if (e.key === "Escape") finishRenameTitle();
}

// ---------------- keyboard ----------------
document.addEventListener("click", (e) => {
  const splash = $("#detail-splash");
  if (!splash || splash.classList.contains("hidden")) return;
  if (e.target.closest(".detail-head")) return;
  if (e.target.closest("#detail-splash")) splash.classList.toggle("head-shown");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const open = document.querySelectorAll(".modal:not(.hidden)");
    if (open.length) { toggleModal("#" + open[open.length - 1].id, false); return; }
    if (!$("#image-lightbox").classList.contains("hidden")) { closeLightbox(); return; }
  }
  if (e.key === "Enter" && e.target.id === "global-search-input") { performSearch(); return; }
  const ed = e.target;
  const isTyping = ed && (ed.tagName === "INPUT" || ed.tagName === "TEXTAREA" || ed.tagName === "SELECT" || ed.isContentEditable);
  if (isTyping) return;
  if ([".media-card"].some((s) => e.target.matches && e.target.matches(s))) return;
  if (state.view === "detail-view" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    const ids = state.listIds;
    if (!ids.length) return;
    const cur = state.currentMedia;
    let idx = ids.indexOf(cur.id);
    if (e.key === "ArrowRight") idx = (idx + 1) % ids.length;
    else idx = (idx - 1 + ids.length) % ids.length;
    openDetail(ids[idx]);
  }
});

// ---------------- bulk fetch mode checkbox ----------------
function toggleBulkMode(el) { state.bulkMode = el.checked ? "missing" : "all"; }

// ---------------- init ----------------
function updateBrowserUrl(path) { /* kept minimal */ }

async function init() {
  try {
    $("#btn-add-media").addEventListener("click", openAddMediaModal);
    wireLightboxSwipe();
    await initSettings();
    wirePersonAutos();
    await Promise.all([loadStats(), loadFacets()]);
    try { state.allMediaOptions = await api("GET", "/api/media?sort=title&per_page=500"); } catch (e) { state.allMediaOptions = []; }
    if (!state.allMediaOptions.length) state.allMediaOptions = state.listMedia;
    // subtle: listen for adds
  } catch (e) {}
}

document.addEventListener("DOMContentLoaded", () => init());

// ---------------- person name autocomplete (dedupe suggestions) ----------------
function wireAutocomplete(input, suggestBox, onPick) {
  if (!input || !suggestBox) return;
  let timer = null;
  const close = () => suggestBox.classList.add("hidden");
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let rows = [];
      try { rows = await api("GET", "/api/people/search?q=" + encodeURIComponent(q)); } catch (e) {}
      if (!rows.length) { close(); return; }
      suggestBox.innerHTML = rows.map((r) => `
        <div class="person-suggest-item" data-id="${r.id}">
          ${r.image_url ? `<img src="${toAbs(r.image_url)}" alt=""/>` : `<span class="pss-letter">${esc((r.name || "?").charAt(0).toUpperCase())}</span>`}
          <span class="pss-name">${esc(r.name)}${r.native_name ? ` <em>${esc(r.native_name)}</em>` : ""}</span>
        </div>`).join("");
      suggestBox.classList.remove("hidden");
      suggestBox.querySelectorAll(".person-suggest-item").forEach((el) => {
        el.addEventListener("click", () => {
          const p = rows.find((x) => x.id === Number(el.dataset.id));
          if (p) onPick(p);
          input.value = p.name;
          close();
        });
      });
    }, 220);
  });
  input.addEventListener("keydown", (e) => {
    if (["Enter", "Escape", "Tab"].includes(e.key)) close();
  });
  document.addEventListener("click", (e) => {
    if (!suggestBox.contains(e.target) && e.target !== input) close();
  });
}

function wirePersonAutos() {
  wireAutocomplete($("#credit-name"), $("#credit-name-suggest"), (p) => {
    $("#credit-person-id").value = p.id;
    state.creditPick.person = p;
    $("#credit-image").value = p.image_url || "";
    $("#credit-person-pos-x").value = p.image_pos_x != null ? p.image_pos_x : 50;
    $("#credit-person-pos-y").value = p.image_pos_y != null ? p.image_pos_y : 50;
    creditAlignPreview("person");
  });
  wireAutocomplete($("#credit-va"), $("#credit-va-suggest"), (p) => {
    $("#credit-va-person-id").value = p.id;
    state.creditPick.va = p;
    $("#credit-va-image").value = p.image_url || "";
    $("#credit-va-pos-x").value = p.image_pos_x != null ? p.image_pos_x : 50;
    $("#credit-va-pos-y").value = p.image_pos_y != null ? p.image_pos_y : 50;
    creditAlignPreview("va");
  });
}
window.addEventListener("resize", () => {
  const sb = $("#sidebar");
  if (window.innerWidth > 768 && sb && sb.classList.contains("open")) {
    sb.classList.remove("open");
    $("#sidebar-backdrop").classList.remove("open");
  }
});