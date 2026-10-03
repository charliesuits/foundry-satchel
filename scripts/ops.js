/**
 * Satchel — inventory operations.
 *
 * Everything that changes items lives here so the window, the award dialog, macros and the
 * GM socket all share one implementation. Transfers to an actor the user does not own are
 * handed to the active GM over the module socket.
 */
import { MODULE_ID, PHYSICAL_TYPES, categoryOf } from "./categories.js";

export const SOCKET = `module.${MODULE_ID}`;

/** A name reduced to what matters for "is this the same thing": case, spacing and "(x3)"-style counts ignored. */
export function stackName(name) {
  return String(name || "").toLowerCase()
    .replace(/\s*[([]\s*(?:x\s*)?\d+\s*[)\]]\s*$/i, "")   // "Silverleaf (x3)" / "Silverleaf [3]"
    .replace(/^\d+\s*x\s+/i, "")                          // "3x Silverleaf"
    .replace(/\s+/g, " ").trim();
}
/** The key two items must share to be merged into one stack. */
export function stackKey(item) {
  return `${item.type}|${item.system?.type?.value ?? ""}|${stackName(item.name)}|${item.system?.container ?? ""}`;
}
const stackable = (item) => PHYSICAL_TYPES.has(item.type) && item.type !== "container";

/** The physical items on an actor, containers included. */
export function inventoryOf(actor) {
  return (actor?.items?.contents ?? [...(actor?.items ?? [])]).filter((i) => PHYSICAL_TYPES.has(i.type));
}

// ───────────────────────────────────────────── quantities
export async function setQuantity(item, qty) {
  qty = Math.max(0, Math.floor(Number(qty) || 0));
  if (qty === item.system.quantity) return;
  if (qty === 0 && game.settings.get(MODULE_ID, "deleteAtZero")) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Used up" },
      content: `<p>Remove <b>${foundry.utils.escapeHTML(item.name)}</b> from the inventory?</p>`,
      yes: { label: "Remove" }, no: { label: "Keep at 0" },
    });
    if (ok) return item.delete();
  }
  return item.update({ "system.quantity": qty });
}

/** Split `count` off a stack into a new stack (same container). */
export async function splitStack(item, count) {
  count = Math.floor(Number(count) || 0);
  const q = item.system.quantity ?? 1;
  if (count <= 0 || count >= q) return;
  const data = item.toObject();
  delete data._id;
  data.system.quantity = count;
  await item.update({ "system.quantity": q - count });
  return item.parent.createEmbeddedDocuments("Item", [data]);
}

// ───────────────────────────────────────────── merging
/** Groups of duplicate stacks on an actor: [{ keep, merge:[...], total }]. */
export function findDuplicates(actor, items = inventoryOf(actor)) {
  const groups = new Map();
  for (const it of items) {
    if (!stackable(it)) continue;
    const k = stackKey(it);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(it);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // keep the stack that has been customised the most (description, then largest)
    list.sort((a, b) => (String(b.system.description?.value || "").length - String(a.system.description?.value || "").length)
      || ((b.system.quantity ?? 1) - (a.system.quantity ?? 1)));
    const [keep, ...merge] = list;
    out.push({ keep, merge, total: list.reduce((s, i) => s + (i.system.quantity ?? 1), 0) });
  }
  return out;
}
export async function mergeGroups(actor, groups) {
  const updates = [], deletes = [];
  for (const g of groups) {
    const tags = new Set(g.keep.flags?.[MODULE_ID]?.tags ?? []);
    for (const m of g.merge) for (const t of m.flags?.[MODULE_ID]?.tags ?? []) tags.add(t);
    updates.push({ _id: g.keep.id, "system.quantity": g.total, [`flags.${MODULE_ID}.tags`]: [...tags] });
    deletes.push(...g.merge.map((m) => m.id));
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes);
  return deletes.length;
}

// ───────────────────────────────────────────── categories, tags, containers
export async function setCategory(actor, ids, category) {
  const cat = category || null;
  return actor.updateEmbeddedDocuments("Item", ids.map((_id) => ({ _id, [`flags.${MODULE_ID}.category`]: cat })));
}
export async function addTags(actor, ids, tags) {
  const clean = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return actor.updateEmbeddedDocuments("Item", ids.map((_id) => {
    const cur = actor.items.get(_id)?.flags?.[MODULE_ID]?.tags ?? [];
    return { _id, [`flags.${MODULE_ID}.tags`]: [...new Set([...cur, ...clean])] };
  }));
}
export async function removeTag(item, tag) {
  const cur = item.flags?.[MODULE_ID]?.tags ?? [];
  return item.update({ [`flags.${MODULE_ID}.tags`]: cur.filter((t) => t !== tag) });
}
/** Put items into a container (null = take out). Stacks with the same name already in there are merged. */
export async function moveToContainer(actor, ids, containerId) {
  const cid = containerId || null;
  const ok = ids.filter((id) => id !== cid && !isInside(actor, cid, id));
  await actor.updateEmbeddedDocuments("Item", ok.map((_id) => ({ _id, "system.container": cid })));
  // tidy up: merge anything that now duplicates a stack in its new home
  const moved = new Set(ok);
  const groups = findDuplicates(actor).filter((g) => [g.keep, ...g.merge].some((i) => moved.has(i.id)));
  if (groups.length) await mergeGroups(actor, groups);
}
/** Would putting `id` into `containerId` put a container inside itself? */
function isInside(actor, containerId, id) {
  let c = containerId ? actor.items.get(containerId) : null;
  for (let guard = 0; c && guard < 20; guard++) {
    if (c.id === id) return true;
    c = c.system.container ? actor.items.get(c.system.container) : null;
  }
  return false;
}

