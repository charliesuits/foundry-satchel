/**
 * Satchel — the GM's award dialog.
 *
 * Drop items in from any compendium, the Items sidebar or the Compendium Library, set how many,
 * tick who gets them, and hand them out. Each recipient's matching stack grows instead of a new
 * one appearing, and a short chat card records what was given.
 */
import { MODULE_ID } from "./categories.js";
import { addToActor } from "./ops.js";

const HAM = foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

export class AwardApp extends HAM {
  static DEFAULT_OPTIONS = {
    id: "satchel-award",
    classes: ["satchel-app", "satchel-award"],
    tag: "div",
    window: { title: "Award Materials", icon: "fa-solid fa-gift", resizable: true },
    position: { width: 560, height: 620 },
  };
  static PARTS = { content: { template: `modules/${MODULE_ID}/templates/satchel.hbs` } };

  static open() {
    if (!game.user.isGM) return ui.notifications.warn("Only a GM can award items.");
    const open = foundry.applications.instances.get("satchel-award");
    if (open) { open.bringToFront(); return open; }
    return new AwardApp().render(true);
  }

  constructor(options) {
    super(options);
    this.entries = [];          // { key, data, qty }
    this.mode = "each";         // each | split
    this.recipients = new Set(this.defaultRecipients().map((a) => a.id));
  }

  candidates() {
    return game.actors.filter((a) => a.type === "group" || (a.type === "character" && a.hasPlayerOwner))
      .sort((a, b) => (a.type === "group" ? -1 : 0) - (b.type === "group" ? -1 : 0) || a.name.localeCompare(b.name));
  }
  defaultRecipients() {
    // whoever is on the current scene, else nobody
    const onScene = new Set((canvas?.tokens?.placeables ?? []).map((t) => t.actor?.id).filter(Boolean));
    return this.candidates().filter((a) => onScene.has(a.id) && a.type === "character");
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const host = this.element.querySelector(".sat-host");
    host.innerHTML = `<div class="sat-award">
      <div class="sat-drop"><i class="fa-solid fa-hand-holding-medical"></i> Drag items here — from compendiums, the Items sidebar or the Compendium Library.</div>
      <div class="sat-award-list"></div>
      <div class="sat-h">Give to</div>
      <div class="sat-recips"></div>
      <div class="sat-mode">
        <label><input type="radio" name="mode" value="each" ${this.mode === "each" ? "checked" : ""}> Each recipient gets the full amount</label>
        <label><input type="radio" name="mode" value="split" ${this.mode === "split" ? "checked" : ""}> Split the amount between them</label>
      </div>
      <footer><button type="button" data-do="clear"><i class="fa-solid fa-broom"></i> Clear</button>
        <button type="button" data-do="award" class="primary"><i class="fa-solid fa-gift"></i> Award</button></footer>
    </div>`;
    const root = host.firstElementChild;
    root.addEventListener("dragover", (e) => e.preventDefault());
    root.addEventListener("drop", (e) => this.onDrop(e));
    root.addEventListener("change", (e) => {
      if (e.target.name === "mode") this.mode = e.target.value;
      if (e.target.matches("[data-recip]")) e.target.checked ? this.recipients.add(e.target.dataset.recip) : this.recipients.delete(e.target.dataset.recip);
      if (e.target.matches("[data-qty]")) { const en = this.entries.find((x) => x.key === e.target.dataset.qty); if (en) en.qty = Math.max(1, e.target.valueAsNumber || 1); }
    });
    root.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) { this.entries = this.entries.filter((x) => x.key !== rm.dataset.rm); return this.draw(); }
      const b = e.target.closest("[data-do]");
      if (b?.dataset.do === "clear") { this.entries = []; return this.draw(); }
      if (b?.dataset.do === "award") return this.award();
    });
    this.root = root;
    this.draw();
  }

  draw() {
    const list = this.root.querySelector(".sat-award-list");
    list.innerHTML = this.entries.length ? this.entries.map((en) => `<div class="sat-arow">
        ${en.data.img ? `<img src="${esc(en.data.img)}" alt="">` : `<i class="fa-solid fa-box sat-noimg"></i>`}<span>${esc(en.data.name)}</span>
        <input type="number" min="1" value="${en.qty}" data-qty="${en.key}">
        <a data-rm="${en.key}" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></a></div>`).join("")
      : `<div class="sat-empty">Nothing yet.</div>`;
    const cands = this.candidates();
    this.root.querySelector(".sat-recips").innerHTML = cands.length ? cands.map((a) => `<label class="sat-recip">
        <input type="checkbox" data-recip="${a.id}" ${this.recipients.has(a.id) ? "checked" : ""}>
        <img src="${esc(a.img)}" alt=""><span>${esc(a.name)}</span>${a.type === "group" ? `<em>party stash</em>` : ""}</label>`).join("")
      : `<div class="sat-empty">No player characters or party actors in this world.</div>`;
  }

  async onDrop(e) {
    e.preventDefault();
    let data;
    try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
    if (data?.type !== "Item") return ui.notifications.warn("Only items can be awarded.");
    const item = await Item.implementation.fromDropData(data);
    if (!item) return;
    const src = item.toObject();
    const key = `${src.type}|${src.name.toLowerCase()}`;
    const have = this.entries.find((x) => x.key === key);
    if (have) have.qty += 1;
    else this.entries.push({ key, data: src, qty: Math.max(1, src.system?.quantity ?? 1) });
    this.draw();
  }

  async award() {
    const who = [...this.recipients].map((id) => game.actors.get(id)).filter(Boolean);
    if (!this.entries.length) return ui.notifications.warn("Drag some items in first.");
    if (!who.length) return ui.notifications.warn("Tick at least one recipient.");
    const lines = [];
    for (const en of this.entries) {
      const shares = this.mode === "split"
        ? who.map((_, i) => Math.floor(en.qty / who.length) + (i < en.qty % who.length ? 1 : 0))
        : who.map(() => en.qty);
      for (let i = 0; i < who.length; i++) if (shares[i] > 0) await addToActor(who[i], en.data, shares[i]);
      lines.push(this.mode === "split"
        ? `${esc(en.data.name)}: ${who.map((a, i) => `${esc(a.name)} ${shares[i]}`).filter((_, i) => shares[i]).join(", ")}`
        : `${en.qty > 1 ? `${en.qty} × ` : ""}${esc(en.data.name)}`);
    }
    if (game.settings.get(MODULE_ID, "announceTransfers")) {
      ChatMessage.implementation.create({
        content: `<div class="satchel-chat"><p><b>Awarded</b>${this.mode === "each" ? ` to ${who.map((a) => esc(a.name)).join(", ")}` : ""}:</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>`,
      });
    }
    ui.notifications.info(`Awarded ${this.entries.length} item${this.entries.length === 1 ? "" : "s"} to ${who.length} recipient${who.length === 1 ? "" : "s"}.`);
    this.entries = [];
    this.draw();
  }
}
