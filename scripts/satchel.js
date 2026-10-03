/**
 * Satchel — the inventory window.
 *
 * One window per actor. Left: categories, containers and tags with live counts and weights.
 * Right: search, sort, a selection bar for bulk actions, and the item list with inline
 * quantity controls. Everything updates live as the actor's items change.
 */
import { MODULE_ID, BUILTIN, categoryInfo, autoCategory } from "./categories.js";
import {
  inventoryOf, categoryOf, setQuantity, splitStack, findDuplicates, mergeGroups, setCategory, addTags, removeTag,
  moveToContainer, addToActor, transfer, rowWeight, unitPriceGp,
} from "./ops.js";
import { openMenu, closeMenu, promptText, promptNumber } from "./menu.js";

const HAM = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
/** A stable colour per tag name. */
const tagHue = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
/** Item description HTML made cheap to show: enrichers flattened to plain text, no scripts or handlers. */
function cleanDescription(html) {
  if (!html) return "";
  let s = String(html)
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")                 // @UUID[...]{Label} -> Label
    .replace(/@\w+\[([^\]]*)\]/g, (m, x) => x.split(/[.|]/).pop()) // @Check[dex] -> dex
    .replace(/\[\[\/\w+\s+([^\]]*?)\]\](?:\{([^}]*)\})?/g, (m, f, l) => l || f)  // [[/r 1d6]]{x} -> x or 1d6
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/&Reference\[([^\]\s]*)[^\]]*\]/g, "$1");
  const t = document.createElement("template");
  t.innerHTML = s;
  t.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((n) => n.remove());
  for (const el of t.content.querySelectorAll("*")) for (const a of [...el.attributes]) {
    if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
  }
  return t.innerHTML;
}
const fmt = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString();

/** dnd5e rarity keys, in order, with the colours players know from most games and D&D Beyond. */
export const RARITIES = {
  common: { label: "Common", color: "#b5b5b5", rank: 1 },
  uncommon: { label: "Uncommon", color: "#3fbf4f", rank: 2 },
  rare: { label: "Rare", color: "#3d8fe0", rank: 3 },
  veryRare: { label: "Very Rare", color: "#a45de8", rank: 4 },
  legendary: { label: "Legendary", color: "#f0902c", rank: 5 },
  artifact: { label: "Artifact", color: "#d9b44a", rank: 6 },
};
/** The item's rarity key, or null for mundane items. */
export const rarityOf = (item) => {
  const r = item.system?.rarity;
  if (!r || r === "none" || r === "mundane") return null;
  return RARITIES[r] ? r : (Object.keys(RARITIES).find((k) => k.toLowerCase() === String(r).toLowerCase().replace(/\s+/g, "")) ?? null);
};
const SORTS = {
  category: { label: "Category", fn: null },
  name: { label: "Name", fn: (a, b) => a.name.localeCompare(b.name) },
  qty: { label: "Quantity", fn: (a, b) => (b.system.quantity ?? 1) - (a.system.quantity ?? 1) || a.name.localeCompare(b.name) },
  weight: { label: "Weight", fn: (a, b) => rowWeight(b) - rowWeight(a) || a.name.localeCompare(b.name) },
  value: { label: "Value", fn: (a, b) => unitPriceGp(b) * (b.system.quantity ?? 1) - unitPriceGp(a) * (a.system.quantity ?? 1) || a.name.localeCompare(b.name) },
  rarity: { label: "Rarity", fn: (a, b) => (RARITIES[rarityOf(b)]?.rank ?? 0) - (RARITIES[rarityOf(a)]?.rank ?? 0) || a.name.localeCompare(b.name) },
  newest: { label: "Newest", fn: (a, b) => (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0) },
};

export class SatchelApp extends HAM {
  static DEFAULT_OPTIONS = {
    classes: ["satchel-app"],
    tag: "div",
    window: { title: "Satchel", icon: "fa-solid fa-bag-shopping", resizable: true },
    position: { width: Math.min(980, window.innerWidth * 0.8), height: Math.min(760, window.innerHeight * 0.85) },
  };
  static PARTS = { content: { template: `modules/${MODULE_ID}/templates/satchel.hbs` } };

  /** Open (or focus) the Satchel for an actor. */
  static async openFor(actor) {
    if (!actor) return ui.notifications.warn("Satchel: select a token or assign a character first.");
    const id = `satchel-${actor.id}`;
    const open = foundry.applications.instances.get(id);
    if (open) { open.bringToFront(); if (open.minimized) open.maximize(); return open; }
    try {
      const app = new SatchelApp(actor, { id });
      await app.render({ force: true });
      return app;
    } catch (err) {
      console.error(`${MODULE_ID} | could not open`, err);
      ui.notifications.error(`Satchel could not open: ${err.message}`, { permanent: true });
    }
  }

