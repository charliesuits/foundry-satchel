/**
 * Satchel: Inventory Manager — entry point.
 *
 * Adds a Satchel button to character, NPC and party sheets (title bar and inventory tab)
 * that opens a roomy inventory manager for that actor, plus a GM "Award Materials" dialog.
 */
import { MODULE_ID } from "./categories.js";
import { registerSocket, transfer, addToActor, findDuplicates, mergeGroups } from "./ops.js";
import { SatchelApp } from "./satchel.js";
import { AwardApp } from "./award.js";

const INVENTORY_ACTORS = new Set(["character", "npc", "group", "vehicle"]);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "tabButton", {
    name: "Button in the inventory tab",
    hint: "Also show an \"Open Satchel\" button at the top of the sheet's inventory tab (the title-bar button is always there).",
    scope: "client", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "deleteAtZero", {
    name: "Offer to remove used-up items",
    hint: "When a stack reaches 0, ask whether to remove it instead of keeping an empty stack.",
    scope: "client", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "announceTransfers", {
    name: "Post gifts and awards to chat",
    hint: "A short chat card whenever items are given between characters or awarded by the GM.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, "viewState", { scope: "client", config: false, type: Object, default: {} });

  game.keybindings.register(MODULE_ID, "open", {
    name: "Open the Satchel",
    hint: "For your selected token, or your assigned character.",
    editable: [{ key: "KeyI", modifiers: ["Shift"] }],
    onDown: () => { SatchelApp.openFor(defaultActor()); return true; },
  });
});

function defaultActor() {
  const tok = canvas?.tokens?.controlled?.[0]?.actor;
  return tok?.isOwner ? tok : game.user.character ?? null;
}

// ───────────────────────────────────────────── sheet buttons
function wanted(actor) { return actor && INVENTORY_ACTORS.has(actor.type) && actor.isOwner; }

/** Title-bar button (ApplicationV2 sheets: default dnd5e, Tidy 5e and most others). */
Hooks.on("renderActorSheetV2", (app, element) => {
  const actor = app.document ?? app.actor;
  if (!wanted(actor)) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const header = app.element?.querySelector(".window-header");
  if (header && !header.querySelector(".satchel-open")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "header-control icon fa-solid fa-bag-shopping satchel-open";
    b.dataset.tooltip = "Satchel — inventory manager";
    b.setAttribute("aria-label", "Open Satchel");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); SatchelApp.openFor(actor); });
    const anchor = header.querySelector('[data-action="close"]') ?? header.lastElementChild;
    header.insertBefore(b, anchor);
  }
  addTabButton(root ?? app.element, actor);
});

/** Older (Application v1) sheets. */
Hooks.on("renderActorSheet", (app, html) => {
  const actor = app.actor;
  if (!wanted(actor)) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  const win = el?.closest?.(".app") ?? app.element?.[0];
  const header = win?.querySelector(".window-header");
  if (header && !header.querySelector(".satchel-open")) {
    const a = document.createElement("a");
    a.className = "satchel-open";
    a.innerHTML = `<i class="fa-solid fa-bag-shopping"></i> Satchel`;
    a.addEventListener("click", (e) => { e.preventDefault(); SatchelApp.openFor(actor); });
    header.querySelector(".close")?.before(a) ?? header.append(a);
  }
  addTabButton(win, actor);
});

/** A wide "Open Satchel" button at the top of the inventory tab. */
function addTabButton(root, actor) {
  if (!root || !game.settings.get(MODULE_ID, "tabButton")) return;
  const tab = root.querySelector('.tab[data-tab="inventory"], .tab.inventory, [data-tab-contents-for="inventory"]');
  if (!tab || tab.querySelector(".satchel-tabbtn")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "satchel-tabbtn";
  b.innerHTML = `<i class="fa-solid fa-bag-shopping"></i> Open Satchel <span>sort, search, merge and share your items</span>`;
  b.addEventListener("click", (e) => { e.preventDefault(); SatchelApp.openFor(actor); });
  tab.prepend(b);
}

/** Also listed in the sheet's ⋮ menu. */
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  const actor = app.document ?? app.actor;
  if (!wanted(actor)) return;
  controls.push({ icon: "fa-solid fa-bag-shopping", label: "Satchel", action: "satchelOpen", onClick: () => SatchelApp.openFor(actor) });
});

// ───────────────────────────────────────────── ready
Hooks.once("ready", () => {
  registerSocket();
  game.modules.get(MODULE_ID).api = {
    /** Open the Satchel for an actor (default: selected token or assigned character). */
    open: (actor = defaultActor()) => SatchelApp.openFor(actor),
    /** GM: open the Award Materials dialog. */
    award: () => AwardApp.open(),
    /** Add item data to an actor, merging with an existing stack. */
    add: addToActor,
    /** Move items between actors: transfer(fromActor, toActor, [{id, qty?}]). */
    transfer,
    /** Merge every duplicate stack on an actor. Returns how many stacks were folded in. */
    mergeAll: (actor) => mergeGroups(actor, findDuplicates(actor)),
  };
});

// GM: an "Award Materials" entry in the Items sidebar header
Hooks.on("renderItemDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  const target = el?.querySelector(".header-actions") ?? el?.querySelector(".directory-header");
  if (!target || target.querySelector(".satchel-award-btn")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "satchel-award-btn";
  b.innerHTML = `<i class="fa-solid fa-gift"></i> Award Materials`;
  b.addEventListener("click", (e) => { e.preventDefault(); AwardApp.open(); });
  target.append(b);
});
