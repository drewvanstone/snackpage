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
  if (q === "") {
    state.view = sortByFrecency(state.bookmarks);
  } else {
    state.view = fuzzyRank(q, state.bookmarks);
  }
  if (state.selected >= state.view.length) state.selected = Math.max(0, state.view.length - 1);
  if (state.view.length > 0 && state.selected < 0) state.selected = 0;
  render();
}

// Weighted fzf ranking. Falls back to substring match if fzf failed to load.
function fuzzyRank(q, items) {
  const F = window.fzf;
  if (!F) {
    const ql = q.toLowerCase();
    return items.filter(b =>
      b.title.toLowerCase().includes(ql) ||
      b.url.toLowerCase().includes(ql) ||
      (b.tags || []).some(t => t.toLowerCase().includes(ql)) ||
      (b.aliases || []).some(a => a.toLowerCase().includes(ql))
    );
  }
  // fzf-for-js: build a Fzf finder per field, score, sum.
  const titleFinder = new F.Fzf(items, { selector: i => i.title });
  const urlFinder = new F.Fzf(items, { selector: i => i.url });
  const tagsFinder = new F.Fzf(items, { selector: i => (i.tags || []).join(" ") });
  const aliasFinder = new F.Fzf(items, { selector: i => (i.aliases || []).join(" ") });

  const scoreMap = new Map(); // id -> { score, item }
  function feed(finder, weight) {
    const entries = finder.find(q);
    for (const e of entries) {
      const cur = scoreMap.get(e.item.id) || { score: 0, item: e.item };
      cur.score += weight * e.score;
      scoreMap.set(e.item.id, cur);
    }
  }
  feed(titleFinder, 4);
  feed(aliasFinder, 3);
  feed(tagsFinder, 2);
  feed(urlFinder, 1);

  const now = Date.now();
  const ranked = [...scoreMap.values()].map(({ score, item }) => ({
    item,
    score: score + 0.001 * frecency(item, now),
  }));
  ranked.sort((a, z) => z.score - a.score);
  return ranked.map(r => r.item);
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

function move(delta) {
  if (state.view.length === 0) return;
  state.selected = (state.selected + delta + state.view.length) % state.view.length;
  render();
  // Scroll selected into view
  const sel = $list.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function openSelected(newTab) {
  const b = state.view[state.selected];
  if (!b) return;
  const url = "/go/" + encodeURIComponent(b.id);
  if (newTab) window.open(url, "_blank");
  else window.location.href = url;
}

// Global key handler — runs at capture phase so we can override input behavior.
document.addEventListener("keydown", (e) => {
  // Modal handles its own keys; bail when one is open.
  if (document.querySelector(".modal-overlay")) return;

  const inInput = document.activeElement === $q;
  const empty = $q.value === "";

  // Navigation: arrows + Ctrl+N/P (always); j/k (only when input is empty)
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault(); move(1); return;
  }
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault(); move(-1); return;
  }
  if ((!inInput || empty) && (e.key === "j")) {
    if (inInput && empty) { e.preventDefault(); move(1); return; }
    if (!inInput) { e.preventDefault(); move(1); return; }
  }
  if ((!inInput || empty) && (e.key === "k")) {
    if (inInput && empty) { e.preventDefault(); move(-1); return; }
    if (!inInput) { e.preventDefault(); move(-1); return; }
  }

  if (e.key === "Enter") {
    if ((e.metaKey || e.ctrlKey)) { e.preventDefault(); openSelected(true); return; }
    e.preventDefault(); openSelected(false); return;
  }
  if (e.key === "Escape") {
    if ($q.value !== "") { $q.value = ""; refresh(); }
    else $q.blur();
    return;
  }
  if (e.key === "/" && !inInput) {
    e.preventDefault();
    $q.focus();
    return;
  }
});

// Click-to-select on rows
$list.addEventListener("click", (e) => {
  const li = e.target.closest(".row");
  if (!li) return;
  const idx = [...$list.children].indexOf(li);
  if (idx >= 0) { state.selected = idx; render(); }
});

load();
