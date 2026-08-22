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
 *   "server" — server.py is running, so saves are files in game/saves/. This is the good case:
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
  TITLES_SPECIAL, ACHIEVEMENTS, ARMOR_SETS, SLAYER_TIERS, SLAYER_REWARDS, ELITE_MODES,
  COMBAT_STATS, AUTO_EAT_OPTIONS, PET_SPECIES, PET_GRADES, COMPANY_SIZES, COMPANIES,
  SHOP_TYPES, SHOP_TIERS, STAFF_ROLES, PROPERTIES, FURNITURE, TAX_KINDS, AUTO_CATEGORIES,
  GUILD_TIERS, GUILD_RANKS, NOTIF_KINDS,
];

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
      console.log("[save] เก็บลงโฟลเดอร์:", info?.saveDir || "game/saves/");
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
 * FILE, the obvious way to restore one is to drop it into game/saves/ — but the profile screen
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
    // from game/saves/backups/ rather than gone.
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
 * and P.spouse, which is a villager id or null.
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
function relBonusOf(id) {
  const spec = REL_BONUS[id];
  if (!spec) return null;
  const st = relStage(relOf(id).aff);
  if (!st.bonus) return null;
  return { ...spec, amount: spec.amount * st.bonus, stage: st };
}

/* Every relationship bonus of one kind, summed. Called from the systems themselves so a new
 * villager cannot be added without their bonus reaching the thing it claims to affect. */
