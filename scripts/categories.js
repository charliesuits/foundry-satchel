/**
 * Satchel — categories.
 *
 * Every item lands in one category. A category chosen by hand (stored on the item as a flag)
 * always wins; otherwise the item's dnd5e type and subtype decide, and for loose materials the
 * item's name decides (Silverleaf → Herbs & Plants, Owlbear Claw → Monster Parts).
 */
export const MODULE_ID = "satchel-inventory";

export const BUILTIN = [
  { id: "herbs", label: "Herbs & Plants", icon: "fa-solid fa-leaf" },
  { id: "monster", label: "Monster Parts", icon: "fa-solid fa-dragon" },
  { id: "minerals", label: "Ores & Minerals", icon: "fa-solid fa-mountain" },
  { id: "reagents", label: "Reagents & Components", icon: "fa-solid fa-flask-vial" },
  { id: "materials", label: "Crafting Materials", icon: "fa-solid fa-cubes" },
  { id: "potions", label: "Potions & Poisons", icon: "fa-solid fa-flask" },
  { id: "food", label: "Food & Drink", icon: "fa-solid fa-drumstick-bite" },
  { id: "ammo", label: "Ammunition", icon: "fa-solid fa-bullseye" },
  { id: "scrolls", label: "Scrolls, Wands & Rods", icon: "fa-solid fa-scroll" },
  { id: "magic", label: "Magic Items", icon: "fa-solid fa-wand-sparkles" },
  { id: "weapons", label: "Weapons", icon: "fa-solid fa-khanda" },
  { id: "armor", label: "Armor & Clothing", icon: "fa-solid fa-shirt" },
  { id: "tools", label: "Tools & Kits", icon: "fa-solid fa-screwdriver-wrench" },
  { id: "gear", label: "Adventuring Gear", icon: "fa-solid fa-toolbox" },
  { id: "valuables", label: "Treasure & Valuables", icon: "fa-solid fa-gem" },
  { id: "trade", label: "Trade Goods", icon: "fa-solid fa-scale-balanced" },
  { id: "containers", label: "Containers", icon: "fa-solid fa-box-open" },
  { id: "junk", label: "Junk", icon: "fa-solid fa-trash-can" },
  { id: "other", label: "Other", icon: "fa-solid fa-circle-question" },
];
export const BUILTIN_BY_ID = Object.fromEntries(BUILTIN.map((c) => [c.id, c]));
const CUSTOM_ICON = "fa-solid fa-tag";

// Name keywords, checked as whole words (and simple plurals)
const KEYWORDS = {
  herbs: ["herb", "leaf", "leaves", "root", "flower", "petal", "moss", "mushroom", "fungus", "fungi", "cap", "bark", "seed", "berry", "berries",
    "sap", "weed", "blossom", "lichen", "thistle", "nightshade", "mandrake", "ginseng", "lotus", "wort", "bloom", "vine", "fern", "pollen", "spore",
    "nettle", "lily", "rose", "sage", "thyme", "mint", "clover", "kelp", "algae", "reed", "grass", "shrub", "sprig", "stem", "bulb", "tuber",
    "silverleaf", "wolfsbane", "belladonna", "hemlock", "foxglove", "yarrow", "chamomile", "lavender", "garlic", "ivy", "cactus", "orchid",
    "truffle", "willow", "nut", "acorn", "pinecone", "resin", "nectar", "honeycomb", "plant", "frond", "tendril", "bramble", "thorn"],
  monster: ["hide", "pelt", "fang", "tooth", "teeth", "claw", "talon", "scale", "horn", "bone", "blood", "ichor", "eye", "eyeball", "heart",
    "gland", "venom", "feather", "wing", "tail", "tusk", "carapace", "chitin", "sinew", "skull", "fur", "egg", "antler", "hoof", "mandible",
    "stinger", "tentacle", "brain", "liver", "tongue", "spine", "quill", "membrane", "marrow", "bile", "slime", "ooze", "gizzard", "musk",
    "trophy", "remains", "carcass", "mane", "beak", "webbing"],
  minerals: ["ore", "ingot", "nugget", "crystal", "quartz", "stone", "rock", "iron", "silver", "gold", "copper", "tin", "lead", "mithral",
    "mithril", "adamantine", "adamantium", "obsidian", "sulfur", "sulphur", "salt", "saltpeter", "coal", "charcoal", "flint", "clay",
    "sand", "marble", "granite", "slate", "geode", "mercury", "quicksilver", "cobalt", "platinum", "electrum", "bronze", "steel", "chalk",
    "limestone", "shale", "meteorite", "lodestone", "gem", "gemstone", "ruby", "sapphire", "emerald", "diamond", "amethyst", "topaz", "opal", "pearl", "jade", "onyx", "garnet", "amber", "jasper", "agate", "malachite", "turquoise", "peridot", "citrine", "moonstone", "bloodstone"],
  reagents: ["reagent", "component", "catalyst", "powder", "dust", "essence", "oil", "ash", "ashes", "ink", "tincture", "extract", "solvent",
    "acid", "alkahest", "philter", "salve", "distillate", "residue", "mote", "residuum", "arcane", "vial", "wax"],
};
const RX = Object.fromEntries(Object.entries(KEYWORDS).map(([k, words]) =>
  [k, new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:s|es)?\\b`, "i")]));

/** Which keyword family a name belongs to, or null. */
export function keywordCategory(name) {
  const n = String(name || "");
  for (const k of ["herbs", "monster", "minerals", "reagents"]) if (RX[k].test(n)) return k;
  return null;
}

const ARMOR = new Set(["light", "medium", "heavy", "shield", "natural", "clothing"]);

/** The automatic category for an item (ignores the manual override). */
export function autoCategory(item) {
  const sys = item.system ?? {};
  const t = item.type;
  const sub = sys.type?.value;
  const magical = !!(sys.properties?.has?.("mgc") || (sys.rarity && sys.rarity !== "" && sys.rarity !== "common" && sys.rarity !== "none"));
  switch (t) {
    case "container": return "containers";
    case "weapon": return sub === "ammo" ? "ammo" : magical ? "magic" : "weapons";
    case "tool": return "tools";
    case "equipment":
      if (ARMOR.has(sub)) return magical ? "magic" : "armor";
      if (["wand", "rod"].includes(sub)) return "scrolls";
      return magical ? "magic" : "gear";
    case "consumable":
      if (sub === "potion" || sub === "poison") return "potions";
      if (sub === "food") return "food";
      if (sub === "ammo") return "ammo";
      if (["scroll", "wand", "rod"].includes(sub)) return "scrolls";
      return keywordCategory(item.name) ?? (magical ? "magic" : "gear");
    case "loot":
      if (sub === "gem" || sub === "art" || sub === "treasure") return "valuables";
      if (sub === "trade") return keywordCategory(item.name) ?? "trade";
      if (sub === "junk") return "junk";
      if (sub === "material" || sub === "resource") return keywordCategory(item.name) ?? "materials";
      if (sub === "gear") return "gear";
      return keywordCategory(item.name) ?? (magical ? "magic" : "other");
    default: return keywordCategory(item.name) ?? "other";
  }
}

/** The category id an item is shown under: the manual choice if any, else the automatic one. */
export function categoryOf(item) {
  const manual = item.flags?.[MODULE_ID]?.category;
  return manual || autoCategory(item);
}

/** Display info for a category id (built-in or custom — a custom id is its own label). */
export function categoryInfo(id) {
  return BUILTIN_BY_ID[id] ?? { id, label: id, icon: CUSTOM_ICON, custom: true };
}

/** Items that hold other things are always shown with their contents underneath. */
export const PHYSICAL_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);
