/**
 * A small dropdown / context menu with nested submenus, used by the Satchel window.
 * items: [{ label, icon, act?, sub?: items, sep?: true, disabled?: bool, hint? }]
 */
let _open = null;

export function closeMenu() {
  _open?.remove();
  _open = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}
function onOutside(e) { if (_open && !_open.contains(e.target)) closeMenu(); }
function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } }

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

function build(items) {
  const ul = document.createElement("div");
  ul.className = "sat-menu-list";
  for (const it of items.filter(Boolean)) {
    if (it.sep) { ul.append(Object.assign(document.createElement("hr"))); continue; }
    if (it.heading) { const h = document.createElement("div"); h.className = "sat-menu-h"; h.textContent = it.heading; ul.append(h); continue; }
    const row = document.createElement("div");
    row.className = `sat-mi${it.sub ? " has-sub" : ""}${it.disabled ? " disabled" : ""}`;
    row.innerHTML = `<i class="${esc(it.icon || "")}"></i><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ""}${it.sub ? `<i class="fa-solid fa-caret-right sat-caret"></i>` : ""}`;
    if (it.sub) {
      const subItems = it.sub.filter(Boolean);
      const sub = build(subItems.length ? subItems : [{ label: "Nothing here", disabled: true }]);
      sub.classList.add("sat-sub");
      row.append(sub);
    } else if (!it.disabled) {
      row.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.act?.(); });
    }
    ul.append(row);
  }
  return ul;
}

/** Open a menu at page coordinates, or under an element. */
export function openMenu(items, at) {
  closeMenu();
  const m = build(items);
  m.classList.add("sat-menu");
  document.body.append(m);
  let x, y;
  if (at instanceof HTMLElement) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
  else ({ x, y } = at);
  const { width, height } = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 8))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 8))}px`;
  // submenus that would run off the right edge open to the left
  if (x + width * 2 > window.innerWidth) m.classList.add("flip");
  _open = m;
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });
  return m;
}

/** Ask for a line of text. Resolves to the string, or null when cancelled. */
export async function promptText(title, label, value = "", hint = "") {
  const id = `sat-${foundry.utils.randomID()}`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<div class="form-group"><label for="${id}">${esc(label)}</label><input id="${id}" name="v" type="text" value="${esc(value)}" autofocus></div>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}`,
    ok: { label: "OK", callback: (event, button) => button.form.elements.v.value },
    rejectClose: false,
  }).catch(() => null);
}

/** Ask for a whole number. Resolves to the number, or null. */
export async function promptNumber(title, label, value = 1, max = null) {
  const id = `sat-${foundry.utils.randomID()}`;
  const v = await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<div class="form-group"><label for="${id}">${esc(label)}</label><input id="${id}" name="v" type="number" min="1" ${max ? `max="${max}"` : ""} step="1" value="${value}" autofocus></div>`,
    ok: { label: "OK", callback: (event, button) => button.form.elements.v.valueAsNumber },
    rejectClose: false,
  }).catch(() => null);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}