// ───────────────────────────────────────────── adding
/**
 * Add item data to an actor, merging with an existing loose stack of the same thing.
 * @param {Actor} actor
 * @param {object} data  item source data
 * @param {number} qty
 */
export async function addToActor(actor, data, qty = data.system?.quantity ?? 1) {
  qty = Math.max(1, Math.floor(Number(qty) || 1));
  if (data.type !== "container") {
    const key = `${data.type}|${data.system?.type?.value ?? ""}|${stackName(data.name)}|`;
    const existing = inventoryOf(actor).find((i) => stackKey(i) === key);
    if (existing) return existing.update({ "system.quantity": (existing.system.quantity ?? 1) + qty });
  }
  const d = foundry.utils.deepClone(data);
  delete d._id;
  delete d.folder;
  delete d.sort;
  delete d.ownership;
  foundry.utils.setProperty(d, "system.quantity", qty);
  foundry.utils.setProperty(d, "system.container", null);
  return (await actor.createEmbeddedDocuments("Item", [d]))[0];
}

// ───────────────────────────────────────────── transfers
/**
 * Move items (or part of a stack) from one actor to another.
 * @param {Actor} from
 * @param {Actor} to
 * @param {{id:string, qty?:number}[]} list  qty omitted = the whole stack
 */
export async function transfer(from, to, list, { announce = true } = {}) {
  if (!from || !to || from === to || !list.length) return;
  if (!(from.isOwner && to.isOwner)) {
    const gm = game.users.activeGM;
    if (!gm) return ui.notifications.warn("A GM needs to be logged in to hand items to a character you don't own.");
    game.socket.emit(SOCKET, { action: "transfer", from: from.uuid, to: to.uuid, list, announce, user: game.user.id });
    return;
  }
  const lines = [];
  for (const { id, qty } of list) {
    const item = from.items.get(id);
    if (!item) continue;
    const have = item.system.quantity ?? 1;
    const n = qty == null ? have : Math.min(have, Math.max(1, Math.floor(qty)));
    if (item.type === "container") {
      // copies the container and everything in it, with fresh ids that still point at each other
      const created = await Item.implementation.createWithContents([item]);
      if (!created?.length) continue;
      await to.createEmbeddedDocuments("Item", created, { keepId: true });
      await item.delete({ deleteContents: true });
    } else {
      await addToActor(to, item.toObject(), n);
      if (n >= have) await item.delete(); else await item.update({ "system.quantity": have - n });
    }
    lines.push(`${n > 1 ? `${n} × ` : ""}${foundry.utils.escapeHTML(item.name)}`);
  }
  if (announce && lines.length && game.settings.get(MODULE_ID, "announceTransfers")) {
    ChatMessage.implementation.create({
      speaker: ChatMessage.implementation.getSpeaker({ actor: from }),
      content: `<div class="satchel-chat"><p><b>${foundry.utils.escapeHTML(from.name)}</b> gave <b>${foundry.utils.escapeHTML(to.name)}</b>:</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>`,
    });
  }
}

/** Socket handler: only the active GM acts on requests. */
export function registerSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (!game.user.isActiveGM) return;
    if (msg?.action === "transfer") {
      const [from, to] = await Promise.all([fromUuid(msg.from), fromUuid(msg.to)]);
      const requester = game.users.get(msg.user);
      // the requester must own the actor the items come from
      if (!from || !to || !requester || !from.testUserPermission(requester, "OWNER")) return;
      await transfer(from, to, msg.list, { announce: msg.announce });
    }
  });
}

// ───────────────────────────────────────────── helpers for the view
/** Weight of one row in the actor's weight units (containers report their contents too). */
export function rowWeight(item) {
  const sys = item.system;
  if (!sys?.weight) return 0;
  const w = (sys.quantity ?? 1) * (Number(sys.weight.value) || 0);
  return Number.isFinite(w) ? w : 0;
}
/** Price of one of this item, in gp. */
export function unitPriceGp(item) {
  const p = item.system?.price;
  if (!p?.value) return 0;
  const rate = CONFIG.DND5E?.currencies?.[p.denomination || "gp"]?.conversion;
  const conv = rate ? 1 / rate : ({ pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 }[p.denomination || "gp"] ?? 1);
  return Number(p.value) * conv;
}
export { categoryOf };
