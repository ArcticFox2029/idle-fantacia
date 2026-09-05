/* Engine + UI. Design decisions, per the owner's spec (2026-08-15):
 * - THE CLOCK ONLY RUNS WHILE YOU ARE HERE. Closing the browser stops the calendar dead: leave on
 *   1Y-4M-27D and you come back to 1Y-4M-27D. That has always been true and still is.
 *   🎯 [amended 2026-08-21] What changed is that being away now PAYS, on every platform — see
 *   applyOfflineProgress(). Offline is an accumulator held beside the calendar, not a span of game
 *   time, and everything it excludes follows from that: a crop ripens on grown-seconds, rent falls
 *   due on a date, tax accrues per day, and none of them can be settled by time that never passed.
 *   Mastery and combat are excluded on the owner's own instruction. Balance is defended by
 *   offline_sim.mjs and the rules by offline_rules.mjs, rather than by judgement.
 * - Saves: manual button + auto every AUTOSAVE_MINUTES + snapshot on tab close/hide.
 *   Two profile slots, create/continue/delete. Old saves migrate forward, never wiped.
 * - One activity at a time (Melvor-style): a skill action OR a hunt, never both.
 * - HP is always visible in the topbar; it drains in combat and self-regenerates slowly
 *   whenever the player is NOT hunting (owner: "ไปเล่นโหมดอื่นรอ hp จะค่อยๆ ฟื้น").
 * - The logic loop runs at 4Hz; smooth bar motion comes from CSS transitions. */

"use strict";

/* ---------- Profile storage & migration ---------- */

/* Renaming the game does NOT rename this key — it is the address of every save already
 * on the player's machine, and changing it would orphan them all. */
const SLOT_KEY = (n) => `idlemyth_profile_${n}`;

/* ---------- Where saves live ----------
 * Two backends, chosen once at boot:
 *
 *   "server" — server.py is running, so saves are files in idle-fantacia/saves/. This is the good case:
 *              the folder can be backed up, copied between machines and inspected, and nothing
 *              depends on the browser's willingness to store anything. It is also what makes the
 *              game work in Brave, which refuses page storage outright on a file:// page.
 *   "local"  — nobody is serving, so fall back to localStorage exactly as before, which keeps
 *              double-clicking index.html working.
 *
 * The rest of the engine stays SYNCHRONOUS. Every slot is read into `slotCache` during boot and
 * every write updates the cache immediately and pushes to disk in the background, so readSlot and
 * writeSlot keep the signatures ~40 call sites already expect. A push that fails surfaces as a
 * toast rather than silently diverging from what is on screen. */
let saveBackend = "local";
const slotCache = {};          // n -> raw JSON string (authoritative while playing)
let pendingWrites = 0;

/* ---------- 🌐 ภาษา ----------
 * The tables i18n.js translates in place. Listed here rather than discovered, so adding a table to
 * data.js without adding it here shows up as one screen staying Thai — obvious — instead of as a
 * walk that silently reaches into something it should not.
 */
const I18N_TABLES = () => [
  MONTH_NAMES, SEASONS, EQUIP_SLOTS, ITEMS, SHOP, SKILLS, LOCATIONS, SEED_SHOP,
  MOMENTUM_TIERS, EVENTS, VILLAGERS, REL_STAGES, REL_BONUS, CHILD_TRACKS, TITLES,
  ACHIEVEMENTS, ARMOR_SETS, SLAYER_TIERS, SLAYER_REWARDS, ELITE_MODES,
  COMBAT_STATS, AUTO_EAT_OPTIONS, PET_SPECIES, PET_GRADES, COMPANY_SIZES, COMPANIES,
  SHOP_TYPES, SHOP_TIERS, STAFF_ROLES, PROPERTIES, FURNITURE, TAX_KINDS,
  GUILD_TIERS, GUILD_RANKS, NOTIF_KINDS, CRYPTOS,
];
/* 🐛 [audit-qa 2026-08-28] AUTO_CATEGORIES used to be on that list and must NOT go back on it.
 * Its `name` is not display text — it is the bag's IDENTITY. `categoryOf()` returns it, `invTab`
 * holds it, and `P.itemCat[itemId]` writes it into the save. Translating those names in place
 * therefore rewrote the key while the copies of it did not move: with the ปลา tab open, switching
 * to English left invTab = "ปลา" against a tab now called "Fish", so the bag rendered
 * "หมวดนี้ยังว่าง" with three fish in it; and an item filed by hand in English kept "Food" in the
 * save, which no Thai tab ever shows again. The names are translated at DISPLAY time through T()
 * instead — see activeTabs()/catOptions() — so the identity stays Thai in every language. */

/* Short name for the one call every hand-written UI string goes through. */
function T(s) { return typeof I18N === "undefined" ? s : I18N.t(s); }

function currentLang() { return typeof I18N === "undefined" ? "th" : I18N.lang; }

/* Labels that live in index.html rather than being built by JS. Re-stamped on every switch, since
 * nothing else ever rewrites them. */
const STATIC_LABELS = [
  ["#btn-save", "💾 ", "เซฟตอนนี้"],
  ["#btn-exit", "", "ออกไปหน้าโปรไฟล์"],
];
function applyStaticLabels() {
  for (const [sel, prefix, thai] of STATIC_LABELS) {
    const el = typeof document !== "undefined" && document.querySelector ? document.querySelector(sel) : null;
    if (el) el.textContent = prefix + T(thai);
  }
}

function setLang(next) {
  if (typeof I18N === "undefined") return;
  I18N.apply(next, I18N_TABLES());
  applyStaticLabels();
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = next === "en" ? "en" : "th";
  }
  if (P) { buildSidebar(); renderView(); renderInventory(); refreshSidebar(); updateTopbar(); }
}

/* Applied before the first render so nothing is ever drawn in the wrong language and then
 * corrected — a flash of Thai on an English save reads as a bug. */
function initLang() {
  if (typeof I18N === "undefined") return;
  I18N.apply(I18N.saved(), I18N_TABLES());
  applyStaticLabels();
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = I18N.lang === "en" ? "en" : "th";
  }
}

async function initStorage() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    if (r.ok) {
      const all = await (await fetch("api/saves", { cache: "no-store" })).json();
      for (const n of Object.keys(slotCache)) delete slotCache[n];
      for (const [n, raw] of Object.entries(all)) slotCache[n] = raw;
      saveBackend = "server";
      const info = r.json ? await r.json().catch(() => null) : null;
      /* Newest art mtime, appended to every image URL below. Boot awaits this before the first
       * render, so no picture is ever requested without the stamp the server just gave us. */
      if (info?.art) ART_STAMP = String(info.art);
      console.log("[save] เก็บลงโฟลเดอร์:", info?.saveDir || "idle-fantacia/saves/");
      await adoptBrowserSaves();
      return;
    }
  } catch (e) {
    // No server (opened as a file, or the launcher is not running) — that is a normal case.
  }
  saveBackend = "local";
  ART_STAMP = "";   // the stamp is the server's to give; without one there is nothing to claim
}

/* Move any progress still living in this browser into the save folder. */
async function adoptBrowserSaves() {
  const moved = [];
  for (let n = 1; n <= PROFILE_SLOTS; n++) {
    if (slotCache[n]) continue;                 // a file already holds this slot — leave it alone
    let raw = null;
    try { raw = localStorage.getItem(SLOT_KEY(n)); } catch (e) { /* storage blocked; nothing to move */ }
    if (!raw) continue;
    let name = `ช่อง ${n}`;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.v || !parsed.xp) continue;   // not one of ours
      name = parsed.name || name;
    } catch (e) { continue; }
    try {
      const put = await fetch(`api/save/${n}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: raw,
      });
      if (!put.ok) continue;
      slotCache[n] = raw;
      moved.push(name);
    } catch (e) { /* server went away mid-move; the browser copy is still there */ }
  }
  if (!moved.length) return;
  // The browser copy is deliberately LEFT in place rather than cleared: if anything about the
  // move was wrong, the original is still there to try again from.
  toast(`📥 ย้ายเซฟจากเบราว์เซอร์มาเก็บเป็นไฟล์แล้ว: ${moved.join(", ")}`, "levelup");
}

/* Push one slot to disk. Deliberately not awaited by the caller: a save must feel instant, and
 * the cache is already correct by the time this starts. */
function pushSlot(n, raw) {
  pendingWrites++;
  fetch(`api/save/${n}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: raw,
  }).then(async (r) => {
    if (!r.ok) {
      const msg = await r.json().catch(() => ({}));
      toast(`💾❌ เขียนไฟล์เซฟไม่สำเร็จ: ${msg.error || r.status}`, "warn");
    }
  }).catch((e) => {
    toast(`💾❌ ติดต่อตัวเก็บเซฟไม่ได้: ${e.message} — ข้อมูลยังอยู่ในหน้านี้ อย่าเพิ่งปิด`, "warn");
  }).finally(() => { pendingWrites--; });
}

function emptyEquip() {
  const eq = {};
  for (const s of EQUIP_SLOTS) eq[s.id] = null;
  return eq;
}

function freshProfile(name) {
  return {
    v: GAME_VERSION,
    name,
    createdAt: Date.now(),
    lastSavedAt: null,
    gold: 0,
    xp: { wc: 0, fi: 0, mi: 0, ck: 0, sm: 0, fm: 0, lw: 0, th: 0, fa: 0 },
    mastery: {},            // "skillId:actionId" -> mastery xp (per-slot stacking)
    cb: { atk: 0, defs: 0, vit: 0 },  // separate trainable combat stat pools
    trainFocus: "atk",      // which stat hunt XP pours into (owner: click to choose)
    eliteMode: "normal",    // difficulty tier selected for hunts
    achieved: {},           // achievementId -> true (permanent perks)
    stats: { actions: 0, kills: 0, bosses: 0, cooked: 0, crafted: 0,
             steals: 0, goldEarned: 0, junkSold: 0, harvests: 0 },
    seenFish: {},           // fish itemId -> true, for the species achievement
    seenCrops: {},          // farming actionId -> true, for the botanist achievement
    /* Which species have EVER been caught. Companions themselves are released on rebirth
     * (owner, 2026-08-17: "ผู้เล่นต้องหาใหม่ แล้วก็เลี้ยงใหม่"), but the record of having found
     * them is collection progress, not power — losing that would punish exploring. */
    seenPets: {},
    /* One entry per owned plot. `grown` counts SECONDS OF PLAY, not wall-clock: a garden keeps
     * growing while the tab is open and pauses the moment it closes, which is the same
     * online-only contract every other job in this game follows. */
    plots: Array(PLOTS_START).fill(null),   // null | { actionId, grown }
    hp: playerMaxHp(1),
    equip: emptyEquip(),    // one key per EQUIP_SLOTS entry + food
    upgrades: {},           // shopId -> true
    kills: {},
    legacyPerk: {},        // perks kept from systems that were replaced — see migrate v28→v29
    slayer: {},             // "loc:idx:tier" -> true, one permanent stat each; survives rebirth
    slayerKills: {},        // "loc:idx:tier" -> kills made IN that mode, counted from zero
    cats: [],               // user-defined inventory tab names
    itemCat: {},            // itemId -> tab name
    inv: {},
    slots: [],              // parallel jobs; length capped by purchased multi-processing
    trader: null,           // {until: epoch ms, offers: [{item,n,price,sold}]} while the stall is up
    food: Array(FOOD_SLOTS).fill(null),  // eaten in order; slot 2 starts when slot 1 runs dry
    autoEatPct: AUTO_EAT_DEFAULT,
    petXpShare: PET_XP_DEFAULT,   // slice of combat XP diverted to the companion
    pets: [],               // [{species, xp, hp}] — companions caught from monsters
    activePet: null,        // index into pets, or null
    playMs: 0,              // total time with the game open, for the statistics page
    gameDays: 0,            // Mythwood's own clock, in days — see GAME_DAY_SECONDS in data.js
    rebirths: 0,
    rebirthFloor: { atk: 1, defs: 1, vit: 1 },   // no rebirth may drop a stat below the last one
    rebirthLog: [],         // [{ year, month, day, before, after }] for the history panel
    quests: [],             // the village board; stocked by refreshQuests on the first day
    rel: {},                // villagerId -> { aff, floor, gaveDay }
    kids: [],               // [{ id, name, age, stats, edu }] — age counts up, never derived
    spouse: null,           // villager id, or null
    bank: { slips: [], sinceDay: 0, yearInterest: 0 },   // each deposit is its own dated slip
    market: {},             // companyId -> current price per share (persisted: it is world state)
    holdings: {},           // companyId -> { shares, cost }  (cost = gold paid, for realised P/L)
    coins: {},              // coinId -> { units, cost }  (cost = AVERAGE paid per unit — see buyCoin)
    crypto: {},             // coinId -> current price; absent means it has never moved off `base`
    shops: [],              // your own businesses — see runShopDay
    brand: 0,               // best customer base any shop of yours ever reached
    estates: [],            // property you own and rent out — see runEstatesDay
    guild: null,            // 🏹 the hunter institute, once built — see runGuildDay
    karma: { xp: 0, gold: 0 },  // banked per rebirth, scaled by the level that run reached
    calendarReset: false,   // true once a rebirth has restarted this save's calendar
    gardener: null,         // { untilDay, actionId } while someone is hired to work the plots
    divAccrual: {},         // companyId -> sub-gold dividend remainder, so frequent payers add up
    tax: { yearProfit: 0, paidTotal: 0, debtSinceDay: null, lastBill: null, bills: [], prepaid: {} },
    ledger: [],             // recent money events, newest first — the investment page reads it
    dead: null,             // { day, reason } once a tax debt runs out of grace
    /* Screen preferences that belong to the RUN, not the browser: a filter re-ticked on every
     * visit is a filter that does not work. Kept in the profile so it travels with the save
     * file between machines and browsers, like everything else about a run. */
    ui: { hideOwnedShop: false, hideDoneAch: false },
    /* 🎯 [owner 2026-08-18] "อาจมี popup guide สอนครั้งแรกเท่านั้น" — shown once on a genuinely NEW
     * character (see migrate v35->v36: an existing save is marked as already seen, so nobody's
     * ongoing run gets an unexpected popup). Scoped to the one thing game-playtester's two runs
     * both found nobody could discover on their own: autoheal needs a food slot assigned. */
    seenIntro: false,
    leftAt: null,           // when the app was last closed/backgrounded — drives offline progress
  };
}

/* Chain migration: every old version steps forward one release at a time. */
function migrate(p) {
  if (p.v === 1) {
    p.v = 2;
    for (const k of ["mastery", "upgrades", "kills", "itemCat"]) p[k] = p[k] || {};
    p.cats = p.cats || [];
    p.cbXp = p.cbXp || 0;
    p.hp = p.hp ?? playerMaxHp(1);
    p.equip = p.equip || { weapon: null, food: null };
    if (p.active && !p.active.type) p.active = { type: "skill", ...p.active };
  }
  if (p.v === 2) {
    p.v = 3;
    p.xp.mi = p.xp.mi || 0;
    const eq = emptyEquip();
    eq.weapon = p.equip?.weapon || null;
    eq.food = p.equip?.food || null;
    p.equip = eq;
  }
  if (p.v === 3) {
    p.v = 4;
    for (const k of ["fm", "lw", "th"]) p.xp[k] = p.xp[k] || 0;
  }
  if (p.v === 4) {
    p.v = 5;
    // Old single combat pool splits evenly across the three new stats.
    const third = Math.floor((p.cbXp || 0) / 3);
    p.cb = { atk: third, defs: third, vit: third };
    p.trainFocus = "atk";
    delete p.cbXp;
  }
  if (p.v === 5) {
    p.v = 6;
    p.eliteMode = "normal";
  }
  if (p.v === 6) {
    p.v = 7;
    p.achieved = p.achieved || {};
    p.stats = p.stats || { actions: 0, kills: 0, bosses: 0, cooked: 0, crafted: 0,
                           steals: 0, goldEarned: 0, junkSold: 0 };
    p.seenFish = p.seenFish || {};
  }
  if (p.v === 7) {
    p.v = 8;
    // The single active job becomes slot 0; combat never survives a reload anyway.
    p.slots = p.active && p.active.type === "skill" ? [p.active] : [];
    delete p.active;
  }
  if (p.v === 8) {
    p.v = 9;
    p.trader = null;
  }
  if (p.v === 9) {
    p.v = 10;
    // The single provision slot becomes the first of three.
    p.food = [p.equip?.food || null, null, null];
    p.autoEatPct = AUTO_EAT_DEFAULT;
    if (p.equip) delete p.equip.food;
  }
  if (p.v === 10) {
    p.v = 11;
    p.pets = [];
    p.activePet = null;
    p.playMs = 0;
  }
  if (p.v === 11) {
    p.v = 12;
    // Pets caught before individual quality existed get a neutral roll rather than a lucky one.
    for (const pet of p.pets || []) pet.iv = pet.iv || { hp: 1, atk: 1, def: 1 };
  }
  if (p.v === 12) {
    p.v = 13;
    p.petXpShare = PET_XP_DEFAULT;
  }
  if (p.v === 13) {
    p.v = 14;
    p.xp.fa = p.xp.fa || 0;
    p.plots = Array(PLOTS_START).fill(null);
    p.seenCrops = {};
    p.stats.harvests = p.stats.harvests || 0;
  }
  if (p.v === 14) {
    p.v = 15;
    p.gameDays = 0;
    p.rebirths = 0;
    p.rebirthFloor = { atk: 1, defs: 1, vit: 1 };
    p.rebirthLog = [];
    p.bank = { balance: 0, sinceDay: 0 };
    p.market = {};
    p.holdings = {};
    p.tax = { yearProfit: 0, paidTotal: 0, debtSinceDay: null, lastBill: null };
    p.ledger = [];
    p.dead = null;
  }
  if (p.v === 15) {
    p.v = 16;
    p.ui = { hideOwnedShop: false, hideDoneAch: false };
  }
  if (p.v === 16) {
    p.v = 17;
    // Seed the record from whatever is already tamed, so an existing collection is not "unseen".
    p.seenPets = {};
    for (const pet of p.pets || []) p.seenPets[pet.species] = true;
  }
  if (p.v === 17) {
    p.v = 18;
    // Sub-gold dividend remainders. Empty is correct for an existing save: nothing was owed yet
    // because every company on v17 paid at least a whole coin per payout.
    p.divAccrual = {};
  }
  if (p.v === 18) {
    p.v = 19;
    // No shops yet, and no brand: both are earned from scratch.
    p.shops = [];
    p.brand = 0;
  }
  if (p.v === 19) {
    p.v = 20;
    p.estates = [];
  }
  if (p.v === 20) {
    p.v = 21;
    p.gardener = null;
    /* Karma used to be derived from the rebirth count at a flat rate. Bank exactly what the old
     * formula was already granting, so nobody loses a bonus they had earned under the old rules. */
    p.karma = { xp: (p.rebirths || 0) * 0.05, gold: (p.rebirths || 0) * 0.03 };
  }
  if (p.v === 21) {
    p.v = 22;
    /* 🎯 [owner 2026-08-17] A save that rebirthed BEFORE the calendar reset shipped is still carrying
     * the previous life's clock — the owner's read 1Y-7M-8D after a rebirth at 1Y-7M-3D. Editing the
     * file directly loses every time: the open tab autosaves its in-memory clock straight back over
     * it, which is exactly what happened, 43 seconds later. Repairing on load is the one place that
     * cannot be clobbered.
     *
     * The rebirth log knows precisely when it happened, so that is the anchor — the calendar ends up
     * reading the days actually elapsed since the reset, which is what the code now produces on its
     * own. Saves whose clock has already been reset carry a marker and are left alone; that marker is
     * what stops this firing a second time on a save that rebirthed after the fix. */
    if (!p.calendarReset && (p.rebirths || 0) > 0) {
      const last = (p.rebirthLog || [])[0];
      const at = last
        ? (last.year - 1) * DAYS_PER_YEAR + (last.month - 1) * DAYS_PER_MONTH + (last.day - 1) : 0;
      if (at > 0 && (p.gameDays || 0) >= at) {
        p.gameDays -= at;
        if (p.bank) p.bank.sinceDay = Math.max(0, (p.bank.sinceDay || 0) - at);
        if (p.tax && p.tax.debtSinceDay != null) p.tax.debtSinceDay -= at;
        for (const sh of p.shops || []) for (const w of sh.staff || []) w.hiredDay = (w.hiredDay || 0) - at;
      }
    }
    p.calendarReset = true;
  }
  if (p.v === 22) {
    p.v = 23;
    /* 🐛 [owner 2026-08-17: "ยอดกำไรสุทธิ ผิด"] Saves that rebirthed before the fix above are still
     * carrying the previous life's investment profit under a year-1 label. There is no way to split
     * that figure back into "before" and "after" — nothing recorded the boundary — so it is cleared
     * outright for anyone who has rebirthed. Clearing is the safe direction: the alternative leaves
     * a year-end bill for gold and shares the rebirth already took away. */
    if ((p.rebirths || 0) > 0 && p.tax) { p.tax.yearProfit = 0; p.tax.lastBill = null; }
  }
  if (p.v === 23) {
    p.v = 24;
    /* 🐛 [owner 2026-08-17: "กำไรต้องเริ่มนับแต่ ตั้ง 1M 1D เลย น่าจะมีหลายยอดแล้ว"] v23 cleared the
     * whole accumulator because nothing recorded where the old life ended. Something does: the
     * ledger stamps every line with the calendar date it happened on, and a rebirth restarts that
     * calendar — so walking newest to oldest, the one place the dates jump FORWARD is the boundary.
     * Rebuild this life's profit from the lines after it instead of throwing the year away.
     *
     * Recovers dividends and realised trading gains, which is everything the ledger holds. Bank
     * interest is booked without a ledger line, so it cannot be recovered here and is left out
     * rather than guessed at — under-counting the tax base is the safe direction. */
    if ((p.rebirths || 0) > 0 && p.tax && !p.tax.yearProfit) {
      const day = (e) => (e.y - 1) * DAYS_PER_YEAR + (e.m - 1) * DAYS_PER_MONTH + (e.dd - 1);
      const log = p.ledger || [];
      let end = log.length;
      for (let i = 1; i < log.length; i++) if (day(log[i]) > day(log[i - 1])) { end = i; break; }
      let sum = 0;
      for (const e of log.slice(0, end)) {
        if (e.icon === "📈") sum += e.amount;
        else if (e.icon === "💹") {
          const m = /กำไร ([\d,]+)/.exec(e.text || "");
          if (m) sum += Number(m[1].replace(/,/g, ""));
        }
      }
      p.tax.yearProfit = Math.round(sum);
    }
  }
  if (p.v === 24) {
    p.v = 25;
    /* 🎯 [owner 2026-08-17] Furniture is bought with gold now and comes back out on a sale, so an
     * estate has to know what went into it. Pieces installed under the old material costs are
     * credited at today's price: they are worth what the piece is worth, and the alternative —
     * refunding nothing for them — would quietly make an already-furnished house the worst one to
     * own, which is the opposite of what the change is for. */
    for (const es of p.estates || []) {
      const kind = PROPERTIES.find((k) => k.id === es.kind);
      if (!kind) { es.spent = es.spent || 0; continue; }
      es.spent = (es.furniture || []).reduce((t, fid) => {
        const f = FURNITURE.find((x) => x.id === fid);
        return t + (f ? furniturePrice(kind, f) : 0);
      }, 0);
    }
  }
  if (p.v === 25) {
    p.v = 26;
    /* 🐛 [owner 2026-08-17] Every rebirth so far banked karma from the HALVED level, so everyone is
     * carrying roughly a quarter of what they earned. It is recoverable: rebirthLog stores the
     * stats each run ended on, which is exactly what the gain should have been computed from.
     * Recompute the whole total from the log rather than patching a difference — the log is the
     * record, and a total derived from it cannot drift further.
     *
     * The log keeps 20 entries. Someone past 20 rebirths would have older runs missing from it, so
     * their recomputed total could come out LOWER than what they hold; take the larger of the two
     * and nobody loses karma they already had. */
    const log = p.rebirthLog || [];
    if (log.length && log.length >= (p.rebirths || 0)) {
      let xp = 0, gold = 0;
      log.forEach((e, i) => {
        const b = e.before || {};
        const lvl = Math.max(1, Math.round(((b.atk || 1) + (b.defs || 1) + (b.vit || 1)) / 3));
        // Rebirths are newest-first, so the oldest entry is the one that faced gate index 0.
        const g = karmaGainFor(lvl, log.length - 1 - i);
        xp += g.xp; gold += g.gold;
        e.before.__lvl = lvl;   // the history panel was showing the halved figure too
      });
      p.karma = { xp: Math.max(xp, p.karma?.xp || 0), gold: Math.max(gold, p.karma?.gold || 0) };
    }
  }
  if (p.v === 26) {
    p.v = 27;
    /* 🎯 [owner 2026-08-17] An earlier build of this handed out marks for kills already recorded.
     * That was the wrong reading: a mark is for hunting a monster IN that difficulty, and the
     * counters it read predate the rule entirely. Counting starts here, from zero, per mode — so
     * anything granted retroactively is taken back before anyone builds on it. */
    p.slayer = {};
    p.slayerKills = {};
  }
  if (p.v === 27) {
    p.v = 28;
    /* 🎯 [owner 2026-08-17] "รางวัลที่ควรได้ มันมีแค่ โหมดปกติ 45 ตัวที่เคยทำสำเร็จเท่านั้น"
     *
     * The four counters stay strictly separate — 369 slimes felled on normal say nothing about
     * elite, and this does not touch those three. What it does fix is the normal column itself:
     * those kills WERE made on normal, under the only rule that column has, so starting it at zero
     * threw away work that already satisfied it. The counter is seeded from the game's own normal
     * tally and the milestone awarded where it is already met.
     *
     * Seeding the counter rather than only the mark is the honest half: the card then reads 369/45
     * because 369 is what happened, instead of a mark appearing next to a bar that says zero. */
    p.slayerKills = p.slayerKills || {};
    p.slayer = p.slayer || {};
    const gate = SLAYER_TIERS.find((t) => t.tier === "normal");
    for (const loc of LOCATIONS) {
      loc.stages.forEach((st, i) => {
        // Both keys hold normal-mode kills; the plain one predates the per-tier counter.
        const n = Math.max(p.kills?.[`${loc.id}:${i}`] || 0, p.kills?.[`${loc.id}:${i}:normal`] || 0);
        if (!n) return;
        p.slayerKills[`${loc.id}:${i}:normal`] = Math.max(p.slayerKills[`${loc.id}:${i}:normal`] || 0, n);
        if (gate && n >= gate.kills) p.slayer[`${loc.id}:${i}:normal`] = true;
      });
    }
  }
  if (p.v === 28) {
    p.v = 29;
    /* 🎯 [owner 2026-08-17] The per-monster hunt achievements are gone, replaced by slayer marks.
     * Anything already earned is banked at exactly the value it paid, so the removal costs nobody
     * a single point — the two systems then differ only in what they ask for NEXT. */
    p.legacyPerk = p.legacyPerk || {};
    for (const a of MONSTER_ACHIEVEMENTS) {
      if (!p.achieved?.[a.id]) continue;
      for (const [k, v] of Object.entries(a.perk)) p.legacyPerk[k] = (p.legacyPerk[k] || 0) + v;
      delete p.achieved[a.id];
    }
  }
  if (p.v === 29) {
    p.v = 30;
    /* 🎯 [owner 2026-08-17] The account becomes a stack of dated slips. An existing balance is one
     * slip carrying the age it had already earned — it kept that seniority under the old rules and
     * must keep it under these, or the change would quietly demote every saver to day one. */
    if (p.bank) {
      p.bank.slips = p.bank.slips || [];
      if (!p.bank.slips.length && (p.bank.balance || 0) > 0) {
        p.bank.slips.push({ sinceDay: p.bank.sinceDay || 0, amount: p.bank.balance,
                            pending: p.bank.pending || 0 });
      }
      delete p.bank.balance;
      delete p.bank.pending;
    }
  }
  if (p.v === 30) {
    p.v = 31;
    /* 🎯 [owner 2026-08-17] Tax becomes three assessed bills the player settles by hand, so a save
     * needs somewhere to keep them. A run that was mid-debt under the old rules is let off: that
     * debt was a negative gold balance the old year end created on its own, and there is no bill to
     * convert it into — charging for a rule that no longer exists is the wrong way round. */
    if (p.tax) {
      p.tax.bills = p.tax.bills || [];
      p.tax.debtSinceDay = null;
      if (p.gold < 0) p.gold = 0;
    }
  }
  if (p.v === 31) {
    p.v = 32;
    /* 🎯 [owner 2026-08-17] Condition and repairs are gone; the 15% exit fee already enforces the
     * long hold they existed for. A house that had decayed is simply whole again — the alternative
     * is a stored number that nothing reads, and a save carrying dead fields invites the next
     * reader to wonder whether they still matter. */
    for (const es of p.estates || []) delete es.condition;
  }
  if (p.v === 32) {
    p.v = 33;
    /* 🐛 [owner 2026-08-17: "บัค อสังหา"] Expanding the ladder to 40 renamed every id — hut, room,
     * house, stone, manor became p01..p40 — and a save holding one of the old ones pointed at a
     * house that no longer existed. Renaming content ids that saves can hold is the mistake; this
     * repairs the five that were, mapping each to the rung nearest its old price so nobody's
     * property changes value. */
    const moved = { hut: "p01", room: "p06", house: "p11", stone: "p16", manor: "p21" };
    for (const es of p.estates || []) if (moved[es.kind]) es.kind = moved[es.kind];
  }
  if (p.v === 33) {
    p.v = 34;
    // Tax now accrues through the year and can be paid down early; this holds what was paid ahead.
    if (p.tax) p.tax.prepaid = p.tax.prepaid || {};
  }
  if (p.v === 34) {
    p.v = 35;
    p.guild = p.guild || null;      // the institute is opt-in; a save without one simply has not built it
  }
  if (p.v === 35) {
    p.v = 36;
    // A save that already exists has already learned to play — the intro popup is for new saves only.
    p.seenIntro = true;
  }
  if (p.v === 36) {
    p.v = 37;
    /* When the app was last put down, so offline progress knows how long it was away. Null on an
     * existing save rather than "now": the time before this field existed is not time the player
     * was away with a job running, and paying it out would hand every save a windfall on first
     * launch of the new build. */
    p.leftAt = null;
  }
  if (p.v === 37) {
    p.v = 38;
    /* Nothing stored changes here — the bump exists only so the cache-busting version on the
     * <script> tags can move for the screen-awake fix. The step still has to be written: without it
     * the equality below turns every existing save into null, which the profile screen draws as an
     * empty slot. That is the "รีเฟรชแล้วข้อมูลหาย" failure, one forgotten line away every bump. */
  }
  if (p.v === 38) {
    p.v = 39;
    /* Titles are computed from achievements at render time and store nothing, so this step moves
     * the number and touches no data. It still has to exist — see the v37 note above. */
  }
  if (p.v === 39) {
    p.v = 40;
    /* The quest board. Empty rather than pre-filled: refreshQuests() stocks it on the first
     * onNewDay or the first time the square is opened, so an existing save does not arrive with
     * four jobs already ticking down against days it was not there for. */
    p.quests = [];
  }
  if (p.v === 40) {
    p.v = 41;
    /* Relationships. Empty rather than seeded: an existing save has been trading with nobody, and
     * arriving already friendly with five people it has never met would read as someone else's
     * save. relOf() creates each entry on first contact. */
    p.rel = p.rel || {};
    p.spouse = p.spouse || null;
  }
  if (p.v === 41) {
    p.v = 42;
    /* Children. Empty on an existing save even if it is somehow already married — a child cannot
     * be back-dated, and inventing one with an age would put a stranger in the household. */
    p.kids = p.kids || [];
  }
  if (p.v === 42) {
    p.v = 43;
    /* The ambush event is gone. Nothing stored referred to it — it rolled and resolved inside a
     * single action — so this step only moves the number for cache-busting. */
  }
  if (p.v === 43) {
    p.v = 44;
    /* Language is a browser preference, not part of a save — two profiles on one machine share it
     * and a save carried to another machine adopts that machine's choice. Nothing stored changes. */
  }
  if (p.v === 44) {
    p.v = 45;
    /* Interface translation. Nothing stored changes — the bump exists so the browser fetches the
     * new bundle rather than serving a cached one that has no English chrome in it. */
  }
  if (p.v === 45) {
    p.v = 46;
    /* The dividend toast changed shape. Nothing stored is involved — divAccrual and the ledger are
     * untouched, only what the message says about them. */
  }
  if (p.v === 46) {
    p.v = 47;
    /* Panel labels translated. Nothing stored changes. */
  }
  if (p.v === 47) {
    p.v = 48;
    /* Two grades above ตำนาน, and new band edges. Existing companions keep their stored IV and are
     * simply re-read against the new table, which is why nothing is rewritten here: a pet that was
     * ยอดเยี่ยม at 1.12 is still ยอดเยี่ยม, and one at 1.16 becomes ตำนาน because the bar moved from
     * 1.18 to 1.15. Nobody loses a grade — every new edge sits at or below the old one. */
  }
  if (p.v === 48) {
    p.v = 49;
    /* Level caps and the companion skill ladder. Nothing stored is rewritten: levels are derived
     * from XP, so a companion sitting at the old cap of 38 simply keeps climbing, and a character
     * at 99 stops being at the ceiling. Both curves were re-fitted rather than reset, so no save
     * loses a level — the same XP buys at least the same rank it bought yesterday. */
  }
  if (p.v === 49) {
    p.v = 50;
    /* Auto-fuse is a button, not stored state. Nothing to migrate. */
  }
  if (p.v === 50) {
    p.v = 51;
    /* Family upkeep starts today rather than being backdated: a save made before the cost existed
     * has not been dodging it, and charging for a marriage the player has had for two in-game years
     * would end a healthy run on the first tick after an update. */
    p.family = { arrears: 0, noteDay: null, lastBirthDay: null, lastBirthByWife: {},
                 bornThisLife: 0, monthPaid: 0 };
  }

  repairOverpopulatedFamily(p);
  repairStrandedQuests(p);

  if (p.v === 51) {
    p.v = 52;
    /* Nothing to migrate. The version moves because ?v= in index.html is the ONLY cache-buster the
     * published site has, and this batch changed game.js without changing the save format — leaving
     * it at 51 would serve every existing player the old code from cache. estateMonth defaults
     * through `|| 0`, and the title rewrite reads the same fields it always did. */
  }
  if (p.v === 52) {
    p.v = 53;
    /* Grown children hunt now, which needs lv/xp/nextHunt/log on each child — all of them default
     * through `|| 0` and `== null`, so nothing has to be written here. A child already of age simply
     * schedules their first outing on the next day tick.
     *
     * The version still moves: ?v= in index.html is the only cache-buster the published site has,
     * and this batch changed game.js heavily. */
  }
  if (p.v === 53) {
    p.v = 54;
    /* Grown children hunt now — lv/xp/nextHunt/log all default through `|| 0` and `== null`, so a
     * child already of age simply schedules their first outing on the next day tick. Nothing to
     * move. The version still steps because ?v= in index.html is the published site's only
     * cache-buster, and this batch rewrote a great deal of game.js. */
  }
  if (p.v === 54) {
    p.v = 55;
    /* Errands, con-colour hunting grounds, the two new notification switches, flat child upkeep.
     * Nothing to move: `k.chores` and `P.kidChoreMonth` both default in place on first use, and an
     * absent notification preference already reads as ON. The version steps because ?v= in
     * index.html is the published site's only cache-buster. */
  }
  if (p.v === 55) {
    p.v = 56;
    /* Children gain `bornLife`, which the family page splits its two lists on. Nothing recorded it
     * before — bornThisLife is a COUNT — so it is reconstructed: children are appended in birth
     * order, so the LAST `bornThisLife` of them are the ones born in the life now running. Anyone
     * earlier belongs to a previous life, which is exactly what the second list is for. */
    const kids = p.kids || [];
    const born = Math.min(kids.length, p.family?.bornThisLife ?? kids.length);
    kids.forEach((k, i) => {
      if (k.bornLife == null) k.bornLife = i >= kids.length - born ? (p.rebirths || 0)
                                                                  : Math.max(0, (p.rebirths || 0) - 1);
    });
  }
  if (p.v === 56) {
    p.v = 57;
    /* Portraits stop being keyed to the name and become a pattern the child carries. Existing
     * children keep the face they have been wearing — it was CHILD_NAMES.indexOf(name), so that is
     * what is written down. A name past the art set records null, which is emoji, which is already
     * what it was showing. */
    for (const k of p.kids || []) {
      if (k.face !== undefined) continue;
      const i = CHILD_NAMES.indexOf(k.name);
      k.face = i >= 0 && i < CHILD_ART_PATTERNS ? i : null;
    }
  }
  if (p.v === 57) {
    p.v = 58;
    /* Nothing to move — the family page lost three buttons and no save field changed. The version
     * still steps because ?v= in index.html is the published site's only cache-buster: without it a
     * returning player keeps the game.js their browser already has. */
  }
  if (p.v === 58) {
    p.v = 59;
    /* Nothing to move — the property panel changed what it COMPUTES from fields that already exist
     * (es.earned, es.spent), and the rebirth card swapped two class names. The version steps
     * because ?v= in index.html is the published site's only cache-buster. */
  }
  if (p.v === 59) {
    p.v = 60;
    /* Nothing to move — the profile screen gained a warning box. The version steps because ?v= in
     * index.html is the published site's only cache-buster, and this change matters most to the
     * people playing the published build. */
  }
  if (p.v === 60) {
    p.v = 61;
    /* 🐛 [owner 2026-08-23] "ลูกที่เพิ่งเกิด เคนจิ ได้รูปผู้หญิง เลยมองว่าแปลกๆ" — patterns were drawn
     * without regard to the name's sex, so existing children can be wearing the wrong one. Each is
     * moved to a free portrait of its own sex; if none is free it takes an emoji, which says
     * nothing false, rather than keeping a picture that does. */
    const used = new Set((p.kids || []).map((k) => k.face).filter((f) => f != null));
    for (const k of p.kids || []) {
      const i = CHILD_NAMES.indexOf(k.name);
      k.sex = i >= 0 ? CHILD_SEX[i] : null;
      if (k.face != null && CHILD_FACE_SEX[k.face] === k.sex) continue;   // already right
      used.delete(k.face);
      let pick = null;
      for (let f = 0; f < CHILD_ART_PATTERNS; f++) {
        if (used.has(f) || CHILD_FACE_SEX[f] !== k.sex) continue;
        pick = f; break;
      }
      k.face = pick;
      if (pick != null) used.add(pick);
    }
  }
  if (p.v === 61) {
    p.v = 62;
    /* Tax moves from holdings to income, and crypto arrives.
     *
     * The wealth tax is gone, so any accrued figure and any UNPAID wealth bill are dropped: they
     * were charged for holding gold, which is now explicitly safe, and leaving them would collect a
     * debt under a rule that no longer exists. Paid ones are history and stay in paidTotal.
     *
     * yearRent starts at zero rather than being reconstructed — rent collected under the old rule
     * was already taxed by the property-value charge, and taxing it again on the way out would bill
     * the same money twice. */
    p.tax = p.tax || {};
    p.tax.yearRent = p.tax.yearRent || 0;
    p.tax.bills = (p.tax.bills || []).filter((b) => b.kind !== "wealth");
    if (p.tax.accrued) delete p.tax.accrued.wealth;
    if (p.tax.prepaid) delete p.tax.prepaid.wealth;
    /* An estate bill assessed on VALUE is dropped for the same reason — it was raised by a rule
     * that has been retired, and the new one has not had a year to run yet. */
    p.tax.bills = p.tax.bills.filter((b) => b.kind !== "estate");
    p.coins = p.coins || {};
    p.crypto = p.crypto || {};
  }
  if (p.v === 62) {
    p.v = 63;
    /* Crypto page: percentage badges, price bands added and removed again in the same batch, and
     * its own two list filters. Four more furniture kinds, so the biggest houses can be filled.
     *
     * Nothing stored changes: a house already furnished keeps exactly the pieces it has, and the
     * new kinds simply become buyable. The version steps for the cache-buster. */
  }
  if (p.v === 63) {
    p.v = 64;
    /* 🐛 [owner 2026-08-23] Companions had no rebirth floor while their owners did, so every
     * rebirth compounded on the last and a pet decayed toward level 1 beside a child that had
     * stopped falling. The floor is added below; this repays what the missing one already cost.
     *
     * Each rebirth halved, so the level lost is the level it still has: doubling restores the most
     * recent halving, which is the one the floor would have prevented. Earlier rebirths are not
     * reconstructed — nothing recorded what the pet was before them, and inventing a number is
     * worse than repaying the part that can be known. The floor is then set to the restored level,
     * so it cannot happen again. */
    const repay = (pet) => {
      if (!pet || pet.lvFloor != null) return;      // already carries a floor: nothing owed
      const lv = Math.max(1, Math.min(PET_MAX_LEVEL, petLevel(pet) * 2));
      pet.xp = Math.max(pet.xp || 0, petXpToReach(lv));
      pet.lvFloor = Math.floor(lv / 2);
    };
    if ((p.rebirths || 0) > 0) {
      for (const k of p.kids || []) repay(k.pet);
      for (const pet of p.pets || []) repay(pet);
    }
  }
  if (p.v === 64) {
    p.v = 65;
    /* 🐛 [owner 2026-08-23] "ไม่มีปุ่มฮีลให้ หลังมันตาย" — feeding could not reach a fainted
     * companion, so one lost fight benched it forever. Nothing stored needs changing: a pet sitting
     * at hp 0 becomes feedable the moment the new code runs. The version steps for the cache-buster
     * and so a player on the old file is not left tapping a button that still cannot work. */
  }
  if (p.v === 65) {
    p.v = 66;
    /* 🎯 [owner 2026-08-23] "กดออกล่า มันบอกช่องเต็ม" — the multi ladder grew from 5 rungs to
     * 10 and was repriced. Upgrades are stored as plain id keys, so a save keeps exactly the rungs
     * it bought and simply sees the new ones for sale; nothing owned is revalued or refunded. */
  }
  if (p.v === 66) {
    p.v = 67;
    /* 🎯 [owner 2026-08-23] "ปรับพลังหลังจุติ ... ให้เป็น 90%" — nothing stored changes. The
     * rule applies from the next rebirth onward; a level already reduced by an earlier halving is
     * not retroactively topped up here. Existing lvFloor/rebirthFloor values were computed at 50%
     * and are therefore LOWER than the new rule would produce, so they are harmless: both floors
     * are applied with Math.max and simply stop binding.
     *
     * ⚠️ The reason first written here — "there is no record of what it was before, and inventing
     * one would hand out levels nobody earned" — was WRONG, and it is why no migration exists.
     * rebirthLog DOES store the pre-rebirth level of every stat, so the gap between the 50% a past
     * rebirth took and the 10% this rule takes is computable exactly, per rebirth, from the save
     * itself: before * (0.5 - (1 - REBIRTH_KEEP)). Leaving it uncomputed is a POLICY choice — a
     * retroactive top-up is a balance decision, not a bug fix — not a data limitation. If one is
     * ever wanted, read rebirthLog[].before; do not re-derive the claim that it cannot be done.
     * The owner's own save was repaid by hand on 2026-08-24 on exactly that basis. */
  }
  if (p.v === 67) {
    p.v = 68;
    /* Two additions, neither of which stores anything new that needs a default: the typing guard
     * is pure runtime, and ecoMode reads through uiPref(), which treats a missing key as off. The
     * version steps for the cache-buster — an old game.js still holding the 100-second repaint is
     * exactly what the fix is for. */
  }
  if (p.v === 68) {
    p.v = 69;
    /* Nothing stored changes. tickMs is read through tickMs(), which validates against TICK_RATES
     * and falls back to the default, so a save without the key — or with a rate no longer offered —
     * simply runs at 250ms. The version steps for the cache-buster: an old game.js still carries
     * the attack scheduler that rounded every interval up to a tick. */
  }
  if (p.v === 69) {
    p.v = 70;
    /* Nothing stored changes — this release is text and pictures. The version steps purely for the
     * cache-buster, and it has to: an old game.js still draws the slayer cards with the Thai
     * sentence baked into the template, so an English player on a cached script would see the
     * screen this release exists to fix. */
  }
  if (p.v === 70) {
    p.v = 71;
    /* Nothing stored changes — this is the second half of the English pass (shop, rebirth, stats,
     * tax, guild). The version step is not optional though, and the reason is a mistake worth not
     * repeating: those screens were translated AFTER v70 shipped, so for a while the site served
     * v70 with the old text while this repo held v70 with the new. Same number, different game.
     * A cache-buster that does not move cannot bust anything. */
  }
  return p.v === GAME_VERSION ? p : null;
}

/* 🐛 [hardened 2026-08-15, owner: "รีเฟรชแล้วข้อมูลหาย"] This used to swallow every error and
 * return null, which the profile screen renders as an EMPTY SLOT — identical to having no save at
 * all. A save that merely failed to parse or migrate (a half-written script during development, a
 * migration bug) therefore looked deleted, and the create button sat right on top of it ready to
 * overwrite the real thing. Now a slot that holds data but cannot be loaded reports itself as
 * broken, keeps the raw bytes untouched, and refuses to offer a fresh start over them. */
/* 🐛 [added 2026-08-17, owner: "เปิดใน brave ไม่ได้ ใน chrome ได้"] Some browsers refuse page
 * storage outright — Brave with Shields up, Safari on a file:// page, anyone in a private window.
 * The game keeps every save in localStorage, so on those the run is doomed from the first tick.
 * Finding out at save time means losing the session; finding out at boot costs nothing. Probed
 * once, before a profile can even be created. */
let storageError = null;
function storageWorks() {
  try {
    const k = "__idlefantacia_probe__";
    localStorage.setItem(k, "1");
    const ok = localStorage.getItem(k) === "1";
    localStorage.removeItem(k);
    if (!ok) { storageError = "เบราว์เซอร์รับค่าไปแล้วแต่อ่านกลับไม่ได้"; return false; }
    storageError = null;
    return true;
  } catch (e) {
    storageError = e.message || String(e);
    return false;
  }
}

/* ---------- Watching the save folder ----------
 * 🎯 [added 2026-08-17, owner: "มันยังไม่ reload ให้ อยากให้มันวิ่งไป call เอง"] Once a save is a
 * FILE, the obvious way to restore one is to drop it into idle-fantacia/saves/ — but the profile screen
 * had already read the folder at boot and had no reason to look again, so a file copied in sat
 * there invisible until a manual refresh.
 *
 * The profile screen now re-reads the folder on a timer and whenever the window regains focus,
 * which is exactly when a file was most likely just copied in. It runs ONLY on that screen and
 * only on the server backend: during play the cache is authoritative (the game is the thing
 * writing), and polling then would risk showing a stale read over a newer in-memory state. */
const SAVE_WATCH_MS = 2000;
let saveWatchTimer = null;
let saveWatchSig = null;

function slotsSignature() {
  return Object.keys(slotCache).sort().map((n) => `${n}:${(slotCache[n] || "").length}`).join("|");
}

async function refreshSlotsFromDisk() {
  if (saveBackend !== "server") return false;
  try {
    const r = await fetch("api/saves", { cache: "no-store" });
    if (!r.ok) return false;
    const all = await r.json();
    for (const n of Object.keys(slotCache)) if (!(n in all)) delete slotCache[n];
    for (const [n, raw] of Object.entries(all)) slotCache[n] = raw;
    const sig = slotsSignature();
    if (sig === saveWatchSig) return false;
    saveWatchSig = sig;
    return true;
  } catch (e) {
    return false;      // server went away; the profile screen keeps what it has
  }
}

function startSaveWatch() {
  stopSaveWatch();
  if (saveBackend !== "server") return;
  saveWatchSig = slotsSignature();
  saveWatchTimer = setInterval(async () => {
    if (await refreshSlotsFromDisk()) {
      renderProfiles();
      toast("📁 พบไฟล์เซฟในโฟลเดอร์เปลี่ยนไป — อัปเดตให้แล้ว");
    }
  }, SAVE_WATCH_MS);
}

function stopSaveWatch() {
  if (saveWatchTimer) clearInterval(saveWatchTimer);
  saveWatchTimer = null;
}

/* Coming back to the tab is the moment a file was most likely just dropped in, so check then
 * too rather than waiting out the interval. */
window.addEventListener("focus", () => {
  if (saveWatchTimer) refreshSlotsFromDisk().then((changed) => { if (changed) renderProfiles(); });
});

/* The raw bytes of a slot, whichever backend holds them. */
function rawSlot(n) {
  if (saveBackend === "server") return slotCache[n] ?? null;
  try { return localStorage.getItem(SLOT_KEY(n)); } catch { return null; }
}

function deleteSlot(n) {
  if (saveBackend === "server") {
    delete slotCache[n];
    // The server keeps a timestamped copy before unlinking, so a mis-click is recoverable
    // from idle-fantacia/saves/backups/ rather than gone.
    fetch(`api/save/${n}`, { method: "DELETE" })
      .catch((e) => toast(`ลบไฟล์เซฟบนดิสก์ไม่สำเร็จ: ${e.message}`, "warn"));
    return;
  }
  try { localStorage.removeItem(SLOT_KEY(n)); }
  catch (e) { toast(`ลบเซฟไม่สำเร็จ: ${e.message}`, "warn"); }
}

function readSlot(n) {
  let raw;
  if (saveBackend === "server") {
    raw = slotCache[n] ?? null;
  } else {
    try { raw = localStorage.getItem(SLOT_KEY(n)); }
    catch (e) { return { __broken: `เบราว์เซอร์ไม่ยอมให้อ่านที่เก็บข้อมูล: ${e.message}` }; }
  }
  if (!raw) return null;                       // genuinely empty
  try {
    const migrated = migrate(JSON.parse(raw));
    if (migrated) return migrated;
    return { __broken: `เซฟเป็นเวอร์ชันที่อ่านไม่ได้ (v${(JSON.parse(raw) || {}).v ?? "?"})`, raw };
  } catch (e) {
    return { __broken: `อ่านเซฟไม่สำเร็จ: ${e.message}`, raw };
  }
}

/* 🐛 [hardened 2026-08-17, owner: "เซฟยังใช้ไม่ได้"] This used to let any failure escape to the
 * click handler, where it died silently: the button appeared to do nothing and the player had no
 * way to tell a working save from a broken one. A save that cannot be written is the single worst
 * thing to fail quietly, so it now reports the reason and the caller can act on it.
 * Returns true on success. */
function writeSlot(n, profile) {
  const stamp = profile.lastSavedAt;
  try {
    profile.lastSavedAt = Date.now();
    const raw = JSON.stringify(profile);
    if (saveBackend === "server") {
      slotCache[n] = raw;        // authoritative immediately; the file catches up in a moment
      pushSlot(n, raw);
      return true;
    }
    localStorage.setItem(SLOT_KEY(n), raw);
    return true;
  } catch (e) {
    profile.lastSavedAt = stamp;          // do not claim a save time we never wrote
    console.error("[save] เขียนเซฟไม่สำเร็จ:", e);
    const full = /quota|exceed/i.test(e.name + e.message);
    toast(full ? "💾❌ เซฟไม่สำเร็จ — พื้นที่เก็บข้อมูลของเบราว์เซอร์เต็ม"
               : `💾❌ เซฟไม่สำเร็จ: ${e.message}`, "warn");
    return false;
  }
}

/* ---------- Runtime state ---------- */

let slot = null;
let P = null;
let view = { kind: "skill", skillId: "wc" }; // skill | combat | shop
let combatLoc = null;
/* Per-slot runtime, index-aligned with P.slots. `startedAt` drives a skill cycle; `fight` holds
 * the live combat state. Only ONE slot may hold a fight at a time — HP is shared, so parallel
 * battles would be incoherent. */
let RT = [];
const slotRT = (i) => (RT[i] = RT[i] || { startedAt: null, fight: null });
const combatSlot = () => P.slots.findIndex((sl) => sl && sl.type === "combat");
let lastRegenAt = 0;

/* ---------- Pause ----------
 * 🎯 [added 2026-08-17, owner: "บางที เราหันไปทำอะไร ไม่ได้สนใจเกม เวลามันไหล"] In an
 * online-only game the clock is the price of leaving the tab open, and there was no way to stop
 * paying it short of closing the window and losing the session.
 *
 * Pausing freezes the clock rather than skipping it: every deadline the engine holds is an
 * absolute timestamp, so on resume they are all shifted forward by exactly how long the pause
 * lasted. Without that shift, coming back would fire every pending action at once — the opposite
 * of what a pause is for. */
let paused = false;
let pausedAt = 0;

function isPaused() { return paused; }

function setPaused(on) {
  if (on === paused) return;
  if (on) {
    paused = true;
    pausedAt = performance.now();
  } else {
    const delta = performance.now() - pausedAt;
    paused = false;
    // Shift every absolute deadline the engine is holding, so nothing "catches up".
    for (const rt of RT) {
      if (!rt) continue;
      if (rt.startedAt != null) rt.startedAt += delta;
      /* 🐛 [fixed 2026-08-17] This shifted pNext and mNext only, while the comment above claimed
       * every deadline — so unpausing handed the companion a free hit and let a draining boss heal
       * on the spot. Every *Next the fight holds, or the promise in that comment is not true. */
      if (rt.fight) for (const k of ["pNext", "mNext", "petNext", "drainNext"]) {
        if (rt.fight[k] != null) rt.fight[k] += delta;
      }
    }
    if (momentumSince) momentumSince += delta;
    for (const k of Object.keys(buffs)) if (buffs[k]) buffs[k] += delta;
    lastRegenAt += delta;
    lastFarmAt = performance.now();     // no farm growth or calendar time for the pause
    lastPlayTick = Date.now();          // and it does not count as play time either
  }
  updatePauseUi();
  updateBanner();
  if (slot === 1) sendPresence(!paused);
}

function updatePauseUi() {
  refreshWakeLock();      // a paused game is not being watched
  if (window.__ui) { window.__ui.sync(); }
  const btn = $("#pause-chip");
  if (btn) {
    btn.textContent = paused ? "▶️ เล่นต่อ" : "⏸️ พัก";
    btn.classList.toggle("paused", paused);
    btn.title = paused
      ? "เวลาในเกมหยุดอยู่ — งาน แปลงปลูก ปฏิทิน และการต่อสู้หยุดหมด"
      : "หยุดเวลาในเกมชั่วคราว (งาน แปลงปลูก ปฏิทิน การต่อสู้)";
  }
  const bar = $("#pause-bar");
  if (bar) bar.style.display = paused ? "block" : "none";
}
let lastFarmAt = 0;     // previous tick's clock, so plot growth advances by real elapsed time
let lastPlayTick = 0;   // wall-clock accumulator for the statistics page
let logicTimer = null;
let autosaveTimer = null;

const $ = (sel) => document.querySelector(sel);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Derived numbers ---------- */

const JUNK_IDS = Object.keys(ITEMS).filter((id) => ITEMS[id].junk);

const masteryKey = (skillId, actionId) => `${skillId}:${actionId}`;
const masteryLevelOf = (skillId, actionId) =>
  masteryLevelFromXp(P.mastery[masteryKey(skillId, actionId)] || 0);

function toolBonus(skillId) {
  let best = 0;
  for (const u of SHOP) if (!u.kind && u.skill === skillId && P.upgrades[u.id]) best = Math.max(best, u.bonus);
  return best;
}

/* A mastery step improves every rate the action has, not just its clock. */
function masteryLootMult(skillId, actionId) {
  return 1 + masteryStepsWorth(masteryLevelOf(skillId, actionId)) * MASTERY_LOOT_PER_LEVEL;
}
/* A drop must stay a drop. With the mastery ceiling at 99 the multiplier reaches 2.06x, which was
 * enough to push two steal bonuses past certainty — and a 100% "chance" is a guaranteed item wearing
 * the wrong label. Capping here rather than at each call site means content added later inherits
 * the rule instead of having to remember it. */
const LOOT_CHANCE_CEIL = 0.95;
function effectiveLootChance(skillId, actionId, chance) {
  return Math.min(LOOT_CHANCE_CEIL, chance * masteryLootMult(skillId, actionId));
}

function masteryJunkMult(skillId, actionId) {
  return Math.max(0.2, 1 - masteryStepsWorth(masteryLevelOf(skillId, actionId)) * MASTERY_JUNK_PER_LEVEL);
}

/* Catch weights tilt toward the rarer end of the table as mastery grows: the entries are
 * authored commonest-first, so a later index gets a bigger share of the shift. */
function effectiveCatch(skillId, action) {
  /* The catch tilt stops growing at MASTERY_TAIL_FROM. Past that it would start inverting tables —
   * the rare fish becoming more common than the ordinary one — which reads as a bug rather than a
   * reward. The tail's value goes into speed, loot and junk instead. */
  const step = Math.min(MASTERY_TAIL_FROM - 1, masteryStepsWorth(masteryLevelOf(skillId, action.id)))
    * MASTERY_CATCH_PER_LEVEL;
  const last = action.catch.length - 1;
  return action.catch.map((c, i) => ({
    item: c.item,
    w: c.w * (1 + step * (last ? i / last : 0) * 2),
  }));
}

function effectiveSeconds(skillId, action) {
  const m = masteryStepsWorth(masteryLevelOf(skillId, action.id));
  let eff = action.seconds * (1 - m * MASTERY_SPEED_PER_LEVEL) * (1 - toolBonus(skillId))
            * (1 - perkTotal("speed"));
  if (buffActive("haste")) eff *= 0.6;
  return Math.max(action.seconds * 0.3, eff);
}

function statLevel(statId) { return levelFromXp(P.cb[statId] || 0); }
/* How many jobs can run at once: one by default, plus each multi-processing tier bought. */
function maxSlots() {
  return 1 + SHOP.filter((u) => u.kind === "multi" && P.upgrades[u.id]).length;
}
function activeCount() { return P.slots.filter(Boolean).length; }

function combatLevel() {
  return Math.max(1, Math.round((statLevel("atk") + statLevel("defs") + statLevel("vit")) / 3));
}

/* Shop-bought permanent effects. */
function tomeBonus(skillId) {
  // Rebirth karma rides along with the tomes: every skill's XP, in one place.
  let total = 0;
  for (const u of SHOP) if (u.kind === "tome" && u.skill === skillId && P.upgrades[u.id]) total += u.value;
  total += karmaXp();
  return total;
}
function charmValue(effect) {
  let total = 0;
  for (const u of SHOP) if (u.kind === "charm" && u.effect === effect && P.upgrades[u.id]) total += u.value;
  return total;
}

/* 🎯 [added 2026-08-15, owner's ask] Copies of an item that are currently WORN are reserved:
 * selling a stack of 3 with one equipped can only ever move 2, so a bulk sale never strips the
 * character mid-hunt. Counted per gear slot, since the same item can fill two slots at once.
 * Food is deliberately NOT reserved — provisions exist to be consumed, and locking the last meal
 * would block the player from clearing it out. */
function reservedCount(id) {
  return EQUIP_SLOTS.filter((s) => P.equip[s.id] === id).length;
}
function sellableCount(id) {
  return Math.max(0, (P.inv[id] || 0) - reservedCount(id));
}

/* An equipped item only counts while at least one copy is actually in the bag. */
function equippedItem(slotId) {
  const id = P.equip[slotId];
  return id && (P.inv[id] || 0) > 0 ? ITEMS[id] : null;
}

/* Which armour sets are fully worn right now (head + body + offhand of one tier). */
function activeSets() {
  const worn = new Set(EQUIP_SLOTS.map((s) => P.equip[s.id]).filter((id) => id && (P.inv[id] || 0) > 0));
  return ARMOR_SETS.filter((set) => set.pieces.every((pc) => worn.has(pc)));
}

/* How much of the achievement page is done — counting BOTH families, because a slayer mark is
 * earned once, never lost, and pays a permanent stat exactly like the rest. This exists because the
 * sidebar and the page were each computing it, and they disagreed the moment one of them learned
 * about marks. One number, one place.
 *
 * The rows are what the page renders, so it takes them from here too rather than rebuilding them. */
function slayerRows() {
  return LOCATIONS.flatMap((loc) => loc.stages.flatMap((raw, i) =>
    SLAYER_TIERS.map((t, ti) => ({ loc, raw, i, t, ti,
      mark: `${loc.id}:${i}:${t.tier}`, mode: ELITE_MODES[ti],
      rk: slayerRewardKey(loc.id, raw.id) }))));
}
function achievementProgress() {
  const rows = slayerRows();
  const marksDone = rows.filter((r) => P.slayer?.[r.mark]).length;
  return { rows, achDone: Object.keys(P.achieved || {}).length, marksDone,
           done: Object.keys(P.achieved || {}).length + marksDone,
           total: ACHIEVEMENTS.length + rows.length };
}

/* Does this monster fear us? True once the top slayer mark for it is held — see the BANE note in
 * data.js. Takes the location id and stage index so it can be asked outside a fight, which the
 * hunt-selection screen does in order to show the mark before you walk in. */
function monsterFearsUs(locId, stageIdx, p = P) {
  return !!(p && p.slayer && p.slayer[`${locId}:${stageIdx}:${BANE_TIER}`]);
}

/* The multiplier on a feared monster's damage. Its own function rather than an inline ternary so
 * the combat line stays readable and the number has one place to live. */
function baneDamageMult(locId, stageIdx, p = P) {
  return monsterFearsUs(locId, stageIdx, p) ? BANE_DAMAGE_MULT : 1;
}

/* How many species have learned to fear us — the count a title is built from. */
function baneCount(p = P) {
  if (!p || !p.slayer) return 0;
  return Object.keys(p.slayer).filter((k) => k.endsWith(`:${BANE_TIER}`)).length;
}

/* ---------- 💗 ความสัมพันธ์ ----------
 * See the REL_* note in data.js. State lives on P.rel: { [villagerId]: { aff, floor, gaveDay } }
 * and the marriages, which live on P.spouses (see spouseIds — P.spouse is the legacy first one).
 */

function relOf(id) {
  P.rel = P.rel || {};
  P.rel[id] = P.rel[id] || { aff: 0, floor: 0, gaveDay: -1 };
  return P.rel[id];
}

function relStage(aff) {
  let out = REL_STAGES[0];
  for (const s of REL_STAGES) if (aff >= s.at) out = s;
  return out;
}

/* The bonus a villager currently contributes. Zero for anyone the player has not warmed to, and
 * zero for the men — they have no romance track and therefore no bonus, per the owner. */
/* 🎯 [owner 2026-08-22] "npc หญิง ต้องแต่งงาน ถึงจะได้โบนัส แต่ npc ชายเราทำแบบนั้นไม่ได้ มันจึงให้ค่า
 * โบนัสเล็กน้อย ตอนสเตตัสยกระดับ" — two rules, because the two kinds of villager have different
 * ceilings.
 *
 * 🐛 The bonus used to scale with the affection stage for everyone, and the top stage's multiplier
 * is 1.0 — so a courted-but-unmarried villager already paid the FULL bonus and the wedding added
 * nothing at all. The one thing marriage was for gave nothing, and the daily upkeep that now comes
 * with it would have made marrying a strictly losing move.
 *
 * So: the romanceable ones pay on the marriage, all of it, and nothing before. The two who cannot be
 * married keep the old behaviour — a small amount that grows as the friendship does, which is the
 * only way they can repay it. */
function relBonusOf(id) {
  const spec = REL_BONUS[id];
  if (!spec) return null;
  const v = VILLAGERS.find((x) => x.id === id);
  const st = relStage(relOf(id).aff);
  if (v?.romance) {
    if (!isSpouse(id)) return null;
    return { ...spec, stage: st };
  }
  if (!st.bonus) return null;
  return { ...spec, amount: spec.amount * st.bonus, stage: st };
}

/* Every relationship bonus of one kind, summed. Called from the systems themselves so a new
 * villager cannot be added without their bonus reaching the thing it claims to affect. */
function relBonusTotal(kind) {
  let total = 0;
  for (const v of VILLAGERS) {
    /* Only the spouse's share is suspended by arrears. The others are friendships, not dependants —
     * they are not being paid for, so failing to pay is not a reason to withdraw them. */
    if (isSpouse(v.id) && familyInArrears()) continue;
    const b = relBonusOf(v.id);
    if (b && b.kind === kind) total += b.amount;
  }
  return total;
}

/* Does this villager care for this item? Matched on the item id containing one of their tags,
 * which is loose on purpose: the item table is 164 rows and a hand-written list per person would
 * be wrong the first time an item is added. */
function giftValue(villager, itemId) {
  const v = VILLAGERS.find((x) => x.id === villager);
  if (!v) return REL_GIFT_PLAIN;
  /* Junk is checked FIRST. It is junk to everyone, and a cheap thing that happens to share a
   * prefix with something they like — ore_stone for the blacksmith — should not read as a gift. */
  if ((ITEMS[itemId]?.sell || 0) <= 1) return REL_GIFT_DISLIKED;
  /* 🐛 [audit-qa 2026-08-22] The tag has to be a WHOLE part of the id, never any substring of it.
   * Plain `itemId.includes(tag)` made the blacksmith's "ore" match spore_glow, snow_core, ember_core
   * and core_nova — four items she has no reason to care about, each paying REL_GIFT_LOVED instead
   * of REL_GIFT_PLAIN. Item ids are word_word with the odd trailing digit, so splitting on those
   * separators is the word boundary this table always meant. Measured before changing it: exactly
   * those four move, and not one intended match is lost. */
  if ((v.likes || []).some((tag) => itemId.split(/[_\d]+/).includes(tag))) return REL_GIFT_LOVED;
  return REL_GIFT_PLAIN;
}

function canGiftToday(id) {
  return relOf(id).gaveDay !== questDay();
}

/* Hand over one item. Returns a short result the caller turns into a toast, rather than toasting
 * here, so the same rule can later serve a batch-gift screen without shouting six times. */
function giveGift(villagerId, itemId) {
  const v = VILLAGERS.find((x) => x.id === villagerId);
  if (!v) return { ok: false, why: "ไม่มีคนนี้ในหมู่บ้าน" };
  const r = relOf(villagerId);
  if (relStage(r.aff).at < REL_STAGES[1].at) return { ok: false, why: `${v.name} ยังไม่สนิทพอจะรับของ` };
  if (!canGiftToday(villagerId)) return { ok: false, why: `วันนี้ให้ของ ${v.name} ไปแล้ว` };
  if (sellableCount(itemId) < 1) return { ok: false, why: "ไม่มีของชิ้นนี้ในกระเป๋า" };

  P.inv[itemId] -= 1;
  if (P.inv[itemId] <= 0) delete P.inv[itemId];
  r.gaveDay = questDay();
  bump("giftsGiven");
  const delta = giftValue(villagerId, itemId);
  const before = relStage(r.aff);
  r.aff = Math.max(r.floor, Math.min(REL_MAX, r.aff + delta));
  const after = relStage(r.aff);
  return { ok: true, delta, villager: v, item: ITEMS[itemId],
           levelUp: after.id !== before.id ? after : null };
}

/* Affection from doing their job, so the quest board feeds the square rather than sitting beside
 * it. Small on purpose — gifts are the deliberate act. */
function relCredit(villagerId, amount = REL_QUEST_BONUS) {
  const r = relOf(villagerId);
  r.aff = Math.max(r.floor, Math.min(REL_MAX, r.aff + amount));
}

/* 🎯 [owner 2026-08-22] "ให้แต่งงานได้หลายคน" — the household can hold more than one marriage. The
 * per-wife yearly clock this note used to describe was removed on 2026-08-23; the cap is per life.
 *
 * P.spouse stays as the FIRST marriage and is what every older save carries, so nothing that reads
 * it breaks; P.spouses is the full list and is derived from P.spouse when a save predates it.
 * Reading through spouseIds() everywhere is what keeps those two from drifting apart. */
function spouseIds() {
  /* Merged rather than "array wins", because the two fields can disagree and only one direction of
     disagreement is safe. An empty P.spouses next to a set P.spouse would silently annul a marriage
     the player has — a listed spouse missing from the array is the harmless case. */
  const list = Array.isArray(P.spouses) ? P.spouses.slice() : [];
  if (P.spouse && !list.includes(P.spouse)) list.unshift(P.spouse);
  return list;
}
function isSpouse(id) { return spouseIds().includes(id); }

/* 🐛 [owner 2026-08-22] What to CALL a rung, for this particular villager. The ladder is shared,
 * but its top two rungs are romantic — so the woodcutter used to be labelled "คนรัก" and then
 * "พร้อมแต่งงาน" for the crime of accepting enough gifts. Everything below is already neutral
 * ("เพื่อน", "คนสนิท") and needs no alternative. */
function relLabel(villagerId, stage) {
  const v = VILLAGERS.find((x) => x.id === villagerId);
  return (!v || v.romance || !stage?.alt) ? stage : { ...stage, ...stage.alt };
}

function canPropose(id) {
  /* 🐛 [owner 2026-08-22] This demanded the EXACT "lover" stage, so affection passing 90 moved the
   * villager to the next stage and the option to propose disappeared for good — being too generous
   * with gifts locked you out of marrying her. The gate is a floor, not a band. */
  const LOVER_AT = REL_STAGES.find((s) => s.id === "lover").at;
  /* 🐛 [owner 2026-08-22] This used the presence of a REL_BONUS as a stand-in for "can be courted",
   * which held only while the two non-romanceable villagers had no bonus at all. The moment they
   * were given one, they would have become marriageable — a coupling nothing in either table hints
   * at. romance is the field that actually means this. */
  const v = VILLAGERS.find((x) => x.id === id);
  return !isSpouse(id) && !!v?.romance && relOf(id).aff >= LOVER_AT;
}

function propose(id) {
  if (!canPropose(id)) return false;
  const r = relOf(id);
  r.aff = Math.max(r.aff, REL_STAGES[REL_STAGES.length - 1].at);
  P.spouses = spouseIds().concat(id);
  P.spouse = P.spouses[0];
  const v = VILLAGERS.find((x) => x.id === id);
  toast(`💍 ${v.icon} ${v.name} ตอบตกลง!`, "levelup", "quest");
  save("แต่งงาน");
  return true;
}

/* What rebirth does. The owner's rule: halve the affection, roll back the marriage, and never drop
 * below the floor a previous life reached — the same shape as rebirthFloor for combat stats, so
 * each life courts the same person faster than the last. */
/* 🎯 [owner 2026-08-22] Two rules changed here on the same day, and the second follows from the
 * first. Marriages survive a rebirth — "ไม่งั้นมันจะสับสน ว่าลูกเก่าเป็นลูกเรากับใคร": a child can now
 * outlive the life he was born into, his record names his mother, and annulling the marriage left
 * that name pointing at a stranger.
 *
 * And affection is no longer halved — "ความสัมพันธ์ต้องไม่ล้างค่าความสัมพันธ์ของ NPC". Once the
 * marriages stay, halving everyone else says the village forgot you while your wives did not, which
 * is the same incoherence the first change removed. The floor mechanic that existed to soften the
 * halving is kept and simply tracks the current value, so nothing that reads r.floor breaks.
 *
 * REL_REBIRTH_MULT is deliberately left in data.js rather than deleted: it is the owner's dial, and
 * a rebirth that costs relationships is one edit away if the halving is ever wanted back.
 *
 * gaveDay still resets. That is not a relationship value — it is "have you given a gift today", and
 * a new life starts on a new calendar. */
function relRebirth() {
  const married = new Set(spouseIds());
  const WED_AT = REL_STAGES[REL_STAGES.length - 1].at;
  for (const id of Object.keys(P.rel || {})) {
    const r = P.rel[id];
    if (married.has(id)) {
      r.aff = Math.max(r.aff || 0, WED_AT);
      r.floor = Math.max(r.floor || 0, WED_AT);
    }
    r.floor = Math.max(r.floor || 0, r.aff || 0);
    r.gaveDay = -1;
  }
  /* Keep both fields in step: spouseIds() merges them, so leaving one behind would be a marriage
     that only half the game can see. */
  P.spouses = spouseIds();
  P.spouse = P.spouses[0] || null;
}

/* ---------- 👶 ลูก ----------
 * See the CHILD_* note in data.js. State lives on P.kids: [{ id, name, bornDay, age, stats, edu }].
 *
 * `age` is an absolute counter incremented by onNewDay, NOT derived from bornDay — doRebirth sets
 * P.gameDays back to 0, so any age computed from the calendar would jump backwards the first time
 * the player rebirths, and would do it silently.
 */
/* 🎯 [owner 2026-08-23] "เพื่อรองรับลูกจำนวนมาก ให้สร้างรูปและชื่อมาอีกเยอะๆ เพื่อรองรับลูกอีก
 * ราวๆ 100 คน เพื่อไว้ก่อน" — children outlive rebirths now, so a long save accumulates them across
 * every cycle and eight names ran out fast. A hundred, in birth order.
 *
 * ORDER-LOCKED against CHILD_FACES: childFaceId indexes one into the other, so inserting a name in
 * the middle silently repaints every child after it. Append only. */
const CHILD_NAMES = [
  "อาริน", "นารา", "เคนจิ", "ลิลลี่", "ทาโร่", "มินะ", "โซอี้", "ยูกิ", "ไอโกะ", "ฮารุ", "เรน",
  "ซากุระ", "ไคโตะ", "โนอา", "เอมิ", "ริกุ", "ฮานะ", "โซระ", "ยูโตะ", "มายา", "เคย์", "อายะ",
  "ทาคุมิ", "นานา", "ชิน", "มิโอะ", "ฮิคารุ", "รินะ", "ไดกิ", "ยูนะ", "โคจิ", "ซากิ", "เท็ตสึ",
  "อากิ", "ริว", "โมโมะ", "เคนตะ", "ชิโฮะ", "ฮิโระ", "นาโอะ", "จุน", "เอริ", "โซตะ", "มิกิ",
  "เรียวตะ", "ฮิยาริ", "คาซึ", "อิจิ", "เมย์", "ทาเครุ", "ซึบากิ", "โยชิ", "คานะ", "เอเดน",
  "ไอวี่", "ฟินน์", "โรซ่า", "มิโล", "เอลล่า", "ธีโอ", "ไอริส", "ลูคัส", "โนรา", "เฟลิกซ์",
  "คลาร่า", "ออสการ์", "เฮเซล", "จูเลียน", "มาริน", "ซิลาส", "เวก้า", "โอริออน", "ลูน่า",
  "แคสเปียน", "เอลารา", "ไคโร", "เซเลน", "อาร์เธอร์", "ไลร่า", "เอซรา", "ทาเลีย", "โรวัน",
  "เอสเม", "ไบรอน", "เนวา", "คีแลน", "ซาช่า", "ดามิร์", "อันย่า", "ไมโล", "เวร่า", "นิโค",
  "ตาเลีย", "อีวาน", "มิร่า", "โอเว่น", "ลาร่า", "ยาน", "นีน่า", "เดเมียน",
];

/* 🐛 [owner 2026-08-22: "มีลูกถึง 4 คนไปแล้ว มันเยอะผิดปกติ ... มันควรเพิ่งแต่งงาน มีลูกแค่คนเดียว"]
 * At 3% a day with no spacing rule, a save filled all four slots inside two game-years — the owner's
 * had children born 17, 3 and 2 days apart. Those children are the old rate's doing, not the
 * player's, so the state is repaired rather than trusted.
 *
 * Keyed on its OWN flag rather than on a version boundary, and that is the point: this was first
 * written inside the 50→51 step, and the owner had already reloaded once between the version bump
 * and the repair being added — so their save sat at 51 with four children and nothing would ever
 * have run again. A repair that can only fire on one exact version misses everyone who crossed it a
 * moment too early.
 *
 * It keeps what the one-per-year rule WOULD have allowed: the eldest, then each child born a full
 * game-year after the last one kept. A save that spaced its children properly loses nothing, which
 * is what makes this a repair and not a wipe. Runs once per save, and never again. */
/* 🐛 [owner 2026-08-22] The same calendar-reset bug, for saves that already rebirthed before it was
 * fixed. A quest dated past the length of a year cannot be explained any other way — the board only
 * ever issues them QUEST_DAYS ahead — so anything further out than that is stranded from a previous
 * life and is expired here rather than left to sit forever. Flagged, so it runs once. */
function repairStrandedQuests(p) {
  p.questsRepaired = p.questsRepaired || false;
  if (p.questsRepaired) return;
  p.questsRepaired = true;
  const today = Math.floor(p.gameDays || 0);
  p.quests = (p.quests || []).filter((q) => (q.until || 0) <= today + QUEST_DAYS);
}

function repairOverpopulatedFamily(p) {
  p.family = p.family || { arrears: 0, noteDay: null, lastBirthDay: null, lastBirthByWife: {},
                           bornThisLife: 0, monthPaid: 0 };
  if (p.family.kidsRepaired) return;
  p.family.kidsRepaired = true;

  const kids = Array.isArray(p.kids)
    ? p.kids.slice().sort((a, b) => (a.bornDay || 0) - (b.bornDay || 0)) : [];
  if (kids.length > 1) {
    const kept = [kids[0]];
    for (const k of kids.slice(1)) {
      if ((k.bornDay || 0) - (kept[kept.length - 1].bornDay || 0) >= DAYS_PER_YEAR) kept.push(k);
    }
    p.kids = kept;
  }
  /* Rebuild the clocks from whoever is actually left, so the spacing rule counts from a survivor's
     birthday rather than from a child that no longer exists. */
  p.family.lastBirthByWife = {};
  for (const k of p.kids || []) {
    if (k.parent) p.family.lastBirthByWife[k.parent] = k.bornDay || 0;
  }
  p.family.lastBirthDay = p.kids?.length ? (p.kids[p.kids.length - 1].bornDay || 0) : null;
  p.family.bornThisLife = p.kids?.length || 0;
}

function childrenOf() { P.kids = P.kids || []; return P.kids; }

/* ---------- 🗡️ ลูกที่โตแล้วออกล่าเอง ----------
 * 🎯 [owner 2026-08-23] "ต้องวางระบบออกผจญภัยเอง ค่อยๆ สู้สะสมเลเวล ... แต่เราไม่ได้คุมเอง มันจะทำงาน
 * ตามระบบหลังบ้าน ... ไม่ต้องมีแถบ hp ให้เห็นเพราะเราไม่สนใจ"
 *
 * Everything below borrows the institute's combat maths rather than restating it — guildTargetPower,
 * guildOutcome, guildLootFor. Two systems that both send people out to fight would drift apart the
 * first time either was tuned, and this one has no screen to notice the drift on. */

/* A child's level from stored XP. Same shape as petLevel, same curve. */
function childLevel(k) {
  let l = 1;
  while (l < CHILD_MAX_LEVEL && (k.xp || 0) >= petXpToReach(l + 1)) l++;
  return l;
}

/* Combat stats as they stand today: what they were born with, grown by level. Birth stats are half
 * the parent's, so a child born to a strong father starts high and climbs from there. */
/* 🐛 [owner 2026-08-23: "ลูกขั้นสอง แต่สเตตัสเหมือนไม่ขยับ"] It did not. The growth was a straight
 * percentage of birth stats, and 2% of 13 is 0.26 — which rounds away. A child had to reach level 3
 * before a single number changed, and at low birth stats the whole climb read as flat.
 *
 * The step is now at least 1 per level. It is still 2% for anything big enough for 2% to be a whole
 * number, so a strong parent's child is unchanged; what it fixes is the case where the percentage
 * was too small to be seen. */
function childStat(k, id) {
  const base = (k.stats || {})[id] || 1;
  const step = Math.max(1, Math.round(base * CHILD_GROWTH));
  return Math.max(1, base + (childLevel(k) - 1) * step);
}

/* What this child can bring to a fight. The hunting track they were taught counts here as well as
   on their parent — the owner's rule, and the reason schooling one is worth the daily upkeep. */
function childPower(k) {
  const atk = childStat(k, "atk"), def = childStat(k, "defs"), vit = childStat(k, "vit");
  const taught = childTrackLevel(k, "hunt") * CHILD_HUNT_TRACK_POWER;
  /* 🎯 [owner 2026-08-23] "pet ก็จะคอยติดตามออกสู้ได้" — the companion is why giving a good breed
     to a child is worth doing rather than merely tidy. Read through the same guildTargetPower maths
     the child itself is, so a stronger pet moves the con-colours the same way a level does. */
  return (atk / 6 + def / 10 + vit / 12) * (1 + taught) + childPetPower(k);
}

/* A child's companion, or null. Same shape as one of P.pets, so petStats and every pet helper in
   the game reads it without knowing whose it is. */
function childPet(k) { return k && k.pet ? k.pet : null; }
function childPetPower(k) {
  const pet = childPet(k);
  if (!pet) return 0;
  const st = petStats(pet);
  return (st.atk / 6 + st.def / 10 + st.maxHp / 12) * CHILD_PET_POWER;
}

/* Hand a companion from the player's stable to a grown child. Auto-assigned, per the owner: the
 * button says "ให้ลูก", not "ให้ใครดี". First adult without one — a child already looking after a
 * companion should not be handed a second, and a minor cannot take one at all. */
function childPetHeir() {
  return childrenOf().filter(childIsAdult).find((k) => !childPet(k)) || null;
}
function givePetToChild(idx) {
  const pet = P.pets[idx];
  if (!pet) return null;
  const heir = childPetHeir();
  if (!heir) return null;
  heir.pet = pet;
  P.pets.splice(idx, 1);
  /* The active slot is an INDEX into a list that just got shorter. Left alone it silently points at
     a different companion, or past the end. Same shift petFuse already has to do. */
  if (P.activePet != null) {
    if (P.activePet === idx) P.activePet = P.pets.length ? 0 : null;
    else if (P.activePet > idx) P.activePet -= 1;
  }
  return heir;
}

/* Where a child is allowed to hunt: stages the PLAYER has opened, bosses excluded. A child should
 * never be the one who clears a boss, and never somewhere the player has not been.
 *
 * 🐛 [owner 2026-08-23: "พบบัคลูกไปล่าด่านที่ยังไม่ปลดล็อค"] This checked stageUnlocked alone, and
 * that is only half the gate — it returns true for the FIRST stage of every location, because
 * within a location there is no earlier stage to clear. The location itself is gated separately, by
 * combat level. So a day-one child could hunt in ห้วงกำเนิด.
 *
 * Both halves now, and taken from startCombat rather than restated: that is the function the player
 * goes through, and a child must not be able to reach anywhere the player cannot. */
function childHuntGrounds() {
  const lvl = combatLevel();
  return LOCATIONS.filter((loc) => lvl >= loc.levelReq).flatMap((loc) => loc.stages
    .map((st, i) => ({ loc, st, i }))
    /* 🎯 [owner 2026-08-23] "ลูกล่าได้เฉพาะมอนที่คุณเคยล่าเองอย่างน้อยหนึ่งตัว" — the strictest of the
       three gates and the one that matches how it reads: unlocking a zone by level is not the same
       as having been there. A child hunts where their parent has actually fought. */
    .filter((x) => !x.st.boss && stageUnlocked(x.loc, x.i) && stageKills(x.loc.id, x.i) > 0));
}

/* Where a grown child goes to work today.
 *
 * 🐛 [owner 2026-08-23: "ต้องเอามาตรฐาน lv สเตตัสตั้งก่อน เพื่อหาตัวแปรว่าจะไปด่านไหน เช่น lv99 จะบอก
 * ไปตีสไลม์ก็ไม่ใช่ มันควรเลือกมอนเขียวตัวยากสุดแทน"] Twice now this cut its bands from the LIST of
 * grounds — the hardest third of the map, the middling third, the easy third — and twice that meant
 * a level-99 child spending most of its days somewhere its level made irrelevant. Difficulty is not
 * a property of the map. It is a property of this child against that monster.
 *
 * So the bands are con-colours, measured per child, exactly as the owner described them:
 *
 *   🟢 green   success >= CHILD_HUNT_BAND_GREEN    "สู้ได้สบาย"
 *   🟡 yellow  >= CHILD_HUNT_BAND_YELLOW           "สู้ 80% ได้ แต่บางครั้งอาจไม่ไหว"
 *   🔴 red     >= CHILD_HUNT_MIN_SUCCESS           "ถ้าสู้ โอกาสชนะ 50%"
 *
 * and within whichever colour the day rolls, only the HARDEST few are in play. That second half is
 * what makes levelling pay: as a child grows, the ground that is merely green climbs with it, so a
 * green day at level 99 is the top of the map rather than the bottom of it. */
function childHuntPick(k) {
  const power = childPower(k);
  const open = childHuntGrounds();
  if (!open.length) return null;
  const rated = open
    .map((g) => ({ ...g, tp: guildTargetPower(g.st) }))
    .map((g) => ({ ...g, success: guildOutcome(power, g.tp, 0).success }))
    .sort((a, b) => a.tp - b.tp);

  const ok = rated.filter((g) => g.success >= CHILD_HUNT_MIN_SUCCESS);
  /* Not even a coin-flip anywhere — a brand-new adult takes the easiest ground open and its odds. */
  if (!ok.length) return rated[0];

  /* Hardest-first inside each colour, then only the top few of each: a band is a difficulty to work
     at, not the whole shelf of everything that happens to share a colour. */
  const top = (band) => band.slice(-CHILD_HUNT_BAND_TOP);
  const bands = [
    top(ok.filter((g) => g.success >= CHILD_HUNT_BAND_GREEN)),
    top(ok.filter((g) => g.success < CHILD_HUNT_BAND_GREEN && g.success >= CHILD_HUNT_BAND_YELLOW)),
    top(ok.filter((g) => g.success < CHILD_HUNT_BAND_YELLOW)),
  ];
  const names = ["low", "mid", "high"];
  const live = bands.map((b, i) => ({ b, w: CHILD_HUNT_TIER_WEIGHTS[names[i]] ?? 1 }))
    .filter((x) => x.b.length);
  if (!live.length) return ok[ok.length - 1];

  let roll = Math.random() * live.reduce((t, x) => t + x.w, 0);
  for (const x of live) {
    roll -= x.w;
    if (roll <= 0) return x.b[Math.floor(Math.random() * x.b.length)];
  }
  return live[0].b[0];
}

/* ---------- A grown child's errand ---------- */

/* Their level in one errand. Capped with the hunt level, and on the player's own XP curve so the
   climb reads the same as everything else in the game. */
function childErrandLevel(k, id) {
  return Math.min(CHILD_MAX_LEVEL, levelFromXp((k.chores || {})[id] || 0));
}

/* Which actions of one errand a child may work today.
 *
 * `actionOpen` is the player's own gate, reused rather than restated — a child must never reach a
 * resource its parent has not unlocked, exactly as childHuntGrounds refuses grounds the parent has
 * never fought on. Its OWN level gates it a second time, which is what makes the errand level worth
 * having: the child grows into better wood the way the player did. */
function childErrandActions(errand) {
  const skill = SKILLS.find((s) => s.id === errand.id);
  if (!skill) return [];
  return skill.actions.filter((a) => (!errand.only || a.id === errand.only) && actionOpen(errand.id, a));
}

/* One errand for one child. Returns what it brought back, or null if there was nothing open to do.
 * Everything it produces goes straight into the player's bag — the child is out working for the
 * household, not keeping a stash. */
function childErrandRun(k) {
  const open = CHILD_ERRANDS
    .map((e) => ({ e, acts: childErrandActions(e) }))
    .filter((x) => x.acts.length);
  if (!open.length) return null;

  const { e, acts } = open[Math.floor(Math.random() * open.length)];
  const lvl = childErrandLevel(k, e.id);
  /* The hardest one it is qualified for. Unlike the hunt there is no risk to trade off here — a
     harder tree is not a more dangerous tree — so there is nothing to spread across bands. */
  const fit = acts.filter((a) => lvl >= a.level);
  const action = (fit.length ? fit : acts).reduce((a, b) => (a.level >= b.level ? a : b));
  const copies = 1 + Math.floor(lvl / CHILD_ERRAND_PER_LEVELS);

  let gold = 0, items = 0;
  const take = (id, n) => {
    if (!n) return;
    P.inv[id] = (P.inv[id] || 0) + n;
    items += n;
  };

  if (action.steal) {
    const st = action.steal;
    /* Caught. The player loses HP here; a child has none to lose and cannot die, so an empty pocket
       IS the failure — the same shape as a failed hunt, minus the days off, since the owner tied
       rest to hunting injuries only. */
    if (Math.random() >= st.success) {
      k.chores = k.chores || {};
      k.chores[e.id] = (k.chores[e.id] || 0) + Math.ceil(action.xp * CHILD_ERRAND_XP * 0.5);
      return { gold: 0, items: 0 };
    }
    gold = randInt(st.gold[0], st.gold[1]) * copies;
    /* no-goldBonus / no-charm: same rule the hunt follows — the parent's perks reward what the
       parent does, and routing a child's takings through them would make children a multiplier. */
    P.gold += gold;
    bump("goldEarned", gold);
    for (const drop of st.loot || []) {
      if (Math.random() < drop.chance) take(drop.item, randInt(drop.n[0], drop.n[1]) * copies);
    }
  } else if (action.catch) {
    const table = action.catch;
    const total = table.reduce((t, c) => t + c.w, 0);
    let roll = Math.random() * total;
    let picked = table[table.length - 1].item;
    for (const c of table) { roll -= c.w; if (roll <= 0) { picked = c.item; break; } }
    take(picked, copies);
    /* Guarded: a save old enough to predate the species achievement has no seenFish at all, and a
       child fishing must not be the thing that throws on it. */
    if (P.seenFish && /^(fish|squid|crab|octo)_/.test(picked)) P.seenFish[picked] = true;
  } else if (action.outputs) {
    /* A recipe a child cannot pay for is simply not a child's errand — the four the owner named are
       all gathering, but this keeps the guard honest if the list ever grows. */
    if (action.inputs) return null;
    for (const [id, n] of Object.entries(action.outputs)) take(id, n * copies);
  } else {
    return null;
  }

  for (const rare of action.rare ? [].concat(action.rare) : []) {
    if (Math.random() < rare.base + rare.perLevel * lvl) take(rare.item, 1);
  }

  k.chores = k.chores || {};
  k.chores[e.id] = (k.chores[e.id] || 0) + Math.ceil(action.xp * CHILD_ERRAND_XP);

  return { gold, items };
}

function childNextHuntGap() {
  return CHILD_HUNT_MIN_DAYS
    + Math.floor(Math.random() * (CHILD_HUNT_MAX_DAYS - CHILD_HUNT_MIN_DAYS + 1));
}

/* One game-day for every grown child. Called from onNewDay.
 *
 * 🎯 [owner 2026-08-23] "เท่ากับวันนึงลูกต้องทำ event สุ่ม เพื่อหาของให้เรา และออกล่า" — two
 * things a day, not one. The errand is unconditional; the hunt waits on its cooldown.
 *
 * 🎯 [owner 2026-08-23] "รวมเป็นก้อน แล้วรายงานว่าลูกๆ ออกล่าได้เงิน ของ ไม่ต้องแยกตามชิ้น บอกทั้งหมด
 * กี่ชิ้นพอ" — with children outliving rebirths and now working twice a day, a household of forty is
 * eighty events every morning. One line for the whole household above the cap, or the toast rail
 * becomes the game. */
function childrenHuntDay() {
  if (P.dead) return;
  const kids = childrenOf().filter(childIsAdult);
  if (!kids.length) return;
  const today = questDay();
  /* Hunt and errand are tallied apart all the way through: they are two ledger lines and two
     different questions, and pooling them here is how the monthly summary would start lying. */
  let hGold = 0, hItems = 0, wins = 0, hurt = 0;
  let cGold = 0, cItems = 0, chores = 0;

  for (const k of kids) {
    /* 🎯 [owner 2026-08-23] "หากลูกบาดเจ็บ ไม่ออกล่า แต่ยังต้องทำ event สุ่ม" — the errand runs
       first and runs regardless. A child resting off a hunting injury still brings something home. */
    const chore = childErrandRun(k);
    if (chore) { cGold += chore.gold; cItems += chore.items; chores++; }

    if (k.nextHunt == null) { k.nextHunt = today + childNextHuntGap(); continue; }
    if (today < k.nextHunt) continue;

    const ground = childHuntPick(k);
    if (!ground) { k.nextHunt = today + childNextHuntGap(); continue; }

    const power = childPower(k);
    const tp = guildTargetPower(ground.st);
    const out = guildOutcome(power, tp, 0);
    const won = Math.random() < out.success;
    /* Injury is the only failure — the owner asked for "ไม่ได้ บาดเจ็บกลับมา", not for a child who
       can die. A household that can be wiped out by background rolls is not something to leave
       running while you do something else. */
    k.nextHunt = today + childNextHuntGap() + (won ? 0 : CHILD_HURT_REST_DAYS);
    /* 🎯 [owner 2026-08-23] "ตอนนี้มันแสดงตำแหน่งการล่าสามแห่งล่าสุด ปรับให้เหลือแห่งเดียว" */
    k.log = [(won ? "✅" : "🩹") + ` ${ground.st.name}`].slice(0, 1);
    if (!won) { hurt++; continue; }

    wins++;
    const bounty = guildBounty(ground.st);
    const g = Math.max(1, Math.round(bounty * CHILD_HUNT_GOLD_SHARE));
    /* no-goldBonus: the luck charm and rebirth karma reward what YOU hunt and steal. A child's haul
       is theirs, and scaling it by the parent's perks would make schooling one a way of multiplying
       those perks instead of a thing the child does. */
    P.gold += g; hGold += g;
    bump("goldEarned", g);

    const loot = guildLootFor(ground.st, bounty * CHILD_HUNT_LOOT_SHARE);
    for (const [id, n] of Object.entries(loot)) {
      P.inv[id] = (P.inv[id] || 0) + n;
      hItems += n;
    }
    const kxp = Math.max(1, Math.round(tp * 40));
    k.xp = (k.xp || 0) + kxp;
    /* 🎯 [owner 2026-08-23] "มี lv เพิ่มได้" — the companion levels off the same outing, at half
       share. Capped by petLevel's own ceiling, so nothing here needs to know about PET_MAX_LEVEL. */
    const pet = childPet(k);
    if (pet) pet.xp = (pet.xp || 0) + Math.max(1, Math.round(kxp * CHILD_PET_XP));
  }

  /* 🎯 [owner 2026-08-23] "notis ในตั้งค่ามันแยกเป็นสองหัวข้อ ... ปรับให้เหลือหัวข้อเดียว มันต้อง
   * รวมค่าทั้งสองแล้วแสดงเป็นค่ารายวัน"
   *
   * One line a day for the whole household. Hunting and gathering were split when they were two
   * separate switches; they are one switch now, so two lines would just be the same number twice.
   * Counted by head the way the dividend notice is — the totals are what you act on, and the family
   * page is where an individual child is looked up. */
  if (wins || hurt || chores) {
    const gold = hGold + cGold, items = hItems + cItems;
    const parts = [];
    if (wins) parts.push(`${T("ล่า")} ${wins}`);
    if (chores) parts.push(`${T("หาของ")} ${chores}`);
    if (gold) parts.push(`${T("ได้")} ${gold.toLocaleString()} 💰`);
    if (items) parts.push(`${T("ของ")} ${items} ${T("ชิ้น")}`);
    if (hurt) parts.push(`${T("บาดเจ็บ")} ${hurt} ${T("คน")}`);
    toast(`🗡️ ${T("ลูก")} ${kids.length} ${T("คน ออกทำงาน")} — ${parts.join(" · ")}`,
      hurt && !wins ? "warn" : "", "kidwork");
  }
  /* 🎯 [owner 2026-08-23] "หน้ารวมบัญชี ให้สรุปลูกออกล่า ว่ายอดรวมต่อเดือนได้เท่าไหร่" — same call
     rent got, and now more necessary: children work every day and there can be forty of them, so a
     line a day would be the whole page. Banked here, posted once by onNewMonth. */
  if (wins || chores) {
    P.kidHuntMonth = P.kidHuntMonth || { gold: 0, items: 0, hunts: 0, chores: 0 };
    P.kidHuntMonth.gold += hGold + cGold;
    P.kidHuntMonth.items += hItems + cItems;
    P.kidHuntMonth.hunts += wins;
    P.kidHuntMonth.chores = (P.kidHuntMonth.chores || 0) + chores;
  }
}

function childIsAdult(k) { return (k.age || 0) >= CHILD_ADULT_DAY; }

/* 🎯 [owner 2026-08-23] Which rebirth cycle a child belongs to. Children outlive a rebirth
   now, so "mine" and "carried over" are different lists on the family page — and `bornThisLife` is
   a count, which cannot answer this for a particular child. A save older than the field reads as
   the current life, which is what a household that has never rebirthed actually is. */
function childIsThisLife(k) { return (k.bornLife ?? 0) >= (P.rebirths || 0); }

/* Half of what we were the day they were born. A snapshot rather than a live fraction: a child
 * should record who their parent was at the time, and a live halving would drag them down with us
 * every time we rebirth. */
function newChildStats() {
  const out = {};
  for (const st of COMBAT_STATS) out[st.id] = Math.max(1, Math.floor(statLevel(st.id) / CHILD_STAT_DIVISOR));
  return out;
}

/* Rolled once per game-day while married. Nothing happens on the vast majority of days, which is
 * the point — see the note on CHILD_BIRTH_CHANCE. */
/* 🎯 [owner 2026-08-22: "สร้างภาพรูปไว้เยอะๆ แล้วค่อยหยิบมาใช้ แต่ถ้ามีลูกเยอะจนใช้รูปหมดแล้ว คนใหม่ๆ ค่อยให้ใช้ emoji"]
 * One portrait per name, and a second for the same child grown up — so อาริน is the same face in
 * every run instead of a fresh stranger each time, and the growing-up the player is meant to watch
 * is finally visible rather than being a number on a progress bar.
 *
 * Falls through to the emoji by returning an id with no file behind it: iconArt already degrades
 * that way, and markArtMissing remembers the miss, so an unnamed child costs one 404 and never
 * asks again. Naming CHILD_FACES separately from CHILD_NAMES is what keeps that promise — a
 * ninth name can be added without an art file and the game stays correct. */
/* 🎯 [owner 2026-08-23] How many portrait PATTERNS actually have pictures on disk. The art set
 * is a prefix of CHILD_FACES and is deliberately partial ("ไม่ต้องสร้างรูปหมด"), so this is the pool
 * a newborn draws from; past it, a child wears an emoji.
 *
 * Kept as a number rather than probed at runtime because a name is chosen at BIRTH and art loads
 * asynchronously at render — the game cannot know what exists at the moment it has to decide.
 * test "จำนวน pattern รูปตรงกับไฟล์ที่มีจริง" holds it to the files. */
const CHILD_ART_PATTERNS = 29;

/* 🎯 [owner 2026-08-23] "เราต้องทำการ mark ชื่อว่าเป็นผู้ชายหรือหญิง + pattern รูปเช่นกัน · เพื่อให้
 * รูปมัน match กับชื่อว่าเพศไหน เพราะลูกที่เพิ่งเกิด เคนจิ ได้รูปผู้หญิง เลยมองว่าแปลกๆ"
 *
 * Names and portraits were decoupled so a freed name would not drag its old face back — but nothing
 * then stopped a boy's name drawing a girl's portrait, which is the state the owner found.
 *
 * One list, same index as CHILD_NAMES and CHILD_FACES, because a name's sex and its picture's sex
 * have to be compared and two separate tables would drift. The picture's sex is stated in its own
 * prompt in tools/child_prompts.tsv, so this is derived from the art rather than guessed at it —
 * test "เพศของ pattern ตรงกับที่เขียนไว้ใน prompt" holds the two together. */
const CHILD_SEX = [
  "f", "f", "m", "f", "m", "f", "f", "f", "f", "m", "m", "f", "m", "f", "f", "m", "f", "m",
  "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f",
  "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "m", "f", "m", "f", "m", "f", "m",
  "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m",
  "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m", "f", "m",
  "f", "m", "f", "m", "f", "m", "f", "m", "f", "m",
];

/* 🎯 [owner 2026-08-23] "เพราะเราไม่ได้ฟิกชื่อต่อรูป" — the sex of a NAME and the sex of a
 * PORTRAIT are two different facts, and this is the second one. I first tried to make them one
 * table by regenerating the art to match the names, which was backwards: names and portraits were
 * deliberately decoupled, so the picture is a given and the matching happens at assignment.
 *
 * Read off the existing art (the adult half of each pair settles the androgynous chibi children),
 * and the prompts in tools/child_prompts.tsv are worded to agree, so a regeneration reproduces the
 * same sex. Only the first CHILD_ART_PATTERNS entries exist, because only those have pictures.
 *
 * Currently f-heavy, which is a real constraint rather than a rounding error: a boy's name with no
 * free male portrait takes an emoji rather than a girl's picture. */
const CHILD_FACE_SEX = ["f", "f", "m", "f", "m", "f", "f", "f", "f", "f", "f", "f", "m", "f", "m", "f", "f", "f", "f", "f", "f", "f", "f", "f", "m", "f", "f", "m", "f"];

/* One portrait id per pattern index. NOT keyed to CHILD_NAMES any more — see childFaceId. A face with no picture on disk falls back to
   its emoji through iconArt — the owner's own rule for outrunning the art we have: "ถ้ามีลูกเยอะจนใช้
   รูปหมดแล้ว คนใหม่ๆ ค่อยให้ใช้ emoji". Append only; see CHILD_NAMES. */
const CHILD_FACES = [
  "arin", "nara", "kenji", "lily", "taro", "mina", "zoe", "yuki", "aiko", "haru", "ren",
  "sakura", "kaito", "noa", "emi", "riku", "hana", "sora", "yuto", "maya", "kei", "aya",
  "takumi", "nana", "shin", "mio", "hikaru", "rina", "daiki", "yuna", "koji", "saki", "tetsu",
  "aki", "ryu", "momo", "kenta", "shiho", "hiro", "nao", "jun", "eri", "sota", "miki", "ryota",
  "hiyori", "kazu", "ichi", "mei", "takeru", "tsubaki", "yoshi", "kana", "aden", "ivy", "finn",
  "rosa", "milo", "ella", "theo", "iris", "lucas", "nora", "felix", "clara", "oscar", "hazel",
  "julian", "marin", "silas", "vega", "orion", "luna", "caspian", "elara", "cairo", "selene",
  "arthur", "lyra", "ezra", "thalia", "rowan", "esme", "byron", "neva", "kieran", "sasha",
  "damir", "anya", "mylo", "vera", "nico", "talia", "ivan", "mira", "owen", "lara", "yan",
  "nina", "damien",
];
/* 🎯 [owner 2026-08-23] "ต้องมองว่าให้รูปเป็น pattern มันไม่ล็อกกับชื่อตรงๆ แต่จะล็อกกับ slot
 * ล่าสุด · พอจุติ pattern 26 pattern 31 จะว่าง แต่ยังไม่โดนหยิบมาใช้ทันที ไม่งั้นจุติรอบใหม่อาจได้รูปลูก
 * คนเดิม ต้องล็อกไว้ก่อน แล้วค่อยคลายจุติหน้า"
 *
 * A portrait used to be whatever CHILD_NAMES.indexOf(name) landed on, which welded the two together
 * — the same name always wore the same face, so a freed name brought its face back with it. They
 * are separate resources now: a child holds a PATTERN, recorded on itself, and the name is drawn
 * independently.
 *
 * `k.face == null` means emoji, which is a legitimate state rather than a failure: art is
 * deliberately partial, and a child from an earlier life uses emoji regardless (see the fam-face
 * branch in renderFamily). */
function childFaceId(k, adult) {
  const i = k.face;
  const face = i != null && i >= 0 && i < CHILD_FACES.length ? CHILD_FACES[i] : "none";
  return adult ? `${face}_adult` : face;
}

/* Which patterns are spoken for right now.
 *
 * Two claims, and they are different in kind. A LIVING child of this life is wearing its pattern.
 * A COOLING pattern belongs to the cycle that just ended — those children have moved to emoji, so
 * the pattern is technically free, but handing it straight back would put last life's faces on this
 * life's children, which is the thing the owner asked to prevent. It is released one rebirth later.
 */
function childFaceTaken() {
  const taken = new Set(P.family?.faceCool || []);
  for (const k of childrenOf()) if (childIsThisLife(k) && k.face != null) taken.add(k.face);
  return taken;
}

/* The sex a name implies, and the sex a portrait was drawn as. Same table, because the whole point
   is comparing them. */
function childSexOfName(name) {
  const i = CHILD_NAMES.indexOf(name);
  return i >= 0 ? CHILD_SEX[i] : null;
}
function childSexOfFace(i) { return i != null && CHILD_FACE_SEX[i] ? CHILD_FACE_SEX[i] : null; }

/* A pattern for a newborn, or null when none is free — in which case they wear an emoji, which is a
 * look, not a bug.
 *
 * 🎯 [owner 2026-08-23] "เพื่อให้รูปมัน match กับชื่อว่าเพศไหน" — drawn only from portraits of the
 * same sex as the name. Falling back to the whole pool when that runs out was considered and
 * rejected: a boy in a girl's portrait is exactly the thing being fixed, and an emoji says nothing
 * false. */
function childPickFace(sex) {
  const taken = childFaceTaken();
  const free = [];
  for (let i = 0; i < CHILD_ART_PATTERNS; i++) {
    if (taken.has(i)) continue;
    if (sex && childSexOfFace(i) !== sex) continue;
    free.push(i);
  }
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

/* 🎯 [owner 2026-08-22] What a household costs per game-day, itemised so the family screen can show
 * the player where the number comes from rather than one total they have to trust. */
function familyUpkeep() {
  const wives = spouseIds();
  const kids = wives.length ? childrenOf() : [];
  const spouse = wives.length * FAMILY_UPKEEP_SPOUSE;
  const heads = kids.length * FAMILY_UPKEEP_CHILD;
  let eduLevels = 0;
  for (const k of kids) for (const tr of CHILD_TRACKS) eduLevels += childTrackLevel(k, tr.id);
  const edu = eduLevels * FAMILY_UPKEEP_PER_EDU;
  return { spouse, heads, edu, eduLevels, kids: kids.length, total: spouse + heads + edu };
}

/* Unpaid upkeep suspends what the household gives back. The owner's rule — "หักไม่ได้ช่วงแรก โบนัสจะหาย"
 * — and the honest version of it: a family you cannot feed does not keep working for you. It is a
 * suspension, not a loss; clearing the arrears restores every bonus untouched. */
function familyInArrears() { return (P.family?.arrears || 0) > 0; }

/* Whether this wife is currently on birth control, and the toggle for it. Stored per villager id so
   the answer survives everything the owner listed: a reload, a tab switch, and a rebirth. */
function wifeOnControl(id) { return !!P.family?.noKids?.[id]; }
function toggleWifeControl(id) {
  P.family = P.family || {};
  P.family.noKids = P.family.noKids || {};
  if (P.family.noKids[id]) delete P.family.noKids[id];
  else P.family.noKids[id] = true;
  const v = VILLAGERS.find((x) => x.id === id);
  toast(P.family.noKids[id]
    ? `🚫 คุมกำเนิดกับ${v ? v.name : "คู่ชีวิต"}แล้ว — จะไม่มีลูกเพิ่มจนกว่าจะปิด`
    : `👶 เลิกคุมกำเนิดกับ${v ? v.name : "คู่ชีวิต"} — มีลูกได้ตามปกติ`, "", "family");
  save("คุมกำเนิด");
  return !!P.family.noKids[id];
}

/* Charged once per game-day. Anything the wallet and bank cannot cover is left as a real negative
 * balance rather than quietly forgiven, which is what hands the run to taxDebtCheck's 90-day clock —
 * the owner asked for "สามเดือน เกม over" and that clock already exists, counting consecutive days at
 * P.gold < 0 whatever put it there. So there is no second game-over path to keep in step with the
 * first. */
function familyUpkeepDay() {
  if (P.dead) return;
  P.family = P.family || {};
  /* Kept as it was: a household with no spouse is charged nothing. An existing DEBT is still
     collected below, so divorcing is not a way to walk away from what is already owed. */
  const due = spouseIds().length ? familyUpkeep().total : 0;
  const owed = Math.round((P.family.arrears || 0) + due);
  if (owed <= 0) { P.family.arrearsDays = 0; return; }

  /* 🎯 [owner 2026-08-23] "ครอบครัวจะไม่หักธนาคาร" — cash only, every ordinary day. Savings are
     out of reach until the ninety days below have run out, which is the whole point of the change:
     what the wallet cannot cover WAITS rather than quietly eating a deposit slip. */
  const paid = Math.min(Math.max(0, Math.floor(P.gold)), owed);
  P.gold -= paid;
  let short = owed - paid;
  P.family.arrears = short;
  /* 🎯 [owner 2026-08-22] "ให้รวมค่าครอบครัวรายวัน แล้วแสดงผลเป็นยอดสิ้นเดือนในบัญชีแทน" — the
     money still leaves every day; only the ledger line is monthly. Banked here, posted by
     onNewMonth. */
  P.family.monthPaid = (P.family.monthPaid || 0) + paid;

  if (short <= 0) {
    /* Cash came back and cleared it. The counter starts again from zero, not from where it was. */
    const wasBehind = P.family.arrearsDays || 0;
    P.family.arrearsDays = 0;
    if (wasBehind) {
      toast(`👏 เคลียร์ค่าเลี้ยงดูที่ค้าง ${wasBehind} วันได้แล้ว — โบนัสครอบครัวกลับมา`, "levelup", "family");
    } else if (!P.family.noteDay || Math.floor(P.gameDays) - P.family.noteDay >= 1) {
      P.family.noteDay = Math.floor(P.gameDays);
      toast(`👨‍👩‍👧 ค่าเลี้ยงดูครอบครัววันนี้ ${due.toLocaleString()} 💰`, "", "family");
    }
    return;
  }

  const days = (P.family.arrearsDays || 0) + 1;
  P.family.arrearsDays = days;

  /* 🎯 [owner 2026-08-23] "ครบ 90 วันก็ค่อยหัก แบบมี notis ถ้าหักจากกระเป๋าและธนาคารไม่ได้ เกม
     โอเวอร์" — the one day the savings are fair game, announced when it happens rather than
     discovered later in a shrunken deposit slip. */
  if (days >= FAMILY_ARREARS_FATAL_DAYS) {
    const took = takeGoldThenBank(short);
    short -= took;
    P.family.arrears = short;
    P.family.monthPaid = (P.family.monthPaid || 0) + took;
    if (took > 0) ledger("🚨", `หักค่าเลี้ยงดูที่ค้าง ${days} วัน`, -took);
    if (short > 0) {
      endRun(`ค้างค่าเลี้ยงดู ${Math.round(owed).toLocaleString()} 💰 ครบ ${FAMILY_ARREARS_FATAL_DAYS}`
             + ` วันในเกม และเงินในกระเป๋ากับธนาคารรวมกันยังไม่พอ`);
      return;
    }
    P.family.arrearsDays = 0;
    toast(`🚨 ค้างค่าเลี้ยงดูครบ ${FAMILY_ARREARS_FATAL_DAYS} วัน — หักจากกระเป๋าและเงินฝาก`
          + ` ${took.toLocaleString()} 💰 เคลียร์หนี้แล้ว`, "warn");
    return;
  }

  /* 🎯 [owner 2026-08-22: "หักค่าใช้จ่าย ต้องมี Notis แจ้งด้วย"] Deliberately uncategorised: toast()
   * filters on category alone and the settings panel promises warnings cannot be switched off. This
   * is the only notice between a missed payment and the run ending, so it must not be mutable.
   *
   * Rate-limited though, which the old one was not: ninety consecutive identical warnings is the
   * flood the owner has objected to twice. First day, every tenth after, and daily in the last week. */
  const left = FAMILY_ARREARS_FATAL_DAYS - days;
  if (days === 1 || days % FAMILY_ARREARS_WARN_EVERY === 0 || left <= FAMILY_ARREARS_WARN_FINAL) {
    toast(`⚠️ ค่าเลี้ยงดูค้าง ${Math.round(short).toLocaleString()} 💰 · ติดค้างมา ${days} วัน`
          + ` — โบนัสจากภรรยาและลูกหยุดจนกว่าจะเคลียร์ · อีก ${left} วันจะถูกหักจากเงินฝาก`
          + ` ถ้าไม่พอคือจบเกม`, "warn");
  }
}

function childBirthRoll() {
  const wives = spouseIds();
  if (!wives.length) return;
  const kids = childrenOf();
  P.family = P.family || {};
  if ((P.family.bornThisLife ?? kids.length) >= CHILD_MAX) return;

  /* 🎯 [owner 2026-08-23] Two limits, and they are not the same limit — I removed this one earlier
   * on the reading that the per-life cap made it redundant, and he corrected it:
   *
   *   per wife   one child a year, counted from HER last birth
   *   per life   four children total, however many wives there are
   *
   * The cap is on the household, not on each woman, so without the yearly clock one wife could fill
   * all four slots in a fortnight. With it, four children across a life means either four wives or
   * several years — which is the pace the growing-up was written for. */
  P.family.lastBirthByWife = P.family.lastBirthByWife || {};
  const today = questDay();
  for (const id of wives) {
    /* 🎯 [owner 2026-08-22: "ในภรรยาที่แต่งงาน จะมีปุ่มควบคุมการมีบุตร ให้เลือกคุมได้ ค่านี้จะโดนจำไป
     * ด้วย ต้องจุติ หรือสลับ tab ว่าเราเลือกคุมอยู่หรือไม่คุม"] Per wife, and remembered — it is
     * stored on the profile rather than in a module variable so it survives a reload, a tab switch
     * and a rebirth. Which matters more than it sounds: children outlive a rebirth now, so upkeep
     * only ever grows, and a setting that quietly reset would hand a player four more mouths every
     * time they were reborn. */
    if (P.family.noKids?.[id]) continue;
    const last = P.family.lastBirthByWife[id] ?? (wives.length === 1 ? P.family.lastBirthDay : null);
    if (last != null && today - last < DAYS_PER_YEAR) continue;
    if (Math.random() >= CHILD_BIRTH_CHANCE) continue;

    /* 🎯 [owner 2026-08-23] "เพิ่มระบบแรนด้อมชื่อด้วยดีกว่าไหม ไม่งั้น จุติ 3 ไล่ นารา → เคนจิ ·
       จุติ 4 มีลูก นารา → เคนจิ มาอีกรอบ" — taking the FIRST free name made the order deterministic,
       so a household that keeps disowning walks the same list in the same sequence every cycle.
       Drawn at random from what is free instead.

       🎯 [owner 2026-08-23] "การไล่ลูกออกไปแล้ว ไม่นับเป็นลูก ดังนั้นอนาคตยังสามารถใช้ชื่อนั้นๆ ได้" —
       free means no LIVING child holds it. A disowned name really is released. */
    const free = CHILD_NAMES.filter((n) => !kids.some((k) => k.name === n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)]
                             : `ลูกคนที่ ${kids.length + 1}`;
    const mother = VILLAGERS.find((v) => v.id === id);
    /* 🎯 [owner 2026-08-23] "ลูกที่จุติในรอบนี้ ... bullet ลูกที่จุติรอบก่อนๆ" — the family page
       splits on this, and there was no per-child record of it: bornThisLife is a COUNT, which
       cannot say which child it refers to once they outlive the life they were born in. */
    kids.push({ id: `k${today}_${kids.length}`, name, bornDay: today, age: 0, bornLife: P.rebirths || 0,
                face: childPickFace(childSexOfName(name)), sex: childSexOfName(name),
                parent: id, stats: newChildStats(), edu: {} });
    P.family.lastBirthByWife[id] = today;
    P.family.lastBirthDay = today;
    P.family.bornThisLife = (P.family.bornThisLife || 0) + 1;
    toast(`👶 ${name} เกิดแล้ว! ลูกของคุณกับ${mother ? mother.name : "คู่ชีวิต"}`
          + ` · ค่าเลี้ยงดูขึ้นเป็นวันละ ${familyUpkeep().total.toLocaleString()} 💰`, "levelup", "family");
    save("ลูกเกิด");
    /* One birth a day at most, whatever the household size — two babies in one toast stack is a
     * result the player cannot follow, and the cap is about to stop the second one anyway. */
    break;
  }
}

/* One day older. Called from onNewDay so growth follows the game calendar, and stored as its own
 * counter so a rebirth's clock reset cannot corrupt it. */
function childrenAgeDay() {
  for (const k of childrenOf()) {
    const was = childIsAdult(k);
    k.age = (k.age || 0) + 1;
    if (!was && childIsAdult(k)) {
      toast(`🎓 ${k.name} โตพอจะออกผจญภัยเองแล้ว`, "levelup", "family");
    }
  }
}

function childTrackLevel(k, trackId) { return (k.edu || {})[trackId] || 0; }

function childTrainNext(k, trackId) {
  const lv = childTrackLevel(k, trackId);
  if (lv >= CHILD_TRACK_MAX) return null;
  return { lv, cost: childTrainCost(lv) };
}

function trainChild(kidId, trackId) {
  const k = childrenOf().find((x) => x.id === kidId);
  const tr = CHILD_TRACKS.find((x) => x.id === trackId);
  if (!k || !tr) return false;
  const next = childTrainNext(k, trackId);
  if (!next) { toast(`${k.name} เรียน${tr.name}จนสุดสายแล้ว`, "warn"); return false; }
  if (P.gold < next.cost) { toast(`ต้องมี ${fmtNum(next.cost)} ทองเพื่อส่ง${k.name}เรียน${tr.name}`, "warn"); return false; }
  P.gold -= next.cost;
  bump("eduSpent", next.cost);
  k.edu = k.edu || {};
  k.edu[trackId] = next.lv + 1;
  toast(`${tr.icon} ${k.name} เรียน${tr.name}ถึงขั้น ${next.lv + 1} แล้ว`, "levelup", "family");
  save("ส่งลูกเรียน");
  return true;
}

/* What the children contribute, summed by bonus kind. Joined to the same totals as gear, perks and
 * relationships — see relBonusTotal for why a bonus must not have its own later pass. */
function childBonusTotal(kind) {
  if (familyInArrears()) return 0;
  let total = 0;
  for (const k of childrenOf()) {
    for (const tr of CHILD_TRACKS) {
      if (tr.kind !== kind) continue;
      total += childTrackLevel(k, tr.id) * tr.per;
    }
  }
  return total;
}

/* Rebirth takes the children with it — the owner's rule, and the reason educating them is a
 * decision rather than a place to park gold. */
/* 🎯 [owner 2026-08-22] "ในรอบจุติต่อรอบ คือ มีลูกได้ max 4 คน ถ้าจุติ จะไม่นับลูกคนเก่าในเงื่อนไข"
 * — the cap is per life, and a new life starts owing nothing to the last one. Counting births
 * explicitly rather than inferring the number from who is still at home: adults stay on the roster
 * today, so the two agree, but the rule the owner stated is about how many were BORN and should not
 * quietly change meaning the first time a grown child moves out. The spacing clock resets with it,
 * so a new marriage is not made to wait out the previous life's cooldown. */
/* 🎯 [owner 2026-08-22] "เพิ่มปุ่มลูกที่มี เราสามารถเลือกลบ คือการไล่ออกจากตระกูลได้"
 *
 * A household is a running cost now, and the cap is on births rather than on who is still at home —
 * so without this a player who schooled the wrong child is stuck paying for them for the rest of the
 * life with no way out.
 *
 * It does NOT give the birth back. bornThisLife stays where it is, because the rule the owner set is
 * four CHILDREN PER LIFE, and refunding a slot for a child sent away would turn the cost of a
 * mistake into a way of rerolling one. What it does return is the daily upkeep, immediately.
 *
 * The mother's yearly clock is left alone for the same reason: her year is about when she last gave
 * birth, and that did happen. */
function disownChild(id) {
  const kids = childrenOf();
  const i = kids.findIndex((k) => k.id === id);
  if (i < 0) return false;
  const gone = kids[i];
  /* 🐛 [owner 2026-08-23: "เช็คว่าถ้าไล่ลูกที่โตและมีมอนสเตอร์อยู่ มอนสเตอร์จะโดนพากลับ ไม่ได้บัค
     หายติดไปด้วย"] It was destroyed with the child. A companion is not part of the child — the family
     page already lets you take one back — and a bred legendary handed down should not be something a
     disown quietly eats. It comes home instead, keeping every level it earned. */
  const pet = childPet(gone);
  if (pet) {
    P.pets.push(pet);
    delete gone.pet;
    if (P.activePet == null) P.activePet = P.pets.length - 1;
  }
  kids.splice(i, 1);
  toast(`💔 ${gone.name} ออกจากตระกูลแล้ว — ค่าเลี้ยงดูเหลือวันละ ${familyUpkeep().total.toLocaleString()} 💰`
        + (pet ? ` · ${petStats(pet).icon} ${petStats(pet).name} กลับมาอยู่กับเรา` : ""),
        "warn", "family");
  save("ไล่ลูกออกจากตระกูล");
  return true;
}

/* 🎯 [owner 2026-08-22] "ให้ลูกอยู่ข้ามชาติเหมือนภรรยา" — children used to be lost here, which was
 * his own earlier design and stopped fitting once marriages started surviving: a child whose mother
 * you are still married to should not vanish while she stays.
 *
 * The consequence is deliberate and is the thing to keep in view when tuning anything: the household
 * has no ceiling any more. Four births per life, none of them cleared, so upkeep grows by roughly
 * 4 × (child + their schooling) every rebirth and never comes down. The cap the hint on the family
 * screen talks about is a cap on BIRTHS THIS LIFE, not on how many people you are feeding. */
function childrenRebirth() {
  /* 🐛 [owner 2026-08-22: "เจอบัค จุติลูกหาย"] Losing the children is the design. Keeping their BILL
   * was not. Arrears used to survive the rebirth, and since upkeep is 0 with no household there is
   * nothing left to pay them down with — so the debt of a family that no longer exists suspended the
   * spouse and child bonuses for the whole of the next life, permanently and with no way back.
   * monthPaid survived too, which posted the dead household's charge in the new life's first month.
   *
   * Everything about the family resets together, because every field here describes a household that
   * has just ceased to exist. kidsRepaired is the one exception: it records that a one-time repair
   * already ran on this save, which is true regardless of how many lives it outlives. */
  /* Two fields outlive the life they were set in, for opposite reasons: kidsRepaired records that a
     one-time repair already ran on this save, and noKids is a standing instruction the owner gave
     per wife. Rebuilding the object wholesale is what lost the second one — and losing it is the
     expensive direction now that children accumulate across rebirths. */
  /* 🎯 [owner 2026-08-23] "การจุติ ให้เหมือนพ่อ ค่า lv โดนลดตาม โจมตี ป้องกัน hp ลดตาม" — halve the
   * LEVEL and the stats follow, because they are derived from it. Same floor rule the father has:
   * a second rebirth in quick succession must never compute something lower than the last one left
   * behind. The level is reduced rather than zeroed, and its fractional part is kept as leftover
   * XP, so a level in progress is not thrown away. */
  for (const k of P.kids || []) {
    const wasLv = childLevel(k);
    /* Reduced through the LEVEL, like everything else a rebirth touches, not by halving the raw XP
       the way this used to. Children ride the same curve as companions (petXpToReach, ceiling 99),
       so the same exact-level helpers apply and the remainder survives as leftover XP. Cutting the
       stored XP instead quietly cut something different: on a superlinear curve half the XP is not
       half the level, so a child fell by a different amount than its father and its own pet. */
    k.xp = petXpAtExact(petLevelExact({ xp: k.xp || 0 }) * REBIRTH_KEEP);
    k.lvFloor = Math.max(k.lvFloor || 1, Math.floor(wasLv * REBIRTH_KEEP));
    const floorXp = petXpToReach(Math.max(1, k.lvFloor));
    if ((k.xp || 0) < floorXp) k.xp = floorXp;
    k.nextHunt = null;          // a new life, a new schedule
    /* 🎯 [owner 2026-08-23] "เมื่อจุติ pet ของลูกๆ ก็จะยังไม่หาย แต่ค่าจะเหมือน pet เราที่โดนหารครึ่ง
       ซึ่งมันตรงกับลูกเรา ที่เมื่อเราจุติ ค่าก็โดนหารครึ่ง" — the same three lines doRebirth runs on the
       keeper, so the child's companion and the player's are reduced by one rule, not two that drift. */
    petRebirthReduce(childPet(k));
  }

  const repaired = P.family?.kidsRepaired;
  const noKids = P.family?.noKids || {};
  /* 🎯 [owner 2026-08-23] "พอจุติ pattern 26 pattern 31 จะว่าง แต่ยังไม่โดนหยิบมาใช้ทันที ไม่งั้น
     จุติรอบใหม่อาจได้รูปลูกคนเดิม ต้องล็อกไว้ก่อน แล้วค่อยคลายจุติหน้า"

     The children of the life just ending move to emoji, so their patterns really are free — and
     handing them straight to the next four would put last life's faces on this life's children,
     which is the whole thing this prevents. Held for one cycle.

     Assigning REPLACES the previous cool list, which is what releases it: a pattern sits out
     exactly one rebirth, not forever. Read before P.rebirths increments, so childIsThisLife still
     means the cycle that is ending. */
  const faceCool = (P.kids || []).filter((k) => childIsThisLife(k) && k.face != null)
    .map((k) => k.face);
  P.family = { arrears: 0, noteDay: null, lastBirthDay: null, lastBirthByWife: {},
               bornThisLife: 0, monthPaid: 0, kidsRepaired: repaired, noKids, faceCool };
}

/* ---------- 📜 เควส ----------
 * See the QUEST_* note in data.js. The board lives on P.quests and is refilled by onNewDay.
 */

/* 🐛 [fixed 2026-08-22, owner: "วันมันแสดงเหลือเป็นเศษวัน แปลกๆ"] P.gameDays counts seconds into
 * fractions of a day, so "6 days from now" minus "now" is 5.37, and the board said so. Every other
 * day-keeping thing in the game floors it first — the tax bills, the seize notice, the deposit
 * slips — and quests have to do the same or a job silently expires part-way through its last day. */
function questDay() { return Math.floor(P.gameDays); }

/* Items a quest may ask for: anything the player can actually obtain, which means anything with a
 * source. Asking for something unreachable turns the board into a wall. */
function questItemPool() {
  return Object.keys(ITEMS).filter((id) => (ITEMS[id].sell || 0) > 0 && !!bestSource(id));
}

/* One job. Pay is derived from the goods' own sell value so it can never be worth less than simply
 * selling them — a board that pays under market is a board nobody should use. */
function makeQuest(dayNow, whoId = null) {
  const pool = questItemPool();
  if (!pool.length) return null;
  const item = pool[Math.floor(Math.random() * pool.length)];
  const qty = randInt(QUEST_MIN_QTY, QUEST_MAX_QTY);
  const who = VILLAGERS.find((v) => v.id === whoId)
           || VILLAGERS[Math.floor(Math.random() * VILLAGERS.length)];
  const gold = Math.max(1, Math.round((ITEMS[item].sell || 1) * qty * QUEST_PAY_MULT));
  return {
    id: `q${dayNow}_${Math.floor(Math.random() * 1e6)}`,
    who: who.id, item, qty, gold,
    xp: Math.max(1, Math.round(gold * QUEST_XP_PER_GOLD)),
    until: dayNow + QUEST_DAYS,
  };
}

/* Refill and expire. Called from onNewDay, and once on load so a save made before quests existed
 * does not open an empty board. */
function refreshQuests(dayNow = questDay()) {
  dayNow = Math.floor(dayNow);
  if (!P) return;
  P.quests = (P.quests || []).filter((q) => q.until > dayNow);
  /* One job per villager, in roster order. Everyone always has something to ask for, so the board
   * reads as the people you know rather than as a lottery that happened to skip three of them. */
  for (const v of VILLAGERS) {
    if (P.quests.some((q) => q.who === v.id)) continue;
    let q = null;
    for (let tries = 0; tries < 30 && !q; tries++) {
      const cand = makeQuest(dayNow, v.id);
      // Two people asking for the same item on one board reads as a bug rather than as variety.
      if (cand && !P.quests.some((x) => x.item === cand.item)) q = cand;
    }
    if (q) P.quests.push(q);
  }
  // Keep them in roster order however they were added, so the board does not reshuffle each day.
  P.quests.sort((a, b) => VILLAGERS.findIndex((v) => v.id === a.who)
                        - VILLAGERS.findIndex((v) => v.id === b.who));
}

function questVillager(q) {
  return VILLAGERS.find((v) => v.id === q.who) || VILLAGERS[0];
}

/* Can this be handed in right now? Uses sellableCount so an item that is only in the bag because
 * it is equipped does not count — handing in your own sword would be a surprise. */
function questReady(q) {
  return sellableCount(q.item) >= q.qty;
}

/* Hand it in. Returns true when it actually completed, so the caller knows whether to re-render. */
function completeQuest(qid) {
  const i = (P.quests || []).findIndex((q) => q.id === qid);
  if (i < 0) return false;
  const q = P.quests[i];
  if (!questReady(q)) {
    // Not a failure — this is the other half of the feature. Offer where the item comes from, and
    // let the player pick when there is more than one way to get it.
    chooseSource(q.item);
    return false;
  }
  P.inv[q.item] -= q.qty;
  if (P.inv[q.item] <= 0) delete P.inv[q.item];
  /* no-goldBonus: a quest fee is a price agreed with a villager, not treasure taken off a corpse.
   * The luck charm and rebirth karma reward hunting and stealing, and payment for delivered goods
   * is the same shape as a sale, which is exempt for the same reason. */
  P.gold += q.gold;
  bump("goldEarned", q.gold);
  /* XP lands on whichever stat is being trained, exactly like a kill does — the quest board is
   * not a second progression track, it is another way to feed the one that exists. */
  const focus = COMBAT_STATS.find((x) => x.id === P.trainFocus) || COMBAT_STATS[0];
  P.cb[focus.id] = (P.cb[focus.id] || 0) + q.xp;
  P.quests.splice(i, 1);
  bump("questsDone");
  bump("questGold", q.gold);
  const v = questVillager(q);
  relCredit(v.id);
  toast(`${v.icon} ${v.name}: ขอบคุณมาก! ได้ ${fmtNum(q.gold)} ทอง`, "money", "quest");
  save("ส่งเควส");
  return true;
}

/* The player's current title. Computed, never stored — see the TITLES note in data.js.
 *
 * Each track is measured against its OWN pool, which is the whole point of the rewrite: achievements
 * are 18, marks are 196, and species-mastered is 49. Mixing them is what let the crown arrive at 8%
 * of the game. */
function titleProgress(p = P) {
  const rows = slayerRows();
  const marksDone = rows.filter((r) => p.slayer?.[r.mark]).length;
  const ach = p.achieved || {};
  const species = new Set(rows.map((r) => `${r.loc.id}:${r.i}`)).size;
  return {
    rows, marksDone, marksTotal: rows.length,
    ach: Object.keys(ach).length, achTotal: ACHIEVEMENTS.length,
    bane: baneCount(p), baneTotal: species,
    work: ["first_steps", "worker", "tireless"].every((id) => ach[id]) ? 1 : 0,
    reb: p.rebirths || 0,
  };
}

/* What one title asks for, and how far along it is — so a caller never has to know which pool a
 * given track is measured against. `need: null` means "all of them", whatever that is today. */
function titleTrack(tt, pr) {
  const at = { ach: pr.ach, mark: pr.marksDone, bane: pr.bane, work: pr.work, reb: pr.reb }[tt.track];
  const total = { ach: pr.achTotal, mark: pr.marksTotal, bane: pr.baneTotal, work: 1, reb: null }[tt.track];
  const need = tt.need == null ? total : tt.need;
  return { at: at || 0, need, total, held: (at || 0) >= need };
}

function titleFor(p = P) {
  if (!p) return null;
  const pr = titleProgress(p);
  let best = null;
  for (const tt of TITLES) {
    if (!titleTrack(tt, pr).held) continue;
    if (!best || tt.rank > best.rank) best = tt;
  }
  /* Rank 0 is held by everyone, so this only fires on a profile with no TITLES at all. */
  if (!best) return null;
  const tr = titleTrack(best, pr);
  return { ...best, at: tr.at, need: tr.need, progress: pr };
}

/* The cheapest title not yet held — "cheapest" by how much is still missing on its own track, not
 * by rank, because the three ladders are not comparable in units. Null once everything is held. */
function nextTitle(p = P) {
  const pr = titleProgress(p);
  let best = null;
  for (const tt of TITLES) {
    const tr = titleTrack(tt, pr);
    if (tr.held) continue;
    const left = tr.need - tr.at;
    if (!best || left < best.need) best = { ...tt, need: left, at: tr.at, of: tr.need };
  }
  return best;
}



/* Slayer marks: one per monster per difficulty, each worth a permanent stat. Summed on demand, so
 * nothing but the flag is stored and retuning the table retunes every save at once — but totalDmg()
 * runs on every swing, so the sum is cached and invalidated only when a mark is actually earned. */
let __slayerCache = null;
function invalidateSlayer() { __slayerCache = null; }
function slayerTotals() {
  if (__slayerCache) return __slayerCache;
  const out = { dmg: 0, def: 0, hp: 0 };
  for (const mark of Object.keys(P.slayer || {})) {
    const [locId, idxStr, tierId] = mark.split(":");
    const raw = LOCATIONS.find((l) => l.id === locId)?.stages[Number(idxStr)];
    if (!raw) continue;                       // a monster removed from the game pays nothing
    const ti = SLAYER_TIERS.findIndex((t) => t.tier === tierId);
    if (ti < 0) continue;
    const key = slayerRewardKey(locId, raw.id);
    out[key] += SLAYER_REWARDS[key].per[ti];
  }
  return (__slayerCache = out);
}

/* Permanent perks from earned achievements, summed. */
function perkTotal(key) {
  // goldBonus is the one perk rebirth also feeds, so every gold site picks karma up for free.
  let total = 0;
  for (const a of ACHIEVEMENTS) if (P.achieved[a.id] && a.perk[key]) total += a.perk[key];
  if (key === "goldBonus") total += karmaGold();
  /* Perks banked from the per-monster achievements that slayer marks replaced. Earned once, kept
   * forever — the system they came from is gone, the bonus is not. */
  if (P.legacyPerk?.[key]) total += P.legacyPerk[key];
  const slayer = slayerTotals()[key];
  if (slayer) total += slayer;
  return total;
}

function gearStats() {
  const total = { dmg: 0, def: 0, hpBonus: 0 };
  for (const s of EQUIP_SLOTS) {
    const item = equippedItem(s.id);
    if (!item) continue;
    total.dmg += item.dmg || 0;
    total.def += item.def || 0;
    total.hpBonus += item.hpBonus || 0;
  }
  for (const set of activeSets()) {
    total.dmg += set.bonus.dmg || 0;
    total.def += set.bonus.def || 0;
    total.hpBonus += set.bonus.hpBonus || 0;
  }
  return total;
}

/* Momentum: seconds spent without switching jobs, and the tier that earns. */
let momentumSince = 0;
let momentumKey = null;
function momentumTier() {
  if (!P.slots.length || !momentumSince) return MOMENTUM_TIERS[0];
  const held = (performance.now() - momentumSince) / 1000;
  let tier = MOMENTUM_TIERS[0];
  for (const t of MOMENTUM_TIERS) if (held >= t.at) tier = t;
  return tier;
}
function noteActivity(key) {
  if (momentumKey !== key) { momentumKey = key; momentumSince = performance.now(); }
}

/* Timed buffs granted by random events. */
let buffs = { surge: 0, haste: 0 };
const buffActive = (k) => buffs[k] > performance.now();

function maxHp() { return playerMaxHp(statLevel("vit")) + gearStats().hpBonus + charmValue("hp") + perkTotal("hp"); }
function totalDmg() {
  /* Relationship bonuses join the same sum as gear and achievement perks rather than being applied
   * later — a bonus that lives in its own pass is one that some future call site forgets. */
  return playerBaseDmg(statLevel("atk")) + gearStats().dmg + perkTotal("dmg") + relBonusTotal("dmg") + childBonusTotal("dmg");
}
function totalDef() {
  return gearStats().def + statDefBonus(statLevel("defs")) + charmValue("def") + perkTotal("def");
}
function luckTotal() { return charmValue("luck") + perkTotal("luck") + relBonusTotal("luck"); }

function stageKills(locId, idx) { return P.kills[`${locId}:${idx}`] || 0; }

/* The active difficulty multiplier set, and which tiers the player has earned. */
function eliteMode() { return ELITE_MODES.find((m) => m.id === P.eliteMode) || ELITE_MODES[0]; }
function eliteUnlocked(mode, loc, idx) {
  if (mode.id === "normal") return true;
  // A harder tier opens once this stage is cleared at the tier below it.
  const order = ELITE_MODES.map((m) => m.id);
  const prev = order[order.indexOf(mode.id) - 1];
  return (P.kills[`${loc.id}:${idx}:${prev}`] || 0) >= KILLS_TO_UNLOCK_NEXT_STAGE
      || (prev === "normal" && stageKills(loc.id, idx) >= KILLS_TO_UNLOCK_NEXT_STAGE);
}
function scaledStage(stage) {
  const m = eliteMode();
  return { ...stage,
    hp: Math.round(stage.hp * m.hp), dmg: Math.round(stage.dmg * m.dmg),
    xp: Math.round(stage.xp * m.xp),
    gold: [Math.round(stage.gold[0] * m.gold), Math.round(stage.gold[1] * m.gold)],
    loot: stage.loot.map((d) => ({ ...d, chance: Math.min(1, d.chance * m.loot) })) };
}

function stageUnlocked(loc, idx) {
  const stage = loc.stages[idx];
  if (stage.boss) {
    return loc.stages.every((s, i) => s.boss || stageKills(loc.id, i) >= KILLS_TO_UNLOCK_NEXT_STAGE);
  }
  if (idx === 0) return true;
  return stageKills(loc.id, idx - 1) >= KILLS_TO_UNLOCK_NEXT_STAGE;
}

/* ---------- Screens & profiles ---------- */

function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
}

function summarize(p) {
  const lv = SKILLS.map((s) => levelFromXp(p.xp[s.id] || 0));
  const last = p.lastSavedAt ? new Date(p.lastSavedAt).toLocaleString("th-TH") : "ยังไม่เคยเซฟ";
  const cb = p.cb ? Math.round((levelFromXp(p.cb.atk) + levelFromXp(p.cb.defs) + levelFromXp(p.cb.vit)) / 3)
                  : levelFromXp(p.cbXp || 0);
  return `เลเวล ${lv.join("/")} · ⚔️ ${cb} · 💰 ${p.gold.toLocaleString()}<br>${T("เซฟล่าสุด")} ${last}`;
}

/* A short stamp for the backup filename, taken from the save itself so two exports of the same
 * profile do not overwrite each other in the Downloads folder. */
function today0(raw) {
  try { return String(JSON.parse(raw).name || "save").replace(/[^\w\u0E00-\u0E7F-]/g, "").slice(0, 12) || "save"; }
  catch { return "save"; }
}

/* Read a save file back in. Everything is validated before anything is written: an import that
 * half-succeeds would be worse than one that refuses. */
function applyImportedSave(n, text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { toast(`⬆️❌ ไฟล์นี้ไม่ใช่ไฟล์เซฟที่อ่านได้: ${e.message}`, "warn"); return false; }
  if (!parsed || typeof parsed !== "object" || !parsed.v || !parsed.xp) {
    toast("⬆️❌ ไฟล์นี้ไม่ใช่เซฟของ Idle Fantacia", "warn");
    return false;
  }
  // Run it through the same migration the game uses, so an old backup still lands playable.
  const migrated = migrate(JSON.parse(text));
  if (!migrated) {
    toast(`⬆️❌ เซฟนี้เป็นเวอร์ชัน v${parsed.v} ที่เกมรุ่นนี้อ่านไม่ได้`, "warn");
    return false;
  }
  const existing = readSlot(n);
  if (existing && !existing.__broken
      && !confirm(`ช่อง ${n} มีโปรไฟล์ "${existing.name}" อยู่แล้ว — นำเข้าทับเลยไหม?`)) return false;
  if (!writeSlot(n, migrated)) return false;    // writeSlot already explains any failure
  toast(`⬆️ นำเข้า "${migrated.name}" ลงช่อง ${n} แล้ว (v${migrated.v})`);
  renderProfiles();
  return true;
}

let pendingImportInput = null;

function importSlot(n) {
  if (pendingImportInput) pendingImportInput.remove();
  const input = document.createElement("input");
  pendingImportInput = input;
  input.type = "file";
  input.accept = "application/json,.json";
  input.style.display = "none";
  document.body.appendChild(input);
  const done = () => {
    input.remove();
    if (pendingImportInput === input) pendingImportInput = null;
  };
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) { done(); return; }
    const reader = new FileReader();
    reader.onload = () => { applyImportedSave(n, String(reader.result || "")); done(); };
    reader.onerror = () => { toast("⬆️❌ อ่านไฟล์ไม่สำเร็จ", "warn"); done(); };
    reader.readAsText(file);
  };
  input.oncancel = done;      // dialog dismissed without choosing
  input.click();
}

function renderProfiles() {
  startSaveWatch();
  const row = $("#profile-row");
  row.innerHTML = "";

  const warn = $("#storage-warning");
  if (warn) {
    const usable = saveBackend === "server" || storageWorks();
    warn.style.display = usable ? "none" : "block";
    if (!usable) {
      const viaFile = String(location.protocol) === "file:";
      warn.innerHTML = `🚨 <b>เบราว์เซอร์นี้ไม่ยอมให้เกมเก็บเซฟ — เล่นไปก็จะหายหมด</b><br>
        วิธีที่ตรงที่สุดคือเสิร์ฟโฟลเดอร์นี้ด้วย <code>python3 -m http.server</code>
        แล้วเซฟจะไปอยู่ในโฟลเดอร์ <code>idle-fantacia/saves/</code> แทน ไม่ต้องพึ่งเบราว์เซอร์เลย<br><br>
        สาเหตุที่ระบบแจ้งกลับมา: <code>${escapeHtml(storageError || "ไม่ทราบ")}</code><br><br>
        ${viaFile
          ? `ตอนนี้เปิดจากไฟล์ตรง ๆ (<code>file://</code>) ซึ่งเบราว์เซอร์หลายตัวบล็อกที่เก็บข้อมูล<br>
             <b>วิธีแก้: เสิร์ฟโฟลเดอร์นี้ก่อน</b> — <code>python3 -m http.server 8000</code> แล้วเปิด
             <code>http://localhost:8000</code>`
          : `ปิด Shields อย่างเดียวอาจไม่พอ — ถ้าตั้ง "บล็อกคุกกี้ทั้งหมด" ไว้ที่
             <code>brave://settings/shields</code> มันจะปิด localStorage ทั้งเบราว์เซอร์
             และปุ่ม Shields รายหน้าแทนที่ค่านั้นไม่ได้<br>
             ถ้าเป็นหน้าต่าง Private ให้เปิดในหน้าต่างปกติแทน`}
        <br><br><a href="diag.html" style="color:#9ad6f0">🔍 เปิดหน้าตรวจที่เก็บเซฟ</a>
        เพื่อดูว่าเบราว์เซอร์บล็อกตรงไหน`;
    }
  }

  for (let n = 1; n <= PROFILE_SLOTS; n++) {
    const p = readSlot(n);
    const card = document.createElement("div");
    card.className = "profile-card";
    if (p && p.__broken) {
      // Never offer a fresh start here: the bytes are still on disk and may be recoverable.
      card.classList.add("broken");
      card.innerHTML = `
        <div class="slot-icon">⚠️</div>
        <h3>${T("อ่านเซฟช่องนี้ไม่ได้")}</h3>
        <div class="meta">${escapeHtml(p.__broken)}<br>
          <b>${T("ข้อมูลยังอยู่ครบ ไม่ได้ถูกลบ")}</b> — ลองรีเฟรชอีกครั้ง หรือกดสำรองไว้ก่อน</div>
        <button class="btn" data-retry="${n}">${T("ลองอ่านใหม่")}</button>
        <button class="btn ghost small" data-export="${n}" style="margin-top:8px">⬇️ สำรองเซฟไว้</button>`;
    } else if (p) {
      card.innerHTML = `
        <div class="slot-icon">🧙</div>
        <h3>${escapeHtml(p.name)}</h3>
        <div class="meta">${summarize(p)}</div>
        <button class="btn" data-play="${n}">${T("เล่นต่อ")}</button>
        <button class="btn ghost small" data-export="${n}" style="margin-top:8px">⬇️ ส่งออกเซฟ</button>
        <button class="btn ghost small" data-del="${n}" style="margin-top:8px">${T("ลบโปรไฟล์")}</button>`;
    } else {
      card.innerHTML = `
        <div class="slot-icon">✨</div>
        <h3>ช่องว่าง ${n}</h3>
        <div class="meta">${T("เริ่มการผจญภัยใหม่")}</div>
        <input maxlength="16" placeholder="ตั้งชื่อนักผจญภัย" data-name="${n}">
        <button class="btn" data-create="${n}">${T("สร้างโปรไฟล์")}</button>
        <button class="btn ghost small" data-import="${n}" style="margin-top:8px">⬆️ นำเข้าไฟล์เซฟ</button>`;
    }
    row.appendChild(card);
  }
  const anySave = [...Array(PROFILE_SLOTS)].some((_, i) => rawSlot(i + 1));
  const where = $("#save-location");
  if (where) {
    /* 🎯 [owner 2026-08-23] "อาจต้อง note สีแดงว่า ถ้าเล่นผ่าน git มัน save ลง local browser
       จะเล่นต่อได้ถ้า browser local เดิม แต่ถ้าสลับ browser หรือเปลี่ยนเครื่อง เซฟจะไม่ตาม ต้องใช้ export
       save / import เข้าไป"

       This box was shown ONLY in server mode, so the person it matters most to — someone playing
       the published build, whose save lives somewhere they cannot see and cannot copy — was told
       nothing at all. Shown in both modes now; the local one is a warning rather than a note,
       because the failure it describes is silent and total: clear the site data, or open the game
       on a different machine, and there is nothing anywhere to recover from. */
    where.style.display = "block";
    where.classList.toggle("is-warn", saveBackend !== "server");
    // 🐛 [fixed 2026-08-18] This used to `return` here, which skipped every handler-attachment
    // call below (data-create/data-play/data-import/...) entirely. On a genuinely empty
    // idle-fantacia/saves/ — a brand-new install before the first-ever profile, or any time both slots
    // are wiped for a fresh restart — !anySave is true, so this branch ran and every button on
    // the profile screen was silently dead: "สร้างโปรไฟล์" did nothing, forever, with no error.
    if (saveBackend === "server" && !anySave) {
      where.innerHTML = `📁 ยังไม่มีไฟล์เซฟใน <code>idle-fantacia/saves/</code><br>
        <span class="dim">ถ้าเคยเล่นค้างไว้แล้วไม่เห็นตรงนี้ แปลว่าเซฟนั้นอยู่ในเบราว์เซอร์ของ
        <b>${T("ที่อยู่อื่น")}</b> — เซฟผูกกับที่อยู่ที่เปิด และหน้านี้อ่านข้ามที่อยู่ไม่ได้<br>
        ให้เปิดเกมแบบเดิมที่เคยเล่น (ดับเบิลคลิก <code>idle-fantacia/index.html</code>) ในเบราว์เซอร์ตัวเดิม
        กด <b>⬇️ ส่งออกเซฟ</b> แล้วก๊อปไฟล์นั้นมาวางใน <code>idle-fantacia/saves/</code> —
        ชื่อไฟล์อะไรก็ได้ เดี๋ยวระบบรับเข้าช่องให้เอง</span>`;
    } else if (saveBackend !== "server") {
      where.innerHTML = `⚠️ <b>${T("เซฟอยู่ในเบราว์เซอร์นี้เท่านั้น")}</b> — ${
        T("เล่นต่อได้ถ้ากลับมาที่เบราว์เซอร์เดิมบนเครื่องเดิม")}<br>
        <span class="dim">${T("สลับเบราว์เซอร์ เปลี่ยนเครื่อง หรือล้างข้อมูลเว็บไซต์ แล้วเซฟจะไม่ตามไป และกู้คืนไม่ได้ — ไม่มีสำเนาอยู่ที่ไหนเลย")}<br>
        ${T("ก่อนย้าย ให้กด")} <b>⬇️ ${T("ส่งออกเซฟ")}</b> ${T("เก็บไฟล์ไว้ แล้วใช้")}
        <b>⬆️ ${T("นำเข้าไฟล์เซฟ")}</b> ${T("ที่เครื่องใหม่")}</span>`;
    } else if (saveBackend === "server") {
      where.innerHTML = `📁 เซฟเก็บเป็นไฟล์ใน <code>idle-fantacia/saves/</code> — คัดลอก สำรอง หรือย้ายเครื่องได้เหมือนไฟล์ทั่วไป
        <span class="dim">(สำรองอัตโนมัติทุกครั้งที่เขียนทับ เก็บไว้ใน <code>saves/backups/</code>)</span><br>
        <span class="dim">${T("จะนำเข้าด้วยปุ่มก็ได้ หรือก๊อปไฟล์ไปวางเป็น ")}<code>idle-fantacia/saves/slot1.json</code>
        แล้วรีเฟรชหน้านี้ก็ได้เหมือนกัน</span>`;
    }
  }
  row.querySelectorAll("[data-retry]").forEach((b) => b.onclick = () => renderProfiles());
  row.querySelectorAll("[data-export]").forEach((b) => b.onclick = () => {
    // Hand the raw bytes to the player as a file so a broken slot is never a dead end.
    const raw = rawSlot(Number(b.dataset.export)) || "";
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `idlefantacia-slot${b.dataset.export}-${today0(raw)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("⬇️ ดาวน์โหลดไฟล์สำรองแล้ว");
  });
  row.querySelectorAll("[data-import]").forEach((b) => b.onclick = () => importSlot(Number(b.dataset.import)));
  row.querySelectorAll("[data-play]").forEach((b) => b.onclick = () => startGame(Number(b.dataset.play)));
  row.querySelectorAll("[data-create]").forEach((b) =>
    b.onclick = () => {
      const n = Number(b.dataset.create);
      const name = (row.querySelector(`[data-name="${n}"]`).value || "").trim() || "นักผจญภัย";
      writeSlot(n, freshProfile(name));
      startGame(n);
    });
  row.querySelectorAll("[data-del]").forEach((b) =>
    b.onclick = () => {
      const n = Number(b.dataset.del);
      const p = readSlot(n);
      if (p && confirm(`ลบโปรไฟล์ "${p.name}" ถาวร? เซฟจะหายทันที`)) {
        deleteSlot(n);
        renderProfiles();
      }
    });
}

/* Everything one absence produced, as data — so the popup reports exactly what was applied rather
 * than recomputing it and risking a different answer. Returns null when there is nothing to say. */
function applyOfflineProgress() {
  /* 🎯 [owner 2026-08-21] Was phone-only, from the original ask ("มีเฉพาะในโหมดมือถือ apk"). The
   * owner now wants it everywhere, and wants to play in a mobile browser — where the Capacitor
   * wrapper the old gate looked for does not exist. Gating on it would have shipped a feature that
   * looked present and silently did nothing on the device it was asked for. The gate is gone, and
   * so is the APK packaging it was written for. */
  if (!P) return null;
  const left = P.leftAt;
  P.leftAt = null;                       // consumed: a second launch must not pay for the same gap
  if (!left) return null;
  const awayMs = Date.now() - left;
  if (awayMs <= 0) return null;          // clock moved backwards; pay nothing rather than guess

  const capMs = OFFLINE_CAP_HOURS * 3600 * 1000;
  const cappedMs = Math.min(awayMs, capMs);
  const seconds = cappedMs / 1000 * OFFLINE_RATE;

  /* 🎯 [owner 2026-08-23] "แก้ปันผล ค่าเช่า ตอนเดินตอนออฟไลน์ แม้ว่าจะไม่เลือกสายอาชีพอะไร · หรือ
   * อาจเลือกต่อสู้ไว้แล้วออก มันก็ไม่นับการต่อสู้ เป็นการถอนตัว แต่เงินค่าเช่า ปันผล ควรเดินต่อ"
   *
   * This used to return null the moment no SKILL job was running, before reaching the line that
   * pays anything — so closing the browser without leaving woodcutting going paid nothing at all,
   * not even rent from a house or a dividend from a company. The guard's own comment said "closing
   * the app is not income", which is true of a job you were doing and false of capital that earns
   * whether you are there or not.
   *
   * Passive income is settled first and unconditionally. The skill job, if there was one, is
   * settled after; combat is still worth nothing offline, which is the owner's rule and is why the
   * search below looks only for a "skill" slot. */
  const cash = offlineCashflow(seconds);

  /* 🎯 [owner 2026-08-23] "สายผลิต มันมี ขโมย ตัดต้นไม้ ขุดแร่ ตกปลา ... ไม่ว่าผลิตสายไหน ถ้ามัน
   * โดนล็อก" — this settled ONE slot, the first "skill" it found. With multi-processing bought you
   * can leave several jobs running, and every one of them but the first was worth nothing for the
   * whole absence. Every production slot is settled now; combat slots are still skipped, which is
   * the owner's rule and is why the filter is on type.
   *
   * Their case 2 is exactly this: "สายผลิต + ตีมอนสเตอร์ จะโดนล็อกแค่ สายผลิต + ค่าเช่า + ปันผล". */
  const slots = (P.slots || []).filter((sl) => sl && sl.type === "skill");
  const made = {};
  const jobs = [];
  let gold = 0, ranAny = 0, ranOut = false, levelsGained = 0;

  for (const sl of slots) {
    const sk = findSkill(sl.skillId);
    const act = sk ? findAction(sk, sl.actionId) : null;
    if (!sk || !act) continue;
    const per = effectiveSeconds(sl.skillId, act);
    const cycles = Math.floor(seconds / per);
    if (cycles <= 0) continue;

    let jobGold = 0, xp = 0, ran = 0;
    const beforeLvl = levelFromXp(P.xp[sl.skillId] || 0);
    for (let i = 0; i < cycles; i++) {
      if (act.inputs) {
        // Out of materials is a real stop, exactly as skillTick would have stopped — offline must
        // not conjure inputs the player never had.
        if (!canAfford(act)) { ranOut = true; break; }
        for (const [id, n] of Object.entries(act.inputs)) P.inv[id] -= n;
      }
      if (act.steal) {
        /* Expected value, not a per-cycle roll. Thousands of unwatched coin flips would land on the
         * average anyway, and a visible number the player cannot verify should not also be random. */
        const st = act.steal;
        const mLvl = masteryLevelOf(sl.skillId, sl.actionId);
        const chance = Math.min(0.95, st.success + 0.004 * (mLvl - 1));
        jobGold += (st.gold[0] + st.gold[1]) / 2 * chance;
        for (const drop of st.loot || []) {
          if (Math.random() < effectiveLootChance(sl.skillId, sl.actionId, drop.chance)) {
            const n = randInt(drop.n[0], drop.n[1]);
            P.inv[drop.item] = (P.inv[drop.item] || 0) + n;
            made[drop.item] = (made[drop.item] || 0) + n;
          }
        }
      }
      if (act.catch) {
        // A catch table yields one of several species; offline credits the most common one rather
        // than rolling, for the same reason as above.
        const table = effectiveCatch(sl.skillId, act);
        const top = table.reduce((a, b) => (b.w > a.w ? b : a), table[0]);
        P.inv[top.item] = (P.inv[top.item] || 0) + 1;
        made[top.item] = (made[top.item] || 0) + 1;
      } else if (act.outputs) {
        for (const [id, n] of Object.entries(act.outputs)) {
          P.inv[id] = (P.inv[id] || 0) + n;
          made[id] = (made[id] || 0) + n;
        }
      }
      xp += act.xp;
      ran++;
    }
    if (!ran) continue;

    /* 🎯 [owner 2026-08-23] "ตัดไม้ 54 ท่อน หายาก 3 = 57" — rare drops count toward the haul, and
       they were not being granted offline at all. Expected value over the whole absence rather than
       one roll per cycle, for the same reason the steal payout is: thousands of unwatched flips land
       on the average anyway, and a number the player cannot verify should not also be random. */
    for (const rare of act.rare ? [].concat(act.rare) : []) {
      const mLvl = masteryLevelOf(sl.skillId, sl.actionId);
      const chance = (rare.base + rare.perLevel * mLvl) * (1 + luckTotal());
      const n = Math.floor(ran * chance);
      if (n > 0) {
        P.inv[rare.item] = (P.inv[rare.item] || 0) + n;
        made[rare.item] = (made[rare.item] || 0) + n;
      }
    }

    jobGold = Math.round(jobGold * (1 + charmValue("gold") + perkTotal("goldBonus")));
    gold += jobGold;
    P.gold += jobGold;
    P.xp[sl.skillId] = (P.xp[sl.skillId] || 0) + Math.ceil(xp * (1 + tomeBonus(sl.skillId)));
    /* 🎯 [owner 2026-08-21] "ความชำนาญไม่ขึ้น" — no mastery offline, deliberately. Mastery is
     * what makes a job permanently faster and its drops better. Items are what you were away from;
     * mastery is what you were there for. */
    if (jobGold) bump("goldEarned", jobGold);
    bump(act.steal ? "steals" : "actions", ran);
    levelsGained += levelFromXp(P.xp[sl.skillId]) - beforeLvl;
    jobs.push({ skill: sk, action: act, cycles: ran });
    ranAny += ran;
  }

  const items = Object.values(made).reduce((t, n) => t + n, 0);
  const earned = (cash.shops || 0) + (cash.div || 0) + (cash.rent || 0);
  /* An absence that produced nothing at all gets no popup and no ledger row, rather than a card
     saying zero. */
  if (!items && !gold && !earned) return null;

  const out = { cash, rate: OFFLINE_RATE, awayMs, cappedMs, capped: awayMs > capMs,
                jobs, made, items, gold, ranOut, levelsGained,
                total: Math.round(gold + earned) };
  offlinePost(out);
  return out;
}

/* 🎯 [owner 2026-08-23] "รวมกัน แล้วสรุป ในหน้า popup รวมถึงหน้าบัญชี ด้วย"
 *
 * One absence, one ledger row. Before this the account page told three different stories about the
 * same night: shops posted their own row, dividends and rent went into the monthly pools where they
 * were indistinguishable from time actually played, and the gold from the job you left running —
 * often the largest of the four — reached the ledger not at all, so a night of stealing was money
 * that appeared in the wallet from nowhere.
 *
 * Everything the absence earned is summed here and written once. The sources are named in the text
 * because "where did this come from" is the only question the ledger exists to answer. */
function offlinePost(r) {
  const c = r.cash || {};
  if (!r.total && !r.items) return;
  /* 🎯 [owner 2026-08-23] "ให้มันสั้นๆ ตอนออฟไลน์ได้ ไอเทม 87 ชิ้น เงินรวม 512 ประมาณนี้พอ" — the
     two numbers a player acts on. Which job or which company produced them is a question the rest
     of the page answers; this row is the total for the absence. */
  ledger("🌙", `${T("ระหว่างออฟไลน์")} ${(c.days || 0).toFixed(1)} ${T("วันในเกม")}`
    + (r.items ? ` — ${T("ไอเทม")} ${r.items.toLocaleString()} ${T("ชิ้น")}` : ""), r.total);
}

/* 🎯 [owner 2026-08-21] "เงินกระแส ของรายได้ ค่าเช่า หรือ การลงทุน ก็ได้แค่ 30% จากที่ควรได้ 100%"
 *
 * Paid as a fraction of the last settled day rather than by running the days themselves. runShopsDay
 * advances each shop's own history, fires its toasts and books tax — and a calendar that did not
 * move must not gain days of history. `seconds` is already the 30%-scaled figure, so the rate
 * applies once here and is not multiplied in twice.
 *
 * Bank interest is deliberately not included: it is booked per calendar day inside onNewDay, and no
 * calendar day passed. Paying it anyway would mean interest on time that did not exist. */
function offlineCashflow(seconds) {
  const days = seconds / GAME_DAY_SECONDS;
  if (days <= 0) return { shops: 0, div: 0, rent: 0, days };

  /* Shops: a fraction of the last settled day rather than by running the days themselves.
   * runShopsDay advances each shop's own history, fires its toasts and books tax, and a calendar
   * that did not move must not gain days of history. */
  let shops = 0;
  if (P.shops?.length) {
    const perDay = P.shops.reduce((t, sh) => t + (sh.lastNet || 0), 0);
    shops = Math.round(perDay * days);
    if (shops) {
      /* no-goldBonus: runShopsDay does not apply it either, and offline must not pay better than
       * being there. The luck charm and rebirth karma reward hunting and stealing — the things you
       * do — not the rent a building collects while you are asleep. */
      P.gold += shops;
      if (shops > 0) bump("goldEarned", shops);
      /* 🎯 [owner 2026-08-23] "รวมกัน แล้วสรุป ในหน้า popup รวมถึงหน้าบัญชี ด้วย" — this used to
         post its own row. One absence is one event, so the ledger gets ONE line for it, written by
         applyOfflineProgress once every source has been settled. Three rows for one night away is
         the same fragmentation the dividend and rent pooling already fixed elsewhere. */
    }
  }

  /* 🎯 [owner 2026-08-21] The quote at the top of this function names three things —
   * "รายได้ ค่าเช่า หรือ การลงทุน" — and rent was the one never written. A property earning 10 a day
   * paid exactly 0 for a night away, silently, while shops and dividends both paid.
   *
   * Same shape as shops: a fraction of the CURRENT daily rate, not by running the days. runEstatesDay
   * advances each property's own earned total and posts to the monthly ledger, and a calendar that
   * did not move must not gain days of history. es.earned is still credited per property, because
   * the investment-result line on the property page is computed from it and would otherwise show a
   * house paying for itself more slowly than it really does. */
  let rent = 0;
  if (P.estates?.length) {
    const perDay = P.estates.reduce((t, es) => t + estateRentPerDay(es), 0);
    rent = Math.round(perDay * days);
    if (rent > 0) {
      /* no-goldBonus: runEstatesDay does not apply it either — rent is return on capital. */
      P.gold += rent;
      bump("rentEarned", rent);
      /* 🎯 [owner 2026-08-23] Rent is taxed on what it EARNED now, not on what the house is
         worth, so every path that credits rent has to reach this counter or a night away would be
         untaxed income. */
      bookRentIncome(rent);
      const share = rent / (perDay * days);
      for (const es of P.estates) es.earned = (es.earned || 0) + estateRentPerDay(es) * days * share;
      /* NOT added to estateMonth: the monthly rent row means "collected while playing", and this
         gold is reported by the offline row instead. Adding it to both would count it twice in the
         one place whose whole job is to account for where money came from. */
    }
  }

  /* 🎯 [owner 2026-08-22] "ขาดเรื่องลงทุนปันผล" — dividends were the half of "เงินกระแส" this
   * function never paid. Shops were, stocks were not, and a portfolio is the more likely of the
   * two to exist at all.
   *
   * Paid as a daily rate rather than by counting divDays boundaries, for the same reason the whole
   * feature works this way: no calendar day passed, so there are no boundaries to count. The rate
   * is exactly what payDividends earns over a year — shares × base × yield — divided by the year,
   * so a 15-day payer and a 30-day payer with the same annual yield are worth the same per hour
   * away, which is what "30% of what you would have earned" has to mean.
   *
   * Priced off the company's fundamentals, never today's price, so an absence cannot be timed
   * against the market. The owner bonus and the accrual remainder both carry over from the online
   * path, so a cheap frequent payer still adds up instead of rounding to nothing every time. */
  let div = 0;
  if (!taxSeized()) {
    P.divAccrual = P.divAccrual || {};
    for (const c of COMPANIES) {
      const shares = heldShares(c.id);
      if (!shares) continue;
      const perDay = shares * c.base * c.yield / DAYS_PER_YEAR
        * (isOwner(c.id) ? 1 + OWNER_DIVIDEND_BONUS : 1);
      const pot = (P.divAccrual[c.id] || 0) + perDay * days;
      const paid = Math.floor(pot);
      P.divAccrual[c.id] = pot - paid;
      if (paid > 0) div += paid;
    }
    if (div) {
      /* no-goldBonus: the same carve-out payDividends declares — those perks reward hunting and
       * stealing, not owning shares, and letting them scale dividends would also inflate the
       * taxable base they feed. */
      P.gold += div;
      bookInvestmentProfit(div);      // taxable exactly as it is online
      bump("divPaid", div);
      /* Same reasoning as rent above: reported by the single offline row, so it must not also go
         into the monthly pool. The monthly ปันผล row means "paid while playing". */
    }
  }

  return { shops, div, rent, days };
}

/* 🎯 [owner 2026-08-23] "ส่วนการแสดงข้อความ ให้มันสั้นๆ ตอนออฟไลน์ได้ ไอเทม 87 ชิ้น เงินรวม 512
 * ประมาณนี้พอ" — two numbers. This used to itemise every drop, name the job, and list the sources of
 * the money on separate lines; four seconds of reading for a card you dismiss. What was per-item is
 * in the bag, what was per-source is in the ledger, and the jobs that ran are named in one dim line
 * because "did the thing I left running actually run" is the one question the totals cannot answer. */
function openOfflinePopup(r) {
  if (!r) return;
  const hrs = r.awayMs / 3600000;
  const away = hrs >= 1 ? `${hrs.toFixed(1)} ชั่วโมง` : `${Math.round(r.awayMs / 60000)} นาที`;
  const ran = r.jobs.map((j) => escapeHtml(j.skill.name)).join(" · ");
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">🌙 ${T("ระหว่างที่ไม่อยู่")}</div>
      <div class="modal-sub">
        ${T("หายไป")} <b>${away}</b>${r.capped ? ` — ${T("คิดให้สูงสุด")} ${OFFLINE_CAP_HOURS} ${T("ชั่วโมง")}` : ""}
        <div class="offline-lines">
          <div class="offline-total">
            ${r.items ? `🎒 ${T("ไอเทม")} <b class="good">${r.items.toLocaleString()}</b> ${T("ชิ้น")}` : ""}
            ${r.items && r.total ? " · " : ""}
            ${r.total ? `💰 ${T("เงินรวม")} <b class="${r.total > 0 ? "good" : "rb-warn"}">${
              r.total > 0 ? "" : "-"}${fmtNum(Math.abs(r.total))}</b>` : ""}
          </div>
          ${ran ? `<div class="dim">${ran}${r.levelsGained > 0
            ? ` · ${T("ขึ้น")} ${r.levelsGained} ${T("เลเวล")}` : ""}</div>` : ""}
          ${/* 🎯 [owner] "มันไม่มีแจ้งว่าควรได้เงินเท่าไหร่ 30%" — say the arithmetic, not just the
               result: a player has no way to tell a correct 30% from a wrong one otherwise, and the
               whole feature is a promise about a fraction. */ ""}
          <div class="dim">— ${T("คิดจาก")} ${(r.cash?.days || 0).toFixed(1)} ${T("วันในเกม")} ${
            T("ที่")} ${Math.round(r.rate * 100)}% ${T("ของอัตราปกติ")}</div>
          ${r.ranOut ? `<div class="rb-warn">⚠️ ${T("วัตถุดิบหมดก่อน งานเลยหยุดกลางทาง")}</div>` : ""}
        </div>
        <span class="dim">${T("ปฏิทินไม่เดิน ความชำนาญไม่ขึ้น แปลงปลูกไม่โต และการล่ามอนสเตอร์ไม่เดินต่อ")}</span>
      </div>
      <div class="modal-actions"><button class="btn" data-close>${T("รับของ")}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => { save("กลับมาเล่น"); back.remove(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}

/* Stamped whenever the app stops being the thing in front of the player. Both paths matter: on a
 * phone, backgrounding fires visibilitychange and the process may be killed later without ever
 * seeing beforeunload. */
function markLeft() {
  if (P) { P.leftAt = Date.now(); writeSlot(slot, P); }
}

/* ---------- Game lifecycle ---------- */

/* 🎯 [added 2026-08-18, owner's ask: "เท่าเทียม"] Racing bot-nox fairly means its playtime should
 * track the owner's real session — playing, paused, or closed — not just run unattended whenever
 * the owner is away. Pause state lives purely in memory with no other observable trace, so this
 * heartbeat is the only channel that can see it. Scoped to slot 1 only (the owner's own slot by
 * this whole feature's convention) and to the server backend only — never localStorage, and
 * inert in the Node smoke-test shim since setInterval is stubbed to a no-op there. */
function sendPresence(active) {
  if (slot !== 1 || saveBackend !== "server") return;
  fetch("api/presence", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  }).catch(() => {});
}

let presenceTimer = null;

function startGame(n) {
  invalidateSlayer();
  stopSaveWatch();     // in play the cache is authoritative — the game is the one writing
  slot = n;
  P = readSlot(n);
  if (!P) return;
  P.slots = (P.slots || []).filter((sl) => sl && sl.type === "skill").slice(0, maxSlots());
  if (P.trader && P.trader.until <= Date.now()) P.trader = null;
  // 🐛 [added 2026-08-15] Migration and gear changes can lower the ceiling under a stored HP
  // value: a v4 save's single combat pool splits three ways, so vit-derived max HP lands far
  // below what the player was walking around with (measured: 280 -> 180 at 30k combat xp),
  // and the topbar would read 280/180 with an overflowing bar. Clamp on every load.
  P.hp = Math.max(1, Math.min(P.hp, maxHp()));
  RT = P.slots.map(() => ({ startedAt: performance.now(), fight: null }));
  lastRegenAt = performance.now();
  lastPlayTick = Date.now();
  view = P.slots[0] ? { kind: "skill", skillId: P.slots[0].skillId } : { kind: "skill", skillId: "wc" };
  // Before the first render, so the screen the player sees already includes what they earned.
  const offline = applyOfflineProgress();

  show("#screen-game");
  // Browsers refuse to start audio before a gesture, and picking a profile is one.
  if (typeof Audio !== "undefined" && Audio.unlock) { Audio.unlock(); applySoundPrefs(); }
  /* Before the first paint, not after: applying it later would show one frame of the full effects
     to a player who turned them off, on the device least able to afford them. */
  applyGraphicsPrefs();
  refreshWakeLock();
  buildSidebar();
  renderView();
  renderInventory();
  updateSaveLabel();
  openIntroPopup();
  if (offline) openOfflinePopup(offline);

  clearInterval(logicTimer);
  startLogicTimer();
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => save("อัตโนมัติ"), AUTOSAVE_MINUTES * 60 * 1000);

  clearInterval(presenceTimer);
  if (n === 1) {
    sendPresence(document.visibilityState === "visible" && !paused);
    /* 🐛 [found 2026-08-23 while measuring what actually costs battery] This fired every 4 seconds
     * unconditionally — 900 requests an hour, 21,600 a day — and kept firing with the tab hidden
     * and the phone in a pocket, where it was reporting "not here" over and over. Waking the radio
     * on a schedule costs far more battery than anything on screen does, and every one of those
     * calls was already redundant: visibilitychange sends the state the moment it changes, which
     * is the only moment the answer is new.
     *
     * Skipped rather than stopped, so nothing has to restart it: coming back to the tab fires
     * visibilitychange, which reports the state, and the next tick resumes on its own. */
    presenceTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      sendPresence(!paused);
    }, 4000);
  }
}

function exitToProfiles() {
  stopCombat(true);
  save("ตอนออก");
  clearInterval(logicTimer);
  clearInterval(autosaveTimer);
  clearInterval(presenceTimer);
  if (slot === 1) sendPresence(false);
  P = null; slot = null; RT = [];
  renderProfiles();
  show("#screen-profiles");
}

function save(reason) {
  if (!P || slot == null) { toast("💾❌ ยังไม่ได้เปิดโปรไฟล์ จึงยังเซฟไม่ได้", "warn"); return false; }
  if (!writeSlot(slot, P)) return false;
  updateSaveLabel();
  if (reason !== "อัตโนมัติ" || document.visibilityState === "visible") toast(`💾 เซฟแล้ว (${reason})`, "", "save");
  return true;
}

function updateSaveLabel() {
  const el = $("#save-when");
  if (el && P) el.textContent = P.lastSavedAt
    ? `${T("เซฟล่าสุด")} ${new Date(P.lastSavedAt).toLocaleTimeString("th-TH")}`
    : "ยังไม่เคยเซฟ";
}

window.addEventListener("beforeunload", () => {
  if (P) P.leftAt = Date.now();      // set before the write, so the save carries it
  if (P) writeSlot(slot, P);
  // sendBeacon survives page teardown; a normal fetch here is unreliable and often never lands.
  if (P && slot === 1 && saveBackend === "server" && navigator.sendBeacon) {
    navigator.sendBeacon("api/presence", JSON.stringify({ active: false }));
  }
});
document.addEventListener("visibilitychange", () => {
  // On a phone this is the one that actually fires — a backgrounded app may be killed outright and
  // never see beforeunload, so the leaving time has to be committed here.
  // markLeft() writes the save itself, so this replaces the old writeSlot rather than adding to it.
  if (document.visibilityState === "hidden" && P) markLeft();
  if (P && slot === 1) sendPresence(document.visibilityState === "visible" && !paused);
  // The browser revokes a wake lock the moment the tab is hidden and does not give it back, so
  // returning has to ask again. Without this the screen keeps its own idle timer after the first
  // app switch and the setting silently stops working.
  refreshWakeLock();
});

/* ---------- "Where do I get this?" index ----------
 * 🎯 [added 2026-08-15, owner's ask] A recipe that lists a material you do not have used to be a
 * dead end — you had to remember which skill makes ไม้/ถ่าน/หนัง/ปลา and go find it. Every missing
 * input is now a button that jumps straight to the place that produces it. Built once from the
 * same tables the rest of the game reads, so new content is routable the moment it is added. */

let SOURCE_INDEX = null;

function buildSourceIndex() {
  const idx = {};
  const push = (id, src) => { (idx[id] = idx[id] || []).push(src); };
  for (const skill of SKILLS) {
    for (const a of skill.actions) {
      for (const id of Object.keys(a.outputs || {})) push(id, { kind: "skill", skillId: skill.id, actionId: a.id });
      for (const c of a.catch || []) push(c.item, { kind: "skill", skillId: skill.id, actionId: a.id });
      for (const r of a.rare ? [].concat(a.rare) : [])
        push(r.item, { kind: "skill", skillId: skill.id, actionId: a.id, rare: true });
      for (const l of a.steal?.loot || []) push(l.item, { kind: "skill", skillId: skill.id, actionId: a.id, rare: true });
    }
  }
  for (const loc of LOCATIONS) {
    loc.stages.forEach((st, i) => {
      for (const d of st.loot) push(d.item, { kind: "combat", locId: loc.id, stageIdx: i, chance: d.chance });
    });
  }
  return idx;
}

/* The source worth sending the player to: prefer one they can use right now, prefer guaranteed
 * output over a rare side-drop, and prefer the highest tier they have unlocked (it is faster). */
function bestSource(itemId) {
  SOURCE_INDEX = SOURCE_INDEX || buildSourceIndex();
  const all = SOURCE_INDEX[itemId] || [];
  if (!all.length) return null;
  const score = (src) => {
    let n = 0;
    if (src.kind === "skill") {
      const skill = findSkill(src.skillId);
      const act = findAction(skill, src.actionId);
      if (actionOpen(src.skillId, act)) n += 100;
      if (!src.rare) n += 50;
      n += act.level;
    } else {
      const loc = findLocation(src.locId);
      if (combatLevel() >= loc.levelReq && stageUnlocked(loc, src.stageIdx)) n += 100;
      n += Math.round((src.chance || 0) * 40);
    }
    return n;
  };
  return all.slice().sort((a, b) => score(b) - score(a))[0];
}

function sourceLabel(itemId) {
  const src = bestSource(itemId);
  if (!src) return null;
  if (src.kind === "skill") {
    const skill = findSkill(src.skillId);
    const act = findAction(skill, src.actionId);
    return `${skill.icon} ${skill.name} · ${act.name}${src.rare ? " (ของหายาก)" : ""}`;
  }
  const loc = findLocation(src.locId);
  return `⚔️ ${loc.name} · ${loc.stages[src.stageIdx].name}`;
}

/* 🎯 [owner 2026-08-22] "กดไปหาของ ก็จะเล่นเลือกได้เลย ว่าต้องหาจากที่ไหน"
 *
 * Most items come from more than one place, and bestSource picks for you. That is right when the
 * game is filling in a missing ingredient by itself, and wrong when the player asked where to go —
 * the cheapest source and the one they feel like playing are not the same thing. */
function allSources(itemId) {
  SOURCE_INDEX = SOURCE_INDEX || buildSourceIndex();
  return (SOURCE_INDEX[itemId] || []).slice();
}

function sourceLabelOf(src) {
  if (src.kind === "skill") {
    const skill = findSkill(src.skillId);
    const act = findAction(skill, src.actionId);
    return { icon: skill.icon, name: `${skill.name} · ${act.name}`,
             note: src.rare ? "ของหายาก" : `ต้องเลเวล ${act.level}`,
             open: actionOpen(src.skillId, act) };
  }
  const loc = findLocation(src.locId);
  return { icon: "⚔️", name: `${loc.name} · ${loc.stages[src.stageIdx].name}`,
           note: `โอกาสดรอป ${Math.round((src.chance || 0) * 100)}%`,
           open: combatLevel() >= loc.levelReq && stageUnlocked(loc, src.stageIdx) };
}

/* Offer the choice when there is one. A single source jumps straight there — a dialog with one
 * button in it is a tax, not a choice. */
function chooseSource(itemId) {
  const all = allSources(itemId);
  if (all.length <= 1) { gotoSource(itemId); return; }
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">${ITEMS[itemId].icon} หา${escapeHtml(ITEMS[itemId].name)}ได้จาก</div>
      <div class="modal-sub">มี ${all.length} ทาง — เลือกทางที่อยากเล่น</div>
      <div class="src-list">
        ${all.map((src, i) => {
          const L = sourceLabelOf(src);
          return `<button class="src-row${L.open ? "" : " locked"}" data-src="${i}">
            <span class="s-ic">${L.icon}</span>
            <span class="s-nm">${escapeHtml(L.name)}</span>
            <span class="s-nt">${L.open ? escapeHtml(L.note) : "🔒 ยังไม่เปิด"}</span>
          </button>`;
        }).join("")}
      </div>
      <div class="modal-acts"><button class="btn ghost" data-close>${T("ปิด")}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.querySelectorAll("[data-src]").forEach((b) => {
    b.onclick = () => { close(); gotoSourceAt(itemId, all[+b.dataset.src]); };
  });
}

/* Set by a jump so the destination card can flash and scroll itself into view. */
let highlightAction = null;

/* Which sub-zone is open on each skill page (owner: "ทำเมนูย่อย... แยกหมวดหมู่พวกนี้").
 * Smithing alone carries 41 recipes across 11 zones, so a flat list buried everything. */
const openArea = {};
function areasOf(skill) {
  return [...new Set(skill.actions.map((a) => a.area))];
}
/* Default to the deepest zone the player has actually opened — that is where they are working. */
function currentArea(skill) {
  const areas = areasOf(skill);
  if (openArea[skill.id] && areas.includes(openArea[skill.id])) return openArea[skill.id];
  let best = areas[0];
  for (const a of skill.actions) if (actionOpen(skill.id, a)) best = a.area;
  return best;
}

function gotoSource(itemId) {
  const src = bestSource(itemId);
  if (!src) { toast(`ยังไม่มีแหล่งของ ${ITEMS[itemId].name} ในเกม`, "warn"); return; }
  gotoSourceAt(itemId, src);
}

/* The jump itself, given a chosen source. Split out of gotoSource so the picker can send the
 * player somewhere other than the highest-scoring one. */
function gotoSourceAt(itemId, src) {
  if (!src) return;
  if (src.kind === "skill") {
    view = { kind: "skill", skillId: src.skillId };
    const sk = findSkill(src.skillId);
    openArea[src.skillId] = findAction(sk, src.actionId).area;   // reveal the zone it lives in
    highlightAction = `${src.skillId}:${src.actionId}`;
    const skill = findSkill(src.skillId);
    const act = findAction(skill, src.actionId);
    toast(`${ITEMS[itemId].icon} ${ITEMS[itemId].name} → ${skill.icon} ${skill.name} · ${act.name}`);
  } else {
    view = { kind: "combat" };
    combatLoc = src.locId;
    highlightAction = `combat:${src.locId}:${src.stageIdx}`;
    const loc = findLocation(src.locId);
    toast(`${ITEMS[itemId].icon} ${ITEMS[itemId].name} → ⚔️ ${loc.name} · ${loc.stages[src.stageIdx].name}`);
  }
  renderView();
}

/* ---------- Artwork ----------
 * 🎯 [added 2026-08-15, owner's ask] Small generated portraits live in art/. Every use degrades to
 * the emoji the game shipped with: a missing file simply never replaces its glyph, so the game
 * still runs from a bare checkout and stays playable offline. Images are lazy and tiny (192px,
 * ~4KB each), so nothing is paid for art that never appears on screen. */
const ART_MISSING = new Set();
/* Set once at boot from api/health — see initStorage. Empty when the game is opened without the
 * server, which is a supported case: the URL is then simply unversioned, exactly as before. */
let ART_STAMP = "";

function artImg(kind, id, alt, cls) {
  const key = `${kind}/${id}`;
  if (ART_MISSING.has(key) || artKindDead(kind)) return null;
  const v = ART_STAMP ? `?v=${ART_STAMP}` : "";
  /* 🐛 [owner 2026-08-22: "บางจังหวะ มันโหลดรูปไอเทมช้า แต่ซักพักรูปก็มา"] The emoji underneath used to
   * be hidden the moment this <img> existed, which is a different moment from the picture arriving —
   * and with loading="lazy" they can be seconds apart on a phone scrolling a full bag. That gap
   * showed an empty circle, or the browser's own broken-image glyph, in place of a fallback that was
   * sitting right there. onload is the only honest signal, so it is what flips the swap now. */
  /* decoding="sync" on purpose: async lets the browser paint the slot before the picture is ready
     even when it came from cache, which is the other half of the flicker the owner saw. */
  return `<img class="art ${cls || ""}" src="art/${key}.jpg${v}" alt="${escapeHtml(alt)}" loading="lazy"
    decoding="sync" onload="markArtReady(this)" onerror="markArtMissing('${key}', this)">`;
}
/* 🐛 [owner 2026-08-22, from a phone: "เฟรม มอน มันหาย"] onerror does not say WHY the image failed,
 * and this used to treat every failure as "this file does not exist" — one permanent entry in
 * ART_MISSING, for the rest of the page's life. But a phone on wifi loses requests for reasons that
 * have nothing to do with the file: the LAN drops for a second, the server is restarted while the
 * page sits open. An idle game is left open for hours, so it only takes one such moment for a
 * portrait to vanish and never come back — which is exactly the shape of the report. A file that is
 * genuinely absent never appears in the first place; a frame that DISAPPEARS was always a live
 * request that failed.
 *
 * So a failure is now provisional. Two retries with backoff, and only then is the key remembered.
 * The retry parameter is what forces the browser to actually re-request instead of replaying the
 * failure it has already cached. */
const ART_TRIES = new Map();
const ART_RETRY_LIMIT = 2;

/* 🐛 [owner 2026-08-23: "ในกระเป๋า ... ยังติดรีโหลด 2-3 วิในบางครั้ง"] Items have no art folder — they
 * were always meant to be emoji — so opening a full bag fired 62 requests that could only 404, and
 * the retry logic above then fired each of them twice more with backoff. Measured: the render itself
 * takes 5ms and the art took 6.5 SECONDS to settle, during which every icon sat blank.
 *
 * Retrying is for a network that dropped a request. A whole KIND that has never once loaded is not a
 * dropped request, it is a folder that does not exist — so after a few failures with no successes,
 * that kind stops being asked for at all and its icons render as emoji immediately. Per page load,
 * and cleared by the `online` handler with everything else, so adding art/item/ later just works. */
/* 🐛 [owner 2026-08-23] Pictures already seen this session. Without this, every rebuild of a page
 * re-created the <img> at opacity 0 and waited for onload to reveal it — and onload for a CACHED
 * image still lands a frame later, which is a visible flash across five portraits at once. Measured
 * before: exactly one transparent frame per rebuild. A key in here is painted opaque immediately. */
const ART_LOADED = new Set();
const ART_KIND_OK = new Set();
const ART_KIND_FAIL = new Map();
const ART_KIND_GIVE_UP = 3;
const artKindOf = (key) => String(key).split("/")[0];
function artKindDead(kind) {
  return !ART_KIND_OK.has(kind) && (ART_KIND_FAIL.get(kind) || 0) >= ART_KIND_GIVE_UP;
}

/* The picture is really on screen now: reveal it, retire the emoji, and forget the retry counter.
 *
 * 🐛 [audit-qa 2026-08-22, unconfirmed but correct anyway] ART_TRIES was only ever cleared by the
 * `online` event. A network that drops requests without firing offline/online — which a phone on
 * bad wifi does — would let a key's count creep to the limit over hours and blacklist a file that
 * is present the whole time. A success is the strongest possible evidence the earlier failures were
 * transient, so it clears the count here rather than waiting for an event that may never come. */
window.markArtReady = (el) => {
  const key = el.getAttribute("src").replace(/^art\//, "").replace(/\.jpg.*$/, "");
  ART_TRIES.delete(key);
  ART_LOADED.add(key);
  ART_KIND_OK.add(artKindOf(key));   // this kind exists; keep retrying its transient failures
  const holder = el.parentElement;
  if (holder) holder.classList.add("art-on");
};

window.markArtMissing = (key, el) => {
  const n = (ART_TRIES.get(key) || 0) + 1;
  ART_TRIES.set(key, n);
  const kind = artKindOf(key);
  ART_KIND_FAIL.set(kind, (ART_KIND_FAIL.get(kind) || 0) + 1);
  /* No retries for a kind that has never produced a single picture — see the note above. */
  if (n <= ART_RETRY_LIMIT && !artKindDead(kind) && el.isConnected) {
    /* ART_STAMP is empty when the game is opened without the server, so the src may carry no query
     * at all — the separator has to be chosen, not assumed. */
    const base = el.getAttribute("src").replace(/[?&]retry=\d+/, "");
    const sep = base.includes("?") ? "&" : "?";
    setTimeout(() => {
      if (el.isConnected) el.setAttribute("src", `${base}${sep}retry=${n}`);
    }, 400 * Math.pow(4, n - 1));
    return;
  }
  ART_MISSING.add(key);
  const holder = el.parentElement;
  el.remove();
  if (holder) holder.classList.add("no-art");
};

/* Coming back online is proof that the failures were the network's, not the files'. Forget every
 * verdict reached while it was down and redraw, so the frames return without a manual reload —
 * which the owner would otherwise have to know to do. */
window.addEventListener("online", () => {
  if (!ART_MISSING.size && !ART_TRIES.size) return;
  ART_MISSING.clear();
  ART_TRIES.clear();
  ART_KIND_FAIL.clear();
  /* ART_LOADED is deliberately kept: those pictures really did arrive, and forgetting them would
     reintroduce the flash on the next render for no gain. */
  try { renderView(); refreshSidebar(); } catch (e) { /* pre-boot; the next render picks it up */ }
});

/* An icon slot that prefers art and falls back to the emoji underneath it. */
function iconArt(kind, id, emoji, alt, cls) {
  const img = artImg(kind, id, alt, cls);
  /* Seen before → opaque from the first frame, no wait for onload and nothing to flash. */
  const on = img && ART_LOADED.has(`${kind}/${id}`) ? " art-on" : "";
  return `<span class="icon-art${on}">${img || ""}<span class="icon-glyph">${emoji}</span></span>`;
}

/* ---------- Pets ---------- */

function petSpecies(id) { return PET_SPECIES.find((s) => s.id === id); }
function petLevel(pet) {
  let l = 1;
  while (l < PET_MAX_LEVEL && pet.xp >= petXpToReach(l + 1)) l++;
  return l;
}
/* 🎯 [owner 2026-08-17: "ถ้าเลเวล pet เป็นเลขคี่ มันจะหารไม่ลงตัว ก็ต้องให้มันมี exp สะสมค้างแทน"]
 * The level with its progress bar included, as one number — level 5 halfway to 6 is 5.5. Halving
 * THIS instead of the whole number is what makes an odd level survive properly: 5 becomes 2.5,
 * which is level 2 carrying half a level of XP, exactly as the owner described. Rounding down
 * first would quietly throw that half away, and on an odd level it always would. */
function petLevelExact(pet) {
  const lv = petLevel(pet);
  if (lv >= PET_MAX_LEVEL) return lv;
  const base = petXpToReach(lv), next = petXpToReach(lv + 1);
  return next > base ? lv + Math.max(0, Math.min(1, (pet.xp - base) / (next - base))) : lv;
}
/* Turn a fractional level back into stored XP. */
function petXpAtExact(exact) {
  const lv = Math.max(1, Math.min(PET_MAX_LEVEL, Math.floor(exact)));
  if (lv >= PET_MAX_LEVEL) return petXpToReach(PET_MAX_LEVEL);
  const frac = exact <= 1 ? 0 : Math.max(0, Math.min(0.999, exact - lv));
  return Math.floor(petXpToReach(lv) + frac * (petXpToReach(lv + 1) - petXpToReach(lv)));
}
function petStats(pet) {
  const sp = petSpecies(pet.species);
  const lv = petLevel(pet);
  const iv = pet.iv || { hp: 1, atk: 1, def: 1 };
  /* Passive skills are part of what the companion IS, so they belong in the stats every screen and
   * every fight already reads — not in a second pass that some call site will forget. */
  const sk = petSkillsAt(lv);
  return { lv, name: sp.name, icon: sp.icon, tier: sp.tier, grade: petGrade(iv), skills: sk,
           maxHp: Math.round(petStat(sp.hp, lv) * iv.hp),
           atk: Math.max(1, Math.round(petStat(sp.atk, lv) * iv.atk * (1 + sk.atk))),
           def: Math.round(petStat(sp.def, lv) * iv.def * (1 + sk.def)) };
}
function activePet() {
  const i = P.activePet;
  return i != null && P.pets[i] ? P.pets[i] : null;
}
/* A fainted companion sits out until healed — it neither helps nor takes hits. */
function petReady() {
  const pet = activePet();
  return pet && pet.hp > 0 ? pet : null;
}

/* Rolled on every kill. Deeper ground both rolls more often and unlocks better breeds. */
function rollPetDrop(loc, stage) {
  const tier = loc.petTier || 1;
  const chance = PET_DROP_BASE * (stage.boss ? 6 : 1) * (1 + (tier - 1) * 0.15);
  if (Math.random() >= chance) return;
  // Bosses can hand over the tier above their ground; ordinary kills stay at or below it.
  const ceiling = stage.boss ? tier + 1 : tier;
  const pool = PET_SPECIES.filter((sp) => sp.tier <= ceiling && sp.tier >= Math.max(1, ceiling - 1));
  const sp = pool[Math.floor(Math.random() * pool.length)] || PET_SPECIES[0];
  /* A wild catch stops at the top of ตำนาน — unless it is blessed, which is rare enough to be a
   * story rather than a strategy. See PET_BLESSED_CATCH. */
  const blessed = Math.random() < PET_BLESSED_CATCH;
  const ivCeiling = blessed ? PET_IV_MAX : PET_IV_CATCH_MAX;   // `ceiling` is already the tier gate
  const roll = () => Math.round(rand(PET_IV_MIN, ivCeiling) * 100) / 100;
  const pet = { species: sp.id, xp: 0, iv: { hp: roll(), atk: roll(), def: roll() } };
  pet.hp = petStats(pet).maxHp;
  P.pets.push(pet);
  P.seenPets = P.seenPets || {};
  P.seenPets[sp.id] = true;
  if (P.activePet == null) P.activePet = P.pets.length - 1;
  const g = petStats(pet).grade;
  toast(`${sp.icon} จับ ${sp.name} มาได้! คุณภาพ ${g.name} (${g.pct}%) · สายพันธุ์ระดับ ${sp.tier}`, "levelup");
}

/* ---------- 🧬 ผสมพันธุ์ (pet fusion) ----------
 * Design and balance: idle-fantacia/pet_fusion_sim.mjs (15 checks) — this is the same arithmetic wired to a
 * profile and a screen; if the two ever disagree, the sim is right.
 *
 * Two same-grade companions merge into one. There is a chance to move up one quality grade; on a
 * miss the result stays at the parents' own grade with a freshly rolled IV — a fusion that misses
 * still hands back something usable, never a downgrade. Same species in, same species out; two
 * different species branch 50/50 between the two parents. Level combines as roughly the parents'
 * average, with a little upward luck (owner's own example: lv5 + lv1 "อาจได้ขั้น 3 หรือ 4"). */
function petFusionForecast(iA, iB) {
  const a = P.pets[iA], b = P.pets[iB];
  if (!a || !b || iA === iB) return null;
  const ga = petStats(a).grade, gb = petStats(b).grade;
  if (ga.cls !== gb.cls) return null;
  const upCls = PET_GRADE_RANK[PET_GRADE_RANK.indexOf(ga.cls) + 1];
  const upName = upCls ? PET_GRADES.find((g) => g.cls === upCls).name : null;
  return {
    grade: ga, upCls, upName, chance: upCls ? (PET_FUSION_UP_BY_GRADE[ga.cls] ?? PET_FUSION_GRADE_UP) : 0,
    sameSpecies: a.species === b.species,
    levelAvg: (petLevelExact(a) + petLevelExact(b)) / 2,
  };
}
function petFuse(iA, iB) {
  const f = petFusionForecast(iA, iB);
  if (!f) { toast("ผสมพันธุ์ได้เฉพาะคุณภาพเดียวกัน", "warn"); return false; }
  const a = P.pets[iA], b = P.pets[iB];

  /* The chance depends on what you fed in, not on one number for the whole game — see
   * PET_FUSION_UP_BY_GRADE. Read from the forecast so the odds shown and the odds rolled cannot
   * drift apart. */
  const graded = f.upCls && Math.random() < f.chance ? f.upCls : f.grade.cls;
  const band = petGradeBand(graded);
  const roll = () => Math.round(rand(band.lo, band.hi) * 100) / 100;
  const iv = { hp: roll(), atk: roll(), def: roll() };
  const species = f.sameSpecies ? a.species : (Math.random() < 0.5 ? a.species : b.species);
  const lvlExact = f.levelAvg * rand(PET_FUSION_LEVEL_LO, PET_FUSION_LEVEL_HI);
  const xp = petXpAtExact(Math.max(1, Math.min(PET_MAX_LEVEL, Math.floor(lvlExact))));
  const child = { species, xp, iv };
  child.hp = petStats(child).maxHp;

  /* Both parents leave the roster; the index bookkeeping mirrors releasePet's, done twice. Splice
   * the higher index first so the lower one stays valid, then work out how far activePet shifts. */
  const hi = Math.max(iA, iB), lo = Math.min(iA, iB);
  const wasActive = P.activePet === iA || P.activePet === iB;
  P.pets.splice(hi, 1);
  P.pets.splice(lo, 1);
  P.pets.push(child);
  if (wasActive) P.activePet = P.pets.length - 1;
  else if (P.activePet != null) {
    P.activePet -= (lo < P.activePet ? 1 : 0) + (hi < P.activePet ? 1 : 0);
  }
  P.seenPets = P.seenPets || {};
  P.seenPets[species] = true;
  const st = petStats(child);
  const upgraded = graded !== f.grade.cls;
  if (!autoFuseQuiet) toast(`🧬 ผสมพันธุ์สำเร็จ! ได้ ${st.icon} ${st.name} ขั้น ${st.lv} คุณภาพ ${st.grade.name} (${st.grade.pct}%)`
    + (upgraded ? " — เลื่อนขั้นคุณภาพสำเร็จ!" : ""), "levelup");
  return true;
}

/* ---------- 🧬 ผสมอัตโนมัติ ----------
 * 🎯 [owner 2026-08-22] "ถ้ามีการสะสมมอนจำนวนมาก ก็จะลำบากที่จะไล่ผสม ดังนั้นจะมีปุ่มข้างๆ auto
 * ผสมพันธุ์ มันจะจับคู่ผสมให้อัตโนมัติ ยกเว้นตัวที่ใช้เป็นตัวหลักจะไม่โดนเลือกเข้าไป"
 *
 * The design asks the player to hoard companions; hoarding thirty and then pairing them by hand is
 * where that design stops being fun. This pairs everything it safely can in one pass.
 *
 * Two things it refuses to touch, because both would take something from the player without asking:
 *
 *   - THE COMPANION YOU ARE FIELDING. The owner's rule, and the right one: it is the one pet with a
 *     meaning the roster cannot see.
 *   - THE TOP GRADE. Two เทพสวรรค์ have nothing to climb to, so fusing them turns two into one and
 *     calls it a success. Manual fusion lets you do that if you insist; a button pressed once for
 *     the whole roster must not.
 *
 * It cascades: a pair of ดี that becomes a ยอดเยี่ยม can immediately pair with another ยอดเยี่ยม.
 * That is what "auto" has to mean, or you would press it five times in a row.
 */
let autoFuseQuiet = false;   // set while a batch runs, so each fusion does not announce itself

function autoFusePlan() {
  const top = PET_GRADE_RANK[PET_GRADE_RANK.length - 1];
  const groups = {};
  P.pets.forEach((pet, i) => {
    if (i === P.activePet) return;                 // never the one you are carrying
    const cls = petStats(pet).grade.cls;
    if (cls === top) return;                       // nothing above it to reach
    (groups[cls] = groups[cls] || []).push(i);
  });
  let pairs = 0;
  for (const list of Object.values(groups)) pairs += Math.floor(list.length / 2);
  return { pairs, groups };
}

/* Runs the plan and keeps going while new pairs appear. Returns a tally rather than toasting per
 * fusion — twenty toasts in two seconds is not a report, it is a wall. */
function autoFuseRun() {
  const before = P.pets.length;
  let done = 0, upgraded = 0, guard = 0;
  /* petFuse announces every fusion, which is right for one deliberate click and wrong for twenty in
   * a row — twenty toasts in two seconds is a wall, not a report. A flag rather than swapping the
   * toast function out: reassigning a function declaration mid-run is the kind of trick that works
   * until someone makes the file a module. */
  autoFuseQuiet = true;
  try {
    for (;;) {
      if (guard++ > 500) break;                     // a roster this size cannot need more rounds
      const plan = autoFusePlan();
      if (!plan.pairs) break;
      /* 🎯 [owner 2026-08-22] "มันต้องเล่นผสมจากระดับต่ำให้เสร็จ ไล่ไปจนสูง"
       *
       * Strictly lowest grade first, and finish it before moving up. Object key order — which is
       * the order the pets happen to sit in the roster — was what this used before, and that is not
       * an order at all: it made the same roster fuse differently depending on the sequence you
       * caught things in. Bottom-up is also what actually feeds the ladder, since every pair of
       * ธรรมดา that succeeds becomes a พอใช้ waiting for a partner one rung up. */
      const list = PET_GRADE_RANK
        .map((cls) => plan.groups[cls])
        .find((g) => g && g.length >= 2);
      if (!list) break;
      const [iA, iB] = list.slice(0, 2).sort((a, b) => a - b);
      const gradeBefore = petStats(P.pets[iA]).grade.cls;
      if (!petFuse(iA, iB)) break;
      done++;
      if (petStats(P.pets[P.pets.length - 1]).grade.cls !== gradeBefore) upgraded++;
    }
  } finally { autoFuseQuiet = false; }
  return { done, upgraded, before, after: P.pets.length };
}

/* Letting one go. The active index has to move with the array, or releasing an early pet would
 * silently swap which companion you are carrying. */
function releasePet(i) {
  const st = petStats(P.pets[i]);
  if (!confirm(`ปล่อย ${st.name} (ขั้น ${st.lv} · คุณภาพ ${st.grade.name}) กลับสู่ธรรมชาติ?\nทำแล้วย้อนกลับไม่ได้`)) return;
  P.pets.splice(i, 1);
  if (P.activePet === i) P.activePet = P.pets.length ? 0 : null;
  else if (P.activePet != null && P.activePet > i) P.activePet--;
  toast(`${st.icon} ปล่อย ${st.name} กลับสู่ธรรมชาติแล้ว`);
  renderView();
}

/* Feeds the companion from the SAME provision slots the player packs.
 *
 * 🐛 [owner 2026-08-23] "ไม่มีปุ่มฮีลให้ หลังมันตาย" — there WAS a button; it could never work.
 * This read petReady(), which is defined as "carried AND hp > 0", so the one state feeding exists
 * to undo was the one state it refused to act in. A fainted companion therefore had no way back at
 * all: onKill also gates XP behind petReady(), so it could not level out of it either, and no
 * daily tick restores pet HP. Measured: hp 0 stayed 0 through 30 in-game days with 99 loaves in
 * the pack. Only a rebirth or fusing it away cleared it — permanent, from one lost fight.
 *
 * Both the faint toast and the pet card already told the player to feed it. The promise was right;
 * the gate was wrong. It reads activePet() now, so "พักจนกว่าจะได้กินอาหาร" is literally true.
 *
 * The sit-out penalty survives: combat's own auto-eat only fires on a companion that is still
 * standing (see the petHits block and the damage split), so nothing revives itself mid-fight.
 * Coming back costs a deliberate tap on the button. */
function petEat() {
  const pet = activePet();
  if (!pet) return false;
  const st = petStats(pet);
  if (pet.hp >= st.maxHp) return false;
  const idx = nextFoodSlot();
  if (idx < 0) return false;
  const id = P.food[idx];
  const wasDown = pet.hp <= 0;
  P.inv[id] -= 1;
  pet.hp = Math.min(st.maxHp, pet.hp + ITEMS[id].heal);
  if (wasDown) {
    toast(`${st.icon} ${st.name} ฟื้นแล้ว — ออกสนามต่อได้ (❤️ ${pet.hp}/${st.maxHp})`, "levelup");
    if ((P.inv[id] || 0) === 0) P.food = P.food.map((f) => (f === id ? null : f));
    return true;
  }
  /* 🎯 [owner 2026-08-23] "ถ้าปิด มันควรปิดค่า pet และคนกินอาหารด้วย มันระบบต่อสู้เดียวกัน" —
     eating only ever happens because something is hitting you, so it belongs to the switch that
     silences the fight rather than being unmutable on its own. */
  toast(`${st.icon} ${st.name} กิน ${ITEMS[id].icon} ${ITEMS[id].name} (+${ITEMS[id].heal} HP)`, "", "kill");
  if ((P.inv[id] || 0) === 0) P.food = P.food.map((f) => (f === id ? null : f));
  return true;
}

/* ---------- Achievements ---------- */

function bump(stat, n = 1) {
  P.stats[stat] = (P.stats[stat] || 0) + n;
}

/* Counters that are cheaper to derive than to track incrementally. */
function derivedStat(stat) {
  if (stat.startsWith("kill:")) return P.stats[stat] || 0;
  if (stat === "masterySum")
    return Object.values(P.mastery).reduce((t, xp) => t + masteryLevelFromXp(xp), 0);
  if (stat === "species") return Object.keys(P.seenFish).length;
  if (stat === "cropSpecies") return Object.keys(P.seenCrops || {}).length;
  if (stat === "setsOwned")
    return ARMOR_SETS.filter((set) => set.pieces.every((pc) => (P.inv[pc] || 0) > 0)).length;
  return P.stats[stat] || 0;
}

function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (P.achieved[a.id]) continue;
    if (derivedStat(a.stat) < a.goal) continue;
    P.achieved[a.id] = true;
    const perks = Object.entries(a.perk)
      .map(([k, v]) => ({ speed: `⚡ ทุกงานเร็วขึ้น ${Math.round(v * 100)}%`,
                          dmg: `🗡️ ดาเมจ +${v}`, def: `🛡️ ป้องกัน +${v}`,
                          luck: `🍀 โชค +${Math.round(v * 100)}%`,
                          goldBonus: `💰 ทอง +${Math.round(v * 100)}%`,
                          healBonus: `❤️ อาหารฟื้นเพิ่ม ${Math.round(v * 100)}%` }[k])).join(" · ");
    toast(`🏆 ปลดความสำเร็จ "${a.name}" — ${perks}`, "levelup");
  }
}

/* ---------- Mythwood's calendar ----------
 * Advances only while the game is open, so a "year" measures play, not absence. Everything
 * scheduled in game time — dividends, bank interest, the tax year — hangs off onNewDay rather
 * than reading the clock itself, so there is exactly one place that decides a day has passed. */

function today() { return gameDate(P.gameDays); }
function dateLabel(d = today()) { return `ปีที่ ${d.year} · ${d.monthName} วันที่ ${d.day}`; }

/* The views a daily system can change under the player's feet. Kept beside calendarTick rather than
 * spread across the systems, so adding one is a single edit in an obvious place.
 *
 * 🐛 [owner 2026-08-23: "ในหน้าครอบครัว มันกระพริบทุกครั้งที่มี notis ... ให้มันเหมือนโปรเซสอื่นที่ทำงาน
 * แบบไม่เห็น ... เหมือนระบบขั้นความชำนาญ"] The family page is deliberately NOT here. My first fix cut
 * the repaints from twenty per catch-up to one, and one is still one too many: a day boundary fires
 * a toast and a rebuild together, so every notification came with a visible flash. Mastery is the
 * model — it accrues all day and the screen simply shows the current number the next time you look.
 *
 * Shops and bank stay, because both are pages you sit and watch a number move on. Nothing on the
 * family screen moves while you watch it. */
const DAILY_VIEWS = new Set(["shops", "bank"]);

function calendarTick(dtSeconds) {
  const before = today();
  P.gameDays += dtSeconds / GAME_DAY_SECONDS;
  const after = today();
  if (after.totalDays === before.totalDays) return;
  for (let d = before.totalDays + 1; d <= after.totalDays; d++) onNewDay(gameDate(d), d);
  updateTopbar();
  /* 🐛 [owner 2026-08-22: "มันกระพริบ รีเฟรชรัวๆ ... รีเฟรชเฉพาะตอนกดเข้ามาดูอีกครั้ง"] The daily
   * systems used to repaint from inside onNewDay, which is fine at one day per 100 seconds and
   * awful the moment this loop catches up. A backgrounded tab throttles the 250ms timer, so coming
   * back runs twenty days in one pass — and the page was rebuilt twenty times in a row. Measured:
   * 20 renders back to back, which is exactly what he was watching.
   *
   * One repaint after the whole catch-up, and only for the pages a daily system actually changes.
   * Anything else is picked up when the player opens it. */
  if (DAILY_VIEWS.has(view.kind)) renderViewAuto();
}

/* One game day passed. Kept deliberately small: each subsystem gets its own function so a new
 * scheduled system is one line here rather than a branch buried in tick(). */
function onNewDay(date) {
  bankAccrue(date);
  marketTick(date);
  /* 🎯 [owner 2026-08-23] "มีการปรับค่าทุกวัน" — every game-day, beside the share market, so the
     two move on the same clock and neither can be timed against the other. */
  cryptoTick();
  payDividends(date);
  runShopsDay(date);
  runEstatesDay();
  runGuildDay();
  refreshQuests(questDay());
  childrenAgeDay();
  childBirthRoll();
  childrenHuntDay();
  /* After the birth roll so a child born today is fed from today, and before taxDebtCheck so that a
   * day whose upkeep pushed the balance negative starts the 90-day clock on that same day rather
   * than a day late. */
  familyUpkeepDay();
  /* 🐛 [found by game-playtester, 2026-08-18] taxEnforce's own docstring says "Runs every game-day"
   * and the tax page shows the late fee as a per-day rate ("ค่าปรับวันละ 0.4%"), but this used to be
   * called from a monthly wrapper that only ran on day 1 of each month — so a seized business accrued
   * its "daily" late fee at 1/30th the advertised speed, and the toast the owner asked for ("daily
   * late-fee deductions with notifications") fired once a month instead of daily. */
  /* Before taxEnforce and taxDebtCheck, so a day's charge is on the books when they read them. */
  taxAccrueDay();
  taxEnforce(date);
  taxDebtCheck();
  if (date.day === 1 && date.month === 1) onNewYear(date);
  else if (date.day === 1) onNewMonth(date);
}

function onNewMonth(date) {
  familyUpkeepPost();
  estateRentPost();
  dividendPost();
  kidHuntPost();
}

/* One ledger line a month for what the children brought home, the counterpart of estateRentPost.
   Posts nothing in a month where nobody hunted, rather than a zero. */
function kidHuntPost() {
  const m = P.kidHuntMonth || { gold: 0, items: 0, hunts: 0, chores: 0 };
  /* A save written while the two totals were still separate carries a part-month in the old field.
     Fold it in rather than drop it, then retire the field. */
  const legacy = P.kidChoreMonth;
  if (legacy) {
    m.gold += legacy.gold || 0;
    m.items += legacy.items || 0;
    m.chores = (m.chores || 0) + (legacy.runs || 0);
    delete P.kidChoreMonth;
  }
  P.kidHuntMonth = { gold: 0, items: 0, hunts: 0, chores: 0 };
  if (!m.gold && !m.items) return;
  /* 🎯 [owner 2026-08-23] "รวมถึงค่ารายเดือนที่แสดงในบัญชี มันไม่ต้องแยกเป็นสองค่า" — one line
     for everything the children brought home, hunting and errands together, matching the single
     daily notice. Both counts still appear, because how they earned it is the part worth reading;
     what must not be split is the MONEY. */
  const how = [m.hunts ? `ล่า ${m.hunts}` : "", m.chores ? `หาของ ${m.chores}` : ""]
    .filter(Boolean).join(" · ");
  ledger("🗡️", `ลูกๆ ออกทำงาน (${how}) — ของ ${m.items} ชิ้น`, Math.round(m.gold));
}

/* One ledger line a month for rent, the counterpart of familyUpkeepPost. Posts what actually
 * arrived, and posts nothing at all in a month without property rather than a zero. */
/* 🎯 [owner 2026-08-23] "ให้รวบรวมการปันผลให้ครบ แล้วแสดงเป็นรายเดือน เหมือนค่าเช่า" — the
   counterpart of estateRentPost, and named for the same reason: a month with no holdings posts
   nothing rather than a zero. */
function dividendPost() {
  const m = P.divMonth;
  P.divMonth = { gold: 0, days: 0, payers: 0 };
  if (!m || m.gold <= 0) return;
  ledger("📈", `${T("ปันผล")} (${T("ทั้งเดือน")}) — ${m.payers || 1} ${T("กิจการ")}`,
    Math.round(m.gold));
}

function estateRentPost() {
  const earned = Math.round(P.estateMonth || 0);
  P.estateMonth = 0;
  if (earned <= 0) return;
  ledger("🏘️", `ค่าเช่าอสังหา (ทั้งเดือน)`, earned);
}

/* One ledger line a month for the household, instead of one a day drowning the dividends beside it.
 * Posts what was ACTUALLY paid, not what was owed — a month where the wallet came up short shows
 * the smaller figure, and the shortfall is already carried as arrears and warned about the day it
 * happens. Runs on the calendar rather than on a counter, so a month with no marriage posts nothing
 * rather than a zero. Also called by onNewYear's month rollover, since day 1 of month 1 takes that
 * branch instead. */
function familyUpkeepPost() {
  const paid = Math.round(P.family?.monthPaid || 0);
  if (paid <= 0) { if (P.family) P.family.monthPaid = 0; return; }
  P.family.monthPaid = 0;
  ledger("👨‍👩‍👧", "ค่าเลี้ยงดูครอบครัว (ทั้งเดือน)", -paid);
  /* No toast to go with it. The daily notice the owner asked for already reports each deduction as
     it happens; a second one at month end would be the same information twice, which is the noise
     this change exists to remove. */
}

function onNewYear(date) {
  familyUpkeepPost();   // day 1 of month 1 comes here instead of onNewMonth, so the month still closes
  estateRentPost();
  dividendPost();
  kidHuntPost();
  bankTidySlips();
  toast(`🎆 ขึ้นปีใหม่ — ปีที่ ${date.year} ของมิธวูด`, "levelup");
  settleTaxYear(date);
}


/* ---------- 🏹 สถาบันฮันเตอร์ (Hunter Guild) ----------
 * Design note: idle-fantacia/HUNTER_GUILD.md. Model and balance: idle-fantacia/guild_sim.mjs (38 checks), which owns
 * every number below — if this file and the sim ever disagree, the sim is right.
 *
 * What it is: the late-game money sink that pays back like a house. You buy a school, take in
 * trainees who cost more than they earn, raise them through ranks over game-years, and send squads
 * after named monsters while you are doing something else. It does not consume a job slot, by
 * deliberate design — every system in this game that competes for slots fights the rest of it.
 *
 * One game-day of the institute, in order: upkeep is paid, each squad on a contract hunts, the
 * bounty and materials land in the pending pile, the hurt come back, someone may not, and training
 * moves everyone toward their next exam. */

const GUILD_NAMES = [
  "อาริน", "เบญญา", "จินตา", "ดารุณ", "เอกา", "ฟ้าใส", "กันต์", "หฤท", "อิงฟ้า", "จารุ",
  "กฤต", "ลลิล", "มนัส", "นารา", "โอบนิธิ", "ปราณ", "ควีนา", "รวิ", "สาริน", "ธาร",
  "อุรัสยา", "วรุณ", "วิศรุต", "ยศ", "ซาบีน", "อนล", "บุญฤทธิ์", "ชนัต", "ดลย์", "เอื้อ",
];
const GUILD_HURT_DAYS = 12;          // a wounded hunter is off the roster this long, then returns
const GUILD_APPLICANT_DAYS = 30;     // a fresh intake shows up once a game-month
const GUILD_CONTRACT_LENGTHS = GUILD_MISSION_ROUNDS;

function guildOn() { return !!P.guild && P.guild.tier > 0; }
function guildTier() { return GUILD_TIERS[Math.max(0, (P.guild?.tier || 1) - 1)]; }
function guildNextTier() { return GUILD_TIERS[P.guild?.tier || 0] || null; }
function guildUpkeepPick() { return P.guild?.upkeep || { food: 1, gear: 1, med: 1, train: 1 }; }
function guildEffect(line) {
  const tiers = GUILD_UPKEEP[line].tiers;
  return tiers[Math.min(tiers.length - 1, guildUpkeepPick()[line] || 0)].effect;
}
function guildUpkeepPerDay() {
  const heads = (P.guild?.roster || []).length;
  const per = Object.keys(GUILD_UPKEEP).reduce((t, line) => {
    const tiers = GUILD_UPKEEP[line].tiers;
    return t + tiers[Math.min(tiers.length - 1, guildUpkeepPick()[line] || 0)].cost;
  }, 0);
  return Math.round(per * guildTier().upkeepMult * heads + guildTier().fixed);
}
function guildRank(id) { return GUILD_RANKS.find((r) => r.id === id) || GUILD_RANKS[0]; }
function guildRankIdx(id) { return Math.max(0, GUILD_RANKS.findIndex((r) => r.id === id)); }
function guildMember(id) { return (P.guild?.roster || []).find((m) => m.id === id) || null; }
function guildIsHurt(m) { return (m.hurtUntil || 0) > P.gameDays; }
/* The zones an institute may write contracts for. This is the wall a squad grows into, and the
 * reason upgrading the school is the loop rather than a nicety. */
/* 🎯 [owner 2026-08-23] "สมาคมฮันเตอร์ก็ใช้กฎเดียวกับลูกนะ ต้องให้เราผ่านการล่าก่อน ถึงจะไปล่าได้" —
 * the institute's contract list was gated only by its own tier, so a young school could be sent to
 * a zone the owner had never walked into. Same rule as the children now: somewhere he has fought. */
function guildTargets() {
  return LOCATIONS.slice(0, guildTier().zones).flatMap((loc, li) =>
    loc.stages.map((st, si) => ({ loc, st, key: `${loc.id}:${si}`, li, si }))
      .filter((x) => !x.st.boss && stageKills(loc.id, x.si) > 0));
}
function guildTargetByKey(key) { return guildTargets().find((t) => t.key === key) || null; }

function guildSquads() {
  P.guild.squads = P.guild.squads || [];
  while (P.guild.squads.length < guildTier().squads) {
    /* autoRepeat defaults on: this is supposed to be the system that "works in the background while
     * you do something else" — see runGuildDay below for what happened when it did not. */
    P.guild.squads.push({ members: [], targetKey: null, roundsLeft: 0, roundsTotal: 0, autoRepeat: true });
  }
  return P.guild.squads.slice(0, guildTier().squads);
}
/* A squad's fighting strength, with the diminishing return per extra body that stops a squad from
 * being a headcount, and the gear that multiplies all of it. */
function guildSquadStrength(sq) {
  const bodies = (sq.members || []).map(guildMember).filter((m) => m && !guildIsHurt(m));
  return guildSquadPower(bodies.map((m) => ({ power: guildRank(m.rank).power })), guildEffect("gear"));
}
function guildSquadReady(sq) {
  return (sq.members || []).map(guildMember).filter((m) => m && !guildIsHurt(m)).length > 0;
}
function guildForecast(sq, target) {
  if (!target) return null;
  const power = guildSquadStrength(sq);
  const tp = guildTargetPower(target.st);
  const out = guildOutcome(power, tp, guildEffect("med"));
  const kills = guildKillsPerRound(power, tp, guildEffect("food"));
  const bounty = guildBounty(target.st);
  const bodies = (sq.members || []).map(guildMember).filter(Boolean);
  const wage = bodies.reduce((t, m) => t + guildRank(m.rank).wage, 0);
  return {
    power, tp, kills, bounty, wage, ...out,
    goldPerRound: Math.round(kills * bounty * out.success),
    lootPerRound: Math.round(kills * bounty * GUILD_LOOT_SHARE * out.success),
  };
}

/* Materials: the budget is a share of the bounty, converted into whatever this monster actually
 * drops. Rolling the loot table straight would hand the guild the same haul a player gets for a
 * kill that took them a real fight, and the value of that haul swings 5x between zones. */
function guildLootFor(stage, budget) {
  const table = (stage.loot || []).filter((d) => (ITEMS[d.item]?.sell || 0) > 0);
  if (!table.length || budget <= 0) return {};
  const weight = table.reduce((t, d) => t + d.chance, 0) || 1;
  const got = {};
  for (const d of table) {
    const share = budget * (d.chance / weight);
    const n = Math.floor(share / (ITEMS[d.item].sell || 1));
    if (n > 0) got[d.item] = (got[d.item] || 0) + n;
  }
  return got;
}

function guildPending() {
  P.guild.pending = P.guild.pending || { gold: 0, items: {}, rounds: 0 };
  return P.guild.pending;
}

/* One game-day. Called from onNewDay, after the shops and before the calendar rolls over. */
function runGuildDay() {
  if (!guildOn()) return;
  if (taxSeized()) return;          // seized for unpaid tax: the institute is shut with everything else
  const g = P.guild;
  g.roster = g.roster || [];
  if (!g.roster.length) return;

  /* Upkeep first, and it is not optional: hunters who are not fed do not hunt. Failing to pay stops
   * the day rather than accruing a debt, so the recovery is always "put money in the bank", never
   * a spiral you cannot read. */
  const bill = guildUpkeepPerDay();
  if (bill > 0) {
    /* Check before taking, never take-then-refund: takeGoldThenBank eats deposit slips on its way
     * down, and handing the money back into the pocket would quietly empty the bank one game-day at
     * a time while the books still balanced. */
    if (Math.floor(P.gold) + bankBalance() < bill) {
      if (!g.warnedBroke) {
        toast("🏹 จ่ายค่าเลี้ยงสถาบันไม่ไหว — วันนี้ไม่มีใครออกล่า", "warn");
        g.warnedBroke = true;
      }
      return;
    }
    takeGoldThenBank(bill);
    g.warnedBroke = false;
    bump("guildUpkeep", bill);
  }

  const pending = guildPending();
  let anyHunted = false;
  for (const sq of guildSquads()) {
    if (!sq.targetKey || (sq.roundsLeft || 0) <= 0) continue;
    const target = guildTargetByKey(sq.targetKey);
    if (!target) { sq.targetKey = null; sq.roundsLeft = 0; continue; }
    const bodies = (sq.members || []).map(guildMember).filter((m) => m && !guildIsHurt(m));
    if (!bodies.length) continue;   // everyone is in the infirmary; the contract waits

    const power = guildSquadPower(bodies.map((m) => ({ power: guildRank(m.rank).power })), guildEffect("gear"));
    const tp = guildTargetPower(target.st);
    const { success, hurt, died } = guildOutcome(power, tp, guildEffect("med"));
    sq.roundsLeft -= 1;
    anyHunted = true;

    const wages = bodies.reduce((t, m) => t + guildRank(m.rank).wage, 0);
    if (Math.random() < success) {
      const kills = guildKillsPerRound(power, tp, guildEffect("food"));
      const bounty = guildBounty(target.st);
      const gold = Math.round(kills * bounty);
      pending.gold += gold;
      pending.rounds = (pending.rounds || 0) + 1;
      const loot = guildLootFor(target.st, kills * bounty * GUILD_LOOT_SHARE);
      for (const [id, n] of Object.entries(loot)) pending.items[id] = (pending.items[id] || 0) + n;
      /* Wages come out of the take, not out of your pocket, so a failed round costs you nothing
       * beyond the day's food — the owner's framing of paying per ROUND, not per day. */
      pending.gold = Math.max(0, pending.gold - wages);
      bump("guildRounds");
    }

    /* Casualties. Injury is the common outcome and it benches someone for a while; death is rare
     * and permanent, and it is why medicine is on the bill. */
    for (const m of bodies) {
      if (Math.random() < died) {
        g.roster = g.roster.filter((x) => x.id !== m.id);
        for (const other of g.squads) other.members = (other.members || []).filter((x) => x !== m.id);
        toast(`🕯️ ${m.name} (${m.rank}) ไม่ได้กลับมาจากภารกิจ`, "warn");
        bump("guildDeaths");
      } else if (Math.random() < hurt) {
        m.hurtUntil = P.gameDays + GUILD_HURT_DAYS;
        toast(`🩹 ${m.name} บาดเจ็บ — พัก ${GUILD_HURT_DAYS} วัน`, "warn", "guild");
        bump("guildHurt");
      }
    }

    /* Training only counts while they are working — a rank is field experience, and the teacher
     * decides how much of a day's work turns into it. */
    for (const m of bodies) {
      if (!GUILD_RANKS[guildRankIdx(m.rank) + 1]) continue;
      m.rounds = (m.rounds || 0) + guildEffect("train");
    }
    if (sq.roundsLeft <= 0) {
      /* 🐛 [reconfirmed by two separate game-playtester runs, 2026-08-18] A finished contract used
       * to just sit there — the squad did nothing, no toast explained why, and upkeep kept draining
       * every day regardless. One run measured 815,400 wasted on a squad idle for two game-years;
       * another lost 270 of a 300-day window the same way. For a system whose entire pitch is
       * running unattended, a silent full stop the day the first contract ends is the opposite of
       * that pitch. Re-issue the SAME contract automatically unless the player turned it off — the
       * target and length they chose are exactly what "keep doing this" should mean by default. */
      if (sq.autoRepeat && sq.roundsTotal > 0 && guildTargetByKey(sq.targetKey)) {
        sq.roundsLeft = sq.roundsTotal;
        toast(`🏹 ${target.st.name} ครบรอบแล้ว — ออกภารกิจใหม่อัตโนมัติ`, "", "guild");
      } else {
        toast(`🏹 ทีมกลับถึงสถาบันแล้ว — ${target.st.name}`, "", "guild");
      }
    }
  }

  if (anyHunted && P.guild.autoCollect) guildCollect(true);
  if (view.kind === "guild") renderViewAuto();
}

function guildCollect(quiet = false) {
  if (!guildOn()) return 0;
  const pending = guildPending();
  const gold = Math.floor(pending.gold || 0);
  const items = pending.items || {};
  const n = Object.values(items).reduce((t, x) => t + x, 0);
  if (gold <= 0 && n <= 0) { if (!quiet) toast("ยังไม่มีอะไรให้รับ", "warn"); return 0; }
  /* no-goldBonus: the institute's takings are a business's profit, like rent and dividends — the
   * luck charm and rebirth karma reward what YOU hunt and steal, not what an operation you own
   * earns while you are elsewhere. The materials are not scaled either, for the same reason. */
  P.gold += gold;
  for (const [id, count] of Object.entries(items)) P.inv[id] = (P.inv[id] || 0) + count;
  /* Guild takings ARE business income: they come from an operation you own, so they belong in the
   * same bucket the shops and dividends pay from, and the income-tax ladder sees them. */
  if (gold > 0) { bookInvestmentProfit(gold); ledger("🏹", "รายได้สถาบันฮันเตอร์", gold); }
  bump("guildGold", gold);
  P.guild.pending = { gold: 0, items: {}, rounds: 0 };
  if (!quiet) toast(`🏹 รับ ${gold.toLocaleString()} 💰${n ? ` · ของ ${n} ชิ้น` : ""}`, "", "guild");
  return gold;
}

function guildBuild() {
  const tier = GUILD_TIERS[0];
  if (guildOn()) return false;
  if (Math.floor(P.gold) < tier.cost) { toast(T("ทองไม่พอสร้างสถาบัน"), "warn"); return false; }
  P.gold -= tier.cost;
  P.guild = {
    tier: 1, roster: [], squads: [], applicants: [], applicantDay: -999,
    upkeep: { food: 1, gear: 1, med: 0, train: 1 },
    pending: { gold: 0, items: {}, rounds: 0 }, autoCollect: false,
  };
  ledger("🏹", currentLang() === "en" ? `Build ${tier.name}` : `สร้าง${tier.name}`, -tier.cost);
  toast(currentLang() === "en" ? `🏹 ${tier.name} built — room for ${tier.beds}` : `🏹 สร้าง${tier.name}แล้ว — รับเด็กเข้ามาได้ ${tier.beds} คน`, "levelup");
  guildRefreshApplicants(true);
  return true;
}

function guildUpgrade() {
  const next = guildNextTier();
  if (!next) return false;
  if (Math.floor(P.gold) < next.cost) { toast("ทองไม่พออัปเกรดสถาบัน", "warn"); return false; }
  P.gold -= next.cost;
  P.guild.tier += 1;
  ledger("🏹", `อัปเกรดเป็น${next.name}`, -next.cost);
  toast(`🏹 ${next.name} — เตียง ${next.beds} · ทีม ${next.squads} · โซน ${next.zones}`, "levelup");
  return true;
}

function guildRefreshApplicants(force = false) {
  const g = P.guild;
  if (!g) return;
  if (!force && P.gameDays - (g.applicantDay || -999) < GUILD_APPLICANT_DAYS) return;
  g.applicantDay = P.gameDays;
  const n = 5 + Math.floor(Math.random() * 6);          // 5-10, as the design asked
  const used = new Set((g.roster || []).map((m) => m.name));
  g.applicants = [];
  for (let i = 0; i < n; i++) {
    const pool = GUILD_NAMES.filter((x) => !used.has(x));
    const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : `ฮันเตอร์ ${i + 1}`;
    used.add(name);
    g.applicants.push({ id: `a${P.gameDays}_${i}`, name });
  }
}

/* Recruits all arrive identical, on purpose. The owner asked for fixed numbers and low variance;
 * per-person potential rolls would make "reroll the intake" the real game and the school a
 * lottery. What you decide is HOW MANY mouths to feed, which is the decision that has a cost. */
function guildRecruit(applicantId) {
  const g = P.guild;
  const a = (g.applicants || []).find((x) => x.id === applicantId);
  if (!a) return false;
  if (g.roster.length >= guildTier().beds) { toast("เตียงเต็มแล้ว — ต้องอัปเกรดสถาบันก่อน", "warn"); return false; }
  g.applicants = g.applicants.filter((x) => x.id !== applicantId);
  g.roster.push({ id: `m${P.gameDays}_${Math.floor(Math.random() * 100000)}`, name: a.name, rank: "F", rounds: 0, hurtUntil: 0, since: P.gameDays });
  toast(`🏹 รับ ${a.name} เข้าสถาบันแล้ว`, "", "guild");
  return true;
}

function guildDismiss(memberId) {
  const g = P.guild;
  g.roster = (g.roster || []).filter((m) => m.id !== memberId);
  for (const sq of g.squads || []) sq.members = (sq.members || []).filter((x) => x !== memberId);
}

function guildCanExam(m) {
  const next = GUILD_RANKS[guildRankIdx(m.rank) + 1];
  return !!next && (m.rounds || 0) >= next.examRounds;
}
function guildExam(memberId) {
  const m = guildMember(memberId);
  if (!m) return false;
  const next = GUILD_RANKS[guildRankIdx(m.rank) + 1];
  if (!next) return false;
  if (!guildCanExam(m)) { toast("ยังฝึกไม่พอจะสอบขั้นนี้", "warn"); return false; }
  if (takeGoldThenBank(next.examCost) < next.examCost) { toast("เงินไม่พอค่าสอบ", "warn"); return false; }
  m.rank = next.id;
  m.rounds = 0;
  ledger("🎓", `ค่าสอบเลื่อนขั้น ${m.name} → ${next.id}`, -next.examCost);
  toast(`🎓 ${m.name} สอบผ่านเป็นขั้น ${next.id} ${next.name}`, "levelup");
  return true;
}

function guildAssign(squadIdx, memberId) {
  const sq = guildSquads()[squadIdx];
  if (!sq) return false;
  const already = sq.members.includes(memberId);
  if (already) { sq.members = sq.members.filter((x) => x !== memberId); return true; }
  if (sq.members.length >= GUILD_SQUAD_MAX) { toast(`ทีมละไม่เกิน ${GUILD_SQUAD_MAX} คน`, "warn"); return false; }
  for (const other of guildSquads()) other.members = (other.members || []).filter((x) => x !== memberId);
  sq.members.push(memberId);
  return true;
}

function guildStart(squadIdx, targetKey, rounds) {
  const sq = guildSquads()[squadIdx];
  if (!sq) return false;
  if (!guildSquadReady(sq)) { toast("ทีมนี้ยังไม่มีคนพร้อมออกล่า", "warn"); return false; }
  if (!guildTargetByKey(targetKey)) { toast("สถาบันขั้นนี้ยังรับสัญญาโซนนั้นไม่ได้", "warn"); return false; }
  sq.targetKey = targetKey;
  sq.roundsLeft = rounds;
  sq.roundsTotal = rounds;
  toast(`🏹 ออกภารกิจ ${guildTargetByKey(targetKey).st.name} · ${rounds} รอบ`, "", "guild");
  return true;
}
function guildRecall(squadIdx) {
  const sq = guildSquads()[squadIdx];
  if (sq) { sq.roundsLeft = 0; }
}
function guildSetAutoRepeat(squadIdx, on) {
  const sq = guildSquads()[squadIdx];
  if (sq) sq.autoRepeat = !!on;
}

/* ---------- Your own shops ----------
 * The whole model lives in idle-fantacia/shop_sim.mjs, which tunes and asserts it (56 checks). This is the
 * same arithmetic wired to a profile and a screen; if the two ever disagree, the sim is right.
 *
 * One game-day of a shop, in order: hunters produce raw, crafters convert it, customers arrive
 * and buy what is on the shelf, wages go out, reputation moves toward what the shop deserved
 * today, and the regular customer base creeps toward that. */

function shopType(id) { return SHOP_TYPES.find((t) => t.id === id); }
function shopTier(sh) { return SHOP_TIERS[sh.tier]; }

function shopStaffBy(sh, role) { return sh.staff.filter((w) => w.role === role); }
function shopWagesPerDay(sh) {
  return sh.staff.reduce((t, w) => t + staffSalary(w, P.gameDays), 0);
}

/* An applicant's traits are hidden as a range until you pay to check them. That turns a blind
 * gamble into a decision you can buy your way out of — and it is what makes honesty worth
 * knowing, since an honest worker is the one you can safely underpay. */
function rollApplicant() {
  const role = STAFF_ROLES[Math.floor(Math.random() * STAFF_ROLES.length)];
  const rnd = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
  return {
    role: role.id, name: `${STAFF_FIRST[Math.floor(Math.random() * STAFF_FIRST.length)]} `
      + STAFF_LAST[Math.floor(Math.random() * STAFF_LAST.length)],
    wage: role.wage, rate: role.rate,
    diligence: rnd(0.55, 1.0), honesty: rnd(0.2, 1.0), charisma: rnd(0.4, 1.0),
    payRatio: 1.0, hiredDay: 0, vetted: false,
  };
}
function refreshApplicants(sh) {
  sh.applicants = Array.from({ length: SHOP_APPLICANTS }, rollApplicant);
}

function openShop(typeId) {
  const tier = SHOP_TIERS[0];
  if (P.gold < tier.cost) { toast(`ทองไม่พอ — เปิดร้านต้องใช้ ${tier.cost.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= tier.cost;
  /* Brand carries across shops (owner's rule): a second shop under a name people already trust
   * opens into an audience the first one built, capped by what the little building can hold. */
  const carried = Math.min(tier.regulars, SHOP_BRAND_CARRY * (P.brand || 0));
  const sh = {
    type: typeId, tier: 0, price: 1.0, rep: 0.35, regulars: carried,
    raw: 0, goods: 0, staff: [], applicants: [], ledger: { revenue: 0, wages: 0, theft: 0, days: 0 },
  };
  refreshApplicants(sh);
  P.shops.push(sh);
  const t = shopType(typeId);
  toast(`${t.icon} เปิด${t.name}แล้ว — จ้างคนแล้วส่งวัตถุดิบเข้าร้านได้เลย`, "levelup");
  if (carried > 0.05) toast(`⭐ ชื่อเสียงเดิมพาลูกค้าประจำมาให้ ${carried.toFixed(1)} คนตั้งแต่วันแรก`, "levelup", "money");
  save("เปิดร้าน");
}

function upgradeShop(sh) {
  const next = SHOP_TIERS[sh.tier + 1];
  if (!next) return;
  if (P.gold < next.cost) { toast(`ทองไม่พอ — ขยายร้านต้องใช้ ${next.cost.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= next.cost;
  sh.tier++;
  toast(`🏗️ ขยายเป็น${next.name} — จ้างได้ ${next.slots} คน ลูกค้ามากขึ้น`, "levelup");
  save("ขยายร้าน");
}

function hireStaff(sh, idx) {
  const tier = shopTier(sh);
  if (sh.staff.length >= tier.slots) { toast(`${tier.name} รับได้แค่ ${tier.slots} คน — ขยายร้านก่อน`, "warn"); return; }
  const a = sh.applicants[idx];
  if (!a) return;
  sh.staff.push({ ...a, hiredDay: P.gameDays });
  sh.applicants.splice(idx, 1);
  if (!sh.applicants.length) refreshApplicants(sh);
  toast(`🤝 จ้าง ${a.name} เป็น${STAFF_ROLES.find((r) => r.id === a.role).name}แล้ว`, "levelup");
  save("จ้างคน");
}

function fireStaff(sh, idx) {
  const w = sh.staff[idx];
  if (!w) return;
  sh.staff.splice(idx, 1);
  toast(`👋 ให้ ${w.name} ออกแล้ว — ค่าจ้างกลับไปเป็นฐานเมื่อจ้างคนใหม่`, "warn");
  save("ไล่ออก");
}

function vetApplicant(sh, idx) {
  const a = sh.applicants[idx];
  if (!a || a.vetted) return;
  if (P.gold < SHOP_VETTING_COST) { toast(`ทองไม่พอ — ตรวจประวัติครั้งละ ${SHOP_VETTING_COST} 💰`, "warn"); return; }
  P.gold -= SHOP_VETTING_COST;
  a.vetted = true;
  toast(`🔍 ตรวจประวัติ ${a.name} แล้ว`, "", "money");
}

/* Materials from your own bag become shop stock. Priced by what the trader would pay, so shipping
 * a valuable item in is never a way to launder a cheap one — and it keeps every production line
 * useful to every shop without a per-shop input table to maintain. */
function shipToShop(sh, itemId, n) {
  const have = sellableCount(itemId);
  const qty = Math.max(0, Math.min(have, Math.floor(n)));
  if (!qty) return 0;
  const worth = (ITEMS[itemId].sell || 0) * qty;
  if (worth <= 0) { toast("ของชิ้นนี้ขายไม่ได้ ส่งเข้าร้านไม่ได้เหมือนกัน", "warn"); return 0; }
  P.inv[itemId] -= qty;
  if (P.inv[itemId] <= 0) delete P.inv[itemId];
  const raw = worth / SHOP_RAW_PER_GOLD;
  sh.raw += raw;
  toast(`📦 ส่ง ${ITEMS[itemId].icon} ${ITEMS[itemId].name} ×${qty} เข้าร้าน — วัตถุดิบ +${raw.toFixed(1)}`, "", "money");
  return raw;
}

/* One game-day for one shop. Mirrors simulate() in shop_sim.mjs exactly. */
function runShopDay(sh, date) {
  if (taxSeized()) return;   // seized for unpaid tax: this earns nothing until the bill is settled
  const t = shopType(sh.type);
  const tier = shopTier(sh);
  const gd = P.gameDays;

  sh.raw += shopStaffBy(sh, "hunter").reduce((a, w) => a + staffOutput(w, gd), 0);

  const canCraft = Math.min(sh.raw, shopStaffBy(sh, "crafter").reduce((a, w) => a + staffOutput(w, gd), 0));
  sh.raw -= canCraft;
  sh.goods += canCraft / t.rawPerGood;

  const sellers = shopStaffBy(sh, "seller");
  const charisma = sellers.length ? sellers.reduce((a, w) => a + w.charisma, 0) / sellers.length : 0;
  /* A season shifts both how many people come and what they will pay — the square root of the
     same factor on each side. Putting the whole swing on footfall made seasons vanish, because a
     busy season simply hit the shop's throughput ceiling and got clipped. */
  const swing = Math.sqrt(t.season[Math.floor((date.month - 1) / 3)] ?? 1);
  const customers = (t.base * tier.demand + sh.regulars) * swing
    * (0.70 + 0.40 * sh.rep)
    * Math.pow(sh.price, -1.35)
    * (0.7 + 0.5 * charisma);

  const capacity = sellers.reduce((a, w) => a + staffOutput(w, gd), 0);
  const sold = Math.min(customers, capacity, sh.goods);
  sh.goods -= sold;

  const tip = sh.rep > 0.75 ? 0.06 * (sh.rep - 0.75) / 0.25 : 0;
  const revenue = sold * t.goodValue * sh.price * swing * (1 + tip);

  const guards = shopStaffBy(sh, "guard").length;
  const guardCover = guards ? 1 - Math.pow(1 - SHOP_GUARD_COVER, guards) : 0;
  const theftRate = sh.staff.reduce((a, w) => a + staffTheft(w, gd), 0) * (1 - guardCover);
  const stolen = revenue * Math.min(0.95, theftRate);
  const wages = shopWagesPerDay(sh);

  const net = revenue - stolen - wages;
  /* no-goldBonus: the luck charm and rebirth karma reward hunting and stealing, not owning a
   * business — and scaling a shop's takings by them would inflate the taxable base they feed,
   * exactly as it would for dividends */
  P.gold += Math.round(net);
  bump("shopProfit", net);
  /* 🎯 [owner 2026-08-17] "พอได้เงินมา มันจะไปกองที่กระเป๋าเรา แล้วโดนภาษี ลองปรับจากกระเป๋านั้นแทน"
   * — a shop's takings are deliberately NOT income-taxed. They land in the pocket, and the pocket
   * is what the wealth tax reads. Taxing both would charge the same gold twice, and taxing the
   * income instead of the pile would punish earning rather than hoarding. */

  /* Reputation drifts toward what the shop deserves today. An empty shelf is the failure that
     really costs you; not enough staff to serve a crowd is a queue, worth a third as much; and
     unhappy staff visibly slack off, which customers notice. */
  const wanted = Math.min(customers, capacity);
  const stockShort = wanted > 0.05 ? Math.max(0, 1 - sold / wanted) : 0;
  const queueShort = customers > 0.05 ? Math.max(0, 1 - capacity / customers) : 0;
  const empty = customers <= 0.05 ? 0.8 : 0;
  const slack = sh.staff.length
    ? Math.max(0, 1 - sh.staff.reduce((a, w) => a + staffMorale(w, gd), 0) / sh.staff.length) : 0;
  const gouge = Math.max(0, sh.price - 1.0) * 0.9;
  const target = Math.max(0.05, Math.min(1, 1 - stockShort - 0.35 * queueShort - empty - gouge - 0.9 * slack));
  sh.rep += (target - sh.rep) * 0.03;
  /* Regulars move fifty times slower, which is where most of the punishment lives too: gouging or
     slacking drains the base over game-YEARS, so the number ticks down in front of the player
     instead of one bad month emptying the shop. */
  sh.regulars += (target * tier.regulars - sh.regulars) * SHOP_REGULARS_SPEED;
  P.brand = Math.max(P.brand || 0, sh.regulars);

  sh.ledger.revenue += revenue; sh.ledger.wages += wages;
  sh.ledger.theft += stolen; sh.ledger.days++;
  sh.lastNet = net; sh.lastSold = sold; sh.lastCustomers = customers;
}

function runShopsDay(date) {
  if (!P.shops?.length) return;
  let total = 0;
  for (const sh of P.shops) { runShopDay(sh, date); total += sh.lastNet || 0; }
  /* 🐛 [owner 2026-08-22: "ธุรกิจของเราที่สร้าง ก็ต้องเห็นรายได้ในบัญชีด้วย"] One line for the day's
   * trading, not one per shop — a chain of six would otherwise fill the whole panel every day and
   * bury everything else, which is the complaint that moved family upkeep to a monthly line. A loss
   * is recorded the same way a profit is: a business that costs you money is exactly what the
   * ledger should be able to tell you. */
  if (Math.abs(total) >= 1) {
    const n = Math.round(total);
    ledger("🏪", `${n >= 0 ? "กำไร" : "ขาดทุน"}ร้านค้า ${P.shops.length} ร้าน`, n);
    toast(`${total >= 0 ? "🏪 กำไรร้านค้า" : "🏪 ขาดทุนร้านค้า"} ${Math.abs(n).toLocaleString()} 💰`,
          total >= 0 ? "" : "warn", "money");
  }
}

/* ---------- Rebirth (จุติ) ----------
 * Keeps achievements, keeps the whole bag, reduces the three combat stats to REBIRTH_KEEP — and never drops a
 * stat below what the PREVIOUS rebirth left behind (owner's rule: a quick rebirth that would
 * compute a lower number keeps the last rebirth's value instead). That floor only ever rises,
 * so rebirthing early can waste progress but can never set you back. */

function rebirthPreview() {
  const out = {};
  for (const st of COMBAT_STATS) {
    const cur = statLevel(st.id);
    /* Reduce the level WITH its progress, not the whole number — at REBIRTH_KEEP a level 33 becomes
     * 29.7, which is level 29 carrying seven tenths of the next one, not a bare 29. `kept` is the
     * displayed integer; `xpAfter` is what actually gets stored, and it is the only place the
     * leftover survives. The owner asked for exactly this: "หากเป็นเศษ ให้แปลงเป็น exp ที่เหลือ". */
    const exactAfter = levelExactFromXp(P.cb[st.id] || 0) * REBIRTH_KEEP;
    const kept = Math.floor(exactAfter);
    const floor = (P.rebirthFloor || {})[st.id] || 1;
    const after = Math.max(1, kept, floor);
    out[st.id] = { cur, kept, halved: kept, floor, after, floored: floor > kept,
                   /* A floor that lifts the level also lifts the XP to that level's start: the
                    * leftover belongs to the halved figure, not to a number handed back by the
                    * floor rule. */
                   xpAfter: after > kept ? xpToReach(after) : xpAtExactLevel(exactAfter) };
  }
  return out;
}

/* 🐛 [owner 2026-08-23: "รู้สึกว่า pet ของลูกหลังจุติโดน reset ขั้น 1 มันผิด มันควรหารครึ่ง"]
 *
 * Each rebirth halved correctly — measured 4 → 2 on his own save. What was missing is the FLOOR the
 * child itself has had since "จุติเร็วเกินไปไม่ทำให้สเตตัสต่ำลง": a child never drops below half its
 * best-ever level, so it settles. Its companion had no such rule, so halving compounded — a level-32
 * pet beside a level-32 child went 16, 8, 4, 2, 1 across five rebirths while the child stopped at
 * 16. Correct arithmetic each time, and a reset in effect.
 *
 * One function for the player's kept companion and for a child's, because the owner's rule for the
 * child's pet is that it matches the player's ("ค่าจะเหมือน pet เราที่โดนหารครึ่ง") and two copies
 * would drift the moment either is retuned. */
function petRebirthReduce(pet) {
  if (!pet) return;
  const wasLv = petLevel(pet);
  pet.lvFloor = Math.max(pet.lvFloor || 1, Math.floor(wasLv * REBIRTH_KEEP));
  const kept = petXpAtExact(petLevelExact(pet) * REBIRTH_KEEP);
  const floorXp = petXpToReach(Math.max(1, Math.min(PET_MAX_LEVEL, pet.lvFloor)));
  pet.xp = Math.max(kept, floorXp);
  pet.hp = petStats(pet).maxHp;          // read AFTER the xp change, or it heals to the old cap
}

/* The pet a rebirth would carry over, or null. Read by the rebirth screen as well as by doRebirth,
 * so what the preview promises and what happens cannot drift apart. */
function petRebirthKeeper() {
  const pet = activePet();
  if (!pet) return null;
  const st = petStats(pet);
  if (!petGradeAtLeast(st.grade.cls, PET_REBIRTH_MIN_GRADE)) return null;
  return pet;
}

function rebirthGate() { return rebirthGateFor(P.rebirths || 0); }
function canRebirth() { return combatLevel() >= rebirthGate(); }

/* 🐛 [found by the owner, 2026-08-18, re-reading the rebirth page: "จุติไม่หายนิ เพราะมี การเน้น
 * เรื่องเก็บภาษีแทน"] Shares, shops, and property stopped disappearing on rebirth back on
 * 2026-08-17 (doRebirth() only ever touches P.gold), but this confirm dialog was never updated to
 * match — it told the player their whole portfolio was about to be destroyed and to sell it first,
 * which was actively wrong advice at the one moment a player cannot take it back. Same bug shape
 * for pets: it said EVERY pet would be released, when a qualifying fielded companion survives
 * (halved) — see petRebirthKeeper(), the same check the summary box on the page already uses.
 *
 * Pulled out of the button's onclick so it can be read back and asserted on directly — the bug
 * above lived in a string nothing outside a live click could ever inspect. */
function rebirthConfirmMessage(pv) {
  const after = COMBAT_STATS.map((st) => `${st.name} ${pv[st.id].cur}→${pv[st.id].after}`).join(", ");
  const keeper = petRebirthKeeper();
  const releasedCount = P.pets.length - (keeper ? 1 : 0);
  const pets = releasedCount > 0
    ? `\n\n🐾 สัตว์เลี้ยง ${releasedCount} ตัวจะถูกปล่อยคืนธรรมชาติ และต้องหาใหม่`
      + (keeper ? ` (${petStats(keeper).icon} ${petStats(keeper).name} จะไปด้วย)` : "")
    : keeper ? `\n\n🐾 ${petStats(keeper).icon} ${petStats(keeper).name} จะไปด้วย` : "";
  /* Only gold sitting loose in the pocket is actually destroyed. Shares, shops, property and the
   * bank all come along — this is the one thing worth spelling out before a single click. */
  const cash = Math.floor(P.gold || 0);
  const atRisk = cash > 0 ? `\n\n⚠️ จะหายไปทันที: ทองในมือ ${fmtNum(cash)} — ฝากธนาคารก่อนจะเก็บไว้ได้ทั้งหมด` : "";
  const kg = karmaGainFor(combatLevel(), P.rebirths || 0);
  /* 🎯 [owner 2026-08-30] Now that the year in progress is assessed on the way out, the player has
   * to be told BEFORE the click — a bill that appears in a new life unannounced reads as a bug,
   * which is precisely how the opposite behaviour was reported. */
  const owed = taxOwedTotal() + taxAccruedTotal();
  const tax = owed > 0
    ? `\n\n🧾 ภาษีค้าง ${fmtNum(owed)} จะตามไปชาติหน้า — จุติหนีภาษีไม่ได้` : "";
  return `ยืนยันการจุติ?\n\n${after}${pets}${atRisk}${tax}`
    + `\n\n🌀 ได้บุญ +${(kg.xp * 100).toFixed(1)}% XP · +${(kg.gold * 100).toFixed(1)}% ทอง`
    + ` (จากเลเวลรวม ${combatLevel()})`
    + `\n\nติดตัวไปแน่นอน: ความสำเร็จ · ของในกระเป๋า · เลเวลอาชีพทุกสาย · หุ้น · ร้านค้า · อสังหา · กิลด์`
    + ` · เงินฝากในธนาคาร ${fmtNum(Math.floor(bankBalance()))}`;
}

function doRebirth() {
  if (!canRebirth()) { toast(`ต้องถึงเลเวลรวม ${rebirthGate()} ก่อนจึงจะจุติได้`, "warn"); return; }
  /* 🐛 [fixed 2026-08-17, found in the owner's own save] Karma was banked from combatLevel() read
   * AFTER the loop below had already halved every stat, so a run was paid for the level it was
   * knocked down TO instead of the level it reached. The owner rebirthed at 21 and was credited as
   * 10 — 0.25% instead of 1.10%, four times short — which is most of why the reward for a whole
   * run felt like nothing. The comment further down always claimed it used "the level this run
   * actually reached"; it just read the number one line too late. Take it before anything moves. */
  const reachedLevel = combatLevel();
  const preview = rebirthPreview();
  const before = {}, after = {};
  for (const st of COMBAT_STATS) {
    before[st.id] = preview[st.id].cur;
    after[st.id] = preview[st.id].after;
    P.cb[st.id] = preview[st.id].xpAfter;   // carries the leftover half of an odd level
    P.rebirthFloor[st.id] = preview[st.id].after;
  }
  /* What a rebirth actually takes (owner's rules, 2026-08-17).
   *
   * SAVINGS ARE THE INHERITANCE. Money in the bank survives untouched — a rebirth should leave
   * something to the next life. Everything else on the money side does not: coins in your pocket,
   * every share you hold, and (when they exist) the businesses themselves. So a rebirth is a
   * planned event rather than a button: liquidate, deposit, then go. Leaving wealth outside the
   * bank is how you lose it.
   *
   * The deposit clock restarts, though. You inherit the money, not the relationship — and the
   * bank's rate is built on years untouched, so a fresh life starts at the opening rate.
   *
   * Tax debt deliberately survives all of this. Rebirth must never be a way to walk away from the
   * three-month countdown; that would make the whole tax system optional.
   *
   * Companions do not follow you through either. The species record survives in P.seenPets. */
  /* 🐛 [fixed 2026-08-17] `P.gold = 0` cleared a DEBT as readily as it confiscated a fortune, and
   * taxGraceCheck reads "gold >= 0" as "settled" — so rebirth was the exit from the three-month
   * countdown that the note above says must not exist. Debt is not a possession; you cannot lose it
   * by starting a new life. Only gold in hand is taken, and only when there is some. */
  /* 🎯 [owner 2026-08-17] "คิดว่าเปลี่ยนระบบ ไม่หายตอนจุติ ทั้งธุรกิจตัวเอง บ้าน กิจการเล็ก กลาง ใหญ่
   * แต่มีข้อเสียคือ จุติหนีภาษีไม่ได้"
   *
   * Shares stay now, alongside the shops and the property that already did. What a rebirth still
   * takes is the gold in your pocket — a life's loose change — and what it can no longer do is
   * outrun a tax bill: the bills follow you, because the wealth that raised them does. */
  const lostGold = Math.max(0, Math.floor(P.gold || 0));
  P.gold = Math.min(0, P.gold || 0);
  /* 🐛 [owner 2026-08-30: "ถ้ามีภาษีค้าง แล้วจุติ หนี้ภาษีหาย มันไม่ควรโดนล้าง"] Measured on his own
   * save: ~12,000 accrued, gone the moment he rebirthed. The note below was true about BILLS and
   * blind to the year in progress — "ปีนี้สะสมถึงวันนี้" on the tax page is taxAccruedTotal(), which
   * is DERIVED from yearProfit and yearRent, so zeroing those two counters erased the liability
   * itself rather than carrying it. That is exactly the escape hatch he closed in August
   * ("จุติหนีภาษีไม่ได้") reopened by a different door.
   *
   * So the life that is ending is assessed on its way out, the same way a year end assesses: what
   * it accrued becomes a real dated bill, and only THEN do the counters reset. The new life starts
   * on zero without the old one going untaxed, and nothing is charged twice. Runs before the clock
   * shift on purpose — the bill is dated in the calendar that raised it, and re-anchored with every
   * other absolute day below. */
  assessTaxOnRebirth();
  /* 🎯 [owner 2026-08-17] "เพิ่งกด จุติ เวลาควรเริ่มต้นใหม่ แต่ หากดอกยังฝากอยู่ มันต้องเดินต่อได้."
   * A new life gets its own calendar — year 1, day 1 — but every value that stored an ABSOLUTE day
   * has to be re-anchored against the new zero or it breaks quietly. Left alone, the bank would
   * compute a negative holding period, an unpaid tax bill would have its three-month countdown
   * handed back to it, and shop staff would read as hired in the future. */
  const clockShift = P.gameDays;
  P.gameDays = 0;
  P.calendarReset = true;   // so the one-off repair migration never re-fires on this save
  /* The deposit itself carries over and keeps earning; only the rate tier restarts, which is the
   * existing rule for touching the account at all — you inherit the money, not the relationship. */
  if (P.bank) P.bank.sinceDay = 0;
  /* Elapsed grace is preserved deliberately: rebirth must not be a way to buy three fresh months. */
  if (P.tax?.debtSinceDay != null) P.tax.debtSinceDay -= clockShift;
  /* 🐛 [same report] debtSinceDay was re-anchored and `assessedDay` was not — and assessedDay is
   * the one the current tax system actually reads. taxOverdueDays() is `floor(P.gameDays) -
   * assessedDay`, so a rebirth dropped gameDays to 0 and handed every unpaid bill a large NEGATIVE
   * age: no late interest, no seizure at 30 days, no game over at 90, for as many days as the old
   * life had lasted. The line above says elapsed grace is preserved deliberately; this is what
   * makes that true of the bills as well as of the legacy counter.
   * Shifted by the FLOOR of clockShift rather than by clockShift itself, which is not a rounding
   * detail: assessedDay is an integer day and the tax card counts against it with
   * `Math.floor(P.gameDays) - b.assessedDay`. Subtracting the fractional live clock would leave
   * every carried bill reporting "ค้างมา 0.4 วัน" for the rest of the run — and because P.gameDays
   * is exactly clockShift at this point, the floor preserves the bill's age to the day. */
  const dayShift = Math.floor(clockShift);
  for (const b of P.tax?.bills || []) b.assessedDay -= dayShift;
  if (P.tax?.seizeNotedDay != null) P.tax.seizeNotedDay -= dayShift;

    /* 🐛 [owner 2026-08-22: "ภารกิจ 3 ตัวล่าง cool down นาน ไม่ยอมเปลี่ยนภารกิจให้"] Quests expire by
     * absolute day — `until = day + QUEST_DAYS` — and the calendar restarting at 0 left every board
     * entry from the previous life dated past day 360. refreshQuests only drops a quest once
     * `until <= today`, so those sat there permanently advertising "เหลือ 353 วัน", and their
     * villagers could never be given a new job. Only the ones that happened to expire before the
     * rebirth were replaced, which is why it looked like three specific people were stuck.
     *
     * Shifted rather than cleared, so a job already half-collected is not confiscated by a decision
     * about a different system — and anything that would land in the past expires today and is
     * reissued by the next refresh. */
    for (const q of P.quests || []) {
      q.until = Math.max(0, (q.until || 0) - clockShift);
      if (q.day != null) q.day = Math.max(0, q.day - clockShift);
    }
  /* 🐛 [fixed 2026-08-17, owner: "ยอดกำไรสุทธิ ผิด"] The calendar restarts here but the tax
   * accumulator did not, so "กำไรลงทุนปีที่ 1" showed a figure earned in a life that no longer
   * exists — and the next year-end would bill it against the savings, which is the one thing
   * rebirth lets you keep. The gold and shares that profit was made on are confiscated a few lines
   * below; taxing their gains afterwards charges twice for the same run. New calendar, new ledger.
   * A debt already owed is NOT cleared — that is the grace period above, and it still stands.
   *
   * The reset itself moved into assessTaxOnRebirth() at the top of this function: the counters may
   * only be cleared once what they owe has been written down as a bill, and doing both in one place
   * is what stops the two halves drifting apart again. */
  if (P.bank) P.bank.yearInterest = 0;   // the year it belonged to no longer exists
  /* Staff keep the seniority and loyalty they earned — the business did not start over. */
  for (const sh of P.shops || []) for (const w of sh.staff || []) w.hiredDay -= clockShift;
  /* The companion you were fielding comes with you if it earned the right to, and it is reduced the
   * same way you are — a rebirth for it too, not a free ride. Everything else is released. */
  const keeper = petRebirthKeeper();
  const released = P.pets.length - (keeper ? 1 : 0);
  let keptPet = null;
  if (keeper) {
    const wasLv = petLevel(keeper);
    petRebirthReduce(keeper);              // the fractional level survives as XP; a floor stops the decay
    keptPet = { st: petStats(keeper), wasLv };
    P.pets = [keeper];
    P.activePet = 0;
  } else {
    P.pets = [];
    P.activePet = null;
  }
  /* Karma is banked from the level this run actually reached, BEFORE the counter moves — the gain
   * is measured against the gate you cleared, not the higher one the next run will face. */
  const gain = karmaGainFor(reachedLevel, P.rebirths || 0);
  before.__lvl = reachedLevel;
  P.karma = P.karma || { xp: 0, gold: 0 };
  P.karma.xp += gain.xp;
  P.karma.gold += gain.gold;
  relRebirth();          // halve affection, keep the floor, undo the marriage — see relRebirth
  childrenRebirth();     // and the children go with it, education included — see childrenRebirth
  P.rebirths = (P.rebirths || 0) + 1;
  const d = today();
  P.rebirthLog = P.rebirthLog || [];
  P.rebirthLog.unshift({ year: d.year, month: d.month, day: d.day, before, after });
  P.rebirthLog = P.rebirthLog.slice(0, 20);
  // Combat stops: the fighter who walked in is not the one walking out.
  const cs = combatSlot();
  if (cs >= 0) stopSlot(cs);
  P.hp = maxHp();
  save("จุติ");
  toast(`🌀 จุติครั้งที่ ${P.rebirths} — ${dateLabel(d)}`, "levelup");
  if (released) toast(`🐾 ปล่อยสัตว์เลี้ยง ${released} ตัวคืนธรรมชาติ — รอบใหม่ต้องออกตามหาใหม่`, "warn");
  if (keptPet) {
    toast(`${keptPet.st.icon} ${keptPet.st.name} (${keptPet.st.grade.name}) จุติตามมาด้วย — `
          + `ขั้น ${keptPet.wasLv} → ${keptPet.st.lv}`, "levelup");
  }
  if (lostGold) toast(`💸 ทองในมือ ${fmtNum(lostGold)} หายไปกับชาติก่อน`, "warn");
  const kept = Math.round(portfolioValue()) + (P.shops || []).length + (P.estates || []).length;
  if (kept) {
    toast(`🏛️ ธุรกิจ หุ้น และอสังหาติดตัวมาด้วยทั้งหมด — และภาษีของมันก็ตามมาด้วย`, "levelup");
  }
  if (bankBalance() > 0) {
    toast(`🏦 เงินฝาก ${fmtNum(Math.floor(bankBalance()))} ติดตัวมาด้วย — ดอกเบี้ยเดินต่อ แต่เรทเริ่มนับใหม่`, "levelup");
  }
  toast(`📅 ปฏิทินเริ่มใหม่ที่ปีที่ 1 — ชีวิตใหม่มีเวลาของตัวเอง`, "levelup");
  toast(`🌀 ได้บุญ +${(gain.xp * 100).toFixed(1)}% XP · +${(gain.gold * 100).toFixed(1)}% ทอง จากเลเวลรวม ${before.__lvl}`, "levelup");
  toast(`บุญเก่าสะสม: XP ทุกสาย +${(karmaXp() * 100).toFixed(1)}% · ทอง +${(karmaGold() * 100).toFixed(1)}%`, "levelup");
  renderView();
  refreshSidebar();
  updateTopbar();
}

/* 🎯 [my addition, 2026-08-17 — owner did not specify a reward] Rebirth as described keeps
 * achievements, the bag and a stat floor, but costs half your combat levels: strictly a loss,
 * so nobody would ever press the button. Each rebirth therefore leaves "บุญเก่า" behind — a
 * small permanent multiplier that makes the next run faster than the last, which is what turns
 * a reset into a choice. Tune or remove freely; nothing else depends on these two numbers. */
function karmaXp() { return Math.min(KARMA_CAP, P.karma?.xp || 0); }
function karmaGold() { return Math.min(KARMA_CAP, P.karma?.gold || 0); }

/* ---------- Money: bank, market, dividends, tax ----------
 * Everything here is scheduled off the in-game calendar (onNewDay), never off the wall clock, so
 * a closed browser genuinely pauses the economy the way it pauses everything else.
 *
 * One rule holds the whole system together: only INVESTMENT profit is taxed. Dividends, realised
 * trading gains and bank interest feed P.tax.yearProfit; gold from hunting, crafting and selling
 * loot never does. That is what makes passive income a real decision instead of a free ride. */

function ledger(icon, text, amount) {
  P.ledger = P.ledger || [];
  const d = today();
  P.ledger.unshift({ icon, text, amount, y: d.year, m: d.month, dd: d.day });
  P.ledger = P.ledger.slice(0, 60);
}

/* The single door rent walks through, so the rent-income tax cannot be dodged by a path that
   forgets to report — the same reasoning as bookInvestmentProfit below. */
function bookRentIncome(amount) {
  P.tax = P.tax || { yearProfit: 0, paidTotal: 0, debtSinceDay: null, lastBill: null };
  P.tax.yearRent = (P.tax.yearRent || 0) + amount;
}

/* The single door investment income walks through — so nothing can earn untaxed by accident. */
function bookInvestmentProfit(amount) {
  P.tax = P.tax || { yearProfit: 0, paidTotal: 0, debtSinceDay: null, lastBill: null };
  P.tax.yearProfit += amount;
}

/* --- bank --- */
/* 🎯 [owner 2026-08-17] "แยกเงินตอนฝาก แบ่งเป็นการ์ด เพื่อเก็บระยะเวลา ไม่งั้นระยะเวลาจะปนกัน ... First
 * In > Last Out"
 *
 * One balance with one clock had an exploit in it, and the owner found it: leave 1 gold sitting for
 * three years to climb the ladder, then deposit ten million and every coin of it earns the top rate
 * from the first day, because depositing deliberately does not reset the clock. The account's age
 * and the account's money were two different things pretending to be one.
 *
 * Each deposit is its own slip with its own start day and its own rate. Withdrawals eat the NEWEST
 * slip first, so the oldest money — the money that climbed the ladder — is the last to be touched.
 * That is the owner's rule and it is also the kind thing to do: dipping into savings should cost
 * you the least seniority available, not the most.
 *
 * Deposits made on the same game-day merge, or a habit of pressing the button twice would bury the
 * page in slips worth a gold each. */
function bankSlips() {
  if (!P.bank) return [];
  if (!P.bank.slips) P.bank.slips = [];
  return P.bank.slips;
}
function bankBalance() { return bankSlips().reduce((t, sl) => t + sl.amount, 0); }
/* 🎯 [owner 2026-08-17] "มันจะรันไปเรื่อยๆ ไม่มีสิ้นสุด ดังนั้นต้องมีการ reset จัดเรียงสลิป ทุกครั้งที่
 * ยอดเป็น 0 หรือทุกปีใหม่"
 *
 * Left alone the stack only grows: one slip per day you ever deposited, forever. Two kinds are
 * safe to remove without touching anyone's seniority:
 *
 *   - an emptied slip is nothing but a date, and
 *   - a slip that has reached BANK_MAX_RATE can no longer climb, so its age has stopped meaning
 *     anything and it can merge with the other slips that have also stopped climbing.
 *
 * Merging anything still climbing would be theft: two slips at different ages have different
 * futures, and the merged one would have to take the younger date. So they are left alone. */
function bankTidySlips() {
  const slips = bankSlips();
  for (let i = slips.length - 1; i >= 0; i--) if (Math.floor(slips[i].amount) <= 0) slips.splice(i, 1);
  const capped = slips.filter((sl) => slipRate(sl) >= BANK_MAX_RATE);
  if (capped.length > 1) {
    // Oldest wins the date; every one of them is at the ceiling, so nothing gains or loses a rate.
    const keep = capped.reduce((a, b) => (a.sinceDay <= b.sinceDay ? a : b));
    for (const sl of capped) {
      if (sl === keep) continue;
      keep.amount += sl.amount;
      slips.splice(slips.indexOf(sl), 1);
    }
  }
  slips.sort((a, b) => a.sinceDay - b.sinceDay);   // oldest first: the order withdrawals reverse
}
function slipYears(sl) { return Math.max(0, (P.gameDays - (sl.sinceDay || 0)) / DAYS_PER_YEAR); }
function slipRate(sl) { return bankRate(slipYears(sl)); }


/* The account's headline age is its OLDEST slip — the seniority a withdrawal is protecting. */
function bankYearsHeld() {
  const slips = bankSlips();
  if (!slips.length) return 0;
  return Math.max(...slips.map(slipYears));
}
function bankCurrentRate() { return bankRate(bankYearsHeld()); }

function bankAccrue() {
  if (!P.bank) return;
  /* 🎯 [owner 2026-08-17] "ให้ปรับเป็นจ่ายทุกวันแทน ไม่ต้องสะสมจ่ายปีละสองครั้ง" — paid straight onto
   * the slip it belongs to, every game-day. The twice-a-year model was tried and set aside: it made
   * the number arrive in a lump, but it also meant a balance that sat still for months and interest
   * that could be stranded by a withdrawal. Each slip still compounds separately, at its own rate. */
  let interest = 0;
  for (const sl of bankSlips()) {
    const add = sl.amount * (slipRate(sl) / DAYS_PER_YEAR);
    sl.amount += add;
    interest += add;
  }
  if (interest < 0.01) return;
  bookInvestmentProfit(interest);
  bump("bankInterest", interest);
  /* 🎯 [owner 2026-08-17] "ดอกเบี้ยธนาคาร ดูยาก" — interest lands inside กำไรลงทุนปีนี้ together with
   * dividends and realised gains, and unlike those two it never appears in the ledger, so there was
   * no way to see how much of that figure it was. This is the per-YEAR total; stats.bankInterest
   * stays the career one. */
  P.bank.yearInterest = (P.bank.yearInterest || 0) + interest;
}

function bankDeposit(amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return;
  if (P.gold < amount) { toast("ทองไม่พอฝาก", "warn"); return; }
  P.gold -= amount;
  /* A new slip with today's date. Adding money never lifts older money up the ladder and never
   * drags it back down — the two simply do not touch, which is the whole point of splitting them. */
  const slips = bankSlips();
  const today0 = Math.floor(P.gameDays);
  const same = slips.find((sl) => Math.floor(sl.sinceDay) === today0);
  if (same) same.amount += amount;
  else slips.push({ sinceDay: P.gameDays, amount, pending: 0 });
  ledger("🏦", `ฝากธนาคาร`, -amount);
  toast(`🏦 ฝาก ${amount.toLocaleString()} 💰 · ใบฝากใหม่ เริ่มที่ ${(BANK_BASE_RATE * 100).toFixed(1)}%/ปี`);
  renderView(); updateTopbar();
}

function bankWithdraw(amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return;
  const have = Math.floor(bankBalance());
  if (amount > have) { toast("ยอดในบัญชีไม่พอ", "warn"); return; }
  /* 🎯 First in, LAST out. Eat the newest slips first so the oldest money — the money that spent
   * years climbing the ladder — is the last thing touched. A slip emptied this way settles the
   * interest it had accrued rather than losing it, since payouts only come twice a year. */
  let left = amount, closed = 0;
  const slips = bankSlips();
  for (let i = slips.length - 1; i >= 0 && left > 0; i--) {
    const sl = slips[i];
    const take = Math.min(sl.amount, left);
    sl.amount -= take;
    left -= take;
    if (Math.floor(sl.amount) <= 0) { slips.splice(i, 1); closed++; }
  }
  bankTidySlips();   // an account drained to nothing starts its next deposit from a clean stack
  /* no-goldBonus: your own savings coming back, not gold earned in the world */
  P.gold += amount;
  ledger("🏦", `ถอนจากธนาคาร`, amount);
  toast(`🏦 ถอน ${amount.toLocaleString()} 💰${closed ? ` · ปิดใบฝาก ${closed} ใบ` : ""}`
        + ` · ใบเก่าที่เหลือยังนับเวลาต่อ`, "warn");
  renderView(); updateTopbar();
}

/* --- market --- */
function findCompany(id) { return COMPANIES.find((c) => c.id === id); }
function sharePrice(id) {
  /* An unknown id is worth nothing rather than a crash. A holding can outlive its company across
   * an update, and this is read from the money page, the ledger and doRebirth — one stale entry
   * used to take all three down with a TypeError. */
  const c = findCompany(id);
  if (!c) return 0;
  const px = (P.market || {})[id];
  return px == null ? c.base : px;
}
function heldShares(id) { return (P.holdings?.[id]?.shares) || 0; }
function isOwner(id) { return heldShares(id) >= SHARES_PER_COMPANY; }
function portfolioValue() {
  return Object.keys(P.holdings || {}).reduce((t, id) => t + heldShares(id) * sharePrice(id), 0);
}

/* --- crypto ---------------------------------------------------------------------------
 * 🎯 [owner 2026-08-23] "ไม่มีปันผล เลยต้องให้เน้นการเก็งกำไรการลงทุน หมวดนี้จะนับเป็นยอดขายของการ
 * ลงทุน" — the whole instrument is the price. There is no payDividends equivalent here and there
 * must never be one, or it becomes a worse version of the share market.
 *
 * Cost basis is tracked per coin as a running average, because that is what makes a SALE report a
 * real gain or loss. Buying more at a different price moves the average rather than resetting it;
 * without that, selling half a position at a profit and half at a loss could be made to look like
 * two profits by choosing the order. */
/* 🎯 [owner 2026-08-23] "ที่มันบ่งบอกความต่างของ % มีสัญลักษณ์ เขียว แดง ด้วย" — one place that
 * turns a ratio into a coloured percentage, so every figure on the page reads the same way and a
 * new one cannot invent its own scale. Dead flat is dim rather than green: nothing has happened,
 * and calling that good is how a page starts lying gently. */
function pctTag(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return "";
  const pct = (ratio - 1) * 100;
  const cls = pct > 0.5 ? "good" : pct < -0.5 ? "bad" : "dim";
  const arrow = pct > 0.5 ? "▲" : pct < -0.5 ? "▼" : "▬";
  const n = Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1);
  return `<span class="pct ${cls}">${arrow} ${n}%</span>`;
}
/* Prices span 5 to 2,844, so a fixed number of decimals is wrong at one end or the other. */
function money(n) { return n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString(); }

function findCoin(id) { return CRYPTOS.find((c) => c.id === id); }
function coinPrice(id) {
  const c = findCoin(id);
  if (!c) return 0;
  const px = (P.crypto || {})[id];
  return px == null ? c.base : px;
}
function coinHeld(id) { return (P.coins?.[id]?.units) || 0; }
function coinCost(id) { return (P.coins?.[id]?.cost) || 0; }   // average paid per unit
function cryptoValue() {
  return Object.keys(P.coins || {}).reduce((t, id) => t + coinHeld(id) * coinPrice(id), 0);
}

/* One day's move. Same shape as marketTick — a shock plus a pull back toward base, applied to the
 * LOG distance so the pull is symmetric up and down — but each coin carries its own two dials, so
 * fifty of them behave like fifty different things rather than one thing fifty times. */
function cryptoTick() {
  P.crypto = P.crypto || {};
  for (const c of CRYPTOS) {
    const px = coinPrice(c.id);
    const shock = (Math.random() * 2 - 1) * c.vol;
    const pull = (c.base - px) / c.base * c.rev;
    const next = px * (1 + shock) + c.base * pull;
    P.crypto[c.id] = Math.min(c.base * CRYPTO_CEIL, Math.max(c.base * CRYPTO_FLOOR, next));
  }
}

function buyCoin(id, units) {
  const c = findCoin(id);
  units = Math.floor(units);
  if (!c || units <= 0) return;
  const room = CRYPTO_MAX_UNITS - coinHeld(id);
  units = Math.min(units, room);
  if (units <= 0) { toast(`ถือ ${c.name} เต็มเพดานแล้ว`, "warn"); return; }
  const px = coinPrice(id);
  const cost = Math.ceil(px * units);
  if (P.gold < cost) { toast(T("ทองไม่พอ"), "warn"); return; }
  P.gold -= cost;
  P.coins = P.coins || {};
  const held = coinHeld(id), paid = coinCost(id) * held;
  P.coins[id] = { units: held + units, cost: (paid + cost) / (held + units) };
  ledger("🪙", `${T("ซื้อ")} ${c.name} ×${units.toLocaleString()}`, -cost);
  toast(`${c.icon} ${T("ซื้อ")} ${c.name} ×${units.toLocaleString()} — ${cost.toLocaleString()} 💰`, "", "money");
  renderView(); updateTopbar();
}

function sellCoin(id, units) {
  const c = findCoin(id);
  units = Math.min(Math.floor(units), coinHeld(id));
  if (!c || units <= 0) return;
  const px = coinPrice(id);
  const got = Math.floor(px * units);
  const basis = coinCost(id) * units;
  /* no-goldBonus: this is a liquidation at market price, not gold FOUND. Paying a gold perk on it
     would make a buy-then-sell round trip profitable by the size of the perk alone — an infinite
     money printer that needs no market movement at all. Same rule as selling shares and property. */
  P.gold += got;
  const left = coinHeld(id) - units;
  if (left > 0) P.coins[id] = { units: left, cost: coinCost(id) };   // average survives a part sale
  else delete P.coins[id];
  /* 🎯 "หมวดนี้จะนับเป็นยอดขายของการลงทุน" — only the GAIN is income, and only when realised.
     A loss reduces the year's taxable profit, which is what makes speculation a real risk rather
     than a one-way bet against the tax office. */
  const gain = Math.round(got - basis);
  if (gain !== 0) bookInvestmentProfit(gain);
  if (got > 0) bump("goldEarned", got);
  ledger("🪙", `${T("ขาย")} ${c.name} ×${units.toLocaleString()}`
    + ` (${gain >= 0 ? "+" : ""}${Math.round(gain).toLocaleString()})`, got);
  toast(`${c.icon} ${T("ขาย")} ${c.name} ×${units.toLocaleString()} — ${got.toLocaleString()} 💰`
    + ` · ${gain >= 0 ? T("กำไร") : T("ขาดทุน")} ${Math.abs(Math.round(gain)).toLocaleString()}`,
    gain >= 0 ? "" : "warn", "money");
  renderView(); updateTopbar();
}

/* Prices random-walk but are pulled back toward `base` every day, so a company never drifts to
 * zero or to the moon — the profitable move is buying a dip and selling a spike, not holding and
 * hoping. Reversion is applied to the LOG distance so the pull is symmetric up and down. */
function marketTick() {
  P.market = P.market || {};
  for (const c of COMPANIES) {
    const px = sharePrice(c.id);
    const shock = (Math.random() * 2 - 1) * c.vol;
    const pull = (c.base - px) / c.base * MARKET_REVERSION;
    const next = px * (1 + shock) + c.base * pull;
    P.market[c.id] = Math.min(c.base * MARKET_CEIL, Math.max(c.base * MARKET_FLOOR, next));
  }
}

function payDividends(date) {
  if (taxSeized()) return;   // seized for unpaid tax: this earns nothing until the bill is settled
  let total = 0;
  let payers = 0;
  for (const c of COMPANIES) {
    const shares = heldShares(c.id);
    if (!shares || date.totalDays % c.divDays !== 0) continue;
    // Paid on the company's fundamentals (base), not on today's price — a dividend should not
    // swing with the market's mood.
    const gross = shares * c.base * c.yield * (c.divDays / DAYS_PER_YEAR)
      * (isOwner(c.id) ? 1 + OWNER_DIVIDEND_BONUS : 1);
    /* 🐛 Rounding used to eat anything under half a gold, which was harmless while the fastest
     * payer ran every 15 days and became a silent theft the moment daily payers existed: one
     * share of a 12-gold shop earns 0.012/day, rounds to nothing, and pays literally forever
     * without ever crediting a coin. The remainder is banked per company instead, so a frequent
     * payer really does add up ("ยิ่งถี่ ได้ทีละน้อย แต่รวมแล้วเยอะ"). */
    P.divAccrual = P.divAccrual || {};
    const pot = (P.divAccrual[c.id] || 0) + gross;
    const paid = Math.floor(pot);
    P.divAccrual[c.id] = pot - paid;
    if (paid <= 0) continue;
    total += paid;
    payers += 1;
  }
  if (!total) return;
  /* no-goldBonus: the luck charm and rebirth karma reward hunting and stealing, not owning
   * shares — letting them scale dividends would also inflate the taxable base they feed */
  P.gold += total;
  bookInvestmentProfit(total);
  bump("divPaid", total);
  /* 🎯 [owner 2026-08-23] "ในหน้าบัญชี จะมีปันผลรายวันเข้ามา ให้รวบรวมการปันผลให้ครบ แล้วแสดงเป็น
     รายเดือน เหมือนค่าเช่า" — the same call rent, upkeep and the children's work already got. A
     payer running daily wrote a line a day, and with several of them the account page was nothing
     but dividends. Banked here, posted once by onNewMonth. The TOAST still fires daily, so the
     money is visible as it lands; it is the permanent record that is monthly. */
  P.divMonth = P.divMonth || { gold: 0, days: 0, payers: 0 };
  P.divMonth.gold += total;
  P.divMonth.days += 1;
  P.divMonth.payers = Math.max(P.divMonth.payers, payers);
  /* 🎯 [owner 2026-08-22] "เคยเจอมันขึ้นเป็นสิบไอคอนเลย" — this printed one icon and amount per
   * paying company, so a diversified portfolio produced a toast nobody could read on a phone. What
   * the message is for is the total and where it came from; the per-company breakdown is already
   * written to the bank ledger, where it can be read at leisure instead of for four seconds while
   * something else is happening. */
  toast(`📈 ${T("รับปันผล")} ${total.toLocaleString()} 💰 ${T("จาก")} ${payers} ${T("การลงทุน")}`,
        "", "income");
  updateTopbar();
}

function buyShares(id, n) {
  const c = findCompany(id);
  n = Math.floor(n);
  const room = SHARES_PER_COMPANY - heldShares(id);
  n = Math.min(n, room);
  if (n <= 0) { toast("ถือครบ 100% แล้ว — เป็นเจ้าของเต็มตัว", "warn"); return; }
  const px = sharePrice(id);
  const cost = Math.ceil(n * px);
  if (P.gold < cost) { toast(`ทองไม่พอ — ต้องการ ${cost.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= cost;
  P.holdings[id] = P.holdings[id] || { shares: 0, cost: 0 };
  P.holdings[id].shares += n;
  P.holdings[id].cost += cost;
  ledger("🛒", `ซื้อ ${c.name} ${n}%`, -cost);
  toast(`🛒 ซื้อ ${c.icon} ${c.name} ${n}% ที่ ${Math.round(px).toLocaleString()}/หุ้น (-${cost.toLocaleString()} 💰)`);
  if (isOwner(id)) toast(`👑 คุณเป็นเจ้าของ ${c.name} เต็ม 100% — ปันผล +${Math.round(OWNER_DIVIDEND_BONUS * 100)}%`, "levelup");
  renderView(); updateTopbar();
}

function sellShares(id, n) {
  const c = findCompany(id);
  const h = P.holdings?.[id];
  n = Math.min(Math.floor(n), h?.shares || 0);
  if (n <= 0) { toast("ไม่มีหุ้นให้ขาย", "warn"); return; }
  const px = sharePrice(id);
  const proceeds = Math.floor(n * px);
  // Average cost, so selling part of a position realises a proportional share of the gain.
  const costOut = Math.round(h.cost * (n / h.shares));
  const gain = proceeds - costOut;
  h.shares -= n;
  h.cost -= costOut;
  if (h.shares <= 0) delete P.holdings[id];
  /* no-goldBonus: selling a holding returns capital; only the realised gain is income */
  P.gold += proceeds;
  if (gain > 0) bookInvestmentProfit(gain);   // only a REALISED gain is taxable
  bump("tradeProfit", gain);   // losses count too: this is a track record, not a tax figure
  ledger(gain >= 0 ? "💹" : "📉", `ขาย ${c.name} ${n}% (${gain >= 0 ? "กำไร" : "ขาดทุน"} ${Math.abs(gain).toLocaleString()})`, proceeds);
  toast(`${gain >= 0 ? "💹" : "📉"} ขาย ${c.icon} ${c.name} ${n}% ได้ ${proceeds.toLocaleString()} 💰 · ${gain >= 0 ? "กำไร" : "ขาดทุน"} ${Math.abs(gain).toLocaleString()}`,
        gain >= 0 ? "" : "warn");
  renderView(); updateTopbar();
}

/* --- tax --- */
/* 🎯 [owner 2026-08-17] Three kinds, assessed once a year, PAID BY HAND. The year end used to reach
 * into the pocket and then the bank on its own; now it hands over a bill and the player settles it
 * from the tax page. Ignoring one has teeth — see taxEnforce below — but it is a decision rather
 * than something that happens to you while you are looking elsewhere. */
/* 🎯 [owner 2026-08-23] Both bases are now year-to-date INCOME, so both are cumulative totals
 * that only grow — never a snapshot of what you happen to hold at the moment of asking. That is what
 * closes the dodge the old holdings taxes had (sell on the last day, buy back on the first) without
 * needing the daily-accrual machinery at all, which is why taxAccrueDay now has nothing to do. */
function taxBaseFor(kindId) {
  if (kindId === "business") return Math.round(P.tax?.yearProfit || 0);
  if (kindId === "estate") return Math.round(P.tax?.yearRent || 0);
  return 0;
}
/* 🎯 [owner 2026-08-17] "เมื่อเงินถึงกำหนด มันจะคิดเรทเฉลี่ยรายวันสะสม ทำให้เราสามารถจ่ายเงินก่อนได้
 * ไม่ต้องรอครบสิ้นปี ... ทำให้ผ่อนจ่ายรายวันได้ง่าย คุมเงินง่าย ไม่ต้องรอจ่ายก้อนโต"
 *
 * The year's liability is visible from the day you cross the threshold and can be paid at any
 * point. It is DERIVED, never accumulated into a counter: what is stored is only what you have
 * already paid toward this year. A running total that is recomputed cannot drift from the figure
 * the year end will charge, and it needs no repair when a rate or a threshold changes.
 *
 * Money and property are charged on what you HOLD, so their year-to-date share is prorated by how
 * much of the year has passed — holding 200m for half a year owes half. Business income is charged
 * on what you have MADE so far, which is already a year-to-date number, so it is not prorated. */
function taxYearElapsed() {
  const d = today();
  return Math.min(1, ((d.month - 1) * DAYS_PER_MONTH + (d.day - 1)) / DAYS_PER_YEAR);
}

/* 🐛 [owner 2026-08-22: "ภาษีมันควรคิดสดต่อวัน ไม่ใช่ต่อปี"] — and he was right that it was not.
 *
 * This used to be `full(TODAY's holdings) × fraction-of-year-elapsed`, which reads as daily accrual
 * and is not: it recomputes the whole year from whatever you happen to hold at the moment of asking.
 * Measured before changing it — hold 500,000,000 for the entire year, move it out on day 359, and
 * the running figure AND the year-end bill both fall to zero. A full year of wealth tax, dodged by
 * one transfer. The estate tax had the same hole: sell the house on the last day, buy it back on
 * the first.
 *
 * So the charge is now genuinely per day and genuinely kept: each game-day adds that day's share of
 * that day's holdings to a stored total, and lowering the balance afterwards does not refund it —
 * the owner's call, and the only version where "คิดสดต่อวัน" means anything. Money moved out early
 * still helps, because every day after the move is charged on the smaller pile.
 *
 * Business income stays outside this: yearProfit is already a year-to-date total that only grows, so
 * charging a slice of it daily would tax the same profit repeatedly. */
function taxAccrueDay() {
  /* 🎯 [owner 2026-08-23] Nothing to do any more, and kept as a named no-op rather than deleted
   * because onNewDay calls it and the shape of the tax year is easier to follow with the seam still
   * visible. Both kinds are charged on income now: yearProfit and yearRent are year-to-date totals
   * that only grow, so a daily slice of them would tax the same earnings again every day.
   *
   * P.tax.accrued is left alone rather than cleared — a save mid-year carries a figure from the old
   * holdings taxes, and taxRunningFor no longer reads it. */
}
/* 🎯 [owner 2026-08-23] Both kinds are income now, so this is simply the ladder applied to what
   the year has earned so far — no proration and no stored accrual, because the base itself is
   already a year-to-date figure that only grows. */
function taxRunningFor(kindId) { return taxOwedFor(kindId, taxBaseFor(kindId)); }
function taxPrepaid(kindId) { return Math.floor(P.tax?.prepaid?.[kindId] || 0); }
/* What this kind owes right now, before the year has even ended. */
function taxAccruedFor(kindId) { return Math.max(0, taxRunningFor(kindId) - taxPrepaid(kindId)); }
function taxAccruedTotal() { return TAX_KINDS.reduce((t, k) => t + taxAccruedFor(k.id), 0); }

function taxBills() { return (P.tax?.bills || []).filter((b) => b.amount > b.paid); }
/* Only DATED bills can fall overdue. This year's running figure is not late until the year ends. */
function taxOwedTotal() { return taxBills().reduce((t, b) => t + (b.amount - b.paid), 0); }
/* How overdue the oldest unpaid bill is, in game-days. */
function taxOverdueDays() {
  const bills = taxBills();
  if (!bills.length) return 0;
  return Math.floor(P.gameDays) - Math.min(...bills.map((b) => b.assessedDay));
}
function taxSeized() { return taxOverdueDays() >= TAX_SEIZE_DAYS; }

/* Take from the pocket first, then the bank's newest slips — the same order a withdrawal uses. */
function takeGoldThenBank(amount) {
  let left = Math.floor(amount), taken = 0;
  const fromGold = Math.min(Math.max(0, Math.floor(P.gold)), left);
  P.gold -= fromGold; left -= fromGold; taken += fromGold;
  if (left > 0) {
    const slips = bankSlips();
    for (let i = slips.length - 1; i >= 0 && left > 0; i--) {
      const take = Math.min(slips[i].amount, left);
      slips[i].amount -= take; left -= take; taken += take;
      if (Math.floor(slips[i].amount) <= 0) slips.splice(i, 1);
    }
    bankTidySlips();
  }
  return Math.floor(taken);
}

function payTaxBill(billId, amount) {
  const bill = (P.tax?.bills || []).find((b) => b.id === billId);
  if (!bill) return 0;
  const owed = bill.amount - bill.paid;
  const want = Math.min(Math.floor(amount ?? owed), owed);
  if (want <= 0) return 0;
  const paid = takeGoldThenBank(want);
  if (paid <= 0) { toast("เงินไม่พอจ่ายภาษี — ต้องมีทองในมือหรือเงินฝาก", "warn"); return 0; }
  bill.paid += paid;
  P.tax.paidTotal = (P.tax.paidTotal || 0) + paid;
  const k = TAX_KINDS.find((x) => x.id === bill.kind);
  ledger("🧾", `จ่าย${k ? k.name : "ภาษี"} ปีที่ ${bill.year}`, -paid);
  const done = bill.amount - bill.paid <= 0;
  toast(`🧾 จ่าย${k ? k.name : "ภาษี"} ${paid.toLocaleString()} 💰`
        + (done ? " — ปิดบิลแล้ว" : ` · เหลืออีก ${(bill.amount - bill.paid).toLocaleString()}`),
        done ? "levelup" : "", "money");
  if (done) P.tax.bills = P.tax.bills.filter((b) => b.amount > b.paid);
  save("จ่ายภาษี");
  renderView(); updateTopbar();
  return paid;
}
function payAllTax() {
  for (const b of [...taxBills()]) payTaxBill(b.id, b.amount - b.paid);
  for (const k of TAX_KINDS) payTaxAccrued(k.id);
}

/* Pay ahead against the year in progress. The same gold, taken the same way, just earlier — which
 * is the whole point: a bill you can settle a little at a time never arrives as a shock. */
function payTaxAccrued(kindId, amount) {
  const owed = taxAccruedFor(kindId);
  const want = Math.min(Math.floor(amount ?? owed), owed);
  if (want <= 0) return 0;
  const paid = takeGoldThenBank(want);
  if (paid <= 0) { toast("เงินไม่พอจ่ายภาษี — ต้องมีทองในมือหรือเงินฝาก", "warn"); return 0; }
  P.tax.prepaid = P.tax.prepaid || {};
  P.tax.prepaid[kindId] = (P.tax.prepaid[kindId] || 0) + paid;
  P.tax.paidTotal = (P.tax.paidTotal || 0) + paid;
  const k = TAX_KINDS.find((x) => x.id === kindId);
  ledger("🧾", `จ่าย${k.name}ล่วงหน้า (ปีที่ ${today().year})`, -paid);
  toast(`🧾 จ่าย${k.name}ล่วงหน้า ${paid.toLocaleString()} 💰`
        + (taxAccruedFor(kindId) <= 0 ? " — ปีนี้จ่ายครบถึงวันนี้แล้ว" : ""), "", "money");
  save("จ่ายภาษีล่วงหน้า");
  renderView(); updateTopbar();
  return paid;
}

/* One id per bill, and never two the same.
 *
 * settleTaxYear used to name a bill `${kind}-${year}` outright, which is unique only while there is
 * one calendar. A rebirth restarts the calendar, so a second life reaching the same year would raise
 * a bill with an id an unpaid one already had — and payTaxBill finds by id with `.find()`, so the
 * older bill would have been unpayable and the newer one invisible to every payment. The rebirth
 * assessment below makes that reachable, so the naming is closed here rather than worked around. */
function taxBillId(kindId, year) {
  const bills = P.tax?.bills || [];
  const base = (P.rebirths || 0) > 0 ? `${kindId}-${year}-r${P.rebirths}` : `${kindId}-${year}`;
  let id = base;
  for (let n = 2; bills.some((b) => b.id === id); n++) id = `${base}-${n}`;
  return id;
}

/* 🎯 [owner 2026-08-30] "ถ้ามีภาษีค้าง แล้วจุติ หนี้ภาษีหาย มันไม่ควรโดนล้าง"
 *
 * A rebirth ends the tax year early. Everything the life just lived has accrued — taxAccruedFor is
 * `ladder(base) - prepaid`, on year-to-date income that only ever grows — and it is assessed here
 * exactly as a year end would assess it, then the counters are reset so the new life starts clean.
 *
 * Both halves matter and neither works alone. Assessing without resetting would tax the previous
 * life's earnings a second time at the new year's end; resetting without assessing is the bug this
 * fixes. It is deliberately NOT collected the way collectAssessedTax does at a year end: the pocket
 * gold is confiscated a few lines earlier anyway, and the whole design of this system is that a
 * bill is settled by hand ("ประเมินปีละครั้ง · ชำระเอง"). The new life gets the same thirty clear
 * days every other bill gets, and the same teeth after them. */
function assessTaxOnRebirth() {
  if (!P.tax) return;
  P.tax.bills = P.tax.bills || [];
  const year = today().year;
  const raised = [];
  let total = 0;
  for (const k of TAX_KINDS) {
    const amount = taxAccruedFor(k.id);
    if (amount <= 0) continue;
    P.tax.bills.push({ id: taxBillId(k.id, year), kind: k.id, year, base: taxBaseFor(k.id),
                       amount, paid: 0, assessedDay: Math.floor(P.gameDays), pastLife: true });
    raised.push(`${k.icon} ${amount.toLocaleString()}`);
    total += amount;
  }
  /* Reset AFTER the assessment, never before — these three are what the figure above is derived
   * from, so clearing them first is the same as forgiving the bill. */
  P.tax.yearProfit = 0;
  P.tax.yearRent = 0;
  P.tax.prepaid = {};
  P.tax.accrued = {};
  P.tax.lastBill = total > 0 ? { year, profit: 0, bill: total, pastLife: true } : null;
  if (total > 0) {
    toast(`🧾 ประเมินภาษีค้างของชาติก่อน ${total.toLocaleString()} — ${raised.join(" · ")}`
          + ` · ตามมาด้วย ต้องชำระภายใน ${TAX_FATAL_DAYS} วัน`, "warn");
  }
}

function settleTaxYear(date) {
  /* 🎯 [owner 2026-08-17] The year end ASSESSES; it no longer collects. Three bills are raised —
   * on what you hold, on what you made, and on what you own — and they sit on the tax page until
   * the player settles them. What used to happen here silently is now a decision, with teeth
   * attached to ignoring it rather than to being briefly short. */
  const year = date.year - 1;
  P.tax.bills = P.tax.bills || [];
  const raised = [];
  for (const k of TAX_KINDS) {
    /* 🎯 [owner 2026-08-17] "ถ้าเริ่มปีใหม่ นั่นคือการแยกบิลภาษีของปี" — whatever is still owed on
     * the year that just ended becomes its OWN dated bill, and only from here does the three-month
     * countdown apply. Anything paid ahead during the year is already gone from this figure, so
     * settling as you go simply leaves nothing behind. */
    const base = taxBaseFor(k.id);
    /* What the YEAR actually accrued, not what today's holdings would imply — the whole point of
       charging per day is that the bill remembers the year you had, not the balance you end on.
       Not taxRunningFor: its fallback prorates by elapsed-fraction-of-year, and this runs on the
       first day of the new year when that fraction is exactly 0 — a save upgrading from before the
       daily accrual would be assessed nothing at all. A finished year is a whole year. */
    const full = taxOwedFor(k.id, base);
    const amount = Math.max(0, full - taxPrepaid(k.id));
    if (amount <= 0) continue;
    P.tax.bills.push({ id: taxBillId(k.id, year), kind: k.id, year, base, amount, paid: 0,
                       assessedDay: Math.floor(P.gameDays) });
    raised.push(`${k.icon} ${amount.toLocaleString()}`);
  }
  P.tax.prepaid = {};   // a new year starts owing nothing and having paid nothing
  P.tax.accrued = {};   // and accrues from zero — last year's total is now a dated bill
  const profit = Math.round(P.tax.yearProfit || 0);
  P.tax.lastBill = { year, profit, bill: raised.length ? P.tax.bills.slice(-raised.length)
    .reduce((t, b) => t + b.amount, 0) : 0 };
  P.tax.yearProfit = 0;
  P.tax.yearRent = 0;                 // the rent year restarts with the tax year
  if (P.bank) P.bank.yearInterest = 0;
  if (!raised.length) {
    if (profit > 0) toast(`🧾 สรุปปีที่ ${year}: กำไรลงทุน ${profit.toLocaleString()} — ยังไม่ถึงเกณฑ์เสียภาษี`);
    return;
  }
  toast(`🧾 ประเมินภาษีปีที่ ${year} แล้ว: ${raised.join(" · ")}`, "warn");
  collectAssessedTax(year);
}

/* 🎯 [owner 2026-08-22: "ถ้าเราเคลียร์ยอดไม่หมด ปีใหม่ระบบจะบังคับหักเงินตอนสิ้นปีจากกระเป๋า แต่ถ้าเงิน
 * ในกระเป๋าไม่พอ จะเกิดค่าติดลบ"] The year end used to raise a bill and wait. It now takes what it
 * can the moment the year turns, wallet first and then the bank, and leaves the rest as a real
 * negative balance rather than a polite request.
 *
 * That negative is what the existing clocks already read: taxDebtCheck ends the run after
 * TAX_GRACE_DAYS at a negative balance, and taxEnforce seizes the businesses after
 * TAX_SEIZE_DAYS. Nothing new had to be invented for the teeth — only for the bite.
 *
 * Paying ahead during the year still avoids all of it, which is the point of accruing daily. */
function collectAssessedTax(year) {
  const bills = (P.tax.bills || []).filter((b) => b.year === year);
  const owed = bills.reduce((t, b) => t + (b.amount - (b.paid || 0)), 0);
  if (owed <= 0) return;

  const took = takeGoldThenBank(owed);
  let left = owed - took;
  /* Spread what was taken across the year's bills oldest first, so a partly-paid year shows which
     bill is still open rather than three bills all half-settled. */
  let pot = took;
  for (const b of bills) {
    if (pot <= 0) break;
    const due = b.amount - (b.paid || 0);
    const pay = Math.min(due, pot);
    b.paid = (b.paid || 0) + pay;
    pot -= pay;
  }
  P.tax.paidTotal = (P.tax.paidTotal || 0) + took;
  if (took > 0) ledger("🧾", `หักภาษีปีที่ ${year} อัตโนมัติ`, -took);

  if (left > 0) {
    /* The shortfall becomes a real debt in the pocket, the same shape family arrears take — which
       is what starts taxDebtCheck's countdown on this very day rather than the next one. */
    P.gold -= left;
    toast(`🚨 หักภาษีปีที่ ${year} ได้ ${took.toLocaleString()} 💰 — ขาดอีก ${Math.round(left).toLocaleString()}`
          + ` · เงินติดลบครบ ${TAX_GRACE_DAYS} วันคือจบเกม`, "warn");
  } else {
    toast(`🧾 หักภาษีปีที่ ${year} เรียบร้อย ${took.toLocaleString()} 💰`, "", "money");
  }
}

/* 🎯 [owner 2026-08-17] "ถ้าไม่จ่ายนาน ... ระบบจะล็อกธุรกิจนั้นๆ เริ่มยึด ทำให้รายได้เป็น 0 จนกว่าจะ
 * จ่ายตัง และจะเริ่มคิดเรทดอกเบี้ยค่าชำระล่าช้า ... ปรับเงินจากกระเป๋าหลักและเงินในบัญชีธนาคารรายวัน"
 *
 * Runs every game-day. Once a bill is TAX_SEIZE_DAYS old the businesses that earned it stop
 * paying — shops, rent and dividends all return nothing while seized — and a late charge is added
 * to the bill AND collected the same day, pocket first and bank second. Both halves matter: the
 * charge alone could be outrun by income, and the seizure alone would leave the bill frozen. */
function taxEnforce(date) {
  if (!P.tax?.bills?.length) return;
  const overdue = taxOverdueDays();
  if (overdue < TAX_SEIZE_DAYS) return;
  const owed = taxOwedTotal();
  if (owed <= 0) return;
  const fee = Math.max(1, Math.round(owed * TAX_LATE_DAILY));
  const oldest = taxBills().reduce((a, b) => (a.assessedDay <= b.assessedDay ? a : b));
  oldest.amount += fee;
  const took = takeGoldThenBank(fee);
  if (took > 0) {
    oldest.paid += took;
    P.tax.paidTotal = (P.tax.paidTotal || 0) + took;
    ledger("🚨", "ค่าปรับชำระภาษีล่าช้า", -took);
  }
  if (!P.tax.seizeNotedDay || Math.floor(P.gameDays) - P.tax.seizeNotedDay >= 1) {
    P.tax.seizeNotedDay = Math.floor(P.gameDays);
    toast(`🚨 ค้างภาษี ${owed.toLocaleString()} เกิน ${TAX_SEIZE_DAYS} วัน — ธุรกิจถูกยึด รายได้เป็น 0`
          + ` · ดอกเบี้ยทบวันละ ${Math.round(TAX_LATE_DAILY * 1000) / 10}%`
          + (took > 0 ? ` · หักไป ${took.toLocaleString()} 💰` : "")
          + ` · เหลืออีก ${Math.max(0, TAX_FATAL_DAYS - overdue)} วันก่อนจบเกม`, "warn", "money");
  }

  /* 🎯 [owner 2026-08-22] "จนถึงเดือนสามคือ 90 วัน ถ้ายังไม่จ่ายก็แปลว่าเกมโอเวอร์" — counted from
   * the assessment, not from the wallet going negative. taxDebtCheck already ends a run that stays
   * in the red, but a player can sit on an unpaid bill with a positive balance indefinitely, and
   * that is the case this closes. */
  if (overdue >= TAX_FATAL_DAYS) {
    endRun(`ค้างภาษี ${owed.toLocaleString()} เกิน ${TAX_FATAL_DAYS} วันในเกม`);
  }
}


/* 🐛 [found by game-playtester, 2026-08-18] "จ่ายไม่ครบ → ติดลบ → มีเวลา 3 เดือนในเกม → แก้ไม่ได้ =
 * เกมโอเวอร์" was fully built — endRun() below, renderDead(), the debt banner on the money page,
 * the sidebar's "🚨 ค้างภาษี!" note, TAX_GRACE_DAYS, and the rebirth code that already re-anchors
 * debtSinceDay to a new calendar — but nothing anywhere ever SET debtSinceDay to a real day number.
 * It was only ever read, reset to null, or shifted. A run could sit at -3,000,000 gold for 450
 * game-days (five times the grace period) with zero consequence: no banner, no game over, nothing.
 * Runs once a game-day, the same cadence the businesses that move P.gold already run at. */
function taxDebtCheck() {
  if (P.dead) return;
  P.tax = P.tax || {};
  if (P.gold >= 0) { P.tax.debtSinceDay = null; return; }
  if (P.tax.debtSinceDay == null) { P.tax.debtSinceDay = Math.floor(P.gameDays); return; }
  if (Math.floor(P.gameDays) - P.tax.debtSinceDay >= TAX_GRACE_DAYS) {
    endRun("ติดลบต่อเนื่องเกิน 3 เดือนในเกม แก้ไม่ทัน");
  }
}

/* Game over is NOT a rebirth: nothing carries over. The save is left on disk untouched rather
 * than deleted — ending a run is the game's call, throwing away the file stays the player's. */
function endRun(reason) {
  P.dead = { day: Math.floor(P.gameDays), reason, date: dateLabel() };
  stopAllSlots();
  save("จบเกม");
  renderView();
  updateTopbar();
  toast(`💀 จบเกม — ${reason}`, "warn");
}

/* ---------- Farming ----------
 * Plots are deliberately NOT job slots. A garden that competed with woodcutting for the one
 * multi-processing slot would just be a worse version of every other skill; the whole point is
 * that it runs beside whatever else you are doing. That parallelism is also why every yield in
 * data.js is priced against PLOTS_MAX rather than a single plot. */

const FARM = () => findSkill("fa");
function maxPlots() {
  return Math.min(PLOTS_MAX, PLOTS_START + SHOP.filter((u) => u.kind === "plot" && P.upgrades[u.id]).length);
}
function farmAction(actionId) { return findAction(FARM(), actionId); }
function growSeconds(actionId) {
  /* The gardener's bonus shortens the wait rather than raising the yield: an idle game is measured
   * in how long you look at a bar, and that is the number worth giving back. */
  return effectiveSeconds("fa", farmAction(actionId)) / (1 + relBonusTotal("farmSpeed"));
}
function plotReady(pl) { return !!pl && pl.grown >= growSeconds(pl.actionId); }

/* Priced straight off the pickings being bought — no window, no estimate. */
function harvestValueOf(actionId) {
  const a = farmAction(actionId);
  return a ? cropValuePerHarvest(a, (id) => ITEMS[id].sell || 0) : 0;
}
function gardenerPrice(actionId, rounds) {
  return Math.round(harvestValueOf(actionId) * maxPlots() * rounds * GARDENER_WAGE_SHARE);
}
function gardenerActive() { return (P.gardener?.harvestsLeft || 0) > 0; }
function gardenerHarvestsLeft() { return P.gardener?.harvestsLeft || 0; }
function gardenerRoundsLeft() { return gardenerHarvestsLeft() / Math.max(1, maxPlots()); }

function hireGardener(actionId, rounds) {
  const cost = gardenerPrice(actionId, rounds);
  if (P.gold < cost) { toast(`ทองไม่พอ — จ้างเก็บ ${rounds} รอบราคา ${cost.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= cost;
  const buying = rounds * maxPlots();
  /* Topping up adds to what is left rather than replacing it — unused pickings are already paid for. */
  P.gardener = {
    harvestsLeft: gardenerHarvestsLeft() + buying,
    actionId, warnedDry: false,
  };
  const a = farmAction(actionId);
  toast(`👩‍🌾 จ้างคนเฝ้าสวนแล้ว ${rounds} รอบ (${buying} ครั้งเก็บ) — เก็บและปลูก${a.name}ให้เอง (${cost.toLocaleString()} 💰)`, "levelup");
  save("จ้างคนเฝ้าสวน");
}
function readyPlots() { return P.plots.slice(0, maxPlots()).filter(plotReady).length; }

/* Every owned plot planted AND ripe — the moment the garden stops earning and starts idling.
 *
 * Deliberately stricter than `readyPlots() > 0`. In a garden of eight plots something is ripe
 * almost all the time, so a badge on that condition would be lit permanently and stop being read.
 * This one only lights when there is genuinely nothing left growing, which is the only moment a
 * harvest is actually overdue. */
function farmIdleFull() {
  const n = maxPlots();
  if (!n) return false;
  return P.plots.slice(0, n).every((pl) => pl && plotReady(pl));
}

/* Growth advances only while the game is open — see the `plots` comment in freshProfile. */
function farmTick(dtSeconds) {
  let anyFinished = false;
  const n = maxPlots();
  const hired = gardenerActive();
  for (let i = 0; i < n; i++) {
    const pl = P.plots[i];
    if (!pl) continue;
    const need = growSeconds(pl.actionId);
    if (pl.grown >= need) continue;
    pl.grown = Math.min(need, pl.grown + dtSeconds);
    if (pl.grown >= need) anyFinished = true;
  }
  /* The hired hand works here rather than on the calendar tick, because this is where a plot
   * becomes ripe — harvesting on the same tick means no crop ever sits finished and idle.
   *
   * 🐛 [owner reported 2026-08-17] This used to run only when a plot had JUST ripened this tick,
   * which deadlocked the moment you hired someone while crops were already sitting ripe: nothing
   * was growing, so nothing ever finished, so the hire never woke up — forever, while the contract
   * ran down. It now looks at the actual state of the plots (anything ripe, or any empty plot it
   * could sow) rather than at an event it might have missed. */
  const ripeNow = readyPlots();
  const emptyNow = P.plots.slice(0, n).filter((pl) => !pl).length;
  if (hired && (ripeNow > 0 || emptyNow > 0)) {
    const got = {};
    let picked = 0;
    for (let i = 0; i < n && P.gardener.harvestsLeft > 0; i++) {
      const r = harvestPlot(i, true);
      if (!r) continue;
      picked++;
      P.gardener.harvestsLeft--;
      got[r.cropId] = (got[r.cropId] || 0) + r.crops;
      got[r.seedId] = (got[r.seedId] || 0) + r.seeds;
    }
    let replanted = 0;
    if (P.gardener.harvestsLeft > 0)
      for (let i = 0; i < n; i++) if (!P.plots[i] && plantPlot(i, P.gardener.actionId)) replanted++;
    if (picked) {
      const list = Object.entries(got).map(([id, q]) => `${ITEMS[id].icon} ×${q}`).join(" · ");
      toast(`👩‍🌾 คนเฝ้าสวนเก็บ ${picked} แปลง ${list}` + (replanted ? ` · ปลูกต่อ ${replanted}` : "")
            + ` · เหลือ ${gardenerHarvestsLeft()} ครั้ง`, "", "gain");
    }
    /* Contract complete. Stop planting so the last crop is not left half-grown and unattended. */
    if (!gardenerActive() && P.gardener) {
      P.gardener = null;
      toast("👩‍🌾 ครบรอบที่จ้างไว้แล้ว — จ้างต่อได้ที่หน้าสวน", "warn");
    }
    /* Ran dry. Said once per contract, plainly — the ticker runs at 4Hz and the contract is still
     * costing, so this must neither spam nor stay silent. */
    if (!replanted && emptyNow + picked > 0 && P.gardener && !P.gardener.warnedDry) {
      P.gardener.warnedDry = true;
      toast("👩‍🌾 เมล็ดหมด คนเฝ้าสวนปลูกต่อไม่ได้ (สัญญายังเดินอยู่)", "warn");
    }
    if (replanted && P.gardener) P.gardener.warnedDry = false;
    if (picked || replanted) {
      checkAchievements();
      refreshSidebar();
      if (view.kind === "skill" && view.skillId === "fa") renderView();
    }
    if (picked || replanted || anyFinished) return;
  }
  if (anyFinished) {
    toast("🌻 มีแปลงที่โตเต็มที่แล้ว — ไปเก็บเกี่ยวได้เลย");
    if (view.kind === "skill" && view.skillId === "fa") renderView();
  } else if (view.kind === "skill" && view.skillId === "fa") {
    updatePlotBars();
  }
}

function plantPlot(i, actionId) {
  const action = farmAction(actionId);
  if (!actionOpen("fa", action)) return false;
  if (i >= maxPlots() || P.plots[i]) return false;
  const seedId = Object.keys(action.inputs)[0];
  if ((P.inv[seedId] || 0) < 1) return false;
  P.inv[seedId] -= 1;
  if (P.inv[seedId] <= 0) delete P.inv[seedId];
  P.plots[i] = { actionId, grown: 0 };
  return true;
}

function plantAll(actionId) {
  /* 🎯 [owner's ask] Pressing plant with ripe crops still in the ground used to do nothing for
   * those plots — they were "full". Harvest first, then plant: nobody presses plant meaning
   * "leave the ripe ones sitting there". */
  const ripe = P.plots.slice(0, maxPlots()).filter((pl) => pl && plotReady(pl)).length;
  if (ripe) harvestAll();
  const before = P.plots.slice(0, maxPlots()).filter(Boolean).length;
  let planted = 0;
  for (let i = 0; i < maxPlots(); i++) if (!P.plots[i] && plantPlot(i, actionId)) planted++;
  const action = farmAction(actionId);
  if (!planted) {
    const empty = maxPlots() - before;
    toast(empty ? "เมล็ดไม่พอสำหรับแปลงที่ว่าง" : "ไม่มีแปลงว่างแล้ว", "warn");
  } else {
    toast(`🌱 ปลูก${action.name} ${planted} แปลง`);
  }
  renderView();
  renderInventory();
  return planted;
}

/* One harvest: the produce, plus MORE seeds than went in — that is what makes a garden
 * self-sustaining once it is started, and why seeds are a one-time purchase. */
function harvestPlot(i, quiet) {
  const pl = P.plots[i];
  if (!plotReady(pl)) return null;
  const action = farmAction(pl.actionId);
  const [cropId, baseN] = Object.entries(action.outputs)[0];
  const seedId = Object.keys(action.inputs)[0];
  const mult = masteryLootMult("fa", pl.actionId);
  const crops = Math.max(1, Math.round(baseN * mult * (1 + luckTotal())));
  const seeds = randInt(action.seedBack[0], action.seedBack[1]);
  P.inv[cropId] = (P.inv[cropId] || 0) + crops;
  P.inv[seedId] = (P.inv[seedId] || 0) + seeds;
  P.plots[i] = null;

  const b = levelFromXp(P.xp.fa);
  P.xp.fa += Math.ceil(action.xp * (1 + tomeBonus("fa") + momentumTier().xp));
  const a = levelFromXp(P.xp.fa);
  const mk = masteryKey("fa", pl.actionId);
  P.mastery[mk] = (P.mastery[mk] || 0) + Math.ceil(action.xp * 0.6);
  P.seenCrops[pl.actionId] = true;
  bump("harvests"); bump("actions");
  checkAchievements();
  if (!quiet) {
    toast(`🌻 เก็บ${action.name}: ${ITEMS[cropId].icon} ×${crops} · ${ITEMS[seedId].icon} คืน ×${seeds}`);
    if (a > b) toast(`🎉 ทำสวนเลเวลอัพ! ถึงเลเวล ${a}`, "levelup");
  }
  return { cropId, crops, seedId, seeds, levelUp: a > b };
}

function harvestAll() {
  const got = {};
  let count = 0, levelUp = false;
  for (let i = 0; i < maxPlots(); i++) {
    const r = harvestPlot(i, true);
    if (!r) continue;
    count++;
    levelUp = levelUp || r.levelUp;
    got[r.cropId] = (got[r.cropId] || 0) + r.crops;
    got[r.seedId] = (got[r.seedId] || 0) + r.seeds;
  }
  if (!count) { toast("ยังไม่มีแปลงไหนโตเต็มที่", "warn"); return; }
  const summary = Object.entries(got).map(([id, n]) => `${ITEMS[id].icon} ×${n}`).join(" · ");
  toast(`🌻 เก็บเกี่ยว ${count} แปลงรวดเดียว — ${summary}`);
  if (levelUp) toast(`🎉 ทำสวนเลเวลอัพ! ถึงเลเวล ${levelFromXp(P.xp.fa)}`, "levelup");
  renderView();
  renderInventory();
  refreshSidebar();
}

function clearPlot(i) {
  if (!P.plots[i]) return;
  const action = farmAction(P.plots[i].actionId);
  P.plots[i] = null;
  toast(`ถอน${action.name}ทิ้ง — เมล็ดที่ลงไปแล้วไม่ได้คืน`, "warn");
  renderView();
}

function buySeed(itemId, n) {
  const entry = SEED_SHOP.find((e) => e.item === itemId);
  if (!entry) return;
  const cost = entry.price * n;
  if (P.gold < cost) { toast(`ทองไม่พอ — ต้องการ ${cost.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= cost;
  P.inv[itemId] = (P.inv[itemId] || 0) + n;
  toast(`🌱 ซื้อ${ITEMS[itemId].name} ×${n} (-${cost.toLocaleString()} 💰)`);
  renderView();
  renderInventory();
  updateTopbar();
}

/* ---------- Wandering trader ----------
 * 🐛 [fixed 2026-08-15, owner: "มี popup แต่หาเมนูซื้อไม่เจอ"] The event used to hand over coins
 * and call itself a trader, which promised a stall that did not exist. It now opens a real,
 * timed one: a hidden shop category appears at the TOP of the shop for five minutes with a rolled
 * selection of materials the shop never otherwise sells. Wall-clock deadline on purpose — closing
 * the tab does not pause it, so a stall you walked away from is genuinely gone. */

function traderOpen() {
  return !!(P.trader && P.trader.until > Date.now());
}
function traderSecondsLeft() {
  return traderOpen() ? Math.ceil((P.trader.until - Date.now()) / 1000) : 0;
}
function openTraderStall(seconds) {
  const pool = TRADER_STOCK.slice();
  const offers = [];
  for (let i = 0; i < TRADER_OFFER_COUNT && pool.length; i++) {
    offers.push({ ...pool.splice(Math.floor(Math.random() * pool.length), 1)[0], sold: false });
  }
  P.trader = { until: Date.now() + seconds * 1000, offers };
}
function buyTraderOffer(i) {
  if (!traderOpen()) { toast("พ่อค้าเก็บแผงไปแล้ว", "warn"); renderView(); return; }
  const o = P.trader.offers[i];
  if (!o || o.sold) return;
  if (P.gold < o.price) { toast("ทองไม่พอ", "warn"); return; }
  P.gold -= o.price;
  P.inv[o.item] = (P.inv[o.item] || 0) + o.n;
  o.sold = true;
  toast(`🧙 ซื้อ ${ITEMS[o.item].icon} ${ITEMS[o.item].name} ×${o.n} — ${o.price.toLocaleString()} 💰`, "levelup", "trader");
  renderView();
  renderInventory();
}

/* ---------- Random events ---------- */

function rollEvent(skillId, actionId) {
  for (const ev of EVENTS) {
    // An event may name the skills it belongs to. Checked before the roll so a restricted event
    // costs nothing on the skills it does not apply to.
    if (ev.only && !ev.only.includes(skillId)) continue;
    if (Math.random() >= ev.roll) continue;
    if (ev.kind === "surge" || ev.kind === "haste") {
      buffs[ev.kind] = performance.now() + ev.seconds * 1000;
    } else if (ev.kind === "trader") {
      openTraderStall(ev.seconds);
    } else if (ev.kind === "gold") {
      const g = Math.round(randInt(ev.gold[0], ev.gold[1]) * (1 + charmValue("gold") + perkTotal("goldBonus")));
      P.gold += g; bump("goldEarned", g);
    } else if (ev.kind === "loot") {
      const id = ev.loot[Math.floor(Math.random() * ev.loot.length)];
      P.inv[id] = (P.inv[id] || 0) + 1;
    } else if (ev.kind === "xp") {
      const skill = findSkill(skillId);
      const act = findAction(skill, actionId);
      P.xp[skillId] += act.xp * ev.xpMult;
    }
    toast(`${ev.icon} ${ev.name} — ${ev.text}`, "levelup", ev.kind === "trader" ? "trader" : "");
    renderView();
    return;
  }
}

/* ---------- Skill engine ---------- */

function canAfford(action) {
  if (!action.inputs) return true;
  return Object.entries(action.inputs).every(([id, n]) => (P.inv[id] || 0) >= n);
}

/* An action opens when the skill level is met AND (if set) another action's mastery has
 * reached the required step — "ปลดล็อกตามความชำนาญ" (owner, 2026-08-15). */
function actionOpen(skillId, action) {
  if (levelFromXp(P.xp[skillId]) < action.level) return false;
  if (action.masteryReq
      && masteryLevelOf(skillId, action.masteryReq.actionId) < action.masteryReq.level) return false;
  return true;
}

/* Which slot, if any, is already running this exact job. */
function slotOf(skillId, actionId) {
  return P.slots.findIndex((sl) => sl && sl.type === "skill"
    && sl.skillId === skillId && sl.actionId === actionId);
}

function startAction(skillId, actionId) {
  const skill = findSkill(skillId);
  const action = findAction(skill, actionId);
  if (!actionOpen(skillId, action)) return;
  const running = slotOf(skillId, actionId);
  if (running >= 0) { stopSlot(running); return; }   // clicking a running job stops it
  if (action.inputs && !canAfford(action)) { toast("วัตถุดิบไม่พอ — ไปเก็บมาก่อนนะ", "warn"); return; }
  if (activeCount() >= maxSlots()) {
    toast(maxSlots() === 1
      ? "ทำได้ทีละอย่าง — ซื้อ 'ทำหลายอย่างพร้อมกัน' ในร้านค้าเพื่อเพิ่มช่อง"
      : `${T("ช่องงานเต็ม")} (${maxSlots()}) — ${T("หยุดงานใดงานหนึ่งก่อน")}`, "warn");
    return;
  }
  const i = P.slots.length;
  P.slots[i] = { type: "skill", skillId, actionId };
  RT[i] = { startedAt: performance.now(), fight: null };
  renderView();
  updateBanner();
}

function stopSlot(i) {
  P.slots.splice(i, 1);
  RT.splice(i, 1);
  if (!P.slots.length) { momentumKey = null; momentumSince = 0; }
  renderView();
  updateBanner();
}

function stopAllSlots() {
  P.slots = [];
  RT = [];
  momentumKey = null; momentumSince = 0;
  renderView();
  updateBanner();
}

function skillTick(now, slotIdx) {
  const { skillId, actionId } = P.slots[slotIdx];
  noteActivity(`${skillId}:${actionId}`);
  const skill = findSkill(skillId);
  const action = findAction(skill, actionId);
  const rt = slotRT(slotIdx);
  const dur = effectiveSeconds(skillId, action);
  const elapsed = (now - rt.startedAt) / 1000;
  if (elapsed < dur) { updateProgressBars(slotIdx, elapsed / dur); return; }

  // Thieving resolves as a success roll instead of guaranteed output: mastery raises the
  // odds; a miss costs HP and pays nothing (the risk that funds the reward).
  if (action.steal) {
    noteActivity(`${skillId}:${actionId}`);
    const st = action.steal;
    const mLvlNow = masteryLevelOf(skillId, actionId);
    const chance = Math.min(0.95, st.success + 0.004 * (mLvlNow - 1));
    rt.startedAt = performance.now();
    if (Math.random() >= chance) {
      P.hp = Math.max(1, P.hp - st.failDmg);
      toast(`🚨 โดนจับได้! เจ็บตัว -${st.failDmg} HP`, "warn");
      // 🎯 [added 2026-08-15, owner's ask] Getting caught draws blood exactly like a monster does,
      // so the same provisions and the same threshold apply here — a thief with food packed no
      // longer has to walk to the hunting grounds to use it.
      if (P.hp > 0 && P.hp / maxHp() < (P.autoEatPct ?? AUTO_EAT_DEFAULT)) tryEat(true);
      updateTopbar();
      if (P.hp <= 1) { toast("บาดเจ็บหนักเกินกว่าจะย่องต่อ — พักฟื้นก่อนนะ", "warn"); stopSlot(slotIdx); }
      return;
    }
    const gold = Math.round(randInt(st.gold[0], st.gold[1])
      * (1 + charmValue("gold") + perkTotal("goldBonus")));
    P.gold += gold;
    const got = [`💰 ${gold}`];
    if (st.junk && Math.random() < st.junk * masteryJunkMult(skillId, actionId)) {
      const j = JUNK_IDS[Math.floor(Math.random() * JUNK_IDS.length)];
      P.inv[j] = (P.inv[j] || 0) + 1;
      got.push(`${ITEMS[j].icon} ${ITEMS[j].name}`);
    }
    for (const drop of st.loot || []) {
      if (Math.random() < effectiveLootChance(skillId, actionId, drop.chance)) {
        const n = randInt(drop.n[0], drop.n[1]);
        P.inv[drop.item] = (P.inv[drop.item] || 0) + n;
        got.push(`${ITEMS[drop.item].icon} ${ITEMS[drop.item].name} ×${n}`);
      }
    }
    const b = levelFromXp(P.xp[skillId]);
    P.xp[skillId] += Math.ceil(action.xp * (1 + tomeBonus(skillId) + momentumTier().xp + relBonusTotal("xpBonus") + childBonusTotal("xpBonus")));
    const a = levelFromXp(P.xp[skillId]);
    bump("steals"); bump("goldEarned", gold);
    /* 🐛 [fixed 2026-08-19] Stealing tracked mastery xp but never looked at whether the LEVEL moved,
     * so — alone among the skills — it never announced "ชำนาญ ... ขั้น N" and never re-rendered on
     * it. Every non-steal action does both (see the tail of this function). Thieving is where a
     * player spends the most consecutive cycles, so it was the worst place to go quiet. */
    const mk = masteryKey(skillId, actionId);
    const mBefore = masteryLevelFromXp(P.mastery[mk] || 0);
    P.mastery[mk] = (P.mastery[mk] || 0) + Math.ceil(action.xp * 0.6);
    const mAfter = masteryLevelFromXp(P.mastery[mk]);
    checkAchievements();
    toast(`🕵️ สำเร็จ! +${action.xp} XP · ${got.join(" · ")}`, "", "gain");
    if (a > b) toast(`🎉 ${skill.name} เลเวลอัพ! ถึงเลเวล ${a}`, "levelup", "level");
    if (mAfter > mBefore) toast(`⭐ ชำนาญ "${action.name}" ขั้น ${mAfter} — เร็วขึ้น ของหายากดรอปง่ายขึ้น`, "levelup", "level");
    refreshSidebar();
    renderInventory();
    if (a > b) renderViewAuto();
    else updateMasteryBar(skillId, actionId);
    updateProgressBars(slotIdx, 0);
    return;
  }

  if (action.inputs) {
    if (!canAfford(action)) { toast(`วัตถุดิบหมด หยุด "${action.name}" แล้ว`, "warn"); stopSlot(slotIdx); return; }
    for (const [id, n] of Object.entries(action.inputs)) P.inv[id] -= n;
  }
  // A `catch` table means the action yields ONE of several species by weight (fishing waters
  // hold more than one fish); plain `outputs` stays the fixed-yield path everything else uses.
  const produced = {};
  if (action.catch) {
    const table = effectiveCatch(skillId, action);
    const total = table.reduce((t, c) => t + c.w, 0);
    let roll = Math.random() * total;
    let picked = table[table.length - 1].item;
    for (const c of table) { roll -= c.w; if (roll <= 0) { picked = c.item; break; } }
    produced[picked] = 1;
  } else {
    for (const [id, n] of Object.entries(action.outputs)) produced[id] = n;
  }
  // A "surge" event doubles what a completed action yields for its duration.
  if (buffActive("surge")) for (const id of Object.keys(produced)) produced[id] *= 2;
  for (const [id, n] of Object.entries(produced)) P.inv[id] = (P.inv[id] || 0) + n;
  for (const id of Object.keys(produced)) if (/^(fish|squid|crab|octo)_/.test(id)) P.seenFish[id] = true;
  // Junk: atmosphere loot that fouls the line or turns up in a stolen pocket.
  if (action.junk && Math.random() < action.junk * masteryJunkMult(skillId, actionId)) {
    const j = JUNK_IDS[Math.floor(Math.random() * JUNK_IDS.length)];
    P.inv[j] = (P.inv[j] || 0) + 1;
    produced[j] = (produced[j] || 0) + 1;
  }

  const before = levelFromXp(P.xp[skillId]);
  P.xp[skillId] += Math.ceil(action.xp * (1 + tomeBonus(skillId) + momentumTier().xp + relBonusTotal("xpBonus") + childBonusTotal("xpBonus")));
  const after = levelFromXp(P.xp[skillId]);
  bump("actions");
  if (skillId === "ck") bump("cooked");
  if (skillId === "sm" || skillId === "lw") bump("crafted");
  const mKey = masteryKey(skillId, actionId);
  const mBefore = masteryLevelFromXp(P.mastery[mKey] || 0);
  P.mastery[mKey] = (P.mastery[mKey] || 0) + Math.ceil(action.xp * 0.6);
  const mAfter = masteryLevelFromXp(P.mastery[mKey]);

  // `rare` may be one entry or a list (e.g. mining: star ore AND a small gem chance).
  for (const rare of action.rare ? [].concat(action.rare) : []) {
    const chance = (rare.base + rare.perLevel * mAfter) * (1 + luckTotal());
    if (Math.random() < chance) {
      P.inv[rare.item] = (P.inv[rare.item] || 0) + 1;
      /* 🎯 [owner 2026-08-23] "ถ้าปิด พวกของหายากก็ควรโดนปิดด้วย มันระบบเดียวกัน" — a rare drop
         IS the job's loot, just the good roll of it. Same switch. */
      toast(`🌟 ของหายาก! ${ITEMS[rare.item].icon} ${ITEMS[rare.item].name}`, "levelup", "gain");
    }
  }

  const drops = Object.entries(produced)
    .map(([id, n]) => `${ITEMS[id].icon} ${ITEMS[id].name} ×${n}`).join(", ");
  toast(`+${action.xp} XP · ได้ ${drops}`, "", "gain");
  if (after > before) toast(`🎉 ${skill.name} เลเวลอัพ! ถึงเลเวล ${after}`, "levelup", "level");
  if (mAfter > mBefore) toast(`⭐ ชำนาญ "${action.name}" ขั้น ${mAfter} — เร็วขึ้น ของหายากดรอปง่ายขึ้น`, "levelup", "level");// "levelup");

  rt.startedAt = performance.now();
  checkAchievements();
  rollEvent(skillId, actionId);
  refreshSidebar();
  renderInventory();
  if (after > before || mAfter > mBefore || action.inputs) renderViewAuto();
  else updateMasteryBar(skillId, actionId);   // no re-render this cycle — repaint the bar in place
  updateProgressBars(slotIdx, 0);
}

/* ---------- Combat engine ---------- */

function startCombat(locId, stageIdx) {
  const loc = findLocation(locId);
  if (combatLevel() < loc.levelReq || !stageUnlocked(loc, stageIdx)) return;
  const existing = combatSlot();
  if (existing >= 0) {
    const cur = P.slots[existing];
    const same = cur.locId === locId && cur.stageIdx === stageIdx;
    stopSlot(existing);           // one fight at a time — HP is shared across the character
    if (same) return;             // clicking the running fight just stops it
  }
  if (activeCount() >= maxSlots()) {
    toast(`${T("ช่องงานเต็ม")} (${maxSlots()}) — ${T("หยุดงานใดงานหนึ่งก่อน")}`, "warn");
    return;
  }
  const i = P.slots.length;
  const now = performance.now();
  const stage = scaledStage(loc.stages[stageIdx]);
  P.slots[i] = { type: "combat", locId, stageIdx };
  RT[i] = { startedAt: null,
            fight: { locId, stageIdx, stage, monHp: stage.hp, pNext: now + 700, mNext: now + 1400,
                     petNext: now + 1100, drainNext: now + 4000, streak: 0, enraged: false } };
  renderView();
  updateBanner();
}

/* The live fight, wherever it is parked. Rendering and combat maths both read this. */
function fightState() {
  const i = combatSlot();
  return i >= 0 ? slotRT(i).fight : null;
}

function stopCombat(silent) {
  const i = combatSlot();
  if (i < 0) return;
  if (!silent) toast("ถอนตัวจากการล่าแล้ว");
  stopSlot(i);
}

/* The first provision slot that still has stock. */
function nextFoodSlot() {
  return (P.food || []).findIndex((id) => id && (P.inv[id] || 0) > 0);
}

/* 🐛 [found by game-playtester, 2026-08-18] `food: [null, null, null]` is the state of every fresh
 * save, and nothing ever fills it — a new player can be carrying healing food the whole time and
 * autoheal will silently do nothing, because tryEat(auto=true) only warns on a MANUAL empty-slot
 * attempt (line below). A first-time player has no way to discover that a menu they were never
 * pointed at is the reason their HP kept dropping in an idle game whose whole pitch is "you don't
 * have to watch it." If every slot is empty, autofill the first one with whatever healing food is
 * actually in the bag — highest heal first, cheap enough to check on every tryEat since it returns
 * immediately once a slot is already usable. The player can still repick freely from the food panel;
 * this only ever touches a slot that was empty. */
function autoFillEmptyFoodSlot() {
  if (nextFoodSlot() >= 0) return;
  const empty = (P.food || []).findIndex((id) => !id);
  if (empty < 0) return;
  const held = Object.keys(P.inv || {})
    .filter((id) => (P.inv[id] || 0) > 0 && ITEMS[id]?.heal && !(P.food || []).includes(id))
    .sort((a, b) => ITEMS[b].heal - ITEMS[a].heal);
  if (held.length) P.food[empty] = held[0];
}

function tryEat(auto) {
  autoFillEmptyFoodSlot();
  const idx = nextFoodSlot();
  const foodId = idx >= 0 ? P.food[idx] : null;
  if (!foodId) { if (!auto) toast("ไม่มีอาหารในช่องเสบียง", "warn"); return false; }
  const max = maxHp();
  if (P.hp >= max) { if (!auto) toast("เลือดเต็มอยู่แล้ว"); return false; }
  P.inv[foodId] -= 1;
  P.hp = Math.min(max, P.hp + Math.round(ITEMS[foodId].heal * (1 + perkTotal("healBonus"))));
  const left = P.inv[foodId] || 0;
  toast(`${auto ? "🤖 กินอัตโนมัติ" : "🍴 กิน"} ${ITEMS[foodId].icon} ${ITEMS[foodId].name} `
    + `+${Math.round(ITEMS[foodId].heal * (1 + perkTotal("healBonus")))} HP (ช่อง ${idx + 1}, เหลือ ${left})`,
    "", "kill");
  if (!left && nextFoodSlot() >= 0) toast(`🍱 ช่อง ${idx + 1} หมด — สลับไปช่อง ${nextFoodSlot() + 1} อัตโนมัติ`, "", "kill");
  renderInventory();
  updateCombatPanel();
  updateTopbar();
  return true;
}

/* 🐛 [owner 2026-08-23, while asking for an FPS setting to save battery] Attack scheduling
 * used to be `next = now + interval`, and `now` is whatever moment the 250ms tick happened to land
 * on — so every interval was silently rounded UP to the next tick. Measured against this game's ten
 * real attack intervals: 2.9% of all damage lost on average, 7.1% on the worst one, for the whole
 * history of the game. Nobody could see it; it just meant a 2.8s weapon swung every 3.0s.
 *
 * Worse for what was being asked for: the loss scales with the tick, so a slower tick to save
 * battery would have quietly bought that battery with damage — 6.4% average at 500ms, 13.6% at
 * 1000ms. A setting that costs you damage without saying so is not a setting, it is a nerf.
 *
 * Carrying the remainder instead of discarding it decouples the two: the average rate is now exact
 * whatever the tick rate is, so the battery setting is genuinely free AND the existing 250ms tick
 * gets its 2.9% back.
 *
 * The clamp is what stops that from becoming a different bug. A backgrounded tab throttles timers
 * to once a minute or stops them, and on return an uncarried schedule would be minutes behind and
 * fire every queued attack in one tick. Falling more than one full interval behind re-bases, which
 * is the old behaviour exactly where the old behaviour was right. */
function nextAt(prev, now, interval) {
  const carried = prev + interval;
  return now - carried > interval ? now + interval : carried;
}

function combatTick(now, slotIdx) {
  const C = slotRT(slotIdx).fight;
  noteActivity(`combat:${C.locId}:${C.stageIdx}`);
  const loc = findLocation(C.locId);
  const stage = C.stage;

  const traits = stage.traits || {};

  // 🛡️ armored: blows land soft until enough connect without the boss answering back.
  const armorMult = () => (traits.armored && C.streak < traits.armored.hits) ? traits.armored.taken : 1;

  if (now >= C.pNext) {
    const dmg = Math.max(1, Math.round(totalDmg() * rand(0.7, 1.3) * armorMult()));
    C.monHp -= dmg;
    C.streak++;
    C.pNext = nextAt(C.pNext, now, PLAYER_ATTACK_INTERVAL * 1000);
    hitFx("#f-mon", dmg, "dmg-out");
    if (traits.armored && C.streak === traits.armored.hits) toast(`🛡️ เกราะของ ${stage.name} แตกแล้ว!`, "", "combat");
    if (C.monHp <= 0) { onKill(loc, stage, C, slotIdx); return; }
  }

  // The companion strikes on its own rhythm and eats from your provisions when hurt.
  const pet = petReady();
  if (pet && now >= C.petNext) {
    const ps = petStats(pet);
    /* Its own swing count, so the heavy blow lands on the companion's rhythm rather than being
     * shaken loose by how fast the player happens to be hitting. */
    C.petHits = (C.petHits || 0) + 1;
    const sk = ps.skills;

    /* Combo before heavy: a companion that has learned to strike several times does that INSTEAD of
     * winding up one big blow, not as well as. Otherwise the two land together on shared multiples
     * and produce a spike nobody designed. */
    const combo = sk.combo && C.petHits % sk.combo.every === 0 ? sk.combo : null;
    const heavy = !combo && sk.heavy && C.petHits % sk.heavy.every === 0 ? sk.heavy : null;
    const hits = combo ? combo.value : 1;
    const mult = heavy ? heavy.value : 1;

    let pdmg = 0;
    for (let h = 0; h < hits; h++) {
      pdmg += Math.max(1, Math.round(ps.atk * rand(0.7, 1.3) * armorMult() * mult));
    }
    C.monHp -= pdmg;
    C.petNext = nextAt(C.petNext, now, petAttackInterval(ps.lv));
    hitFx("#f-mon", pdmg, "dmg-pet");
    if (combo) toast(`${combo.icon} ${ps.name} ปล่อย${combo.name}! ${pdmg} ดาเมจ`, "", "combat");
    else if (heavy) toast(`${heavy.icon} ${ps.name} ปล่อย${heavy.name}! ${pdmg} ดาเมจ`, "", "combat");

    /* 🎯 [owner 2026-08-22] "ฮีล ซึ่งใช้ฮีลตัวเองและเจ้าของได้" — both, on the companion's own
     * rhythm. Capped at each side's own maximum so it tops up rather than overflows, and it reports
     * only what it actually restored: healing for zero and announcing it is worse than silence. */
    if (sk.heal && C.petHits % sk.heal.every === 0) {
      const petGain = Math.min(ps.maxHp - pet.hp, Math.round(ps.maxHp * sk.heal.value));
      const ownGain = Math.min(maxHp() - P.hp, Math.round(maxHp() * sk.heal.value));
      if (petGain > 0) pet.hp += petGain;
      if (ownGain > 0) { P.hp += ownGain; hitFx("#f-me", -ownGain, "heal-mon"); updateTopbar(); }
      if (petGain > 0 || ownGain > 0) {
        toast(`${sk.heal.icon} ${ps.name} ใช้${sk.heal.name}`
          + (ownGain > 0 ? ` — ฟื้นให้คุณ ${ownGain}` : "")
          + (petGain > 0 ? `${ownGain > 0 ? " และ" : " — ฟื้น"}ตัวเอง ${petGain}` : ""), "", "combat");
      }
    }

    if (pet.hp / ps.maxHp < PET_EAT_BELOW) petEat();
    if (C.monHp <= 0) { onKill(loc, stage, C, slotIdx); return; }
  }

  // 😡 enrage: a wounded boss hits far harder for the rest of the fight.
  if (traits.enrage && !C.enraged && C.monHp / stage.hp <= traits.enrage.at) {
    C.enraged = true;
    toast(`😡 ${stage.name} เข้าสู่โหมดคลั่ง! แรงขึ้น ${traits.enrage.mult} เท่า`, "warn", "combat");
  }
  // 🩸 drain: healing on a rhythm punishes a damage race that is too slow.
  if (traits.drain && now >= C.drainNext) {
    C.drainNext = now + traits.drain.every * 1000;
    const healed = Math.round(stage.hp * traits.drain.pct);
    C.monHp = Math.min(stage.hp, C.monHp + healed);
    hitFx("#f-mon", -healed, "heal-mon");
  }
  if (now >= C.mNext) {
    const rage = C.enraged ? traits.enrage.mult : 1;
    /* A monster that has learned to fear us flinches — see monsterFearsUs. Applied to the raw
     * roll rather than after defence, so the reduction scales with the hit instead of being
     * swallowed whole by armour on small monsters and invisible on large ones. */
    const fear = baneDamageMult(C.locId, C.stageIdx);
    const raw = Math.max(1, Math.round(stage.dmg * rand(0.7, 1.3) * rage * fear));
    C.streak = 0;                       // being hit resets the armour-breaking streak
    C.mNext = nextAt(C.mNext, now, stage.interval * 1000);

    // A living companion soaks a share of the blow against its own defence and HP.
    let toPlayer = raw;
    const petNow = petReady();
    if (petNow) {
      const ps = petStats(petNow);
      const share = Math.round(raw * PET_DAMAGE_SHARE);
      const petHit = Math.max(1, share - ps.def);
      petNow.hp -= petHit;
      toPlayer = raw - share;
      hitFx("#f-pet", petHit, "dmg-in");
      if (petNow.hp <= 0) {
        petNow.hp = 0;
        toast(`${ps.icon} ${ps.name} หมดแรง — พักจนกว่าจะได้กินอาหาร`, "warn", "combat");
      } else if (petNow.hp / ps.maxHp < PET_EAT_BELOW) petEat();
    }

    // Flat defence with a floor: gear softens hits but never zeroes them.
    const dmg = Math.max(Math.ceil(toPlayer * DEF_FLOOR_FRACTION), toPlayer - totalDef());
    P.hp -= dmg;
    hitFx("#f-me", dmg, "dmg-in");
    if (P.hp > 0 && P.hp / maxHp() < (P.autoEatPct ?? AUTO_EAT_DEFAULT)) tryEat(true);
    if (P.hp <= 0) {
      P.hp = Math.max(1, Math.round(maxHp() * 0.25));
      toast(`💀 พ่ายแพ้ให้ ${stage.name} — ถอยกลับมารักษาตัว (เหลือ HP 25%)`, "warn");
      stopSlot(slotIdx);
      updateTopbar();
      return;
    }
  }
  updateCombatPanel();
  updateTopbar();
}

/* One mark per monster per difficulty, at the kill that crosses the threshold. Marks are NOT taken
 * by a rebirth — they are what you learned about the animal, not what you were carrying. */
function awardSlayerMark(loc, stage, key) {
  const ti = ELITE_MODES.findIndex((m) => m.id === P.eliteMode);
  const need = SLAYER_TIERS[ti];
  if (!need) return;
  const mark = `${key}:${P.eliteMode}`;
  /* 🎯 [owner 2026-08-17: "ต้องเล่นจากโหมดเฉพาะ เช่น สไลม์ ชั้นยอด ตั้งนับ 1 ใหม่ ... ไม่ใช่ล่าโหมด
   * ปกติแล้วได้รางวัลนั้น"] These are NOT the kill counters the rest of the game uses. Those already
   * hold thousands of kills made before this system existed, and reading them would have paid out
   * for hunting that was never done under these rules. A separate tally, from zero, per mode. */
  P.slayerKills = P.slayerKills || {};
  P.slayerKills[mark] = (P.slayerKills[mark] || 0) + 1;
  if (P.slayer?.[mark]) return;
  if (P.slayerKills[mark] < need.kills) return;
  P.slayer = P.slayer || {};
  P.slayer[mark] = true;
  invalidateSlayer();
  const rk = slayerRewardKey(loc.id, stage.id);
  const r = SLAYER_REWARDS[rk];
  toast(`${r.icon} รอยสังหาร ${stage.name} (${ELITE_MODES[ti].name}) — ${r.name}ถาวร +${r.per[ti]}`, "levelup");
}

function onKill(loc, stage, C, slotIdx) {
  // Normal kills drive stage unlocks; every tier also keeps its own tally for elite gating.
  const key = `${loc.id}:${C.stageIdx}`;
  if (P.eliteMode === "normal") P.kills[key] = (P.kills[key] || 0) + 1;
  const tierKey = `${key}:${P.eliteMode}`;
  P.kills[tierKey] = (P.kills[tierKey] || 0) + 1;
  awardSlayerMark(loc, stage, key);

  const gold = Math.round(randInt(stage.gold[0], stage.gold[1])
    * (1 + charmValue("gold") + perkTotal("goldBonus")));
  P.gold += gold;
  bump("kills"); bump("goldEarned", gold);
  bump(`kill:${loc.id}:${loc.stages[C.stageIdx].id}`);
  if (stage.boss) bump("bosses");
  const got = [`💰 ${gold}`];
  for (const drop of stage.loot) {
    if (Math.random() < drop.chance) {
      const n = randInt(drop.n[0], drop.n[1]);
      P.inv[drop.item] = (P.inv[drop.item] || 0) + n;
      got.push(`${ITEMS[drop.item].icon} ${ITEMS[drop.item].name} ×${n}`);
    }
  }

  // A fielded companion is paid out of the player's own training, not on top of it.
  const pet = petReady();
  const share = pet ? (P.petXpShare ?? PET_XP_DEFAULT) : 0;
  const petCut = Math.round(stage.xp * share);
  const stat = COMBAT_STATS.find((x) => x.id === P.trainFocus) || COMBAT_STATS[0];
  const before = statLevel(stat.id);
  P.cb[stat.id] = (P.cb[stat.id] || 0) + (stage.xp - petCut);
  const after = statLevel(stat.id);
  /* 🎯 [owner 2026-08-17: "มันขึ้นรัวๆ"] The fastest-firing toast in the game — one per kill, and a
   * kill takes a couple of seconds — and it was the only one with no category at all, so the
   * settings popup could not touch it. A boss stays untagged on purpose: it is a milestone, not
   * spam, and someone silencing the grind still wants to see the thing they were grinding towards. */
  toast(`${stage.boss ? "👑" : "⚔️"} ล้ม ${stage.name}! +${stage.xp - petCut} XP ${stat.icon}${stat.name}`
    + `${petCut ? ` (แบ่งให้สัตว์เลี้ยง ${petCut})` : ""} · ${got.join(" · ")}`,
    stage.boss ? "levelup" : "", stage.boss ? "" : "kill");
  if (after > before) {
    P.hp = maxHp();
    toast(`🎉 ${stat.icon} ${stat.name} เพิ่มเป็นขั้น ${after}! HP เต็ม ${maxHp()}`, "levelup");
  }
  if (!stage.boss && P.kills[key] === KILLS_TO_UNLOCK_NEXT_STAGE) {
    toast(`🗝️ ปราบ ${stage.name} ครบ ${KILLS_TO_UNLOCK_NEXT_STAGE} — เปิดทางไปด่านถัดไปแล้ว!`, "levelup");
  }
  if (stage.boss) toast(`🏆 พิชิตบอสแห่ง${loc.name}!`, "levelup");

  if (pet && petCut > 0) {
    const before = petLevel(pet);
    pet.xp += petCut;
    const after = petLevel(pet);
    if (after > before) {
      const ps = petStats(pet);
      pet.hp = ps.maxHp;   // a level-up patches it up
      toast(`${ps.icon} ${ps.name} เก่งขึ้นเป็นขั้น ${after}! (🗡️${ps.atk} 🛡️${ps.def} ❤️${ps.maxHp})`, "levelup");
    }
  }
  rollPetDrop(loc, stage);
  checkAchievements();

  const now = performance.now();
  C.monHp = stage.hp;
  C.pNext = now + 900;
  C.mNext = now + 1600;
  C.petNext = now + 1300;
  C.drainNext = now + 4000;
  C.streak = 0;
  C.enraged = false;
  refreshSidebar();
  renderInventory();
  if (after > before || P.kills[key] === KILLS_TO_UNLOCK_NEXT_STAGE) renderViewAuto();
  updateCombatPanel();
  updateTopbar();
}

/* ---------- Main tick ---------- */

let lastAutoEatAt = 0;
function tick() {
  if (!P) return;
  if (paused) return;
  const now = performance.now();
  // Play time counts wall-clock while the game is open — the honest number for an online-only game.
  const wall = Date.now();
  P.playMs = (P.playMs || 0) + Math.min(2000, wall - lastPlayTick);
  lastPlayTick = wall;
  if (P.dead) return;             // a finished run keeps its screen; nothing advances

  // Plots grow beside the job slots, not inside them — see the Farming section.
  const dt = lastFarmAt ? Math.min(2, (now - lastFarmAt) / 1000) : 0;
  lastFarmAt = now;
  if (dt) { farmTick(dt); calendarTick(dt); }

  /* 🐛 [fixed 2026-08-17, owner: "โหมดขโมย มันไม่กินเอง"] Auto-eat was an event handler on taking
   * damage — a monster's blow, a failed steal — so arriving somewhere already hurt and then not
   * getting hit again left you wounded with three hundred loaves packed. The owner sat at 57/334
   * with a 30% threshold because every steal happened to succeed. It is a standing rule now,
   * checked on the tick like everything else, so "eat below 30%" means what it says wherever you
   * are. Throttled to once a second: unthrottled it would try on every frame the moment the
   * provisions ran out. */
  if (P.hp > 0 && now - lastAutoEatAt > 1000) {
    lastAutoEatAt = now;
    if (P.hp / maxHp() < (P.autoEatPct ?? AUTO_EAT_DEFAULT)) tryEat(true);
  }

  // Iterate from the end: a slot may remove itself mid-tick (materials out, knocked down).
  for (let i = P.slots.length - 1; i >= 0; i--) {
    const sl = P.slots[i];
    if (!sl) continue;
    if (sl.type === "skill" && slotRT(i).startedAt != null) skillTick(now, i);
    else if (sl.type === "combat" && slotRT(i).fight) combatTick(now, i);
  }

  // The stall runs on wall-clock, so it can expire while the player is elsewhere.
  if (P.trader) {
    if (!traderOpen()) {
      P.trader = null;
      toast("🧙 พ่อค้าเร่เก็บแผงเดินทางต่อแล้ว", "", "trader");
      refreshSidebar();
      if (view.kind === "shop") renderViewAuto();
    } else {
      const clock = $("#trader-clock");
      if (clock) clock.textContent = traderSecondsLeft();
      const note = document.querySelector('.skill-tab[data-tab="shop"] [data-shop-note]');
      if (note) note.textContent = `🧙 พ่อค้าเร่! เหลือ ${traderSecondsLeft()}s`;
    }
  }

  // Slow self-regen whenever NOT hunting. 🎯 [retuned 2026-08-15, owner: "ฟื้นไวมากไปหน่อย
  // ไม่ค่อยสมดุล"] Was 1.5% every 2s = full in ~2 minutes, which made food pointless outside
  // a fight. Now 1% every 5s = full in ~8-9 minutes: getting wrecked by a boss costs real
  // downtime, and eating a meal (instant, from cooking) stays the fast lane by design.
  if (combatSlot() < 0 && now - lastRegenAt >= 5000) {
    lastRegenAt = now;
    const max = maxHp();
    if (P.hp < max) {
      P.hp = Math.min(max, P.hp + Math.max(1, Math.ceil(max * 0.01)));
      updateTopbar();
    }
  }
}

/* ---------- Sidebar & topbar ---------- */

/* Sidebar order is the owner's (2026-08-17): shop first, hunting second, the skills, then the
 * money and meta pages, with the bank above achievements. */
let __sidebarOrder = [];      // built order, so a test can assert the layout the owner asked for

function buildSidebar() {
  // Same handover as refreshSidebar, and it has to be here too: this runs on every profile load,
  // AFTER the React shell has mounted, and it used to wipe #skill-tabs and refill it with the
  // legacy markup — leaving a React root attached to a container it no longer owned. The tab order
  // is still recorded, because the keyboard shortcuts and the layout test both read it.
  if (window.__ui) {
    // Straight off the model React renders, so there is exactly one place that decides the order.
    __sidebarOrder = sidebarModel().map((r) => r.id);
    window.__ui.sync();
    return;
  }
  const box = $("#skill-tabs");
  box.innerHTML = "";
  __sidebarOrder = [];

  const simpleTab = (tab, icon, name, noteAttr) => {
    const el = document.createElement("div");
    el.className = "skill-tab";
    el.dataset.tab = tab;
    el.onclick = () => { view = { kind: tab }; if (tab === "combat") combatLoc = null; renderView(); };
    el.innerHTML = `<div class="icon">${icon}</div>
      <div class="info"><div class="name">${name}</div><div class="lvl"${noteAttr ? ` ${noteAttr}` : ""}></div>
      ${tab === "combat" ? '<div class="xpbar"><div style="background:#e86a6a" data-xpfill></div></div>' : ""}</div>`;
    box.appendChild(el);
    __sidebarOrder.push(tab);
    return el;
  };

  simpleTab("shop", "🏪", "ร้านค้า", "data-shop-note");
  simpleTab("combat", "⚔️", "ล่ามอนสเตอร์", "data-lvl");

  for (const skill of SKILLS) {
    const el = document.createElement("div");
    el.className = "skill-tab";
    el.dataset.tab = skill.id;
    // Each skill already carries an accent colour, but it only ever reached the XP bar as an
    // inline background. Exposing it as a custom property lets the stylesheet tint the whole tab
    // — rail, glow, icon — without the colours being duplicated in CSS and drifting from data.js.
    // Same shim guard as renderSkill: smoke_render.mjs builds elements whose `style` is a plain
    // object with no setProperty.
    if (el.style && el.style.setProperty) el.style.setProperty("--accent", skill.accent);
    el.onclick = () => { view = { kind: "skill", skillId: skill.id }; renderView(); };
    el.innerHTML = `
      <div class="icon">${skill.icon}</div>
      <div class="info">
        <div class="name">${skill.name}</div>
        <div class="lvl" data-lvl></div>
        <div class="xpbar"><div style="background:${skill.accent}" data-xpfill></div></div>
      </div>`;
    box.appendChild(el);
    __sidebarOrder.push(skill.id);
  }

  simpleTab("guild", "🏹", "สถาบันฮันเตอร์", "data-guild-note");
  simpleTab("shops", "🏪", "ธุรกิจของเรา", "data-shops-note");
  simpleTab("bank", "🏦", "ธนาคาร/ลงทุน", "data-bank-note");
  simpleTab("tax", "🧾", "ภาษี", "data-tax-note");
  simpleTab("rebirth", "🌀", "การจุติ", "data-rebirth-note");
  simpleTab("ach", "🏆", "ความสำเร็จ", "data-ach-count");
  simpleTab("stats", "📊", "สถิติ", "data-stat-note");
  refreshSidebar();
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * UI bridge — the model the React shell renders
 *
 * The sidebar's per-tab text is real game logic: what the guild is doing, whether a shop is losing
 * money, how much tax is owed. Reimplementing any of it in the React layer would put the same rule
 * in two places, and the copy would drift the first time one of them changed.
 *
 * So the split is: this file decides WHAT each tab says, and the React layer decides how it looks.
 * `sidebarModel()` returns plain data — no DOM, no framework — which also keeps it callable from
 * the Node smoke test.
 *
 * `window.__game` exists because data.js and game.js are classic scripts: `const SKILLS` and
 * `let view` are top-level bindings and never become window properties, so a bundled module cannot
 * see them at all. This is the deliberate, and only, seam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

function xpFrac(xp, lvl) {
  if (lvl >= MAX_LEVEL) return 1;
  const base = xpToReach(lvl), next = xpToReach(lvl + 1);
  return next > base ? (xp - base) / (next - base) : 0;
}

function sidebarModel() {
  if (!P) return [];
  const isSkill = (id) => view.kind === "skill" && view.skillId === id;
  const rows = [];

  rows.push({
    id: "shop", kind: "tab", icon: "🏪", name: T("ร้านค้า"), accent: "#e8b64c",
    note: traderOpen() ? `🧙 ${T("พ่อค้าเร่!")} ${T("เหลือ")} ${traderSecondsLeft()}s`
          : maxSlots() > 1 ? `${T("ช่องงาน")} ${maxSlots()}` : T("อัปเกรดเครื่องมือ"),
    alert: traderOpen(), active: view.kind === "shop",
  });

  const focus = COMBAT_STATS.find((x) => x.id === P.trainFocus) || COMBAT_STATS[0];
  rows.push({
    id: "combat", kind: "tab", icon: "⚔️", name: T("ล่ามอนสเตอร์"), accent: "#e86a6a",
    note: `${T("เลเวล")} ${combatLevel()} · ${T("ฝึก")}${focus.icon}${statLevel(focus.id)}`,
    pct: xpFrac(P.cb[focus.id] || 0, statLevel(focus.id)), active: view.kind === "combat",
  });

  for (const skill of SKILLS) {
    const xp = P.xp[skill.id], lvl = levelFromXp(xp);
    const waiting = !!skill.farming && farmIdleFull();
    rows.push({
      id: skill.id, kind: "skill", icon: skill.icon, name: skill.name, accent: skill.accent,
      note: waiting ? `${T("เลเวล")} ${lvl} · (${T("รอเก็บเกี่ยว")})` : `${T("เลเวล")} ${lvl}`,
      pct: xpFrac(xp, lvl), active: isSkill(skill.id), waiting,
    });
  }

  /* The square sits right after the hunt: it is where the things you gather turn into money, so it
   * belongs next to the places you gather them, not down among the ledgers. */
  const readyJobs = (P.quests || []).filter(questReady).length;
  rows.push({
    id: "village", kind: "tab", icon: "🏘️", name: T("ลานหมู่บ้าน"), accent: "#d98fb0",
    note: readyJobs ? `✅ ${T("ส่งงานได้")} ${readyJobs}` : `${(P.quests || []).length} ${T("งานบนกระดาน")}`,
    alert: readyJobs > 0, active: view.kind === "village",
  });

  const kidsN = (P.kids || []).length;
  rows.push({
    id: "family", kind: "tab", icon: "👨‍👩‍👧", name: T("ครอบครัว"), accent: "#e8a0c8",
    note: spouseIds().length
      ? `${spouseIds().map((id) => VILLAGERS.find((v) => v.id === id)?.name || "คู่ชีวิต").join(" · ")}${kidsN ? ` · ลูก ${kidsN} คน` : ""}`
      : P.pets.length ? `${T("เรากับสัตว์เลี้ยง")} ${P.pets.length}` : T("ยังมีแค่เรา"),
    active: view.kind === "family",
  });

  const g = P.guild;
  const out = guildOn() ? guildSquads().filter((x) => (x.roundsLeft || 0) > 0).length : 0;
  rows.push({
    id: "guild", kind: "tab", icon: "🏹", name: T("สถาบันฮันเตอร์"), accent: "#7cc47f",
    note: !guildOn() ? T("ยังไม่ได้สร้าง") : `${g.roster.length} ${T("คน")} · ${T("ออกล่า")} ${out}`,
    alert: guildOn() && Math.floor(guildPending().gold) > 0, active: view.kind === "guild",
  });

  const owned = P.shops || [];
  rows.push({
    id: "shops", kind: "tab", icon: "🏪", name: T("ธุรกิจของเรา"), accent: "#e8a05f",
    note: !owned.length ? T("ยังไม่ได้เปิดร้าน")
          : `${owned.length} ร้าน · ${owned.reduce((t, x) => t + x.staff.length, 0)} คน`,
    alert: owned.some((x) => (x.lastNet || 0) < 0), active: view.kind === "shops",
  });

  const debt = P.tax?.debtSinceDay != null && P.gold < 0;
  rows.push({
    id: "bank", kind: "tab", icon: "🏦", name: T("ธนาคาร/ลงทุน"), accent: "#5fa8e8",
    note: debt ? `🚨 ${T("ค้างภาษี!")}`
          : `ทรัพย์สิน ${fmtNum(Math.floor(bankBalance()) + Math.round(portfolioValue()))}`,
    alert: debt, active: view.kind === "bank",
  });

  const owed = taxOwedTotal(), acc = taxAccruedTotal();
  rows.push({
    id: "tax", kind: "tab", icon: "🧾", name: T("ภาษี"), accent: "#c8a878",
    note: owed > 0 ? `${taxSeized() ? `🚨 ${T("ถูกยึด")} · ` : ""}${T("ค้าง")} ${fmtNum(owed)}`
          : acc > 0 ? `ปีนี้ ${fmtNum(acc)}` : "ไม่มีค้างชำระ",
    alert: owed > 0, active: view.kind === "tax",
  });

  rows.push({
    id: "rebirth", kind: "tab", icon: "🌀", name: T("การจุติ"), accent: "#c08fe8",
    note: P.rebirths ? `${T("จุติแล้ว")} ${P.rebirths} ${T("ครั้ง")}`
          : canRebirth() ? "พร้อมจุติแล้ว" : `ต้องเลเวลรวม ${rebirthGate()}`,
    alert: !P.rebirths && canRebirth(), active: view.kind === "rebirth",
  });

  const a = achievementProgress();
  rows.push({
    id: "ach", kind: "tab", icon: "🏆", name: T("ความสำเร็จ"), accent: "#e8b64c",
    note: `${a.done}/${a.total} ${T("ปลดแล้ว")}`, active: view.kind === "ach",
  });

  rows.push({
    id: "stats", kind: "tab", icon: "📊", name: T("สถิติ"), accent: "#9aa1c0",
    note: fmtDuration(P.playMs || 0), active: view.kind === "stats",
  });

  return rows;
}

/* How far through its current cycle a running action is, 0..1.
 *
 * Matched by action id, never by grid position. A positional version once pointed the bar at the
 * wrong card in every multi-zone skill: the slot's index counts every action in the skill, while
 * the grid only draws the zone on screen, and the two only line up in a skill's first zone.
 */
function actionProgressFraction(skillId, actionId) {
  const slotIdx = slotOf(skillId, actionId);
  if (slotIdx < 0) return 0;
  const rt = slotRT(slotIdx);
  if (!rt || !rt.startedAt) return 0;
  const dur = effectiveSeconds(skillId, findAction(findSkill(skillId), actionId));
  if (!dur) return 0;
  // performance.now(), not Date.now(). RT[i].startedAt is stamped with performance.now() and the
  // pause handler shifts it by the same clock, so mixing the two made every bar read 100% —
  // the epoch difference is decades, and Math.min clamped it.
  return Math.max(0, Math.min(1, (performance.now() - rt.startedAt) / 1000 / dur));
}

/* One card per action in the open zone, as plain data.
 *
 * Every expression here is lifted verbatim from the loop that used to build the DOM, because these
 * are game rules wearing UI clothing: what "unlocked" means, how mastery converts to a speed bonus,
 * which drop rates scale with level. Re-deriving any of them in the React layer would be the same
 * rule in two places, and the copy drifts the first time one of them changes.
 *
 * `pct` and the mastery numbers are live, so this is also what the 250ms tick reads. React's
 * reconciliation is what makes that affordable: the old note above updateMasteryBar says a full
 * renderSkill per cycle "rebuilds the grid and would fight every click", and that was true of
 * rebuilding DOM by hand. Re-rendering a described tree is not the same operation.
 */
function skillCardsModel() {
  if (!P || view.kind !== "skill") return null;
  const skill = findSkill(view.skillId);
  if (!skill || skill.farming) return null;
  const shown = currentArea(skill);
  const lvl = levelFromXp(P.xp[skill.id]);
  const cards = [];

  for (const action of skill.actions) {
    if (action.area !== shown) continue;
    const unlocked = actionOpen(skill.id, action);
    const running = slotOf(skill.id, action.id) >= 0;
    const mLvl = masteryLevelOf(skill.id, action.id);
    const mXp = P.mastery[masteryKey(skill.id, action.id)] || 0;
    const mBase = masteryXpToReach(mLvl), mNext = masteryXpToReach(mLvl + 1);
    const mFrac = mLvl >= MASTERY_MAX ? 1 : (mXp - mBase) / (mNext - mBase);
    const eff = effectiveSeconds(skill.id, action);
    const outId = action.outputs && !action.catch ? Object.keys(action.outputs)[0] : null;

    const details = [];
    if (outId && ITEMS[outId].slot) {
      details.push(`สวมช่อง${EQUIP_SLOTS.find((s) => s.id === ITEMS[outId].slot).name} · ${statBadge(ITEMS[outId])}`);
    }
    if (action.steal) {
      details.push(`🎯 โอกาสสำเร็จ ${Math.round(Math.min(0.95, action.steal.success + 0.004 * (mLvl - 1)) * 100)}% (ชำนาญแล้วนิ่งมือขึ้น)`);
    }
    for (const r of [].concat(action.rare || [])) {
      details.push(`🌟 ${ITEMS[r.item].icon} ${ITEMS[r.item].name} ${((r.base + r.perLevel * mLvl) * 100).toFixed(2)}%`);
    }

    cards.push({
      id: action.id, skillId: skill.id, accent: skill.accent,
      name: action.name, maxed: mLvl >= MASTERY_MAX, unlocked, running,
      req: unlocked ? null
        : lvl < action.level ? `🔒 เลเวล ${action.level}`
        : `🔒 ชำนาญ "${findAction(skill, action.masteryReq.actionId).name}" ขั้น ${action.masteryReq.level}`,
      seconds: action.seconds,
      effSeconds: eff < action.seconds - 0.05 ? Number(eff.toFixed(1)) : null,
      xp: action.xp,
      io: ioLine(action, skill.id),        // HTML: carries the clickable [data-need] buttons
      details,
      mastery: {
        level: mLvl, frac: mFrac,
        numbers: mLvl >= MASTERY_MAX ? "เต็มขั้นแล้ว" : `${mXp - mBase}/${mNext - mBase} XP`,
        speed: (masteryStepsWorth(mLvl) * MASTERY_SPEED_PER_LEVEL * 100).toFixed(1),
        loot: (action.steal || action.catch || action.junk)
          ? ((masteryLootMult(skill.id, action.id) - 1) * 100).toFixed(0) : null,
        junk: action.junk ? ((1 - masteryJunkMult(skill.id, action.id)) * 100).toFixed(0) : null,
      },
      // The running slot's own elapsed fraction. Matched by action id, never by grid position —
      // a positional assumption here once pointed the bar at the wrong card in every multi-zone
      // skill, because the slot index is not the index within the zone being displayed.
      progress: running ? actionProgressFraction(skill.id, action.id) : 0,
      jumped: highlightAction === `${skill.id}:${action.id}`,
    });
  }
  return { skillId: skill.id, accent: skill.accent, cards };
}

function vitalsModel() {
  if (!P) return null;
  const max = maxHp();
  const hpPct = Math.max(0, Math.min(100, Math.round(P.hp / max * 100)));
  const d = today();
  const ti = titleFor();
  return {
    /* Named `epithet`, not `title`: this object already carries a `title` for the page heading, and
     * the later key silently won — the vitals row read the view's name and the tooltip vanished. A
     * collision that produces plausible output rather than an error is worth the longer word. */
      epithet: ti && {
        icon: ti.icon, name: ti.name,
        /* Every title states what earned it, and the tooltip carries all three tracks separately —
           collapsing them into one number is the bug this replaced. */
        special: ti.track === "bane",
        title: (() => {
          const pr = ti.progress, nx = nextTitle();
          return `${ti.desc}\n`
            + `📖 ความสำเร็จ ${pr.ach}/${pr.achTotal}`
            + ` · 🗡️ รอยล่า ${pr.marksDone}/${pr.marksTotal}`
            + ` · ☠️ สายพันธุ์ที่ล่าจนสุด ${pr.bane}/${pr.baneTotal}`
            + (nx ? (currentLang() === "en" ? `\n${nx.need} more for ${nx.icon} ${nx.name}` : `\nอีก ${nx.need} เป็น ${nx.icon} ${nx.name}`) : `\n${T("ถือครบทุกฉายาแล้ว")}`);
        })(),
      },
    hp: { now: Math.max(0, P.hp), max, pct: hpPct,
          // The three-step colour is the one signal that says "stop and eat" without reading a
          // number, so it stays exactly as it was rather than becoming a theme colour.
          color: hpPct > 50 ? "#5fbf77" : hpPct > 25 ? "#e8b64c" : "#e86a6a" },
    level: {
      value: combatLevel(),
      // Tooltip text is game knowledge, not presentation: after a rebirth the level halves while
      // max HP does not, because gear, charms and achievement perks survive. Two numbers that look
      // contradictory need the explanation next to the rule, not next to the styling.
      title: COMBAT_STATS.map((st) => `${st.icon} ${st.name} ${statLevel(st.id)}`).join(" · ")
        + (P.rebirths ? `\nจุติมาแล้ว ${P.rebirths} ครั้ง — เลเวลเหลือ ${Math.round(REBIRTH_KEEP * 100)}% แต่ของสวมใส่ เครื่องราง`
                      + ` และโบนัสความสำเร็จไม่หาย เลือดสูงสุดจึงไม่ลดตามเลเวล` : ""),
    },
    gold: { text: `${P.gold < 0 ? "-" : ""}${fmtNum(Math.abs(P.gold))}`, debt: P.gold < 0 },
    date: {
      text: `${d.year}Y-${d.month}M-${d.day}D`,
      title: `ปีที่ ${d.year} · เดือน${d.monthName} วันที่ ${d.day} · ${d.season}\n`
        + `1 ปีในเกม = ${Math.round(DAYS_PER_YEAR * GAME_DAY_SECONDS / 3600)} ชม.จริง`
        + ` · 1 เดือน = ${Math.round(DAYS_PER_MONTH * GAME_DAY_SECONDS / 60)} นาที`
        + `\nเวลาเดินเฉพาะตอนเปิดเกม — ปิดหน้าต่างคือหยุด`,
    },
    bag: { count: Object.values(P.inv).filter((n) => n > 0).length, open: view.kind === "bag" },
    paused,
    fullscreen: { supported: fullscreenSupported(), on: isFullscreen() },
    title: { icon: viewIcon(), name: viewName(), flavor: viewFlavor() },
  };
}

/* The heading above the vitals. Pulled out of renderView so React can draw it without the legacy
 * path having to write into #skill-title and #skill-flavor as a side effect of rendering a view. */
function viewIcon() {
  if (view.kind === "skill") { const s = SKILLS.find((x) => x.id === view.skillId); return s ? s.icon : "✨"; }
  return ({ shop: "🏪", combat: "⚔️", guild: "🏹", shops: "🏪", bank: "🏦", tax: "🧾",
            rebirth: "🌀", ach: "🏆", stats: "📊", bag: "🎒" })[view.kind] || "✨";
}
function viewName() {
  if (view.kind === "skill") { const s = SKILLS.find((x) => x.id === view.skillId); return s ? s.name : ""; }
  const row = sidebarModel().find((r) => r.kind !== "skill" && r.id === view.kind);
  return row ? row.name : ({ bag: "กระเป๋าเก็บของ" })[view.kind] || "";
}
function viewFlavor() {
  if (view.kind === "skill") { const s = SKILLS.find((x) => x.id === view.skillId); return s ? s.flavor : ""; }
  return "";
}

window.__game = {
  get ready() { return !!P; },
  sidebar: sidebarModel,
  vitals: vitalsModel,
  cards: skillCardsModel,
  startAction(skillId, actionId) { startAction(skillId, actionId); },
  gotoSource(itemId) { gotoSource(itemId); },
  // The bag remembers where you were, so opening it does not cost you your place. Duplicated from
  // the legacy #bag-chip handler rather than delegating to it, because React replaces that button
  // and delegating would mean calling a click handler on an element that no longer exists.
  toggleBag() {
    if (view.kind === "bag") view = bagReturnView || { kind: "skill", skillId: "wc" };
    else { bagReturnView = { ...view }; view = { kind: "bag" }; }
    renderView();
  },
  togglePause() { setPaused(!paused); },
  settings() { openSettings(); },
  /* The React islands draw their own labels; they translate through the same dictionary. */
  t: T,
  toggleFullscreen() { toggleFullscreen(); },
  select(row) {
    view = row.kind === "skill" ? { kind: "skill", skillId: row.id } : { kind: row.id };
    renderView();
  },
};

function refreshSidebar() {
  // The React shell owns #skill-tabs once it mounts. Every existing caller keeps calling this
  // function -- there are fourteen of them -- so this one line is the whole handover, rather than
  // fourteen edits that could each be missed. The legacy path below stays intact and still runs
  // when the bundle is absent, which is what keeps `python3 server.py` on a bare checkout working.
  if (window.__ui) { window.__ui.sync(); updateTopbar(); return; }
  for (const skill of SKILLS) {
    const tab = document.querySelector(`.skill-tab[data-tab="${skill.id}"]`);
    if (!tab) continue;
    const xp = P.xp[skill.id];
    const lvl = levelFromXp(xp);
    const base = xpToReach(lvl), next = xpToReach(lvl + 1);
    const frac = lvl >= MAX_LEVEL ? 1 : (xp - base) / (next - base);
    // The farming tab carries a waiting state the others cannot have: its plots finish on their
    // own and then sit there. Saying so in the sidebar is the whole point — you are meant to be
    // looking at another skill when it happens.
    const waiting = !!skill.farming && farmIdleFull();
    tab.querySelector("[data-lvl]").textContent =
      (currentLang() === "en" ? (waiting ? `Level ${lvl} · (ready to harvest)` : `Level ${lvl}`)
              : (waiting ? `เลเวล ${lvl} · (รอเก็บเกี่ยว)` : `เลเวล ${lvl}`));
    tab.classList.toggle("farm-waiting", waiting);
    tab.querySelector("[data-xpfill]").style.width = `${Math.round(frac * 100)}%`;
    tab.classList.toggle("active", view.kind === "skill" && skill.id === view.skillId);
  }
  const ct = document.querySelector('.skill-tab[data-tab="combat"]');
  if (ct) {
    const focus = COMBAT_STATS.find((x) => x.id === P.trainFocus) || COMBAT_STATS[0];
    const fXp = P.cb[focus.id] || 0;
    const fLvl = statLevel(focus.id);
    const base = xpToReach(fLvl), next = xpToReach(fLvl + 1);
    const frac = fLvl >= MAX_LEVEL ? 1 : (fXp - base) / (next - base);
    ct.querySelector("[data-lvl]").textContent = (currentLang() === "en" ? `Level ${combatLevel()} · training ${focus.icon}${statLevel(focus.id)}` : `เลเวล ${combatLevel()} · ฝึก${focus.icon}${statLevel(focus.id)}`);
    ct.querySelector("[data-xpfill]").style.width = `${Math.round(frac * 100)}%`;
    ct.classList.toggle("active", view.kind === "combat");
  }
  const tt = document.querySelector('.skill-tab[data-tab="tax"]');
  if (tt) {
    const owed = taxOwedTotal();
    const acc = taxAccruedTotal();
    tt.querySelector("[data-tax-note]").textContent =
      owed > 0 ? `${taxSeized() ? "🚨 ถูกยึด · " : ""}ค้าง ${fmtNum(owed)}`
      : acc > 0 ? `ปีนี้ ${fmtNum(acc)}` : "ไม่มีค้างชำระ";
    tt.classList.toggle("active", view.kind === "tax");
  }
  const at = document.querySelector('.skill-tab[data-tab="ach"]');
  if (at) {
    at.querySelector("[data-ach-count]").textContent =
      (() => { const a = achievementProgress(); return `${a.done}/${a.total} ปลดแล้ว`; })();
    at.classList.toggle("active", view.kind === "ach");
  }
  const stt = document.querySelector('.skill-tab[data-tab="stats"]');
  if (stt) {
    stt.querySelector("[data-stat-note]").textContent = fmtDuration(P.playMs || 0);
    stt.classList.toggle("active", view.kind === "stats");
  }
  const gt = document.querySelector('.skill-tab[data-tab="guild"]');
  if (gt) {
    const g = P.guild;
    const out = guildOn() ? guildSquads().filter((x) => (x.roundsLeft || 0) > 0).length : 0;
    gt.querySelector("[data-guild-note]").textContent = !guildOn()
      ? T("ยังไม่ได้สร้าง")
      : `${g.roster.length} คน · ออกล่า ${out} ทีม`;
    // Money waiting to be collected should pull the eye from the sidebar, like the trader does.
    gt.classList.toggle("trader-on", guildOn() && Math.floor(guildPending().gold) > 0);
    gt.classList.toggle("active", view.kind === "guild");
  }
  const sht = document.querySelector('.skill-tab[data-tab="shops"]');
  if (sht) {
    const owned = P.shops || [];
    sht.querySelector("[data-shops-note]").textContent = !owned.length
      ? "ยังไม่ได้เปิดร้าน"
      : `${owned.length} ร้าน · ${owned.reduce((t, x) => t + x.staff.length, 0)} คน`;
    // A shop that is losing money every day needs to say so from the sidebar, not only when opened.
    sht.classList.toggle("trader-on", owned.some((x) => (x.lastNet || 0) < 0));
    sht.classList.toggle("active", view.kind === "shops");
  }
  const st = document.querySelector('.skill-tab[data-tab="shop"]');
  if (st) {
    st.querySelector("[data-shop-note]").textContent = traderOpen()
      ? `🧙 พ่อค้าเร่! เหลือ ${traderSecondsLeft()}s`
      : maxSlots() > 1 ? `ช่องงาน ${maxSlots()} ช่อง` : "อัปเกรดเครื่องมือ";
    st.classList.toggle("trader-on", traderOpen());
    st.classList.toggle("active", view.kind === "shop");
  }
  const bt = document.querySelector('.skill-tab[data-tab="bank"]');
  if (bt) {
    const debt = P.tax?.debtSinceDay != null && P.gold < 0;
    bt.querySelector("[data-bank-note]").textContent = debt
      ? "🚨 ค้างภาษี!"
      : `ทรัพย์สิน ${fmtNum(Math.floor(bankBalance()) + Math.round(portfolioValue()))}`;
    bt.classList.toggle("trader-on", debt);
    bt.classList.toggle("active", view.kind === "bank");
  }
  const rt = document.querySelector('.skill-tab[data-tab="rebirth"]');
  if (rt) {
    rt.querySelector("[data-rebirth-note]").textContent = P.rebirths
      ? `จุติแล้ว ${P.rebirths} ครั้ง` : canRebirth() ? "พร้อมจุติแล้ว" : `ต้องเลเวลรวม ${rebirthGate()}`;
    rt.classList.toggle("active", view.kind === "rebirth");
  }
  updateTopbar();
}

/* The always-visible vitals: HP (with bar) and gold, top-right of every view. */
function updateTopbar() {
  if (!P) return;
  // React owns the vitals row once it mounts, and its elements are gone from the page. Same
  // handover as the sidebar: one line here rather than a null guard on each of the eight lookups
  // below, and the legacy path stays intact for a checkout with no bundle built.
  if (window.__ui) { window.__ui.sync(); return; }
  const max = maxHp();
  const hpPct = Math.max(0, Math.min(100, Math.round(P.hp / max * 100)));
  $("#hp-chip-text").textContent = `${Math.max(0, P.hp)}/${max}`;
  const fill = $("#hp-chip-fill");
  fill.style.width = `${hpPct}%`;
  fill.style.background = hpPct > 50 ? "#5fbf77" : hpPct > 25 ? "#e8b64c" : "#e86a6a";
  const goldChip = $("#gold-chip");
  goldChip.textContent = `💰 ${P.gold < 0 ? "-" : ""}${fmtNum(Math.abs(P.gold))}`;
  goldChip.classList.toggle("debt", P.gold < 0);
  /* Level sits beside HP so growth reads as one line (owner's ask). It is the average of the
   * three trainable stats — the same number the hunt screen gates on. After a rebirth this drops
   * while max HP does not fall as far, because gear, charms and achievement perks survive the
   * reset; the tooltip spells that out rather than letting the two numbers look contradictory. */
  const lvlChip = $("#lvl-chip");
  if (lvlChip) {
    lvlChip.textContent = `⚔️ lv ${combatLevel()}`;
    lvlChip.title = COMBAT_STATS.map((st) => `${st.icon} ${st.name} ${statLevel(st.id)}`).join(" · ")
      + (P.rebirths ? `\nจุติมาแล้ว ${P.rebirths} ครั้ง — เลเวลเหลือ ${Math.round(REBIRTH_KEEP * 100)}% แต่ของสวมใส่ เครื่องราง`
                    + ` และโบนัสความสำเร็จไม่หาย เลือดสูงสุดจึงไม่ลดตามเลเวล` : "");
  }
  const bagCount = $("#bag-count");
  if (bagCount) bagCount.textContent = Object.values(P.inv).filter((n) => n > 0).length;

  const dateChip = $("#date-chip");
  if (dateChip) {
    const d = today();
    dateChip.textContent = `📅 ${d.year}Y-${d.month}M-${d.day}D`;
    dateChip.title = `ปีที่ ${d.year} · เดือน${d.monthName} วันที่ ${d.day} · ${d.season}\n`
      + `1 ปีในเกม = ${Math.round(DAYS_PER_YEAR * GAME_DAY_SECONDS / 3600)} ชม.จริง`
      + ` · 1 เดือน = ${Math.round(DAYS_PER_MONTH * GAME_DAY_SECONDS / 60)} นาที`
      + `\nเวลาเดินเฉพาะตอนเปิดเกม — ปิดหน้าต่างคือหยุด`;
  }
}

/* ---------- Views ---------- */

/* The accent for the view being opened. Skills carry their own colour in data.js; the rest get one
 * that matches what they are about, and anything unlisted falls back to gold. */
const VIEW_ACCENT = {
  shop: "#e8b64c", combat: "#e86a6a", guild: "#7cc47f", shops: "#e8a05f",
  bank: "#5fa8e8", tax: "#c8a878", rebirth: "#c08fe8", ach: "#e8b64c", village: "#d98fb0", family: "#e8a0c8",
  stats: "#9aa1c0", bag: "#8fd0e8",
};
function setViewAccent() {
  const root = document.documentElement;
  if (!root || !root.style || !root.style.setProperty) return;   // the smoke-test DOM shim
  let accent = VIEW_ACCENT[view.kind] || "#e8b64c";
  if (view.kind === "skill") {
    const s = SKILLS.find((x) => x.id === view.skillId);
    if (s) accent = s.accent;
  }
  root.style.setProperty("--skill-accent", accent);
}

/* The square. Quests today; the people who hand them out are already named so the courting that
 * lands next has somewhere to attach. */
/* 🎯 [owner 2026-08-22] "แยกหัวข้อย่อยเป็น ภารกิจเควส และ ความสัมพันธ์ จะทำให้ดูเล่นง่ายกว่า"
 * Two tabs rather than one long scroll, using the same area-tabs the shop already uses. */
let villagePanel = "quests";

function renderVillage() {
  $("#skill-title").textContent = `🏘️ ${T("ลานหมู่บ้าน")}`;
  $("#skill-flavor").textContent = villagePanel === "quests"
    ? T("รับงานจากคนในหมู่บ้าน — มีของอยู่แล้วก็ส่งได้ทันที")
    : T("ให้ของขวัญเพื่อสนิทขึ้น — แต่ละคนหนุนคนละอย่าง");
  refreshQuests();
  const jobs = P.quests || [];
  const days = (q) => Math.max(0, q.until - questDay());

  const boardSummary = `
    <div class="mastery-summary">
      <span class="m-chip">📜 ${T("งานบนกระดาน")} ${jobs.length}/${QUEST_SLOTS}</span>
      <span class="m-chip">✅ ${T("ส่งได้เลย")} ${jobs.filter(questReady).length}</span>
    </div>`;

  $("#action-grid").innerHTML = jobs.map((q) => {
    const v = questVillager(q);
    const it = ITEMS[q.item];
    const have = sellableCount(q.item);
    const ready = have >= q.qty;
    return `
      <div class="action-card quest-card${ready ? " is-ready" : ""}">
        <div class="q-head">
          <span class="q-face">${iconArt("char", v.id, v.icon, v.name)}</span>
          <span class="q-who">${escapeHtml(v.name)}</span>
          <span class="q-job">${escapeHtml(v.job)}</span>
        </div>
        <div class="q-want">
          <span class="q-item">${it.icon} ${escapeHtml(it.name)} ×${q.qty}</span>
          <span class="q-have${ready ? " ok" : ""}">${T("มี")} ${fmtNum(have)}/${q.qty}</span>
        </div>
        <div class="q-pay">💰 ${fmtNum(q.gold)} · ⚔️ ${fmtNum(q.xp)} XP</div>
        <div class="q-foot">
          <span class="q-left">${days(q) <= 1 ? `⏳ ${T("วันสุดท้าย")}` : (currentLang() === "en" ? `${days(q)} days left` : `เหลือ ${days(q)} วัน`)}</span>
          <button class="btn ${ready ? "primary" : ""}" data-quest="${q.id}">
            ${ready ? T("ส่งงาน") : `${T("ไปหาของ")}${allSources(q.item).length > 1 ? ` (${allSources(q.item).length}${currentLang() === "en" ? "" : " ทาง"})` : ""}`}
          </button>
        </div>
      </div>`;
  }).join("") || `<div class="empty-note">ยังไม่มีงานบนกระดาน — พรุ่งนี้ค่อยมาดูใหม่</div>`;

  /* The people, under the board. Same screen on purpose: the quests are what brings you here, and
   * the relationship is what the quests are quietly building. */
  const people = VILLAGERS.map((v) => {
    const r = relOf(v.id);
    const st = relLabel(v.id, relStage(r.aff));
    /* Both rungs go through relLabel, or the woodcutter is told he is 15 points from being
       your lover. */
    const next = relLabel(v.id, REL_STAGES.find((s) => s.at > r.aff));
    const b = relBonusOf(v.id);
    const wed = isSpouse(v.id);
    const pct = next ? (r.aff - st.at) / (next.at - st.at) * 100 : 100;
    return `
      <div class="villager-card${wed ? " is-wed" : ""}">
        <div class="v-top">
          <span class="v-face">${iconArt("char", v.id, v.icon, v.name, "big")}</span>
          <span class="v-id">
            <b>${escapeHtml(v.name)}${wed ? " 💍" : ""}</b>
            <small>${escapeHtml(v.job)}</small>
          </span>
          <!-- 🎯 [owner 2026-08-22] Marriage is a fact about the two of you, not a rung on the
               affection ladder — so it is stated, not inferred from the stage name. -->
          <span class="v-stage${wed ? " is-wed" : ""}">${wed ? T("แต่งงานแล้ว") : escapeHtml(st.name)}</span>
        </div>
        <div class="v-track"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
        <div class="v-note">${next ? (currentLang() === "en" ? `${next.at - r.aff} more to reach ${escapeHtml(next.name)}` : `อีก ${next.at - r.aff} เป็น${escapeHtml(next.name)}`)
            : wed ? T("คู่ชีวิตของคุณ")
            : canPropose(v.id) ? T("สนิทที่สุดแล้ว — ขอแต่งงานได้") : T("สนิทที่สุดแล้ว")}
          <!-- 🐛 [owner 2026-08-22] A "พื้นจากชาติก่อน" line used to sit here. The floor was
               what a rebirth left you standing on after affection halved; nothing lowers
               affection any more, so it just tracks the current value and the line printed
               the same number twice, labelled as if it meant something. --></div>
        ${b ? `<div class="v-bonus">${escapeHtml(b.label)} +${b.kind === "dmg"
            ? Math.round(b.amount * 10) / 10
            : Math.round(b.amount * 100) + "%"}</div>`
            : `<div class="v-bonus muted">${
                /* 🎯 [owner 2026-08-22] Say WHY there is no bonus yet, per kind of villager.
                   "ยังไม่สนิทพอ" was wrong for someone already at maximum affection who simply
                   has not been married, which is now the state that pays. */
                !v.romance ? T("โบนัสจะโตขึ้นเองเมื่อสนิทกันขึ้น")
                  : canPropose(v.id) ? T("แต่งงานแล้วจะได้โบนัสเต็ม")
                  : T("ยังไม่สนิทพอ")}</div>`}
        <div class="v-acts">
          ${st.at >= REL_STAGES[1].at
            ? `<button class="btn" data-gift="${v.id}"${canGiftToday(v.id) ? "" : " disabled"}>
                 ${canGiftToday(v.id) ? "🎁 ให้ของขวัญ" : "ให้ไปแล้ววันนี้"}</button>`
            : `<button class="btn" disabled>ยังไม่รับของ</button>`}
          ${canPropose(v.id) ? `<button class="btn primary" data-propose="${v.id}">💍 ขอแต่งงาน</button>` : ""}
        </div>
      </div>`;
  }).join("");

  const readyN = jobs.filter(questReady).length;
  const tabs = `
    <div class="area-tabs">
      <button class="area-tab${villagePanel === "quests" ? " active" : ""}" data-vpanel="quests">
        📜 ${T("ภารกิจเควส")}${readyN ? ` (${readyN})` : ""}</button>
      <button class="area-tab${villagePanel === "people" ? " active" : ""}" data-vpanel="people">
        💗 ${T("ความสัมพันธ์")}</button>
    </div>`;
  $("#view-extra").innerHTML = tabs + (villagePanel === "quests"
    ? boardSummary
    : `<div class="villager-grid">${people}</div>`);
  if (villagePanel === "people") $("#action-grid").innerHTML = "";

  $("#view-extra").querySelectorAll("[data-vpanel]").forEach((b) => {
    b.onclick = () => { villagePanel = b.dataset.vpanel; renderView(); };
  });
  $("#action-grid").querySelectorAll("[data-quest]").forEach((b) => {
    b.onclick = () => { if (completeQuest(b.dataset.quest)) renderView(); };
  });
  $("#view-extra").querySelectorAll("[data-gift]").forEach((b) => {
    b.onclick = () => openGiftDialog(b.dataset.gift);
  });
  $("#view-extra").querySelectorAll("[data-propose]").forEach((b) => {
    b.onclick = () => { if (propose(b.dataset.propose)) renderView(); };
  });
}

/* Pick something from the bag to hand over. Shows what each item is worth to THIS person before
 * the player commits — guessing wrong costs affection, and a system that punishes a guess it never
 * let you make is just a tax. */
function openGiftDialog(villagerId) {
  const v = VILLAGERS.find((x) => x.id === villagerId);
  if (!v) return;
  const ids = Object.keys(P.inv).filter((id) => sellableCount(id) > 0)
    .sort((a, b) => giftValue(villagerId, b) - giftValue(villagerId, a));
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">🎁 ให้ของขวัญ ${v.icon} ${escapeHtml(v.name)}</div>
      <div class="modal-sub">ให้ได้วันละชิ้น — ของที่เขาชอบได้ใจมากกว่า ของไร้ค่าทำให้เสียใจ</div>
      <div class="gift-list">
        ${ids.map((id) => {
          const d = giftValue(villagerId, id);
          const tone = d >= REL_GIFT_LOVED ? "loved" : d < 0 ? "bad" : "plain";
          return `<button class="gift-row ${tone}" data-give="${id}">
            <span>${ITEMS[id].icon} ${escapeHtml(ITEMS[id].name)}</span>
            <span class="g-n">×${fmtNum(sellableCount(id))}</span>
            <span class="g-d">${d > 0 ? "+" : ""}${d}</span>
          </button>`;
        }).join("") || `<div class="empty-note">${T("กระเป๋าว่าง — ไปหาของก่อน")}</div>`}
      </div>
      <div class="modal-acts"><button class="btn ghost" data-close>${T("ปิด")}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.querySelectorAll("[data-give]").forEach((b) => {
    b.onclick = () => {
      const res = giveGift(villagerId, b.dataset.give);
      if (!res.ok) { toast(res.why, "warn"); return; }
      toast(`${res.delta > 0 ? "💗" : "💔"} ${v.icon} ${v.name} ${res.delta > 0 ? "ดีใจ" : "ไม่ค่อยชอบ"} `
            + `(${res.delta > 0 ? "+" : ""}${res.delta})`, res.delta > 0 ? "gain" : "warn", "quest");
      if (res.levelUp) toast(`💗 ${v.name} ตอนนี้เป็น${res.levelUp.name}แล้ว`, "levelup", "quest");
      close();
      save("ให้ของขวัญ");
      renderView();
    };
  });
}

/* 🎯 [owner 2026-08-22] "ครอบครัว โดยจะมีเรา เป็นหลัก ถ้ายังไม่มีลูก หรือแฟน มีสัตว์เลี้ยง ที่เราใช้ล่า
 * ... เอาการ์ดใน pet ตอนต่อสู้ มาโชว์ว่าสัตว์เลี้ยงเราตัวโปรดคือตัวไหน"
 *
 * Us first, always. A player with no partner and no children still has a household — themselves and
 * the companion they hunt with — so this page is never empty and never reads as a locked feature. */
function renderFamily() {
  $("#skill-title").textContent = `👨‍👩‍👧 ${T("ครอบครัว")}`;
  $("#skill-flavor").textContent = T("บ้านของเรา — คู่ชีวิต ลูก และเพื่อนร่วมทาง");

  const wives = spouseIds().map((id) => VILLAGERS.find((v) => v.id === id)).filter(Boolean);
  const spouse = wives[0] || null;
  const kids = childrenOf();

  const meCard = `
    <div class="fam-card is-me">
      <div class="fam-face">${iconArt("char", "hero", "🧙", "ตัวละคร", "big")}</div>
      <div class="fam-body">
        <b>${escapeHtml(P.name)}</b>
        <small>${titleFor().icon} ${escapeHtml(titleFor().name)}</small>
        <div class="fam-row">${COMBAT_STATS.map((st) =>
          `<span>${st.icon} ${statLevel(st.id)}</span>`).join("")}</div>
      </div>
    </div>`;

  /* One card per marriage, each showing the children she has and when she may have another —
     the yearly clock belongs to her, so it is read where she is. */
  const spouseCard = wives.length ? wives.map((w) => {
    const hers = kids.filter((k) => k.parent === w.id).length;
    const left = CHILD_MAX - (P.family?.bornThisLife ?? kids.length);
    /* Both gates, because they answer different questions and either can be the one stopping you:
       her own year, and the household's quota for this life. */
    const lastHers = P.family?.lastBirthByWife?.[w.id]
      ?? (wives.length === 1 ? P.family?.lastBirthDay : null);
    const wait = lastHers != null
      ? Math.max(0, Math.ceil(DAYS_PER_YEAR - (questDay() - lastHers))) : 0;
    return `
    <div class="fam-card is-spouse">
      <div class="fam-face">${iconArt("char", w.id, w.icon, w.name, "big")}</div>
      <div class="fam-body">
        <b>💍 ${escapeHtml(w.name)}</b>
        <small>${escapeHtml(w.job)}</small>
        <div class="fam-note">${escapeHtml(REL_BONUS[w.id]?.label || "")}</div>
        <!-- 🎯 [owner 2026-08-23] "โควตารอบไม่ต้องแสดงตรงการ์ด ให้แสดงข้อความล่างสุดพอ" — the card
             answers only what is true of HER: her year, or that she is not trying. The quota belongs
             to the household and is stated once at the bottom of the page. -->
        <small>${hers ? `ลูก ${hers} คน · ` : ""}${wifeOnControl(w.id) ? "คุมกำเนิดอยู่"
          : wait > 0 ? `มีลูกได้อีกใน ${wait} วัน` : "พร้อมมีลูกได้"}</small>
        <div class="wife-acts">
          <button class="btn ghost tiny${wifeOnControl(w.id) ? " on" : ""}" data-control="${w.id}">
            ${wifeOnControl(w.id) ? "🚫 คุมกำเนิดอยู่" : "👶 มีลูกได้"}</button>
        </div>
      </div>
    </div>`;
  }).join("") : `
    <div class="fam-card is-empty">
      <div class="fam-face">💗</div>
      <div class="fam-body"><b>${T("ยังไม่มีคู่ชีวิต")}</b>
        <small>${T("ไปสนิทกับใครสักคนที่ลานหมู่บ้านก่อน")}</small></div>
    </div>`;

  /* 🎯 [owner 2026-08-23] "pet ต้องโชว์ในการ์ดสัตว์เลี้ยงในของครอบครัว เพื่อให้ใช้ปล่อยหรือเปลี่ยน
   * ตัวได้ · pet ของเราก็จะ (ของเรา) · pet ของลูกก็จะ (ของอาริน) ชื่อลูก"
   *
   * This showed the ONE active companion and nothing else, which stopped making sense the moment
   * companions could be given away: a pet living with a child appeared nowhere on the page that is
   * about the household. Every companion now, the player's and the children's, each saying whose it
   * is — and the two things you would come here to do work from here. */
  const petEntry = (pet, ownerLabel, acts, extraClass) => {
    const ps = petStats(pet);
    return `
    <div class="fam-card is-pet${extraClass || ""}">
      <div class="fam-face">${iconArt("pet", pet.species, ps.icon, ps.name, "big")}</div>
      <div class="fam-body">
        <b>${escapeHtml(ps.name)} <span class="pet-owner">${escapeHtml(ownerLabel)}</span></b>
        <small>${T("ขั้น")} ${ps.lv} · ${T("คุณภาพ")} ${escapeHtml(ps.grade?.name || "-")}</small>
        <div class="fam-row"><span>❤️ ${Math.max(0, Math.round(pet.hp))}/${ps.maxHp}</span>
          <span>🗡️ ${ps.atk}</span><span>🛡️ ${ps.def}</span></div>
        <div class="kid-acts">${acts}</div>
      </div>
    </div>`;
  };

  /* 🎯 [owner 2026-08-23] "ในการ์ดครอบครัว สัตว์เลี้ยงไม่ต้องโชว์ทุกตัว โชว์แค่ของเราตัวหลักที่ลง
     สนาม กับของลูกพอ" — listing the whole stable turned the household page into a second pet screen,
     which is what the pet screen is for. What belongs here is the household: the one you field, and
     the ones living with your children. */
  /* 🎯 [owner 2026-08-23] "ในหน้าครอบครัว สัตว์เลี้ยง เอาปุ่มปล่อยออก · เหลือเพียง pet ของลูก ที่
     เอากลับ" — releasing is permanent and belongs where you go to manage companions, not on the page
     you open to look at your household; a destructive button beside a portrait is easy to hit by
     accident. Both ปล่อย and ให้ลูก are on the pet screen, so nothing is stranded by removing them
     here. What stays is the one action that only makes sense from here. */
  const active = P.activePet != null ? P.pets[P.activePet] : null;
  const mine = active ? petEntry(active, `(${T("ของเรา")})`, "", " is-active") : "";

  /* A child's companion is not yours to field, so it gets no "พาตัวนี้ไป" — only the two things
     that are genuinely yours to decide: take it back into the stable, or let it go. */
  const theirs = kids.filter(childPet).map((k) => petEntry(
    childPet(k),
    `(${T("ของ")}${k.name})`,
    `<button class="btn ghost tiny" data-famtake="${k.id}">↩️ ${T("เอากลับ")}</button>`)).join("");

  const petCard = (mine + theirs) || `
    <div class="fam-card is-empty">
      <div class="fam-face">🐾</div>
      <div class="fam-body"><b>${T("ยังไม่มีเพื่อนร่วมทาง")}</b>
        <small>${T("จับสัตว์เลี้ยงได้จากการล่ามอนสเตอร์")}</small></div>
    </div>`;

  const kidCard = (k) => {
    const adult = childIsAdult(k);
    const pct = Math.min(100, (k.age || 0) / CHILD_ADULT_DAY * 100);
    const tracks = CHILD_TRACKS.map((tr) => {
      const lv = childTrackLevel(k, tr.id);
      const nx = childTrainNext(k, tr.id);
      return `
        <div class="edu-row">
          <span class="edu-name">${tr.icon} ${tr.name}</span>
          <span class="edu-lv">${"●".repeat(lv)}${"○".repeat(CHILD_TRACK_MAX - lv)}</span>
          ${nx ? `<button class="btn tiny${P.gold >= nx.cost ? " primary" : ""}"
                    data-train="${k.id}" data-track="${tr.id}">${fmtNum(nx.cost)}</button>`
               : `<span class="edu-max">สุดสาย</span>`}
        </div>`;
    }).join("");
    return `
      <div class="fam-card is-kid">
        <!-- 🎯 [owner 2026-08-23] "ลูกหลังจุติ มันไม่จำเป็นต้องใช้รูป แต่ให้เป็น emoji แทนก็ได้นะ"
             — and it settles something bigger than a look. Art is deliberately partial now ("ไม่ต้อง
             สร้างรูปหมด"): 29 of the 100 names have a portrait. artKindDead blacklists a whole KIND
             after three failures with no success, which exists to stop hammering a deployment that
             ships no art at all — but a household deep enough to be showing artless children could
             trip it and take the portraits that DO exist down with it, for the rest of the session.
             Children from earlier lives ask for no art at all, so the race cannot start. -->
        <div class="fam-face">${childIsThisLife(k)
          ? iconArt("child", childFaceId(k, adult), adult ? "🧑" : "👶", k.name, "big")
          : `<span class="icon-art"><span class="icon-glyph">${adult ? "🧑" : "👶"}</span></span>`}</div>
        <div class="fam-body">
          <b>${escapeHtml(k.name)}</b>
          <small>${adult
            ? `${T("ขั้น")} ${childLevel(k)}/${CHILD_MAX_LEVEL} · ${
                k.nextHunt == null ? T("กำลังจะออกล่า")
                  : Math.max(0, Math.ceil(k.nextHunt - questDay())) > 0
                    ? `${T("ล่าอีก")} ${Math.ceil(k.nextHunt - questDay())} ${T("วัน")}`
                    : T("ออกล่าวันนี้")}`
            : `${T("อายุ")} ${k.age || 0}/${CHILD_ADULT_DAY} ${T("วัน")}`}</small>
          <!-- 🎯 [owner 2026-08-22] "ในตัวของลูก เช่น อาริน ควรมีข้อความเล็กๆ บอกว่าลูกเรากับของใคร"
               — and this is the same thread as the rebirth rule: a child records his mother,
               which is why annulling marriages was wrong. Now the record is visible.
               Falls back rather than guessing: a very old save may have no parent stored. -->
          <small class="kid-parent">${(() => {
            const m = VILLAGERS.find((v) => v.id === k.parent);
            return m ? `${T("ลูกของคุณกับ")}${escapeHtml(m.name)}` : T("ไม่มีบันทึกว่าเป็นลูกกับใคร");
          })()}</small>
          ${adult ? "" : `<div class="kid-track"><div style="width:${pct}%"></div></div>`}
          <div class="fam-row">${COMBAT_STATS.map((st) =>
            `<span>${st.icon} ${adult ? childStat(k, st.id) : ((k.stats || {})[st.id] || 1)}</span>`).join("")}</div>
          <!-- 🎯 [owner 2026-08-23] "ไม่ต้องมีแถบ hp ให้เห็นเพราะเราไม่สนใจ" — no bar, no controls.
               The last three outings are the whole report a child owes you. -->
          ${adult && (k.log || []).length
            ? `<div class="detail kid-log">${k.log.map(escapeHtml).join(" · ")}</div>` : ""}
          <!-- 🎯 [owner 2026-08-23] "แบบนี้จะเพิ่มความสามารถในการหาของได้" — the errand levels are the
               visible half of that promise. Shown only once one has actually moved, so a child who
               has just grown up is not handed a row of zeroes to read. -->
          ${adult && CHILD_ERRANDS.some((e) => childErrandLevel(k, e.id) > 1)
            ? `<div class="fam-row kid-chores">${CHILD_ERRANDS
                .filter((e) => childErrandLevel(k, e.id) > 1)
                .map((e) => `<span title="${escapeHtml(T(e.name))}">${e.icon} ${childErrandLevel(k, e.id)}</span>`)
                .join("")}</div>` : ""}
          <!-- 🎯 [owner 2026-08-23] "pet ก็จะคอยติดตามออกสู้ได้ มี lv เพิ่มได้" — shown on the
               child rather than in the stable, because that is where it lives now and where its
               level climbing is the thing you want to see. -->
          ${(() => {
            const kp = childPet(k);
            if (!kp) return "";
            const ps = petStats(kp);
            return `<div class="kid-pet">${iconArt("pet", kp.species, ps.icon, ps.name)}
              <span>${escapeHtml(ps.name)} · ${T("ขั้น")} ${ps.lv}</span>
              <span class="detail">🗡️ ${ps.atk} · 🛡️ ${ps.def}</span></div>`;
          })()}
          <div class="edu-list">${tracks}</div>
          <div class="kid-acts">
            <button class="btn ghost tiny" data-disown="${k.id}">💔 ${T("ไล่ออกจากตระกูล")}</button>
          </div>
        </div>
      </div>`;
  };

  /* 🎯 [owner 2026-08-22: "หลังแต่งงาน ไม่เห็นค่าใช้จ่ายรายวัน ของภรรยา"] Broken out per head rather
   * than shown as one total, because the player decides how many children to have and how far to
   * school them — a single number gives them nothing to decide with. */
  const up = familyUpkeep();
  const bonusLine = ["dmg", "sellPrice", "xpBonus"]
    .map((kind) => ({ kind, v: childBonusTotal(kind) })).filter((x) => x.v > 0)
    .map((x) => ({ dmg: `🗡️ +${Math.round(x.v * 10) / 10}`,
                   sellPrice: `🪙 +${Math.round(x.v * 100)}%`,
                   xpBonus: `⚒️ +${Math.round(x.v * 100)}%` }[x.kind])).join(" · ");

  $("#view-extra").innerHTML = `
    <div class="mastery-summary">
      <span class="m-chip">👨‍👩‍👧 ${1 + (spouse ? 1 : 0) + kids.length} ${T("คน")}</span>
      <!-- Counts the ones out with the children too: they are still the household's. -->
      <span class="m-chip">🐾 ${T("สัตว์เลี้ยง")} ${P.pets.length + kids.filter(childPet).length}</span>
      ${bonusLine ? `<span class="m-chip">${T("โบนัสจากลูก")} ${bonusLine}</span>` : ""}
      ${up.total ? `<span class="m-chip${familyInArrears() ? " missing" : ""}">🍚 ${T("ค่าเลี้ยงดู")} ${up.total.toLocaleString()}/${T("วัน")}</span>` : ""}
    </div>`;
  /* 🎯 [owner 2026-08-23] "ทำช่องภรรยาเป็น bullet ย่อและแสดงรายละเอียด ... ลูกที่จุติในรอบนี้ มันจะทำ
   * ให้โฟกัสได้ถูกต้อง ... bullet ลูกที่จุติรอบก่อนๆ จะมีรายละเอียดลูกที่โดนย้ายมาหลังจุติทั้งหมด เพราะตาม
   * ปกติหลังจุติแทบไม่ได้มายุ่งกับลูกที่โตแล้ว"
   *
   * The page used to be one flat grid, which is fine at one wife and one child and unreadable at
   * five and forty. Four <details> — the same idiom the difficulty picker uses, so open/close needs
   * no state machine and keyboard and screen readers come for free.
   *
   * The split that matters is by LIFE, not by age: after a rebirth you are working with the new
   * cycle's children, and the grown ones from before are a list you consult rather than tend. */
  const openState = P.ui?.famOpen || {};
  /* Persisted, because this page repaints on every day boundary — a section that closed itself
     while you were reading it would be worse than not folding at all. */
  const fold = (id, icon, title, chips, body, count) => `
    <details class="fam-fold" data-fold="${id}"${openState[id] ? " open" : ""}>
      <summary class="fam-summary">
        <span class="ff-bullet">◆</span>
        <span class="ff-title">${icon} ${escapeHtml(title)}</span>
        <span class="ff-count">${count}</span>
        <span class="ff-chips">${chips}</span>
        <span class="ff-caret">▾</span>
      </summary>
      <div class="fam-grid">${body}</div>
    </details>`;

  const thisLife = kids.filter(childIsThisLife);
  const pastLife = kids.filter((k) => !childIsThisLife(k));
  /* Closed, a section still has to say something true about what is inside it. For the wives that
     is their faces — the owner asked for exactly this — and for the children a count is enough. */
  const faces = (list, kind, idOf, iconOf, nameOf) => list.slice(0, 8).map((x) =>
    `<span class="ff-face">${iconArt(kind, idOf(x), iconOf(x), nameOf(x))}</span>`).join("")
    + (list.length > 8 ? `<span class="ff-more">+${list.length - 8}</span>` : "");

  $("#action-grid").innerHTML =
    `<div class="fam-grid">${meCard}</div>`
    + fold("wives", "\u{1f48d}", T("ภรรยา"), faces(wives, "char", (w) => w.id, (w) => w.icon, (w) => w.name),
           spouseCard, wives.length ? `${wives.length} ${T("คน")}` : T("ยังไม่มี"))
    + fold("kidsNow", "\u{1f476}", T("ลูกที่จุติรอบนี้"),
           faces(thisLife, "child", (k) => childFaceId(k, childIsAdult(k)),
                 (k) => (childIsAdult(k) ? "\u{1f9d1}" : "\u{1f476}"), (k) => k.name),
           thisLife.length ? thisLife.map(kidCard).join("") : `
             <div class="fam-card is-empty"><div class="fam-face">\u{1f476}</div>
               <div class="fam-body"><b>${T("รอบนี้ยังไม่มีลูก")}</b></div></div>`,
           `${thisLife.length}/${CHILD_MAX}`)
    /* 🎯 [owner 2026-08-23] "bullet ลูกที่จุติรอบก่อนๆ จะไม่มีรูปในตอนย่อ มีแค่จำนวนว่ามีกี่คน เพราะ
       มันอาจมีจำนวนเยอะมากจากการจุติหลายรอบ" — no portraits here on purpose. The wives are a handful
       and their faces are the useful summary; this list grows without limit, and a row of faces
       would wrap into a wall in exactly the case the fold exists to tidy. */
    + (pastLife.length ? fold("kidsPast", "\u{1f9d1}", T("ลูกจากรอบก่อนๆ"), "",
           pastLife.map(kidCard).join(""), `${pastLife.length} ${T("คน")}`) : "")
    /* The count says both, because "how many companions does this household have" is now two
       numbers and the interesting one is how many are out with the children. */
    /* Counts what the section actually shows, not what the stable holds — a header that says three
       above a list of two is worse than no header. */
    + fold("pets", "\u{1f43e}", T("สัตว์เลี้ยง"), "", petCard,
           (P.activePet != null && P.pets[P.activePet] ? 1 : 0) + kids.filter(childPet).length
             ? [P.activePet != null && P.pets[P.activePet] ? T("ตัวที่ลงสนาม") : "",
                kids.filter(childPet).length ? `${kids.filter(childPet).length} ${T("อยู่กับลูก")}` : ""]
               .filter(Boolean).join(" · ")
             : T("ยังไม่มี"))
    + (up.total ? `<div class="fam-hint${familyInArrears() ? " is-debt" : ""}">
          🍚 ค่าเลี้ยงดูวันละ <b>${up.total.toLocaleString()}</b> 💰 — ภรรยา ${up.spouse.toLocaleString()}${up.kids ? ` · ลูก ${up.kids} คน ${up.heads.toLocaleString()}` : ""}${up.edu ? ` · ค่าเรียน ${up.edu.toLocaleString()}` : ""}
          ${familyInArrears() ? `<br><b>ค้างจ่าย ${Math.round(P.family.arrears).toLocaleString()} 💰 — โบนัสจากภรรยาและลูกหยุดอยู่</b> จ่ายครบแล้วกลับมาเหมือนเดิม · เงินติดลบครบ ${TAX_GRACE_DAYS} วันคือจบเกม` : ""}
        </div>` : "")
    + (() => {
      /* 🐛 [owner 2026-08-22] "คำอธิบายมันแปลกๆ เพราะเราเพิ่งจุติ" — a two-branch ternary made
         "no wife" and "quota full" the same sentence, so a fresh life with an empty household was
         told it had already had four children. Three states, because there are three. */
      const born = P.family?.bornThisLife ?? 0;
      const left = CHILD_MAX - born;
      const rule = currentLang() === "en"
        ? `Rules: ${CHILD_MAX} children per rebirth — children carried over from a past life do not count`
        : `กฎ: จุติหนึ่งรอบมีลูกได้ ${CHILD_MAX} คน — ลูกที่ติดตัวมาจากชาติก่อนไม่นับ`;
      if (left <= 0) return `<div class="fam-hint">${rule}<br>รอบจุตินี้มีลูกครบแล้ว — จุติใหม่ถึงจะเริ่มนับใหม่</div>`;
      if (!spouseIds().length) return `<div class="fam-hint">${rule}<br>${currentLang() === "en"
        ? `${left} more children possible this rebirth — you need a partner first`
        : `รอบจุตินี้ยังมีลูกได้อีก ${left} คน — ต้องมีคู่ชีวิตก่อน`}</div>`;
      return `<div class="fam-hint">${rule}<br>${currentLang() === "en"
      ? `One child per partner per year · ${Math.round(CHILD_BIRTH_CHANCE * 100)}% chance each day · ${left} more possible this rebirth · the button on a partner card pauses it`
      : `ภรรยาแต่ละคนมีลูกได้ปีละคน · แต่ละวันมีโอกาส ${Math.round(CHILD_BIRTH_CHANCE * 100)}% · รอบจุตินี้ยังมีลูกได้อีก ${left} คน · กดปุ่มบนการ์ดภรรยาเพื่อคุมกำเนิดได้`}</div>`;
    })();

  /* Confirmed, and the dialog names what is lost: this is permanent and refunds nothing spent on
     their schooling, which is not something to find out afterwards. */
  $("#action-grid").querySelectorAll("[data-fold]").forEach((d) => {
    d.addEventListener("toggle", () => {
      P.ui = P.ui || {};
      P.ui.famOpen = P.ui.famOpen || {};
      P.ui.famOpen[d.dataset.fold] = d.open;
    });
  });

  /* 🎯 [owner 2026-08-23] Take-back is the one companion action this page keeps: it is about
     the household rather than about managing a stable, and it is not destructive. Fielding,
     releasing and giving all live on the pet screen — their handlers were removed with their
     buttons rather than left behind waiting for markup that no longer exists. */
  $("#action-grid").querySelectorAll("[data-famtake]").forEach((b) => {
    b.onclick = () => {
      const k = childrenOf().find((x) => x.id === b.dataset.famtake);
      const pet = childPet(k);
      if (!pet) return;
      const st = petStats(pet);
      if (!confirm(`เอา ${st.name} กลับมาจาก ${k.name}?\n\n· ${k.name} จะออกล่าคนเดียว อ่อนลง\n`
          + `· ตัวมันเองไม่เสียขั้นที่สะสมไว้`)) return;
      delete k.pet;
      P.pets.push(pet);
      if (P.activePet == null) P.activePet = P.pets.length - 1;
      toast(`↩️ ${st.icon} ${st.name} กลับมาอยู่กับเราแล้ว`, "", "family");
      save("เอาสัตว์เลี้ยงกลับ");
      renderView();
    };
  });
  $("#action-grid").querySelectorAll("[data-control]").forEach((b) => {
    b.onclick = () => { toggleWifeControl(b.dataset.control); renderView(); };
  });

  $("#action-grid").querySelectorAll("[data-disown]").forEach((b) => {
    b.onclick = () => {
      const k = childrenOf().find((x) => x.id === b.dataset.disown);
      if (!k) return;
      const lv = CHILD_TRACKS.reduce((n, tr) => n + childTrackLevel(k, tr.id), 0);
      const born = P.family?.bornThisLife ?? childrenOf().length;
      const msg = `ไล่ ${k.name} ออกจากตระกูล?\n\n`
        + "· หายถาวร เอากลับมาไม่ได้\n"
        + (lv ? `· ค่าเรียน ${lv} ขั้นที่ลงทุนไปหายไปด้วย ไม่คืนเงิน\n` : "")
        + `· โควตาลูกรอบจุตินี้ไม่คืน (เกิดแล้ว ${born}/${CHILD_MAX})\n`
        + (childPet(k) ? `· ${petStats(childPet(k)).name} จะกลับมาอยู่กับเรา ไม่หายไปด้วย\n` : "")
        + "· ค่าเลี้ยงดูจะลดลงทันที";
      if (!confirm(msg)) return;
      if (disownChild(b.dataset.disown)) renderView();
    };
  });

  $("#action-grid").querySelectorAll("[data-train]").forEach((b) => {
    b.onclick = () => { if (trainChild(b.dataset.train, b.dataset.track)) renderView(); };
  });
}

/* 🐛 [owner 2026-08-23] "ในตอนพิมพ์ เช่น จะฝากเงิน หรือ จะขายของ พิมพ์ตัวเลขได้ แต่ซักพัก
 * ตัวเลขจะหาย ทำให้บางทีพิมพ์ไม่ครบ"
 *
 * Not the notifications — a repaint. Every page rebuild does `grid.innerHTML = ""`, which destroys
 * the <input> node along with whatever is half-typed in it. The bank page is rebuilt on a TIMER:
 * calendarTick fires a render once per game-day, and a game-day is 100 real seconds, so an amount
 * being typed had a fixed deadline nobody could see. On a phone it is worse than losing the digits
 * — rebuilding the focused element under an open keyboard makes the keyboard drop too, so the
 * rest of what you type goes nowhere.
 *
 * The rule is about WHO asked for the repaint. A render the player caused — pressing ฝาก, opening
 * a tab, buying something — must always run: they are looking at the result of their own action.
 * A render the CLOCK caused must not interrupt them mid-number. So the automatic ones come through
 * here, and while a text field has focus they are held and replayed the moment it is released.
 *
 * Held, not dropped: `renderPending` is what makes this different from simply skipping. Whatever
 * the day did — interest, dividends, a new share price — is on screen as soon as the field is no
 * longer being typed in. */
let renderPending = false;

/* Only fields you TYPE into. A checkbox or a button holding focus is not someone entering a value,
   and blocking a daily repaint for the rest of the session because a checkbox was clicked would be
   a worse bug than the one this fixes. */
function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = (el.type || "text").toLowerCase();
  return type === "number" || type === "text" || type === "search" || type === "tel";
}

function renderViewAuto() {
  if (isTypingInField()) { renderPending = true; return; }
  renderPending = false;
  renderView();
}

/* The replay: run the render the clock asked for, now that nobody is typing. */
function flushPendingRender() {
  if (!renderPending || isTypingInField()) return;
  renderPending = false;
  if (P && !P.dead) renderView();
}

/* focusout fires as the field is released — including when the player taps ฝาก on the same page,
   which is exactly when they want to see the current numbers.

   The deferral to the next frame is load-bearing, not tidiness: focusout fires BEFORE click, so
   repainting on the blur itself would rebuild the page — button included — out from under a tap
   that has not landed yet, and the deposit would simply not happen. Fixing a lost number by
   swallowing the button press would be the worse bug. */
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("focusout", () => {
    if (renderPending) setTimeout(flushPendingRender, 0);
  });
}

function renderView() {
  // Every view gets an accent, not just the skills. The stylesheet tints borders, section rules and
  // zone tabs from --skill-accent, and setting it only in renderSkill meant the shop, the bank and
  // the hunt wore whichever skill you happened to open last.
  setViewAccent();
  const bag = $("#bag-panel");
  if (bag) bag.style.display = view.kind === "bag" ? "block" : "none";
  // A finished run takes over the whole screen — there is nothing left to interact with.
  if (P.dead) { renderDead(); refreshSidebar(); updateBanner(); return; }
  // Farming shares the skill tab strip but not the action-card layout: its unit of play is a
  // plot you come back to, not a job you leave running.
  if (view.kind === "skill" && view.skillId === "fa") renderFarm();
  else if (view.kind === "skill") renderSkill();
  else if (view.kind === "combat") renderCombat();
  else if (view.kind === "ach") renderAchievements();
  else if (view.kind === "stats") renderStats();
  else if (view.kind === "bag") renderBag();
  else if (view.kind === "bank") renderMoney();
  else if (view.kind === "tax") renderTax();
  else if (view.kind === "rebirth") renderRebirth();
  else if (view.kind === "shops") renderShops();
  else if (view.kind === "guild") renderGuild();
  else if (view.kind === "village") renderVillage();
  else if (view.kind === "family") renderFamily();
  else renderShop();
  refreshSidebar();
  updateBanner();
}

function ioLine(action, skillId) {
  // Percentages shown are the ones the engine will actually roll, mastery included, so a step
  // visibly moves the card the player is looking at.
  const junkPct = (base) => Math.round(base * masteryJunkMult(skillId, action.id) * 1000) / 10;
  if (action.catch) {
    const table = effectiveCatch(skillId, action);
    const total = table.reduce((t, c) => t + c.w, 0);
    const list = table
      .map((c) => `${ITEMS[c.item].icon} ${ITEMS[c.item].name} ${(c.w / total * 100).toFixed(1)}%`)
      .join(" · ");
    return `${T("ได้")} ${list}${action.junk ? ` · 🗑️ ขยะ ${junkPct(action.junk)}%` : ""}`;
  }
  if (action.steal) {
    const st = action.steal;
    const lootTxt = (st.loot || []).map((d) =>
      `${ITEMS[d.item].icon} ${(effectiveLootChance(skillId, action.id, d.chance) * 100).toFixed(1)}%`).join(" ");
    return `ได้ 💰 ${st.gold[0]}-${st.gold[1]}${lootTxt ? " · แถม " + lootTxt : ""}`
      + `${st.junk ? ` · 🗑️ ${junkPct(st.junk)}%` : ""} · พลาดเจ็บ -${st.failDmg} HP`;
  }
  const outs = Object.entries(action.outputs).map(([id, n]) => `${ITEMS[id].icon} ×${n}`).join(" ");
  if (!action.inputs) return `${T("ได้")} ${outs}`;
  const ins = Object.entries(action.inputs).map(([id, n]) => {
    const have = P.inv[id] || 0;
    if (have >= n) return `<span>${ITEMS[id].icon} ×${n} (มี ${have})</span>`;
    const where = sourceLabel(id);
    return `<button class="need" data-need="${id}"${where ? ` title="ไปที่ ${where}"` : ""}>`
      + `${ITEMS[id].icon} ×${n} (มี ${have}) ${where ? "➜" : ""}</button>`;
  }).join(" + ");
  return `ใช้ ${ins} → ${outs}`;
}

function statBadge(item) {
  const bits = [];
  if (item.dmg) bits.push(`🗡️+${item.dmg}`);
  if (item.def) bits.push(`🛡️+${item.def}`);
  if (item.hpBonus) bits.push(`❤️+${item.hpBonus}`);
  if (item.heal) bits.push(`❤️${T("ฟื้น")} ${item.heal}`);
  return bits.join(" ");
}

function renderSkill() {
  // Same idea as the sidebar: let the whole skill view pick up the accent from data.js.
  // Guarded because smoke_render.mjs runs this file under a hand-written DOM shim that has no
  // documentElement — an unguarded reach for it took out every check that opens a skill page.
  const __sk = SKILLS.find((s) => s.id === view.skillId);
  if (__sk && document.documentElement && document.documentElement.style) {
    document.documentElement.style.setProperty("--skill-accent", __sk.accent);
  }
  const skill = findSkill(view.skillId);
  // Skills that can wound the player get the provisions panel, since auto-eat applies there.
  const woundsPlayer = skill.actions.some((a) => a.steal);
  const lvl = levelFromXp(P.xp[skill.id]);
  $("#skill-title").textContent = `${skill.icon} ${skill.name}`;
  $("#skill-flavor").textContent = skill.flavor;

  const mLevels = skill.actions.map((a) => masteryLevelOf(skill.id, a.id));
  const mSum = mLevels.reduce((t, x) => t + x, 0);
  const mCap = skill.actions.length * MASTERY_MAX;
  const mMaxed = mLevels.filter((x) => x >= MASTERY_MAX).length;
  const extra = $("#view-extra");
  extra.innerHTML = "";
  if (woundsPlayer) renderFoodPanel(extra);
  const summary = document.createElement("div");
  summary.innerHTML = `
    <div class="mastery-summary">
      <span class="m-chip">⭐ ${T("ความชำนาญรวมของสายนี้")}</span>
      <div class="m-track">
        <div class="m-bar"><div data-msumfill style="width:${Math.round(mSum / mCap * 100)}%; background:${skill.accent}"></div></div>
        <div class="m-nums" data-msumnums>${T("ขั้นรวม")} ${mSum}/${mCap} (${(mSum / mCap * 100).toFixed(1)}%)
          · ${T("ช่องที่ MAX แล้ว")} ${mMaxed}/${skill.actions.length}</div>
      </div>
    </div>`;
  extra.appendChild(summary.firstElementChild);

  // Sub-menu: one chip per zone, showing how much of it is open, then only that zone's cards.
  const areas = areasOf(skill);
  const shown = currentArea(skill);
  if (areas.length > 1) {
    const bar = document.createElement("div");
    bar.className = "area-tabs";
    bar.innerHTML = areas.map((ar) => {
      const acts = skill.actions.filter((a) => a.area === ar);
      const open = acts.filter((a) => actionOpen(skill.id, a)).length;
      const maxed = acts.every((a) => masteryLevelOf(skill.id, a.id) >= MASTERY_MAX);
      /* 🐛 [audit-qa 2026-08-22] The LABEL goes through T(); the data-area attribute must not.
       * `area` is the key every card on this page is filtered by (action.area === shown, openArea,
       * the click handler that reads dataset.area back), which is why i18n.js does not walk it —
       * and why the tab used to print the raw Thai even in English mode. Two zone names had already
       * been translated in the dictionary and could never appear on screen. */
      return `<button class="area-tab${ar === shown ? " active" : ""}${open ? "" : " shut"}" data-area="${escapeHtml(ar)}">
        <span style="color:${skill.accent}">◆</span> ${escapeHtml(T(ar))}
        <span class="area-count">${maxed ? "✅" : `${open}/${acts.length}`}</span></button>`;
    }).join("");
    extra.appendChild(bar);
    bar.querySelectorAll("[data-area]").forEach((b) => b.onclick = () => {
      openArea[skill.id] = b.dataset.area;
      renderSkill();
    });
  }

  const grid = $("#action-grid");
  grid.innerHTML = "";
  // React draws these cards into #skill-grid-root. The grid is still cleared above, because every
  // other view renders into it and leaving one view's cards under another's is worse than an empty
  // container.
  if (window.__ui) { window.__ui.sync(); highlightAction = null; return; }
  for (const action of skill.actions) {
    if (action.area !== shown) continue;
    const unlocked = actionOpen(skill.id, action);
    const running = slotOf(skill.id, action.id) >= 0;
    const mLvl = masteryLevelOf(skill.id, action.id);
    const mXp = P.mastery[masteryKey(skill.id, action.id)] || 0;
    const mBase = masteryXpToReach(mLvl), mNext = masteryXpToReach(mLvl + 1);
    const mFrac = mLvl >= MASTERY_MAX ? 1 : (mXp - mBase) / (mNext - mBase);
    const eff = effectiveSeconds(skill.id, action);
    const timeLabel = eff < action.seconds - 0.05
      ? `<s>${action.seconds}s</s> ${eff.toFixed(1)}s` : `${action.seconds}s`;
    const outId = action.outputs && !action.catch ? Object.keys(action.outputs)[0] : null;
    const gearLine = outId && ITEMS[outId].slot
      ? `<div class="detail">สวมช่อง${EQUIP_SLOTS.find((s) => s.id === ITEMS[outId].slot).name} · ${statBadge(ITEMS[outId])}</div>` : "";
    const stealLine = action.steal
      ? `<div class="detail">🎯 โอกาสสำเร็จ ${Math.round(Math.min(0.95, action.steal.success + 0.004 * (mLvl - 1)) * 100)}% (ชำนาญแล้วนิ่งมือขึ้น)</div>` : "";
    const rareLine = action.rare
      ? [].concat(action.rare).map((r) =>
          `<div class="detail">🌟 ${ITEMS[r.item].icon} ${ITEMS[r.item].name} `
          + `${((r.base + r.perLevel * mLvl) * 100).toFixed(2)}%</div>`).join("") : "";

    const card = document.createElement("div");
    card.className = "action-card" + (running ? " running" : "") + (unlocked ? "" : " locked");
    card.innerHTML = `
      <div class="head">
        <div class="name">${mLvl >= MASTERY_MAX ? "✅ " : ""}${action.name}</div>
        <div class="req">${unlocked ? timeLabel
          : levelFromXp(P.xp[skill.id]) < action.level ? `🔒 เลเวล ${action.level}`
          : `🔒 ชำนาญ "${findAction(skill, action.masteryReq.actionId).name}" ขั้น ${action.masteryReq.level}`}</div>
      </div>
      <div class="detail">+${action.xp} XP ต่อรอบ</div>
      <div class="io">${ioLine(action, skill.id)}</div>
      ${gearLine}
      ${stealLine}
      ${rareLine}
      <div class="mastery-row">
        <span class="m-chip" data-mchip="${action.id}">⭐ ขั้น ${mLvl}${mLvl >= MASTERY_MAX ? " MAX" : ""}</span>
        <div class="m-track">
          <div class="m-bar"><div data-mfill="${action.id}" style="width:${Math.round(mFrac * 100)}%; background:${skill.accent}"></div></div>
          <div class="m-nums" data-mnums="${action.id}">${mLvl >= MASTERY_MAX ? "เต็มขั้นแล้ว" : `${mXp - mBase}/${mNext - mBase} XP`}
            · เร็วขึ้น ${(masteryStepsWorth(mLvl) * MASTERY_SPEED_PER_LEVEL * 100).toFixed(1)}%${
              action.steal || action.catch || action.junk
                ? ` · ของดี +${((masteryLootMult(skill.id, action.id) - 1) * 100).toFixed(0)}%`
                  + (action.junk ? ` · ขยะ -${((1 - masteryJunkMult(skill.id, action.id)) * 100).toFixed(0)}%` : "")
                : ""}</div>
        </div>
      </div>
      <div class="progress" data-progress="${action.id}" style="background:${skill.accent}"></div>`;
    if (unlocked) card.onclick = () => startAction(skill.id, action.id);
    // Material buttons must not also trigger the card's own start-this-action click.
    card.querySelectorAll("[data-need]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      gotoSource(b.dataset.need);
    });
    if (highlightAction === `${skill.id}:${action.id}`) {
      card.classList.add("jumped");
      setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
    }
    grid.appendChild(card);
  }
  highlightAction = null;
}

/* --- Farm view: the plots, then the seed stall --------------------------------
 * Selected seed lives in module state rather than the profile: it is a UI cursor, not progress,
 * and a save file should not carry "which seed was highlighted". */
let farmSeed = null;

function farmSeedChoice() {
  const open = FARM().actions.filter((a) => actionOpen("fa", a));
  if (farmSeed && open.some((a) => a.id === farmSeed)) return farmSeed;
  // Default to the best unlocked crop the player actually has seeds for, else the best unlocked.
  const owned = open.filter((a) => (P.inv[Object.keys(a.inputs)[0]] || 0) > 0);
  return (owned.length ? owned : open).slice(-1)[0]?.id || null;
}

/* Only the bar widths change 4x a second — re-rendering the whole garden that often would fight
 * every click the player makes. */
function updatePlotBars() {
  for (let i = 0; i < maxPlots(); i++) {
    const fill = document.querySelector(`[data-plot-fill="${i}"]`);
    if (!fill) continue;
    const pl = P.plots[i];
    if (!pl) { fill.style.width = "0%"; continue; }
    const need = growSeconds(pl.actionId);
    fill.style.width = `${Math.round(Math.min(1, pl.grown / need) * 100)}%`;
    const clock = document.querySelector(`[data-plot-clock="${i}"]`);
    if (clock) clock.textContent = pl.grown >= need
      ? "พร้อมเก็บ ✅" : `อีก ${Math.ceil(need - pl.grown)}s`;
  }
}

function renderFarm() {
  const skill = FARM();
  const lvl = levelFromXp(P.xp.fa);
  $("#skill-title").textContent = `${skill.icon} ${skill.name}`;
  $("#skill-flavor").textContent = skill.flavor;

  const n = maxPlots();
  const ready = readyPlots();
  const busy = P.plots.slice(0, n).filter(Boolean).length;
  const pick = farmSeedChoice();
  const extra = $("#view-extra");
  extra.innerHTML = "";

  // --- seed picker: every crop the player has unlocked, with how many seeds are in the bag ---
  const picker = document.createElement("div");
  picker.className = "seed-picker";
  const opts = skill.actions.map((a) => {
    const open = actionOpen("fa", a);
    const seedId = Object.keys(a.inputs)[0];
    const have = P.inv[seedId] || 0;
    const [cropId, yieldN] = Object.entries(a.outputs)[0];
    const gate = !open
      ? (lvl < a.level ? `🔒 เลเวล ${a.level}`
         : `🔒 ${findAction(skill, a.masteryReq.actionId).name} ขั้น ${a.masteryReq.level}`)
      : `${ITEMS[seedId].icon} มี ${have}`;
    return `<button class="seed-opt${a.id === pick ? " active" : ""}${open ? "" : " shut"}"
              data-seed="${a.id}"${open ? "" : " disabled"}>
        <span class="seed-face">${ITEMS[cropId].icon}</span>
        <span class="seed-body">
          <span class="seed-name">${escapeHtml(a.name)}</span>
          <span class="seed-meta">${gate} · โต ${Math.round(growSeconds(a.id))}s
            · ได้ ×${yieldN} (❤️${ITEMS[cropId].heal}) · เมล็ดคืน ${a.seedBack[0]}-${a.seedBack[1]}</span>
        </span></button>`;
  }).join("");
  /* 🎯 [owner 2026-08-22] "ที่พับได้ มันต้องมี เลือกเมล็ดที่จะปลูก และแผงเมล็ดพันธุ์ที่ซื้อ" — both
     lists fold away together, because both are things you set occasionally and then leave alone.
     What stays out in the open is plant-all and harvest-all: those are the page's actual verbs, and
     burying them behind a caret to save room would cost more than the room is worth. */
  picker.innerHTML = `<div class="seed-fold"></div>
    <div class="farm-actions">
      <button class="farm-btn plant"${pick ? "" : " disabled"} data-plant-all>🌱 ปลูกทุกแปลงที่ว่าง</button>
      <button class="farm-btn harvest"${ready ? "" : " disabled"} data-harvest-all>🌻 เก็บเกี่ยวทั้งหมด (${ready})</button>
      <span class="farm-note">แปลง ${busy}/${n} · สูงสุด ${PLOTS_MAX} (ซื้อเพิ่มในร้านค้า)</span>
    </div>
    <div class="gardener-row">
      ${gardenerActive()
        ? `<span class="gardener-on">👩‍🌾 คนเฝ้าสวนทำงานอยู่ — เหลือ ${gardenerHarvestsLeft()} ครั้งเก็บ
             (≈ ${gardenerRoundsLeft().toFixed(1)} รอบทั้งสวน)
             · เก็บและปลูก${escapeHtml(farmAction(P.gardener.actionId).name)}ให้เอง</span>`
        : `<span class="farm-note">👩‍🌾 จ้างคนเฝ้าสวน — คิดเป็น<b>รอบเก็บ</b> ไม่ใช่เวลา
             จึงไม่ต้องคิดว่าพืชโตช้าหรือเร็ว</span>`}
      ${pick ? GARDENER_ROUNDS.map((r) => {
        const cost = gardenerPrice(pick, r);
        const secs = growSeconds(pick) * r;
        return `<button class="farm-btn hire-gardener${P.gold >= cost ? "" : " locked"}"
          data-hire-g="${r}"
          title="${escapeHtml(farmAction(pick).name)} ${maxPlots()} แปลง × ${r} รอบ = ${r * maxPlots()} ครั้งเก็บ">
          ${r} รอบ · ${cost.toLocaleString()} 💰
          <span class="hire-real">${r * maxPlots()} ครั้งเก็บ · ราว ${secs < 3600 ? Math.round(secs / 60) + " นาที" : (secs / 3600).toFixed(1) + " ชม."}</span></button>`;
      }).join("") : ""}
    </div>`;
  extra.appendChild(picker);
  renderSeedPanel(picker.querySelector(".seed-fold"), lvl, opts, pick);
  picker.querySelectorAll("[data-seed]").forEach((b) => b.onclick = () => {
    farmSeed = b.dataset.seed;
    renderFarm();
  });
  picker.querySelector("[data-plant-all]").onclick = () => { if (pick) plantAll(pick); };
  picker.querySelector("[data-harvest-all]").onclick = () => harvestAll();
  picker.querySelectorAll("[data-hire-g]").forEach((b) => b.onclick = () => {
    hireGardener(farmSeed || pick, Number(b.dataset.hireG));
    renderView();
  });

  // --- the plots themselves ---
  const grid = $("#action-grid");
  grid.innerHTML = "";
  const head = document.createElement("div");
  head.className = "area-head";
  // `busy` counts planted plots, ripe ones included, so the old wording said "8 แปลงกำลังโต"
  // at the exact moment nothing was growing any more. Growing is what is planted but not yet ripe.
  const growing = busy - ready;
  head.className = "area-head" + (farmIdleFull() ? " farm-waiting-head" : "");
  head.textContent = farmIdleFull()
    ? `🌻 แปลงปลูก — สุกครบทุกแปลงแล้ว (รอเก็บเกี่ยว ${ready} แปลง)`
    : `🪴 แปลงปลูก — ${growing} แปลงกำลังโต · ${ready} แปลงพร้อมเก็บ`;
  grid.appendChild(head);

  for (let i = 0; i < n; i++) {
    const pl = P.plots[i];
    const card = document.createElement("div");
    const done = plotReady(pl);
    card.className = "action-card plot-card" + (done ? " ripe" : pl ? " running" : " empty-plot");
    if (!pl) {
      const seedId = pick ? Object.keys(farmAction(pick).inputs)[0] : null;
      const canPlant = seedId && (P.inv[seedId] || 0) > 0;
      card.innerHTML = `
        <div class="head"><div class="name">🪴 แปลงที่ ${i + 1}</div>
          <div class="req">${T("ว่าง")}</div></div>
        <div class="detail">${pick
          ? (canPlant ? `กดเพื่อปลูก${escapeHtml(farmAction(pick).name)}`
                      : `ไม่มี${escapeHtml(ITEMS[seedId].name)} — ซื้อที่แผงด้านล่าง หรือไปล่ามอนสเตอร์`)
          : "ยังไม่มีพืชที่ปลูกได้"}</div>`;
      if (canPlant) card.onclick = () => { plantPlot(i, pick); renderFarm(); renderInventory(); };
    } else {
      const action = farmAction(pl.actionId);
      const [cropId, yieldN] = Object.entries(action.outputs)[0];
      const need = growSeconds(pl.actionId);
      card.innerHTML = `
        <div class="head"><div class="name">${ITEMS[cropId].icon} ${escapeHtml(action.name)}</div>
          <div class="req" data-plot-clock="${i}">${done ? "พร้อมเก็บ ✅" : `อีก ${Math.ceil(need - pl.grown)}s`}</div></div>
        <div class="detail">ได้ ${ITEMS[cropId].icon} ×${yieldN} (❤️ฟื้น ${ITEMS[cropId].heal} ต่อชิ้น)
          · ${ITEMS[Object.keys(action.inputs)[0]].icon} คืน ${action.seedBack[0]}-${action.seedBack[1]}</div>
        <div class="plot-bar"><div data-plot-fill="${i}"
          style="width:${Math.round(Math.min(1, pl.grown / need) * 100)}%; background:${skill.accent}"></div></div>
        ${done ? "" : `<button class="plot-pull" data-pull="${i}">ถอนทิ้ง</button>`}`;
      if (done) card.onclick = () => { harvestPlot(i); renderFarm(); renderInventory(); refreshSidebar(); };
      const pull = card.querySelector("[data-pull]");
      if (pull) pull.onclick = (e) => { e.stopPropagation(); clearPlot(i); };
    }
    grid.appendChild(card);
  }

  // --- locked plots, shown so the ladder is visible rather than hidden in the shop ---
  for (let i = n; i < PLOTS_MAX; i++) {
    const up = SHOP.filter((u) => u.kind === "plot")[i - PLOTS_START];
    const card = document.createElement("div");
    card.className = "action-card locked plot-card";
    card.innerHTML = `
      <div class="head"><div class="name">🔒 แปลงที่ ${i + 1}</div>
        <div class="req">${up ? `${up.price.toLocaleString()} 💰` : ""}</div></div>
      <div class="detail">${up ? `ซื้อ "${escapeHtml(up.name)}" ในร้านค้าเพื่อเปิดแปลงนี้` : ""}</div>`;
    grid.appendChild(card);
  }

  /* 🎯 [owner 2026-08-22] "หน้าปลูกพืช ตรงเมล็ดพันธุ์ อยากให้ปรับเป็น bullet เหมือนอาหาร เพราะเราไม่ได้
   * ปรับบ่อยๆ" — the stall used to be one full action-card per seed, right here, pushing the plots
   * themselves off a phone screen. It now lives in the collapsible panel above, next to the
   * what-to-plant list, so this end of the page is nothing but the plots. */
  highlightAction = null;
}

let seedOpen = false;

/* Both seed lists in one collapsible panel: what to plant, and what to buy. Collapsed by default —
 * the summary answers the question asked in passing (what am I planting, and do I have any), and
 * the two lists are long enough together to push the plots themselves off a phone screen. */
function renderSeedPanel(host, lvl, opts, pick) {
  if (!host) return;
  const panel = document.createElement("div");
  panel.className = "equip-panel" + (seedOpen ? " open" : "");
  const held = SEED_SHOP.filter((e) => (P.inv[e.item] || 0) > 0).length;
  const chosen = pick ? farmAction(pick) : null;
  const chosenCrop = chosen ? ITEMS[Object.entries(chosen.outputs)[0][0]] : null;
  const seedOfPick = chosen ? Object.keys(chosen.inputs)[0] : null;
  const haveOfPick = seedOfPick ? (P.inv[seedOfPick] || 0) : 0;

  const summary = `
    <button class="equip-summary" id="seed-toggle">
      <span class="caret">${seedOpen ? "▾" : "▸"}</span>
      <span class="worn-row">
        <span class="worn${chosenCrop ? " on" : ""}"
          title="${chosenCrop ? `กำลังจะปลูก ${escapeHtml(chosen.name)}` : "ยังไม่ได้เลือกเมล็ด"}">${chosenCrop ? chosenCrop.icon : "🌱"}</span>
      </span>
      ${seedOpen ? `
      <span class="sum-stats">
        <span class="stat-chip${chosenCrop ? "" : " missing"}">🌱 ${chosen ? escapeHtml(chosen.name) : "ยังไม่ได้เลือก"}</span>
        <span class="stat-chip${haveOfPick ? "" : " missing"}">มีเมล็ด ${haveOfPick}</span>
        <span class="stat-chip">🏪 ถือไว้ ${held}/${SEED_SHOP.length} ชนิด</span>
      </span>
      <span class="expand-hint">ย่อ</span>` : `
      <span class="sum-stats">
        <span class="stat-chip${chosenCrop ? "" : " missing"}">${chosen ? escapeHtml(chosen.name) : "เลือกเมล็ด"}</span>
        <span class="stat-chip${haveOfPick ? "" : " missing"}">เมล็ด ${haveOfPick}</span>
      </span>`}
    </button>`;

  if (!seedOpen) {
    panel.innerHTML = summary;
    host.appendChild(panel);
    panel.querySelector("#seed-toggle").onclick = () => { seedOpen = true; renderView(); };
    return;
  }

  panel.innerHTML = summary + `
    <div class="seed-head">🌱 เลือกเมล็ดที่จะปลูก</div>
    <div class="seed-list">${opts}</div>
    <div class="seed-head">🏪 แผงเมล็ดพันธุ์ — หรือจะไปล่ามอนสเตอร์เอาเมล็ดฟรีก็ได้</div>
    <div class="equip-slots">
      ${SEED_SHOP.map((entry) => {
        const item = ITEMS[entry.item];
        const open = lvl >= entry.level;
        const where = sourceLabel(entry.item);
        return `<div class="equip-slot-box seed-box${open ? "" : " locked"}">
          <div class="slot-face">${item.icon}</div>
          <div class="slot-name">${escapeHtml(item.name)}</div>
          <div class="detail">มีอยู่ ${P.inv[entry.item] || 0} เมล็ด${where ? `<br>ดรอปจาก${escapeHtml(where)}` : ""}</div>
          ${open ? `<div class="seed-buy">
            <button data-buy="1" data-buyseed="${entry.item}">ซื้อ 1 · ${entry.price.toLocaleString()} 💰</button>
            <button data-buy="10" data-buyseed="${entry.item}">ซื้อ 10 · ${(entry.price * 10).toLocaleString()} 💰</button>
          </div>` : `<div class="detail">🔒 เลเวล ${entry.level}</div>`}
        </div>`;
      }).join("")}
    </div>`;
  host.appendChild(panel);
  panel.querySelector("#seed-toggle").onclick = () => { seedOpen = false; renderView(); };
  /* 🐛 data-seed was already taken: the plot picker uses it for "which crop to plant", and reusing
     it here put a buy button and a plant button behind the same selector. Renamed rather than
     scoped, because a selector that only works from the right root is a trap for the next reader. */
  panel.querySelectorAll("[data-buyseed]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    buySeed(b.dataset.buyseed, Number(b.dataset.buy));
  });
}

/* --- Bag view -----------------------------------------------------------------------
 * 🎯 [moved 2026-08-17, owner: "การใช้งานหรือดู มันน้อยกว่าที่คิด"] The inventory used to sit
 * pinned under every screen, spending permanent space on something opened occasionally. It is
 * now a page behind the topbar button, which also lets it use the full width. */
function renderBag() {
  const kinds = Object.values(P.inv).filter((n) => n > 0).length;
  const worth = Object.entries(P.inv)
    .reduce((t, [id, n]) => t + (n > 0 ? (ITEMS[id]?.sell || 0) * n : 0), 0);
  $("#skill-title").textContent = "🎒 กระเป๋าเก็บของ";
  $("#skill-flavor").textContent = `${kinds} ชนิด · ขายหมดได้ราว ${worth.toLocaleString()} 💰`;
  $("#view-extra").innerHTML = "";
  $("#action-grid").innerHTML = "";
  renderInventory();
  highlightAction = null;
}

/* --- Money view: bank, the market by weight class, and the tax ledger -----------------
 * Owner, 2026-08-17: "แยกเป็น bullet การลงทุน แต่ละขนาด แต่ละร้านค่าให้เลือก ... มันจะได้ไม่โชว์
 * ข้อมูลเยอะจนไม่น่าสนใจ". So: one bullet strip picks the section, a company card shows only the
 * three numbers that decide a purchase (price, yield, payout frequency), and the full detail plus
 * the buy/sell controls only unfold for the one company you clicked. */

/* 🎯 [owner 2026-08-22] "default ของหน้านี้ มันชอบไปหมวดย่อยธนาคาร ควรปรับให้มันไปหมวดย่อยบัญชี"
 *
 * The strip already lists บัญชี first and ธนาคาร second, so defaulting to "bank" meant the tab that
 * opened was never the tab on the left — the one place a reader's eye starts. The ledger is also
 * the better landing: it answers "what just happened to my money", which is why you opened this
 * page, while the bank tab answers "what do I want to do next". */
let moneyTab = "ledger";     // ledger | bank | s | m | l
let openCompany = null;      // the one expanded card

/* 🐛 [owner 2026-08-23: "ส่วนภาษีที่ต้องจ่าย มันต้องรวมทั้งสองภาษี แล้วโชว์"] This priced ONLY the
 * investment ladder, through taxOwedOn — a standalone helper that predated there being more than
 * one kind, and that was deleted in 2026-08-24 once nothing read it any more. The rent tax was invisible here, so the headline number under-reported the year for anyone
 * who owned property. taxAccruedTotal walks every kind and subtracts what has already been paid,
 * which is what "ถ้าจบปีนี้" actually means. */
function estimatedTaxNow() { return taxAccruedTotal(); }



/* ---------- Property ----------
 * Rent arrives every game-day like a shop's takings, but the resemblance stops there: there are no
 * wages, no customers and no season.
 *
 * 🎯 [owner 2026-08-17] "ยกเลิกระบบสภาพบ้าน 100% และลดลง ที่ต้องซ่อม เพราะเราบังคับถือระยะยาว ถือรีบขาย
 * ไม่คุ้มทุน ต้องเสีย VAT 15%" — condition and repairs are gone. They existed to make property ask
 * something of you over time, but the 15% exit fee already does that far more cleanly: it makes
 * holding the RIGHT answer instead of making neglect the wrong one. Two mechanisms enforcing the
 * same "commit for the long run" is one chore too many, and the chore was the weaker of the two. */

/* 🐛 [hardened 2026-08-17] An unknown id used to return undefined, and every caller read .price
 * off it — so one stale holding threw inside renderEstates and left the WHOLE page blank, with the
 * tab still counting the house. A holding can outlive its table across an update; sharePrice has
 * degraded gracefully for companies since the same thing happened there. */
const UNKNOWN_ESTATE = { id: "?", name: "อสังหาที่ไม่รู้จัก", icon: "🏚️", price: 0, slots: 0 };
function estateKind(id) { return PROPERTIES.find((x) => x.id === id) || UNKNOWN_ESTATE; }
function furnitureOf(id) { return FURNITURE.find((f) => f.id === id); }

function estateRentBonus(es) {
  return (es.furniture || []).reduce((t, fid) => t + (furnitureOf(fid)?.rent || 0), 0);
}
/* Flat and predictable: what a house pays never moves once it is furnished. */
function estateRentPerDay(es) {
  const kind = estateKind(es.kind);
  return kind.price * RENT_YIELD / DAYS_PER_YEAR * (1 + estateRentBonus(es));
}

function buyProperty(kindId) {
  const kind = estateKind(kindId);
  if (P.gold < kind.price) { toast(`ทองไม่พอ — ${kind.name} ราคา ${kind.price.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= kind.price;
  /* `spent` is the gold put into furnishing, banked so the refund pays back what was actually paid
   * rather than what the price table says today. */
  P.estates.push({ kind: kindId, furniture: [], earned: 0, spent: 0 });
  toast(`${kind.icon} ซื้อ${kind.name}แล้ว — ค่าเช่าเข้าทุกวันในเกม`, "levelup");
  save("ซื้ออสังหา");
}

/* 🎯 The house and its furnishing both hold their full value — no wear is taken off either, and no
 * market moves them. What a sale costs is a flat 15% of the lot, every time. */
function estateSaleValue(es) {
  const kind = estateKind(es.kind);
  const gross = Math.round(kind.price * PROPERTY_SELL_BACK) + Math.round(es.spent || 0);
  return { gross, fee: Math.round(gross * PROPERTY_SELL_FEE), net: Math.round(gross * (1 - PROPERTY_SELL_FEE)) };
}

function sellProperty(i) {
  const es = P.estates[i];
  if (!es) return;
  const kind = estateKind(es.kind);
  const { gross, fee, net } = estateSaleValue(es);
  /* Always confirm, furnished or not: the fee is the whole reason property is a commitment, and
   * finding out about it from the toast afterwards is finding out too late. */
  if (!confirm(`ขาย${kind.name}\n\n`
               + `บ้าน ${kind.price.toLocaleString()} + เฟอร์นิเจอร์ ${Math.round(es.spent || 0).toLocaleString()}`
               + ` = ${gross.toLocaleString()} 💰\n`
               + `หักค่าธรรมเนียม ${Math.round(PROPERTY_SELL_FEE * 100)}% = -${fee.toLocaleString()}\n\n`
               + `ได้รับจริง ${net.toLocaleString()} 💰`)) return;
  P.estates.splice(i, 1);
  /* no-goldBonus: this is your own capital coming back, not income — scaling a refund by a luck
   * charm would mint gold out of buying and selling the same house */
  P.gold += net;
  toast(`${kind.icon} ขาย${kind.name} ได้ ${net.toLocaleString()} 💰 (หัก ${Math.round(PROPERTY_SELL_FEE * 100)}% แล้ว)`, "", "money");
  save("ขายอสังหา");
}

// [removed 2026-08-25] canPayCost / payCost / costText lived here — a complete item-cost payment
// helper set (check you can afford it, spend the items, render the requirement) that nothing called.
// Every cost the game actually charges is gold (P.gold -= ...), not inventory items. Removed as a
// set: leaving one of the three would read as a system that is still half wired up.

function installFurniture(i, fid) {
  const es = P.estates[i];
  const f = furnitureOf(fid);
  if (!es || !f) return;
  const kind = estateKind(es.kind);
  if (es.furniture.includes(fid)) return;
  if (es.furniture.length >= kind.slots) { toast(`${kind.name} ใส่ได้แค่ ${kind.slots} ชิ้น`, "warn"); return; }
  const price = furniturePrice(kind, f);
  if (P.gold < price) { toast(`ทองไม่พอ — ${f.name} ราคา ${price.toLocaleString()} 💰`, "warn"); return; }
  P.gold -= price;
  es.furniture.push(fid);
  es.spent = Math.round((es.spent || 0) + price);
  toast(`${f.icon} ติดตั้ง${f.name}แล้ว — ค่าเช่า +${Math.round(f.rent * 100)}%`, "levelup");
  save("แต่งบ้าน");
}


function runEstatesDay() {
  if (taxSeized()) return;   // seized for unpaid tax: this earns nothing until the bill is settled
  if (!P.estates?.length) return;
  let total = 0;
  for (const es of P.estates) {
    const rent = estateRentPerDay(es);
    es.earned = (es.earned || 0) + rent;
    total += rent;
  }
  /* no-goldBonus: rent is return on capital, not something the luck charm or rebirth karma earned
   * — the same reasoning that keeps dividends and shop takings out of those multipliers */
  P.gold += Math.round(total);
  bump("rentEarned", total);
  bookRentIncome(Math.round(total));
  /* Rent is not income-taxed either, for the same reason: the estate tax already charges the
   * property, and the rent it pays lands in the pocket where the wealth tax finds it. */
  /* 🐛 [owner 2026-08-22: "เช็คให้หน่อยว่าค่าเช่าทำไมไม่เห็นในบัญชี"] It toasted and vanished. The
   * ledger is the only record of where a year's profit came from, and rent was leaving no trace in
   * it at all — so the page that answers "where did my money come from" could not answer it for the
   * income the player deliberately bought a building to get. */
  /* 🎯 [owner 2026-08-22] "ให้โชว์ข้อมูลค่าเช่ารวมเป็นเดือน ไม่ต้องโชว์เป็นรายวัน" — the same call the
   * family upkeep got, and for the same reason: rent arrives every game-day, which is every 100 real
   * seconds, and a line each buried everything else on the page. The toast still fires daily, so the
   * money is still visible as it lands; it is the permanent record that is monthly. */
  if (Math.round(total) >= 1) {
    P.estateMonth = (P.estateMonth || 0) + Math.round(total);
    toast(`🏘️ ค่าเช่า ${Math.round(total).toLocaleString()} 💰`, "", "income");
  }
}

/* ---------- Shops view ---------- */
let estateTab = "buy";   // buy | sell | furnish — three different jobs on one page, per the owner

/* 🎯 [owner 2026-08-18] "เพิ่มย่อยเป็นเมนู ซื้อ / ขาย / ตบแต่ง เพื่อที่หน้าซื้อจะได้เลือกซื้ออย่างเดียว"
 * The single page used to mix three different jobs — browse the market, manage what you hold, and
 * furnish it — in one scroll, which meant "just buy a house" always came with unrelated cards for
 * every house you already own in the way. Split the same way the guild's page already is: one area
 * for what you're actually here to do. */
function renderEstates(grid, extra) {
  $("#skill-title").textContent = "🏘️ อสังหาริมทรัพย์";
  $("#skill-flavor").textContent = "ราคาบ้านไม่ขึ้นไม่ลง — ขายคืนได้เท่าที่ซื้อเสมอ · ค่าเช่าเข้าทุกวัน ไม่มีค่าเสื่อม ไม่ต้องซ่อม";

  const owned = P.estates || [];
  if (owned.length) {
    /* 🎯 [owner 2026-08-23] "ผลลัพธ์การลงทุน ให้เอาค่าเช่าทั้งหมด - ทุน = x · หาก x ติดลบ ขึ้นสีแดง
       (ยังไม่คืนทุน) · หาก x ไม่ติดลบ ขึ้นเขียว (กำไรสุทธิ)"

       Both sides are scoped to the properties you HOLD, so the subtraction is honest. P.stats
       .rentEarned is lifetime and survives selling, so pairing it with the capital of what you
       still own would credit a sold house's rent against a capital figure it left — a portfolio
       could read as profitable purely by having sold something.

       Furniture counts as capital, which it was not doing before. It is money put in that the rent
       has to pay back, and the sell card already calls it refundable on sale exactly like the house
       ("ได้คืนตอนขาย ไม่มีค่าเสื่อม"). Leaving it out understated the capital and overstated the yield. */
    const capital = owned.reduce((t, es) => t + estateKind(es.kind).price + (es.spent || 0), 0);
    const collected = owned.reduce((t, es) => t + (es.earned || 0), 0);
    const net = Math.round(collected - capital);
    const rentDay = owned.reduce((t, es) => t + estateRentPerDay(es), 0);
    const sum = document.createElement("div");
    sum.className = "money-summary";
    sum.innerHTML = `
      <div class="money-stat"><span>${T("บ้านที่ถือ")}</span><b>${owned.length} หลัง</b></div>
      <div class="money-stat"><span>${T("ทุนที่จมอยู่")}</span><b>${fmtNum(capital)}</b></div>
      <div class="money-stat"><span>${T("ค่าเช่า/วันในเกม")}</span><b class="good">${Math.round(rentDay).toLocaleString()}</b></div>
      <div class="money-stat"><span>${T("ผลตอบแทนต่อทุน")}</span><b>${capital > 0 ? (rentDay * DAYS_PER_YEAR / capital * 100).toFixed(1) : "0.0"}%/ปี</b></div>
      <div class="money-stat"><span>${T("ค่าเช่าที่เก็บได้แล้ว")}</span><b>${fmtNum(Math.round(collected))}</b></div>
      <div class="money-stat"><span>${T("ผลลัพธ์การลงทุน")}</span><b class="${net < 0 ? "bad" : "good"}">${
        net < 0 ? `-${fmtNum(-net)}` : `+${fmtNum(net)}`} <small>${
        net < 0 ? T("ยังไม่คืนทุน") : T("กำไรสุทธิ")}</small></b></div>`;
    extra.appendChild(sum);
  }

  const needFurnish = owned.filter((es) => es.furniture.length < estateKind(es.kind).slots).length;
  const tabs = document.createElement("div");
  tabs.className = "area-tabs";
  tabs.innerHTML = [
    ["buy", "🏷️ ซื้อ", ""],
    ["sell", "💰 ขาย", owned.length ? `${owned.length}` : ""],
    ["furnish", "🛋️ ตบแต่ง", needFurnish ? `${needFurnish}` : ""],
  ].map(([id, label, n]) => `<button class="area-tab${estateTab === id ? " active" : ""}" data-etab="${id}">
      <span style="color:#7cc47f">◆</span> ${label}${n ? `<span class="area-count">${n}</span>` : ""}</button>`).join("");
  extra.appendChild(tabs);
  tabs.querySelectorAll("[data-etab]").forEach((b) => b.onclick = () => { estateTab = b.dataset.etab; renderShops(); });

  if (estateTab === "sell") renderEstateSell(grid, owned);
  else if (estateTab === "furnish") renderEstateFurnish(grid, owned);
  else renderEstateBuy(grid, owned);
}

function renderEstateBuy(grid, owned) {
  if (!owned.length) {
    const note = document.createElement("div");
    note.className = "action-card full-card";
    note.innerHTML = `<div class="detail">
      อสังหาคือที่พักเงินก้อนที่ <b>${T("ไม่ต้องลุ้น")}</b> — ราคาไม่ขึ้นไม่ลง ขายคืนได้เท่าที่ซื้อเสมอ
      ค่าเช่าเปล่า ๆ ให้ ${Math.round(RENT_YIELD * 100)}%/ปี ซึ่ง<b>${T("น้อยกว่าปันผลหุ้น")}</b> โดยตั้งใจ<br>
      สิ่งที่ทำให้มันคุ้มคือ <b>${T("เฟอร์นิเจอร์")}</b> — แต่ละชิ้นทำจากคนละสายอาชีพ
      แต่งครบทั้งหลังค่าเช่าเพิ่มได้ถึง ${Math.round(FURNITURE.reduce((t, f) => t + f.rent, 0) * 100)}%
      ของที่คุณผลิตเองจึงมีทางใช้นอกจากขายทิ้ง<br>
      <span class="rb-warn">ไม่มีค่าเสื่อม ไม่ต้องซ่อม — สิ่งที่บังคับให้ถือยาวคือค่าธรรมเนียมขาย
      ${Math.round(PROPERTY_SELL_FEE * 100)}% ซึ่งกินกำไรของการซื้อมาขายไปเสมอ</span>
    </div>`;
    grid.appendChild(note);
  }

  const h2 = document.createElement("div");
  h2.className = "area-head";
  h2.textContent = "ประกาศขาย — ราคาคงที่ ไม่มีต่อรอง";
  grid.appendChild(h2);
  for (const kind of PROPERTIES) {
    const afford = P.gold >= kind.price;
    const card = document.createElement("div");
    card.className = "action-card" + (afford ? "" : " locked");
    /* 🐛 [2026-08-23] This took the first N pieces in TABLE order, but the install list is sorted
       best-first, so a player filling four slots buys the four highest — not the first four. The
       figure therefore promised a number nobody would actually reach. Best N, on a copy: sorting
       FURNITURE itself would change what every other reader of it means. */
    const full = FURNITURE.slice().sort((a, b) => b.rent - a.rent)
      .slice(0, kind.slots).reduce((t, f) => t + f.rent, 0);
    card.innerHTML = `
      <div class="head"><div class="name">${kind.icon} ${escapeHtml(kind.name)}</div>
        <div class="req">${kind.price.toLocaleString()} 💰</div></div>
      <div class="detail">
        ค่าเช่า ${Math.round(kind.price * RENT_YIELD / DAYS_PER_YEAR).toLocaleString()} 💰/วัน
        → แต่งเต็ม ${Math.round(kind.price * RENT_YIELD / DAYS_PER_YEAR * (1 + full)).toLocaleString()} 💰/วัน<br>
        ใส่เฟอร์นิเจอร์ได้ ${kind.slots} ชิ้น · คืนทุนราว ${(1 / RENT_YIELD).toFixed(0)} ปีในเกมถ้าไม่แต่ง</div>`;
    if (afford) card.onclick = () => { buyProperty(kind.id); renderShops(); };
    grid.appendChild(card);
  }
}

function renderEstateSell(grid, owned) {
  if (!owned.length) {
    const note = document.createElement("div");
    note.className = "action-card full-card";
    note.innerHTML = `<div class="detail">ยังไม่มีบ้านให้ขาย — ไปที่แท็บ 🏷️ ซื้อ ก่อน</div>`;
    grid.appendChild(note);
    return;
  }
  owned.forEach((es, i) => {
    const kind = estateKind(es.kind);
    const card = document.createElement("div");
    card.className = "action-card full-card";
    card.innerHTML = `
      <div class="head"><div class="name">${kind.icon} ${escapeHtml(kind.name)}</div>
        <div class="req">${Math.round(estateRentPerDay(es)).toLocaleString()} 💰/วัน</div></div>
      <div class="detail">
        ทุน ${kind.price.toLocaleString()} 💰 · ค่าเช่าฐาน ${Math.round(RENT_YIELD * 100)}%/ปี
        ${estateRentBonus(es) > 0 ? ` <b class="good">+${Math.round(estateRentBonus(es) * 100)}% จากเฟอร์นิเจอร์</b>` : ""}<br>
        เฟอร์นิเจอร์ ${es.furniture.length}/${kind.slots} · เก็บค่าเช่าไปแล้ว ${fmtNum(Math.round(es.earned || 0))}
        · ลงเฟอร์นิเจอร์ไปแล้ว ${fmtNum(Math.round(es.spent || 0))} 💰 (ได้คืนตอนขาย ไม่มีค่าเสื่อม)
      </div>
      <div class="cd-actions">
        <button class="btn ghost" data-sell-es="${i}">ขาย ${fmtNum(estateSaleValue(es).net)} 💰 (หัก ${Math.round(PROPERTY_SELL_FEE * 100)}%)</button>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-sell-es]").forEach((b) => b.onclick = () => { sellProperty(Number(b.dataset.sellEs)); renderShops(); });
}

function renderEstateFurnish(grid, owned) {
  const unfinished = owned
    .map((es, i) => ({ es, i }))
    .filter(({ es }) => es.furniture.length < estateKind(es.kind).slots);
  if (!unfinished.length) {
    const note = document.createElement("div");
    note.className = "action-card full-card";
    note.innerHTML = `<div class="detail">${owned.length
      ? "ทุกหลังแต่งครบแล้ว — ไม่มีอะไรให้ตบแต่งเพิ่ม"
      : "ยังไม่มีบ้านให้ตบแต่ง — ไปที่แท็บ 🏷️ ซื้อ ก่อน"}</div>`;
    grid.appendChild(note);
    return;
  }
  unfinished.forEach(({ es, i }) => {
    const kind = estateKind(es.kind);
    const free = kind.slots - es.furniture.length;
    const card = document.createElement("div");
    card.className = "action-card full-card";
    card.innerHTML = `
      <div class="head"><div class="name">${kind.icon} ${escapeHtml(kind.name)}</div>
        <div class="req">เฟอร์นิเจอร์ ${es.furniture.length}/${kind.slots} (ว่าง ${free})</div></div>
      <div class="detail">
        ค่าเช่าตอนนี้ ${Math.round(estateRentPerDay(es)).toLocaleString()} 💰/วัน
        ${estateRentBonus(es) > 0 ? ` <b class="good">+${Math.round(estateRentBonus(es) * 100)}% จากเฟอร์นิเจอร์</b>` : ""}
      </div>
      <!-- 🎯 [owner 2026-08-22] "ในส่วนตบแต่ง ให้เรียง % สูงขึ้นก่อน" — the list ran in table
           order, which put a +8% between two +10%s. Every slot is a choice among the same six
           pieces at prices that scale with the rent they add, so the percentage is the only
           thing being compared and should not have to be hunted for. Sorted on a COPY:
           FURNITURE is read elsewhere by position (slice(0, slots) for the fully-furnished
           figure), and reordering the table itself would quietly change what that means. -->
      <div class="furn-row">${FURNITURE.slice().sort((a, b) => b.rent - a.rent).map((f) => {
        const has = es.furniture.includes(f.id);
        const room = es.furniture.length < kind.slots;
        const price = furniturePrice(kind, f);
        return `<button class="btn ghost small${has ? " on" : ""}" data-furn="${f.id}" data-i="${i}"
          ${has || !room || P.gold < price ? " disabled" : ""}
          title="${escapeHtml(f.name)} ${price.toLocaleString()} 💰 · คืนทุนใน ${FURNITURE_PAYBACK_YEARS} ปีในเกม">
          ${f.icon} ${f.name} +${Math.round(f.rent * 100)}% · ${fmtNum(price)}</button>`;
      }).join("")}</div>
      <div class="detail furn-note">ราคาเฟอร์นิเจอร์คิดตามราคาบ้าน — ทุกชิ้นคืนทุนใน ${FURNITURE_PAYBACK_YEARS} ปีในเกมจากค่าเช่าที่เพิ่ม</div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-furn]").forEach((b) => b.onclick = () => {
    installFurniture(Number(b.dataset.i), b.dataset.furn); renderShops();
  });
}

let shopTab = 0;          // which of your shops is open
let shopPanel = "floor";  // floor | staff | hire
let bizTab = "shop";      // shop | estate — the two kinds of business you can own

/* ---------- 🏹 the institute's page ----------
 * Four things, in the order the decision is actually made: what the school costs to run, who is in
 * it, which squads are out, and what they brought back. */
let guildTab = "squads";     // squads | roster | intake | upkeep

function renderGuild() {
  const extra = $("#view-extra");
  extra.innerHTML = "";
  const grid = $("#action-grid");
  grid.innerHTML = "";
  $("#skill-title").textContent = `🏹 ${T("สถาบันฮันเตอร์")}`;
  $("#skill-flavor").textContent = T("เลี้ยงเด็กเอง ฝึกเอง ส่งออกล่าเอง — ขาดทุนช่วงแรก คืนทุนในระยะยาว");

  if (!guildOn()) { renderGuildOpening(grid, extra); return; }
  guildRefreshApplicants();
  const t = guildTier();
  const g = P.guild;
  const pending = guildPending();
  const nItems = Object.values(pending.items || {}).reduce((a, b) => a + b, 0);
  const hurt = g.roster.filter(guildIsHurt).length;

  const summary = document.createElement("div");
  summary.className = "money-summary";
  summary.innerHTML = `
    <div class="money-stat"><span>${T("สถาบัน")}</span><b>${t.name}</b></div>
    <div class="money-stat"><span>${T("คนในสังกัด")}</span><b>${g.roster.length}/${t.beds}${hurt ? ` · ${T("เจ็บ")} ${hurt}` : ""}</b></div>
    <div class="money-stat"><span>${T("ค่าเลี้ยง/วันในเกม")}</span><b class="bad">${guildUpkeepPerDay().toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("รอรับ")}</span><b class="${pending.gold > 0 ? "good" : ""}">${Math.floor(pending.gold).toLocaleString()}${nItems ? ` · ของ ${nItems}` : ""}</b></div>`;
  extra.appendChild(summary);

  const tabs = document.createElement("div");
  tabs.className = "area-tabs";
  tabs.innerHTML = [
    ["squads", `🗡️ ${T("ทีมและภารกิจ")}`, `${guildSquads().filter((x) => x.roundsLeft > 0).length}/${t.squads}`],
    ["roster", `🧑‍🎓 ${T("คนในสังกัด")}`, `${g.roster.length}`],
    ["intake", `📜 ${T("รับเลี้ยง")}`, `${(g.applicants || []).length}`],
    ["upkeep", `🍲 ${T("ค่าเลี้ยงดู")}`, ""],
  ].map(([id, label, n]) => `<button class="area-tab${guildTab === id ? " active" : ""}" data-gtab="${id}">
      <span style="color:#7cc47f">◆</span> ${label}${n ? `<span class="area-count">${n}</span>` : ""}</button>`).join("");
  extra.appendChild(tabs);
  tabs.querySelectorAll("[data-gtab]").forEach((b) => b.onclick = () => { guildTab = b.dataset.gtab; renderGuild(); });

  /* Collecting is its own card at the top of every tab: it is the one thing you came here to do. */
  const take = document.createElement("div");
  take.className = "action-card full-card" + (pending.gold > 0 ? " running" : "");
  take.innerHTML = `
    <div class="head"><div class="name">📦 ${T("ของที่ทีมส่งกลับมา")}</div>
      <div class="req">${Math.floor(pending.gold).toLocaleString()} 💰${nItems ? ` · ${nItems}${unitWord("ชิ้น")}` : ""}</div></div>
    <div class="detail">${currentLang() === "en" ? `${pending.rounds || 0} hunts since you last collected` : `ล่าไปแล้ว ${pending.rounds || 0} รอบตั้งแต่รับครั้งก่อน`}
      ${nItems ? `<br>${Object.entries(pending.items).map(([id, n]) => `${ITEMS[id]?.icon || "📦"} ${ITEMS[id]?.name || id} ×${n}`).join(" · ")}` : ""}</div>
    <div class="cd-actions">
      <button class="farm-btn harvest" data-gcollect>${T("รับของและเงิน")}</button>
      <label class="chk"><input type="checkbox" data-gauto ${g.autoCollect ? "checked" : ""}> ${T("รับอัตโนมัติ")}</label>
    </div>`;
  grid.appendChild(take);
  take.querySelector("[data-gcollect]").onclick = () => { guildCollect(); renderGuild(); };
  take.querySelector("[data-gauto]").onchange = (e) => { g.autoCollect = e.target.checked; save(); };

  if (guildTab === "squads") renderGuildSquads(grid);
  else if (guildTab === "roster") renderGuildRoster(grid);
  else if (guildTab === "intake") renderGuildIntake(grid);
  else renderGuildUpkeep(grid, extra);
}

function renderGuildOpening(grid, extra) {
  const t = GUILD_TIERS[0];
  const note = document.createElement("div");
  note.className = "shop-intro";
  note.innerHTML = `
    <b>${T("สถาบันฮันเตอร์คืออะไร")}</b><br>
    ${currentLang() === "en" ? `
    Buy the school, take children in, train them until they pass their grading, then send them out
    as squads to hunt in your place.<br>
    Squads hunt on their own every game-day and bring back both bounty and materials —
    <b>${T("แต่ช่วงแรกขาดทุนแน่นอน")}</b>, because grade F children do not yet earn their keep. Expect
    around seven game-years to break even.<br>
    Keeping too many on the books loses money, and sending a squad somewhere beyond it gets people
    killed — the ones who die are the ones you spent years training.
    <br><b>${T("ไม่กินช่องงาน")}</b> — it runs in the background while you do something else` : `
    ซื้อโรงเรียน รับเด็กเข้ามาเลี้ยง ฝึกจนสอบเลื่อนขั้นได้ แล้วส่งเป็นทีมออกล่ามอนสเตอร์แทนเรา<br>
    ทีมจะล่าเองทุกวันในเกม ได้ทั้งค่าหัวและวัตถุดิบ — <b>${T("แต่ช่วงแรกขาดทุนแน่นอน")}</b>
    เพราะเด็กขั้น F ยังหาเงินไม่คุ้มค่าข้าว กว่าจะคืนทุนใช้เวลาราวเจ็ดปีในเกม<br>
    เลี้ยงคนไว้เยอะเกินก็ขาดทุน ส่งไปเป้าที่เกินตัวก็มีคนตาย และคนที่ตายคือคนที่เราลงทุนฝึกมาหลายปี
    <br><b>${T("ไม่กินช่องงาน")}</b> — ทำงานอยู่เบื้องหลังพร้อมกับที่เราทำอย่างอื่น`}`;
  extra.appendChild(note);

  const card = document.createElement("div");
  card.className = "action-card full-card";
  const can = Math.floor(P.gold) >= t.cost;
  card.innerHTML = `
    <div class="head"><div class="name">🏹 ${currentLang() === "en" ? `Build ${t.name}` : `สร้าง${t.name}`}</div>
      <div class="req ${can ? "good" : "bad"}">${t.cost.toLocaleString()} 💰</div></div>
    <div class="detail">${currentLang() === "en"
        ? `${t.beds} beds · ${t.squads} squad(s) · contracts in the first ${t.zones} zones<br>Fixed institute upkeep ${t.fixed.toLocaleString()} 💰 per game-day, plus per-head upkeep`
        : `เตียง ${t.beds} คน · ส่งได้ ${t.squads} ทีม · รับสัญญาได้ ${t.zones} โซนแรก<br>ค่าดูแลสถาบันคงที่ ${t.fixed.toLocaleString()} 💰/วันในเกม บวกค่าเลี้ยงรายหัว`}</div>
    <div class="cd-actions"><button class="farm-btn harvest" data-gbuild ${can ? "" : "disabled"}>${T("สร้างสถาบัน")}</button></div>`;
  grid.appendChild(card);
  card.querySelector("[data-gbuild]").onclick = () => { if (guildBuild()) renderGuild(); };

  const ladder = document.createElement("div");
  ladder.className = "area-head";
  ladder.textContent = "📐 ขั้นของสถาบัน";
  grid.appendChild(ladder);
  for (const x of GUILD_TIERS) {
    const c = document.createElement("div");
    c.className = "action-card";
    c.innerHTML = `<div class="head"><div class="name">${x.name}</div>
        <div class="req">${x.cost.toLocaleString()} 💰</div></div>
      <div class="detail">${currentLang() === "en"
        ? `${x.beds} beds · ${x.squads} squads · ${x.zones} zones · per-head upkeep ×${x.upkeepMult.toFixed(2)} · institute ${x.fixed.toLocaleString()}/day`
        : `เตียง ${x.beds} · ทีม ${x.squads} · โซน ${x.zones} · ค่าเลี้ยงต่อหัว ×${x.upkeepMult.toFixed(2)} · ค่าสถาบัน ${x.fixed.toLocaleString()}/วัน`}</div>`;
    grid.appendChild(c);
  }
}

function renderGuildSquads(grid) {
  const t = guildTier();
  const squads = guildSquads();
  squads.forEach((sq, i) => {
    const bodies = (sq.members || []).map(guildMember).filter(Boolean);
    const target = guildTargetByKey(sq.targetKey);
    const f = guildForecast(sq, target);
    const out = (sq.roundsLeft || 0) > 0;
    const card = document.createElement("div");
    card.className = "action-card full-card" + (out ? " running" : "");
    card.innerHTML = `
      <div class="head"><div class="name">🗡️ ทีมที่ ${i + 1}</div>
        <div class="req">${bodies.length}/${GUILD_SQUAD_MAX} คน${out ? ` · เหลือ ${sq.roundsLeft} รอบ` : ""}</div></div>
      <div class="detail">
        ${bodies.length ? bodies.map((m) => `${guildIsHurt(m) ? "🩹" : "🗡️"} ${m.name} (${m.rank})`).join(" · ") : "ยังไม่ได้จัดคนเข้าทีม"}
        ${f ? `<br>กำลังทีม ${f.power.toFixed(1)} เทียบเป้า ${f.tp.toFixed(1)} · สำเร็จ ${Math.round(f.success * 100)}%
          · ได้ราว ${f.goldPerRound.toLocaleString()} 💰/รอบ · ค่าจ้าง ${f.wage.toLocaleString()}/รอบ
          ${f.died > 0.0005 ? `<br><b class="bad">⚠️ เสี่ยงตาย ${(f.died * 100).toFixed(2)}%/คน/รอบ — เป้านี้เกินตัว</b>` : ""}` : ""}
      </div>
      <div class="cd-actions">
        <select data-gtarget="${i}" class="q-in">
          <option value="">— เลือกเป้าหมาย —</option>
          ${guildTargets().map((x) => `<option value="${x.key}"${x.key === sq.targetKey ? " selected" : ""}>
            ${x.loc.icon} ${x.st.name} (ระดับ ${guildTargetPower(x.st).toFixed(0)})</option>`).join("")}
        </select>
        ${GUILD_CONTRACT_LENGTHS.map((n) => `<button class="farm-btn" data-gstart="${i}" data-rounds="${n}">ออกล่า ${n} รอบ</button>`).join("")}
        ${out ? `<button class="q-out" data-grecall="${i}">เรียกกลับ</button>` : ""}
        <label class="chk"><input type="checkbox" data-grepeat="${i}" ${sq.autoRepeat ? "checked" : ""}> ล่าซ้ำอัตโนมัติเมื่อครบรอบ</label>
      </div>
      <div class="cd-actions">
        ${P.guild.roster.map((m) => {
          const inThis = (sq.members || []).includes(m.id);
          const elsewhere = squads.some((o, oi) => oi !== i && (o.members || []).includes(m.id));
          return `<button class="farm-btn${inThis ? " harvest" : ""}" data-gassign="${i}" data-mid="${m.id}"
            ${elsewhere ? "disabled" : ""}>${inThis ? "✓ " : ""}${m.name} ${m.rank}${guildIsHurt(m) ? " 🩹" : ""}</button>`;
        }).join("")}
      </div>`;
    grid.appendChild(card);
  });

  grid.querySelectorAll("[data-gassign]").forEach((b) => b.onclick = () => {
    guildAssign(Number(b.dataset.gassign), b.dataset.mid); save(); renderGuild();
  });
  grid.querySelectorAll("[data-gtarget]").forEach((sel) => sel.onchange = () => {
    const sq = guildSquads()[Number(sel.dataset.gtarget)];
    if (sq) { sq.targetKey = sel.value || null; save(); renderGuild(); }
  });
  grid.querySelectorAll("[data-gstart]").forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.gstart);
    const sel = grid.querySelector(`[data-gtarget="${i}"]`);
    if (guildStart(i, sel?.value, Number(b.dataset.rounds))) { save(); renderGuild(); }
  });
  grid.querySelectorAll("[data-grecall]").forEach((b) => b.onclick = () => {
    guildRecall(Number(b.dataset.grecall)); save(); renderGuild();
  });
  grid.querySelectorAll("[data-grepeat]").forEach((c) => c.onchange = (e) => {
    guildSetAutoRepeat(Number(c.dataset.grepeat), e.target.checked); save();
  });

  const next = guildNextTier();
  if (next) {
    const can = Math.floor(P.gold) >= next.cost;
    const c = document.createElement("div");
    c.className = "action-card full-card";
    c.innerHTML = `
      <div class="head"><div class="name">⬆️ อัปเกรดเป็น${next.name}</div>
        <div class="req ${can ? "good" : "bad"}">${next.cost.toLocaleString()} 💰</div></div>
      <div class="detail">เตียง ${t.beds} → ${next.beds} · ทีม ${t.squads} → ${next.squads}
        · โซน ${t.zones} → ${next.zones} · ค่าเลี้ยงต่อหัว ×${t.upkeepMult.toFixed(2)} → ×${next.upkeepMult.toFixed(2)}
        <br>เด็กที่เก่งเกินโซนที่สถาบันรับได้ ก็ไม่มีที่ให้ไป — โรงเรียนที่ใหญ่ขึ้นคือสิ่งที่ปลดล็อกเป้าที่รวยกว่า</div>
      <div class="cd-actions"><button class="farm-btn harvest" data-gup ${can ? "" : "disabled"}>${T("อัปเกรด")}</button></div>`;
    grid.appendChild(c);
    c.querySelector("[data-gup]").onclick = () => { if (guildUpgrade()) { save(); renderGuild(); } };
  }
}

function renderGuildRoster(grid) {
  const g = P.guild;
  if (!g.roster.length) {
    const c = document.createElement("div");
    c.className = "action-card full-card";
    c.innerHTML = `<div class="detail">ยังไม่มีใครในสังกัด — ไปที่แท็บ 📜 รับเลี้ยง</div>`;
    grid.appendChild(c);
    return;
  }
  for (const m of g.roster) {
    const r = guildRank(m.rank);
    const next = GUILD_RANKS[guildRankIdx(m.rank) + 1];
    const ready = guildCanExam(m);
    const c = document.createElement("div");
    c.className = "action-card" + (ready ? " running" : "");
    c.innerHTML = `
      <div class="head"><div class="name">${guildIsHurt(m) ? "🩹" : "🗡️"} ${m.name}</div>
        <div class="req">ขั้น ${r.id} ${r.name}</div></div>
      <div class="detail">กำลัง ${r.power.toFixed(1)} · ค่าจ้าง ${r.wage.toLocaleString()}/รอบ
        (ตลาดจ้าง ${GUILD_MARKET_WAGE.toLocaleString()})
        ${guildIsHurt(m) ? `<br><b class="bad">พักรักษาตัวอีก ${Math.ceil(m.hurtUntil - P.gameDays)} วัน</b>` : ""}
        ${next ? `<br>ออกงานมาแล้ว ${Math.floor(m.rounds || 0).toLocaleString()}/${next.examRounds.toLocaleString()} รอบ
          → สอบขั้น ${next.id} ค่าสอบ ${next.examCost.toLocaleString()} 💰` : "<br>ถึงขั้นสูงสุดแล้ว"}</div>
      ${next ? `<div class="cd-actions">
        <button class="farm-btn harvest" data-gexam="${m.id}" ${ready ? "" : "disabled"}>สอบเลื่อนขั้น</button>
        <button class="q-out" data-gfire="${m.id}">ให้ออก</button></div>` : ""}`;
    grid.appendChild(c);
  }
  grid.querySelectorAll("[data-gexam]").forEach((b) => b.onclick = () => {
    if (guildExam(b.dataset.gexam)) { save(); renderGuild(); }
  });
  grid.querySelectorAll("[data-gfire]").forEach((b) => b.onclick = () => {
    guildDismiss(b.dataset.gfire); save(); renderGuild();
  });
}

function renderGuildIntake(grid) {
  const g = P.guild;
  const t = guildTier();
  const full = g.roster.length >= t.beds;
  const head = document.createElement("div");
  head.className = "action-card full-card";
  head.innerHTML = `<div class="detail">
    ผู้สมัครรอบใหม่มาทุก ${GUILD_APPLICANT_DAYS} วันในเกม · เตียงว่าง ${Math.max(0, t.beds - g.roster.length)} เตียง<br>
    ทุกคนเข้ามาที่ขั้น F เหมือนกันหมด — สิ่งที่ต้องตัดสินใจคือ<b>${T("รับกี่คน")}</b> ไม่ใช่รับใคร
    เพราะทุกปากที่รับเข้ามากินค่าอาหารทุกวัน ตั้งแต่วันแรกที่ยังหาเงินไม่ได้</div>
    <div class="cd-actions"><button class="farm-btn" data-gapp-refresh>
      🔄 ${T("ประกาศรับใหม่")} · ${GUILD_REROLL_COST.toLocaleString()} 💰</button></div>`;
  grid.appendChild(head);
  /* 🎯 [owner 2026-09-05] "rank f กด รีเฟรช ได้เหมือน พนักงาน ว่าจะรับใครเพิ่มบ้าง มีให้สุ่มเรื่อยๆ"
   *
   * The intake used to arrive on a 30-day clock and nothing else, so a player who took everyone on
   * the board sat looking at an empty tab for a game-month with beds free and no way to act.
   *
   * It costs money, and that is the whole design of the button. Recruits are deliberately identical
   * — the note above `guildRefreshApplicants` says per-person rolls would make rerolling the real
   * game — so a reroll buys COUNT and NAMES, never a better hunter. Free, it would be a button you
   * mash until the roll is 10; priced, it is "I have beds and money, bring me more mouths", which is
   * the decision this tab is about. */
  const refresh = head.querySelector("[data-gapp-refresh]");
  if (refresh) {
    refresh.disabled = P.gold < GUILD_REROLL_COST;
    refresh.onclick = () => {
      if (P.gold < GUILD_REROLL_COST) { toast("เงินไม่พอ", "warn"); return; }
      P.gold -= GUILD_REROLL_COST;
      guildRefreshApplicants(true);
      toast(`ประกาศรับใหม่ — มีผู้สมัคร ${(P.guild.applicants || []).length} คน`, "good");
      save(); renderGuild();
    };
  }
  for (const a of g.applicants || []) {
    const c = document.createElement("div");
    c.className = "action-card";
    c.innerHTML = `
      <div class="head"><div class="name">🧑‍🎓 ${a.name}</div><div class="req">ขั้น F</div></div>
      <div class="detail">${T("อยากเป็นฮันเตอร์ ยังไม่เคยออกสนามจริง")}</div>
      <div class="cd-actions"><button class="farm-btn harvest" data-grecruit="${a.id}" ${full ? "disabled" : ""}>
        ${full ? "เตียงเต็ม" : "รับเลี้ยง"}</button></div>`;
    grid.appendChild(c);
  }
  grid.querySelectorAll("[data-grecruit]").forEach((b) => b.onclick = () => {
    if (guildRecruit(b.dataset.grecruit)) { save(); renderGuild(); }
  });
}

function renderGuildUpkeep(grid, extra) {
  const note = document.createElement("div");
  note.className = "area-head";
  note.textContent = `🍲 ค่าเลี้ยงดู — รวม ${guildUpkeepPerDay().toLocaleString()} 💰/วันในเกม`;
  grid.appendChild(note);
  const why = {
    food: "อาหารดีขึ้น = ล่าได้เร็วขึ้น เป็นสัดส่วนของรายได้ — โรงเรียนเล็กยังไม่คุ้ม สถาบันโตถึงจะคุ้ม",
    gear: "อุปกรณ์ดีขึ้น = กำลังทีมสูงขึ้น มีผลเฉพาะตอนไปเป้าที่ยังเอาชนะไม่ขาด ถ้าเป้าง่ายอยู่แล้วคือจ่ายฟรี",
    med: "ยาลดโอกาสตายอย่างเดียว ถ้าไม่ส่งใครไปเป้าที่เกินตัว ก็ไม่ต้องจ่าย",
    train: "ครูดีขึ้น = สอบเลื่อนขั้นเร็วขึ้น จ่ายเป็นเวลา ไม่ใช่เป็นเงินต่อรอบ",
  };
  for (const [line, def] of Object.entries(GUILD_UPKEEP)) {
    const picked = guildUpkeepPick()[line] || 0;
    const c = document.createElement("div");
    c.className = "action-card full-card";
    c.innerHTML = `
      <div class="head"><div class="name">${def.icon} ${def.name}</div>
        <div class="req">${def.tiers[picked].cost.toLocaleString()} 💰/คน/วัน</div></div>
      <div class="detail">${why[line] || ""}</div>
      <div class="cd-actions">${def.tiers.map((tr, i) =>
        `<button class="farm-btn${i === picked ? " harvest" : ""}" data-gline="${line}" data-tier="${i}">
          ${i === picked ? "✓ " : ""}${tr.name} · ${tr.cost.toLocaleString()}/คน/วัน</button>`).join("")}</div>`;
    grid.appendChild(c);
  }
  grid.querySelectorAll("[data-gline]").forEach((b) => b.onclick = () => {
    P.guild.upkeep = P.guild.upkeep || {};
    P.guild.upkeep[b.dataset.gline] = Number(b.dataset.tier);
    save(); renderGuild();
  });
}

function renderShops() {
  const extra = $("#view-extra");
  extra.innerHTML = "";
  const grid = $("#action-grid");
  grid.innerHTML = "";

  /* Two businesses that fail in completely different ways deserve to be told apart at the door:
   * a shop is staff and throughput and can bleed you every day, a property is capital that sits
   * still and only ever costs you attention. */
  const kinds = document.createElement("div");
  kinds.className = "area-tabs";
  kinds.innerHTML = [
    ["shop", `🏪 ${T("ร้านค้า")}`, P.shops?.length ? `${P.shops.length}` : ""],
    ["estate", `🏘️ ${T("อสังหา")}`, P.estates?.length ? `${P.estates.length}` : ""],
  ].map(([id, label, n]) => `<button class="area-tab${bizTab === id ? " active" : ""}" data-biz="${id}">
      <span style="color:#7cc47f">◆</span> ${label}${n ? `<span class="area-count">${n}</span>` : ""}</button>`).join("");
  extra.appendChild(kinds);
  kinds.querySelectorAll("[data-biz]").forEach((b) => b.onclick = () => { bizTab = b.dataset.biz; renderShops(); });

  if (bizTab === "estate") { renderEstates(grid, extra); return; }

  $("#skill-title").textContent = `🏪 ${T("ธุรกิจของเรา")}`;
  $("#skill-flavor").textContent = T("จ้างคน จัดอัตราส่วน ตั้งราคา — รายได้เข้าทุกวันในเกม แต่ค่าจ้างก็ออกทุกวันเหมือนกัน");

  if (!P.shops?.length) { renderShopOpening(grid, extra); return; }
  if (shopTab >= P.shops.length) shopTab = 0;
  /* 🐛 [owner 2026-09-05: "พอจะเปิดร้านใหม่ เมนูมันไม่ขึ้นมา"] The "＋ เปิดร้านใหม่" button sets
     shopTab = -1 and re-renders. The clamp above only catches an index that is too HIGH, so -1
     survived it, `P.shops[-1]` was undefined, and `shopType(sh.type)` threw one line later — 33
     lines before the `if (shopTab < 0)` branch written to handle exactly this. The whole panel
     rendered nothing: no summary, no shop tabs, no opening form, and no error the player could see.

     The sentinel is checked where it is SET rather than where it was eventually read. A negative
     index is not an out-of-range shop, it is "no shop selected". The shop bar is built FIRST now,
     so the opening form still comes with a way back to the shop you already own — losing that was
     the first fix's own cost, and a screen with no way out is a second bug rather than a fix. */
  const sh = shopTab >= 0 ? P.shops[shopTab] : null;

  {
    const bar = document.createElement("div");
    bar.className = "area-tabs";
    bar.innerHTML = P.shops.map((x, i) => {
      const xt = shopType(x.type);
      return `<button class="area-tab${i === shopTab ? " active" : ""}" data-shoptab="${i}">
        <span style="color:#7cc47f">◆</span> ${xt.icon} ${xt.name}
        <span class="area-count">${SHOP_TIERS[x.tier].name}</span></button>`;
    }).join("") + `<button class="area-tab" data-newshop>＋ ${T("เปิดร้านใหม่")}</button>`;
    extra.appendChild(bar);
    bar.querySelectorAll("[data-shoptab]").forEach((b) => b.onclick = () => {
      shopTab = Number(b.dataset.shoptab); renderShops();
    });
    bar.querySelector("[data-newshop]").onclick = () => { shopTab = -1; renderShops(); };
  }

  // Answered after the bar is on screen and before anything reads `sh`, so the opening form keeps
  // a way back to the shop you already own.
  if (shopTab < 0) { renderShopOpening(grid, extra); return; }
  const t = shopType(sh.type);
  const tier = shopTier(sh);

  const perDay = sh.ledger.days ? (sh.ledger.revenue - sh.ledger.wages - sh.ledger.theft) / sh.ledger.days : 0;
  const summary = document.createElement("div");
  summary.className = "money-summary";
  summary.innerHTML = `
    <div class="money-stat"><span>${T("กำไรเฉลี่ย/วันในเกม")}</span>
      <b class="${perDay >= 0 ? "good" : "bad"}">${Math.round(perDay).toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("ค่าจ้างรวม/วัน")}</span><b class="bad">${Math.round(shopWagesPerDay(sh)).toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("ลูกค้าประจำ")}</span><b>${sh.regulars.toFixed(1)}/${tier.regulars}</b></div>
    <div class="money-stat"><span>${T("ชื่อเสียง")}</span><b class="${sh.rep > 0.7 ? "good" : sh.rep < 0.4 ? "bad" : ""}">${Math.round(sh.rep * 100)}%</b></div>
    <div class="money-stat"><span>${T("วัตถุดิบ / สินค้า")}</span><b>${sh.raw.toFixed(1)} / ${sh.goods.toFixed(1)}</b></div>
    <div class="money-stat"><span>${T("พนักงาน")}</span><b>${sh.staff.length}/${tier.slots}</b></div>`;
  extra.appendChild(summary);



  const panels = document.createElement("div");
  panels.className = "area-tabs";
  panels.innerHTML = [["floor", `🏪 ${T("หน้าร้าน")}`], ["staff", `👥 ${T("พนักงาน")} (${sh.staff.length})`], ["hire", `📋 ${T("รับสมัคร")}`]]
    .map(([id, label]) => `<button class="area-tab${shopPanel === id ? " active" : ""}" data-panel="${id}">${label}</button>`).join("");
  extra.appendChild(panels);
  panels.querySelectorAll("[data-panel]").forEach((b) => b.onclick = () => { shopPanel = b.dataset.panel; renderShops(); });

  if (shopPanel === "floor") renderShopFloor(grid, sh, t, tier);
  else if (shopPanel === "staff") renderShopStaff(grid, sh);
  else renderShopHiring(grid, sh, tier);
}

function renderShopOpening(grid, extra) {
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = `เปิดร้านของตัวเอง — ${SHOP_TIERS[0].cost.toLocaleString()} 💰 ต่อร้าน`;
  grid.appendChild(head);
  const note = document.createElement("div");
  note.className = "action-card full-card";
  note.innerHTML = `<div class="detail">
    ${currentLang() === "en" ? `
    A shop runs itself every game-day and <b>${T("ไม่กินช่องงาน")}</b> — but wages go out every day
    whether anything sold or not, which is the one reason this business can
    <b class="bad">${T("ขาดทุนได้จริง")}</b><br>
    The line is 🏹 hunters gather materials → 🔨 crafters process them → 💁 sellers sell ·
    you can also feed materials in from your own bag` : `
    ร้านทำงานเองทุกวันในเกม <b>${T("ไม่กินช่องงาน")}</b> — แต่ค่าจ้างพนักงานออกทุกวันไม่ว่าจะขายได้หรือไม่
    ซึ่งเป็นเหตุผลเดียวที่ธุรกิจนี้ <b class="bad">${T("ขาดทุนได้จริง")}</b><br>
    สายพานคือ 🏹 นักล่าหาวัตถุดิบ → 🔨 ช่างแปรรูป → 💁 พ่อค้าขาย · คุณส่งวัตถุดิบจากกระเป๋าเข้าไปเองก็ได้`}
    ${P.brand > 0.05 ? `<br><b class="good">⭐ ${currentLang() === "en"
        ? `Your standing brings ${(SHOP_BRAND_CARRY * P.brand).toFixed(1)} regulars to a new shop from day one`
        : `ชื่อเสียงที่สะสมไว้จะพาลูกค้าประจำ ${(SHOP_BRAND_CARRY * P.brand).toFixed(1)} คนมาให้ร้านใหม่ตั้งแต่วันแรก`}</b>` : ""}
  </div>`;
  grid.appendChild(note);

  for (const t of SHOP_TYPES) {
    const card = document.createElement("div");
    const afford = P.gold >= SHOP_TIERS[0].cost;
    card.className = "action-card" + (afford ? "" : " locked");
    card.innerHTML = `
      <div class="head"><div class="name">${t.icon} ${t.name}</div>
        <div class="req">${SHOP_TIERS[0].cost.toLocaleString()} 💰</div></div>
      <div class="detail">${t.note}<br>
        ${currentLang() === "en" ? `Sells <b>${t.goodName}</b> at ${t.goodValue} 💰 each · uses ${t.rawPerGood} material per unit` : `ขาย <b>${t.goodName}</b> ชิ้นละ ${t.goodValue} 💰 · ใช้วัตถุดิบ ${t.rawPerGood} หน่วย/ชิ้น`}<br>
        ${T("ฤดู")}: ${SEASONS.map((sn, i) => `${T(sn.replace(/^\S+\s*/, ""))} ×${t.season[i].toFixed(2)}`).join(" · ")}</div>`;
    if (afford) card.onclick = () => { openShop(t.id); shopTab = P.shops.length - 1; renderShops(); };
    grid.appendChild(card);
  }
}

function renderShopFloor(grid, sh, t, tier) {
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = "ตั้งราคาขาย — ถูกคนเยอะกำไรบาง แพงคนน้อยแต่ชื่อเสียงตก";
  grid.appendChild(head);

  const card = document.createElement("div");
  card.className = "action-card full-card";
  card.innerHTML = `
    <div class="detail">
      ราคาปกติของ<b>${t.goodName}</b>คือ ${t.goodValue} 💰 — ตอนนี้ตั้งไว้
      <b>${Math.round(t.goodValue * sh.price)} 💰</b> (×${sh.price.toFixed(2)})<br>
      เมื่อวานขายได้ ${(sh.lastSold || 0).toFixed(1)} ชิ้น จากลูกค้าที่เข้ามา ${(sh.lastCustomers || 0).toFixed(1)} คน
      ${sh.goods < 0.5 && (sh.lastCustomers || 0) > 0.5 ? '<br><b class="bad">⚠️ ของหมดชั้น — ลูกค้ามาแล้วไม่ได้ซื้อ ชื่อเสียงกำลังตก</b>' : ""}
      ${sh.raw > 5 && !shopStaffBy(sh, "crafter").length ? '<br><b class="bad">⚠️ วัตถุดิบกองอยู่แต่ไม่มีช่างแปรรูป</b>' : ""}
    </div>
    <div class="price-steps">${SHOP_PRICE_STEPS.map((p) =>
      `<button class="btn ghost small${Math.abs(p - sh.price) < 0.001 ? " on" : ""}" data-price="${p}">×${p.toFixed(2)}</button>`).join("")}</div>
    <div class="cd-actions">
      <button class="farm-btn plant" data-ship>📦 ส่งวัตถุดิบจากกระเป๋า</button>
      ${SHOP_TIERS[sh.tier + 1]
        ? `<button class="farm-btn harvest" data-upg>🏗️ ขยายเป็น${SHOP_TIERS[sh.tier + 1].name} (${SHOP_TIERS[sh.tier + 1].cost.toLocaleString()} 💰)</button>`
        : `<span class="req">ขยายจนสุดแล้ว</span>`}
    </div>`;
  grid.appendChild(card);
  card.querySelectorAll("[data-price]").forEach((b) => b.onclick = () => {
    sh.price = Number(b.dataset.price); save("ตั้งราคา"); renderShops();
  });
  card.querySelector("[data-ship]").onclick = () => openShipDialog(sh);
  card.querySelector("[data-upg]")?.addEventListener("click", () => { upgradeShop(sh); renderShops(); });

  const h2 = document.createElement("div");
  h2.className = "area-head";
  h2.textContent = "สายพานตอนนี้ — ใครคือคอขวด";
  grid.appendChild(h2);
  const flow = document.createElement("div");
  flow.className = "action-card full-card";
  const gd = P.gameDays;
  const rawIn = shopStaffBy(sh, "hunter").reduce((a, w) => a + staffOutput(w, gd), 0);
  const craft = shopStaffBy(sh, "crafter").reduce((a, w) => a + staffOutput(w, gd), 0);
  const sell = shopStaffBy(sh, "seller").reduce((a, w) => a + staffOutput(w, gd), 0);
  const goodsMade = craft / t.rawPerGood;
  const rows = [
    ["🏹 นักล่าหาวัตถุดิบ", `${rawIn.toFixed(1)} หน่วย/วัน`],
    ["🔨 ช่างแปรรูปได้", `${craft.toFixed(1)} หน่วย → ${goodsMade.toFixed(1)} ชิ้น/วัน`],
    ["💁 พ่อค้าขายไหว", `${sell.toFixed(1)} ชิ้น/วัน`],
    ["🙋 ลูกค้าที่เข้ามา", `${(sh.lastCustomers || 0).toFixed(1)} คน/วัน`],
  ];
  const worst = rawIn > craft + 0.5 ? "ช่างทำไม่ทัน — วัตถุดิบกองทิ้ง"
    : goodsMade > sell + 0.5 ? "พ่อค้าขายไม่ทัน — สินค้าค้างสต็อก"
    : goodsMade < (sh.lastCustomers || 0) - 0.5 ? "ของไม่พอขาย — ลูกค้ามาแล้วกลับ"
    : "สมดุลดี";
  flow.innerHTML = rows.map(([a, b]) => `<div class="reborn-row"><span class="rb-name">${a}</span>
      <span class="rb-num">${b}</span></div>`).join("")
    + `<div class="detail"><b>คอขวด:</b> ${worst}</div>`;
  grid.appendChild(flow);
}

function renderShopStaff(grid, sh) {
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = `พนักงาน ${sh.staff.length}/${shopTier(sh).slots} คน — ค่าจ้างรวม ${Math.round(shopWagesPerDay(sh)).toLocaleString()} 💰/วัน`;
  grid.appendChild(head);
  if (!sh.staff.length) {
    const none = document.createElement("div");
    none.className = "action-card full-card";
    none.innerHTML = `<div class="detail">ยังไม่มีใครทำงานอยู่เลย — ไปที่แท็บ <b>📋 รับสมัคร</b>
      อย่างน้อยต้องมีครบสามหน้าที่ ร้านถึงจะขายได้: 🏹 หาของ · 🔨 แปรรูป · 💁 ขาย</div>`;
    grid.appendChild(none);
    return;
  }
  const gd = P.gameDays;
  sh.staff.forEach((w, i) => {
    const role = STAFF_ROLES.find((r) => r.id === w.role);
    const loy = staffLoyalty(w, gd), mor = staffMorale(w, gd);
    const card = document.createElement("div");
    card.className = "action-card full-card";
    card.innerHTML = `
      <div class="head"><div class="name">${role.icon} ${escapeHtml(w.name)} — ${role.name}</div>
        <div class="req">${Math.round(staffSalary(w, gd)).toLocaleString()} 💰/วัน</div></div>
      <div class="detail">
        ขยัน ${Math.round(w.diligence * 100)}% · ซื่อสัตย์ ${Math.round(w.honesty * 100)}%
        ${w.role === "seller" ? ` · เสน่ห์ ${Math.round(w.charisma * 100)}%` : ""}<br>
        ทำงานมา ${((gd - w.hiredDay) / DAYS_PER_YEAR).toFixed(1)} ปี · ความผูกพัน ${Math.round(loy * 100)}%
        · ขวัญกำลังใจ <b class="${mor >= 1 ? "good" : mor < 0.75 ? "bad" : ""}">${Math.round(mor * 100)}%</b>
        ${staffTheft(w, gd) > 0.01 ? `<br><b class="bad">🕳️ กำลังยักยอกราว ${(staffTheft(w, gd) * 100).toFixed(1)}% ของรายรับ</b>` : ""}
      </div>
      <div class="price-steps">${SHOP_PAY_STEPS.map((r) =>
        `<button class="btn ghost small${Math.abs(r - w.payRatio) < 0.001 ? " on" : ""}" data-pay="${r}" data-i="${i}">${Math.round(r * 100)}%</button>`).join("")}</div>
      <div class="cd-actions"><button class="btn ghost" data-fire="${i}">👋 ให้ออก</button></div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-pay]").forEach((b) => b.onclick = () => {
    sh.staff[Number(b.dataset.i)].payRatio = Number(b.dataset.pay); save("ปรับค่าจ้าง"); renderShops();
  });
  grid.querySelectorAll("[data-fire]").forEach((b) => b.onclick = () => {
    fireStaff(sh, Number(b.dataset.fire)); renderShops();
  });
}

function renderShopHiring(grid, sh, tier) {
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = `ผู้สมัคร — ว่าง ${Math.max(0, tier.slots - sh.staff.length)} ตำแหน่ง`;
  grid.appendChild(head);
  const hint = document.createElement("div");
  hint.className = "action-card full-card";
  hint.innerHTML = `<div class="detail">
    ค่าสถิติของผู้สมัครแสดงเป็นช่วงจนกว่าจะจ่ายค่าตรวจประวัติ ${SHOP_VETTING_COST} 💰<br>
    <b>${T("ความซื่อสัตย์คือค่าที่คุ้มที่สุดที่จะรู้")}</b> — คนซื่อกดค่าจ้างได้โดยไม่โดนยักยอก คนไม่ซื่อจ่ายเต็มก็ไม่ขโมย
    แต่กดเมื่อไหร่เจอเมื่อนั้น</div>`;
  grid.appendChild(hint);

  sh.applicants.forEach((a, i) => {
    const role = STAFF_ROLES.find((r) => r.id === a.role);
    const band = (v) => v >= 0.75 ? "สูง" : v >= 0.5 ? "ปานกลาง" : "ต่ำ";
    const show = (v) => a.vetted ? `${Math.round(v * 100)}%` : band(v);
    const full = sh.staff.length >= tier.slots;
    const card = document.createElement("div");
    card.className = "action-card" + (full ? " locked" : "");
    card.innerHTML = `
      <div class="head"><div class="name">${role.icon} ${escapeHtml(a.name)}</div>
        <div class="req">${role.name} · ${a.wage} 💰/วัน</div></div>
      <div class="detail">${role.what}<br>
        ขยัน ${show(a.diligence)} · ซื่อสัตย์ ${show(a.honesty)}
        ${a.role === "seller" ? ` · เสน่ห์ ${show(a.charisma)}` : ""}
        ${a.vetted ? ' <b class="good">✔ ตรวจแล้ว</b>' : ""}</div>
      <div class="cd-actions">
        ${a.vetted ? "" : `<button class="btn ghost" data-vet="${i}">🔍 ตรวจประวัติ ${SHOP_VETTING_COST} 💰</button>`}
        <button class="farm-btn harvest" data-hire="${i}"${full ? " disabled" : ""}>🤝 จ้าง</button>
      </div>`;
    grid.appendChild(card);
  });
  const more = document.createElement("div");
  more.className = "action-card full-card";
  more.innerHTML = `<div class="cd-actions"><button class="btn ghost" data-reroll>🔄 เรียกผู้สมัครชุดใหม่</button></div>`;
  grid.appendChild(more);
  more.querySelector("[data-reroll]").onclick = () => { refreshApplicants(sh); renderShops(); };
  grid.querySelectorAll("[data-vet]").forEach((b) => b.onclick = () => { vetApplicant(sh, Number(b.dataset.vet)); renderShops(); });
  grid.querySelectorAll("[data-hire]").forEach((b) => b.onclick = () => { hireStaff(sh, Number(b.dataset.hire)); renderShops(); });
}

function openShipDialog(sh) {
  const items = Object.keys(P.inv).filter((id) => sellableCount(id) > 0 && (ITEMS[id]?.sell || 0) > 0)
    .sort((a, b) => (ITEMS[b].sell * sellableCount(b)) - (ITEMS[a].sell * sellableCount(a)));
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">📦 ส่งวัตถุดิบเข้าร้าน</div>
      <div class="modal-sub">คิดเป็นวัตถุดิบตามราคาที่พ่อค้ารับซื้อ — ทุก ${SHOP_RAW_PER_GOLD} 💰 = 1 หน่วย
        ของที่สวมอยู่จะไม่ถูกส่ง</div>
      <div class="ship-list">${items.length ? items.map((id) => {
        const n = sellableCount(id);
        return `<button class="ship-row" data-item="${id}">
          <span>${ITEMS[id].icon} ${escapeHtml(ITEMS[id].name)} ×${n}</span>
          <span class="lr-amt">+${(ITEMS[id].sell * n / SHOP_RAW_PER_GOLD).toFixed(1)} หน่วย</span></button>`;
      }).join("") : '<div class="modal-sub">${T("ไม่มีของที่ส่งได้")}</div>'}</div>
      <div class="modal-actions"><button class="btn" data-close>${T("ปิด")}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); renderShops(); refreshSidebar(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.querySelectorAll("[data-item]").forEach((b) => b.onclick = () => {
    const id = b.dataset.item;
    shipToShop(sh, id, sellableCount(id));
    save("ส่งวัตถุดิบ");
    close();
  });
}

function renderMoney() {
  $("#skill-title").textContent = "🏦 ธนาคารและการลงทุน";
  $("#skill-flavor").textContent = "ฝากกินดอกเบี้ย · ถือหุ้นกินปันผล · เก็งกำไรตอนราคาเหวี่ยง — แต่กำไรลงทุนต้องเสียภาษี";

  const d = today();
  const extra = $("#view-extra");
  extra.innerHTML = "";

  // --- purse summary: the four numbers that matter, always visible ---
  const profit = Math.round(P.tax?.yearProfit || 0);
  const rent = Math.round(P.tax?.yearRent || 0);
  const est = estimatedTaxNow();
  const summary = document.createElement("div");
  summary.className = "money-summary";
  summary.innerHTML = `
    <div class="money-stat"><span>${T("ทองในมือ")}</span><b class="${P.gold < 0 ? "bad" : ""}">${P.gold.toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("ฝากธนาคาร")}</span><b>${Math.floor(bankBalance()).toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("มูลค่าหุ้นที่ถือ")}</span><b>${Math.round(portfolioValue()).toLocaleString()}</b></div>
    ${/* 🎯 [owner 2026-08-23] "มันไม่ควรสร้างช่องใหม่มา · มันควรเอาค่าเช่าอสังหาปีที่ 2 ไปเพิ่ม ·
         ส่วนกล่องเดิมมันยังมีเรื่องกำไรลงทุนปีที่ 2 อยู่แล้ว" — I had added a second summary box below
         the tabs saying much of what this one already said. Rent belongs beside the profit it is
         taxed alongside, in the box that is always on screen. */ ""}
    <div class="money-stat"><span>${T("ค่าเช่าปีที่")} ${d.year}</span><b>${rent.toLocaleString()}</b></div>
    <div class="money-stat"><span>${currentLang() === "en" ? `Investment profit, year ${d.year}` : `กำไรลงทุนปีที่ ${d.year}`}</span><b>${profit.toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("ภาษีที่ต้องจ่ายถ้าจบปีนี้")}</span>
      <b class="${est > 0 ? "bad" : "good"}">${est.toLocaleString()}</b></div>`;
  extra.appendChild(summary);

  if (P.tax?.debtSinceDay != null && P.gold < 0) {
    const left = TAX_GRACE_DAYS - (Math.floor(P.gameDays) - P.tax.debtSinceDay);
    const warn = document.createElement("div");
    warn.className = "debt-banner";
    warn.innerHTML = `🚨 ค้างภาษีอยู่ ${Math.abs(P.gold).toLocaleString()} 💰 —
      เหลือเวลาอีก ${Math.max(0, Math.ceil(left / DAYS_PER_MONTH))} เดือนในเกม
      ถ้าทองยังติดลบเมื่อครบกำหนด เกมจะจบทันที และไม่ได้อะไรกลับมาเลย (ไม่เหมือนการจุติ)`;
    extra.appendChild(warn);
  }

  // --- bullet strip ---
  /* 🎯 [owner 2026-08-17] "เอาบัญชีขึ้นมาไว้อันแรกสุด และลบคำว่าภาษีออก" — the ledger answers "what
   * just happened to my money", which is what you open this page to find out, so it leads. And it
   * is only the ledger now: the tax ladder moved to its own page when tax became something you pay
   * by hand, and a tab still called บัญชีและภาษี would send people here looking for it. */
  const tabs = [
    { id: "ledger", label: `🧾 ${T("บัญชี")}`, count: "" },
    { id: "bank", label: `🏦 ${T("ธนาคาร")}`, count: "" },
    /* 🎯 [owner 2026-08-23] "ยุบรวมให้เหลือเมนูเดียว" — I had split these into three shelves by
       price band. One tab: the coins are already sorted by price inside it, so the bands were a
       navigation step that bought nothing. */
    { id: "coin", label: `🪙 ${T("คริปโต")}`,
      count: `${CRYPTOS.filter((c) => coinHeld(c.id) > 0).length}/${CRYPTOS.length}` },
    ...COMPANY_SIZES.map((sz) => ({
      id: sz.id, label: `${sz.icon} ${sz.name}`,
      count: `${COMPANIES.filter((c) => c.size === sz.id && heldShares(c.id) > 0).length}/${COMPANIES.filter((c) => c.size === sz.id).length}`,
    })),
  ];
  const bar = document.createElement("div");
  bar.className = "area-tabs";
  bar.innerHTML = tabs.map((t) => `<button class="area-tab${t.id === moneyTab ? " active" : ""}"
      data-mtab="${t.id}"><span style="color:#7cc47f">◆</span> ${t.label}
      ${t.count ? `<span class="area-count">${t.count}</span>` : ""}</button>`).join("");
  extra.appendChild(bar);
  bar.querySelectorAll("[data-mtab]").forEach((b) => b.onclick = () => {
    moneyTab = b.dataset.mtab; openCompany = null; renderMoney();
  });

  /* 🎯 [owner's ask] Ninety companies is too many to scan for "what do I already have" or "what
   * is left to buy". Two complementary filters, remembered like the shop's and the achievement
   * page's, so the answer is one click rather than a scroll. Both are defined by holding at least
   * one share — the 👑 badge is a separate thing (100%) and is not what these hide. */
  /* 🎯 [owner 2026-08-23] "bitcoin เพิ่มหัวข้อ ซ่อนที่มีแล้ว กับ ซ่อนที่ยังไม่ได้เป็นเจ้าของ" — the
     same pair the share tabs have, and fifty coins is exactly the length that makes them worth
     having. Their own preference keys, because "hide what I hold" means a different set on each
     page and sharing one key would make ticking it on one silently filter the other. */
  if (moneyTab !== "bank" && moneyTab !== "ledger") {
    const coins = moneyTab === "coin";
    const inTab = coins ? CRYPTOS : COMPANIES.filter((c) => c.size === moneyTab);
    const has = (x) => (coins ? coinHeld(x.id) > 0 : heldShares(x.id) > 0);
    const keyHeld = coins ? "hideHeldCoin" : "hideHeldCo";
    const keyUnheld = coins ? "hideUnheldCoin" : "hideUnheldCo";
    const held = inTab.filter(has).length;
    const filters = document.createElement("div");
    filters.className = "money-filters";
    filters.innerHTML = `
      <label class="hide-owned">
        <input type="checkbox" id="hide-held"${uiPref(keyHeld) ? " checked" : ""}>
        ซ่อนที่มีแล้ว (${held})
      </label>
      <label class="hide-owned">
        <input type="checkbox" id="hide-unheld"${uiPref(keyUnheld) ? " checked" : ""}>
        ซ่อนที่ยังไม่ได้เป็นเจ้าของ (${inTab.length - held})
      </label>`;
    extra.appendChild(filters);
    /* 🎯 [owner 2026-08-17] "ทำให้มันติ๊กสลับกัน ไม่ให้ติ๊กพร้อมกัน" — the two are opposites, and
     * ticking both hides every company on the page: a filter whose only reachable state is an empty
     * list. Turning one on turns the other off, so the reachable states are held-only, unheld-only,
     * or everything. */
    filters.querySelector("#hide-held").onchange = (e) => {
      setUiPref(keyHeld, e.target.checked);
      if (e.target.checked) setUiPref(keyUnheld, false);
      openCompany = null; renderMoney();
    };
    filters.querySelector("#hide-unheld").onchange = (e) => {
      setUiPref(keyUnheld, e.target.checked);
      if (e.target.checked) setUiPref(keyHeld, false);
      openCompany = null; renderMoney();
    };
  }

  const grid = $("#action-grid");
  grid.innerHTML = "";
  if (moneyTab === "bank") renderBankTab(grid);
  else if (moneyTab === "ledger") renderLedgerTab(grid);
  else if (moneyTab === "coin") renderCryptoTab(grid);
  else renderMarketTab(grid, moneyTab);
  highlightAction = null;
}

function renderBankTab(grid) {
  const rate = bankCurrentRate();
  const years = bankYearsHeld();
  const nextRate = bankRate(Math.floor(years) + 1);
  const daysToNext = Math.ceil((Math.floor(years) + 1) * DAYS_PER_YEAR - (P.gameDays - P.bank.sinceDay));
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = "🏦 ธนาคารมิธวูด — ยิ่งฝากนิ่งนาน ดอกเบี้ยยิ่งขึ้น";
  grid.appendChild(head);

  const card = document.createElement("div");
  card.className = "action-card bank-card";
  card.innerHTML = `
    <div class="head"><div class="name">💰 ยอดฝาก ${Math.floor(bankBalance()).toLocaleString()}</div>
      <div class="req">${(rate * 100).toFixed(1)}%/ปี</div></div>
    <div class="detail">
      ดอกเบี้ยวันละ <b class="good">${fmtNum(Math.round(bankSlips().reduce((t, sl) => t + sl.amount * slipRate(sl) / DAYS_PER_YEAR, 0)))}</b>
      · ได้รับปีที่ ${today().year} แล้ว <b class="good">${fmtNum(Math.round(P.bank.yearInterest || 0))}</b>
      · เข้าบัญชีทุกวันในเกม<br>
      <b>${T("ฝากแต่ละครั้งเป็นใบของตัวเอง")}</b> มีอายุและดอกเบี้ยของมันเอง — ถอนจะกินใบใหม่สุดก่อน
      ใบเก่าจึงไม่เสียอายุ<br>
      ดอกเบี้ยนับเป็นกำไรลงทุน จึงถูกคิดภาษีปลายปีเหมือนปันผล
    </div>
    <div class="bank-row">
      <input type="number" id="bank-amt" min="1" placeholder="จำนวนทอง">
      <button class="farm-btn plant" data-dep>${T("ฝาก")}</button>
      <button class="farm-btn harvest" data-wd>${T("ถอน")}</button>
    </div>
    <div class="bank-row quick">
      <button class="q-half" data-quick="dep-half">${T("ฝากครึ่งหนึ่ง")}</button>
      <button class="q-in" data-quick="dep-all">${T("ฝากทั้งหมด")}</button>
      <button class="q-out" data-quick="wd-all">${T("ถอนทั้งหมด")}</button>
    </div>`;
  grid.appendChild(card);

  /* 🎯 [owner 2026-08-18] Two separate things, and they had been conflated: the NUMBER belongs to
   * the slip's AGE — oldest is ใบที่ 1 and keeps that number as new ones arrive — while the ORDER on
   * screen is newest first, 3 · 2 · 1, so the slip a withdrawal eats next is the one at the top.
   * Numbering by screen position is what broke it: it handed "ใบที่ 1" to whatever was deposited
   * most recently and renumbered the entire stack on every deposit. */
  const slips = [...bankSlips()]
    .sort((a, b) => (a.sinceDay || 0) - (b.sinceDay || 0))
    .map((sl, i) => ({ sl, no: i + 1 }))
    .reverse();
  if (slips.length) {
    const h = document.createElement("div");
    h.className = "area-head";
    h.textContent = `📄 ใบฝาก ${slips.length} ใบ — ถอนจะกินจากบนลงล่าง`;
    /* Numbers are re-derived from age on every render, never stored: slips are closed and merged,
     * and a stored id would leave the list reading 1, 2, 5, 7, 14. */
    grid.appendChild(h);
    slips.forEach(({ sl, no }, n) => {
      const first = n === 0;
      const r = slipRate(sl);
      const yrs = slipYears(sl);
      const toNext = Math.ceil((Math.floor(yrs) + 1) * DAYS_PER_YEAR - (P.gameDays - sl.sinceDay));
      const c = document.createElement("div");
      c.className = "action-card" + (first && slips.length > 1 ? " running" : "");
      c.innerHTML = `
        <div class="head"><div class="name">📄 ใบที่ ${no} · ${Math.floor(sl.amount).toLocaleString()} 💰</div>
          <div class="req">${(r * 100).toFixed(1)}%/ปี</div></div>
        <div class="detail">ฝากนิ่งมาแล้ว ${yrs.toFixed(2)} ปีในเกม
          ${r < BANK_MAX_RATE ? `· อีก ${toNext} วันจะขึ้นเป็น ${(bankRate(Math.floor(yrs) + 1) * 100).toFixed(1)}%/ปี`
                              : "· ถึงเพดานแล้ว"}
          ${first && slips.length > 1 ? '<br><b class="bad">◀ ใบนี้จะถูกถอนก่อน</b>' : ""}</div>`;
      grid.appendChild(c);
    });
  }
  const amt = () => Math.floor(Number(card.querySelector("#bank-amt")?.value || 0));
  card.querySelector("[data-dep]").onclick = () => bankDeposit(amt());
  card.querySelector("[data-wd]").onclick = () => bankWithdraw(amt());
  card.querySelectorAll("[data-quick]").forEach((b) => b.onclick = () => {
    if (b.dataset.quick === "dep-half") bankDeposit(Math.floor(P.gold / 2));
    else if (b.dataset.quick === "dep-all") bankDeposit(P.gold);
    else bankWithdraw(Math.floor(bankBalance()));
  });
}

/* 🎯 [owner 2026-08-23] The crypto tab. Deliberately NOT a copy of the share card: there is no
 * dividend line, no ownership badge and no yield, because none of them exist here. What it shows
 * instead is the two things a speculator acts on — where the price is against what it usually is,
 * and where it is against what YOU paid. */
/* 🎯 [owner 2026-08-23] "ยุบรวมให้เหลือเมนูเดียว แล้วปรับแต่งให้สวยงามเหมือนในรูป" — the share
 * card's layout, which is the one already proven on this page: name on the left, price with a
 * coloured move on the right, and one compact row of figures underneath.
 *
 * The row says different things, because a coin is a different instrument: there is no yield and no
 * pay-out interval, so what fills that space is how violently it moves, where it sits against its
 * own usual level, and — once you hold some — what your position is actually worth.
 *
 * Sorted cheapest first so the list itself does the work the price bands were doing. */
function renderCryptoTab(grid) {
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = "🪙 คริปโต — ไม่มีปันผล กำไรอยู่ที่ส่วนต่างราคาอย่างเดียว";
  grid.appendChild(head);

  const anyHeld = CRYPTOS.filter((c) => coinHeld(c.id) > 0);
  if (anyHeld.length) {
    const worth = Math.round(cryptoValue());
    const paid = Math.round(anyHeld.reduce((t, c) => t + coinCost(c.id) * coinHeld(c.id), 0));
    const net = worth - paid;
    const sum = document.createElement("div");
    sum.className = "money-summary";
    sum.innerHTML = `
      <div class="money-stat"><span>${T("เหรียญที่ถือ")}</span><b>${anyHeld.length}</b></div>
      <div class="money-stat"><span>${T("ทุนที่จมอยู่")}</span><b>${fmtNum(paid)}</b></div>
      <div class="money-stat"><span>${T("มูลค่าตอนนี้")}</span><b>${fmtNum(worth)}</b></div>
      <div class="money-stat"><span>${T("กำไร/ขาดทุนถ้าขายตอนนี้")}</span><b class="${net < 0 ? "bad" : "good"}">${
        net < 0 ? "-" : "+"}${fmtNum(Math.abs(net))}</b> ${pctTag(paid ? worth / paid : 1)}</div>`;
    grid.appendChild(sum);
  }

  /* Same two filters the share tabs use, on their own keys — see the block in renderMoney. */
  const all = [...CRYPTOS].sort((a, b) => a.base - b.base);
  const shown = all.filter((c) => {
    const has = coinHeld(c.id) > 0;
    return !((has && uiPref("hideHeldCoin")) || (!has && uiPref("hideUnheldCoin")));
  });
  if (!shown.length) {
    const none = document.createElement("div");
    none.className = "area-head";
    none.textContent = "ตัวกรองซ่อนไว้ทั้งหมด — เอาเครื่องหมายถูกออกสักอันเพื่อดูรายการ";
    grid.appendChild(none);
    return;
  }
  if (shown.length < all.length) head.textContent += `  ·  แสดง ${shown.length}/${all.length}`;

  for (const c of shown) {
    const px = coinPrice(c.id);
    const units = coinHeld(c.id);
    const drift = (px - c.base) / c.base;
    const swing = c.vol >= 0.3 ? T("เหวี่ยงแรงมาก") : c.vol >= 0.15 ? T("เหวี่ยงแรง") : T("ค่อยๆ ขยับ");
    const mine = units > 0 ? Math.round(px * units - coinCost(c.id) * units) : 0;
    const card = document.createElement("div");
    card.className = "action-card company-card" + (units ? " running" : "");
    card.innerHTML = `
      <div class="head">
        <div class="name">${c.icon} ${escapeHtml(c.name)}</div>
        <div class="req ${drift > 0.04 ? "px-up" : drift < -0.04 ? "px-down" : ""}">
          ${money(px)} <span class="px-drift">${drift >= 0 ? "▲" : "▼"} ${Math.abs(drift * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div class="detail company-line">
        <span>${swing}</span>
        <span>${T("ปกติ ")}<b>${money(c.base)}</b></span>
        ${units
          ? `<span>${T("ถือ ")}<b>${units.toLocaleString()}</b></span>
             <span>${T("ทุน ")}<b>${money(coinCost(c.id))}</b></span>
             <span class="${mine < 0 ? "bad" : "good"}">${mine < 0 ? "-" : "+"}${fmtNum(Math.abs(mine))}</span>`
          : `<span class="dim">${T("มูลค่าต่อหน่วย")} ${money(px)}</span>`}
      </div>
      <div class="cd-actions">
        <button class="btn ghost small" data-buycoin="${c.id}" data-n="1">${T("ซื้อ")} 1</button>
        <button class="btn ghost small" data-buycoin="${c.id}" data-n="10">${T("ซื้อ")} 10</button>
        <button class="btn ghost small" data-buycoin="${c.id}" data-n="max">${T("ซื้อเท่าที่ไหว")}</button>
        ${units ? `<button class="btn ghost small" data-sellcoin="${c.id}" data-n="${Math.ceil(units / 2)}">${T("ขายครึ่ง")}</button>
          <button class="btn ghost small" data-sellcoin="${c.id}" data-n="all">${T("ขายหมด")}</button>` : ""}
      </div>`;
    grid.appendChild(card);
  }

  grid.querySelectorAll("[data-buycoin]").forEach((b) => b.onclick = () => {
    const id = b.dataset.buycoin;
    const n = b.dataset.n === "max" ? Math.floor(P.gold / Math.max(0.01, coinPrice(id))) : Number(b.dataset.n);
    buyCoin(id, n);
  });
  grid.querySelectorAll("[data-sellcoin]").forEach((b) => b.onclick = () => {
    const id = b.dataset.sellcoin;
    sellCoin(id, b.dataset.n === "all" ? coinHeld(id) : Number(b.dataset.n));
  });
}

function renderMarketTab(grid, sizeId) {
  const sz = COMPANY_SIZES.find((x) => x.id === sizeId);
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = `${sz.icon} ${sz.name} — ${sz.note}`;
  grid.appendChild(head);

  const all = COMPANIES.filter((x) => x.size === sizeId);
  const shown = all.filter((c) => {
    const has = heldShares(c.id) > 0;
    return !((has && uiPref("hideHeldCo")) || (!has && uiPref("hideUnheldCo")));
  });
  if (!shown.length) {
    const none = document.createElement("div");
    none.className = "area-head";
    none.textContent = all.length
      ? "ตัวกรองซ่อนไว้ทั้งหมด — เอาเครื่องหมายถูกออกสักอันเพื่อดูรายการ"
      : "ยังไม่มีกิจการในหมวดนี้";
    grid.appendChild(none);
    return;
  }
  if (shown.length < all.length) head.textContent += `  ·  แสดง ${shown.length}/${all.length}`;

  for (const c of shown) {
    const px = sharePrice(c.id);
    const shares = heldShares(c.id);
    const drift = (px - c.base) / c.base;
    const open = openCompany === c.id;
    const card = document.createElement("div");
    card.className = "action-card company-card" + (shares ? " running" : "") + (open ? " open" : "");
    // Collapsed: only what decides a purchase — price vs fair value, yield, how often it pays.
    card.innerHTML = `
      <div class="head">
        <div class="name">${c.icon} ${escapeHtml(c.name)}${isOwner(c.id) ? ' <span class="owner-badge">👑 เจ้าของ</span>' : ""}</div>
        <div class="req ${drift > 0.04 ? "px-up" : drift < -0.04 ? "px-down" : ""}">
          ${Math.round(px).toLocaleString()} <span class="px-drift">${drift >= 0 ? "▲" : "▼"} ${Math.abs(drift * 100).toFixed(0)}%</span>
        </div>
      </div>
      <div class="detail company-line">
        <span>${T("ปันผล ")}<b>${(c.yield * 100).toFixed(0)}%/ปี</b></span>
        <span>${T("จ่ายทุก ")}<b>${c.divDays} วัน</b></span>
        <span>${T("ถือ ")}<b>${shares}%</b></span>
        <span class="dim">ซื้อขาด ${(c.base * SHARES_PER_COMPANY).toLocaleString()}</span>
      </div>
      ${open ? companyDetailHtml(c, px, shares) : ""}`;
    card.onclick = (e) => {
      if (e.target.closest(".company-detail")) return;   // clicks inside the panel are its own
      openCompany = open ? null : c.id;
      renderMoney();
    };
    if (open) wireCompanyDetail(card, c);
    grid.appendChild(card);
  }
}

function companyDetailHtml(c, px, shares) {
  const perPayout = divRound(shares * c.base * c.yield * (c.divDays / DAYS_PER_YEAR)
    * (shares >= SHARES_PER_COMPANY ? 1 + OWNER_DIVIDEND_BONUS : 1));
  const h = P.holdings?.[c.id];
  const value = Math.round(shares * px);
  const pl = h ? value - h.cost : 0;
  const room = SHARES_PER_COMPANY - shares;
  return `<div class="company-detail">
    <div class="cd-grid">
      <div><span>${T("ราคายุติธรรม")}</span><b>${c.base.toLocaleString()}</b></div>
      <div><span>${T("ราคาตอนนี้")}</span><b>${Math.round(px).toLocaleString()}</b></div>
      <div><span>${T("ความเหวี่ยงต่อวัน")}</span><b>±${(c.vol * 100).toFixed(1)}%</b></div>
      <div><span>${T("ปันผลรอบหน้าของคุณ")}</span><b>${perPayout.toLocaleString()}</b></div>
      ${h ? `<div><span>ต้นทุนที่จ่ายไป</span><b>${h.cost.toLocaleString()}</b></div>
             <div><span>กำไร/ขาดทุนถ้าขายตอนนี้</span>
               <b class="${pl >= 0 ? "good" : "bad"}">${pl >= 0 ? "+" : ""}${pl.toLocaleString()}</b></div>` : ""}
    </div>
    <div class="cd-note">ปันผลคิดจากราคายุติธรรม ไม่ใช่ราคาตลาด — ราคาเหวี่ยงไม่ทำให้ปันผลเหวี่ยงตาม
      · ถือครบ 100% ปันผล +${Math.round(OWNER_DIVIDEND_BONUS * 100)}%
      · กำไรจากการขายและปันผลถูกคิดภาษีปลายปี</div>
    <div class="cd-actions">
      <button data-buy="1"${room < 1 ? " disabled" : ""}>ซื้อ 1%</button>
      <button data-buy="10"${room < 1 ? " disabled" : ""}>ซื้อ 10%</button>
      <button data-buy="max"${room < 1 ? " disabled" : ""}>${T("ซื้อเท่าที่ไหว")}</button>
      <button data-sell="1"${shares < 1 ? " disabled" : ""}>ขาย 1%</button>
      <button data-sell="10"${shares < 1 ? " disabled" : ""}>ขาย 10%</button>
      <button data-sell="all"${shares < 1 ? " disabled" : ""}>${T("ขายทั้งหมด")}</button>
    </div>
  </div>`;
}

function wireCompanyDetail(card, c) {
  card.querySelectorAll("[data-buy]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const v = b.dataset.buy;
    buyShares(c.id, v === "max" ? Math.floor(P.gold / sharePrice(c.id)) : Number(v));
  });
  card.querySelectorAll("[data-sell]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const v = b.dataset.sell;
    sellShares(c.id, v === "all" ? heldShares(c.id) : Number(v));
  });
}

/* 🎯 [2026-08-17, owner: "รายการเงินล่าสุด / ข้อมูล / ภาษีขั้นบันได / ข้อมูล / แบบนี้"] These were a
 * switch, on the reasoning that stacking them meant scrolling past a static table to reach the
 * lines you actually wanted. In practice the switch hid the tax ladder: nothing on the ledger view
 * says what the year is going to cost, so the answer had to be hunted for rather than seen. Both
 * are on the page now, log first because it is what changes.
 *
 * 🎯 [owner 2026-08-17: "แสดง 10 รายการ พอ"] Ten lines on screen, sixty still kept. Stacking the
 * tax ladder underneath is what makes the length matter — a full sixty pushed it off the page, and
 * the whole point of stacking was that it should be visible without hunting. The store stays at
 * sixty because it costs nothing and it is the only record of where a year's profit came from. */
/* 🎯 [owner 2026-08-22] "ให้แสดงเพิ่มเป็น 15 ข้อมูลล่าสุด จาก 10" — asked for in the same breath as
   putting rent and shop takings into the ledger, which is what makes the extra room necessary. */
const LEDGER_SHOWN = 15;

function renderLedgerTab(grid) {
  const all = P.ledger || [];
  const shown = all.slice(0, LEDGER_SHOWN);
  const logHead = document.createElement("div");
  logHead.className = "area-head";
  /* No count in the heading: "10 จาก 60" reads as a truncation warning for a list nobody asked to
   * see all of, and the sixty are kept for the year's record rather than for reading here. */
  logHead.textContent = "📒 รายการเงินล่าสุด";
  grid.appendChild(logHead);
  const log = document.createElement("div");
  log.className = "action-card ledger-card full-card";
  log.innerHTML = shown.length
    ? `<div class="ledger-list">${shown.map((e) => `<div class="ledger-row">
        <span class="lr-date">ปี ${e.y}/${e.m}/${e.dd}</span>
        <span class="lr-text">${e.icon} ${escapeHtml(e.text)}</span>
        <span class="lr-amt ${e.amount >= 0 ? "good" : "bad"}">${e.amount >= 0 ? "+" : ""}${e.amount.toLocaleString()}</span>
      </div>`).join("")}</div>`
    : `<div class="detail">${T("ยังไม่มีรายการ — ลองฝากเงินหรือซื้อหุ้นสักกิจการดู")}</div>`;
  grid.appendChild(log);

}

/* --- Tax view ------------------------------------------------------------------------
 * 🎯 [owner 2026-08-17] "ในหน้าธนาคารและการลงทุน มันมีข้อมูลภาษี ให้ย้ายออกไป แล้วใส่รายละเอียดภาษี
 * เรทแต่ละประเภท และการกดจ่ายเองได้"
 *
 * Its own page, under the bank in the sidebar. Three ladders you can read before they apply to you,
 * a live reading of what each one is currently assessed on, and the bills with a button. */

/* The tax rules panel. One block per language: it is a rule explanation where the sentences depend
 * on each other, and the day thresholds are interpolated in positions the two languages order
 * differently. */
function taxRulesText() {
  const daily = Math.round(TAX_LATE_DAILY * 1000) / 10;
  const example = fmtNum(Math.round(1000000 * Math.pow(1 + TAX_LATE_DAILY, TAX_FATAL_DAYS - TAX_SEIZE_DAYS)));
  if (currentLang() === "en") {
    return `
        <b>Tax accrues every day</b> — charged on what you actually hold that day, and kept.
        Moving money out later does not erase what has already accrued, but every day after that is
        charged on the smaller pile.
        <br><b>Pay as much as you like, whenever you like</b> — anything paid comes off the year-end bill
        <br><br><b>At year end</b> whatever is unpaid is taken at once, from your pocket first and then
        the bank. If the two together are not enough, <b class="bad">your money goes negative</b> and it
        becomes an outstanding bill.
        <br><br><b>After that</b>
        <br>· Days 1–${TAX_SEIZE_DAYS} — no interest, pay at your own pace
        <br>· Day ${TAX_SEIZE_DAYS + 1} onward — <b class="bad">${daily}% a day, compounding</b>, and your
        businesses are seized: their income drops to 0
        <br>· Unpaid for <b class="bad">${TAX_FATAL_DAYS} days</b> — the run ends
        <br><br><span class="muted">For scale: owe ${fmtNum(1000000)}, pay nothing for the full
        ${TAX_FATAL_DAYS} days, and it becomes ${example}</span>`;
  }
  return `
        <b>ภาษีเดินทุกวัน</b> — คิดจากสิ่งที่ถืออยู่จริงในวันนั้น แล้วสะสมไว้
        ย้ายเงินออกทีหลังไม่ลบของที่สะสมไปแล้ว แต่ทุกวันหลังจากนั้นจะคิดจากกองที่เล็กลง
        <br><b>จ่ายล่วงหน้าเท่าไหร่ก็ได้ เมื่อไหร่ก็ได้</b> — ที่จ่ายแล้วหักออกจากบิลสิ้นปี
        <br><br><b>สิ้นปี</b> ส่วนที่ยังไม่ได้จ่ายจะถูกหักทันที จากกระเป๋าก่อนแล้วธนาคาร
        ถ้ารวมกันยังไม่พอ <b class="bad">เงินจะติดลบ</b> และกลายเป็นบิลค้าง
        <br><br><b>หลังจากนั้น</b>
        <br>· วันที่ 1–${TAX_SEIZE_DAYS} — ปลอดดอกเบี้ย จ่ายได้ตามสบาย
        <br>· วันที่ ${TAX_SEIZE_DAYS + 1} เป็นต้นไป — <b class="bad">ดอกทบต้นทบดอกวันละ ${daily}%</b> และธุรกิจถูกยึด รายได้เป็น 0
        <br>· ค้างครบ <b class="bad">${TAX_FATAL_DAYS} วัน</b> — จบเกม
        <br><br><span class="muted">ตัวอย่าง: ค้าง ${fmtNum(1000000)} ไม่จ่ายเลยจนครบ ${TAX_FATAL_DAYS} วัน จะกลายเป็น ${example}</span>`;
}

function renderTax() {
  $("#skill-title").textContent = "🧾 ภาษี";
  $("#skill-flavor").textContent = "ประเมินปีละครั้ง · ชำระเอง · ค้างนานถูกยึดธุรกิจ";
  const owed = taxOwedTotal();
  const running = taxAccruedTotal();
  const overdue = taxOverdueDays();
  const seized = taxSeized();
  $("#view-extra").innerHTML = `
    <div class="money-summary">
      <div class="money-stat"><span>${T("ค้างชำระ (ปีก่อน)")}</span>
        <b class="${owed > 0 ? "bad" : "good"}">${fmtNum(owed)}</b></div>
      <div class="money-stat"><span>${T("ปีนี้สะสมถึงวันนี้")}</span>
        <b class="${running > 0 ? "" : "good"}">${fmtNum(running)}</b></div>
      <div class="money-stat"><span>${T("จ่ายภาษีสะสมทั้งชีวิต")}</span>
        <b>${fmtNum(Math.round(P.tax?.paidTotal || 0))}</b></div>
      <div class="money-stat"><span>${T("สถานะ")}</span>
        <b class="${seized ? "bad" : "good"}">${seized ? `🚨 ${T("ธุรกิจถูกยึด")}` : T("ปกติ")}</b></div>
      ${owed > 0 ? `<div class="money-stat"><span>${overdue < TAX_SEIZE_DAYS ? "ปลอดดอกอีก" : "เหลือก่อนจบเกม"}</span>
        <b class="${overdue >= TAX_SEIZE_DAYS ? "bad" : ""}">${overdue < TAX_SEIZE_DAYS
          ? `${TAX_SEIZE_DAYS - overdue} วัน` : `${Math.max(0, TAX_FATAL_DAYS - overdue)} วัน`}</b></div>` : ""}
    </div>
    <!-- 🎯 [owner 2026-08-22] He asked for the timeline written out in his own framing: what happens
         at year end, the thirty clear days, and what the interest costs after. A rule the player has
         to infer from a countdown is a rule they meet by surprise. -->
    <div class="action-card full-card tax-explain">
      <div class="detail">${taxRulesText()}</div>
    </div>`;

  const grid = $("#action-grid");
  grid.innerHTML = "";

  const bills = taxBills();
  const h1 = document.createElement("div");
  h1.className = "area-head";
  h1.textContent = bills.length ? `📋 บิลที่ต้องชำระ ${bills.length} ใบ` : "📋 ไม่มีบิลค้างชำระ";
  grid.appendChild(h1);

  if (!bills.length) {
    const none = document.createElement("div");
    none.className = "action-card full-card";
      none.innerHTML = `<div class="detail">${currentLang() === "en"
        ? `Tax accrues daily on what you actually hold that day — pay as much as you like, whenever you like.<br>At new year anything unpaid is taken from your pocket and then the bank at once; if that is not enough your money goes negative.<br>After assessment you have ${TAX_SEIZE_DAYS} days before interest starts compounding at ${Math.round(TAX_LATE_DAILY * 1000) / 10}% a day · unpaid for ${TAX_FATAL_DAYS} days ends the run`
        : `ภาษีเดินสะสมทุกวันตามที่ถืออยู่จริงในวันนั้น — จ่ายล่วงหน้าเท่าไหร่ก็ได้ เมื่อไหร่ก็ได้\n<br>ขึ้นปีใหม่ ส่วนที่ยังไม่ได้จ่ายจะถูกหักจากกระเป๋าแล้วธนาคารทันที ถ้าไม่พอจะติดลบ\n<br>หลังประเมิน มีเวลา ${TAX_SEIZE_DAYS} วันก่อนเริ่มคิดดอกทบวันละ ${Math.round(TAX_LATE_DAILY * 1000) / 10}% · ค้างครบ ${TAX_FATAL_DAYS} วันคือจบเกม`}</div>`;
    grid.appendChild(none);
  } else {
    const payAll = document.createElement("div");
    payAll.className = "action-card full-card";
    payAll.innerHTML = `
      <div class="head"><div class="name">รวมทั้งหมด ${fmtNum(owed)} 💰</div>
        <div class="req">มีจ่าย ${fmtNum(Math.max(0, Math.floor(P.gold)) + Math.floor(bankBalance()))}</div></div>
      <div class="detail">${T("หักจากทองในมือก่อน แล้วจึงดึงจากเงินฝาก (ใบใหม่สุดก่อน)")}</div>
      <div class="cd-actions"><button class="farm-btn harvest" data-paytax="all">🧾 ชำระทั้งหมด</button></div>`;
    grid.appendChild(payAll);

    for (const b of bills) {
      const k = TAX_KINDS.find((x) => x.id === b.kind);
      const late = Math.floor(P.gameDays) - b.assessedDay;
      const card = document.createElement("div");
      card.className = "action-card" + (late >= TAX_SEIZE_DAYS ? " dead-card" : "");
      card.innerHTML = `
        <div class="head"><div class="name">${k.icon} ${k.name} · ปีที่ ${b.year}${
          b.pastLife ? " (ชาติก่อน)" : ""}</div>
          <div class="req ${late >= TAX_SEIZE_DAYS ? "bad" : ""}">${fmtNum(b.amount - b.paid)}</div></div>
        <div class="detail">ประเมินจาก ${fmtNum(b.base)} (${escapeHtml(k.what)})
          ${b.paid ? `<br>จ่ายไปแล้ว ${fmtNum(b.paid)} จาก ${fmtNum(b.amount)}` : ""}
            <!-- 🎯 [owner 2026-08-22] The timeline he set: one month clear, then daily
                 compounding, then the run ends at three. All three numbers belong on the card — a
                 deadline the player cannot see is not a deadline, it is an ambush. -->
            <br>ค้างมา ${late} วัน${late >= TAX_SEIZE_DAYS
              ? ` — <b class="bad">ดอกเบี้ยทบวันละ ${Math.round(TAX_LATE_DAILY * 1000) / 10}% · ธุรกิจถูกยึด · เหลือ ${Math.max(0, TAX_FATAL_DAYS - late)} วันก่อนจบเกม</b>`
              : ` · ยังไม่มีดอก เริ่มคิดเมื่อครบ ${TAX_SEIZE_DAYS} วัน (อีก ${TAX_SEIZE_DAYS - late} วัน) · ค้างครบ ${TAX_FATAL_DAYS} วันคือจบเกม`}</div>
        <div class="cd-actions"><button class="farm-btn harvest" data-paytax="${b.id}">${T("ชำระใบนี้")}</button></div>`;
      grid.appendChild(card);
    }
  }

  /* 🎯 [owner 2026-08-17] The year in progress, payable today. Seeing it build a little each day —
   * and being able to clear it a little each day — is the whole point: "ผ่อนจ่ายรายวันได้ง่าย คุมเงิน
   * ง่าย ไม่ต้องรอจ่ายก้อนโต". */
  const hNow = document.createElement("div");
  hNow.className = "area-head";
  hNow.textContent = `📆 ปีที่ ${today().year} — สะสมมาแล้ว ${Math.round(taxYearElapsed() * 100)}% ของปี`;
  grid.appendChild(hNow);

  if (running <= 0) {
    const none = document.createElement("div");
    none.className = "action-card full-card";
    none.innerHTML = `<div class="detail">${T("ยังไม่ถึงเกณฑ์ของประเภทไหนเลย — ไม่มีอะไรสะสมอยู่ตอนนี้")}</div>`;
    grid.appendChild(none);
  } else {
    const all = document.createElement("div");
    all.className = "action-card full-card";
    all.innerHTML = `
      <div class="head"><div class="name">จ่ายล่วงหน้าทั้งหมด ${fmtNum(running)} 💰</div></div>
      <div class="detail">จ่ายก่อนได้ทุกวัน ไม่ต้องรอสิ้นปี — ที่จ่ายไปแล้วจะถูกหักออกจากบิลตอนขึ้นปีใหม่</div>
      <div class="cd-actions"><button class="farm-btn harvest" data-payacc="all">🧾 จ่ายล่วงหน้าทั้งหมด</button></div>`;
    grid.appendChild(all);
  }

  for (const k of TAX_KINDS) {
    const acc = taxAccruedFor(k.id);
    const full = taxOwedFor(k.id, taxBaseFor(k.id));
    if (full <= 0 && acc <= 0) continue;
    const card = document.createElement("div");
    card.className = "action-card" + (acc <= 0 ? " running" : "");
    card.innerHTML = `
      <div class="head"><div class="name">${k.icon} ${k.name}</div>
        <div class="req ${acc > 0 ? "" : "good"}">${acc > 0 ? fmtNum(acc) : "จ่ายครบถึงวันนี้"}</div></div>
      <div class="detail">ฐานตอนนี้ ${fmtNum(taxBaseFor(k.id))} → ทั้งปี ${fmtNum(full)}
        ${k.id === "business" ? " (คิดจากกำไรที่ทำได้แล้ว)" : ` (คิดตามสัดส่วนของปี ${Math.round(taxYearElapsed() * 100)}%)`}
        ${taxPrepaid(k.id) ? `<br>จ่ายล่วงหน้าไปแล้ว ${fmtNum(taxPrepaid(k.id))}` : ""}</div>
      ${acc > 0 ? `<div class="cd-actions">
        <button class="farm-btn harvest" data-payacc="${k.id}">จ่ายส่วนนี้</button></div>` : ""}`;
    grid.appendChild(card);
  }

  const h2 = document.createElement("div");
  h2.className = "area-head";
  h2.textContent = "📐 อัตราภาษีแต่ละประเภท — คิดแบบขั้นบันได เสียเฉพาะส่วนที่เกิน";
  grid.appendChild(h2);

  for (const k of TAX_KINDS) {
    const base = taxBaseFor(k.id);
    const would = taxOwedFor(k.id, base);
    const rows = [`<tr><td>${currentLang() === "en" ? `Up to ${fmtNum(k.free)}` : `ไม่เกิน ${fmtNum(k.free)}`}</td><td>${T("ยกเว้น")}</td><td></td></tr>`];
    let floor = k.free;
    for (const b of k.brackets) {
      const hit = base > floor;
      rows.push(`<tr class="${hit ? "band-hit" : ""}"><td>${fmtNum(floor)} – ${
        b.upTo === Infinity ? T("ขึ้นไป") : fmtNum(b.upTo)}</td>
        <td>${(b.rate * 100).toFixed(1)}%</td><td>${hit ? `◀ ${T("ถึงขั้นนี้แล้ว")}` : ""}</td></tr>`);
      floor = b.upTo;
    }
    const card = document.createElement("div");
    card.className = "action-card ledger-card full-card";
    card.innerHTML = `
      <div class="head"><div class="name">${k.icon} ${k.name}</div>
        <div class="req">${T("ตอนนี้")} ${fmtNum(base)} → ${fmtNum(would)}</div></div>
      <div class="detail">${escapeHtml(k.what)}</div>
      <table class="tax-table"><tr><th>${T("ช่วง")}</th><th>${T("อัตรา")}</th><th></th></tr>${rows.join("")}</table>`;
    grid.appendChild(card);
  }

  grid.querySelectorAll("[data-paytax]").forEach((b) => b.onclick = () => {
    const id = b.dataset.paytax;
    if (id === "all") payAllTax(); else payTaxBill(id);
    renderTax();
  });
  grid.querySelectorAll("[data-payacc]").forEach((b) => b.onclick = () => {
    const id = b.dataset.payacc;
    if (id === "all") for (const k of TAX_KINDS) payTaxAccrued(k.id);
    else payTaxAccrued(id);
    renderTax();
  });
}

/* --- Rebirth view ------------------------------------------------------------------- */

/* The rebirth briefing, composed per language.
 *
 * Written as one block per language rather than a dozen T() calls threaded through the markup.
 * Every line here is a full sentence that only makes sense next to the others, and half of them
 * carry interpolated numbers in positions the two languages do not share — "เหลือ 90%" puts the
 * figure after the verb, "keeps 90%" before the noun. Splitting it into fragments to translate
 * would be the mistake this file has already made twice. */
function rebirthKeepsText() {
  const keptPct = Math.round(REBIRTH_KEEP * 100);
  const levels = SKILLS.map((sk) =>
    `${sk.icon} ${escapeHtml(sk.name)} ${levelFromXp(P.xp[sk.id] || 0)}`).join(" · ");
  if (currentLang() === "en") {
    return `
      <b>Kept:</b> 🏆 every achievement and its bonus · 🎒 everything in your bag ·
      🏦 <b class="good">${T("เงินฝากในธนาคาร")}</b> · 🪴 garden plots · 🏪 anything bought from the shop ·
      📖 your record of the pet species you have met<br>
      <b class="good">Every profession level survives:</b> ${levels}
      — the mastery you built up stays. A new run does not climb it again; it only has to earn money again.<br>
      <b>Reduced:</b> all three hunting stats keep ${keptPct}% · children and the pets that follow you keep the same ·
      the remainder of a level is banked as leftover XP rather than thrown away<br>
      <b class="bad">Lost entirely:</b> 🐾 every pet is released back to the wild ·
      💰 <b class="bad">${T("ทองในมือ")}</b> · 📈 <b class="bad">${T("หุ้นทุกตัว")}</b>
      — only money in the bank comes with you, so <b>${T("ต้องขายแล้วเอาไปฝากก่อน")}</b> before you rebirth<br>
      <span class="rb-warn">Note: bank interest is earned on years the account is left alone, and a rebirth
      resets that clock — the principal is untouched but the rate starts over · unpaid tax is not cleared by a rebirth</span>`;
  }
  return `
      <b>สิ่งที่ไม่หาย:</b> 🏆 ความสำเร็จทั้งหมดและโบนัสของมัน · 🎒 ของในกระเป๋าทุกชิ้น ·
      🏦 <b class="good">${T("เงินฝากในธนาคาร")}</b> · 🪴 แปลงปลูก · 🏪 ของที่ซื้อจากร้าน ·
      📖 บันทึกสายพันธุ์สัตว์เลี้ยงที่เคยเจอ<br>
      <b class="good">เลเวลอาชีพทุกสายอยู่ครบ:</b> ${levels}
      — ความชำนาญที่สะสมไว้ไม่หายไปไหน รอบใหม่ไม่ต้องไต่ใหม่ทั้งหมด แค่ต้องหาเงินใหม่<br>
      <b>สิ่งที่ลดลง:</b> ค่าสเตตัสการล่าทั้งสามช่อง เหลือ ${keptPct}% · ลูกและสัตว์เลี้ยงที่ตามไปด้วยก็เหลือเท่ากัน · เศษของเลเวลเก็บไว้เป็น XP ค้าง ไม่ทิ้ง<br>
      <b class="bad">สิ่งที่หายไปทั้งหมด:</b> 🐾 สัตว์เลี้ยงทุกตัวถูกปล่อยคืนธรรมชาติ ·
      💰 <b class="bad">${T("ทองในมือ")}</b> · 📈 <b class="bad">${T("หุ้นทุกตัว")}</b>
      — เงินติดตัวได้เฉพาะที่อยู่ในธนาคาร ถ้าจะจุติ <b>${T("ต้องขายแล้วเอาไปฝากก่อน")}</b><br>
      <span class="rb-warn">หมายเหตุ: ดอกเบี้ยเงินฝากคิดจากจำนวนปีที่ไม่แตะบัญชี และการจุติจะรีเซ็ตนาฬิกานั้น
      — เงินต้นอยู่ครบ แต่เรทกลับไปเริ่มใหม่ · หนี้ภาษีที่ค้างอยู่ไม่หายไปด้วยการจุติ</span>`;
}

/* One row of the karma ladder. Its own function because the sentence puts the multiplier in a
 * different place in each language — Thai trails it after the noun, English leads with it. */
function karmaRowNote(lv, now) {
  const gold = T("ทอง");
  if (lv === now) return `${gold} · ${T("จุติได้เลย")}`;
  const mult = (karmaGainFor(lv, P.rebirths || 0).xp
              / Math.max(1e-9, karmaGainFor(now, P.rebirths || 0).xp)).toFixed(1);
  return currentLang() === "en"
    ? `${gold} · ${lv - now} more levels → ${mult}× the karma you would get now`
    : `${gold} · ไต่อีก ${lv - now} เลเวล ได้บุญ ${mult} เท่าของตอนนี้`;
}

function renderRebirth() {
  $("#skill-title").textContent = `🌀 ${T("การจุติ")}`;
  $("#skill-flavor").textContent = T("เริ่มรอบใหม่โดยไม่ทิ้งสิ่งที่สะสมมา — ความสำเร็จอยู่ครบ ของในกระเป๋าอยู่ครบ");
  const pv = rebirthPreview();
  const extra = $("#view-extra");
  extra.innerHTML = "";

  const keep = document.createElement("div");
  keep.className = "money-summary";
  keep.innerHTML = `
    <div class="money-stat"><span>${T("จุติมาแล้ว")}</span><b>${P.rebirths || 0}</b></div>
    <div class="money-stat"><span>${T("บุญเก่า — XP ทุกสาย")}</span><b class="good">+${(karmaXp() * 100).toFixed(1)}%</b></div>
    <div class="money-stat"><span>${T("บุญเก่า — ทองที่หาได้")}</span><b class="good">+${(karmaGold() * 100).toFixed(1)}%</b></div>
    <div class="money-stat"><span>${T("จุติตอนนี้จะได้บุญ")}</span>
      <b class="${canRebirth() ? "good" : "bad"}">+${(karmaGainFor(combatLevel(), P.rebirths || 0).xp * 100).toFixed(1)}% XP</b></div>
    <div class="money-stat"><span>${T("เลเวลรวมตอนนี้")}</span><b>${combatLevel()}</b></div>
    ${(() => {
      /* Say what happens to the companion BEFORE the button is pressed. The bars are invisible
       * otherwise — a level and a grade you would have to go and check — and finding out that the
       * pet you had raised did not qualify is the kind of thing you find out too late. */
      const k = petRebirthKeeper();
      const kept = k ? petStats(k) : null;
      const lost = P.pets.length - (k ? 1 : 0);
      return `<div class="money-stat"><span>${T("สัตว์เลี้ยงที่จะไปด้วย")}</span>
        <b class="${kept ? "good" : "bad"}">${kept
          ? `${kept.icon} ${escapeHtml(kept.name)} ${T("ขั้น")} ${kept.lv} → ${Math.max(1, Math.floor(petLevelExact(k) / 2))}`
          : (currentLang() === "en" ? `None — take one hunting, and it must be grade ${PET_GRADES.find((g) => g.cls === PET_REBIRTH_MIN_GRADE).name} or better` : `ไม่มี — ต้องพาออกล่า และเกรด ${PET_GRADES.find((g) => g.cls === PET_REBIRTH_MIN_GRADE).name}ขึ้นไป`)}</b></div>
      <div class="money-stat"><span>${T("สัตว์เลี้ยงที่จะเสียไป")}</span>
        <b class="${lost ? "bad" : ""}">${lost}</b></div>`;
    })()}
    <div class="money-stat"><span>${T("สายพันธุ์ที่เคยเจอ (เก็บไว้)")}</span>
      <b class="good">${Object.keys(P.seenPets || {}).length}/${PET_SPECIES.length}</b></div>
    <div class="money-stat"><span>🏦 ${T("เงินฝาก (รอด)")}</span>
      <b class="good">${fmtNum(Math.floor(bankBalance()))}</b></div>
    <div class="money-stat"><span>💰 ${T("ทองในมือ (จะหาย)")}</span>
      <b class="${P.gold > 0 ? "bad" : ""}">${fmtNum(Math.floor(P.gold || 0))}</b></div>
    <div class="money-stat"><span>📈 ${T("หุ้นที่ถือ (รอด)")}</span>
      <b class="good">${fmtNum(Math.round(portfolioValue()))}</b></div>`;
  extra.appendChild(keep);

  const grid = $("#action-grid");
  grid.innerHTML = "";
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = T("ค่าที่จะเปลี่ยนเมื่อจุติ");
  grid.appendChild(head);

  const card = document.createElement("div");
  card.className = "action-card full-card";
  const rows = COMBAT_STATS.map((st) => {
    const r = pv[st.id];
    return `<div class="reborn-row">
      <span class="rb-name">${st.icon} ${st.name}</span>
      <span class="rb-num">${r.cur}</span>
      <span class="rb-arrow">→</span>
      <!-- 🎯 [owner 2026-08-23] "ค่าที่แสดงมากกว่าจุติเดิม มันควรเป็นสีเขียวไม่ใช่สีแดง · ค่าที่จุติ
           แล้วค่าต่ำ ได้ค่าจุติเดิม ควรเป็นสีแดง · สีมันสลับกัน" — and they were, exactly.

           floored means the reduction landed BELOW the floor the last rebirth left, so this run
           hands back the old number: no progress, red. Not floored means the kept level clears that
           floor and becomes a new, higher one: green. The colours had been written the other way
           round, reading "the floor caught you" as the good outcome. -->
      <span class="rb-num ${r.floored ? "bad" : "good"}">${r.after}</span>
      <span class="rb-note">${r.floored
        ? (currentLang() === "en" ? `${r.kept} would be below your old floor, so it stays at ${r.floor}` : `เหลือ ${r.kept} ซึ่งต่ำกว่าพื้นเดิม จึงคงไว้ที่ ${r.floor}`)
        : (currentLang() === "en" ? `Keeps ${Math.round(REBIRTH_KEEP * 100)}% of ${r.cur} · new floor becomes ${r.after}` : `เก็บ ${Math.round(REBIRTH_KEEP * 100)}% จาก ${r.cur} · พื้นใหม่จะเป็น ${r.after}`)}</span>
    </div>`;
  }).join("");
  card.innerHTML = `
    <div class="detail keeps">${rebirthKeepsText()}</div>
    ${rows}
    <div class="detail">
      ${T("พื้นการจุติจะไม่มีวันต่ำลง — จุติเร็วเกินไปจนได้น้อยกว่าครั้งก่อน ระบบจะคงค่าเดิมไว้ให้")}${canRebirth() ? "" : `<br><b>${currentLang() === "en"
        ? `Combat level ${rebirthGate()} required (currently ${combatLevel()})`
        : `ต้องถึงเลเวลรวม ${rebirthGate()} ก่อน (ตอนนี้ ${combatLevel()})`}</b>`}
    </div>
    <div class="cd-actions">
      <button class="farm-btn harvest" data-rebirth${canRebirth() ? "" : " disabled"}>🌀 ${T("จุติเลย")}</button>
    </div>`;
  grid.appendChild(card);
  /* 🎯 The point of scaling karma by level is that WAITING becomes a decision, and a decision the
   * player cannot make without seeing the numbers. This table is the whole feature's interface. */
  const kh = document.createElement("div");
  kh.className = "area-head";
  kh.textContent = T("จุติตอนนี้ หรือไต่ต่อ — บุญที่จะได้");
  grid.appendChild(kh);
  const ktab = document.createElement("div");
  ktab.className = "action-card full-card";
  const now = combatLevel(), gate = rebirthGate();
  const marks = [...new Set([gate, now, 30, 40, 50, 60, 75, 90, 99].filter((l) => l >= gate && l >= now))]
    .sort((a, b) => a - b).slice(0, 7);
  ktab.innerHTML = marks.map((lv) => {
    const g = karmaGainFor(lv, P.rebirths || 0);
    const isNow = lv === now;
    return `<div class="reborn-row${isNow ? " karma-now" : ""}">
      <span class="rb-name">${isNow ? "▶ " : ""}${T("เลเวลรวม")} ${lv}${isNow ? ` (${T("ตอนนี้")})` : ""}</span>
      <span class="rb-num good">+${(g.xp * 100).toFixed(1)}%</span>
      <span class="rb-arrow">XP</span>
      <span class="rb-num good">+${(g.gold * 100).toFixed(1)}%</span>
      <span class="rb-note">${karmaRowNote(lv, now)}</span>
    </div>`;
  }).join("") + `<div class="detail">${currentLang() === "en" ? `
    Karma is measured from your <b>${T("เลเวลรวมตอนที่จุติ")}</b> against the gate (currently ${gate})
    — the further you climb before rebirthing, the more you get, and it compounds.
    It is no longer the same amount every time.<br>
    The gate rises ${REBIRTH_GATE_STEP} levels with each rebirth (up to ${REBIRTH_GATE_MAX})
    — so rapid low-level rebirths are not a shortcut any more · total karma caps at +${Math.round(KARMA_CAP * 100)}%
  ` : `
    บุญคิดจาก <b>${T("เลเวลรวมตอนที่จุติ")}</b> เทียบกับประตู (ตอนนี้ ${gate}) — ยิ่งไต่ไกลก่อนจุติ ยิ่งได้เยอะแบบทวีคูณ
    ไม่ใช่ได้เท่ากันทุกครั้งเหมือนเมื่อก่อน<br>
    ประตูจะขยับขึ้น ${REBIRTH_GATE_STEP} เลเวลทุกครั้งที่จุติ (สูงสุด ${REBIRTH_GATE_MAX})
    — จุติรัว ๆ ที่เลเวลต่ำจึงไม่ใช่ทางลัดอีกต่อไป · เพดานบุญรวม +${Math.round(KARMA_CAP * 100)}%
  `}</div>`;
  grid.appendChild(ktab);

  card.querySelector("[data-rebirth]").onclick = () => {
    if (!canRebirth()) return;
    if (confirm(rebirthConfirmMessage(pv))) doRebirth();
  };

  if ((P.rebirthLog || []).length) {
    const h2 = document.createElement("div");
    h2.className = "area-head";
    h2.textContent = T("ประวัติการจุติ");
    grid.appendChild(h2);
    const hist = document.createElement("div");
    hist.className = "action-card ledger-card full-card";
    hist.innerHTML = `<div class="ledger-list">${P.rebirthLog.map((r, i) => `<div class="ledger-row">
      <span class="lr-date">${T("ปี")} ${r.y ?? r.year}/${r.month}/${r.day}</span>
      <span class="lr-text">ครั้งที่ ${P.rebirthLog.length - i} · ${COMBAT_STATS.map((st) =>
        `${st.name} ${r.before[st.id]}→${r.after[st.id]}`).join(" · ")}</span>
      <span class="lr-amt"></span></div>`).join("")}</div>`;
    grid.appendChild(hist);
  }
}

/* --- The run has ended: shown instead of everything else -------------------------- */

function renderDead() {
  $("#skill-title").textContent = "💀 จบเกม";
  $("#skill-flavor").textContent = "บริหารเงินไม่ทัน — รอบนี้จบลงโดยไม่มีอะไรเหลือ";
  $("#view-extra").innerHTML = "";
  const grid = $("#action-grid");
  grid.innerHTML = "";
  const card = document.createElement("div");
  card.className = "action-card dead-card full-card";
  card.innerHTML = `
    <div class="head"><div class="name">💀 ${escapeHtml(P.dead.reason)}</div>
      <div class="req">${escapeHtml(P.dead.date || "")}</div></div>
    <div class="detail">
      หนี้ภาษีค้างเกิน 3 เดือนในเกม รอบนี้จึงจบลง —
      <b>${T("ไม่เหมือนการจุติ ตรงที่ไม่มีอะไรถูกเก็บไว้เลย")}</b><br><br>
      เซฟยังอยู่บนเครื่องและไม่ถูกลบ ถ้าอยากเริ่มใหม่ ให้กลับไปหน้าโปรไฟล์แล้วลบช่องนี้เอง
    </div>`;
  grid.appendChild(card);
}

/* --- Combat view: paper-doll equipment + location/stage browser + fight scene --- */

function renderCombat() {
  $("#skill-title").textContent = "⚔️ ล่ามอนสเตอร์";
  $("#skill-flavor").textContent = "เลือกสถานที่ → ไล่ด่าน → โค่นบอส · อาหารจากครัวคือยาเลือดของคุณ";
  const grid = $("#action-grid");
  grid.innerHTML = "";
  const extra = $("#view-extra");
  extra.innerHTML = "";

  renderEquipPanel(extra);
  renderPetPanel(extra);
  renderFoodPanel(extra);
  renderElitePicker(extra);
  if (fightState()) { renderFight(extra); return; }

  const cbLvl = combatLevel();
  if (!combatLoc) {
    for (const loc of LOCATIONS) {
      const open = cbLvl >= loc.levelReq;
      const normals = loc.stages.filter((s) => !s.boss).length;
      const cleared = loc.stages.filter((s, i) => !s.boss && stageKills(loc.id, i) >= KILLS_TO_UNLOCK_NEXT_STAGE).length;
      const bossDown = loc.stages.some((s, i) => s.boss && stageKills(loc.id, i) > 0);
      const card = document.createElement("div");
      card.className = "loc-card" + (open ? "" : " locked");
      card.innerHTML = `
        <div class="loc-icon">${loc.icon}</div>
        <div class="loc-body">
          <div class="head"><div class="name">${loc.name}</div>
            <div class="req">${open ? `${cleared}/${normals} ${T("ด่าน")}${bossDown ? " · 🏆" : ""}` : `🔒 ${T("เลเวลล่า")} ${loc.levelReq}`}</div></div>
          <div class="detail">${loc.flavor}</div>
          <div class="loc-mobs">${loc.stages.map((s) => `<span class="${stageKills(loc.id, loc.stages.indexOf(s)) > 0 || !s.boss ? "" : "dim"}">${s.icon}</span>`).join(" ")}</div>
        </div>`;
      if (open) card.onclick = () => { combatLoc = loc.id; renderView(); };
      grid.appendChild(card);
    }
    return;
  }

  const loc = findLocation(combatLoc);
  const back = document.createElement("button");
  back.className = "btn ghost small";
  back.textContent = "← กลับไปเลือกสถานที่";
  back.style.marginBottom = "12px";
  back.onclick = () => { combatLoc = null; renderView(); };
  extra.appendChild(back);

  const mode = eliteMode();
  for (let i = 0; i < loc.stages.length; i++) {
    const raw = loc.stages[i];
    const stage = scaledStage(raw);
    const tierOk = eliteUnlocked(mode, loc, i);
    const open = stageUnlocked(loc, i) && tierOk;
    const kills = stageKills(loc.id, i);
    const tierKills = P.kills[`${loc.id}:${i}:${mode.id}`] || 0;
    const shown = mode.id === "normal" ? kills : tierKills;
    const prog = stage.boss
      ? (shown > 0 ? "🏆 พิชิตแล้ว" : "รอผู้ท้าชิง")
      : `ปราบแล้ว ${shown}${shown < KILLS_TO_UNLOCK_NEXT_STAGE ? `/${KILLS_TO_UNLOCK_NEXT_STAGE}` : ""}`;
    const card = document.createElement("div");
    card.className = "stage-card" + (open ? "" : " locked") + (stage.boss ? " boss" : "");
    card.innerHTML = `
      <div class="stage-icon">${iconArt("mon", `${loc.id}_${raw.id}`, stage.icon, stage.name)}</div>
      <div class="stage-body">
        <div class="head"><div class="name">${stage.boss ? "👑 " : ""}${stage.name}
          ${mode.id === "normal" ? "" : `<span class="elite-tag">${mode.icon} ${mode.name}</span>`}</div>
          <div class="req">${open ? prog
            : !tierOk ? `🔒 ต้องปราบระดับก่อนหน้าครบ ${KILLS_TO_UNLOCK_NEXT_STAGE} ตัว`
            : "🔒 เคลียร์ด่านก่อนหน้า"}</div></div>
        ${raw.traits ? `<div class="detail boss-traits">${Object.entries(raw.traits)
          .map(([k, t]) => `<span class="trait-chip">${BOSS_TRAITS[k].icon} ${BOSS_TRAITS[k].name} — ${BOSS_TRAITS[k].desc(t)}</span>`)
          .join("")}</div>` : ""}
        <div class="detail">❤️ ${stage.hp} · 🗡️ ${stage.dmg} · +${stage.xp} XP
          · ดรอป ${stage.loot.map((d) => ITEMS[d.item].icon).join(" ")}</div>
        ${(() => {
          /* All four difficulties at once, on the monster itself. The reward is per MONSTER, so
           * this is the only place it can be read without keeping a tally in your head — and the
           * three locked rows are the answer to "why would I ever fight the harder version". */
          const rk = slayerRewardKey(loc.id, raw.id);
          const r = SLAYER_REWARDS[rk];
          const rows = SLAYER_TIERS.map((t, ti) => {
            const m = ELITE_MODES[ti];
            const n = P.slayerKills?.[`${loc.id}:${i}:${t.tier}`] || 0;
            const done = !!P.slayer?.[`${loc.id}:${i}:${t.tier}`];
            return `<span class="slay-chip${done ? " on" : ""}">${m.icon} ${n >= t.kills ? t.kills : n}/${t.kills}
              ${done ? `<b>+${r.per[ti]}</b>` : ""}</span>`;
          }).join("");
          return `<div class="detail slay-row">${r.icon} รอยสังหาร — ${escapeHtml(r.name)}ถาวร ${rows}</div>`;
        })()}
        ${!stage.boss && kills < KILLS_TO_UNLOCK_NEXT_STAGE
          ? `<div class="stage-track"><div style="width:${kills / KILLS_TO_UNLOCK_NEXT_STAGE * 100}%"></div></div>` : ""}
      </div>
      ${open ? '<div class="stage-go">ล่า ▶</div>' : ""}`;
    if (open) card.onclick = () => startCombat(loc.id, i);
    if (highlightAction === `combat:${loc.id}:${i}`) {
      card.classList.add("jumped");
      setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
    }
    grid.appendChild(card);
  }
  highlightAction = null;
}

/* Difficulty selector: one row of tiers, each showing what it multiplies. Locked tiers say
 * what to clear first, so the ladder is legible without a wiki. */
/* 🎯 [added 2026-08-15, owner's ask] Provisions get their own collapsible bullet, separate from
 * gear: three slots eaten in order, and a player-chosen auto-eat threshold. Closed it is one line
 * showing what is packed and when it will be used; open it is three pickers and the threshold. */
let foodOpen = false;

/* Companions get the same collapsible treatment as gear and provisions. */
let petOpen = false;
let petFuseMode = false;   // true while picking a pair to fuse
let petFusePick = [];      // up to two pet indices, in pick order

/* 🎯 [owner 2026-08-22] "ยังต้องสะสมมอนที่เจอ ค่อยๆ ผสมไปเรื่อยๆ เพื่อหาตัวดีสุด"
 *
 * That design asks the player to keep a lot of companions, and fusion needs two of the SAME grade —
 * so the one thing the list has to do is put same-grade pets next to each other. Unsorted, finding
 * a partner in a collection of two hundred is the part of the feature people would give up on.
 *
 * Grade first, then level, then IV: the pair you are looking for ends up adjacent, and the best of
 * each grade sits at the top of its own run. Returns the original index alongside, because every
 * action on this screen — field, fuse, release — addresses a pet by its position in P.pets. */
function petListOrder() {
  return P.pets
    .map((pet, i) => ({ pet, i, st: petStats(pet) }))
    .sort((a, b) => {
      const ga = PET_GRADE_RANK.indexOf(a.st.grade.cls);
      const gb = PET_GRADE_RANK.indexOf(b.st.grade.cls);
      if (ga !== gb) return gb - ga;
      if (a.st.lv !== b.st.lv) return b.st.lv - a.st.lv;
      return (b.st.grade.pct || 0) - (a.st.grade.pct || 0);
    });
}

function renderPetPanel(extra) {
  const panel = document.createElement("div");
  panel.className = "equip-panel" + (petOpen ? " open" : "");
  const cur = activePet();
  const cs = cur ? petStats(cur) : null;
  const fainted = cur && cur.hp <= 0;

  const summary = `
    <button class="equip-summary" id="pet-toggle">
      <span class="caret">${petOpen ? "▾" : "▸"}</span>
      <span class="worn-row"><span class="worn${cur ? " on" : ""}">${cs ? cs.icon : "🐾"}</span></span>
      <span class="sum-stats">
        ${cur ? `<span class="stat-chip${fainted ? " missing" : ""}">${cs.icon} ${cs.name} ขั้น ${cs.lv}</span>
                 <span class="stat-chip grade-${cs.grade.cls}">${cs.grade.name} ${cs.grade.pct}%</span>
                 <span class="stat-chip">❤️ ${Math.max(0, cur.hp)}/${cs.maxHp}</span>
                 <span class="stat-chip">🗡️ ${cs.atk}</span>
                 <span class="stat-chip">🛡️ ${cs.def}</span>
                 ${fainted ? `<span class="stat-chip missing">หมดแรง — ให้กินอาหารก่อน</span>` : ""}`
             : P.pets.length
               ? `<span class="stat-chip">😴 ไม่ได้พาตัวไหนลงสนาม — ไม่เสีย XP</span>`
               : `<span class="stat-chip missing">${T("ยังไม่มีสัตว์เลี้ยง — ล่ามอนสเตอร์เพื่อลุ้นจับ")}</span>`}
        <span class="stat-chip">🐾 ${currentLang() === "en" ? `${P.pets.length} caught` : `เก็บได้ ${P.pets.length} ตัว`}</span>
        ${cur ? `<span class="stat-chip${(P.petXpShare ?? PET_XP_DEFAULT) ? " missing" : ""}">📚 กิน XP ${Math.round((P.petXpShare ?? PET_XP_DEFAULT) * 100)}%</span>` : ""}
      </span>
      <span class="expand-hint">${petOpen ? T("ย่อ") : T("กดเพื่อจัดการสัตว์เลี้ยง")}</span>
    </button>`;

  if (!petOpen) {
    panel.innerHTML = summary;
    extra.appendChild(panel);
    panel.querySelector("#pet-toggle").onclick = () => { petOpen = true; renderView(); };
    return;
  }

  /* 🎯 [owner 2026-08-18] "เพิ่มระบบผสมพันธุ์ รวมร่าง" — a mode, not a page: picking a pair replaces
   * the usual per-pet buttons with one selection toggle, so nothing else can be clicked by accident
   * mid-pick. Model: idle-fantacia/pet_fusion_sim.mjs. */
  const pickedGrade = petFusePick.length ? petStats(P.pets[petFusePick[0]]).grade.cls : null;
  panel.innerHTML = summary + (P.pets.length ? `
    ${P.pets.length >= 2 ? `
    <div class="train-row">
      <button class="btn ${petFuseMode ? "" : "ghost"} small" id="fuse-toggle">🧬 ${T("ผสมพันธุ์")}</button>
      ${(() => {
        const plan = autoFusePlan();
        return `<button class="btn ghost small" id="fuse-auto"${plan.pairs ? "" : " disabled"} title="${T("จับคู่ผสมให้อัตโนมัติ — ไม่แตะตัวที่พาลงสนาม และไม่ผสมขั้นสูงสุด")}">⚡ ${T("ผสมอัตโนมัติ")}${plan.pairs ? ` (${plan.pairs})` : ""}</button>`;
      })()}
      ${petFuseMode ? `<span class="train-sub">เลือกสัตว์เลี้ยงคุณภาพเดียวกัน 2 ตัว มารวมร่างเป็น 1 ตัว — ทั้งสองตัวหายไป</span>` : ""}
    </div>` : ""}
    <div class="equip-slots">
      ${petListOrder().map(({ pet, i }) => {
        const st = petStats(pet);
        const base = petXpToReach(st.lv), next = petXpToReach(st.lv + 1);
        const frac = st.lv >= PET_MAX_LEVEL ? 1 : (pet.xp - base) / (next - base);
        const iv = pet.iv || { hp: 1, atk: 1, def: 1 };
        const q = (v) => `<span class="iv iv-${v >= 1.15 ? "hi" : v >= 1 ? "mid" : "lo"}">${Math.round(v * 100)}%</span>`;
        const picked = petFusePick.includes(i);
        const pickable = !petFuseMode || picked || petFusePick.length >= 2
          ? picked : (pickedGrade == null || st.grade.cls === pickedGrade);
        return `<div class="equip-slot-box pet-box ${i === P.activePet ? "filled" : ""}${pet.hp <= 0 ? " fainted" : ""}${picked ? " fuse-pick" : ""}">
          <div class="slot-face">${iconArt("pet", pet.species, st.icon, st.name)}</div>
          <div class="slot-name">${st.name} · ขั้น ${st.lv}</div>
          <div class="pet-grade grade-${st.grade.cls}">${st.grade.name} ${st.grade.pct}%</div>
          <div class="pet-stats">🗡️${st.atk} ${q(iv.atk)} · 🛡️${st.def} ${q(iv.def)}</div>
          <div class="pet-stats">❤️ ${Math.max(0, pet.hp)}/${st.maxHp} ${q(iv.hp)}</div>
          <div class="m-bar"><div style="width:${Math.round(frac * 100)}%; background:var(--gold)"></div></div>
          ${(() => {
            /* Ninety-nine ranks are only worth climbing if the climb is visible. The card shows what
             * this companion has learned and what the next rank brings, so the bar above has a
             * destination rather than only a percentage. */
            const sk = st.skills;
            const nx = petNextSkill(st.lv);
            const has = [sk.heavy, sk.combo, sk.heal].filter(Boolean)
              .map((s) => `<span class="pet-skill" title="${escapeHtml(s.name)}">${s.icon}</span>`).join("");
            const passive = (sk.atk || sk.def)
              ? `<span class="pet-skill-num">${sk.atk ? `🗡️+${Math.round(sk.atk * 100)}%` : ""}${
                   sk.atk && sk.def ? " " : ""}${sk.def ? `🛡️+${Math.round(sk.def * 100)}%` : ""}</span>`
              : "";
            if (!has && !passive && !nx) return "";
            return `<div class="pet-skills">${has}${passive}${
              nx ? `<span class="pet-next">${T("ขั้น")} ${nx.lv}: ${nx.icon} ${escapeHtml(nx.name)}</span>` : ""}</div>`;
          })()}
          ${petFuseMode
            ? `<button class="btn ${picked ? "" : "ghost"} small" data-fusepick="${i}" ${pickable ? "" : "disabled"}>
                 ${picked ? "✓ เลือกแล้ว" : "เลือกผสม"}</button>`
            : `<button class="btn small" data-pet="${i}">${i === P.activePet ? "กำลังพาไป" : "พาตัวนี้ไป"}</button>
               ${i === P.activePet ? `<button class="btn ghost small" data-rest="${i}">😴 ให้พัก</button>` : ""}
               ${pet.hp <= 0
                 ? `<button class="btn small revive" data-feed="${i}">🍖 ${T("ปลุกให้ฟื้น")}</button>`
                 : pet.hp < st.maxHp ? `<button class="btn ghost small" data-feed="${i}">🍴 ให้อาหาร</button>` : ""}
               ${childPetHeir() ? `<button class="btn ghost small" data-givekid="${i}">🎁 ${T("ให้ลูก")}</button>` : ""}
               <button class="btn ghost small" data-release="${i}">🕊️ ปล่อย</button>`}
        </div>`;
      }).join("")}
    </div>
    ${petFuseMode && petFusePick.length === 2 ? (() => {
      const f = petFusionForecast(petFusePick[0], petFusePick[1]);
      if (!f) return "";
      return `<div class="detail fuse-forecast">
        🧬 ${f.grade.name} + ${f.grade.name} → ${f.upName ? `<b>${Math.round(f.chance * 100)}% ได้ ${f.upName}</b> · พลาดแล้วยังได้ ${f.grade.name} เหมือนเดิม (สุ่ม % ใหม่)`
          : `ถึงขั้นสูงสุดแล้ว — สุ่ม % ใหม่ในขั้นเดิม`}<br>
        สายพันธุ์: ${f.sameSpecies ? "สายพันธุ์เดิมแน่นอน" : "ต่างสายพันธุ์ — แตกแขนงสุ่ม 50/50 ระหว่างสองตัวนี้"}
        · ระดับที่ได้ราว ${Math.max(1, Math.floor(f.levelAvg * PET_FUSION_LEVEL_LO))}–${Math.min(PET_MAX_LEVEL, Math.ceil(f.levelAvg * PET_FUSION_LEVEL_HI))}
        <br><b class="rb-warn">ทั้งสองตัวจะหายไป เหลือแค่ตัวใหม่ที่ได้ — ย้อนกลับไม่ได้</b>
      </div>
      <div class="train-row">
        <button class="btn small" id="fuse-confirm">🧬 ยืนยันผสมพันธุ์</button>
        <button class="btn ghost small" id="fuse-clear">ยกเลิกที่เลือก</button>
      </div>`;
    })() : ""}
    <div class="train-row">
      <span class="train-label">📚 แบ่ง XP จากการล่าให้สัตว์เลี้ยง:</span>
      ${PET_XP_OPTIONS.map((o) =>
        `<button class="train-chip${Math.abs(o - (P.petXpShare ?? PET_XP_DEFAULT)) < 0.001 ? " active" : ""}" data-xpshare="${o}">
          <b>${o ? Math.round(o * 100) + "%" : "ไม่แบ่ง"}</b>
          <span class="train-sub">${o ? "มันโตขึ้น เราโตช้าลง" : "มันสู้ด้วยแต่ไม่โต"}</span>
        </button>`).join("")}
    </div>
    <div class="detail">สัตว์เลี้ยงตีเสริมทุก 3 วินาที รับดาเมจแทนคุณ ${Math.round(PET_DAMAGE_SHARE * 100)}%
      และกินจากช่องเสบียงเดียวกับคุณเมื่อเลือดต่ำกว่า ${Math.round(PET_EAT_BELOW * 100)}%<br>
      XP ที่แบ่งให้มันถูก<b>${T("หักจากส่วนของคุณ")}</b> ไม่ใช่ของแถม — ไม่พาลงสนามก็ไม่เสีย XP เลย</div>`
    : `<div class="detail">ยังไม่มีสัตว์เลี้ยง — โอกาสจับได้จากการล่า ยิ่งด่านลึกยิ่งเจอสายพันธุ์ดี และบอสมีโอกาสสูงกว่ามาก</div>`);
  extra.appendChild(panel);

  panel.querySelector("#pet-toggle").onclick = () => { petOpen = false; renderView(); };
    const autoBtn = panel.querySelector("#fuse-auto");
    if (autoBtn) autoBtn.onclick = () => {
      const plan = autoFusePlan();
      if (!plan.pairs) { toast(T("ไม่มีคู่ที่ผสมได้"), "warn"); return; }
      /* Confirmed first: this consumes companions, and how many is not obvious from a button. */
      if (!confirm(`${T("จะผสมอัตโนมัติ")} ${plan.pairs} ${T("คู่")}\n\n`
        + `${T("ตัวที่พาลงสนามและขั้นสูงสุดจะไม่ถูกแตะ")}\n`
        + `${T("ผสมแล้วสัตว์เลี้ยงสองตัวจะกลายเป็นตัวเดียว")}`)) return;
      const r = autoFuseRun();
      if (!r.done) { toast(T("ไม่มีคู่ที่ผสมได้"), "warn"); return; }
      toast(`⚡ ${T("ผสมอัตโนมัติ")} ${r.done} ${T("คู่")} — ${T("เลื่อนขั้นสำเร็จ")} ${r.upgraded} ${T("ตัว")}`
        + ` · ${r.before} → ${r.after} ${T("ตัว")}`, r.upgraded ? "levelup" : "", "combat");
      save("ผสมอัตโนมัติ");
      renderView();
    };
  const ft = panel.querySelector("#fuse-toggle");
  if (ft) ft.onclick = () => { petFuseMode = !petFuseMode; petFusePick = []; renderView(); };
  panel.querySelectorAll("[data-fusepick]").forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.fusepick);
    if (petFusePick.includes(i)) petFusePick = petFusePick.filter((x) => x !== i);
    else if (petFusePick.length < 2) petFusePick = [...petFusePick, i];
    renderView();
  });
  const fc = panel.querySelector("#fuse-confirm");
  if (fc) fc.onclick = () => {
    if (petFuse(petFusePick[0], petFusePick[1])) { petFusePick = []; petFuseMode = false; save(); }
    renderView();
  };
  const fx = panel.querySelector("#fuse-clear");
  if (fx) fx.onclick = () => { petFusePick = []; renderView(); };
  panel.querySelectorAll("[data-pet]").forEach((b) => b.onclick = () => {
    P.activePet = Number(b.dataset.pet);
    toast(`${petStats(P.pets[P.activePet]).icon} พา ${petStats(P.pets[P.activePet]).name} ออกล่าด้วย`);
    renderView();
  });
  panel.querySelectorAll("[data-rest]").forEach((b) => b.onclick = () => {
    const st = petStats(P.pets[P.activePet]);
    P.activePet = null;                      // stays in the stable: no fighting, no XP taken
    toast(`😴 ${st.name} อยู่บ้านพัก — ไม่ลงสนามและไม่กิน XP ของคุณ`);
    renderView();
  });
  panel.querySelectorAll("[data-xpshare]").forEach((b) => b.onclick = () => {
    P.petXpShare = Number(b.dataset.xpshare);
    toast(P.petXpShare
      ? `📚 แบ่ง XP ให้สัตว์เลี้ยง ${Math.round(P.petXpShare * 100)}% (หักจากส่วนของคุณ)`
      : "📚 ไม่แบ่ง XP — สัตว์เลี้ยงสู้ด้วยแต่จะไม่โตขึ้น");
    renderView();
  });
  panel.querySelectorAll("[data-release]").forEach((b) => b.onclick = () => releasePet(Number(b.dataset.release)));
  /* 🎯 [owner 2026-08-23] "ให้เพิ่มเหนือเมนูปล่อย คือ ให้ลูก ระบบมันจะส่งไปให้ลูกที่โตเต็มวัยอัตโนมัติ" —
     confirmed like a release is, because it leaves your stable for good: a child's companion is not
     something you can take back, and the dialog says so rather than letting it be discovered. */
  panel.querySelectorAll("[data-givekid]").forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.givekid);
    const pet = P.pets[i];
    const heir = childPetHeir();
    if (!pet || !heir) return;
    const st = petStats(pet);
    if (!confirm(`ให้ ${st.name} (ขั้น ${st.lv} · คุณภาพ ${st.grade.name}) กับ ${heir.name}?\n\n`
        + `· ${heir.name} จะพามันออกล่าทุกวัน และมันจะขึ้นขั้นไปด้วย\n`
        + `· ออกจากคอกของคุณถาวร เอากลับมาไม่ได้\n`
        + `· จุติแล้วมันไม่หาย แต่จะเหลือ ${Math.round(REBIRTH_KEEP * 100)}% เหมือนลูก`)) return;
    givePetToChild(i);
    toast(`🎁 ${st.icon} ${st.name} ไปอยู่กับ ${heir.name} แล้ว — ออกล่าด้วยกันตั้งแต่พรุ่งนี้`, "levelup", "family");
    save("ให้สัตว์เลี้ยงกับลูก");
    renderView();
  });
  panel.querySelectorAll("[data-feed]").forEach((b) => b.onclick = () => {
    const keep = P.activePet;
    P.activePet = Number(b.dataset.feed);
    if (!petEat()) toast("ไม่มีอาหารในช่องเสบียง", "warn");
    P.activePet = keep;
    renderView();
  });
}

function renderFoodPanel(extra) {
  const panel = document.createElement("div");
  panel.className = "equip-panel" + (foodOpen ? " open" : "");
  const pct = P.autoEatPct ?? AUTO_EAT_DEFAULT;
  const nextIdx = nextFoodSlot();
  const packed = (P.food || []).filter((id) => id && (P.inv[id] || 0) > 0);
  const totalHeal = packed.reduce((t, id) => t + ITEMS[id].heal * P.inv[id], 0);

  const summary = `
    <button class="equip-summary" id="food-toggle">
      <span class="caret">${foodOpen ? "▾" : "▸"}</span>
      <span class="worn-row">${(P.food || []).map((id, i) => {
        const has = id && (P.inv[id] || 0) > 0;
        return `<span class="worn${has ? " on" : ""}${i === nextIdx ? " next" : ""}"
          title="ช่อง ${i + 1}${has ? `: ${ITEMS[id].name} ×${P.inv[id]}` : " (ว่าง)"}">${has ? ITEMS[id].icon : "🍽️"}</span>`;
      }).join("")}</span>
      ${/* 🎯 [owner 2026-08-22] "ช่องอาหาร ข้อมูลตอนนี้มันเยอะไป ให้ลดลง เหลือแต่ไอคอนอาหารสามช่อง
             แต่ถ้ากดแสดงการ์ด มันจะมีรายละเอียดครบเหมือนเดิม"
           Collapsed, the three icons already answer the only question this panel is asked in
           passing — is there food in it. The three chips restate what the icons show, in words,
           above every wounding skill's card list. Expanded, nothing is lost: they come back
           alongside the slot pickers that are the reason you opened it. */ ""}
      ${foodOpen ? `
      <span class="sum-stats">
        <span class="stat-chip">🍱 เสบียง ${packed.length}/${FOOD_SLOTS} ช่อง</span>
        <span class="stat-chip${packed.length ? "" : " missing"}">❤️ ฟื้นได้รวม ${totalHeal.toLocaleString()}</span>
        <span class="stat-chip">🤖 กินเองเมื่อเลือดต่ำกว่า ${Math.round(pct * 100)}%</span>
      </span>
      <span class="expand-hint">ย่อ</span>` : `
      <span class="stat-chip${packed.length ? "" : " missing"}">${packed.length}/${FOOD_SLOTS}</span>`}
    </button>`;

  if (!foodOpen) {
    panel.innerHTML = summary;
    extra.appendChild(panel);
    panel.querySelector("#food-toggle").onclick = () => { foodOpen = true; renderView(); };
    return;
  }

  const foods = Object.keys(ITEMS).filter((id) => ITEMS[id].heal && (P.inv[id] || 0) > 0);
  panel.innerHTML = summary + `
    <div class="equip-slots">
      ${(P.food || []).map((cur, i) => {
        const has = cur && (P.inv[cur] || 0) > 0;
        return `<div class="equip-slot-box food ${has ? "filled" : ""}${i === nextIdx ? " next" : ""}">
          <div class="slot-face">${has ? ITEMS[cur].icon : "🍽️"}</div>
          <div class="slot-name">ช่อง ${i + 1}${i === nextIdx ? " (ใช้อยู่)" : ""}${has ? ` ×${P.inv[cur]}` : ""}</div>
          <select data-food="${i}">
            <option value="">— ว่าง —</option>
            ${foods.map((id) => `<option value="${id}" ${cur === id ? "selected" : ""}>
              ${ITEMS[id].icon} ${ITEMS[id].name} ❤️${ITEMS[id].heal} (มี ${P.inv[id]})</option>`).join("")}
          </select>
        </div>`;
      }).join("")}
    </div>
    <div class="train-row">
      <span class="train-label">🤖 กินอัตโนมัติเมื่อเลือดต่ำกว่า:</span>
      ${AUTO_EAT_OPTIONS.map((o) =>
        `<button class="train-chip${Math.abs(o - pct) < 0.001 ? " active" : ""}" data-eat="${o}">
          <b>${Math.round(o * 100)}%</b></button>`).join("")}
      <button class="btn small" id="btn-eat">🍴 กินเดี๋ยวนี้</button>
    </div>
    <div class="detail">กินจากช่อง 1 ก่อน หมดแล้วสลับไปช่อง 2 และ 3 ให้อัตโนมัติ</div>`;
  extra.appendChild(panel);

  panel.querySelector("#food-toggle").onclick = () => { foodOpen = false; renderView(); };
  panel.querySelectorAll("[data-food]").forEach((sel) => sel.onchange = (e) => {
    P.food[Number(e.target.dataset.food)] = e.target.value || null;
    renderView();
  });
  panel.querySelectorAll("[data-eat]").forEach((b) => b.onclick = () => {
    P.autoEatPct = Number(b.dataset.eat);
    toast(`🤖 ตั้งให้กินเองเมื่อเลือดต่ำกว่า ${Math.round(P.autoEatPct * 100)}%`);
    renderView();
  });
  panel.querySelector("#btn-eat").onclick = () => tryEat(false);
}

/* A mode is offered when at least one stage in view has earned it. Without this the picker
 * listed every tier as if it were selectable, and choosing one just produced locked stage cards
 * with no explanation of what to do about it. */
function eliteAvailable(mode) {
  if (mode.id === "normal") return true;
  const locs = combatLoc ? [findLocation(combatLoc)] : LOCATIONS;
  return locs.some((l) => l.stages.some((st, i) => eliteUnlocked(mode, l, i)));
}

/* 🎯 [rebuilt 2026-08-17, owner: "ทำเป็น bullet dropdown ไง มันซ่อนอันที่ไม่ใช้ได้"] Four
 * full-width cards spent a third of the hunt screen on a setting changed occasionally, and a
 * flat bullet strip still showed all four at once. Closed, this is one line naming the tier in
 * play; the rest only appear when the player goes looking for them. <details> so the open/close
 * needs no state of its own and keyboard/screen-reader behaviour comes for free. */
function renderElitePicker(extra) {
  const cur = eliteMode();
  const box = document.createElement("details");
  box.className = "elite-drop";
  const line = (m) => {
    const open = eliteAvailable(m);
    const detail = m.id === "normal" ? T("ค่าพื้นฐาน ไม่มีตัวคูณ")
      : (currentLang() === "en" ? `HP ×${m.hp} · DMG ×${m.dmg} · XP ×${m.xp} · Gold ×${m.gold} · Loot ×${m.loot}` : `เลือด ×${m.hp} · แรง ×${m.dmg} · XP ×${m.xp} · ทอง ×${m.gold} · ของดรอป ×${m.loot}`);
    return `<button class="elite-opt${m.id === P.eliteMode ? " active" : ""}${open ? "" : " shut"}"
        data-elite="${m.id}"${open ? "" : " disabled"}>
      <span class="eo-bullet">◆</span>
      <span class="eo-face">${open ? m.icon : "🔒"}</span>
      <span class="eo-body"><span class="eo-name">${T(m.name)}</span>
        <span class="eo-detail">${open ? detail
          : (currentLang() === "en" ? `Defeat ${KILLS_TO_UNLOCK_NEXT_STAGE} at the tier below first` : `ปราบด่านในระดับก่อนหน้าให้ครบ ${KILLS_TO_UNLOCK_NEXT_STAGE} ตัวก่อน`)}</span></span>
    </button>`;
  };
  box.innerHTML = `
    <summary class="elite-summary">
      <span class="train-label">🔥 ${T("ระดับความยาก")}</span>
      <span class="elite-current">◆ ${cur.icon} ${cur.name}</span>
      <span class="elite-mult">${cur.id === "normal" ? T("มาตรฐาน") : `×${cur.xp} XP · ×${cur.gold} 💰`}</span>
      <span class="elite-caret">▾</span>
    </summary>
    <div class="elite-list">${ELITE_MODES.map(line).join("")}</div>`;
  extra.appendChild(box);
  box.querySelectorAll("[data-elite]").forEach((b) => b.onclick = (e) => {
    e.preventDefault();
    const mode = ELITE_MODES.find((m) => m.id === b.dataset.elite);
    if (!eliteAvailable(mode)) return;
    box.open = false;
    if (mode.id === P.eliteMode) return;
    P.eliteMode = mode.id;
    toast(currentLang() === "en" ? `${mode.icon} Difficulty set to ${mode.name}` : `${mode.icon} เปลี่ยนระดับความยากเป็น ${mode.name}`);
    if (combatSlot() >= 0) { stopCombat(true); toast("หยุดล่าเพื่อเปลี่ยนระดับ — กดด่านใหม่ได้เลย"); }
    renderView();
  });
}

/* Collapsed by default (owner: "ย่อเป็น bullet... จะได้ประหยัดพื้นที่"). The closed state is a
 * single line that still answers "what am I wearing and how strong am I" — worn icons plus the
 * three combat totals — and only expands into the full paper-doll when the player intends to
 * change something. The choice is remembered for the session. */
let equipOpen = false;

function renderEquipPanel(extra) {
  const stats = gearStats();
  const sets = activeSets();
  const panel = document.createElement("div");
  panel.className = "equip-panel" + (equipOpen ? " open" : "");

  const wornIcons = EQUIP_SLOTS.map((sl) => {
    const it = equippedItem(sl.id);
    return `<span class="worn${it ? " on" : ""}" title="${sl.name}${it ? `: ${it.name}` : " (ว่าง)"}">${it ? it.icon : sl.icon}</span>`;
  }).join("");

  const summary = `
    <button class="equip-summary" id="equip-toggle">
      <span class="caret">${equipOpen ? "▾" : "▸"}</span>
      <span class="worn-row">${wornIcons}</span>
      <span class="sum-stats">
        <span class="stat-chip">🗡️ ${totalDmg()}</span>
        <span class="stat-chip">🛡️ ${totalDef()}</span>
        <span class="stat-chip">❤️ ${maxHp()}</span>
        <span class="stat-chip">⚔️ ${T("เลเวลล่า")} ${combatLevel()}</span>
        ${sets.length ? `<span class="stat-chip set-on">👕 ${sets.map((x) => x.name).join(", ")}</span>` : ""}
      </span>
      <span class="expand-hint">${equipOpen ? T("ย่อ") : T("กดเพื่อปรับอุปกรณ์")}</span>
    </button>`;

  if (!equipOpen) {
    panel.innerHTML = summary;
    extra.appendChild(panel);
    panel.querySelector("#equip-toggle").onclick = () => { equipOpen = true; renderView(); };
    return;
  }

  const slotsHtml = EQUIP_SLOTS.map((sl) => {
    const owned = Object.keys(ITEMS).filter((id) => ITEMS[id].slot === sl.id && (P.inv[id] || 0) > 0);
    const cur = equippedItem(sl.id);
    const options = [`<option value="">— ว่าง —</option>`,
      ...owned.map((id) => `<option value="${id}" ${P.equip[sl.id] === id ? "selected" : ""}>
        ${ITEMS[id].icon} ${ITEMS[id].name} ${statBadge(ITEMS[id])}</option>`)].join("");
    return `
      <div class="equip-slot-box ${cur ? "filled" : ""}">
        <div class="slot-face">${cur ? cur.icon : sl.icon}</div>
        <div class="slot-name">${sl.name}</div>
        <select data-slot="${sl.id}">${options}</select>
      </div>`;
  }).join("");

  panel.innerHTML = summary + `
    <div class="equip-slots">${slotsHtml}</div>
    <div class="set-row">${ARMOR_SETS.map((set) => {
      const on = sets.includes(set);
      const owned = set.pieces.filter((pc) => (P.inv[pc] || 0) > 0).length;
      const b = Object.entries(set.bonus).map(([k, v]) =>
        ({ def: `🛡️+${v}`, dmg: `🗡️+${v}`, hpBonus: `❤️+${v}` }[k])).join(" ");
      return `<span class="set-chip${on ? " on" : ""}" title="${set.pieces.map((pc) => ITEMS[pc].name).join(", ")}">
        ${set.name} ${on ? "✅" : `${owned}/3`} <b>${b}</b></span>`;
    }).join("")}</div>
    <div class="train-row">
      <span class="train-label">🎯 เป้าฝึก (XP จากการล่าเทเข้าช่องนี้):</span>
      ${COMBAT_STATS.map((st) => {
        const lvl = statLevel(st.id);
        const xp = P.cb[st.id] || 0;
        const base = xpToReach(lvl), next = xpToReach(lvl + 1);
        const frac = lvl >= MAX_LEVEL ? 1 : (xp - base) / (next - base);
        return `<button class="train-chip${P.trainFocus === st.id ? " active" : ""}" data-train="${st.id}">
          ${st.icon} ${st.name} <b>ขั้น ${lvl}</b>
          <span class="train-bar"><span style="width:${Math.round(frac * 100)}%"></span></span>
        </button>`;
      }).join("")}
    </div>`;
  extra.appendChild(panel);

  panel.querySelector("#equip-toggle").onclick = () => { equipOpen = false; renderView(); };
  panel.querySelectorAll("[data-train]").forEach((b) => {
    b.onclick = () => {
      P.trainFocus = b.dataset.train;
      const st = COMBAT_STATS.find((x) => x.id === P.trainFocus);
      toast(`🎯 เปลี่ยนเป้าฝึกเป็น ${st.icon} ${st.name} — XP จากการล่าจะเทเข้าช่องนี้`);
      renderView();
    };
  });
  panel.querySelectorAll("select[data-slot]").forEach((sel) => {
    sel.onchange = (e) => {
      const slotId = e.target.dataset.slot;
      P.equip[slotId] = e.target.value || null;
      P.hp = Math.min(P.hp, maxHp());   // an hpBonus piece coming off can lower the ceiling
      renderView();
    };
  });
}

function renderFight(extra) {
  const C = fightState();
  if (!C) return;
  const loc = findLocation(C.locId);
  const stage = C.stage;
  const fight = document.createElement("div");
  fight.className = "fight-scene" + (stage.boss ? " boss" : "");
  fight.innerHTML = `
    <div class="fight-bg">${loc.icon}</div>
    ${petReady() ? `<div class="fighter pet" id="f-pet">
      <div class="f-avatar">${iconArt("pet", petReady().species, petStats(petReady()).icon, petStats(petReady()).name, "big")}</div>
      <div class="f-name">${petStats(petReady()).name}</div>
      <div class="hp-bar"><div id="f-pethp" style="background:#8fd0e8"></div></div>
      <div class="f-sub" id="f-pethp-t"></div>
      <div class="atk-bar"><div id="f-petatk"></div></div>
    </div>` : ""}
    <div class="fighter" id="f-me">
      <div class="f-avatar">${iconArt("char", "hero", "🧙", "ตัวละคร", "big")}</div>
      <div class="f-name">${escapeHtml(P.name)}</div>
      <div class="hp-bar"><div id="f-php" style="background:#5fbf77"></div></div>
      <div class="f-sub" id="f-php-t"></div>
      <div class="atk-bar"><div id="f-patk"></div></div>
    </div>
    <div class="vs">${stage.boss ? "👑" : "⚔️"}</div>
    <div class="fighter" id="f-mon">
      <div class="f-avatar">${iconArt("mon", `${C.locId}_${loc.stages[C.stageIdx].id}`, stage.icon, stage.name, "big")}</div>
      <div class="f-name">${stage.boss ? "👑 " : ""}${stage.name}${monsterFearsUs(C.locId, C.stageIdx) ? ` <span class="fear-tag" title="ล่ามันครบ 1,000 ตัวแล้ว — มันตีเบาลง ${Math.round((1 - BANE_DAMAGE_MULT) * 100)}%">😱</span>` : ""}</div>
      <div class="hp-bar"><div id="f-mhp" style="background:#e86a6a"></div></div>
      <div class="f-sub" id="f-mhp-t"></div>
      <div class="atk-bar"><div id="f-matk"></div></div>
    </div>
    <button class="btn ghost small" id="btn-flee">🏃 ถอนตัว</button>`;
  extra.appendChild(fight);
  fight.querySelector("#btn-flee").onclick = () => { stopCombat(false); renderView(); updateBanner(); };
  updateCombatPanel();
}

function updateCombatPanel() {
  const C = fightState();
  if (!C) return;
  const loc = findLocation(C.locId);
  const stage = C.stage;
  const max = maxHp();
  const php = $("#f-php");
  if (!php) return;
  php.style.width = `${Math.max(0, Math.round(P.hp / max * 100))}%`;
  $("#f-php-t").textContent = `${Math.max(0, P.hp)} / ${max}`;
  const pet = petReady();
  const pbar = $("#f-pethp");
  if (pet && pbar) {
    const ps = petStats(pet);
    pbar.style.width = `${Math.max(0, Math.round(pet.hp / ps.maxHp * 100))}%`;
    $("#f-pethp-t").textContent = `${Math.max(0, pet.hp)} / ${ps.maxHp}`;
  }
  $("#f-mhp").style.width = `${Math.max(0, Math.round(C.monHp / stage.hp * 100))}%`;
  $("#f-mhp-t").textContent = `${Math.max(0, C.monHp)} / ${stage.hp}`;
  // Attack-timer bars fill toward the next hit — the "rhythm" of the fight.
  const now = performance.now();
  const pFrac = 1 - Math.max(0, C.pNext - now) / (PLAYER_ATTACK_INTERVAL * 1000);
  const mFrac = 1 - Math.max(0, C.mNext - now) / (stage.interval * 1000);
  $("#f-patk").style.width = `${Math.round(pFrac * 100)}%`;
  $("#f-matk").style.width = `${Math.round(mFrac * 100)}%`;
  const petBar = $("#f-petatk");
  if (pet && petBar) {
    petBar.style.width =
      `${Math.round((1 - Math.max(0, C.petNext - now) / petAttackInterval(petStats(pet).lv)) * 100)}%`;
  }
}

/* Floating damage number + hit flash on the struck fighter card. */
function hitFx(sel, dmg, cls) {
  const el = $(sel);
  if (!el) return;
  el.classList.remove("hit");
  void el.offsetWidth; // restart the flash animation
  el.classList.add("hit");
  const f = document.createElement("div");
  f.className = `dmg-float ${cls}`;
  f.textContent = `-${dmg}`;
  f.style.left = `${30 + Math.random() * 40}%`;
  el.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

/* 🎯 Every line here is composed per language rather than assembled from translated fragments.
 *
 * This one function is the single densest patch of Thai left in the game: the shop screen shows
 * ~50 items and each one calls it, so "เร็วขึ้น" appeared 29 times and "ต้องมี" 49 on one screen.
 * They are also exactly the fragments a dictionary must not hold — "ได้", "เพิ่ม", "ถาวร" are
 * common enough words that an entry for them would also rewrite any table field that happens to
 * equal one, and the two languages put the number on opposite sides of the noun anyway. */
/* Two one-line sentences that the shop repeats on nearly every card — "ยังขาดอีก" 50 times and
 * "ต้องมี ... ก่อน" 49. Kept as functions so there is one copy of each rather than one per call
 * site, and composed per language because the pieces are far too common to put in the dictionary. */
function shortBy(gold) {
  return currentLang() === "en"
    ? `${gold.toLocaleString()} 💰 short`
    : `ยังขาดอีก ${gold.toLocaleString()} 💰`;
}
function needFirst(name) {
  return currentLang() === "en" ? `Requires ${name} first` : `ต้องมี ${name} ก่อน`;
}

function shopEffectText(u) {
  const en = currentLang() === "en";
  const pct = (v) => Math.round(v * 100);
  if (u.kind === "tome") {
    const skill = findSkill(u.skill);
    return en ? `${skill.icon} ${skill.name}: +${pct(u.value)}% XP, permanently`
              : `${skill.icon} ${skill.name} ได้ XP เพิ่ม ${pct(u.value)}% ถาวร`;
  }
  if (u.kind === "multi") {
    const n = SHOP.filter((x) => x.kind === "multi").findIndex((x) => x.id === u.id) + 2;
    return en ? `Work on ${n} things at once (only one hunt at a time — you have one health bar)`
              : `ทำงานพร้อมกันได้ ${n} อย่าง (สู้ได้ทีละสนามเท่านั้น — เลือดมีชุดเดียว)`;
  }
  if (u.kind === "plot") {
    const n = SHOP.filter((x) => x.kind === "plot").findIndex((x) => x.id === u.id) + PLOTS_START + 1;
    return en ? `🌻 Opens garden plot ${n} — grow more at once (up to ${PLOTS_MAX} plots)`
              : `🌻 เปิดแปลงปลูกที่ ${n} — ปลูกพร้อมกันได้มากขึ้น (สูงสุด ${PLOTS_MAX} แปลง)`;
  }
  if (u.kind === "charm") {
    return (en
      ? { luck: `+${pct(u.value)}% chance of rare finds from every profession`,
          gold: `+${pct(u.value)}% gold from hunting and thieving`,
          def:  `+${u.value} defence, carried (no need to equip anything)`,
          hp:   `+${u.value} max HP, carried` }
      : { luck: `โอกาสของหายากจากทุกสายเพิ่ม ${pct(u.value)}%`,
          gold: `ทองจากการล่าและขโมยเพิ่ม ${pct(u.value)}%`,
          def:  `ป้องกันติดตัว +${u.value} (ไม่ต้องสวมของ)`,
          hp:   `HP สูงสุดติดตัว +${u.value}` })[u.effect];
  }
  const skill = findSkill(u.skill);
  return en ? `${skill.icon} ${skill.name}: ${pct(u.bonus)}% faster`
            : `${skill.icon} ${skill.name} เร็วขึ้น ${pct(u.bonus)}%`;
}

/* Compact number formatting — 240,000,000 reads badly next to a progress bar. */
/* Dividends can legitimately be a fraction of a gold now that companies pay daily, so a payout
 * display has to keep two decimals rather than round a real payment down to "0". */
function divRound(n) { return n >= 10 ? Math.round(n) : Math.round(n * 100) / 100; }

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toLocaleString();
}
function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return currentLang() === "en" ? `${m} min played` : `เล่นมา ${m} นาที`;
  const h = Math.floor(m / 60);
  return currentLang() === "en"
    ? (h < 24 ? `${h}h ${m % 60}m played` : `${Math.floor(h / 24)}d ${h % 24}h played`)
    : (h < 24 ? `เล่นมา ${h} ชม. ${m % 60} น.` : `เล่นมา ${Math.floor(h / 24)} วัน ${h % 24} ชม.`);
}

/* 🎯 [added 2026-08-15, owner's ask] Everything the game already counts, in one place — an idle
 * game lives on watching its own numbers grow, and until now none of them were visible. */
/* Unit words on the stats screen. They are appended to a number rather than being strings of
 * their own — "1,234" + " ครั้ง" — so no dictionary entry can reach them, and several ("ตัว",
 * "คน", "ชิ้น") are far too common to put in one anyway. Some have no English equivalent worth
 * printing: "3 ตัว" is just "3" in English, and an empty string is the right translation. */
const STAT_UNITS = {
  "ครั้ง": "times", "จาน": "dishes", "ชิ้น": "items", "ช่อง": "slots", "ชนิด": "kinds",
  "ทอง": "gold", "งาน": "jobs", "แปลง": "plots", "รายการ": "items", "ขั้น": "levels",
  "ตัว": "", "คน": "", "แห่ง": "",
};
function unitWord(th) {
  const en = STAT_UNITS[th];
  if (currentLang() !== "en") return ` ${th}`;
  return en ? ` ${en}` : "";
}

function renderStats() {
  $("#skill-title").textContent = `📊 ${T("สถิติ")}`;
  $("#skill-flavor").textContent = T("ทุกอย่างที่ทำมาตั้งแต่เริ่มโปรไฟล์นี้");

  /* 🐛 [fixed 2026-08-19] This summed P.mastery, which only holds the actions the player has
   * actually performed — but a mastery level FLOORS AT 1 (masteryLevelFromXp(0) === 1), and the cap
   * below counts every action in the game. So the numerator silently dropped one step per untouched
   * action while the denominator still charged for it: the owner's own page read 327/13,761 when
   * every skill page, which walks all of its actions via masteryLevelOf, totalled 441 — 114 slots
   * they had not opened yet, each worth its base step. Counting the same set on both sides of the
   * slash is the fix, and it makes this figure equal the sum of the per-skill "ขั้นรวม" bars. */
  const totalMastery = SKILLS.reduce((t, sk) =>
    t + sk.actions.reduce((n, a) => n + masteryLevelOf(sk.id, a.id), 0), 0);
  const masteryCap = SKILLS.reduce((t, sk) => t + sk.actions.length * MASTERY_MAX, 0);
  const seenItems = Object.keys(P.inv).filter((id) => (P.inv[id] || 0) > 0).length;
  const heldCount = COMPANIES.filter((c) => heldShares(c.id) > 0).length;
  const ownedCount = COMPANIES.filter((c) => isOwner(c.id)).length;
  const investedCost = Object.values(P.holdings || {}).reduce((t, h) => t + (h.cost || 0), 0);
  const marketNow = portfolioValue();
  const unrealised = marketNow - investedCost;
  const killTotal = Object.entries(P.stats).filter(([k]) => k.startsWith("kill:"))
    .reduce((t, [, v]) => t + v, 0);
  const monstersMet = Object.keys(P.stats).filter((k) => k.startsWith("kill:")).length;
  const allMonsters = LOCATIONS.reduce((t, l) => t + l.stages.length, 0);
  const bestSkill = SKILLS.map((sk) => ({ sk, lv: levelFromXp(P.xp[sk.id] || 0) }))
    .sort((a, b) => b.lv - a.lv)[0];

  $("#view-extra").innerHTML = `
    <div class="mastery-summary">
      <span class="m-chip">⏱️ ${fmtDuration(P.playMs || 0)}</span>
      <div class="m-track"><div class="m-nums">
        ${currentLang() === "en"
          ? `Profile "${escapeHtml(P.name)}" · created ${new Date(P.createdAt).toLocaleDateString("en-GB")}`
          : `โปรไฟล์ "${escapeHtml(P.name)}" · สร้างเมื่อ ${new Date(P.createdAt).toLocaleDateString("th-TH")}`}
      </div></div>
    </div>`;

  const cards = [
    { icon: "⚒️", title: T("การทำงาน"), rows: [
      [T("ทำงานสำเร็จ"), fmtNum(P.stats.actions || 0) + unitWord("ครั้ง")],
      [T("ปรุงอาหาร"), fmtNum(P.stats.cooked || 0) + unitWord("จาน")],
      [T("ตีของ/เย็บของ"), fmtNum(P.stats.crafted || 0) + unitWord("ชิ้น")],
      [T("ขโมยสำเร็จ"), fmtNum(P.stats.steals || 0) + unitWord("ครั้ง")],
      [T("ช่องงานที่มี"), `${maxSlots()} ${unitWord("ช่อง").trim()}`],
    ]},
    { icon: "⚔️", title: T("การล่า"), rows: [
      [T("ปราบมอนสเตอร์"), fmtNum(killTotal) + unitWord("ตัว")],
      [T("โค่นบอส"), fmtNum(P.stats.bosses || 0) + unitWord("ครั้ง")],
      [T("ชนิดที่เคยเจอ"), `${monstersMet}/${allMonsters} ${unitWord("ชนิด").trim()}`],
      [T("ระดับความยาก"), T(eliteMode().name)],
      [T("เลเวลล่ารวม"), combatLevel()],
    ]},
    { icon: "💰", title: T("ทรัพย์สิน"), rows: [
      [T("ทองที่หามาทั้งหมด"), fmtNum(P.stats.goldEarned || 0)],
      [T("ทองในมือตอนนี้"), fmtNum(P.gold)],
      [T("ขยะที่ขายไป"), fmtNum(P.stats.junkSold || 0) + unitWord("ชิ้น")],
      [T("ของในกระเป๋า"), `${seenItems} ${unitWord("ชนิด").trim()}`],
      [T("ของที่ซื้อจากร้าน"), `${Object.keys(P.upgrades).length} ${unitWord("รายการ").trim()}`],
    ]},
    /* 🎯 [owner's ask] The business page shows today's position; this shows the track record —
     * how much is deployed, what it is worth now, and where the income actually came from. The
     * yearly tax figure alone never answers "has investing been worth it". */
    { icon: "📈", title: T("การลงทุน"), rows: [
      [T("กิจการที่ถือ"), `${heldCount}/${COMPANIES.length} ${unitWord("แห่ง").trim()}` +
        (ownedCount ? ` · 👑 เจ้าของเต็ม ${ownedCount}` : "")],
      [T("แยกตามขนาด"), COMPANY_SIZES.map((sz) =>
        `${sz.icon} ${COMPANIES.filter((c) => c.size === sz.id && heldShares(c.id) > 0).length}`).join(" · ")],
      [T("เงินที่ลงไป (ทุน)"), fmtNum(Math.round(investedCost))],
      [T("มูลค่าตอนนี้"), fmtNum(Math.round(marketNow)) +
        (investedCost > 0 ? ` (${unrealised >= 0 ? "+" : ""}${(unrealised / investedCost * 100).toFixed(1)}%)` : "")],
      [T("กำไรที่ยังไม่ขาย"), fmtNum(Math.round(unrealised))],
      [T("ปันผลที่ได้รับสะสม"), fmtNum(Math.round(P.stats.divPaid || 0))],
      [T("กำไรจากการซื้อขายสะสม"), fmtNum(Math.round(P.stats.tradeProfit || 0))],
      [T("ดอกเบี้ยธนาคารสะสม"), fmtNum(Math.round(P.stats.bankInterest || 0))],
      [T("ฝากธนาคารตอนนี้"), fmtNum(Math.floor(bankBalance()))],
      [currentLang() === "en" ? `Investment profit, year ${today().year}` : `กำไรลงทุนปีที่ ${today().year}`, fmtNum(Math.round(P.tax?.yearProfit || 0))],
      [T("ภาษีที่จ่ายไปแล้ว"), fmtNum(Math.round(P.tax?.paidTotal || 0))],
    ]},
    { icon: "⭐", title: T("ความชำนาญ"), rows: [
      [T("ขั้นชำนาญรวม"), `${fmtNum(totalMastery)}/${fmtNum(masteryCap)}`],
      [T("ช่องที่ MAX แล้ว"), Object.values(P.mastery).filter((xp) => masteryLevelFromXp(xp) >= MASTERY_MAX).length],
      [T("สายที่เก่งสุด"), `${bestSkill.sk.icon} ${bestSkill.sk.name} (${T("เลเวล")} ${bestSkill.lv})`],
      [T("สายพันธุ์ปลาที่เจอ"), `${Object.keys(P.seenFish).length} ${unitWord("ชนิด").trim()}`],
      [T("เก็บเกี่ยวไปแล้ว"), `${(P.stats.harvests || 0).toLocaleString()} ${unitWord("แปลง").trim()}`],
      [T("พืชที่เคยปลูก"), `${Object.keys(P.seenCrops || {}).length}/${findSkill("fa").actions.length} ${unitWord("ชนิด").trim()}`],
      /* 🐛 [2026-08-18] The third site that counted achievements its own way. The sidebar and the
       * achievements page were unified behind achievementProgress() when the owner caught them
       * disagreeing; this one was missed and still read 5/18 while both of those said 5/190. */
      [T("ความสำเร็จ"), (() => { const a = achievementProgress(); return `${a.done}/${a.total}`; })()],
    ]},
    { icon: "🐾", title: T("สัตว์เลี้ยง"), rows: [
      [T("จับได้แล้ว"), `${P.pets.length} ${unitWord("ตัว").trim()}`],
      [T("สายพันธุ์ที่มีตอนนี้"), `${new Set(P.pets.map((x) => x.species)).size}/${PET_SPECIES.length}`],
      [T("สายพันธุ์ที่เคยเจอ (ไม่หายตอนจุติ)"),
       `${Object.keys(P.seenPets || {}).length}/${PET_SPECIES.length}`],
      [T("ตัวที่พาไปด้วย"), activePet() ? `${petStats(activePet()).icon} ${petStats(activePet()).name} ขั้น ${petStats(activePet()).lv}` : "—"],
      [T("ขั้นสูงสุดที่เลี้ยงได้"), P.pets.length ? Math.max(...P.pets.map((x) => petLevel(x))) : 0],
    ]},
    /* 🎯 [owner 2026-08-22] "เพิ่มสถิติต่างๆ ที่ควรเก็บ เพราะดูหน้าเดียวรู้ทุกอย่าง ทั้งเควส ความสัมพันธ์"
     * Everything the new systems know, on the page that already exists for knowing things. */
    { icon: "📜", title: T("งานจากหมู่บ้าน"), rows: [
      [T("ส่งงานสำเร็จ"), fmtNum(P.stats.questsDone || 0) + unitWord("งาน")],
      [T("ค่าจ้างที่ได้"), fmtNum(Math.round(P.stats.questGold || 0)) + unitWord("ทอง")],
      [T("งานบนกระดานตอนนี้"), `${(P.quests || []).length} ${unitWord("งาน").trim()}`],
      [T("ส่งได้เลยตอนนี้"), `${(P.quests || []).filter(questReady).length} ${unitWord("งาน").trim()}`],
    ] },
    { icon: "💗", title: T("ความสัมพันธ์"), rows: [
      ...VILLAGERS.filter((v) => v.romance).map((v) => {
        const r = relOf(v.id);
        return [`${v.icon} ${v.name}`,
                `${relStage(r.aff).name} (${r.aff}/${REL_MAX})${isSpouse(v.id) ? " 💍" : ""}`];
      }),
      [T("ของขวัญที่ให้ไป"), fmtNum(P.stats.giftsGiven || 0) + unitWord("ชิ้น")],
    ] },
    { icon: "👨‍👩‍👧", title: T("ครอบครัว"), rows: [
      [T("คู่ชีวิต"), spouseIds().length
      ? spouseIds().map((id) => VILLAGERS.find((v) => v.id === id)?.name || "-").join(", ") : T("ยังไม่มี")],
        [T("ลูก"), currentLang() === "en"
        ? `${(P.kids || []).length} · ${P.family?.bornThisLife ?? (P.kids || []).length}/${CHILD_MAX} born this rebirth`
        : `${(P.kids || []).length} คน · รอบจุตินี้เกิดแล้ว ${P.family?.bornThisLife ?? (P.kids || []).length}/${CHILD_MAX}`],
      [T("ลูกที่โตแล้ว"), `${(P.kids || []).filter(childIsAdult).length} ${unitWord("คน").trim()}`],
      [T("ขั้นการเรียนรวม"), `${(P.kids || []).reduce((t, k) =>
          t + CHILD_TRACKS.reduce((n, tr) => n + childTrackLevel(k, tr.id), 0), 0)} ${unitWord("ขั้น").trim()}`],
      [T("ลงทุนกับการเรียนไป"), fmtNum(Math.round(P.stats.eduSpent || 0)) + unitWord("ทอง")],
        /* 🎯 [owner 2026-08-22: "อย่าลืมปรับหน้าสถิติ ให้สัมพันธ์กับระบบล่าสุด"] The household now
           costs money every day and can end the run if it goes unpaid, so the page that summarises
           it has to say both. A stats page listing only what a family GIVES is not a summary. */
        [T("ค่าเลี้ยงดูต่อวัน"), (() => {
          const u = familyUpkeep();
          return u.total ? `${fmtNum(u.total)} ทอง · ภรรยา ${fmtNum(u.spouse)}`
            + (u.kids ? ` · ลูก ${fmtNum(u.heads)}` : "")
            + (u.edu ? ` · ${T("ค่าเรียน")} ${fmtNum(u.edu)}` : "") : T("ยังไม่มีค่าใช้จ่าย");
        })()],
        [T("จ่ายไปเดือนนี้"), fmtNum(Math.round(P.family?.monthPaid || 0)) + unitWord("ทอง")],
        [T("ค้างจ่าย"), familyInArrears()
          ? (currentLang() === "en" ? `${fmtNum(Math.round(P.family.arrears))} gold — partner and child bonuses are paused` : `${fmtNum(Math.round(P.family.arrears))} ทอง — โบนัสภรรยาและลูกหยุดอยู่`) : T("ไม่มี")],
    ] },
    { icon: "📈", title: T("เลเวลทุกสาย"), rows: SKILLS.map((sk) =>
      [`${sk.icon} ${sk.name}`, `${T("เลเวล")} ${levelFromXp(P.xp[sk.id] || 0)}`]) },
  ];

  const grid = $("#action-grid");
  grid.innerHTML = "";
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "action-card stat-card";
    card.innerHTML = `<div class="head"><div class="name">${c.icon} ${c.title}</div></div>`
      + c.rows.map(([k, v]) => `<div class="stat-line"><span>${k}</span><b>${v}</b></div>`).join("");
    grid.appendChild(card);
  }
}

/* 🐛 [2026-08-24] These two sentences were raw Thai inside the slayer card template, and they are
 * the reason the achievements screen was by far the most untranslated in the game — 10,319 Thai
 * characters against 1,949 for the next worst. Not because they are long, but because the screen
 * draws ~196 of these cards and every card repeated the same six fragments: ปราบ, ในระดับ, ตัว,
 * รางวัล, ถาวร and the tier note. Seven distinct phrases were carrying most of the total.
 *
 * Composed per language rather than by translating the fragments. The two languages order this
 * sentence differently — Thai counts at the end, English counts before the noun — and the pieces
 * are common enough words that putting them in a dictionary which also does whole-field
 * replacement is asking for a table entry named exactly "ตัว" to be rewritten somewhere else. */
function slayerRowDetail(r) {
  const monster = escapeHtml(r.raw.name), mode = escapeHtml(r.mode.name);
  const n = r.t.kills.toLocaleString();
  if (currentLang() === "en") {
    return `Defeat ${n} ${monster} at ${mode} tier`
      + (r.ti === 0 ? "" : " · counts only kills at this tier, starting from zero");
  }
  return `ปราบ${monster}ในระดับ${mode} ${n} ตัว`
    + (r.ti === 0 ? "" : " · นับเฉพาะที่ล่าในระดับนี้ เริ่มจากศูนย์");
}
function slayerRowReward(r, rw) {
  return currentLang() === "en"
    ? `Reward: ${rw.icon} +${rw.per[r.ti]} ${rw.name} permanently`
    : (currentLang() === "en" ? `${T("รางวัล")}: ${rw.icon} +${rw.per[r.ti]} ${rw.name}, permanent` : `รางวัล: ${rw.icon} ${rw.name}ถาวร +${rw.per[r.ti]}`);
}

function renderAchievements() {
  $("#skill-title").textContent = `🏆 ${T("ความสำเร็จ")}`;
  $("#skill-flavor").textContent = T("ทุกอันที่ปลดได้ให้โบนัสถาวรกับทั้งโปรไฟล์");
  const { rows: slayerRows, marksDone, done, total } = achievementProgress();
  const perkLine = ["speed", "dmg", "def", "hp", "luck", "goldBonus", "healBonus"]
    .map((k) => ({ k, v: perkTotal(k) })).filter((x) => x.v)
    .map((x) => ({ speed: `⚡ เร็วขึ้น ${Math.round(x.v * 100)}%`, dmg: `🗡️ +${x.v}`,
                   def: `🛡️ +${x.v}`, hp: `❤️ +${x.v}`, luck: `🍀 +${Math.round(x.v * 100)}%`,
                   goldBonus: `💰 +${Math.round(x.v * 100)}%`,
                   healBonus: `❤️ +${Math.round(x.v * 100)}%` }[x.k])).join(" · ");
  /* The title belongs on this page more than anywhere else: this is the only screen that shows
   * what it is made of, and the only one that can say what the next one costs. */
  const ti = titleFor(), nx = nextTitle();
  const titleBlock = ti ? `
    <div class="title-banner${ti.special ? " is-special" : ""}">
      <span class="t-icon">${ti.icon}</span>
      <span class="t-body">
        <b>${escapeHtml(ti.name)}</b>
          <small>${escapeHtml(ti.desc)}${nx
            ? (currentLang() === "en" ? ` · ${nx.need} more for ${nx.icon} ${escapeHtml(nx.name)}` : ` · อีก ${nx.need} เป็น ${nx.icon} ${escapeHtml(nx.name)}`)
            : " · ถือครบทุกฉายาแล้ว ไม่มีอะไรเหนือกว่านี้"}</small>
      </span>
    </div>` : "";
  $("#view-extra").innerHTML = titleBlock + `
    <div class="mastery-summary">
      <span class="m-chip">🏆 ${T("ปลดแล้ว")} ${done}/${total}</span>
      <div class="m-track">
        <div class="m-bar"><div style="width:${done / total * 100}%; background:var(--gold)"></div></div>
        <div class="m-nums">${perkLine || T("ยังไม่มีโบนัสถาวร — ปลดอันแรกแล้วจะเริ่มสะสม")}</div>
      </div>
    </div>
    <label class="hide-owned">
      <input type="checkbox" id="hide-done"${uiPref("hideDoneAch") ? " checked" : ""}>
      ${currentLang() === "en" ? `Hide unlocked (${done}/${total})` : `ซ่อนอันที่ปลดแล้ว (${done}/${total} อัน)`}
    </label>`;
  $("#hide-done").onchange = (e) => { setUiPref("hideDoneAch", e.target.checked); renderAchievements(); };

  const grid = $("#action-grid");
  grid.innerHTML = "";
  const hideDone = uiPref("hideDoneAch");
  if (hideDone && done === total) {
    const all = document.createElement("div");
    all.className = "area-head";
    all.textContent = "🏆 ปลดครบทุกอันแล้ว — ไม่เหลืออะไรให้แสดง";
    grid.appendChild(all);
  }
  for (const a of ACHIEVEMENTS) {
    const got = !!P.achieved[a.id];
    if (hideDone && got) continue;
    const cur = Math.min(derivedStat(a.stat), a.goal);
    const perks = Object.entries(a.perk)
      .map(([k, v]) => ({ speed: `⚡ ${Math.round(v * 100)}%`, dmg: `🗡️ +${v}`, def: `🛡️ +${v}`,
                          luck: `🍀 ${Math.round(v * 100)}%`, goldBonus: `💰 ${Math.round(v * 100)}%`,
                          healBonus: `❤️ ${Math.round(v * 100)}%` }[k])).join(" · ");
    const card = document.createElement("div");
    card.className = "action-card" + (got ? " running" : "");
    card.innerHTML = `
      <div class="head"><div class="name">${a.icon} ${a.name}</div>
        <div class="req">${got ? `✅ ${T("ปลดแล้ว")}` : `${cur.toLocaleString()}/${a.goal.toLocaleString()}`}</div></div>
      <div class="detail">${a.desc}</div>
      <div class="io">${T("รางวัล")}: ${perks}</div>
      <div class="mastery-row"><div class="m-track">
        <div class="m-bar"><div style="width:${cur / a.goal * 100}%; background:var(--gold)"></div></div>
      </div></div>`;
    grid.appendChild(card);
  }

  /* 🎯 [owner 2026-08-17] "มีการ์ดให้เห็นว่าอันไหนสำเร็จ ไม่สำเร็จ ถ้าล่าจะได้อะไร เหมือนการ์ดอื่นๆ"
   * Grouped by monster, not by difficulty: the four rows for one animal belong together, and a flat
   * list of 172 sorted any other way is a wall. The header only prints for a monster that still has
   * a card to show, so the hide-completed filter does not leave empty headings behind. */
  let lastMon = null;
  for (const r of slayerRows) {
    const got = !!P.slayer?.[r.mark];
    if (hideDone && got) continue;
    const n = P.slayerKills?.[r.mark] || 0;
    const rw = SLAYER_REWARDS[r.rk];
    const monKey = `${r.loc.id}:${r.i}`;
    if (monKey !== lastMon) {
      lastMon = monKey;
      const h = document.createElement("div");
      h.className = "area-head";
      h.textContent = `${r.raw.icon} ${r.raw.name} — ${r.loc.name}`;
      grid.appendChild(h);
    }
    const card = document.createElement("div");
    card.className = "action-card" + (got ? " running" : "");
    card.innerHTML = `
      <div class="head"><div class="name">${r.mode.icon} ${escapeHtml(r.mode.name)}</div>
        <div class="req">${got ? `✅ ${T("ปลดแล้ว")}` : `${n.toLocaleString()}/${r.t.kills.toLocaleString()}`}</div></div>
      <div class="detail">${slayerRowDetail(r)}</div>
      <div class="io">${slayerRowReward(r, rw)}</div>
      <div class="mastery-row"><div class="m-track">
        <div class="m-bar"><div style="width:${Math.min(100, n / r.t.kills * 100)}%; background:#7cc47f"></div></div>
      </div></div>`;
    grid.appendChild(card);
  }
}

/* 🎯 [added 2026-08-15, owner's ask] The shop only grows, so everything already bought stays in
 * the way of what is still worth reading. This hides owned entries; the count stays visible so it
 * never feels like something went missing. */
/* Read through a helper so an older profile that predates `ui` still answers false rather than
 * throwing, without every call site repeating the guard. */
function uiPref(key) { return !!(P.ui && P.ui[key]); }

/* Sound settings live in the profile like every other preference. Effects default ON, music OFF.
 * The asymmetry is deliberate: an effect answers something you just did and is over in a tenth of a
 * second, while music is a decision to have this game making noise for hours — defaulting it on
 * would be choosing that on the player's behalf for their whole session. */
function soundPref(key, fallback) {
  if (!P || !P.ui || P.ui[key] === undefined) return fallback;
  return !!P.ui[key];
}
/* 🎯 [owner 2026-08-23] "ในปุ่มตั้งค่า มีปรับค่ากราฟิก โหมดประหยัดพลังงาน อาจลดเอฟเฟกต์ต่างๆ"
 *
 * One switch, not a slider with three quality tiers — there is exactly one decision here ("make the
 * phone work less") and every extra step would be a setting the player has to form an opinion about.
 *
 * What it turns off is chosen by COST, not by how decorative it looks. The expensive things in this
 * page are the ones that never stop: a full-viewport blurred backdrop animating on a 46-second loop,
 * a grain layer over the top of it, and the sheens and pulses that run `infinite` on cards, bars and
 * tabs. A blurred element the size of the screen is re-composited every frame it moves, which is the
 * single most expensive thing a CSS page can ask a phone to do, and it is doing it whether or not
 * anything is happening in the game.
 *
 * What it keeps is everything that ANSWERS something: damage numbers, the hit shake, toasts, the
 * level-up flash. Those are short, they fire because you did something, and removing them would make
 * the game harder to read rather than cheaper to run — a power saver that hides what just happened
 * has stopped being a graphics setting.
 *
 * The tick rate is deliberately untouched. The game still simulates at 250ms and progress bars still
 * move at full smoothness; this saves GPU compositing, not simulation. Saying so matters, because a
 * "power saving" toggle that quietly slowed the game down would be a different feature. */
function ecoOn() { return uiPref("ecoMode"); }

/* The tick rate the player chose, validated against the table rather than trusted: a save carrying
   a number that is no longer offered would otherwise set the game to it forever. */
function tickMs() {
  const want = P && P.ui && P.ui.tickMs;
  return TICK_RATES.some((r) => r.ms === want) ? want : TICK_MS_DEFAULT;
}

function startLogicTimer() {
  if (logicTimer) clearInterval(logicTimer);
  logicTimer = setInterval(tick, tickMs());
}

function applyGraphicsPrefs() {
  const el = typeof document !== "undefined" && document.documentElement;
  if (!el || !el.classList) return;      // headless DOM, and nothing to paint anyway
  el.classList.toggle("eco", ecoOn());
  /* Progress bars are smoothed by a CSS transition between ticks. At 250ms the default lengths
     hide the steps; at 1000ms they finish long before the next update and the bar visibly stops
     and jumps. Lengthening the transition to match the rate is what keeps a slower tick reading as
     "slower updates" rather than "the game is stuttering". */
  el.classList.toggle("tick-slow", tickMs() >= 500);
  el.classList.toggle("tick-slowest", tickMs() >= 1000);
}

function applySoundPrefs() {
  if (typeof Audio === "undefined" || !Audio.available || !Audio.available()) return;
  Audio.setSfx(soundPref("sfxOn", true));
  Audio.setMusic(soundPref("musicOn", false));
}
function setSoundPref(key, on) {
  P.ui = P.ui || {};
  P.ui[key] = !!on;
  applySoundPrefs();
  refreshWakeLock();      // the awake toggle lives in the same panel and must act immediately
}
function setUiPref(key, value) {
  P.ui = P.ui || {};
  P.ui[key] = !!value;
}

function renderShop() {
  $("#skill-title").textContent = `🏪 ${T("ร้านค้านักผจญภัย")}`;
  $("#skill-flavor").textContent = T("เครื่องมือเร่งงาน · คัมภีร์เพิ่ม XP · เครื่องรางติดตัว — ทุกชิ้นถาวร");
  const ownedCount = SHOP.filter((u) => P.upgrades[u.id]).length;
  $("#view-extra").innerHTML = `
    <label class="hide-owned">
      <input type="checkbox" id="hide-owned"${uiPref("hideOwnedShop") ? " checked" : ""}>
      ${currentLang() === "en" ? `Hide owned (${ownedCount}/${SHOP.length})` : `ซ่อนของที่มีแล้ว (${ownedCount}/${SHOP.length} ชิ้น)`}
    </label>`;
  $("#hide-owned").onchange = (e) => { setUiPref("hideOwnedShop", e.target.checked); renderShop(); };
  const grid = $("#action-grid");
  grid.innerHTML = "";

  if (traderOpen()) {
    const head = document.createElement("div");
    head.className = "area-head trader-head";
    head.innerHTML = `🧙 แผงพ่อค้าเร่ — เก็บแผงในอีก <span id="trader-clock">${traderSecondsLeft()}</span> วินาที`;
    grid.appendChild(head);
    P.trader.offers.forEach((o, i) => {
      const item = ITEMS[o.item];
      const card = document.createElement("div");
      card.className = "action-card trader-card" + (o.sold ? " locked" : "");
      card.innerHTML = `
        <div class="head"><div class="name">${item.icon} ${item.name} ×${o.n}</div>
          <div class="req">${o.sold ? `✅ ${T("ซื้อแล้ว")}` : `${o.price.toLocaleString()} 💰`}</div></div>
        <div class="detail">${currentLang() === "en" ? `Normally you go and find these — ${Math.round(o.price / o.n)} 💰 each on average` : `ปกติต้องไปหาเอง — ราคาเฉลี่ย ${Math.round(o.price / o.n)} 💰 ต่อชิ้น`}</div>
        ${!o.sold && P.gold < o.price
          ? `<div class="detail missing">${shortBy(o.price - P.gold)}</div>` : ""}`;
      if (!o.sold) card.onclick = () => buyTraderOffer(i);
      grid.appendChild(card);
    });
  }

  const groups = [
    { title: `🛠️ ${T("เครื่องมือ (ทำงานเร็วขึ้น ซื้อไล่ขั้น)")}`, match: (u) => !u.kind },
    { title: `📚 ${T("คัมภีร์ (XP เพิ่มถาวรทั้งสาย)")}`,   match: (u) => u.kind === "tome" },
    { title: `🧿 ${T("เครื่องราง (ผลติดตัวทุกโหมด)")}`,    match: (u) => u.kind === "charm" },
    { title: `🪴 ${T("กระถางปลูก (เปิดแปลงเพิ่มให้สวน)")}`, match: (u) => u.kind === "plot" },
    { title: `⚡ ${T("ทำหลายอย่างพร้อมกัน (ของแพงที่สุดในเกม)")}`, match: (u) => u.kind === "multi" },
  ];
  for (const g of groups) {
    const all = SHOP.filter(g.match);
    const shown = uiPref("hideOwnedShop") ? all.filter((u) => !P.upgrades[u.id]) : all;
    if (!shown.length) continue;   // a fully-bought category disappears rather than sitting empty
    const head = document.createElement("div");
    head.className = "area-head";
    head.textContent = g.title
      + (uiPref("hideOwnedShop") && shown.length < all.length ? ` — ซ่อนไปแล้ว ${all.length - shown.length}` : "");
    grid.appendChild(head);
    for (const u of shown) {
      const owned = !!P.upgrades[u.id];
      const gated = u.requires && !P.upgrades[u.requires];
      const card = document.createElement("div");
      card.className = "action-card" + (owned ? " running" : "") + (gated ? " locked" : "");
      card.innerHTML = `
        <div class="head"><div class="name">${u.icon} ${u.name}</div>
          <div class="req">${owned ? `✅ ${T("มีแล้ว")}` : `${u.price.toLocaleString()} 💰`}</div></div>
        <div class="detail">${shopEffectText(u)}</div>
        ${!owned && !gated && P.gold < u.price
          ? `<div class="detail missing">${shortBy(u.price - P.gold)}</div>` : ""}
        ${gated ? `<div class="detail missing">${needFirst(SHOP.find((x) => x.id === u.requires).name)}</div>` : ""}`;
      if (!owned && !gated) card.onclick = () => {
        if (P.gold < u.price) { toast("ทองไม่พอ", "warn"); return; }
        P.gold -= u.price;
        P.upgrades[u.id] = true;
        toast(`🛒 ซื้อ ${u.name} แล้ว — ${shopEffectText(u)}`, "levelup");
        renderView();
      };
      grid.appendChild(card);
    }
  }
}

/* ---------- Banner ---------- */

/* The banner is now a list: one row per running slot, each with its own progress and stop. */
function updateBanner() {
  const banner = $("#active-banner");
  if (!P || !P.slots.length) { banner.classList.remove("on"); return; }
  banner.classList.add("on");

  const mt = momentumTier();
  const held = momentumSince ? Math.floor((performance.now() - momentumSince) / 1000) : 0;
  const nextT = MOMENTUM_TIERS.find((t) => t.at > held);
  const buffTxt = [buffActive("surge") ? "💎 ของ ×2" : "", buffActive("haste") ? "🍃 เร็ว +40%" : ""]
    .filter(Boolean).join(" ");

  banner.innerHTML = `
    <div class="slot-list">
      ${P.slots.map((sl, i) => {
        if (sl.type === "skill") {
          const skill = findSkill(sl.skillId);
          const action = findAction(skill, sl.actionId);
          return `<div class="slot-row">
            <span class="slot-what">${skill.icon} ${action.name}</span>
            <span class="slot-bar"><span data-slotfill="${i}" style="background:${skill.accent}"></span></span>
            <button class="btn ghost small" data-stopslot="${i}">${T("หยุด")}</button>
          </div>`;
        }
        const loc = findLocation(sl.locId);
        const stage = loc.stages[sl.stageIdx];
        const m2 = eliteMode();
        return `<div class="slot-row">
          <span class="slot-what">${m2.icon} ล่า ${stage.name}${m2.id === "normal" ? "" : ` · ${m2.name}`}</span>
          <span class="slot-bar"><span data-slotfill="${i}" style="background:#e86a6a; width:100%"></span></span>
          <button class="btn ghost small" data-stopslot="${i}">${T("หยุด")}</button>
        </div>`;
      }).join("")}
    </div>
    <div class="banner-side">
      <span class="slot-count">ช่องงาน ${P.slots.length}/${maxSlots()}</span>
      <span class="momentum${mt.xp ? " on" : ""}">${mt.icon} ${mt.name}${mt.xp ? ` +${Math.round(mt.xp * 100)}% XP` : ""}`
        + `${nextT ? ` <span class="mo-next">(อีก ${nextT.at - held}s)</span>` : ""}</span>
      ${buffTxt ? `<span class="buff-chip">${buffTxt}</span>` : ""}
      ${P.slots.length > 1 ? `<button class="btn ghost small" id="stop-all">หยุดทั้งหมด</button>` : ""}
    </div>`;

  banner.querySelectorAll("[data-stopslot]").forEach((b) =>
    b.onclick = () => stopSlot(Number(b.dataset.stopslot)));
  const all = banner.querySelector("#stop-all");
  if (all) all.onclick = () => stopAllSlots();
}

function updateProgressBars(slotIdx, frac) {
  const sl = P.slots[slotIdx];
  if (!sl || sl.type !== "skill") return;
  const pct = `${Math.min(100, Math.round(frac * 100))}%`;
  const fill = document.querySelector(`[data-slotfill="${slotIdx}"]`);
  if (fill) fill.style.width = pct;
  /* 🐛 [fixed 2026-08-18, owner: "ขโมย มันค้างไม่ขยับ ต้องสลับไปหน้าอื่น"] This used to match the
   * running job by its POSITION in the grid against its index in skill.actions — but renderSkill
   * only draws the cards of the currently shown ZONE, while that index counts every action in the
   * skill. The two only line up in a skill's FIRST zone. Anywhere deeper the index overshoots the
   * card list, `i === idx` never matched, and the else-branch actively forced every bar to 0% — so
   * the bar could never move at all. Thieving showed it worst because currentArea() defaults to the
   * DEEPEST zone unlocked (th:32 lands on zone 5 of 7) while the owner's job ran in zone 1, but
   * every multi-zone skill had it: fishing, mining, farming, cooking, leatherwork, smithing (14
   * zones), charcoal, woodcutting. Matching on the action id instead has no positional assumption
   * left to break, the same way the farm's plot bars already select by [data-plot-fill="i"]. */
  if (view.kind === "skill" && sl.skillId === view.skillId) {
      // React reads the fraction back out of the model, so the tick only has to say
      // "something moved". The memo on each card means an unchanged one costs a shallow
      // compare and touches no DOM at all.
      if (window.__ui) { window.__ui.sync(); return; }
    document.querySelectorAll("#action-grid [data-progress]").forEach((bar) => {
      bar.style.width = bar.dataset.progress === sl.actionId ? pct : "0%";
    });
  }
}

/* 🐛 [added 2026-08-19, owner: "แถบสีชมพูขั้น มันไม่ขยับ"] The mastery bar, its XP text and the
 * whole-skill summary above it were written once by renderSkill and never touched again — mastery
 * xp accrues on every completed cycle, but nothing redrew them, so the bar sat frozen and the
 * numbers lied. A full renderSkill() per cycle is not an option: it rebuilds the grid and would
 * fight every click. This repaints just the three values in place, the same shape as
 * updateProgressBars. Only the running action's row can have changed, so only it is touched. */
function updateMasteryBar(skillId, actionId) {
  // React re-reads the mastery numbers from the model; the tick only has to say something moved.
  if (window.__ui) { window.__ui.sync(); return; }
  if (!(view.kind === "skill" && view.skillId === skillId)) return;
  const skill = findSkill(skillId);
  const lvl = masteryLevelOf(skillId, actionId);
  const xp = P.mastery[masteryKey(skillId, actionId)] || 0;
  const base = masteryXpToReach(lvl), next = masteryXpToReach(lvl + 1);
  const maxed = lvl >= MASTERY_MAX;

  const fill = document.querySelector(`[data-mfill="${actionId}"]`);
  if (fill) fill.style.width = `${Math.round((maxed ? 1 : (xp - base) / (next - base)) * 100)}%`;
  const chip = document.querySelector(`[data-mchip="${actionId}"]`);
  if (chip) chip.textContent = `⭐ ขั้น ${lvl}${maxed ? " MAX" : ""}`;
  const nums = document.querySelector(`[data-mnums="${actionId}"]`);
  if (nums) {
    const action = findAction(skill, actionId);
    nums.textContent = `${maxed ? "เต็มขั้นแล้ว" : `${xp - base}/${next - base} XP`}`
      + ` · เร็วขึ้น ${(masteryStepsWorth(lvl) * MASTERY_SPEED_PER_LEVEL * 100).toFixed(1)}%`
      + (action.steal || action.catch || action.junk
          ? ` · ของดี +${((masteryLootMult(skillId, actionId) - 1) * 100).toFixed(0)}%`
            + (action.junk ? ` · ขยะ -${((1 - masteryJunkMult(skillId, actionId)) * 100).toFixed(0)}%` : "")
          : "");
  }

  // The per-skill roll-up right above the cards moves with every one of them.
  const levels = skill.actions.map((a) => masteryLevelOf(skillId, a.id));
  const sum = levels.reduce((t, x) => t + x, 0);
  const cap = skill.actions.length * MASTERY_MAX;
  const sumFill = document.querySelector("[data-msumfill]");
  if (sumFill) sumFill.style.width = `${Math.round(sum / cap * 100)}%`;
  const sumNums = document.querySelector("[data-msumnums]");
  if (sumNums) sumNums.textContent = `ขั้นรวม ${sum}/${cap} (${(sum / cap * 100).toFixed(1)}%)`
    + ` · ช่องที่ MAX แล้ว ${levels.filter((x) => x >= MASTERY_MAX).length}/${skill.actions.length}`;
}

/* ---------- Inventory (custom tabs) ---------- */

let invTab = "ทั้งหมด";

/* 🎯 [added 2026-08-15, owner's ask] Items file themselves into ปลา / อาหาร / แร่ / อาวุธ on sight,
 * so a fresh bag is organised without anyone organising it. A category the player set by hand on a
 * specific item always wins over the automatic one. */
function categoryOf(id) {
  if (P.itemCat[id]) return P.itemCat[id];
  const auto = AUTO_CATEGORIES.find((c) => c.match(id, ITEMS[id]));
  return auto ? auto.name : null;
}
/* An automatic bag earns its tab only once something is actually in it. */
function activeTabs() {
  const holding = Object.entries(P.inv).filter(([, n]) => n > 0).map(([id]) => id);
  const autos = AUTO_CATEGORIES
    .filter((c) => holding.some((id) => categoryOf(id) === c.name))
    .map((c) => ({ label: `${c.icon} ${T(c.name)}`, name: c.name }));
  return [...autos, ...P.cats.map((c) => ({ label: c, name: c }))];
}

function renderInvTabs() {
  const bar = $("#inv-tabs");
  // Automatic bags lead, then the player's own, then the add button, with "ทั้งหมด" anchoring the
  // end (owner's ordering, 2026-08-15). Only hand-made categories can be deleted.
  const tab = (t) =>
    `<button class="inv-tab${t.name === invTab ? " active" : ""}" data-tab="${escapeHtml(t.name)}">${escapeHtml(t.label)}</button>`;
  bar.innerHTML = activeTabs().map(tab).join("")
    + `<button class="inv-tab add" id="inv-add">+ ${T("หมวดใหม่")}</button>`
    + (junkOnHand().n ? `<button class="inv-tab junk" id="inv-junk">🗑️ ${T("ขายขยะทั้งหมด")} (${junkOnHand().n} ${T("ชิ้น")} / ${junkOnHand().gold.toLocaleString()} 💰)</button>` : "")
    + tab({ label: T("ทั้งหมด"), name: "ทั้งหมด" })
    + (P.cats.includes(invTab) ? `<button class="inv-tab del" id="inv-del">${T("ลบหมวดนี้")}</button>` : "");
  bar.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { invTab = b.dataset.tab; renderInventory(); });
  $("#inv-add").onclick = () => {
    const name = (prompt(T("ตั้งชื่อหมวดใหม่ (เช่น ของขาย / เก็บไว้คราฟต์)")) || "").trim();
    if (!name || P.cats.includes(name) || name === "ทั้งหมด"
        || AUTO_CATEGORIES.some((c) => c.name === name)) return;
    P.cats.push(name);
    invTab = name;
    renderInventory();
  };
  const jb = $("#inv-junk");
  if (jb) jb.onclick = () => sellAllJunk();
  const del = $("#inv-del");
  if (del) del.onclick = () => {
    P.cats = P.cats.filter((c) => c !== invTab);
    for (const [id, c] of Object.entries(P.itemCat)) if (c === invTab) delete P.itemCat[id];
    invTab = "ทั้งหมด";
    renderInventory();
  };
}

/* What the one-click junk sweep would clear right now. */
function junkOnHand() {
  let n = 0, gold = 0;
  for (const id of JUNK_IDS) {
    const have = P.inv[id] || 0;
    n += have;
    gold += have * ITEMS[id].sell;
  }
  return { n, gold };
}

function sellAllJunk() {
  const { n, gold } = junkOnHand();
  if (!n) return;
  for (const id of JUNK_IDS) P.inv[id] = 0;
  P.gold += gold;
  bump("junkSold", n); bump("goldEarned", gold);
  checkAchievements();
  toast(`🗑️ ขายขยะ ${n} ชิ้น ได้ ${gold.toLocaleString()} 💰`);
  renderInventory();
  refreshSidebar();
}

function renderInventory() {
  renderInvTabs();
  const grid = $("#inv-grid");
  const entries = Object.entries(P.inv).filter(([id, n]) =>
    n > 0 && (invTab === "ทั้งหมด" || categoryOf(id) === invTab));
  if (!entries.length) {
    grid.innerHTML = `<div class="inv-empty">${T(invTab === "ทั้งหมด" ? "ยังไม่มีของ — เริ่มเก็บวัตถุดิบกันเลย" : "หมวดนี้ยังว่าง")}</div>`;
    return;
  }
  grid.innerHTML = "";
  const catOptions = (id) => {
    const cur = P.itemCat[id];
    const auto = AUTO_CATEGORIES.find((c) => c.match(id, ITEMS[id]));
    const names = [...AUTO_CATEGORIES.map((c) => c.name), ...P.cats];
    /* The VALUE is the Thai name — that is the identity the save keeps (see the note beside
     * I18N_TABLES). Only the label a player reads goes through T(). A hand-made category is not in
     * the dictionary, so T() returns it untouched, which is what should happen to the player's own
     * words. */
    return [`<option value="">${auto ? `${T("อัตโนมัติ")} · ${T(auto.name)}` : T("ไม่จัดหมวด")}</option>`,
      ...names.map((c) => `<option value="${escapeHtml(c)}" ${cur === c ? "selected" : ""}>${escapeHtml(T(c))}</option>`)].join("");
  };
  for (const [id, n] of entries) {
    const item = ITEMS[id];
    const badge = statBadge(item);
    const el = document.createElement("div");
    el.className = "inv-item";
    el.innerHTML = `
      <div class="icon">${iconArt("item", id, item.icon, item.name)}</div>
      <div class="inv-main">
        <div class="nm">${item.name}</div>
        <div class="sell">${T("ขาย")} ${item.sell} 💰${badge ? " · " + badge : ""}</div>
        <select class="cat-pick" data-cat="${id}">${catOptions(id)}</select>
      </div>
      <div class="inv-side">
        <div class="qty">×${n}${reservedCount(id) ? `<span class="lock-badge" title="${T("สวมใส่อยู่")} ${reservedCount(id)} ${T("ชิ้น")}">🔒${reservedCount(id)}</span>` : ""}</div>
        <button class="btn small" data-sell="${id}">${T("ขาย")}</button>
      </div>`;
    el.querySelector("[data-sell]").onclick = () => openSellDialog(id);
    el.querySelector("[data-cat]").onchange = (e) => {
      if (e.target.value) P.itemCat[id] = e.target.value; else delete P.itemCat[id];
      renderInventory();
    };
    grid.appendChild(el);
  }
}

/* 🎯 [added 2026-08-15, owner's ask] Selling used to dump the whole stack instantly with no
 * confirmation — one stray click could wipe a hoard. Now a dialog asks how many, with quick
 * buttons and a free-typed amount, and shows the exact gold before anything is committed. */
/* Notification settings. Deliberately its own popup next to the pause button rather than a page:
 * it is something you reach for mid-play when the strip gets noisy, not something you go and
 * visit. Changes apply immediately and are saved with the profile. */
function setNotif(cat, on) {
  P.ui = P.ui || {};
  P.ui.notif = P.ui.notif || {};
  P.ui.notif[cat] = !!on;
}

/* 🎯 [owner 2026-08-18, on game-playtester's finding that autoheal is silently inert until a food
 * slot is manually assigned] "ถ้าเป็นการเล่น มันอาจมี popup guide สอนครั้งแรกเท่านั้น" — shown once,
 * only to a genuinely new character (freshProfile sets seenIntro: false; migrate marks every
 * existing save as already seen). One tip, because that is the one thing two separate playtests
 * confirmed nobody could discover on their own — not a general tutorial. */
function openIntroPopup() {
  if (!P || P.seenIntro) return;
  P.seenIntro = true;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">👋 ก่อนเริ่ม</div>
      <div class="modal-sub">
        เลือดจะไม่ฟื้นเองระหว่างล่า จนกว่าจะตั้ง "ช่องเสบียง" ไว้อย่างน้อยหนึ่งช่อง —
        ไปที่หน้าล่ามอนสเตอร์ แล้วเปิดแผงอาหารด้านล่าง เลือกของกินใส่ช่องไว้ก่อนออกไป<br><br>
        มีของกินอยู่ในกระเป๋าเฉยๆ โดยไม่ตั้งช่อง จะไม่ถูกกินเองเลย
      </div>
      <div class="modal-actions"><button class="btn" data-close>${T("เข้าใจแล้ว")}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => { save("แนะนำครั้งแรก"); back.remove(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}

/* ── Fullscreen ───────────────────────────────────────────────────────────────────────────────
 * 🎯 [owner 2026-08-22] "เพิ่มโหมดขยาย full screen หลังปุ่มเฟือง ... กดอีกครั้งจะกลับมาเหมือนเดิม"
 *
 * The API is prefixed on older WebKit and, more importantly, is simply ABSENT on iPhone Safari —
 * iOS allows fullscreen on <video> and nothing else. A button that is present and does nothing is
 * worse than one that is not there, so `fullscreenSupported()` decides whether it is rendered at
 * all rather than the click failing quietly.
 */
function fullscreenSupported() {
  /* 🐛 [found 2026-08-22 by the new title checks] documentElement is absent under the headless DOM
   * shim, so this threw and took vitalsModel() down with it — the same shape as the unguarded
   * style writes that once cost 48 checks at a stroke. Capability probes must never assume the
   * host has a full DOM. */
  const el = typeof document !== "undefined" && document.documentElement;
  if (!el) return false;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function toggleFullscreen() {
  const el = document.documentElement;
  if (isFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
  } else {
    (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
  }
}

/* ── Keeping the screen awake ──────────────────────────────────────────────────────────────────
 * 🎯 [owner 2026-08-22] "เพราะมันเป็นเกม idle มีบางจังหวะที่เรานั่งดู แต่ในมือถือมันจะเริ่มเข้าโหมด idle
 * ไม่ขยับ แล้วเตรียมล็อกจอตาม"
 *
 * A phone decides you are idle by watching for touches, and this is specifically the kind of game
 * you watch without touching. The Wake Lock API is the only way to say "I am still here" without
 * faking input.
 *
 * Three rules, each because a wake lock spends someone's battery on their behalf:
 *   - the browser revokes it whenever the tab is hidden, so it must be re-taken on return
 *   - it is released while the game is paused, because a paused game is not being watched
 *   - it is released the moment the setting is turned off, not at the next tick
 *
 * Support is real but not universal: Android Chrome and iOS Safari 16.4+ have it, older iOS does
 * not. The row renders disabled with the reason rather than lying about what it will do.
 */
let wakeLock = null;

/* Either mechanism counts as "we can keep the screen on". The Wake Lock API is preferred and
 * needs a secure context; the video fallback works anywhere and is what makes the setting real on
 * a plain-http LAN address, which is exactly how the owner plays. */
function wakeLockSupported() {
  return (typeof navigator !== "undefined" && "wakeLock" in navigator)
      || typeof NoSleepVideo !== "undefined";
}
function wakeLockNative() {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

async function acquireWakeLock() {
  if (!wakeLockSupported() || wakeLock) return;
  if (!P || !soundPref("awakeOn", true) || paused) return;
  if (document.visibilityState !== "visible") return;
  if (!wakeLockNative()) {
    // No secure context, so no API. The playing-video trick holds the screen instead.
    if (typeof NoSleepVideo !== "undefined") await NoSleepVideo.enable();
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    // The browser drops it on its own — tab switch, lock, low battery. Clearing the handle is what
    // lets refreshWakeLock notice and take a new one instead of assuming it still holds one.
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) {
    wakeLock = null;                 // refused (battery saver, permission) — never worth a toast
  }
}

function releaseWakeLock() {
  if (typeof NoSleepVideo !== "undefined") NoSleepVideo.disable();
  if (!wakeLock) return;
  try { wakeLock.release(); } catch (e) { /* already gone */ }
  wakeLock = null;
}

/* The single entry point: every caller only has to say "conditions may have changed". */
function refreshWakeLock() {
  if (!wakeLockSupported()) return;
  const want = !!P && soundPref("awakeOn", true) && !paused
    && document.visibilityState === "visible";
  if (want) acquireWakeLock(); else releaseWakeLock();
}

/* What the screen-awake setting is ACTUALLY doing right now.
 *
 * 🎯 [owner 2026-08-22] Third report of "จอกันดับยังใช้ไม่ได้". The row could only say supported or
 * not supported, so neither of us could tell whether the video was refused, playing but muted, or
 * playing and simply not enough for this device. Three rounds of guessing is the cost of a UI that
 * reports intent instead of state; this reports state.
 */
function wakeLockStatusText() {
  if (!soundPref("awakeOn", true)) return "";
  if (wakeLockNative()) {
    return wakeLock ? T("กำลังทำงาน (Wake Lock API)") : T("ยังไม่ได้จับ — จะจับเมื่อกลับมาดูหน้าจอ");
  }
  if (typeof NoSleepVideo === "undefined") return T("ไม่มีวิธีสำรองในหน้านี้");
  const s = NoSleepVideo.status();
  if (s.playing && !s.muted) return T("กำลังทำงาน (วิดีโอเงียบ)");
  if (s.playing && s.muted) return T("วิดีโอเล่นแบบ mute — Android มักไม่ยอมกันจอดับให้ ต้องใช้ https");
  if (s.error) return `${T("วิดีโอถูกปฏิเสธ")} (${s.error}) — ${T("แตะหน้าจอหนึ่งครั้งแล้วเปิดดูใหม่")}`;
  return T("ยังไม่เริ่ม — แตะหน้าจอหนึ่งครั้ง");
}

function openSettings() {
  if (!P) return;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">${T("⚙️ ตั้งค่า")}</div>
      <div class="modal-head" style="font-size:16px">${T("ภาษา / Language")}</div>
      <div class="lang-row">
        <button class="btn lang-btn${currentLang() === "th" ? " primary" : ""}" data-lang="th">${T("🇹🇭 ไทย")}</button>
        <button class="btn lang-btn${currentLang() === "en" ? " primary" : ""}" data-lang="en">🇬🇧 English</button>
      </div>
      <div class="modal-sub">${T("ยังแปลไม่ครบทุกคำ — คำที่ยังไม่ได้แปลจะแสดงเป็นภาษาไทยไว้ก่อน / Not everything is translated yet; untranslated text stays in Thai.")}</div>
      <div class="modal-head" style="font-size:16px">${T("การแจ้งเตือน")}</div>
      <div class="modal-sub">${T("เลือกว่าจะให้อะไรเด้งขึ้นมาบ้าง — คำเตือน ความพ่ายแพ้ และข้อความที่ตอบสิ่งที่คุณเพิ่งกด จะแสดงเสมอ ปิดไม่ได้")}</div>
      <div class="notif-list">
        ${NOTIF_KINDS.map((n) => `
          <label class="notif-row">
            <input type="checkbox" data-notif="${n.id}"${notifOn(n.id) ? " checked" : ""}>
            <span class="notif-name">${n.icon} ${n.name}</span>
            <span class="notif-note">${n.note}</span>
          </label>`).join("")}
      </div>

      <!-- 🎯 [owner 2026-08-22] "เอาเสียงทั้งสองไปไว้ใต้สุด เพราะน่าจะปรับพวก Notis บ่อยกว่าเสียง"
           Sound is set once and left; the notification rows are the ones that get revisited. The
           thing you come back for goes where you land. -->
      <div class="modal-head" style="font-size:16px; margin-top:18px">${T("เสียงและหน้าจอ")}</div>
      <div class="notif-list">
        <label class="notif-row">
          <input type="checkbox" data-sound="sfxOn"${soundPref("sfxOn", true) ? " checked" : ""}>
          <span class="notif-name">${T("🔔 เสียงประกอบ")}</span>
          <span class="notif-note">${T("เสียงสั้น ๆ ตอนได้ของ เลเวลอัพ เก็บเกี่ยว หรือมีคำเตือน")}</span>
        </label>
        <label class="notif-row">
          <input type="checkbox" data-sound="musicOn"${soundPref("musicOn", false) ? " checked" : ""}>
          <span class="notif-name">${T("🎵 เพลงประกอบ")}</span>
          <span class="notif-note">${T("ทำนองช้า ๆ วนไปเรื่อย ๆ — ปิดไว้เป็นค่าเริ่มต้น")}</span>
        </label>
        <label class="notif-row"${wakeLockSupported() ? "" : ' style="opacity:.45"'}>
          <input type="checkbox" data-sound="awakeOn"${soundPref("awakeOn", true) ? " checked" : ""}${wakeLockSupported() ? "" : " disabled"}>
          <span class="notif-name">${T("📱 กันจอดับตอนดูเกม")}</span>
          <span class="notif-note">${wakeLockSupported()
            ? `${T("เกม idle มีจังหวะที่นั่งดูเฉย ๆ มือถือจะได้ไม่ล็อกจอ — ปล่อยเองเมื่อสลับแอปหรือกดพัก")}${
                wakeLockNative() ? "" : ` ${T("(ใช้วิธีเล่นวิดีโอเงียบ เพราะหน้านี้เป็น http)")}`}${wakeLockStatusText() ? `<br><b class="awake-state">${T("สถานะตอนนี้")}: ${escapeHtml(wakeLockStatusText())}</b>` : ""}`
            : (typeof isSecureContext !== "undefined" && !isSecureContext)
              /* 🎯 [owner 2026-08-22] This used to say "เบราว์เซอร์นี้ไม่รองรับ" and that was wrong:
               * Chrome supports Wake Lock. It requires a SECURE CONTEXT, and http:// on a LAN name
               * is not one — localhost is special-cased as secure, which is precisely why it worked
               * in testing and nowhere else. Blaming the browser sent the owner looking in the
               * wrong place, so the message now names the real cause and the fix. */
              ? "ต้องเปิดผ่าน https — เบราว์เซอร์ปิดฟีเจอร์นี้บนหน้า http (รันเซิร์ฟเวอร์ด้วย --https)"
              : "เบราว์เซอร์นี้ไม่รองรับ"}</span>
        </label>
      </div>
      <div class="modal-head" style="font-size:16px; margin-top:18px">${T("กราฟิก")}</div>
      <div class="modal-sub">${T("อัตราอัปเดตหน้าจอ")} — ${T("เกมนี้ไม่ได้วาดที่ 60 เฟรม/วินาที แต่เดินด้วยรอบอัปเดตวินาทีละ 4 ครั้ง ลดลงได้เพื่อให้เครื่องทำงานน้อยลง")}<br><b>${T("ความเร็วต่อสู้และการผลิตไม่เปลี่ยน ไม่ว่าจะเลือกอันไหน")}</b></div>
      <div class="lang-row">
        ${TICK_RATES.map((r) => `<button class="btn lang-btn${tickMs() === r.ms ? " primary" : ""}" data-tick="${r.ms}"
          title="${escapeHtml(T(r.note))}">${T(r.name)}</button>`).join("")}
      </div>
      <div class="modal-sub">${escapeHtml(T(TICK_RATES.find((r) => r.ms === tickMs()).note))}</div>

      <div class="notif-list">
        <label class="notif-row">
          <input type="checkbox" data-gfx="ecoMode"${ecoOn() ? " checked" : ""}>
          <span class="notif-name">${T("🔋 โหมดประหยัดพลังงาน")}</span>
          <span class="notif-note">${T("ปิดพื้นหลังเบลอที่ขยับตลอดเวลา ผิวหนังการ์ด และแถบวิ่ง — พวกที่ทำงานทิ้งไว้แม้ไม่มีอะไรเกิดขึ้น เครื่องร้อนน้อยลงและแบตอยู่นานขึ้น")}<br>${T("ตัวเลขดาเมจ ข้อความเด้ง และเอฟเฟกต์ตอนเลเวลอัพยังอยู่ครบ — พวกนั้นบอกว่าเพิ่งเกิดอะไรขึ้น ปิดแล้วเกมจะอ่านยากกว่าเดิม")}<br>${T("ความเร็วเกมและแถบความคืบหน้าไม่ถูกลดลง")}</span>
        </label>
      </div>

      <div class="modal-actions">
        <button class="btn ghost" data-notif-all="off">${T("ปิดทั้งหมด")}</button>
        <button class="btn ghost" data-notif-all="on">${T("เปิดทั้งหมด")}</button>
        <button class="btn" data-close>${T("เสร็จ")}</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const sync = () => back.querySelectorAll("[data-notif]").forEach((el) => {
    el.checked = notifOn(el.dataset.notif);
  });
  back.querySelectorAll("[data-notif]").forEach((el) => {
    el.onchange = () => setNotif(el.dataset.notif, el.checked);
  });
  back.querySelectorAll("[data-sound]").forEach((el) => {
    el.onchange = () => {
      setSoundPref(el.dataset.sound, el.checked);
      // Play the thing being switched on, so the tick is its own confirmation. Switching music on
      // is otherwise silent for up to a second, which reads as a control that did nothing.
      if (el.checked && el.dataset.sound === "sfxOn") Audio.play("gain");
    };
  });
  back.querySelectorAll("[data-tick]").forEach((b) => b.onclick = () => {
    P.ui = P.ui || {};
    P.ui.tickMs = Number(b.dataset.tick);
    startLogicTimer();
    applyGraphicsPrefs();
    save("ตั้งค่าอัตราอัปเดต");
    back.remove();
    openSettings();            // reopen so the selected button shows as selected
  });
  back.querySelectorAll("[data-gfx]").forEach((el) => {
    el.onchange = () => {
      P.ui = P.ui || {};
      P.ui[el.dataset.gfx] = el.checked;
      applyGraphicsPrefs();          // takes effect behind the open panel, so the switch shows its own result
      save("ตั้งค่ากราฟิก");
    };
  });
  back.querySelectorAll("[data-lang]").forEach((b) => b.onclick = () => {
    setLang(b.dataset.lang);
    back.remove();
    openSettings();          // reopen so the panel itself is in the new language
  });
  back.querySelectorAll("[data-notif-all]").forEach((b) => b.onclick = () => {
    for (const n of NOTIF_KINDS) setNotif(n.id, b.dataset.notifAll === "on");
    sync();
  });
  /* The status line is a live reading, so it has to keep reading while the panel is open — the
     retry it describes usually fires from the very touch that opened this panel. Self-cancels when
     the node goes, so closing needs no teardown. */
  const awakeTick = setInterval(() => {
    const cell = back.querySelector(".awake-state");
    if (!cell || !document.body.contains(back)) { clearInterval(awakeTick); return; }
    cell.textContent = `${T("สถานะตอนนี้")}: ${wakeLockStatusText()}`;
  }, 1000);
  const close = () => { save("ตั้งค่า"); back.remove(); };
  back.querySelector("[data-close]").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}

function openSellDialog(id) {
  const have = P.inv[id] || 0;
  if (!have) return;
  const item = ITEMS[id];
  const locked = reservedCount(id);
  const sellable = sellableCount(id);
  if (!sellable) {
    toast(`${item.icon} ${item.name} สวมใส่อยู่ทั้งหมด — ถอดออกก่อนถึงจะขายได้`, "warn");
    return;
  }

  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">${item.icon} ขาย ${escapeHtml(item.name)}</div>
      <div class="modal-sub">มีอยู่ ${have} ชิ้น · ชิ้นละ ${item.sell} 💰
        ${locked ? `<br><span class="locked-note">🔒 ล็อกไว้ ${locked} ชิ้น (สวมใส่อยู่) — ขายได้สูงสุด ${sellable}</span>` : ""}</div>
      <div class="modal-qty">
        <button class="btn ghost small" data-q="1">1</button>
        <button class="btn ghost small" data-q="10">10</button>
        <button class="btn ghost small" data-q="${Math.floor(sellable / 2)}">ครึ่ง (${Math.floor(sellable / 2)})</button>
        <button class="btn ghost small" data-q="${sellable}">ทั้งหมด (${sellable})</button>
      </div>
      <input class="modal-input" id="sell-n" type="number" min="1" max="${sellable}" value="${sellable}">
      <div class="modal-total" id="sell-total"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="sell-cancel">${T("ยกเลิก")}</button>
        <button class="btn" id="sell-ok">${T("ยืนยันขาย")}</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const input = back.querySelector("#sell-n");
  const total = back.querySelector("#sell-total");
  const clamp = () => Math.max(1, Math.min(sellable, Math.floor(Number(input.value) || 1)));
  const refresh = () => {
    const n = clamp();
    total.textContent = `ขาย ${n} ชิ้น → ได้ ${(n * item.sell).toLocaleString()} 💰`;
  };
  input.oninput = refresh;
  refresh();
  input.focus();
  input.select();

  back.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
    input.value = Math.max(1, Number(b.dataset.q));
    refresh();
  });
  const close = () => back.remove();
  back.querySelector("#sell-cancel").onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.querySelector("#sell-ok").onclick = () => { doSell(id, clamp()); close(); };
  input.onkeydown = (e) => {
    if (e.key === "Enter") { doSell(id, clamp()); close(); }
    if (e.key === "Escape") close();
  };
}

function doSell(id, n) {
  const sellable = sellableCount(id);
  n = Math.max(0, Math.min(sellable, n));
  if (!n) return;
  P.inv[id] = (P.inv[id] || 0) - n;
  /* A trader's daughter who likes you gets you a better price. Rounded once, at the total, so a
   * hundred single sales and one sale of a hundred pay the same. */
  const paid = Math.round(n * ITEMS[id].sell * (1 + relBonusTotal("sellPrice") + childBonusTotal("sellPrice")));
  P.gold += paid;
  bump("goldEarned", paid);
  // Only the food slot can still empty out this way; gear copies are reserved above.
  if ((P.inv[id] || 0) === 0) P.food = P.food.map((f) => (f === id ? null : f));
  toast(`ขาย ${ITEMS[id].icon} ${ITEMS[id].name} ×${n} ได้ ${(n * ITEMS[id].sell).toLocaleString()} 💰`);
  renderInventory();
  refreshSidebar();
  if (view.kind !== "combat" || combatSlot() < 0) renderView();
}

/* ---------- Toasts ---------- */

/* Notification categories.
 *
 * 🎯 [owner, 2026-08-17] "มันขึ้นรัวๆ ทำให้เริ่มสับสน" — with daily dividends and per-action loot
 * the toast strip had become a scrolling log. These are the families that repeat on their own
 * during normal play, so they are the ones worth muting. Everything NOT tagged stays on always:
 * that is direct feedback to something the player just clicked, plus every warning, defeat and
 * failure — muting those would hide the game breaking. */
const NOTIF_KINDS = [
  { id: "kill",   icon: "⚔️", name: "ล้มมอนสเตอร์และของที่ดรอป", note: "ทุกตัวที่ล้มได้ รวมถึงตอนคุณและสัตว์เลี้ยงกินอาหาร (บอสยังขึ้นเสมอ)" },
  { id: "gain",   icon: "🎁", name: "ของและ XP จากงาน",   note: "ตัดไม้ ขุด ตกปลา ปลูกผัก คราฟต์ ย่องเก็บของ และของหายาก" },
  { id: "level",  icon: "🎉", name: "เลเวลอัพ / ขั้นชำนาญ", note: "เลเวลสายอาชีพ สเตตัสการล่า และขั้นชำนาญ" },
  /* 🎯 [owner 2026-08-23] "เพิ่มหัวข้อ ปิดรายได้ ค่าเช่าและปันผล ทำเป็นหัวข้อเดียวกัน" — money
     bundled the income that arrives on its own with the feedback from a button you just pressed, so
     silencing the daily drip also silenced the confirmation that a sale went through. Split: the
     passive stream is its own switch, money keeps what you did on purpose. */
  { id: "income", icon: "💰", name: "รายได้ที่เข้าเอง",     note: "ค่าเช่าอสังหาและปันผลรายวัน — เข้าทุกวันในเกมโดยไม่ต้องกด" },
  { id: "money",  icon: "📈", name: "การซื้อขายและภาษี",    note: "ซื้อ-ขายหุ้น อสังหา ร้านค้า และการหักภาษี" },
  { id: "combat", icon: "⚔️", name: "รายละเอียดการต่อสู้",  note: "เกราะแตก โหมดคลั่ง สัตว์เลี้ยงหมดแรง" },
  { id: "trader", icon: "🧙", name: "พ่อค้าเร่",            note: "ตอนมาตั้งแผง ตอนเก็บแผง และตอนซื้อของจากแผง" },
  { id: "guild",  icon: "🏹", name: "สถาบันฮันเตอร์",      note: "ทีมกลับถึงสถาบัน รับของอัตโนมัติ บาดเจ็บ และรับเด็กเข้าสังกัด" },
  { id: "family", icon: "👨‍👩‍👧", name: "ครอบครัว",           note: "ลูกเกิด ลูกโตพอออกผจญภัย การเรียน และค่าเลี้ยงดูรายวัน" },
  /* 🎯 [owner 2026-08-23] "notis ในตั้งค่ามันแยกเป็นสองหัวข้อ ... ปรับให้เหลือหัวข้อเดียว" — was
     two switches for one daily line. Still split off ครอบครัว, which is the one-off news: a birth
     and a coming of age should survive muting the daily traffic. */
  { id: "kidwork",  icon: "🗡️", name: "ลูกออกทำงาน", note: "สรุปรายวัน — ออกล่าและ event หาของ ได้เงินและของเท่าไหร่" },
  { id: "quest",  icon: "📜", name: "งานจากลานหมู่บ้าน",   note: "ตอนส่งงานสำเร็จและได้ค่าจ้าง" },
  { id: "save",   icon: "💾", name: "แจ้งว่าเซฟแล้ว",       note: "เซฟอัตโนมัติทุก 10 นาที (เซฟไม่สำเร็จจะเตือนเสมอ)" },
];
function notifOn(cat) {
  if (!cat) return true;                       // untagged = always shown
  const n = P?.ui?.notif;
  return !n || n[cat] !== false;               // default on, including for a profile with no prefs
}

/* Which sound a toast makes. Mapped here rather than at each call site so a message added later
 * gets a sound for free — and, more to the point, cannot get the WRONG one by being copied from a
 * neighbouring call. `kind` already carries the severity the toast is styled by, so the sound and
 * the colour cannot disagree. */
const TOAST_SFX = { levelup: "levelup", warn: "warn" };
const TOAST_CAT_SFX = { money: "money", save: "tap" };

function toast(text, kind = "", cat = "") {
  if (!notifOn(cat)) return;
  if (typeof Audio !== "undefined" && Audio.play) {
    Audio.play(TOAST_SFX[kind] || TOAST_CAT_SFX[cat] || "gain");
  }
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 5) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), 3200);
}

/* ---------- Boot ---------- */

// The bag toggles: pressing it again goes back to where you were, so checking stock mid-job
// does not cost you your place.
let bagReturnView = null;
if ($("#bag-chip")) $("#bag-chip").onclick = () => {
  if (view.kind === "bag") { view = bagReturnView || { kind: "skill", skillId: "wc" }; }
  else { bagReturnView = { ...view }; view = { kind: "bag" }; }
  renderView();
};
// Guarded: React renders these now, and calls the same actions through window.__game.
if ($("#pause-chip")) $("#pause-chip").onclick = () => setPaused(!paused);
if ($("#settings-chip")) $("#settings-chip").onclick = () => openSettings();

/* 🎯 [added 2026-08-19] Phone drawer. Everything here is a no-op on desktop, where CSS keeps the
 * sidebar in the flow and hides both the button and the backdrop — so there is no second layout to
 * keep in sync, only a class the narrow-screen rules react to. */
function setSidebarOpen(on) {
  const bar = $("#sidebar"), back = $("#sidebar-backdrop"), chip = $("#menu-chip");
  if (!bar) return;
  bar.classList.toggle("open", on);
  if (back) back.classList.toggle("open", on);
  if (chip) chip.setAttribute("aria-expanded", on ? "true" : "false");
}
if ($("#menu-chip")) {
  $("#menu-chip").onclick = () => setSidebarOpen(!$("#sidebar").classList.contains("open"));
}
if ($("#sidebar-backdrop")) $("#sidebar-backdrop").onclick = () => setSidebarOpen(false);
/* Picking a tab should get out of the way — the drawer covers the very view being opened.
 * Delegated on the container because buildSidebar() replaces every tab on each profile load. */
if ($("#skill-tabs")) $("#skill-tabs").addEventListener("click", () => setSidebarOpen(false));
// Space toggles pause, unless the player is typing a profile name or a deposit amount.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.target.tagName === "INPUT") return;
  e.preventDefault();
  setPaused(!paused);
});
$("#btn-save").onclick = () => save("กดเอง");
$("#btn-exit").onclick = exitToProfiles;
show("#screen-profiles");
/* The subtitle names the cap, which is the one number a player needs before deciding whether to
 * close the tab. It used to be swapped in only for the phone build, because the feature was
 * phone-only; both are universal now, so the line is simply written once in index.html. */

// Pick the backend first: renderProfiles reads slots, and reading the wrong store would show
// empty slots over a perfectly good save folder.
/* Language before storage: the profile screen is the first thing drawn, and it has text on it. */
initLang();
initStorage().then(renderProfiles);