function relBonusTotal(kind) {
  let total = 0;
  for (const v of VILLAGERS) {
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
  if ((v.likes || []).some((tag) => itemId.includes(tag))) return REL_GIFT_LOVED;
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

function canPropose(id) {
  return !P.spouse && relStage(relOf(id).aff).id === "lover" && !!REL_BONUS[id];
}

function propose(id) {
  if (!canPropose(id)) return false;
  const r = relOf(id);
  r.aff = Math.max(r.aff, REL_STAGES[REL_STAGES.length - 1].at);
  P.spouse = id;
  const v = VILLAGERS.find((x) => x.id === id);
  toast(`💍 ${v.icon} ${v.name} ตอบตกลง!`, "levelup", "quest");
  save("แต่งงาน");
  return true;
}

/* What rebirth does. The owner's rule: halve the affection, roll back the marriage, and never drop
 * below the floor a previous life reached — the same shape as rebirthFloor for combat stats, so
 * each life courts the same person faster than the last. */
function relRebirth() {
  for (const id of Object.keys(P.rel || {})) {
    const r = P.rel[id];
    const halved = Math.floor((r.aff || 0) * REL_REBIRTH_MULT);
    r.floor = Math.max(r.floor || 0, halved);
    r.aff = Math.max(r.floor, halved);
    r.gaveDay = -1;
  }
  P.spouse = null;
}

/* ---------- 👶 ลูก ----------
 * See the CHILD_* note in data.js. State lives on P.kids: [{ id, name, bornDay, age, stats, edu }].
 *
 * `age` is an absolute counter incremented by onNewDay, NOT derived from bornDay — doRebirth sets
 * P.gameDays back to 0, so any age computed from the calendar would jump backwards the first time
 * the player rebirths, and would do it silently.
 */
const CHILD_NAMES = ["อาริน", "นารา", "เคนจิ", "ลิลลี่", "ทาโร่", "มินะ", "โซอี้", "ยูกิ"];

function childrenOf() { P.kids = P.kids || []; return P.kids; }

function childIsAdult(k) { return (k.age || 0) >= CHILD_ADULT_DAY; }

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
function childBirthRoll() {
  if (!P.spouse) return;
  const kids = childrenOf();
  if (kids.length >= CHILD_MAX) return;
  if (Math.random() >= CHILD_BIRTH_CHANCE) return;
  const used = new Set(kids.map((k) => k.name));
  const name = CHILD_NAMES.find((n) => !used.has(n)) || `ลูกคนที่ ${kids.length + 1}`;
  const spouse = VILLAGERS.find((v) => v.id === P.spouse);
  kids.push({ id: `k${questDay()}_${kids.length}`, name, bornDay: questDay(), age: 0,
              parent: P.spouse, stats: newChildStats(), edu: {} });
  toast(`👶 ${name} เกิดแล้ว! ลูกของคุณกับ${spouse ? spouse.name : "คู่ชีวิต"}`, "levelup", "family");
  save("ลูกเกิด");
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
function childrenRebirth() { P.kids = []; }

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
 * A special title outranks the counted one: it says something the number cannot, and a player who
 * has cleared every slayer mark should not read as "นักเดินทางผู้ช่ำชอง" like everyone else on six. */
function titleFor(p = P) {
  if (!p) return null;
  const pr = achievementProgress();
  const ach = p.achieved || {};
  for (const s of TITLES_SPECIAL) {
    try {
      if (s.test(pr, ach, p, baneCount(p))) return { name: s.name, icon: s.icon, special: true, desc: s.desc, done: pr.done };
    } catch (e) { /* a broken test must not cost the player their name */ }
  }
  const tier = TITLES.find((x) => pr.done >= x.at) || TITLES[TITLES.length - 1];
  return { name: tier.name, icon: tier.icon, special: false, at: tier.at, done: pr.done };
}

/* What it takes to reach the next counted tier, for the achievements page. Null once the top is
 * held — "อีก 0 รายการ" reads as a bug rather than as a finished set. */
function nextTitle(p = P) {
  const done = achievementProgress().done;
  const higher = TITLES.filter((x) => x.at > done).sort((a, b) => a.at - b.at)[0];
  return higher ? { ...higher, need: higher.at - done } : null;
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
        แล้วเซฟจะไปอยู่ในโฟลเดอร์ <code>game/saves/</code> แทน ไม่ต้องพึ่งเบราว์เซอร์เลย<br><br>
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
    where.style.display = saveBackend === "server" ? "block" : "none";
    // 🐛 [fixed 2026-08-18] This used to `return` here, which skipped every handler-attachment
    // call below (data-create/data-play/data-import/...) entirely. On a genuinely empty
    // game/saves/ — a brand-new install before the first-ever profile, or any time both slots
    // are wiped for a fresh restart — !anySave is true, so this branch ran and every button on
    // the profile screen was silently dead: "สร้างโปรไฟล์" did nothing, forever, with no error.
    if (saveBackend === "server" && !anySave) {
      where.innerHTML = `📁 ยังไม่มีไฟล์เซฟใน <code>game/saves/</code><br>
        <span class="dim">ถ้าเคยเล่นค้างไว้แล้วไม่เห็นตรงนี้ แปลว่าเซฟนั้นอยู่ในเบราว์เซอร์ของ
        <b>${T("ที่อยู่อื่น")}</b> — เซฟผูกกับที่อยู่ที่เปิด และหน้านี้อ่านข้ามที่อยู่ไม่ได้<br>
        ให้เปิดเกมแบบเดิมที่เคยเล่น (ดับเบิลคลิก <code>game/index.html</code>) ในเบราว์เซอร์ตัวเดิม
        กด <b>⬇️ ส่งออกเซฟ</b> แล้วก๊อปไฟล์นั้นมาวางใน <code>game/saves/</code> —
        ชื่อไฟล์อะไรก็ได้ เดี๋ยวระบบรับเข้าช่องให้เอง</span>`;
    } else if (saveBackend === "server") {
      where.innerHTML = `📁 เซฟเก็บเป็นไฟล์ใน <code>game/saves/</code> — คัดลอก สำรอง หรือย้ายเครื่องได้เหมือนไฟล์ทั่วไป
        <span class="dim">(สำรองอัตโนมัติทุกครั้งที่เขียนทับ เก็บไว้ใน <code>saves/backups/</code>)</span><br>
        <span class="dim">${T("จะนำเข้าด้วยปุ่มก็ได้ หรือก๊อปไฟล์ไปวางเป็น ")}<code>game/saves/slot1.json</code>
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

  const slot0 = (P.slots || []).find((sl) => sl && sl.type === "skill");
  if (!slot0) return null;               // nothing was running — closing the app is not income

  const skill = findSkill(slot0.skillId);
  const action = findAction(skill, slot0.actionId);
  if (!skill || !action) return null;

  const capMs = OFFLINE_CAP_HOURS * 3600 * 1000;
  const cappedMs = Math.min(awayMs, capMs);
  const seconds = cappedMs / 1000 * OFFLINE_RATE;
  const per = effectiveSeconds(slot0.skillId, action);
  let cycles = Math.floor(seconds / per);
  if (cycles <= 0) return null;

  const made = {};
  let gold = 0, xp = 0, ran = 0, ranOut = false;
  const beforeLvl = levelFromXp(P.xp[slot0.skillId] || 0);
  for (let i = 0; i < cycles; i++) {
    if (action.inputs) {
      // Out of materials is a real stop, exactly as skillTick would have stopped — offline must not
      // conjure inputs the player never had.
      if (!canAfford(action)) { ranOut = true; break; }
      for (const [id, n] of Object.entries(action.inputs)) P.inv[id] -= n;
    }
    if (action.steal) {
      /* Expected value, not a per-cycle roll. Thousands of unwatched coin flips would land on the
       * average anyway, and a visible number the player cannot verify should not also be random. */
      const st = action.steal;
      const mLvl = masteryLevelOf(slot0.skillId, slot0.actionId);
      const chance = Math.min(0.95, st.success + 0.004 * (mLvl - 1));
      gold += (st.gold[0] + st.gold[1]) / 2 * chance;
    }
    if (action.catch) {
      // A catch table yields one of several species; offline credits the most common one rather
      // than rolling, for the same reason as above.
      const table = effectiveCatch(slot0.skillId, action);
      const top = table.reduce((a, b) => (b.w > a.w ? b : a), table[0]);
      P.inv[top.item] = (P.inv[top.item] || 0) + 1;
      made[top.item] = (made[top.item] || 0) + 1;
    } else {
      for (const [id, n] of Object.entries(action.outputs || {})) {
        P.inv[id] = (P.inv[id] || 0) + n;
        made[id] = (made[id] || 0) + n;
      }
    }
    xp += action.xp;
    ran++;
  }
  if (!ran) return null;

  gold = Math.round(gold * (1 + charmValue("gold") + perkTotal("goldBonus")));
  P.gold += gold;
  P.xp[slot0.skillId] = (P.xp[slot0.skillId] || 0) + Math.ceil(xp * (1 + tomeBonus(slot0.skillId)));
  /* 🎯 [owner 2026-08-21] "ความชำนาญไม่ขึ้น" — no mastery offline, deliberately.
   * Mastery is the thing that makes a job permanently faster and its drops better. Items are what
   * you were away from; mastery is what you were there for. This used to grant xp * 0.6 and that
   * was the one line separating "the game keeps ticking" from "there is no reason to open it". */
  if (gold) bump("goldEarned", gold);
  bump(action.steal ? "steals" : "actions", ran);

  const cash = offlineCashflow(seconds);

  return {
    action, skill, cycles: ran, gold, made, ranOut, cash,
    rate: OFFLINE_RATE,
    awayMs, cappedMs, capped: awayMs > capMs,
    levelsGained: levelFromXp(P.xp[slot0.skillId]) - beforeLvl,
  };
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
  if (days <= 0) return { shops: 0, div: 0, days };

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
    }
  }

  return { shops, div, days };
}

function openOfflinePopup(r) {
  if (!r) return;
  const hrs = r.awayMs / 3600000;
  const away = hrs >= 1 ? `${hrs.toFixed(1)} ชั่วโมง` : `${Math.round(r.awayMs / 60000)} นาที`;
  const items = Object.entries(r.made)
    .map(([id, n]) => `${ITEMS[id].icon} ${escapeHtml(ITEMS[id].name)} ×${n.toLocaleString()}`)
    .join(" · ");
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">🌙 ระหว่างที่ไม่อยู่</div>
      <div class="modal-sub">
        หายไป <b>${away}</b>${r.capped
          ? ` — คิดให้สูงสุด ${OFFLINE_CAP_HOURS} ชั่วโมง` : ""}<br>
        <b>${escapeHtml(r.skill.name)} · ${escapeHtml(r.action.name)}</b>
        ทำไป <b>${r.cycles.toLocaleString()}</b> รอบ
        <div class="offline-lines">
          ${r.gold ? `<div>💰 ได้ทอง <b class="good">${fmtNum(r.gold)}</b></div>` : ""}
          ${items ? `<div>🎒 ${items}</div>` : ""}
          ${r.levelsGained > 0
            ? `<div>🎉 ${escapeHtml(r.skill.name)} ขึ้น <b class="good">${r.levelsGained}</b> เลเวล</div>` : ""}
            ${r.cash && r.cash.shops ? `<div>🏪 ${r.cash.shops > 0 ? "รายได้ร้านค้า" : "ขาดทุนร้านค้า"} <b class="${r.cash.shops > 0 ? "good" : "rb-warn"}">${fmtNum(Math.abs(r.cash.shops))}</b></div>` : ""}
            ${r.cash && r.cash.div ? `<div>📈 ปันผลจากหุ้น <b class="good">${fmtNum(r.cash.div)}</b></div>` : ""}
            ${/* 🎯 [owner] "มันไม่มีแจ้งว่าควรได้เงินเท่าไหร่ 30%" — say the arithmetic, not just the
                 result. Without this the number is unverifiable: a player has no way to tell a
                 correct 30% from a wrong one, and the whole feature is a promise about a fraction. */ ""}
            ${r.cash && (r.cash.shops || r.cash.div) ? `<div class="dim">— คิดจาก ${r.cash.days.toFixed(1)} วันในเกม ที่ ${Math.round(r.rate * 100)}% ของอัตราปกติ</div>` : ""}
          ${r.ranOut ? `<div class="rb-warn">⚠️ วัตถุดิบหมดก่อน งานเลยหยุดกลางทาง</div>` : ""}
        </div>
        <span class="dim">ตอนไม่อยู่ได้ ${Math.round(OFFLINE_RATE * 100)}% ของการเล่นเอง 
            — ปฏิทินไม่เดิน ความชำนาญไม่ขึ้น แปลงปลูกไม่โต และการล่ามอนสเตอร์ไม่เดินต่อ</span>
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
  refreshWakeLock();
  buildSidebar();
  renderView();
  renderInventory();
  updateSaveLabel();
  openIntroPopup();
  if (offline) openOfflinePopup(offline);

  clearInterval(logicTimer);
  logicTimer = setInterval(tick, 250);
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => save("อัตโนมัติ"), AUTOSAVE_MINUTES * 60 * 1000);

  clearInterval(presenceTimer);
  if (n === 1) {
    sendPresence(document.visibilityState === "visible" && !paused);
    presenceTimer = setInterval(
      () => sendPresence(document.visibilityState === "visible" && !paused), 4000);
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
  if (ART_MISSING.has(key)) return null;
  const v = ART_STAMP ? `?v=${ART_STAMP}` : "";
  return `<img class="art ${cls || ""}" src="art/${key}.jpg${v}" alt="${escapeHtml(alt)}" loading="lazy"
    onerror="markArtMissing('${key}', this)">`;
}
/* Called from the img's own onerror — drops the element and remembers not to try again. */
window.markArtMissing = (key, el) => {
  ART_MISSING.add(key);
  const holder = el.parentElement;
  el.remove();
  if (holder) holder.classList.add("no-art");
};

/* An icon slot that prefers art and falls back to the emoji underneath it. */
function iconArt(kind, id, emoji, alt, cls) {
  const img = artImg(kind, id, alt, cls);
  return `<span class="icon-art">${img || ""}<span class="icon-glyph">${emoji}</span></span>`;
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
  return { lv, name: sp.name, icon: sp.icon, tier: sp.tier, grade: petGrade(iv),
           maxHp: Math.round(petStat(sp.hp, lv) * iv.hp),
           atk: Math.max(1, Math.round(petStat(sp.atk, lv) * iv.atk)),
           def: Math.round(petStat(sp.def, lv) * iv.def) };
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
  const roll = () => Math.round(rand(PET_IV_MIN, PET_IV_MAX) * 100) / 100;
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
 * Design and balance: game/pet_fusion_sim.mjs (15 checks) — this is the same arithmetic wired to a
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
    grade: ga, upCls, upName, chance: upCls ? PET_FUSION_GRADE_UP : 0,
    sameSpecies: a.species === b.species,
    levelAvg: (petLevelExact(a) + petLevelExact(b)) / 2,
  };
}
function petFuse(iA, iB) {
  const f = petFusionForecast(iA, iB);
  if (!f) { toast("ผสมพันธุ์ได้เฉพาะคุณภาพเดียวกัน", "warn"); return false; }
  const a = P.pets[iA], b = P.pets[iB];

  const graded = f.upCls && Math.random() < PET_FUSION_GRADE_UP ? f.upCls : f.grade.cls;
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
  toast(`🧬 ผสมพันธุ์สำเร็จ! ได้ ${st.icon} ${st.name} ขั้น ${st.lv} คุณภาพ ${st.grade.name} (${st.grade.pct}%)`
    + (upgraded ? " — เลื่อนขั้นคุณภาพสำเร็จ!" : ""), "levelup");
  return true;
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

/* Feeds the companion from the SAME provision slots the player packs. */
function petEat() {
  const pet = petReady();
  if (!pet) return false;
  const st = petStats(pet);
  if (pet.hp >= st.maxHp) return false;
  const idx = nextFoodSlot();
  if (idx < 0) return false;
  const id = P.food[idx];
  P.inv[id] -= 1;
  pet.hp = Math.min(st.maxHp, pet.hp + ITEMS[id].heal);
  toast(`${st.icon} ${st.name} กิน ${ITEMS[id].icon} ${ITEMS[id].name} (+${ITEMS[id].heal} HP)`);
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

function calendarTick(dtSeconds) {
  const before = today();
  P.gameDays += dtSeconds / GAME_DAY_SECONDS;
  const after = today();
  if (after.totalDays === before.totalDays) return;
  for (let d = before.totalDays + 1; d <= after.totalDays; d++) onNewDay(gameDate(d), d);
  updateTopbar();
}

/* One game day passed. Kept deliberately small: each subsystem gets its own function so a new
 * scheduled system is one line here rather than a branch buried in tick(). */
function onNewDay(date) {
  bankAccrue(date);
  marketTick(date);
  payDividends(date);
  runShopsDay(date);
  runEstatesDay();
  runGuildDay();
  refreshQuests(questDay());
  childrenAgeDay();
  childBirthRoll();
  /* 🐛 [found by game-playtester, 2026-08-18] taxEnforce's own docstring says "Runs every game-day"
   * and the tax page shows the late fee as a per-day rate ("ค่าปรับวันละ 0.4%"), but this used to be
   * called from a monthly wrapper that only ran on day 1 of each month — so a seized business accrued
   * its "daily" late fee at 1/30th the advertised speed, and the toast the owner asked for ("daily
   * late-fee deductions with notifications") fired once a month instead of daily. */
  taxEnforce(date);
  taxDebtCheck();
  if (date.day === 1 && date.month === 1) onNewYear(date);
  else if (date.day === 1) onNewMonth(date);
  if (view.kind === "bank") renderView();
}

function onNewMonth(date) {
}

function onNewYear(date) {
  bankTidySlips();
  toast(`🎆 ขึ้นปีใหม่ — ปีที่ ${date.year} ของมิธวูด`, "levelup");
  settleTaxYear(date);
}


/* ---------- 🏹 สถาบันฮันเตอร์ (Hunter Guild) ----------
 * Design note: game/HUNTER_GUILD.md. Model and balance: game/guild_sim.mjs (38 checks), which owns
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
function guildTargets() {
  return LOCATIONS.slice(0, guildTier().zones).flatMap((loc, li) =>
    loc.stages.map((st, si) => ({ loc, st, key: `${loc.id}:${si}`, li, si })).filter((x) => !x.st.boss));
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
  if (view.kind === "guild") renderView();
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
  if (Math.floor(P.gold) < tier.cost) { toast("ทองไม่พอสร้างสถาบัน", "warn"); return false; }
  P.gold -= tier.cost;
  P.guild = {
    tier: 1, roster: [], squads: [], applicants: [], applicantDay: -999,
    upkeep: { food: 1, gear: 1, med: 0, train: 1 },
    pending: { gold: 0, items: {}, rounds: 0 }, autoCollect: false,
  };
  ledger("🏹", `สร้าง${tier.name}`, -tier.cost);
  toast(`🏹 สร้าง${tier.name}แล้ว — รับเด็กเข้ามาได้ ${tier.beds} คน`, "levelup");
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
 * The whole model lives in game/shop_sim.mjs, which tunes and asserts it (56 checks). This is the
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
  if (Math.abs(total) >= 1) {
    toast(`${total >= 0 ? "🏪 กำไรร้านค้า" : "🏪 ขาดทุนร้านค้า"} ${Math.abs(Math.round(total)).toLocaleString()} 💰`,
          total >= 0 ? "" : "warn", "money");
  }
  if (view.kind === "shops") renderView();
}

/* ---------- Rebirth (จุติ) ----------
 * Keeps achievements, keeps the whole bag, halves the three combat stats — and never drops a
 * stat below what the PREVIOUS rebirth left behind (owner's rule: a quick rebirth that would
 * compute a lower number keeps the last rebirth's value instead). That floor only ever rises,
 * so rebirthing early can waste progress but can never set you back. */

function rebirthPreview() {
  const out = {};
  for (const st of COMBAT_STATS) {
    const cur = statLevel(st.id);
    /* Halve the level WITH its progress, not the whole number — level 33 becomes 16 and a half,
     * not a bare 16. `halved` stays the displayed integer; `xpAfter` is what actually gets stored,
     * and it is the only place the leftover survives. */
    const exactAfter = levelExactFromXp(P.cb[st.id] || 0) / 2;
    const halved = Math.floor(exactAfter);
    const floor = (P.rebirthFloor || {})[st.id] || 1;
    const after = Math.max(1, halved, floor);
    out[st.id] = { cur, halved, floor, after, floored: floor > halved,
                   /* A floor that lifts the level also lifts the XP to that level's start: the
                    * leftover belongs to the halved figure, not to a number handed back by the
                    * floor rule. */
                   xpAfter: after > halved ? xpToReach(after) : xpAtExactLevel(exactAfter) };
  }
  return out;
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
  return `ยืนยันการจุติ?\n\n${after}${pets}${atRisk}`
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
  /* 🐛 [fixed 2026-08-17, owner: "ยอดกำไรสุทธิ ผิด"] The calendar restarts here but the tax
   * accumulator did not, so "กำไรลงทุนปีที่ 1" showed a figure earned in a life that no longer
   * exists — and the next year-end would bill it against the savings, which is the one thing
   * rebirth lets you keep. The gold and shares that profit was made on are confiscated a few lines
   * below; taxing their gains afterwards charges twice for the same run. New calendar, new ledger.
   * A debt already owed is NOT cleared — that is the grace period above, and it still stands. */
  if (P.tax) { P.tax.yearProfit = 0; P.tax.lastBill = null; }
  if (P.bank) P.bank.yearInterest = 0;   // the year it belonged to no longer exists
  /* Staff keep the seniority and loyalty they earned — the business did not start over. */
  for (const sh of P.shops || []) for (const w of sh.staff || []) w.hiredDay -= clockShift;
  /* The companion you were fielding comes with you if it earned the right to, and it is halved the
   * same way you are — a rebirth for it too, not a free ride. Everything else is released. */
  const keeper = petRebirthKeeper();
  const released = P.pets.length - (keeper ? 1 : 0);
  let keptPet = null;
  if (keeper) {
    const wasLv = petLevel(keeper);
    keeper.xp = petXpAtExact(petLevelExact(keeper) / 2);   // odd levels keep the leftover half
    keeper.hp = petStats(keeper).maxHp;   // read AFTER the xp change, or it heals to the old cap
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
  ledger("📈", `${T("ปันผล")} ${payers} ${T("กิจการ")}`, total);
  /* 🎯 [owner 2026-08-22] "เคยเจอมันขึ้นเป็นสิบไอคอนเลย" — this printed one icon and amount per
   * paying company, so a diversified portfolio produced a toast nobody could read on a phone. What
   * the message is for is the total and where it came from; the per-company breakdown is already
   * written to the bank ledger, where it can be read at leisure instead of for four seconds while
   * something else is happening. */
  toast(`📈 ${T("รับปันผล")} ${total.toLocaleString()} 💰 ${T("จาก")} ${payers} ${T("การลงทุน")}`,
        "", "money");
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
function taxBaseFor(kindId) {
  if (kindId === "wealth") return Math.max(0, Math.floor(P.gold || 0)) + Math.floor(bankBalance());
  if (kindId === "business") return Math.round(P.tax?.yearProfit || 0);
  if (kindId === "estate") {
    return (P.estates || []).reduce((t, es) => {
      const kind = estateKind(es.kind);
      return t + (kind ? kind.price : 0) + Math.round(es.spent || 0);
    }, 0);
  }
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
function taxRunningFor(kindId) {
  const full = taxOwedFor(kindId, taxBaseFor(kindId));
  return kindId === "business" ? full : Math.round(full * taxYearElapsed());
}
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
    const full = k.id === "business" ? taxOwedFor(k.id, base) : taxOwedFor(k.id, base);
    const amount = Math.max(0, full - taxPrepaid(k.id));
    if (amount <= 0) continue;
    P.tax.bills.push({ id: `${k.id}-${year}`, kind: k.id, year, base, amount, paid: 0,
                       assessedDay: Math.floor(P.gameDays) });
    raised.push(`${k.icon} ${amount.toLocaleString()}`);
  }
  P.tax.prepaid = {};   // a new year starts owing nothing and having paid nothing
  const profit = Math.round(P.tax.yearProfit || 0);
  P.tax.lastBill = { year, profit, bill: raised.length ? P.tax.bills.slice(-raised.length)
    .reduce((t, b) => t + b.amount, 0) : 0 };
  P.tax.yearProfit = 0;
  if (P.bank) P.bank.yearInterest = 0;
  if (!raised.length) {
    if (profit > 0) toast(`🧾 สรุปปีที่ ${year}: กำไรลงทุน ${profit.toLocaleString()} — ยังไม่ถึงเกณฑ์เสียภาษี`);
    return;
  }
  toast(`🧾 ประเมินภาษีปีที่ ${year} แล้ว: ${raised.join(" · ")} — ไปที่หน้าภาษีเพื่อชำระ`, "warn");
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
          + ` · หักค่าปรับล่าช้า ${took.toLocaleString()} 💰`, "warn", "money");
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
    if (a > b) renderView();
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
      toast(`🌟 ของหายาก! ${ITEMS[rare.item].icon} ${ITEMS[rare.item].name}`, "levelup");
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
  if (after > before || mAfter > mBefore || action.inputs) renderView();
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
    + `+${Math.round(ITEMS[foodId].heal * (1 + perkTotal("healBonus")))} HP (ช่อง ${idx + 1}, เหลือ ${left})`);
  if (!left && nextFoodSlot() >= 0) toast(`🍱 ช่อง ${idx + 1} หมด — สลับไปช่อง ${nextFoodSlot() + 1} อัตโนมัติ`);
  renderInventory();
  updateCombatPanel();
  updateTopbar();
  return true;
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
    C.pNext = now + PLAYER_ATTACK_INTERVAL * 1000;
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
    const heavy = ps.lv >= PET_SPECIAL_LEVEL && C.petHits % PET_SPECIAL_EVERY === 0;
    const pdmg = Math.max(1, Math.round(ps.atk * rand(0.7, 1.3) * armorMult()
      * (heavy ? PET_SPECIAL_MULT : 1)));
    C.monHp -= pdmg;
    C.petNext = now + petAttackInterval(ps.lv);
    hitFx("#f-mon", pdmg, "dmg-pet");
    if (heavy) toast(`${ps.icon} ${ps.name} ปล่อยท่าหนัก! ${pdmg} ดาเมจ`, "", "combat");
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
    C.mNext = now + stage.interval * 1000;

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
  if (after > before || P.kills[key] === KILLS_TO_UNLOCK_NEXT_STAGE) renderView();
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
      if (view.kind === "shop") renderView();
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
    note: P.spouse
      ? `${VILLAGERS.find((v) => v.id === P.spouse)?.name || "คู่ชีวิต"}${kidsN ? ` · ลูก ${kidsN} คน` : ""}`
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
      icon: ti.icon, name: ti.name, special: !!ti.special,
      title: ti.special
        ? `ฉายาพิเศษ — ${ti.desc}\nปลดความสำเร็จแล้ว ${ti.done} รายการ`
        : (() => { const nx = nextTitle();
                   return `ปลดความสำเร็จแล้ว ${ti.done} รายการ`
                        + (nx ? `\nอีก ${nx.need} รายการเป็น ${nx.icon} ${nx.name}` : "\nสูงสุดแล้ว"); })(),
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
        + (P.rebirths ? `\nจุติมาแล้ว ${P.rebirths} ครั้ง — เลเวลถูกหารครึ่ง แต่ของสวมใส่ เครื่องราง`
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
      waiting ? `เลเวล ${lvl} · (รอเก็บเกี่ยว)` : `เลเวล ${lvl}`;
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
    ct.querySelector("[data-lvl]").textContent = `เลเวล ${combatLevel()} · ฝึก${focus.icon}${statLevel(focus.id)}`;
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
      ? "ยังไม่ได้สร้าง"
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
      + (P.rebirths ? `\nจุติมาแล้ว ${P.rebirths} ครั้ง — เลเวลถูกหารครึ่ง แต่ของสวมใส่ เครื่องราง`
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
          <span class="q-have${ready ? " ok" : ""}">มี ${fmtNum(have)}/${q.qty}</span>
        </div>
        <div class="q-pay">💰 ${fmtNum(q.gold)} · ⚔️ ${fmtNum(q.xp)} XP</div>
        <div class="q-foot">
          <span class="q-left">${days(q) <= 1 ? "⏳ วันสุดท้าย" : `เหลือ ${days(q)} วัน`}</span>
          <button class="btn ${ready ? "primary" : ""}" data-quest="${q.id}">
            ${ready ? "ส่งงาน" : `ไปหาของ${allSources(q.item).length > 1 ? ` (${allSources(q.item).length} ทาง)` : ""}`}
          </button>
        </div>
      </div>`;
  }).join("") || `<div class="empty-note">ยังไม่มีงานบนกระดาน — พรุ่งนี้ค่อยมาดูใหม่</div>`;

  /* The people, under the board. Same screen on purpose: the quests are what brings you here, and
   * the relationship is what the quests are quietly building. */
  const people = VILLAGERS.map((v) => {
    const r = relOf(v.id);
    const st = relStage(r.aff);
    const next = REL_STAGES.find((s) => s.at > r.aff);
    const b = relBonusOf(v.id);
    const wed = P.spouse === v.id;
    const pct = next ? (r.aff - st.at) / (next.at - st.at) * 100 : 100;
    return `
      <div class="villager-card${wed ? " is-wed" : ""}">
        <div class="v-top">
          <span class="v-face">${iconArt("char", v.id, v.icon, v.name, "big")}</span>
          <span class="v-id">
            <b>${escapeHtml(v.name)}${wed ? " 💍" : ""}</b>
            <small>${escapeHtml(v.job)}</small>
          </span>
          <span class="v-stage">${escapeHtml(st.name)}</span>
        </div>
        <div class="v-track"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
        <div class="v-note">${next ? `อีก ${next.at - r.aff} เป็น${escapeHtml(next.name)}` : "สนิทที่สุดแล้ว"}
          ${r.floor > 0 ? ` · พื้นจากชาติก่อน ${r.floor}` : ""}</div>
        ${b ? `<div class="v-bonus">${escapeHtml(b.label)} +${b.kind === "dmg"
            ? Math.round(b.amount * 10) / 10
            : Math.round(b.amount * 100) + "%"}</div>`
            : `<div class="v-bonus muted">${v.romance ? "ยังไม่สนิทพอ" : "เพื่อนบ้าน — ไม่มีโบนัส"}</div>`}
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
        📜 ภารกิจเควส${readyN ? ` (${readyN})` : ""}</button>
      <button class="area-tab${villagePanel === "people" ? " active" : ""}" data-vpanel="people">
        💗 ความสัมพันธ์</button>
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
        }).join("") || `<div class="empty-note">กระเป๋าว่าง — ไปหาของก่อน</div>`}
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

  const spouse = P.spouse ? VILLAGERS.find((v) => v.id === P.spouse) : null;
  const kids = childrenOf();
  const pet = P.activePet != null ? P.pets[P.activePet] : null;

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

  const spouseCard = spouse ? `
    <div class="fam-card is-spouse">
      <div class="fam-face">${iconArt("char", spouse.id, spouse.icon, spouse.name, "big")}</div>
      <div class="fam-body">
        <b>💍 ${escapeHtml(spouse.name)}</b>
        <small>${escapeHtml(spouse.job)}</small>
        <div class="fam-note">${escapeHtml(REL_BONUS[spouse.id]?.label || "")}</div>
      </div>
    </div>` : `
    <div class="fam-card is-empty">
      <div class="fam-face">💗</div>
      <div class="fam-body"><b>${T("ยังไม่มีคู่ชีวิต")}</b>
        <small>${T("ไปสนิทกับใครสักคนที่ลานหมู่บ้านก่อน")}</small></div>
    </div>`;

  const petCard = pet ? (() => {
    const ps = petStats(pet);
    return `
    <div class="fam-card is-pet">
      <div class="fam-face">${iconArt("pet", pet.species, ps.icon, ps.name, "big")}</div>
      <div class="fam-body">
        <b>${escapeHtml(ps.name)}</b>
        <small>ตัวโปรด · ขั้น ${petLevel(pet)} · คุณภาพ ${escapeHtml(ps.grade?.name || "-")}</small>
        <div class="fam-row"><span>❤️ ${Math.max(0, Math.round(pet.hp))}/${ps.maxHp}</span>
          <span>🗡️ ${ps.atk}</span><span>🛡️ ${ps.def}</span></div>
      </div>
    </div>`;
  })() : `
    <div class="fam-card is-empty">
      <div class="fam-face">🐾</div>
      <div class="fam-body"><b>${T("ยังไม่มีเพื่อนร่วมทาง")}</b>
        <small>${T("จับสัตว์เลี้ยงได้จากการล่ามอนสเตอร์")}</small></div>
    </div>`;

  const kidCards = kids.map((k) => {
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
        <div class="fam-face">${adult ? "🧑" : "👶"}</div>
        <div class="fam-body">
          <b>${escapeHtml(k.name)}</b>
          <small>${adult ? "โตแล้ว — ออกผจญภัยเอง" : `อายุ ${k.age || 0}/${CHILD_ADULT_DAY} วัน`}</small>
          ${adult ? "" : `<div class="kid-track"><div style="width:${pct}%"></div></div>`}
          <div class="fam-row">${COMBAT_STATS.map((st) =>
            `<span>${st.icon} ${(k.stats || {})[st.id] || 1}</span>`).join("")}</div>
          <div class="edu-list">${tracks}</div>
        </div>
      </div>`;
  }).join("");

  const bonusLine = ["dmg", "sellPrice", "xpBonus"]
    .map((kind) => ({ kind, v: childBonusTotal(kind) })).filter((x) => x.v > 0)
    .map((x) => ({ dmg: `🗡️ +${Math.round(x.v * 10) / 10}`,
                   sellPrice: `🪙 +${Math.round(x.v * 100)}%`,
                   xpBonus: `⚒️ +${Math.round(x.v * 100)}%` }[x.kind])).join(" · ");

  $("#view-extra").innerHTML = `
    <div class="mastery-summary">
      <span class="m-chip">👨‍👩‍👧 ${1 + (spouse ? 1 : 0) + kids.length} ${T("คน")}</span>
      <span class="m-chip">🐾 ${T("สัตว์เลี้ยง")} ${P.pets.length}</span>
      ${bonusLine ? `<span class="m-chip">${T("โบนัสจากลูก")} ${bonusLine}</span>` : ""}
    </div>`;
  $("#action-grid").innerHTML =
    `<div class="fam-grid">${meCard}${spouseCard}${petCard}${kidCards}</div>`
    + (P.spouse && kids.length < CHILD_MAX
        ? `<div class="fam-hint">แต่งงานแล้ว — แต่ละวันมีโอกาส ${Math.round(CHILD_BIRTH_CHANCE * 100)}% ที่จะมีลูก</div>`
        : kids.length >= CHILD_MAX ? `<div class="fam-hint">ลูกครบ ${CHILD_MAX} คนแล้ว</div>` : "");

  $("#action-grid").querySelectorAll("[data-train]").forEach((b) => {
    b.onclick = () => { if (trainChild(b.dataset.train, b.dataset.track)) renderView(); };
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
  if (item.heal) bits.push(`❤️ฟื้น ${item.heal}`);
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
      return `<button class="area-tab${ar === shown ? " active" : ""}${open ? "" : " shut"}" data-area="${escapeHtml(ar)}">
        <span style="color:${skill.accent}">◆</span> ${escapeHtml(ar)}
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
  picker.innerHTML = `<div class="seed-head">🌱 เลือกเมล็ดที่จะปลูก</div>
    <div class="seed-list">${opts}</div>
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

  // --- seed stall ---
  const stallHead = document.createElement("div");
  stallHead.className = "area-head";
  stallHead.textContent = "🌱 แผงเมล็ดพันธุ์ — หรือจะไปล่ามอนสเตอร์เอาเมล็ดฟรีก็ได้";
  grid.appendChild(stallHead);
  for (const entry of SEED_SHOP) {
    const item = ITEMS[entry.item];
    const open = lvl >= entry.level;
    const card = document.createElement("div");
    card.className = "action-card seed-card" + (open ? "" : " locked");
    const where = sourceLabel(entry.item);
    card.innerHTML = `
      <div class="head"><div class="name">${item.icon} ${item.name}</div>
        <div class="req">${open ? `${entry.price.toLocaleString()} 💰` : `🔒 เลเวล ${entry.level}`}</div></div>
      <div class="detail">มีอยู่ ${P.inv[entry.item] || 0} เมล็ด${where ? ` · ดรอปจาก${escapeHtml(where)}` : ""}</div>
      ${open ? `<div class="seed-buy">
        <button data-buy="1">ซื้อ 1</button>
        <button data-buy="10">ซื้อ 10 (${(entry.price * 10).toLocaleString()} 💰)</button></div>` : ""}`;
    card.querySelectorAll("[data-buy]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      buySeed(entry.item, Number(b.dataset.buy));
    });
    grid.appendChild(card);
  }
  highlightAction = null;
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

function estimatedTaxNow() { return taxOwedOn(Math.round(P.tax?.yearProfit || 0)); }



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

function canPayCost(cost) {
  return Object.entries(cost).every(([id, n]) => sellableCount(id) >= n);
}
function payCost(cost) {
  for (const [id, n] of Object.entries(cost)) {
    P.inv[id] -= n;
    if (P.inv[id] <= 0) delete P.inv[id];
  }
}
function costText(cost) {
  return Object.entries(cost).map(([id, n]) =>
    `${ITEMS[id].icon} ${escapeHtml(ITEMS[id].name)} ${sellableCount(id)}/${n}`).join(" · ");
}

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
  /* Rent is not income-taxed either, for the same reason: the estate tax already charges the
   * property, and the rent it pays lands in the pocket where the wealth tax finds it. */
  if (Math.round(total) >= 1) toast(`🏘️ ค่าเช่า ${Math.round(total).toLocaleString()} 💰`, "", "money");
  if (view.kind === "shops") renderView();
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
    const capital = owned.reduce((t, es) => t + estateKind(es.kind).price, 0);
    const rentDay = owned.reduce((t, es) => t + estateRentPerDay(es), 0);
    const sum = document.createElement("div");
    sum.className = "money-summary";
    sum.innerHTML = `
      <div class="money-stat"><span>${T("บ้านที่ถือ")}</span><b>${owned.length} หลัง</b></div>
      <div class="money-stat"><span>${T("ทุนที่จมอยู่ (ขายคืนได้เต็ม)")}</span><b>${fmtNum(capital)}</b></div>
      <div class="money-stat"><span>${T("ค่าเช่า/วันในเกม")}</span><b class="good">${Math.round(rentDay).toLocaleString()}</b></div>
      <div class="money-stat"><span>${T("ผลตอบแทนต่อทุน")}</span><b>${capital > 0 ? (rentDay * DAYS_PER_YEAR / capital * 100).toFixed(1) : "0.0"}%/ปี</b></div>
      <div class="money-stat"><span>${T("ค่าเช่าสะสม")}</span><b>${fmtNum(Math.round(P.stats.rentEarned || 0))}</b></div>`;
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
    const full = FURNITURE.slice(0, kind.slots).reduce((t, f) => t + f.rent, 0);
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
      <div class="furn-row">${FURNITURE.map((f) => {
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
  $("#skill-title").textContent = "🏹 สถาบันฮันเตอร์";
  $("#skill-flavor").textContent = "เลี้ยงเด็กเอง ฝึกเอง ส่งออกล่าเอง — ขาดทุนช่วงแรก คืนทุนในระยะยาว";

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
    <div class="money-stat"><span>${T("คนในสังกัด")}</span><b>${g.roster.length}/${t.beds}${hurt ? ` · เจ็บ ${hurt}` : ""}</b></div>
    <div class="money-stat"><span>${T("ค่าเลี้ยง/วันในเกม")}</span><b class="bad">${guildUpkeepPerDay().toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("รอรับ")}</span><b class="${pending.gold > 0 ? "good" : ""}">${Math.floor(pending.gold).toLocaleString()}${nItems ? ` · ของ ${nItems}` : ""}</b></div>`;
  extra.appendChild(summary);

  const tabs = document.createElement("div");
  tabs.className = "area-tabs";
  tabs.innerHTML = [
    ["squads", "🗡️ ทีมและภารกิจ", `${guildSquads().filter((x) => x.roundsLeft > 0).length}/${t.squads}`],
    ["roster", "🧑‍🎓 คนในสังกัด", `${g.roster.length}`],
    ["intake", "📜 รับเลี้ยง", `${(g.applicants || []).length}`],
    ["upkeep", "🍲 ค่าเลี้ยงดู", ""],
  ].map(([id, label, n]) => `<button class="area-tab${guildTab === id ? " active" : ""}" data-gtab="${id}">
      <span style="color:#7cc47f">◆</span> ${label}${n ? `<span class="area-count">${n}</span>` : ""}</button>`).join("");
  extra.appendChild(tabs);
  tabs.querySelectorAll("[data-gtab]").forEach((b) => b.onclick = () => { guildTab = b.dataset.gtab; renderGuild(); });

  /* Collecting is its own card at the top of every tab: it is the one thing you came here to do. */
  const take = document.createElement("div");
  take.className = "action-card full-card" + (pending.gold > 0 ? " running" : "");
  take.innerHTML = `
    <div class="head"><div class="name">📦 ของที่ทีมส่งกลับมา</div>
      <div class="req">${Math.floor(pending.gold).toLocaleString()} 💰${nItems ? ` · ${nItems} ชิ้น` : ""}</div></div>
    <div class="detail">ล่าไปแล้ว ${pending.rounds || 0} รอบตั้งแต่รับครั้งก่อน
      ${nItems ? `<br>${Object.entries(pending.items).map(([id, n]) => `${ITEMS[id]?.icon || "📦"} ${ITEMS[id]?.name || id} ×${n}`).join(" · ")}` : ""}</div>
    <div class="cd-actions">
      <button class="farm-btn harvest" data-gcollect>${T("รับของและเงิน")}</button>
      <label class="chk"><input type="checkbox" data-gauto ${g.autoCollect ? "checked" : ""}> รับอัตโนมัติ</label>
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
    ซื้อโรงเรียน รับเด็กเข้ามาเลี้ยง ฝึกจนสอบเลื่อนขั้นได้ แล้วส่งเป็นทีมออกล่ามอนสเตอร์แทนเรา<br>
    ทีมจะล่าเองทุกวันในเกม ได้ทั้งค่าหัวและวัตถุดิบ — <b>${T("แต่ช่วงแรกขาดทุนแน่นอน")}</b>
    เพราะเด็กขั้น F ยังหาเงินไม่คุ้มค่าข้าว กว่าจะคืนทุนใช้เวลาราวเจ็ดปีในเกม<br>
    เลี้ยงคนไว้เยอะเกินก็ขาดทุน ส่งไปเป้าที่เกินตัวก็มีคนตาย และคนที่ตายคือคนที่เราลงทุนฝึกมาหลายปี
    <br><b>${T("ไม่กินช่องงาน")}</b> — ทำงานอยู่เบื้องหลังพร้อมกับที่เราทำอย่างอื่น`;
  extra.appendChild(note);

  const card = document.createElement("div");
  card.className = "action-card full-card";
  const can = Math.floor(P.gold) >= t.cost;
  card.innerHTML = `
    <div class="head"><div class="name">🏹 สร้าง${t.name}</div>
      <div class="req ${can ? "good" : "bad"}">${t.cost.toLocaleString()} 💰</div></div>
    <div class="detail">เตียง ${t.beds} คน · ส่งได้ ${t.squads} ทีม · รับสัญญาได้ ${t.zones} โซนแรก
      <br>ค่าดูแลสถาบันคงที่ ${t.fixed.toLocaleString()} 💰/วันในเกม บวกค่าเลี้ยงรายหัว</div>
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
      <div class="detail">เตียง ${x.beds} · ทีม ${x.squads} · โซน ${x.zones}
        · ค่าเลี้ยงต่อหัว ×${x.upkeepMult.toFixed(2)} · ค่าสถาบัน ${x.fixed.toLocaleString()}/วัน</div>`;
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
    เพราะทุกปากที่รับเข้ามากินค่าอาหารทุกวัน ตั้งแต่วันแรกที่ยังหาเงินไม่ได้</div>`;
  grid.appendChild(head);
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
    ["shop", `🏪 ร้านค้า`, P.shops?.length ? `${P.shops.length}` : ""],
    ["estate", `🏘️ อสังหา`, P.estates?.length ? `${P.estates.length}` : ""],
  ].map(([id, label, n]) => `<button class="area-tab${bizTab === id ? " active" : ""}" data-biz="${id}">
      <span style="color:#7cc47f">◆</span> ${label}${n ? `<span class="area-count">${n}</span>` : ""}</button>`).join("");
  extra.appendChild(kinds);
  kinds.querySelectorAll("[data-biz]").forEach((b) => b.onclick = () => { bizTab = b.dataset.biz; renderShops(); });

  if (bizTab === "estate") { renderEstates(grid, extra); return; }

  $("#skill-title").textContent = "🏪 ธุรกิจของเรา";
  $("#skill-flavor").textContent = "จ้างคน จัดอัตราส่วน ตั้งราคา — รายได้เข้าทุกวันในเกม แต่ค่าจ้างก็ออกทุกวันเหมือนกัน";

  if (!P.shops?.length) { renderShopOpening(grid, extra); return; }
  if (shopTab >= P.shops.length) shopTab = 0;
  const sh = P.shops[shopTab];
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

  if (P.shops.length > 1 || SHOP_TIERS[sh.tier + 1] || true) {
    const bar = document.createElement("div");
    bar.className = "area-tabs";
    bar.innerHTML = P.shops.map((x, i) => {
      const xt = shopType(x.type);
      return `<button class="area-tab${i === shopTab ? " active" : ""}" data-shoptab="${i}">
        <span style="color:#7cc47f">◆</span> ${xt.icon} ${xt.name}
        <span class="area-count">${SHOP_TIERS[x.tier].name}</span></button>`;
    }).join("") + `<button class="area-tab" data-newshop>＋ เปิดร้านใหม่</button>`;
    extra.appendChild(bar);
    bar.querySelectorAll("[data-shoptab]").forEach((b) => b.onclick = () => {
      shopTab = Number(b.dataset.shoptab); renderShops();
    });
    bar.querySelector("[data-newshop]").onclick = () => { shopTab = -1; renderShops(); };
  }
  if (shopTab < 0) { renderShopOpening(grid, extra); return; }

  const panels = document.createElement("div");
  panels.className = "area-tabs";
  panels.innerHTML = [["floor", "🏪 หน้าร้าน"], ["staff", `👥 พนักงาน (${sh.staff.length})`], ["hire", "📋 รับสมัคร"]]
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
    ร้านทำงานเองทุกวันในเกม <b>${T("ไม่กินช่องงาน")}</b> — แต่ค่าจ้างพนักงานออกทุกวันไม่ว่าจะขายได้หรือไม่
    ซึ่งเป็นเหตุผลเดียวที่ธุรกิจนี้ <b class="bad">${T("ขาดทุนได้จริง")}</b><br>
    สายพานคือ 🏹 นักล่าหาวัตถุดิบ → 🔨 ช่างแปรรูป → 💁 พ่อค้าขาย · คุณส่งวัตถุดิบจากกระเป๋าเข้าไปเองก็ได้
    ${P.brand > 0.05 ? `<br><b class="good">⭐ ชื่อเสียงที่สะสมไว้จะพาลูกค้าประจำ ${(SHOP_BRAND_CARRY * P.brand).toFixed(1)} คนมาให้ร้านใหม่ตั้งแต่วันแรก</b>` : ""}
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
        ขาย <b>${t.goodName}</b> ชิ้นละ ${t.goodValue} 💰 · ใช้วัตถุดิบ ${t.rawPerGood} หน่วย/ชิ้น<br>
        ฤดู: ${SEASONS.map((sn, i) => `${sn} ×${t.season[i].toFixed(2)}`).join(" · ")}</div>`;
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
  const est = estimatedTaxNow();
  const summary = document.createElement("div");
  summary.className = "money-summary";
  summary.innerHTML = `
    <div class="money-stat"><span>${T("ทองในมือ")}</span><b class="${P.gold < 0 ? "bad" : ""}">${P.gold.toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("ฝากธนาคาร")}</span><b>${Math.floor(bankBalance()).toLocaleString()}</b></div>
    <div class="money-stat"><span>${T("มูลค่าหุ้นที่ถือ")}</span><b>${Math.round(portfolioValue()).toLocaleString()}</b></div>
    <div class="money-stat"><span>กำไรลงทุนปีที่ ${d.year}</span><b>${profit.toLocaleString()}</b></div>
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
    { id: "ledger", label: "🧾 บัญชี", count: "" },
    { id: "bank", label: "🏦 ธนาคาร", count: "" },
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
  if (moneyTab !== "bank" && moneyTab !== "ledger") {
    const inTab = COMPANIES.filter((c) => c.size === moneyTab);
    const held = inTab.filter((c) => heldShares(c.id) > 0).length;
    const filters = document.createElement("div");
    filters.className = "money-filters";
    filters.innerHTML = `
      <label class="hide-owned">
        <input type="checkbox" id="hide-held"${uiPref("hideHeldCo") ? " checked" : ""}>
        ซ่อนที่มีแล้ว (${held})
      </label>
      <label class="hide-owned">
        <input type="checkbox" id="hide-unheld"${uiPref("hideUnheldCo") ? " checked" : ""}>
        ซ่อนที่ยังไม่ได้เป็นเจ้าของ (${inTab.length - held})
      </label>`;
    extra.appendChild(filters);
    /* 🎯 [owner 2026-08-17] "ทำให้มันติ๊กสลับกัน ไม่ให้ติ๊กพร้อมกัน" — the two are opposites, and
     * ticking both hides every company on the page: a filter whose only reachable state is an empty
     * list. Turning one on turns the other off, so the reachable states are held-only, unheld-only,
     * or everything. */
    filters.querySelector("#hide-held").onchange = (e) => {
      setUiPref("hideHeldCo", e.target.checked);
      if (e.target.checked) setUiPref("hideUnheldCo", false);
      openCompany = null; renderMoney();
    };
    filters.querySelector("#hide-unheld").onchange = (e) => {
      setUiPref("hideUnheldCo", e.target.checked);
      if (e.target.checked) setUiPref("hideHeldCo", false);
      openCompany = null; renderMoney();
    };
  }

  const grid = $("#action-grid");
  grid.innerHTML = "";
  if (moneyTab === "bank") renderBankTab(grid);
  else if (moneyTab === "ledger") renderLedgerTab(grid);
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
const LEDGER_SHOWN = 10;

function renderLedgerTab(grid) {
  const d = today();
  const profit = Math.round(P.tax?.yearProfit || 0);

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
    : `<div class="detail">ยังไม่มีรายการ — ลองฝากเงินหรือซื้อหุ้นสักกิจการดู</div>`;
  grid.appendChild(log);

}

/* --- Tax view ------------------------------------------------------------------------
 * 🎯 [owner 2026-08-17] "ในหน้าธนาคารและการลงทุน มันมีข้อมูลภาษี ให้ย้ายออกไป แล้วใส่รายละเอียดภาษี
 * เรทแต่ละประเภท และการกดจ่ายเองได้"
 *
 * Its own page, under the bank in the sidebar. Three ladders you can read before they apply to you,
 * a live reading of what each one is currently assessed on, and the bills with a button. */

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
        <b class="${seized ? "bad" : "good"}">${seized ? "🚨 ธุรกิจถูกยึด" : "ปกติ"}</b></div>
      ${owed > 0 ? `<div class="money-stat"><span>ค้างมาแล้ว</span>
        <b class="${overdue >= TAX_SEIZE_DAYS ? "bad" : ""}">${overdue}/${TAX_SEIZE_DAYS} วัน</b></div>` : ""}
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
    none.innerHTML = `<div class="detail">ประเมินภาษีตอนขึ้นปีใหม่ — ยังไม่มีอะไรต้องจ่ายตอนนี้</div>`;
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
        <div class="head"><div class="name">${k.icon} ${k.name} · ปีที่ ${b.year}</div>
          <div class="req ${late >= TAX_SEIZE_DAYS ? "bad" : ""}">${fmtNum(b.amount - b.paid)}</div></div>
        <div class="detail">ประเมินจาก ${fmtNum(b.base)} (${escapeHtml(k.what)})
          ${b.paid ? `<br>จ่ายไปแล้ว ${fmtNum(b.paid)} จาก ${fmtNum(b.amount)}` : ""}
          <br>ค้างมา ${late} วัน${late >= TAX_SEIZE_DAYS
            ? ` — <b class="bad">ถูกยึดแล้ว ค่าปรับวันละ ${Math.round(TAX_LATE_DAILY * 1000) / 10}%</b>`
            : ` · ยึดเมื่อครบ ${TAX_SEIZE_DAYS} วัน`}</div>
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
    none.innerHTML = `<div class="detail">ยังไม่ถึงเกณฑ์ของประเภทไหนเลย — ไม่มีอะไรสะสมอยู่ตอนนี้</div>`;
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
    const rows = [`<tr><td>ไม่เกิน ${fmtNum(k.free)}</td><td>${T("ยกเว้น")}</td><td></td></tr>`];
    let floor = k.free;
    for (const b of k.brackets) {
      const hit = base > floor;
      rows.push(`<tr class="${hit ? "band-hit" : ""}"><td>${fmtNum(floor)} – ${
        b.upTo === Infinity ? "ขึ้นไป" : fmtNum(b.upTo)}</td>
        <td>${(b.rate * 100).toFixed(1)}%</td><td>${hit ? "◀ ถึงขั้นนี้แล้ว" : ""}</td></tr>`);
      floor = b.upTo;
    }
    const card = document.createElement("div");
    card.className = "action-card ledger-card full-card";
    card.innerHTML = `
      <div class="head"><div class="name">${k.icon} ${k.name}</div>
        <div class="req">ตอนนี้ ${fmtNum(base)} → ${fmtNum(would)}</div></div>
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

function renderRebirth() {
  $("#skill-title").textContent = "🌀 การจุติ";
  $("#skill-flavor").textContent = "เริ่มรอบใหม่โดยไม่ทิ้งสิ่งที่สะสมมา — ความสำเร็จอยู่ครบ ของในกระเป๋าอยู่ครบ";
  const pv = rebirthPreview();
  const extra = $("#view-extra");
  extra.innerHTML = "";

  const keep = document.createElement("div");
  keep.className = "money-summary";
  keep.innerHTML = `
    <div class="money-stat"><span>${T("จุติมาแล้ว")}</span><b>${P.rebirths || 0} ครั้ง</b></div>
    <div class="money-stat"><span>บุญเก่า — XP ทุกสาย</span><b class="good">+${(karmaXp() * 100).toFixed(1)}%</b></div>
    <div class="money-stat"><span>บุญเก่า — ทองที่หาได้</span><b class="good">+${(karmaGold() * 100).toFixed(1)}%</b></div>
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
      return `<div class="money-stat"><span>สัตว์เลี้ยงที่จะไปด้วย</span>
        <b class="${kept ? "good" : "bad"}">${kept
          ? `${kept.icon} ${escapeHtml(kept.name)} ขั้น ${kept.lv} → ${Math.max(1, Math.floor(petLevelExact(k) / 2))}`
          : `ไม่มี — ต้องพาออกล่า และเกรด ${PET_GRADES.find((g) => g.cls === PET_REBIRTH_MIN_GRADE).name}ขึ้นไป`}</b></div>
      <div class="money-stat"><span>สัตว์เลี้ยงที่จะเสียไป</span>
        <b class="${lost ? "bad" : ""}">${lost} ตัว</b></div>`;
    })()}
    <div class="money-stat"><span>${T("สายพันธุ์ที่เคยเจอ (เก็บไว้)")}</span>
      <b class="good">${Object.keys(P.seenPets || {}).length}/${PET_SPECIES.length}</b></div>
    <div class="money-stat"><span>🏦 เงินฝาก (รอด)</span>
      <b class="good">${fmtNum(Math.floor(bankBalance()))}</b></div>
    <div class="money-stat"><span>💰 ทองในมือ (จะหาย)</span>
      <b class="${P.gold > 0 ? "bad" : ""}">${fmtNum(Math.floor(P.gold || 0))}</b></div>
    <div class="money-stat"><span>📈 หุ้นที่ถือ (รอด)</span>
      <b class="good">${fmtNum(Math.round(portfolioValue()))}</b></div>`;
  extra.appendChild(keep);

  const grid = $("#action-grid");
  grid.innerHTML = "";
  const head = document.createElement("div");
  head.className = "area-head";
  head.textContent = "ค่าที่จะเปลี่ยนเมื่อจุติ";
  grid.appendChild(head);

  const card = document.createElement("div");
  card.className = "action-card full-card";
  const rows = COMBAT_STATS.map((st) => {
    const r = pv[st.id];
    return `<div class="reborn-row">
      <span class="rb-name">${st.icon} ${st.name}</span>
      <span class="rb-num">${r.cur}</span>
      <span class="rb-arrow">→</span>
      <span class="rb-num ${r.floored ? "good" : "bad"}">${r.after}</span>
      <span class="rb-note">${r.floored
        ? `หารครึ่งได้ ${r.halved} ซึ่งต่ำกว่าพื้นเดิม จึงคงไว้ที่ ${r.floor}`
        : `หารครึ่งจาก ${r.cur} · พื้นใหม่จะเป็น ${r.after}`}</span>
    </div>`;
  }).join("");
  card.innerHTML = `
    <div class="detail keeps">
      <b>สิ่งที่ไม่หาย:</b> 🏆 ความสำเร็จทั้งหมดและโบนัสของมัน · 🎒 ของในกระเป๋าทุกชิ้น ·
      🏦 <b class="good">${T("เงินฝากในธนาคาร")}</b> · 🪴 แปลงปลูก · 🏪 ของที่ซื้อจากร้าน ·
      📖 บันทึกสายพันธุ์สัตว์เลี้ยงที่เคยเจอ<br>
      <b class="good">เลเวลอาชีพทุกสายอยู่ครบ:</b> ${SKILLS.map((sk) =>
        `${sk.icon} ${escapeHtml(sk.name)} ${levelFromXp(P.xp[sk.id] || 0)}`).join(" · ")}
      — ความชำนาญที่สะสมไว้ไม่หายไปไหน รอบใหม่ไม่ต้องไต่ใหม่ทั้งหมด แค่ต้องหาเงินใหม่<br>
      <b>สิ่งที่ลดลง:</b> ค่าสเตตัสการล่าทั้งสามช่อง หารครึ่ง<br>
      <b class="bad">สิ่งที่หายไปทั้งหมด:</b> 🐾 สัตว์เลี้ยงทุกตัวถูกปล่อยคืนธรรมชาติ ·
      💰 <b class="bad">${T("ทองในมือ")}</b> · 📈 <b class="bad">${T("หุ้นทุกตัว")}</b>
      — เงินติดตัวได้เฉพาะที่อยู่ในธนาคาร ถ้าจะจุติ <b>${T("ต้องขายแล้วเอาไปฝากก่อน")}</b><br>
      <span class="rb-warn">หมายเหตุ: ดอกเบี้ยเงินฝากคิดจากจำนวนปีที่ไม่แตะบัญชี และการจุติจะรีเซ็ตนาฬิกานั้น
      — เงินต้นอยู่ครบ แต่เรทกลับไปเริ่มใหม่ · หนี้ภาษีที่ค้างอยู่ไม่หายไปด้วยการจุติ</span>
    </div>
    ${rows}
    <div class="detail">
      พื้นการจุติจะไม่มีวันต่ำลง — ถ้าจุติเร็วเกินไปจนหารครึ่งแล้วได้น้อยกว่าครั้งก่อน
      ระบบจะคงค่าของการจุติครั้งล่าสุดไว้ให้ ${canRebirth() ? "" : `<br><b>ต้องถึงเลเวลรวม ${rebirthGate()} ก่อน (ตอนนี้ ${combatLevel()})</b>`}
    </div>
    <div class="cd-actions">
      <button class="farm-btn harvest" data-rebirth${canRebirth() ? "" : " disabled"}>🌀 จุติเลย</button>
    </div>`;
  grid.appendChild(card);
  /* 🎯 The point of scaling karma by level is that WAITING becomes a decision, and a decision the
   * player cannot make without seeing the numbers. This table is the whole feature's interface. */
  const kh = document.createElement("div");
  kh.className = "area-head";
  kh.textContent = "จุติตอนนี้ หรือไต่ต่อ — บุญที่จะได้";
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
      <span class="rb-name">${isNow ? "▶ " : ""}เลเวลรวม ${lv}${isNow ? " (ตอนนี้)" : ""}</span>
      <span class="rb-num good">+${(g.xp * 100).toFixed(1)}%</span>
      <span class="rb-arrow">XP</span>
      <span class="rb-num good">+${(g.gold * 100).toFixed(1)}%</span>
      <span class="rb-note">ทอง · ${lv === now ? "จุติได้เลย" : `ไต่อีก ${lv - now} เลเวล ได้บุญ ${(karmaGainFor(lv, P.rebirths || 0).xp / Math.max(1e-9, karmaGainFor(now, P.rebirths || 0).xp)).toFixed(1)} เท่าของตอนนี้`}</span>
    </div>`;
  }).join("") + `<div class="detail">
    บุญคิดจาก <b>${T("เลเวลรวมตอนที่จุติ")}</b> เทียบกับประตู (ตอนนี้ ${gate}) — ยิ่งไต่ไกลก่อนจุติ ยิ่งได้เยอะแบบทวีคูณ
    ไม่ใช่ได้เท่ากันทุกครั้งเหมือนเมื่อก่อน<br>
    ประตูจะขยับขึ้น ${REBIRTH_GATE_STEP} เลเวลทุกครั้งที่จุติ (สูงสุด ${REBIRTH_GATE_MAX})
    — จุติรัว ๆ ที่เลเวลต่ำจึงไม่ใช่ทางลัดอีกต่อไป · เพดานบุญรวม +${Math.round(KARMA_CAP * 100)}%
  </div>`;
  grid.appendChild(ktab);

  card.querySelector("[data-rebirth]").onclick = () => {
    if (!canRebirth()) return;
    if (confirm(rebirthConfirmMessage(pv))) doRebirth();
  };

  if ((P.rebirthLog || []).length) {
    const h2 = document.createElement("div");
    h2.className = "area-head";
    h2.textContent = "ประวัติการจุติ";
    grid.appendChild(h2);
    const hist = document.createElement("div");
    hist.className = "action-card ledger-card full-card";
    hist.innerHTML = `<div class="ledger-list">${P.rebirthLog.map((r, i) => `<div class="ledger-row">
      <span class="lr-date">ปี ${r.y ?? r.year}/${r.month}/${r.day}</span>
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
            <div class="req">${open ? `${cleared}/${normals} ด่าน${bossDown ? " · 🏆" : ""}` : `🔒 เลเวลล่า ${loc.levelReq}`}</div></div>
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
               : `<span class="stat-chip missing">ยังไม่มีสัตว์เลี้ยง — ล่ามอนสเตอร์เพื่อลุ้นจับ</span>`}
        <span class="stat-chip">🐾 เก็บได้ ${P.pets.length} ตัว</span>
        ${cur ? `<span class="stat-chip${(P.petXpShare ?? PET_XP_DEFAULT) ? " missing" : ""}">📚 กิน XP ${Math.round((P.petXpShare ?? PET_XP_DEFAULT) * 100)}%</span>` : ""}
      </span>
      <span class="expand-hint">${petOpen ? "ย่อ" : "กดเพื่อจัดการสัตว์เลี้ยง"}</span>
    </button>`;

  if (!petOpen) {
    panel.innerHTML = summary;
    extra.appendChild(panel);
    panel.querySelector("#pet-toggle").onclick = () => { petOpen = true; renderView(); };
    return;
  }

  /* 🎯 [owner 2026-08-18] "เพิ่มระบบผสมพันธุ์ รวมร่าง" — a mode, not a page: picking a pair replaces
   * the usual per-pet buttons with one selection toggle, so nothing else can be clicked by accident
   * mid-pick. Model: game/pet_fusion_sim.mjs. */
  const pickedGrade = petFusePick.length ? petStats(P.pets[petFusePick[0]]).grade.cls : null;
  panel.innerHTML = summary + (P.pets.length ? `
    ${P.pets.length >= 2 ? `
    <div class="train-row">
      <button class="btn ${petFuseMode ? "" : "ghost"} small" id="fuse-toggle">🧬 ผสมพันธุ์</button>
      ${petFuseMode ? `<span class="train-sub">เลือกสัตว์เลี้ยงคุณภาพเดียวกัน 2 ตัว มารวมร่างเป็น 1 ตัว — ทั้งสองตัวหายไป</span>` : ""}
    </div>` : ""}
    <div class="equip-slots">
      ${P.pets.map((pet, i) => {
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
          ${petFuseMode
            ? `<button class="btn ${picked ? "" : "ghost"} small" data-fusepick="${i}" ${pickable ? "" : "disabled"}>
                 ${picked ? "✓ เลือกแล้ว" : "เลือกผสม"}</button>`
            : `<button class="btn small" data-pet="${i}">${i === P.activePet ? "กำลังพาไป" : "พาตัวนี้ไป"}</button>
               ${i === P.activePet ? `<button class="btn ghost small" data-rest="${i}">😴 ให้พัก</button>` : ""}
               ${pet.hp < st.maxHp ? `<button class="btn ghost small" data-feed="${i}">🍴 ให้อาหาร</button>` : ""}
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
    const detail = m.id === "normal" ? "ค่าพื้นฐาน ไม่มีตัวคูณ"
      : `เลือด ×${m.hp} · แรง ×${m.dmg} · XP ×${m.xp} · ทอง ×${m.gold} · ของดรอป ×${m.loot}`;
    return `<button class="elite-opt${m.id === P.eliteMode ? " active" : ""}${open ? "" : " shut"}"
        data-elite="${m.id}"${open ? "" : " disabled"}>
      <span class="eo-bullet">◆</span>
      <span class="eo-face">${open ? m.icon : "🔒"}</span>
      <span class="eo-body"><span class="eo-name">${m.name}</span>
        <span class="eo-detail">${open ? detail
          : `ปราบด่านในระดับก่อนหน้าให้ครบ ${KILLS_TO_UNLOCK_NEXT_STAGE} ตัวก่อน`}</span></span>
    </button>`;
  };
  box.innerHTML = `
    <summary class="elite-summary">
      <span class="train-label">🔥 ระดับความยาก</span>
      <span class="elite-current">◆ ${cur.icon} ${cur.name}</span>
      <span class="elite-mult">${cur.id === "normal" ? "มาตรฐาน" : `×${cur.xp} XP · ×${cur.gold} 💰`}</span>
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
    toast(`${mode.icon} เปลี่ยนระดับความยากเป็น ${mode.name}`);
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
        <span class="stat-chip">⚔️ เลเวลล่า ${combatLevel()}</span>
        ${sets.length ? `<span class="stat-chip set-on">👕 ${sets.map((x) => x.name).join(", ")}</span>` : ""}
      </span>
      <span class="expand-hint">${equipOpen ? "ย่อ" : "กดเพื่อปรับอุปกรณ์"}</span>
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

function shopEffectText(u) {
  if (u.kind === "tome") {
    const skill = findSkill(u.skill);
    return `${skill.icon} ${skill.name} ได้ XP เพิ่ม ${Math.round(u.value * 100)}% ถาวร`;
  }
  if (u.kind === "multi") {
    const n = SHOP.filter((x) => x.kind === "multi").findIndex((x) => x.id === u.id) + 2;
    return `ทำงานพร้อมกันได้ ${n} อย่าง (สู้ได้ทีละสนามเท่านั้น — เลือดมีชุดเดียว)`;
  }
  if (u.kind === "plot") {
    const n = SHOP.filter((x) => x.kind === "plot").findIndex((x) => x.id === u.id) + PLOTS_START + 1;
    return `🌻 เปิดแปลงปลูกที่ ${n} — ปลูกพร้อมกันได้มากขึ้น (สูงสุด ${PLOTS_MAX} แปลง)`;
  }
  if (u.kind === "charm") {
    return { luck: `โอกาสของหายากจากทุกสายเพิ่ม ${Math.round(u.value * 100)}%`,
             gold: `ทองจากการล่าและขโมยเพิ่ม ${Math.round(u.value * 100)}%`,
             def:  `ป้องกันติดตัว +${u.value} (ไม่ต้องสวมของ)`,
             hp:   `HP สูงสุดติดตัว +${u.value}` }[u.effect];
  }
  const skill = findSkill(u.skill);
  return `${skill.icon} ${skill.name} เร็วขึ้น ${Math.round(u.bonus * 100)}%`;
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
  if (m < 60) return `เล่นมา ${m} นาที`;
  const h = Math.floor(m / 60);
  return h < 24 ? `เล่นมา ${h} ชม. ${m % 60} น.` : `เล่นมา ${Math.floor(h / 24)} วัน ${h % 24} ชม.`;
}

/* 🎯 [added 2026-08-15, owner's ask] Everything the game already counts, in one place — an idle
 * game lives on watching its own numbers grow, and until now none of them were visible. */
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
        โปรไฟล์ "${escapeHtml(P.name)}" · สร้างเมื่อ ${new Date(P.createdAt).toLocaleDateString("th-TH")}
      </div></div>
    </div>`;

  const cards = [
    { icon: "⚒️", title: "การทำงาน", rows: [
      ["ทำงานสำเร็จ", fmtNum(P.stats.actions || 0) + " ครั้ง"],
      ["ปรุงอาหาร", fmtNum(P.stats.cooked || 0) + " จาน"],
      ["ตีของ/เย็บของ", fmtNum(P.stats.crafted || 0) + " ชิ้น"],
      ["ขโมยสำเร็จ", fmtNum(P.stats.steals || 0) + " ครั้ง"],
      ["ช่องงานที่มี", `${maxSlots()} ช่อง`],
    ]},
    { icon: "⚔️", title: "การล่า", rows: [
      ["ปราบมอนสเตอร์", fmtNum(killTotal) + " ตัว"],
      ["โค่นบอส", fmtNum(P.stats.bosses || 0) + " ครั้ง"],
      ["ชนิดที่เคยเจอ", `${monstersMet}/${allMonsters} ชนิด`],
      ["ระดับความยาก", eliteMode().name],
      ["เลเวลล่ารวม", combatLevel()],
    ]},
    { icon: "💰", title: "ทรัพย์สิน", rows: [
      ["ทองที่หามาทั้งหมด", fmtNum(P.stats.goldEarned || 0)],
      ["ทองในมือตอนนี้", fmtNum(P.gold)],
      ["ขยะที่ขายไป", fmtNum(P.stats.junkSold || 0) + " ชิ้น"],
      ["ของในกระเป๋า", `${seenItems} ชนิด`],
      ["ของที่ซื้อจากร้าน", `${Object.keys(P.upgrades).length} รายการ`],
    ]},
    /* 🎯 [owner's ask] The business page shows today's position; this shows the track record —
     * how much is deployed, what it is worth now, and where the income actually came from. The
     * yearly tax figure alone never answers "has investing been worth it". */
    { icon: "📈", title: "การลงทุน", rows: [
      ["กิจการที่ถือ", `${heldCount}/${COMPANIES.length} แห่ง` +
        (ownedCount ? ` · 👑 เจ้าของเต็ม ${ownedCount}` : "")],
      ["แยกตามขนาด", COMPANY_SIZES.map((sz) =>
        `${sz.icon} ${COMPANIES.filter((c) => c.size === sz.id && heldShares(c.id) > 0).length}`).join(" · ")],
      ["เงินที่ลงไป (ทุน)", fmtNum(Math.round(investedCost))],
      ["มูลค่าตอนนี้", fmtNum(Math.round(marketNow)) +
        (investedCost > 0 ? ` (${unrealised >= 0 ? "+" : ""}${(unrealised / investedCost * 100).toFixed(1)}%)` : "")],
      ["กำไรที่ยังไม่ขาย", fmtNum(Math.round(unrealised))],
      ["ปันผลที่ได้รับสะสม", fmtNum(Math.round(P.stats.divPaid || 0))],
      ["กำไรจากการซื้อขายสะสม", fmtNum(Math.round(P.stats.tradeProfit || 0))],
      ["ดอกเบี้ยธนาคารสะสม", fmtNum(Math.round(P.stats.bankInterest || 0))],
      ["ฝากธนาคารตอนนี้", fmtNum(Math.floor(bankBalance()))],
      [`กำไรลงทุนปีที่ ${today().year}`, fmtNum(Math.round(P.tax?.yearProfit || 0))],
      ["ภาษีที่จ่ายไปแล้ว", fmtNum(Math.round(P.tax?.paidTotal || 0))],
    ]},
    { icon: "⭐", title: "ความชำนาญ", rows: [
      ["ขั้นชำนาญรวม", `${fmtNum(totalMastery)}/${fmtNum(masteryCap)}`],
      ["ช่องที่ MAX แล้ว", Object.values(P.mastery).filter((xp) => masteryLevelFromXp(xp) >= MASTERY_MAX).length],
      ["สายที่เก่งสุด", `${bestSkill.sk.icon} ${bestSkill.sk.name} (เลเวล ${bestSkill.lv})`],
      ["สายพันธุ์ปลาที่เจอ", `${Object.keys(P.seenFish).length} ชนิด`],
      ["เก็บเกี่ยวไปแล้ว", `${(P.stats.harvests || 0).toLocaleString()} แปลง`],
      ["พืชที่เคยปลูก", `${Object.keys(P.seenCrops || {}).length}/${findSkill("fa").actions.length} ชนิด`],
      /* 🐛 [2026-08-18] The third site that counted achievements its own way. The sidebar and the
       * achievements page were unified behind achievementProgress() when the owner caught them
       * disagreeing; this one was missed and still read 5/18 while both of those said 5/190. */
      ["ความสำเร็จ", (() => { const a = achievementProgress(); return `${a.done}/${a.total}`; })()],
    ]},
    { icon: "🐾", title: "สัตว์เลี้ยง", rows: [
      ["จับได้แล้ว", `${P.pets.length} ตัว`],
      ["สายพันธุ์ที่มีตอนนี้", `${new Set(P.pets.map((x) => x.species)).size}/${PET_SPECIES.length}`],
      ["สายพันธุ์ที่เคยเจอ (ไม่หายตอนจุติ)",
       `${Object.keys(P.seenPets || {}).length}/${PET_SPECIES.length}`],
      ["ตัวที่พาไปด้วย", activePet() ? `${petStats(activePet()).icon} ${petStats(activePet()).name} ขั้น ${petStats(activePet()).lv}` : "—"],
      ["ขั้นสูงสุดที่เลี้ยงได้", P.pets.length ? Math.max(...P.pets.map((x) => petLevel(x))) : 0],
    ]},
    /* 🎯 [owner 2026-08-22] "เพิ่มสถิติต่างๆ ที่ควรเก็บ เพราะดูหน้าเดียวรู้ทุกอย่าง ทั้งเควส ความสัมพันธ์"
     * Everything the new systems know, on the page that already exists for knowing things. */
    { icon: "📜", title: "งานจากหมู่บ้าน", rows: [
      ["ส่งงานสำเร็จ", fmtNum(P.stats.questsDone || 0) + " งาน"],
      ["ค่าจ้างที่ได้", fmtNum(Math.round(P.stats.questGold || 0)) + " ทอง"],
      ["งานบนกระดานตอนนี้", `${(P.quests || []).length} งาน`],
      ["ส่งได้เลยตอนนี้", `${(P.quests || []).filter(questReady).length} งาน`],
    ] },
    { icon: "💗", title: "ความสัมพันธ์", rows: [
      ...VILLAGERS.filter((v) => v.romance).map((v) => {
        const r = relOf(v.id);
        return [`${v.icon} ${v.name}`,
                `${relStage(r.aff).name} (${r.aff}/${REL_MAX})${P.spouse === v.id ? " 💍" : ""}`];
      }),
      ["ของขวัญที่ให้ไป", fmtNum(P.stats.giftsGiven || 0) + " ชิ้น"],
    ] },
    { icon: "👨‍👩‍👧", title: "ครอบครัว", rows: [
      ["คู่ชีวิต", P.spouse ? (VILLAGERS.find((v) => v.id === P.spouse)?.name || "-") : "ยังไม่มี"],
      ["ลูก", `${(P.kids || []).length}/${CHILD_MAX} คน`],
      ["ลูกที่โตแล้ว", `${(P.kids || []).filter(childIsAdult).length} คน`],
      ["ขั้นการเรียนรวม", `${(P.kids || []).reduce((t, k) =>
          t + CHILD_TRACKS.reduce((n, tr) => n + childTrackLevel(k, tr.id), 0), 0)} ขั้น`],
      ["ลงทุนกับการเรียนไป", fmtNum(Math.round(P.stats.eduSpent || 0)) + " ทอง"],
    ] },
    { icon: "📈", title: "เลเวลทุกสาย", rows: SKILLS.map((sk) =>
      [`${sk.icon} ${sk.name}`, `เลเวล ${levelFromXp(P.xp[sk.id] || 0)}`]) },
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
        <small>${ti.special
          ? `ฉายาพิเศษ — ${escapeHtml(ti.desc)}`
          : nx ? `อีก ${nx.need} รายการเป็น ${nx.icon} ${escapeHtml(nx.name)}`
               : "ฉายาสูงสุดแล้ว ไม่มีอะไรเหนือกว่านี้"}</small>
      </span>
    </div>` : "";
  $("#view-extra").innerHTML = titleBlock + `
    <div class="mastery-summary">
      <span class="m-chip">🏆 ${T("ปลดแล้ว")} ${done}/${total}</span>
      <div class="m-track">
        <div class="m-bar"><div style="width:${done / total * 100}%; background:var(--gold)"></div></div>
        <div class="m-nums">${perkLine || "ยังไม่มีโบนัสถาวร — ปลดอันแรกแล้วจะเริ่มสะสม"}</div>
      </div>
    </div>
    <label class="hide-owned">
      <input type="checkbox" id="hide-done"${uiPref("hideDoneAch") ? " checked" : ""}>
      ซ่อนอันที่ปลดแล้ว (${done}/${total} อัน)
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
        <div class="req">${got ? "✅ ปลดแล้ว" : `${cur.toLocaleString()}/${a.goal.toLocaleString()}`}</div></div>
      <div class="detail">${a.desc}</div>
      <div class="io">รางวัล: ${perks}</div>
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
        <div class="req">${got ? "✅ ปลดแล้ว" : `${n.toLocaleString()}/${r.t.kills.toLocaleString()}`}</div></div>
      <div class="detail">ปราบ${escapeHtml(r.raw.name)}ในระดับ${escapeHtml(r.mode.name)} ${r.t.kills.toLocaleString()} ตัว${
        r.ti === 0 ? "" : " · นับเฉพาะที่ล่าในระดับนี้ เริ่มจากศูนย์"}</div>
      <div class="io">รางวัล: ${rw.icon} ${rw.name}ถาวร +${rw.per[r.ti]}</div>
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
  $("#skill-title").textContent = "🏪 ร้านค้านักผจญภัย";
  $("#skill-flavor").textContent = "เครื่องมือเร่งงาน · คัมภีร์เพิ่ม XP · เครื่องรางติดตัว — ทุกชิ้นถาวร";
  const ownedCount = SHOP.filter((u) => P.upgrades[u.id]).length;
  $("#view-extra").innerHTML = `
    <label class="hide-owned">
      <input type="checkbox" id="hide-owned"${uiPref("hideOwnedShop") ? " checked" : ""}>
      ซ่อนของที่มีแล้ว (${ownedCount}/${SHOP.length} ชิ้น)
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
          <div class="req">${o.sold ? "✅ ซื้อแล้ว" : `${o.price.toLocaleString()} 💰`}</div></div>
        <div class="detail">ปกติต้องไปหาเอง — ราคาเฉลี่ย ${Math.round(o.price / o.n)} 💰 ต่อชิ้น</div>
        ${!o.sold && P.gold < o.price
          ? `<div class="detail missing">ยังขาดอีก ${(o.price - P.gold).toLocaleString()} 💰</div>` : ""}`;
      if (!o.sold) card.onclick = () => buyTraderOffer(i);
      grid.appendChild(card);
    });
  }

  const groups = [
    { title: "🛠️ เครื่องมือ (ทำงานเร็วขึ้น ซื้อไล่ขั้น)", match: (u) => !u.kind },
    { title: "📚 คัมภีร์ (XP เพิ่มถาวรทั้งสาย)",          match: (u) => u.kind === "tome" },
    { title: "🧿 เครื่องราง (ผลติดตัวทุกโหมด)",           match: (u) => u.kind === "charm" },
    { title: "🪴 กระถางปลูก (เปิดแปลงเพิ่มให้สวน)",        match: (u) => u.kind === "plot" },
    { title: "⚡ ทำหลายอย่างพร้อมกัน (ของแพงที่สุดในเกม)", match: (u) => u.kind === "multi" },
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
          <div class="req">${owned ? "✅ มีแล้ว" : `${u.price.toLocaleString()} 💰`}</div></div>
        <div class="detail">${shopEffectText(u)}</div>
        ${!owned && !gated && P.gold < u.price
          ? `<div class="detail missing">ยังขาดอีก ${(u.price - P.gold).toLocaleString()} 💰</div>` : ""}
        ${gated ? `<div class="detail missing">ต้องมี ${SHOP.find((x) => x.id === u.requires).name} ก่อน</div>` : ""}`;
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
    .map((c) => ({ label: `${c.icon} ${c.name}`, name: c.name }));
  return [...autos, ...P.cats.map((c) => ({ label: c, name: c }))];
}

function renderInvTabs() {
  const bar = $("#inv-tabs");
  // Automatic bags lead, then the player's own, then the add button, with "ทั้งหมด" anchoring the
  // end (owner's ordering, 2026-08-15). Only hand-made categories can be deleted.
  const tab = (t) =>
    `<button class="inv-tab${t.name === invTab ? " active" : ""}" data-tab="${escapeHtml(t.name)}">${escapeHtml(t.label)}</button>`;
  bar.innerHTML = activeTabs().map(tab).join("")
    + `<button class="inv-tab add" id="inv-add">+ หมวดใหม่</button>`
    + (junkOnHand().n ? `<button class="inv-tab junk" id="inv-junk">🗑️ ขายขยะทั้งหมด (${junkOnHand().n} ชิ้น / ${junkOnHand().gold.toLocaleString()} 💰)</button>` : "")
    + tab({ label: "ทั้งหมด", name: "ทั้งหมด" })
    + (P.cats.includes(invTab) ? `<button class="inv-tab del" id="inv-del">${T("ลบหมวดนี้")}</button>` : "");
  bar.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { invTab = b.dataset.tab; renderInventory(); });
  $("#inv-add").onclick = () => {
    const name = (prompt("ตั้งชื่อหมวดใหม่ (เช่น ของขาย / เก็บไว้คราฟต์)") || "").trim();
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
    grid.innerHTML = `<div class="inv-empty">${invTab === "ทั้งหมด" ? "ยังไม่มีของ — เริ่มเก็บวัตถุดิบกันเลย" : "หมวดนี้ยังว่าง"}</div>`;
    return;
  }
  grid.innerHTML = "";
  const catOptions = (id) => {
    const cur = P.itemCat[id];
    const auto = AUTO_CATEGORIES.find((c) => c.match(id, ITEMS[id]));
    const names = [...AUTO_CATEGORIES.map((c) => c.name), ...P.cats];
    return [`<option value="">${auto ? `อัตโนมัติ · ${auto.name}` : "ไม่จัดหมวด"}</option>`,
      ...names.map((c) => `<option value="${escapeHtml(c)}" ${cur === c ? "selected" : ""}>${escapeHtml(c)}</option>`)].join("");
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
        <div class="sell">ขาย ${item.sell} 💰${badge ? " · " + badge : ""}</div>
        <select class="cat-pick" data-cat="${id}">${catOptions(id)}</select>
      </div>
      <div class="inv-side">
        <div class="qty">×${n}${reservedCount(id) ? `<span class="lock-badge" title="สวมใส่อยู่ ${reservedCount(id)} ชิ้น">🔒${reservedCount(id)}</span>` : ""}</div>
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
    return wakeLock ? "กำลังทำงาน (Wake Lock API)" : "ยังไม่ได้จับ — จะจับเมื่อกลับมาดูหน้าจอ";
  }
  if (typeof NoSleepVideo === "undefined") return "ไม่มีวิธีสำรองในหน้านี้";
  const s = NoSleepVideo.status();
  if (s.playing && !s.muted) return "กำลังทำงาน (วิดีโอเงียบ)";
  if (s.playing && s.muted) return "วิดีโอเล่นแบบ mute — Android มักไม่ยอมกันจอดับให้ ต้องใช้ https";
  if (s.error) return `วิดีโอถูกปฏิเสธ (${s.error}) — แตะหน้าจอหนึ่งครั้งแล้วเปิดดูใหม่`;
  return "ยังไม่เริ่ม — แตะหน้าจอหนึ่งครั้ง";
}

function openSettings() {
  if (!P) return;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal">
      <div class="modal-head">⚙️ ตั้งค่า</div>
      <div class="modal-head" style="font-size:16px">ภาษา / Language</div>
      <div class="lang-row">
        <button class="btn lang-btn${currentLang() === "th" ? " primary" : ""}" data-lang="th">🇹🇭 ไทย</button>
        <button class="btn lang-btn${currentLang() === "en" ? " primary" : ""}" data-lang="en">🇬🇧 English</button>
      </div>
      <div class="modal-sub">ยังแปลไม่ครบทุกคำ — คำที่ยังไม่ได้แปลจะแสดงเป็นภาษาไทยไว้ก่อน / Not everything is translated yet; untranslated text stays in Thai.</div>
      <div class="modal-head" style="font-size:16px">${T("การแจ้งเตือน")}</div>
      <div class="modal-sub">เลือกว่าจะให้อะไรเด้งขึ้นมาบ้าง — คำเตือน ความพ่ายแพ้
        และข้อความที่ตอบสิ่งที่คุณเพิ่งกด จะแสดงเสมอ ปิดไม่ได้</div>
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
          <span class="notif-name">🔔 เสียงประกอบ</span>
          <span class="notif-note">${T("เสียงสั้น ๆ ตอนได้ของ เลเวลอัพ เก็บเกี่ยว หรือมีคำเตือน")}</span>
        </label>
        <label class="notif-row">
          <input type="checkbox" data-sound="musicOn"${soundPref("musicOn", false) ? " checked" : ""}>
          <span class="notif-name">🎵 เพลงประกอบ</span>
          <span class="notif-note">ทำนองช้า ๆ วนไปเรื่อย ๆ — ปิดไว้เป็นค่าเริ่มต้น</span>
        </label>
        <label class="notif-row"${wakeLockSupported() ? "" : ' style="opacity:.45"'}>
          <input type="checkbox" data-sound="awakeOn"${soundPref("awakeOn", true) ? " checked" : ""}${wakeLockSupported() ? "" : " disabled"}>
          <span class="notif-name">📱 กันจอดับตอนดูเกม</span>
          <span class="notif-note">${wakeLockSupported()
            ? `เกม idle มีจังหวะที่นั่งดูเฉย ๆ มือถือจะได้ไม่ล็อกจอ — ปล่อยเองเมื่อสลับแอปหรือกดพัก${
                wakeLockNative() ? "" : " (ใช้วิธีเล่นวิดีโอเงียบ เพราะหน้านี้เป็น http)"}${wakeLockStatusText() ? `<br><b class="awake-state">สถานะตอนนี้: ${escapeHtml(wakeLockStatusText())}</b>` : ""}`
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
    cell.textContent = `สถานะตอนนี้: ${wakeLockStatusText()}`;
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
  { id: "kill",   icon: "⚔️", name: "ล้มมอนสเตอร์และของที่ดรอป", note: "ทุกตัวที่ล้มได้ — ตัวที่ขึ้นถี่ที่สุด (บอสยังขึ้นเสมอ)" },
  { id: "gain",   icon: "🎁", name: "ของและ XP จากงาน",   note: "ตัดไม้ ขุด ตกปลา ปลูกผัก คราฟต์ และย่องเก็บของ" },
  { id: "level",  icon: "🎉", name: "เลเวลอัพ / ขั้นชำนาญ", note: "เลเวลสายอาชีพ สเตตัสการล่า และขั้นชำนาญ" },
  { id: "money",  icon: "📈", name: "ปันผลและการซื้อขาย",   note: "ปันผลรายวัน ดอกเบี้ย ซื้อ-ขายหุ้นและของ" },
  { id: "combat", icon: "⚔️", name: "รายละเอียดการต่อสู้",  note: "กินอัตโนมัติ เกราะแตก โหมดคลั่ง สัตว์เลี้ยงหมดแรง" },
  { id: "trader", icon: "🧙", name: "พ่อค้าเร่",            note: "ตอนมาตั้งแผง ตอนเก็บแผง และตอนซื้อของจากแผง" },
  { id: "guild",  icon: "🏹", name: "สถาบันฮันเตอร์",      note: "ทีมกลับถึงสถาบัน รับของอัตโนมัติ บาดเจ็บ และรับเด็กเข้าสังกัด" },
  { id: "family", icon: "👨‍👩‍👧", name: "ครอบครัว",           note: "ลูกเกิด ลูกโตพอออกผจญภัย และการเรียน" },
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