  // The actor is kept out of the application options: Foundry deep-copies options, which would
  // hand us a plain copy of the actor instead of the live document.
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.view = foundry.utils.mergeObject({ cat: "all", box: "any", tag: null, rar: null, q: "", sort: "category", compact: false, collapsed: {} },
      game.settings.get(MODULE_ID, "viewState") || {}, { inplace: false });
    this.view.q = "";
    this.selected = new Set();
    this._lastClicked = null;
    this._hooks = [];
    this.editing = new Set();   // item ids with the quick-edit panel open
    this.showing = new Set();   // item ids with the details panel open
    this._focus = null;         // { id, field } to put the cursor back after a refresh
  }

  get title() { return `Satchel — ${this.actor?.name ?? ""}`; }

  saveState() {
    const { cat, sort, compact, collapsed } = this.view;
    game.settings.set(MODULE_ID, "viewState", { cat, sort, compact, collapsed });
  }

  // ───────────────────────────────────────── lifecycle
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const mine = (doc) => doc?.parent?.id === this.actor.id;
    const refresh = foundry.utils.debounce(() => this.rendered && this.refresh(), 60);
    for (const h of ["createItem", "updateItem", "deleteItem"]) this._hooks.push([h, Hooks.on(h, (doc) => mine(doc) && refresh())]);
    this._hooks.push(["updateActor", Hooks.on("updateActor", (a) => a.id === this.actor.id && refresh())]);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    try {
      const host = this.element.querySelector(".sat-host") ?? this.element.querySelector(".window-content");
      if (!host.querySelector(".sat")) this.buildShell(host);
      this.refresh();
    } catch (err) {
      console.error(`${MODULE_ID} | render failed`, err);
      ui.notifications.error(`Satchel hit an error: ${err.message}`, { permanent: true });
    }
  }

  async close(options) {
    for (const [h, id] of this._hooks) Hooks.off(h, id);
    this._hooks = [];
    closeMenu();
    return super.close(options);
  }

  // ───────────────────────────────────────── shell
  buildShell(host) {
    const gm = game.user.isGM;
    host.innerHTML = `
      <div class="sat ${this.view.compact ? "compact" : ""}">
        <aside class="sat-side"></aside>
        <section class="sat-main">
          <header class="sat-bar">
            <label class="sat-search"><i class="fa-solid fa-magnifying-glass"></i>
              <input type="search" placeholder="Search names, tags, containers…  #tag  -word" value="${esc(this.view.q)}"></label>
            <select class="sat-sort" data-tooltip="Sort">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}" ${this.view.sort === k ? "selected" : ""}>${s.label}</option>`).join("")}</select>
            <button type="button" data-do="compact" class="sat-icon" data-tooltip="Compact rows"><i class="fa-solid fa-list"></i></button>
            <button type="button" data-do="merge" data-tooltip="Merge duplicate stacks"><i class="fa-solid fa-object-group"></i> Merge</button>
            <button type="button" data-do="add" data-tooltip="Add an item"><i class="fa-solid fa-plus"></i> Add</button>
            ${gm ? `<button type="button" data-do="award" data-tooltip="Hand out materials to the party"><i class="fa-solid fa-gift"></i> Award</button>` : ""}
          </header>
          <div class="sat-selbar" hidden></div>
          <div class="sat-list" tabindex="0"></div>
          <footer class="sat-foot"></footer>
        </section>
      </div>`;
    const $ = (s) => host.querySelector(s);
    this.el = { root: $(".sat"), side: $(".sat-side"), list: $(".sat-list"), foot: $(".sat-foot"), sel: $(".sat-selbar"), search: $(".sat-search input") };

    this.el.search.addEventListener("input", foundry.utils.debounce((e) => { this.view.q = e.target.value; this.refresh(); }, 120));
    $(".sat-sort").addEventListener("change", (e) => { this.view.sort = e.target.value; this.saveState(); this.refresh(); });
    host.querySelector(".sat-bar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-do]");
      if (!b) return;
      if (b.dataset.do === "compact") { this.view.compact = !this.view.compact; this.el.root.classList.toggle("compact", this.view.compact); this.saveState(); }
      if (b.dataset.do === "merge") this.mergeDialog();
      if (b.dataset.do === "add") this.quickAdd();
      if (b.dataset.do === "award") game.modules.get(MODULE_ID).api.award();
    });

    // sidebar
    this.el.side.addEventListener("click", (e) => {
      const f = e.target.closest("[data-filter]");
      if (!f) return;
      const [kind, val] = f.dataset.filter.split(":");
      if (kind === "cat") { this.view.cat = val; this.view.box = "any"; this.view.tag = null; }
      if (kind === "box") { this.view.box = this.view.box === val ? "any" : val; }
      if (kind === "tag") { this.view.tag = this.view.tag === val ? null : val; }
      if (kind === "rar") { this.view.rar = this.view.rar === val ? null : val; }
      this.saveState();
      this.refresh();
    });
    this.el.side.addEventListener("contextmenu", (e) => {
      const f = e.target.closest("[data-filter^='cat:']");
      if (!f) return;
      const cat = f.dataset.filter.slice(4);
      if (cat === "all") return;
      e.preventDefault();
      const ids = this.visibleItems().filter((i) => categoryOf(i) === cat).map((i) => i.id);
      openMenu([
        { label: `Select all ${categoryInfo(cat).label}`, icon: "fa-solid fa-check-double", act: () => { ids.forEach((id) => this.selected.add(id)); this.refresh(); } },
        { label: "Reset these to automatic categories", icon: "fa-solid fa-rotate-left", act: () => setCategory(this.actor, ids, null) },
      ], { x: e.clientX, y: e.clientY });
    });
    // sidebar is also a drop target: category or container
    this.el.side.addEventListener("dragover", (e) => { const t = e.target.closest("[data-drop]"); if (t) { e.preventDefault(); t.classList.add("drop-hover"); } });
    this.el.side.addEventListener("dragleave", (e) => e.target.closest("[data-drop]")?.classList.remove("drop-hover"));
    this.el.side.addEventListener("drop", (e) => this.onSideDrop(e));

    // list
    this.el.list.addEventListener("click", (e) => this.onListClick(e));
    // double-click a name to rename it in place; double-click elsewhere on the row opens the editor
    this.el.list.addEventListener("dblclick", (e) => {
      const r = e.target.closest(".sat-row:not(.sat-head)");
      if (!r || e.target.closest("input,button,select,textarea,.sat-edit,.sat-details")) return;
      if (e.target.closest(".sat-open")) { clearTimeout(this._nameTimer); return this.startRename(r.dataset.id); }
      this.toggleEditor(r.dataset.id, true);
    });
    this.el.list.addEventListener("contextmenu", (e) => { const r = e.target.closest(".sat-row"); if (!r) return; e.preventDefault(); this.rowMenu(r.dataset.id, { x: e.clientX, y: e.clientY }); });
    this.el.list.addEventListener("change", (e) => {
      const q = e.target.closest(".sat-qty input");
      if (q) return setQuantity(this.item(q.closest(".sat-row").dataset.id), q.value);
      const f = e.target.closest("[data-field]");
      if (f) return this.saveField(f.closest("[data-edit]").dataset.edit, f.dataset.field, f);
      if (e.target.matches(".sat-tagin") && e.target.value.trim()) {
        addTags(this.actor, [e.target.closest("[data-tagfor]").dataset.tagfor], e.target.value.split(","));
      }
    });
    this.el.list.addEventListener("keydown", (e) => {
      if (e.target.matches(".sat-qty input") && e.key === "Enter") { e.target.blur(); return; }
      if (e.target.matches(".sat-tagin") && (e.key === "Enter" || e.key === ",")) {
        e.preventDefault();
        const id = e.target.closest("[data-tagfor]").dataset.tagfor;
        const v = e.target.value.trim();
        if (v) { this._focus = { id, field: "tagin" }; addTags(this.actor, [id], v.split(",")); }
        e.target.value = "";
        return;
      }
      if (e.target.matches(".sat-tagin") && e.key === "Escape") { e.target.closest(".sat-tagadd")?.classList.remove("open"); e.target.blur(); return; }
      if (e.target.matches(".sat-edit input[type=text], .sat-edit input[type=number]") && e.key === "Enter") { e.target.blur(); return; }
      if (e.target.matches("input, textarea, select")) return;
      if (e.key === "F2" && this._lastClicked) { e.preventDefault(); return this.startRename(this._lastClicked); }
      if (e.key === "e" && this._lastClicked) { e.preventDefault(); return this.toggleEditor(this._lastClicked); }
      if (e.key === "Delete" && this.selected.size) { e.preventDefault(); this.deleteSelected(); }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.visibleItems().forEach((i) => this.selected.add(i.id)); this.refresh(); }
      if (e.key === "Escape" && this.selected.size) { e.preventDefault(); this.selected.clear(); this.refresh(); }
    });
    this.el.list.addEventListener("dragstart", (e) => {
      const r = e.target.closest(".sat-row");
      if (!r) return;
      const item = this.item(r.dataset.id);
      const ids = this.selected.has(item.id) ? [...this.selected] : [item.id];
      e.dataTransfer.setData("text/plain", JSON.stringify({ ...item.toDragData(), satchel: { actor: this.actor.uuid, ids } }));
    });
    // dropping items from elsewhere adds them here (merging stacks)
    const main = host.querySelector(".sat-main");
    main.addEventListener("dragover", (e) => e.preventDefault());
    main.addEventListener("drop", (e) => this.onMainDrop(e));

    this.el.sel.addEventListener("click", (e) => this.onSelBar(e));
  }

  // ───────────────────────────────────────── data
  item(id) { return this.actor.items.get(id); }
  allItems() { return inventoryOf(this.actor); }
  containers() { return this.allItems().filter((i) => i.type === "container").sort((a, b) => a.name.localeCompare(b.name)); }

  matches(item, terms) {
    if (!terms.length) return true;
    const tags = item.flags?.[MODULE_ID]?.tags ?? [];
    const box = item.system.container ? this.item(item.system.container)?.name ?? "" : "";
    const hay = `${item.name} ${RARITIES[rarityOf(item)]?.label ?? "mundane"} ${categoryInfo(categoryOf(item)).label} ${tags.map((t) => `#${t}`).join(" ")} ${box}`.toLowerCase();
    return terms.every((t) => (t.startsWith("-") && t.length > 1 ? !hay.includes(t.slice(1)) : hay.includes(t)));
  }
  searchTerms() {
    const out = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(this.view.q.toLowerCase()))) out.push(m[1] ?? m[2]);
    return out;
  }
  /** Items passing search, tag and container filters (category filter applied separately so counts stay useful). */
  filtered({ ignoreCat = false } = {}) {
    const terms = this.searchTerms();
    const st = this.view;
    return this.allItems().filter((i) => {
      if (!ignoreCat && st.cat !== "all" && categoryOf(i) !== st.cat) return false;
      if (st.tag && !(i.flags?.[MODULE_ID]?.tags ?? []).includes(st.tag)) return false;
      if (st.rar && (rarityOf(i) ?? "mundane") !== st.rar) return false;
      if (st.box === "loose" && i.system.container) return false;
      if (st.box !== "any" && st.box !== "loose" && i.system.container !== st.box) return false;
      return this.matches(i, terms);
    });
  }
  visibleItems() { return this._visible ?? []; }

  // ───────────────────────────────────────── render
  refresh() {
    if (!this.el) return;
    // drop selections of items that no longer exist
    for (const id of this.selected) if (!this.item(id)) this.selected.delete(id);
    this.renderSide();
    this.renderList();
    this.renderSelBar();
    this.renderFoot();
  }

  renderSide() {
    const all = this.allItems();
    const base = this.filtered({ ignoreCat: true });
    const counts = new Map(), weights = new Map();
    for (const i of base) { const c = categoryOf(i); counts.set(c, (counts.get(c) || 0) + 1); weights.set(c, (weights.get(c) || 0) + rowWeight(i)); }
    const present = new Set(all.map(categoryOf));
    const cats = [...BUILTIN.filter((c) => present.has(c.id)), ...[...present].filter((c) => !BUILTIN.some((b) => b.id === c)).sort().map(categoryInfo)];
    const st = this.view;
    const row = (filter, icon, label, n, extra = "", drop = "") => `<div class="sat-f ${extra}" data-filter="${esc(filter)}" ${drop ? `data-drop="${esc(drop)}"` : ""}>
      <i class="${icon}"></i><span>${esc(label)}</span><em>${n}</em></div>`;
    let html = `<div class="sat-h">Categories</div>`;
    html += row("cat:all", "fa-solid fa-layer-group", "Everything", base.length, st.cat === "all" ? "on" : "");
    for (const c of cats) {
      const n = counts.get(c.id) || 0;
      html += row(`cat:${c.id}`, c.icon, c.label, n, `${st.cat === c.id ? "on" : ""} ${n ? "" : "empty"}`, `cat:${c.id}`);
    }
    html += `<div class="sat-hint">Drag items onto a category to file them there.</div>`;
    const boxes = this.containers();
    if (boxes.length) {
      html += `<div class="sat-h">Containers</div>`;
      html += row("box:loose", "fa-solid fa-hand-holding", "Not in a container", all.filter((i) => !i.system.container).length, st.box === "loose" ? "on" : "", "box:");
      for (const b of boxes) {
        const n = all.filter((i) => i.system.container === b.id).length;
        html += row(`box:${b.id}`, "fa-solid fa-box-open", b.name, n, st.box === b.id ? "on" : "", `box:${b.id}`);
      }
    }
    const rar = new Map();
    for (const i of all) { const r = rarityOf(i) ?? "mundane"; rar.set(r, (rar.get(r) || 0) + 1); }
    if ([...rar.keys()].some((k) => k !== "mundane")) {
      html += `<div class="sat-h">Rarity</div>`;
      for (const [k, info] of [["mundane", { label: "Mundane", color: "" }], ...Object.entries(RARITIES)]) {
        if (!rar.get(k)) continue;
        html += `<div class="sat-f sat-rarf ${st.rar === k ? "on" : ""}" data-filter="rar:${k}" style="${info.color ? `--rar:${info.color}` : ""}">
          <i class="fa-solid fa-circle"></i><span>${info.label}</span><em>${rar.get(k)}</em></div>`;
      }
    }
    const tags = new Map();
    for (const i of all) for (const t of i.flags?.[MODULE_ID]?.tags ?? []) tags.set(t, (tags.get(t) || 0) + 1);
    if (tags.size) {
      html += `<div class="sat-h">Tags</div>`;
      for (const [t, n] of [...tags].sort((a, b) => a[0].localeCompare(b[0]))) html += row(`tag:${t}`, "fa-solid fa-hashtag", t, n, st.tag === t ? "on" : "");
    }
    this.el.side.innerHTML = html;
  }

  renderList() {
    const items = this.filtered();
    const st = this.view;
    const sort = SORTS[st.sort] ?? SORTS.category;
    let groups;
    if (sort.fn === null) {
      const byCat = new Map();
      for (const i of items) { const c = categoryOf(i); (byCat.get(c) ?? byCat.set(c, []).get(c)).push(i); }
      const order = [...BUILTIN.map((b) => b.id)];
      groups = [...byCat].sort((a, b) => ((order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99)) || a[0].localeCompare(b[0]))
        .map(([c, list]) => [c, list.sort((a, b) => a.name.localeCompare(b.name))]);
    } else groups = [[null, items.sort(sort.fn)]];

    this._visible = groups.flatMap(([c, list]) => (c && st.collapsed[c] ? [] : list));
    if (!items.length) {
      this.el.list.innerHTML = `<div class="sat-empty">${this.allItems().length ? "Nothing matches." : "This inventory is empty. Drag items here or use <b>Add</b>."}</div>`;
      return;
    }
    const head = `<div class="sat-row sat-head"><span></span><span></span><span>Item</span><span class="r">Qty</span><span class="r">Weight</span><span class="r">Value</span><span></span></div>`;
    this.el.list.innerHTML = head + groups.map(([c, list]) => {
      const info = c ? categoryInfo(c) : null;
      const w = list.reduce((s, i) => s + rowWeight(i), 0);
      const n = list.reduce((s, i) => s + (i.system.quantity ?? 1), 0);
      const collapsed = c && st.collapsed[c];
      const header = info ? `<div class="sat-group" data-group="${esc(c)}"><i class="fa-solid fa-caret-${collapsed ? "right" : "down"}"></i><i class="${info.icon}"></i>
        <span>${esc(info.label)}</span><em>${list.length} stack${list.length === 1 ? "" : "s"} · ${n.toLocaleString()} items · ${fmt(w)} lb</em>
        <a class="sat-selgroup" data-tooltip="Select this group"><i class="fa-regular fa-square-check"></i></a></div>` : "";
      return header + (collapsed ? "" : list.map((i) => this.rowHTML(i)).join(""));
    }).join("") + this.tagDatalist();
    this.restoreFocus();
  }

  tagDatalist() {
    const tags = new Set();
    for (const i of this.allItems()) for (const t of i.flags?.[MODULE_ID]?.tags ?? []) tags.add(t);
    return `<datalist id="sat-taglist-${this.actor.id}">${[...tags].sort().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`;
  }

  restoreFocus() {
    const f = this._focus;
    if (!f) return;
    let el;
    if (f.field === "tagin") el = this.el.list.querySelector(`[data-edit="${f.id}"] .sat-tagin`) ?? this.el.list.querySelector(`.sat-tagadd[data-tagfor="${f.id}"] .sat-tagin`);
    else el = this.el.list.querySelector(`[data-edit="${f.id}"] [data-field="${f.field}"]`);
    if (!el) return;
    el.closest(".sat-tagadd")?.classList.add("open");
    el.focus();
    if (f.field === "name") el.select?.();
    el.scrollIntoView({ block: "nearest" });
    this._focus = null;
  }

  rowHTML(i) {
    const q = i.system.quantity ?? 1;
    const tags = i.flags?.[MODULE_ID]?.tags ?? [];
    const box = i.system.container ? this.item(i.system.container) : null;
    const price = unitPriceGp(i);
    const isBox = i.type === "container";
    const contents = isBox ? this.allItems().filter((x) => x.system.container === i.id).length : 0;
    const manual = !!i.flags?.[MODULE_ID]?.category;
    const usable = i.type === "consumable" || i.system.activities?.size;
    const eq = i.system.equipped ? `<i class="fa-solid fa-shield-halved sat-eq" data-tooltip="Equipped"></i>` : "";
    const note = i.flags?.[MODULE_ID]?.note ?? "";
    const editing = this.editing.has(i.id);
    const showing = !editing && this.showing.has(i.id);
    const rk = rarityOf(i);
    const rinfo = rk ? RARITIES[rk] : null;
    return `<div class="sat-row ${this.selected.has(i.id) ? "sel" : ""} ${editing ? "editing" : ""}${showing ? " showing" : ""} ${rk ? `rar rar-${rk}` : ""}" ${rinfo ? `style="--rar:${rinfo.color}"` : ""} data-id="${i.id}" draggable="true">
      <input type="checkbox" class="sat-check" ${this.selected.has(i.id) ? "checked" : ""}>
      <img src="${esc(i.img)}" alt="" loading="lazy">
      <div class="sat-name"><a class="sat-open" data-tooltip="Show details · double-click to rename">${esc(i.name)}</a>${rinfo && rk !== "common" ? `<span class="sat-rar">${rinfo.label}</span>` : ""}${eq}
        ${box ? `<span class="sat-in" data-tooltip="Inside ${esc(box.name)}"><i class="fa-solid fa-box-open"></i> ${esc(box.name)}</span>` : ""}
        ${isBox ? `<span class="sat-in box" data-box="${i.id}" data-tooltip="Show what's inside"><i class="fa-solid fa-arrow-right-to-bracket"></i> ${contents} inside</span>` : ""}
        ${manual ? `<span class="sat-manual" data-tooltip="Filed by hand"><i class="fa-solid fa-thumbtack"></i></span>` : ""}
        ${tags.map((t) => `<span class="sat-tag" data-tag="${esc(t)}" style="--tag-h:${tagHue(t)}">#${esc(t)}<i class="fa-solid fa-xmark" data-untag="${esc(t)}" data-tooltip="Remove tag"></i></span>`).join("")}
        <span class="sat-tagadd" data-tagfor="${i.id}"><a class="sat-tagbtn" data-tooltip="Add a tag"><i class="fa-solid fa-plus"></i><i class="fa-solid fa-hashtag"></i></a><input class="sat-tagin" type="text" list="sat-taglist-${this.actor.id}" placeholder="tag, tag…"></span>
        ${note ? `<div class="sat-note">${esc(note)}</div>` : ""}
      </div>
      <div class="sat-qty">${isBox ? "" : `<button type="button" data-q="-1" tabindex="-1">−</button><input type="number" min="0" value="${q}"><button type="button" data-q="1" tabindex="-1">+</button>`}</div>
      <div class="sat-w r">${rowWeight(i) ? fmt(rowWeight(i), rowWeight(i) < 1 ? 2 : 1) : "—"}</div>
      <div class="sat-v r" ${price ? `data-tooltip="${fmt(price, 2)} gp each"` : ""}>${price ? fmt(price * q, 2) : "—"}</div>
      <div class="sat-act">${usable ? `<a data-act="use" data-tooltip="Use"><i class="fa-solid fa-dice-d20"></i></a>` : ""}<a data-act="edit" data-tooltip="Edit (E)"><i class="fa-solid fa-pen"></i></a><a data-act="menu" data-tooltip="More"><i class="fa-solid fa-ellipsis-vertical"></i></a></div>
    </div>${editing ? this.editorHTML(i) : showing ? this.detailsHTML(i) : ""}`;
  }

  /** A light, read-only details panel under a row. No enrichment or async work, so it opens instantly. */
  detailsHTML(i) {
    const sys = i.system;
    const L = i.labels ?? {};
    const loc = (k) => (k && game.i18n?.localize ? game.i18n.localize(k) : k);
    const rawType = loc(CONFIG.Item?.typeLabels?.[i.type]) || i.type;
    const typeLabel = rawType.charAt(0).toUpperCase() + rawType.slice(1);
    const sub = L.type || L.subtype || "";
    const rk = rarityOf(i);
    const bits = [sub && sub !== typeLabel ? sub : typeLabel, rk ? RARITIES[rk].label : "", sys.attunement ? (sys.attuned ? "Attuned" : "Requires attunement") : ""].filter(Boolean);
    const units = this.actor.system.attributes?.encumbrance?.units ?? sys.weight?.units ?? "lb";
    const w = Number(sys.weight?.value) || 0;
    const price = Number(sys.price?.value) || 0;
    const stats = [];
    if (i.type !== "container") stats.push(["Quantity", sys.quantity ?? 1]);
    if (w) stats.push(["Weight", `${fmt(w, 2)} ${esc(units)} each`]);
    if (price) stats.push(["Value", `${fmt(price, 2)} ${esc(sys.price?.denomination || "gp")} each`]);
    if (L.armor) stats.push(["Armor", esc(L.armor)]);
    const dmg = (L.damages ?? []).map((d) => d?.label ?? d?.formula).filter(Boolean);
    if (dmg.length) stats.push(["Damage", esc(dmg.join(" + "))]);
    if (sys.uses?.max) stats.push(["Uses", `${sys.uses.value ?? sys.uses.max - (sys.uses.spent ?? 0)} / ${sys.uses.max}`]);
    const props = (L.properties ?? []).map((p) => p?.label ?? p).filter((p) => typeof p === "string");
    const note = i.flags?.[MODULE_ID]?.note ?? "";
    const desc = cleanDescription(sys.description?.value ?? "");
    const usable = i.type === "consumable" || sys.activities?.size;
    return `<div class="sat-details" data-edit="${i.id}" ${rk ? `style="--rar:${RARITIES[rk].color}"` : ""}>
      <div class="sat-dhead">${bits.map(esc).join(" · ")}</div>
      ${stats.length ? `<div class="sat-dstats">${stats.map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join("")}</div>` : ""}
      ${props.length ? `<div class="sat-dprops">${props.map((p) => `<span>${esc(p)}</span>`).join("")}</div>` : ""}
      ${note ? `<div class="sat-dnote"><i class="fa-solid fa-note-sticky"></i> ${esc(note)}</div>` : ""}
      <div class="sat-ddesc">${desc || `<em>No description.</em>`}</div>
      <div class="sat-editbar">
        ${usable ? `<button type="button" data-act="use"><i class="fa-solid fa-dice-d20"></i> Use</button>` : ""}
        <button type="button" data-act="sheet"><i class="fa-solid fa-up-right-from-square"></i> Full item sheet</button>
        <button type="button" data-act="edit"><i class="fa-solid fa-pen"></i> Edit</button>
        <button type="button" data-act="hide" class="primary"><i class="fa-solid fa-chevron-up"></i> Close</button>
      </div>
    </div>`;
  }

  toggleDetails(id, open) {
    const on = open ?? !this.showing.has(id);
    if (on) { this.showing.add(id); this.editing.delete(id); } else this.showing.delete(id);
    this.refresh();
    if (on) this.el.list.querySelector(`.sat-details[data-edit="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /** The quick-edit panel under a row: everything a player usually wants to change, saved as they go. */
  editorHTML(i) {
    const sys = i.system;
    const f = i.flags?.[MODULE_ID] ?? {};
    const units = this.actor.system.attributes?.encumbrance?.units ?? sys.weight?.units ?? "lb";
    const present = new Set(this.allItems().map(categoryOf));
    const custom = [...present].filter((c) => !BUILTIN.some((b) => b.id === c)).sort();
    const cur = f.category || "";
    const auto = categoryInfo(autoCategory(i)).label;
    const catOpts = `<option value="" ${cur ? "" : "selected"}>Automatic (${esc(auto)})</option>`
      + BUILTIN.map((c) => `<option value="${c.id}" ${cur === c.id ? "selected" : ""}>${esc(c.label)}</option>`).join("")
      + custom.map((c) => `<option value="${esc(c)}" ${cur === c ? "selected" : ""}>${esc(c)}</option>`).join("")
      + `<option value="__new">New category…</option>`;
    const denoms = ["pp", "gp", "ep", "sp", "cp"].map((d) => `<option value="${d}" ${(sys.price?.denomination || "gp") === d ? "selected" : ""}>${d}</option>`).join("");
    const boxes = this.containers().filter((b) => b.id !== i.id);
    const boxOpts = `<option value="">Not in a container</option>` + boxes.map((b) => `<option value="${b.id}" ${sys.container === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("");
    const tags = f.tags ?? [];
    return `<div class="sat-edit" data-edit="${i.id}">
      <label class="wide">Name <input type="text" data-field="name" value="${esc(i.name)}"></label>
      <label>Quantity <input type="number" min="0" data-field="qty" value="${sys.quantity ?? 1}"></label>
      <label>Weight each (${esc(units)}) <input type="number" min="0" step="0.01" data-field="weight" value="${Number(sys.weight?.value) || 0}"></label>
      <label>Value each <span class="sat-price"><input type="number" min="0" step="0.01" data-field="price" value="${Number(sys.price?.value) || 0}"><select data-field="denom">${denoms}</select></span></label>
      <label>Category <select data-field="category">${catOpts}</select></label>
      <label>Rarity <select data-field="rarity"><option value="">Mundane</option>${Object.entries(RARITIES).map(([k, r]) => `<option value="${k}" ${rarityOf(i) === k ? "selected" : ""}>${r.label}</option>`).join("")}</select></label>
      ${i.type !== "container" || boxes.length ? `<label>Container <select data-field="container">${boxOpts}</select></label>` : ""}
      <label class="wide">Tags
        <span class="sat-tagedit" data-tagfor="${i.id}">${tags.map((t) => `<span class="sat-tag" style="--tag-h:${tagHue(t)}">#${esc(t)}<i class="fa-solid fa-xmark" data-untag="${esc(t)}"></i></span>`).join("")}
          <input class="sat-tagin" type="text" list="sat-taglist-${this.actor.id}" placeholder="type a tag, press Enter"></span></label>
      <label class="wide">Note <input type="text" data-field="note" value="${esc(f.note ?? "")}" placeholder="Where you found it, what it's for… (shown under the name)"></label>
      <div class="sat-editbar">
        <button type="button" data-act="sheet"><i class="fa-solid fa-up-right-from-square"></i> Full item sheet</button>
        <button type="button" data-act="img"><i class="fa-solid fa-image"></i> Change image</button>
        <button type="button" data-act="done" class="primary"><i class="fa-solid fa-check"></i> Done</button>
      </div>
    </div>`;
  }

  toggleEditor(id, open) {
    const on = open ?? !this.editing.has(id);
    if (on) { this.editing.add(id); this.showing.delete(id); } else this.editing.delete(id);
    if (on) this._focus = { id, field: "name" };
    this.refresh();
  }

  async saveField(id, field, el) {
    const item = this.item(id);
    if (!item) return;
    const v = el.value;
    const num = (x) => Math.max(0, Number(x) || 0);
    this._focus = null;
    switch (field) {
      case "name": if (v.trim() && v.trim() !== item.name) return item.update({ name: v.trim() }); return;
      case "qty": return setQuantity(item, v);
      case "weight": return item.update({ "system.weight.value": num(v) });
      case "price": return item.update({ "system.price.value": num(v) });
      case "denom": return item.update({ "system.price.denomination": v });
      case "rarity": return item.update({ "system.rarity": v });
      case "note": return item.update({ [`flags.${MODULE_ID}.note`]: v.trim() });
      case "container": return moveToContainer(this.actor, [id], v || null);
      case "category": {
        if (v === "__new") {
          const n = await promptText("New category", "Name", "", "Items filed here show under this name.");
          if (n?.trim()) return setCategory(this.actor, [id], n.trim());
          return this.refresh();
        }
        return setCategory(this.actor, [id], v || null);
      }
    }
  }

  /** Rename in place: the name becomes a text box; Enter saves, Escape cancels. */
  startRename(id) {
    const item = this.item(id);
    const a = this.el.list.querySelector(`.sat-row[data-id="${id}"] .sat-open`);
    if (!item || !a) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sat-rename";
    input.value = item.name;
    a.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== item.name) item.update({ name: v });
      else this.refresh();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  renderSelBar() {
    const n = this.selected.size;
    this.el.sel.hidden = !n;
    if (!n) return;
    this.el.sel.innerHTML = `<span><b>${n}</b> selected</span>
      <button type="button" data-sel="cat"><i class="fa-solid fa-folder-tree"></i> File under…</button>
      ${this.containers().length ? `<button type="button" data-sel="box"><i class="fa-solid fa-box-open"></i> Put in…</button>` : ""}
      <button type="button" data-sel="give"><i class="fa-solid fa-hand-holding-hand"></i> Give to…</button>
      <button type="button" data-sel="tag"><i class="fa-solid fa-hashtag"></i> Tag…</button>
      <button type="button" data-sel="merge"><i class="fa-solid fa-object-group"></i> Merge</button>
      <button type="button" data-sel="delete" class="danger"><i class="fa-solid fa-trash"></i> Delete</button>
      <button type="button" data-sel="clear" class="sat-icon" data-tooltip="Clear selection"><i class="fa-solid fa-xmark"></i></button>`;
  }

  renderFoot() {
    const all = this.allItems();
    const enc = this.actor.system.attributes?.encumbrance;
    const total = all.reduce((s, i) => s + rowWeight(i), 0);
    const value = all.reduce((s, i) => s + unitPriceGp(i) * (i.system.quantity ?? 1), 0);
    const units = enc?.units ?? "lb";
    let bar = "";
    if (enc && Number.isFinite(enc.max) && enc.max > 0) {
      const pct = Math.min(100, (enc.value / enc.max) * 100);
      const cls = enc.value > (enc.thresholds?.heavilyEncumbered ?? Infinity) ? "heavy" : enc.value > (enc.thresholds?.encumbered ?? Infinity) ? "enc" : "";
      bar = `<div class="sat-enc ${cls}" data-tooltip="Carrying ${fmt(enc.value)} of ${fmt(enc.max)} ${esc(units)}"><div style="width:${pct}%"></div><span>${fmt(enc.value)} / ${fmt(enc.max)} ${esc(units)}</span></div>`;
    } else bar = `<span>${fmt(total)} ${esc(units)}</span>`;
    const cur = this.actor.system.currency ?? {};
    const coins = ["pp", "gp", "ep", "sp", "cp"].filter((k) => cur[k]).map((k) => `${cur[k].toLocaleString()} ${k}`).join(" · ");
    const shown = this.filtered();
    this.el.foot.innerHTML = `<span data-tooltip="Stacks shown / all stacks"><i class="fa-solid fa-boxes-stacked"></i> ${shown.length} / ${all.length} stacks · ${all.reduce((s, i) => s + (i.system.quantity ?? 1), 0).toLocaleString()} items</span>
      ${bar}
      <span data-tooltip="Listed value of everything carried"><i class="fa-solid fa-coins"></i> ${fmt(value, 2)} gp</span>
      ${coins ? `<span class="sat-coins" data-tooltip="Coins">${coins}</span>` : ""}`;
  }

  // ───────────────────────────────────────── interaction
  async onListClick(e) {
    const g = e.target.closest(".sat-group");
    if (g) {
      const c = g.dataset.group;
      if (e.target.closest(".sat-selgroup")) {
        this.filtered().filter((i) => categoryOf(i) === c).forEach((i) => this.selected.add(i.id));
      } else {
        this.view.collapsed[c] = !this.view.collapsed[c];
        this.saveState();
      }
      return this.refresh();
    }
    const r = e.target.closest(".sat-row") ?? e.target.closest(".sat-edit, .sat-details");
    if (!r || r.classList.contains("sat-head")) return;
    const item = this.item(r.dataset.id ?? r.dataset.edit);
    if (!item) return;
    const qb = e.target.closest("[data-q]");
    if (qb) {
      const step = Number(qb.dataset.q) * (e.shiftKey ? 5 : 1) * (e.ctrlKey || e.metaKey ? 10 : 1);
      return setQuantity(item, (item.system.quantity ?? 1) + step);
    }
    if (e.target.closest(".sat-qty")) return;
    if (e.target.closest(".sat-open")) {
      // click the name to show its details; a double-click renames instead (so wait a moment to tell them apart)
      clearTimeout(this._nameTimer);
      if (e.detail > 1) return;
      this._nameTimer = setTimeout(() => this.toggleDetails(item.id), 220);
      return;
    }
    const untag = e.target.closest("[data-untag]");
    if (untag) return removeTag(item, untag.dataset.untag);
    const tag = e.target.closest("[data-tag]");
    if (tag) { this.view.tag = tag.dataset.tag; return this.refresh(); }
    const box = e.target.closest("[data-box]");
    if (box) { this.view.box = box.dataset.box; this.view.cat = "all"; return this.refresh(); }
    const tagBtn = e.target.closest(".sat-tagbtn");
    if (tagBtn) {
      const wrap = tagBtn.closest(".sat-tagadd");
      wrap.classList.add("open");
      wrap.querySelector("input").focus();
      return;
    }
    if (e.target.closest(".sat-tagin, .sat-edit input, .sat-edit select, .sat-rename")) return;
    const act = e.target.closest("[data-act]");
    if (act?.dataset.act === "edit") return this.toggleEditor(item.id);
    if (act?.dataset.act === "done") return this.toggleEditor(item.id, false);
    if (act?.dataset.act === "hide") return this.toggleDetails(item.id, false);
    if (act?.dataset.act === "sheet") return item.sheet.render(true);
    if (act?.dataset.act === "img") {
      const FP = foundry.applications.apps.FilePicker.implementation;
      return new FP({ type: "image", current: item.img, callback: (path) => item.update({ img: path }) }).render(true);
    }
    if (e.target.closest(".sat-edit")) return;
    if (e.target.closest(".sat-details") && !act) return;
    if (act?.dataset.act === "use") return item.use?.({ event: e });
    if (act?.dataset.act === "menu") return this.rowMenu(item.id, act);

    // selection: click toggles, shift-click selects a range
    if (e.shiftKey && this._lastClicked) {
      const ids = this.visibleItems().map((i) => i.id);
      const [a, b] = [ids.indexOf(this._lastClicked), ids.indexOf(item.id)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) ids.slice(a, b + 1).forEach((id) => this.selected.add(id));
    } else if (this.selected.has(item.id)) this.selected.delete(item.id);
    else this.selected.add(item.id);
    this._lastClicked = item.id;
    this.refresh();
  }

  /** Menus shared by the row menu and the selection bar. `ids` = the items acted on. */
  categoryMenu(ids) {
    const present = new Set(this.allItems().map(categoryOf));
    const custom = [...present].filter((c) => !BUILTIN.some((b) => b.id === c)).sort();
    return [
      { label: "Automatic", icon: "fa-solid fa-wand-magic-sparkles", hint: "by type and name", act: () => setCategory(this.actor, ids, null) },
      { sep: true },
      ...BUILTIN.map((c) => ({ label: c.label, icon: c.icon, act: () => setCategory(this.actor, ids, c.id) })),
      custom.length && { sep: true },
      ...custom.map((c) => ({ label: c, icon: "fa-solid fa-tag", act: () => setCategory(this.actor, ids, c) })),
      { sep: true },
      { label: "New category…", icon: "fa-solid fa-plus", act: async () => { const n = await promptText("New category", "Name", "", "Items filed here show under this name in every Satchel."); if (n?.trim()) setCategory(this.actor, ids, n.trim()); } },
    ];
  }
  containerMenu(ids) {
    return [
      { label: "Not in a container", icon: "fa-solid fa-hand-holding", act: () => moveToContainer(this.actor, ids, null) },
      { sep: true },
      ...this.containers().filter((b) => !ids.includes(b.id)).map((b) => ({ label: b.name, icon: "fa-solid fa-box-open", act: () => moveToContainer(this.actor, ids, b.id) })),
    ];
  }
  giveTargets() {
    const targets = game.actors.filter((a) => a.id !== this.actor.id && (a.type === "group" || (a.type === "character" && (a.hasPlayerOwner || game.user.isGM))));
    return targets.sort((a, b) => (a.type === "group" ? -1 : 0) - (b.type === "group" ? -1 : 0) || a.name.localeCompare(b.name));
  }
  giveMenu(ids) {
    const t = this.giveTargets();
    if (!t.length) return [{ label: "No other characters or party actors", disabled: true }];
    return t.map((a) => ({
      label: a.name, icon: a.type === "group" ? "fa-solid fa-people-group" : "fa-solid fa-user",
      hint: a.type === "group" ? "party stash" : "",
      act: async () => {
        let list = ids.map((id) => ({ id }));
        const one = ids.length === 1 ? this.item(ids[0]) : null;
        if (one && (one.system.quantity ?? 1) > 1) {
          const n = await promptNumber(`Give to ${a.name}`, `How many ${one.name}? (you have ${one.system.quantity})`, one.system.quantity, one.system.quantity);
          if (!n) return;
          list = [{ id: one.id, qty: n }];
        }
        await transfer(this.actor, a, list);
        ids.forEach((id) => this.selected.delete(id));
      },
    }));
  }

  rowMenu(id, at) {
    const item = this.item(id);
    if (!item) return;
    const ids = this.selected.has(id) && this.selected.size > 1 ? [...this.selected] : [id];
    const many = ids.length > 1;
    const q = item.system.quantity ?? 1;
    openMenu([
      many && { heading: `${ids.length} selected items` },
      !many && { label: "Details", icon: "fa-solid fa-circle-info", act: () => this.toggleDetails(item.id, true) },
      !many && { label: "Edit…", icon: "fa-solid fa-pen", hint: "E", act: () => this.toggleEditor(item.id, true) },
      !many && { label: "Rename", icon: "fa-solid fa-i-cursor", hint: "F2", act: () => this.startRename(item.id) },
      !many && { label: "Open item sheet", icon: "fa-solid fa-up-right-from-square", act: () => item.sheet.render(true) },
      !many && (item.type === "consumable" || item.system.activities?.size) && { label: "Use", icon: "fa-solid fa-dice-d20", act: () => item.use?.() },
      !many && q > 1 && item.type !== "container" && { label: "Split stack…", icon: "fa-solid fa-scissors", act: async () => { const n = await promptNumber("Split stack", `Move how many ${item.name} into a new stack?`, Math.floor(q / 2), q - 1); if (n) splitStack(item, n); } },
      !many && item.type !== "container" && { label: "Post to chat", icon: "fa-solid fa-comment", act: () => item.displayCard?.() ?? item.toMessage?.() },
      { sep: true },
      { label: "File under", icon: "fa-solid fa-folder-tree", sub: this.categoryMenu(ids) },
      this.containers().length && { label: "Put in", icon: "fa-solid fa-box-open", sub: this.containerMenu(ids) },
      { label: "Give to", icon: "fa-solid fa-hand-holding-hand", sub: this.giveMenu(ids) },
      { label: "Add tag…", icon: "fa-solid fa-hashtag", act: () => this.tagPrompt(ids) },
      { sep: true },
      { label: many ? `Delete ${ids.length} items` : "Delete", icon: "fa-solid fa-trash", act: () => this.deleteItems(ids) },
    ], at);
  }

  async onSelBar(e) {
    const b = e.target.closest("[data-sel]");
    if (!b) return;
    const ids = [...this.selected];
    switch (b.dataset.sel) {
      case "cat": return openMenu(this.categoryMenu(ids), b);
      case "box": return openMenu(this.containerMenu(ids), b);
      case "give": return openMenu(this.giveMenu(ids), b);
      case "tag": return this.tagPrompt(ids);
      case "merge": {
        const groups = findDuplicates(this.actor, ids.map((id) => this.item(id)).filter(Boolean));
        if (!groups.length) return ui.notifications.info("None of the selected stacks are duplicates of each other.");
        const n = await mergeGroups(this.actor, groups);
        return ui.notifications.info(`Merged ${n} duplicate stack${n === 1 ? "" : "s"}.`);
      }
      case "delete": return this.deleteSelected();
      case "clear": this.selected.clear(); return this.refresh();
    }
  }

  async tagPrompt(ids) {
    const v = await promptText("Add tags", "Tags (comma-separated)", "", "Search with #tag. Click a tag's × to remove it.");
    if (v) addTags(this.actor, ids, v.split(","));
  }

  async deleteItems(ids) {
    const names = ids.map((id) => this.item(id)?.name).filter(Boolean);
    if (!names.length) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete items" },
      content: `<p>Delete ${names.length === 1 ? `<b>${esc(names[0])}</b>` : `${names.length} stacks`}? Containers take their contents with them.</p>`,
    });
    if (!ok) return;
    await this.actor.deleteEmbeddedDocuments("Item", ids, { deleteContents: true });
    ids.forEach((id) => this.selected.delete(id));
  }
  deleteSelected() { return this.deleteItems([...this.selected]); }

  async mergeDialog() {
    const groups = findDuplicates(this.actor);
    if (!groups.length) return ui.notifications.info("No duplicate stacks — everything is already merged.");
    const rows = groups.map((g) => `<li><img src="${esc(g.keep.img)}" width="20" height="20"> <b>${esc(g.keep.name)}</b> — ${g.merge.length + 1} stacks → ${g.total}</li>`).join("");
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Merge duplicate stacks" },
      content: `<p>These items appear more than once in the same place:</p><ul class="sat-mergelist">${rows}</ul><p>Merge each into a single stack?</p>`,
      yes: { label: "Merge all" },
    });
    if (!ok) return;
    const n = await mergeGroups(this.actor, groups);
    ui.notifications.info(`Merged ${n} duplicate stack${n === 1 ? "" : "s"}.`);
  }

  async quickAdd() {
    const catOpts = BUILTIN.map((c) => `<option value="${c.id}" ${c.id === "materials" ? "selected" : ""}>${esc(c.label)}</option>`).join("");
    const data = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Add to ${this.actor.name}` },
      content: `
        <div class="form-group"><label>Name</label><input name="name" type="text" placeholder="Silverleaf" autofocus></div>
        <div class="form-group"><label>Quantity</label><input name="qty" type="number" min="1" value="1"></div>
        <div class="form-group"><label>Category</label><select name="cat"><option value="">Automatic (by name)</option>${catOpts}</select></div>
        <div class="form-group"><label>Weight each (${esc(this.actor.system.attributes?.encumbrance?.units ?? "lb")})</label><input name="weight" type="number" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label>Value each (gp)</label><input name="price" type="number" min="0" step="0.01" value="0"></div>
        <p class="hint">Adds a material to this inventory. If one with the same name is already here, the quantity is added to it. You can also drag items from compendiums straight into this window.</p>`,
      ok: {
        label: "Add",
        callback: (event, button) => {
          const f = button.form.elements;
          return { name: f.name.value.trim(), qty: f.qty.valueAsNumber || 1, cat: f.cat.value, weight: f.weight.valueAsNumber || 0, price: f.price.valueAsNumber || 0 };
        },
      },
      rejectClose: false,
    }).catch(() => null);
    if (!data?.name) return;
    const itemData = {
      name: data.name, type: "loot",
      system: { type: { value: "material" }, quantity: data.qty, weight: { value: data.weight }, price: { value: data.price, denomination: "gp" } },
    };
    if (data.cat) foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.category`, data.cat);
    await addToActor(this.actor, itemData, data.qty);
  }

  // ───────────────────────────────────────── drops
  async dropItems(e) {
    let data;
    try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return null; }
    return data?.type === "Item" ? data : null;
  }

  async onSideDrop(e) {
    const t = e.target.closest("[data-drop]");
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    t.classList.remove("drop-hover");
    const data = await this.dropItems(e);
    if (!data) return;
    // only rows dragged out of this same Satchel can be filed
    const ids = data.satchel?.actor === this.actor.uuid ? data.satchel.ids : null;
    if (!ids) return this.onMainDrop(e);
    const [kind, val] = t.dataset.drop.split(":");
    if (kind === "cat") await setCategory(this.actor, ids, val);
    if (kind === "box") await moveToContainer(this.actor, ids, val || null);
  }

  async onMainDrop(e) {
    if (e.defaultPrevented && e.target.closest(".sat-side")) return;
    e.preventDefault();
    const data = await this.dropItems(e);
    if (!data) return;
    if (data.satchel?.actor === this.actor.uuid) return;           // dragged within this window
    const item = await Item.implementation.fromDropData(data);
    if (!item) return;
    if (item.parent && item.parent !== this.actor && item.parent.isOwner) {
      // from another of the user's actors: move it (ask how many for a stack)
      let qty;
      if ((item.system.quantity ?? 1) > 1) {
        qty = await promptNumber("Move items", `How many ${item.name}?`, item.system.quantity, item.system.quantity);
        if (!qty) return;
      }
      return transfer(item.parent, this.actor, [{ id: item.id, qty }]);
    }
    if (item.parent === this.actor) return;
    await addToActor(this.actor, item.toObject(), item.system.quantity ?? 1);
  }
}
