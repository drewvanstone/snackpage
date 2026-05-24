// snackpage frontend. Vanilla JS, no build step.
// Public surface: nothing — everything is module-scoped.

const state = {
  bookmarks: [],   // [{id,title,url,tags,aliases,visit_count,last_visit_at}]
  view: [],        // filtered + sorted subset rendered to DOM
  selected: 0,     // index into view
};

const $q = document.getElementById("q");
const $list = document.getElementById("list");
const $count = document.getElementById("count");

async function load() {
  const r = await fetch("/api/bookmarks");
  const j = await r.json();
  state.bookmarks = j.bookmarks || [];
  refresh();
}

function refresh() {
  const q = $q.value.trim();
  state.view = q === "" ? sortByFrecency(state.bookmarks) : state.bookmarks; // search added in Task 17
  if (state.selected >= state.view.length) state.selected = Math.max(0, state.view.length - 1);
  render();
}

function sortByFrecency(items) {
  const now = Date.now();
  const scored = items.map(b => ({ b, score: frecency(b, now), title: b.title.toLowerCase() }));
  scored.sort((a, z) => z.score - a.score || a.title.localeCompare(z.title));
  return scored.map(s => s.b);
}

function frecency(b, now) {
  const last = b.last_visit_at ? new Date(b.last_visit_at).getTime() : 0;
  const visits = b.visit_count || 0;
  let decay;
  if (!last) {
    decay = 0.1;
  } else {
    const days = Math.floor((now - last) / 86_400_000);
    if (days <= 1) decay = 1.0;
    else if (days <= 7) decay = 0.6;
    else if (days <= 30) decay = 0.3;
    else decay = 0.1;
  }
  return Math.max(visits, 1) * decay;
}

function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function render() {
  $list.innerHTML = "";
  state.view.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "row";
    li.setAttribute("aria-selected", i === state.selected ? "true" : "false");
    li.dataset.id = b.id;
    li.innerHTML = `
      <span class="marker">▌</span>
      <div>
        <div class="title">${escapeHTML(b.title)}</div>
        <div class="sub">${escapeHTML(b.url)}${b.tags && b.tags.length ? "  ·  " + b.tags.map(escapeHTML).join(", ") : ""}</div>
      </div>
      <div class="meta">${relTime(b.last_visit_at)}<span class="count">${b.visit_count || 0} visits</span></div>
    `;
    $list.appendChild(li);
  });
  $count.textContent = `${state.view.length} / ${state.bookmarks.length}`;
}

$q.addEventListener("input", refresh);

load();
