/* All game content lives in these tables — balancing or adding content means editing
 * numbers here, never touching the engine. Item icons are emoji on purpose: zero image
 * assets keeps the whole game a few hundred KB and fully offline. */

/* 🐛 [2026-08-15] Bump this in the SAME commit as any new migrate() step in game.js. The
 * v5 combat-stat split shipped with this left at 4: freshProfile stamped v4, migrate pushed
 * it to v5, and the `p.v === GAME_VERSION` guard then rejected every profile — the game
 * silently refused to create or load anything. balance_check.mjs now fails if the two drift. */
const GAME_VERSION = 70;
/* 🎯 [owner 2026-08-22] "avatar คน เพดานน่าจะไม่กำหนด เพราะวางไว้ว่าให้โตได้เรื่อยๆ ... จริงๆ อยากให้ถึง 999"
 *
 * 99 was reachable in about four hours of the best XP route, which is the whole reason it felt like
 * a ceiling rather than a horizon. The curve underneath (75·L^1.62 + 40·(L−20)^2.3) is steep enough
 * to carry 999 unchanged — no formula change, just a number that stops getting in the way.
 *
 * Not uncapped, which was the other option on the table: a rebirth halves your level, and that only
 * means something while there is a top to be halved away from. */
const MAX_LEVEL = 999;
/* Farming plots grow in PARALLEL and cost no job slot, so the plot count is the real multiplier
 * on everything the skill pays. Every yield below is priced against PLOTS_MAX, not one plot. */
const PLOTS_START = 3;
const PLOTS_MAX = 9;

/* ---------- The in-game calendar ----------
 * Mythwood keeps its own clock, deliberately unhooked from the wall clock (owner, 2026-08-17:
 * "ไม่อ้างอิงกับเวลาโลกจริง"). It advances only while the game is open — same online-only
 * contract as farming and every job slot — so a year is a measure of how much you PLAYED, not
 * how long the tab sat closed. Rebirth, dividends and the tax year all read this clock.
 *
 * The year length is DERIVED, not chosen for feel. The owner fixed the tax threshold at 700,000
 * per year, and a year has to be long enough that 700k of passive income is a large-but-earnable
 * amount rather than pocket change. At 72 real minutes per year the whole market paid 841k/hr —
 * 21x the best hands-on route — because a "yearly" dividend was landing every 72 minutes.
 * Solving that back: one day = 100 real seconds, so a month is 50 real minutes and a year is
 * 10 real hours. A year of hands-on play then earns ~390k, which puts the tax threshold at a
 * meaningful 1.8x that — exactly the "passive income overtakes grinding" line it should mark. */
const GAME_DAY_SECONDS = 100;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;
const MONTH_NAMES = ["จันทราต้น", "จันทราปลาย", "ผลิบาน", "ฝนแรก", "ฝนหลวง", "น้ำหลาก",
                     "ลมเปลี่ยน", "เก็บเกี่ยว", "ใบร่วง", "หมอกลง", "เหมันต์", "ดาวยาว"];
const SEASONS = ["❄️ เหมันต์", "🌸 ผลิบาน", "🌧️ วสันต์", "🍂 สารท"];

/* One place turns elapsed days into a date, so the calendar can never drift between the
 * topbar, the dividend schedule and the tax year. */
function gameDate(totalDays) {
  const d = Math.floor(totalDays);
  const year = 1 + Math.floor(d / DAYS_PER_YEAR);
  const dayOfYear = d % DAYS_PER_YEAR;
  const monthIdx = Math.floor(dayOfYear / DAYS_PER_MONTH);
  return {
    year, month: monthIdx + 1, day: (dayOfYear % DAYS_PER_MONTH) + 1,
    monthName: MONTH_NAMES[monthIdx],
    season: SEASONS[Math.floor(monthIdx / 3)],
    totalDays: d,
  };
}
const MASTERY_MAX = 99;
const AUTOSAVE_MINUTES = 10;
const PROFILE_SLOTS = 2;
const KILLS_TO_UNLOCK_NEXT_STAGE = 10;

/* 🎯 [added 2026-08-19, owner: "หาก offline ต้องให้มันเล่นต่อได้เอง สะสมของไปเรื่อยๆ ... ยกเว้นต่อสู้
 * ... มีเฉพาะในโหมดมือถือ apk"] The job that was running keeps running while the app is closed.
 *
 * These two numbers are the whole balance of the feature, and offline_sim.mjs is what defends them:
 * the product CAP × RATE is how many hours of ATTENDED play a full absence is worth, and the sim
 * fails if it exceeds 4. That guard exists because the uncapped version is not a small change —
 * measured on the owner's own save, whose best thieving route pays ~61k gold/hour, twelve hours
 * away would have paid 98% of everything they had earned in 4.5 hours of real play, and the
 * 1,000,000 multi-slot upgrade would fall in under two days of not touching the phone.
 *
 * Combat is excluded by design (the owner's own carve-out) and structurally: startGame already
 * drops combat slots on load, and a fight nobody watched could end the run. */
const OFFLINE_CAP_HOURS = 8;    // a night's sleep pays; a weekend away stops paying at the same cap
const OFFLINE_RATE = 0.3;       /* 🎯 [owner 2026-08-21] "ได้ทรัพยากร 30%" — was 0.5. An unattended
                                 * hour is worth 0.3 attended ones, so a full 8-hour cap is worth at
                                 * most 2.4 hours of actually playing. offline_sim.mjs pins that
                                 * product rather than either number, so the two can move together. */

/* Cumulative XP required to REACH a level.
 * 🎯 [retuned 2026-08-15 from measurement, owner: "เริ่มเล่นง่ายขึ้นเพราะเข้ากลางเกมแล้ว"]
 * The single 1.62 exponent made the curve INVERT past level 20: measured on continuous
 * woodcutting, a level cost 8.2 minutes at L15 but only 5.5 at L40, because stacked mastery
 * and tool speed plus higher-XP actions outgrew the requirement. The late term restores
 * weight (L40 now ~20 minutes) while levels 1-20 are byte-identical to the old formula, so
 * no existing save loses a single level. */
function xpToReach(level) {
  if (level <= 1) return 0;
  const base = 75 * Math.pow(level - 1, 1.62);
  const late = level > 20 ? 40 * Math.pow(level - 20, 2.3) : 0;
  return Math.floor(base + late);
}

function levelFromXp(xp) {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpToReach(level + 1)) level++;
  return level;
}
/* 🎯 [owner 2026-08-17: "ของ คน ก็เช่นกัน เพราะ เราใช้ ระบบ หารครึ่ง"] The level with its progress
 * bar folded in, as one number — level 33 halfway to 34 is 33.5. A rebirth halves THIS rather than
 * the whole number, so an odd level keeps its leftover half as XP instead of losing it. On an odd
 * level, rounding the level down first always throws away half a level. */
function levelExactFromXp(xp) {
  const lv = levelFromXp(xp);
  if (lv >= MAX_LEVEL) return lv;
  const base = xpToReach(lv), next = xpToReach(lv + 1);
  return next > base ? lv + Math.max(0, Math.min(1, (xp - base) / (next - base))) : lv;
}
/* Turn a fractional level back into stored XP. */
function xpAtExactLevel(exact) {
  const lv = Math.max(1, Math.min(MAX_LEVEL, Math.floor(exact)));
  if (lv >= MAX_LEVEL) return xpToReach(MAX_LEVEL);
  const frac = exact <= 1 ? 0 : Math.max(0, Math.min(0.999, exact - lv));
  return Math.floor(xpToReach(lv) + frac * (xpToReach(lv + 1) - xpToReach(lv)));
}

/* Mastery is per-ACTION (each tree, each fishing spot, each recipe levels on its own —
 * the Melvor-style stacking the owner asked for). Cheaper curve, capped at MASTERY_MAX. */
function masteryXpToReach(level) {
  if (level <= 1) return 0;
  return Math.floor(40 * Math.pow(level - 1, 1.5));
}

function masteryLevelFromXp(xp) {
  let level = 1;
  while (level < MASTERY_MAX && xp >= masteryXpToReach(level + 1)) level++;
  return level;
}

/* What a mastery step is worth. 🎯 [broadened 2026-08-15, owner: "ค่าเรท...ควรแมทกับชั้นที่
 * ค่อยๆ อัพเลเวลด้วย"] Mastery used to move only action speed and the rare-drop roll, so a step
 * in ล้วงกระเป๋า or ลำธารน้ำใส felt like nothing. Now EVERY rate a step could sensibly improve
 * does: loot lands more often, junk fouls the line less, and a catch table tilts toward its
 * rarer species. All three are relative to the action's own base numbers, so content added
 * later inherits the scaling without touching the engine. */
const MASTERY_SPEED_PER_LEVEL = 0.007;   // -0.7% action time per step
const MASTERY_LOOT_PER_LEVEL  = 0.016;   // +1.6% relative loot chance per step
const MASTERY_JUNK_PER_LEVEL  = 0.016;   // junk chance shrinks 1.6% per step
const MASTERY_CATCH_PER_LEVEL = 0.013;   // rarer catch-table entries gain weight per step

/* 🎯 [cap raised 50 -> 99, owner 2026-08-17: "ปรับขั้นให้หน่อย ทั้งหมด 99 ขั้น"]
 *
 * Doubling the ranks cannot simply double every bonus — at the old per-step rates, rank 99 would
 * have removed 69% of action time (past the engine's own 70% floor, so tools and perks would stop
 * mattering) and driven junk chance negative.
 *
 * Halving the rates instead would have been worse: anyone already sitting at rank 50 would log in
 * to find their finished masteries suddenly weaker. Nobody should be punished for having played.
 *
 * So the first 49 steps are worth exactly what they always were, and everything past MASTERY_TAIL_FROM
 * counts for a fraction of a step. Rank 50 is untouched, rank 99 is a real but diminishing
 * improvement, and the long tail is the reward for a very long grind rather than a doubling. */
const MASTERY_TAIL_FROM  = 50;
const MASTERY_TAIL_SCALE = 0.35;
function masteryStepsWorth(level) {
  const l = Math.max(1, level);
  return Math.min(l - 1, MASTERY_TAIL_FROM - 1) + Math.max(0, l - MASTERY_TAIL_FROM) * MASTERY_TAIL_SCALE;
}

/* Gear slots, by body position. Items declare `slot`; the equip panel is built from this
 * list, so a future slot (cape, boots, ...) is one line here + items that use it. */
const EQUIP_SLOTS = [
  { id: "head",    name: "หมวก",   icon: "🪖" },
  { id: "body",    name: "เกราะ",  icon: "🥋" },
  { id: "weapon",  name: "อาวุธ",  icon: "🗡️" },
  { id: "offhand", name: "มือรอง", icon: "🛡️" },
  { id: "ring",    name: "แหวน",   icon: "💍" },
  { id: "amulet",  name: "สร้อย",  icon: "📿" },
];

/* Item stat keys: dmg = added damage, def = flat damage reduction (capped in the engine),
 * hpBonus = added max HP. `slot` marks equipment; `heal` marks food. */
const ITEMS = {
  /* gathering */
  wood_oak:      { name: "ไม้โอ๊ค",         icon: "🪵", sell: 2 },
  wood_willow:   { name: "ไม้วิลโลว์เงา",    icon: "🪵", sell: 5 },
  wood_moon:     { name: "ไม้จันทรา",       icon: "🪵", sell: 9 },
  wood_dragon:   { name: "ไม้เกล็ดมังกร",    icon: "🪵", sell: 16 },
  fish_clear:    { name: "ปลาน้ำใส",        icon: "🐟", sell: 2 },
  fish_silver:   { name: "ปลาเงินระยับ",     icon: "🐟", sell: 6 },
  fish_moon:     { name: "ปลาแสงจันทร์",    icon: "🐠", sell: 10 },
  fish_wyrm:     { name: "ปลามังกรน้อย",    icon: "🐉", sell: 19 },
  fish_minnow:   { name: "ปลาซิวแก้ว",       icon: "🐟", sell: 3 },
  fish_frog:     { name: "กบภูเขา",          icon: "🐸", sell: 4 },
  fish_carp:     { name: "ปลาไนเกล็ดเงิน",   icon: "🎏", sell: 8 },
  fish_eel:      { name: "ปลาไหลสายฟ้า",     icon: "🪱", sell: 12 },
  fish_lantern:  { name: "ปลาโคมไฟ",        icon: "🏮", sell: 15 },
  crab_moon:     { name: "ปูจันทรา",         icon: "🦀", sell: 18 },
  fish_ray:      { name: "กระเบนราตรี",      icon: "🥏", sell: 24 },
  octo_night:    { name: "หมึกยักษ์ราตรี",    icon: "🐙", sell: 34 },
  fish_saber:    { name: "ปลาดาบเงา",       icon: "🗡️", sell: 28 },
  squid_emerald: { name: "หมึกมรกต",        icon: "🦑", sell: 40 },
  fish_abyss:    { name: "ปลาผีเหวลึก",     icon: "👻", sell: 55 },
  fish_gold:     { name: "ปลามังกรทอง",     icon: "🐡", sell: 90 },
  ore_stone:     { name: "หินผาโบราณ",      icon: "🪨", sell: 1 },
  ore_copper:    { name: "แร่ทองแดงรุ้ง",    icon: "🟠", sell: 3 },
  ore_iron:      { name: "แร่เหล็กเงา",      icon: "⚙️", sell: 6 },
  ore_mith:      { name: "แร่มิธริลน้ำเงิน",  icon: "🔵", sell: 12 },
  ore_silver:    { name: "แร่เงินบริสุทธิ์",   icon: "⚪", sell: 9 },
  ore_gold:      { name: "แร่ทองคำเปลว",     icon: "🟨", sell: 15 },
  ore_adamant:   { name: "แร่อดามันไทต์",     icon: "🟩", sell: 26 },
  ore_night:     { name: "แร่ราตรีดำ",       icon: "⚫", sell: 20 },
  ore_sun:       { name: "แร่สุริยะ",        icon: "🟡", sell: 32 },
  wood_spirit:   { name: "ไม้วิญญาณโบราณ",   icon: "🎋", sell: 22 },
  wood_solar:    { name: "ไม้สุริยัน",       icon: "🌞", sell: 34 },
  charcoal_spirit: { name: "ถ่านวิญญาณ",     icon: "🟣", sell: 6 },
  charcoal:      { name: "ถ่านไม้มายา",      icon: "⬛", sell: 2 },
  hide_soft:     { name: "หนังสัตว์นุ่ม",     icon: "🟤", sell: 4 },
  hide_thick:    { name: "หนังสัตว์หนา",     icon: "🟫", sell: 9 },
  leather:       { name: "หนังฟอกเวท",      icon: "🧶", sell: 8 },
  bread:         { name: "ขนมปังโฮมเมด",    icon: "🍞", sell: 4, heal: 8 },
  /* meals — heal makes cooking the combat lifeline */
  meal_grill:    { name: "ปลาย่างหอมกรุ่น",  icon: "🍢", sell: 9,  heal: 15 },
  meal_stew:     { name: "สตูว์ปลาเงิน",     icon: "🍲", sell: 20, heal: 30 },
  meal_feast:    { name: "จานแสงจันทร์",    icon: "🍱", sell: 34, heal: 50 },
  meal_royal:    { name: "มื้อราชามังกร",    icon: "👑", sell: 62, heal: 90 },
  meal_saber:    { name: "สเต๊กปลาดาบเงา",   icon: "🥩", sell: 85,  heal: 120 },
  meal_squid:    { name: "หมึกย่างมรกต",     icon: "🍤", sell: 120, heal: 160 },
  meal_abyss:    { name: "ซุปวิญญาณเหวลึก",  icon: "🍜", sell: 165, heal: 220 },
  meal_skewer:   { name: "ไม้ปิ้งรวมมิตร",     icon: "🍡", sell: 12,  heal: 22 },
  meal_soup:     { name: "ต้มยำปลาไน",       icon: "🥘", sell: 26,  heal: 40 },
  meal_crab:     { name: "ปูจันทราอบเกลือ",   icon: "🦞", sell: 52,  heal: 72 },
  meal_octo:     { name: "หมึกผัดพริกไทย",    icon: "🍝", sell: 140, heal: 185 },
  meal_emperor:  { name: "มื้อจักรพรรดิมังกร", icon: "🏮", sell: 260, heal: 300 },
  /* farming — a seed is the input, produce is bulk food. A harvest returns MORE seeds than it
   * consumed on average, so a bought seed is a one-time investment, never a running cost. Produce
   * heals less per bite than a cooked meal by design: farming is the cheap food that keeps you
   * going, cooking stays the burst heal that survives a boss. */
  seed_carrot:   { name: "เมล็ดแครอทแสงจันทร์",  icon: "🌱", sell: 1,  seed: true },
  seed_potato:   { name: "เมล็ดมันหวานราตรี",    icon: "🫘", sell: 2,  seed: true },
  seed_pumpkin:  { name: "เมล็ดฟักทองโคมไฟ",     icon: "🌾", sell: 3,  seed: true },
  seed_grape:    { name: "เมล็ดองุ่นน้ำค้าง",     icon: "🍃", sell: 5,  seed: true },
  seed_melon:    { name: "เมล็ดแตงโมจันทรา",     icon: "🌿", sell: 6,  seed: true },
  seed_berry:    { name: "เมล็ดสตรอว์เบอร์รีเพลิง", icon: "🍀", sell: 9,  seed: true },
  seed_pome:     { name: "เมล็ดทับทิมอมตะ",      icon: "🌰", sell: 14, seed: true },
  seed_star:     { name: "เมล็ดผลไม้ดาวนิรันดร์",  icon: "☘️", sell: 22, seed: true },
  crop_carrot:   { name: "แครอทแสงจันทร์",      icon: "🥕", sell: 2,  heal: 6 },
  crop_potato:   { name: "มันหวานราตรี",        icon: "🍠", sell: 4,  heal: 10 },
  crop_pumpkin:  { name: "ฟักทองโคมไฟ",         icon: "🎃", sell: 6,  heal: 16 },
  crop_grape:    { name: "องุ่นน้ำค้าง",         icon: "🍇", sell: 9,  heal: 24 },
  crop_melon:    { name: "แตงโมจันทรา",         icon: "🍉", sell: 8,  heal: 30 },
  crop_berry:    { name: "สตรอว์เบอร์รีเพลิง",    icon: "🍓", sell: 16, heal: 42 },
  crop_pome:     { name: "ทับทิมอมตะ",          icon: "🍎", sell: 25, heal: 60 },
  crop_star:     { name: "ผลไม้ดาวนิรันดร์",     icon: "🌟", sell: 40, heal: 85 },
  /* rare drops from mastery */
  resin_gold:    { name: "เรซินทองคำ",      icon: "🍯", sell: 25 },
  pearl_deep:    { name: "ไข่มุกน้ำลึก",     icon: "🫧", sell: 30 },
  spice_void:    { name: "เครื่องเทศมิติ",   icon: "✨", sell: 35 },
  star_ore:      { name: "แร่ดาวตก",        icon: "☄️", sell: 40 },
  /* monster drops */
  slime_goo:     { name: "เมือกสไลม์ดาว",   icon: "🔵", sell: 3 },
  horn_shard:    { name: "เศษเขาเดียว",     icon: "🦄", sell: 7 },
  wolf_fang:     { name: "เขี้ยวหมาป่าเงา",  icon: "🦷", sell: 10 },
  spore_glow:    { name: "สปอร์เรืองแสง",   icon: "🍄", sell: 12 },
  twig_cursed:   { name: "กิ่งไม้ต้องสาป",   icon: "🥢", sell: 15 },
  spirit_dust:   { name: "ผงวิญญาณ",        icon: "💫", sell: 22 },
  bat_wing:      { name: "ปีกค้างคาวน้ำแข็ง", icon: "🦇", sell: 18 },
  snow_core:     { name: "แกนหิมะโบราณ",    icon: "❄️", sell: 28 },
  scale_ice:     { name: "เกล็ดมังกรน้ำแข็ง", icon: "🔷", sell: 45 },
  gem_moon:      { name: "อัญมณีจันทรา",    icon: "💎", sell: 120 },
  ember_core:    { name: "แกนเพลิงนิรันดร์",  icon: "🔥", sell: 55 },
  hide_dragon:   { name: "หนังมังกรเพลิง",   icon: "🟥", sell: 40 },
  feather_storm: { name: "ขนนกพายุ",        icon: "🪶", sell: 60 },
  rune_sky:      { name: "รูนเวหา",          icon: "🌀", sell: 150 },
  tome_old:      { name: "คัมภีร์โบราณ",     icon: "📜", sell: 65 },
  /* 🎯 [added 2026-08-15, owner: "ครัวต้องเลือกจะขายหรือใช้เติมเลือด ... อัญมณีควรใช้ให้มีราคา"]
   * Goods exist purely to be sold. They give leatherwork and the jeweller a money route that does
   * NOT compete with keeping food for healing, and they are where gems finally pay: a pendant is
   * worth several times the stone inside it. */
  good_pouch:    { name: "กระเป๋าหนังเย็บมือ",  icon: "👝", sell: 195,   goods: true },
  good_boots:    { name: "รองเท้าหนังนุ่ม",     icon: "👢", sell: 420,   goods: true },
  good_coat:     { name: "เสื้อคลุมหนังมังกร",  icon: "🧥", sell: 1250,  goods: true },
  good_cloak:    { name: "ผ้าคลุมขนนกพายุ",     icon: "🪶", sell: 2800,  goods: true },
  good_earring:  { name: "ต่างหูเงินสลัก",      icon: "🪞", sell: 62,   goods: true },
  good_bangle:   { name: "กำไลทองคำเปลว",       icon: "⭕", sell: 128,  goods: true },
  good_ringmith: { name: "แหวนมิธริลเกลียว",    icon: "💍", sell: 268,  goods: true },
  good_pendant:  { name: "จี้อัญมณีจันทรา",     icon: "🔮", sell: 640,  goods: true },
  good_crownrep: { name: "มงกุฎจำลองฟาโรห์",    icon: "👑", sell: 1500, goods: true },
  bone_ancient:  { name: "กระดูกกาลเวลา",    icon: "🦴", sell: 85 },
  sand_hour:     { name: "ทรายนาฬิกา",      icon: "⌛", sell: 110 },
  crown_shard:   { name: "เศษมงกุฎผุพัง",    icon: "👑", sell: 190 },
  ash_star:      { name: "เถ้าดาวดับ",       icon: "🌑", sell: 240 },
  core_nova:     { name: "แกนโนวา",         icon: "💥", sell: 320 },
  /* junk — atmosphere loot with no recipe use, sold in one sweep from the bag */
  junk_boot:     { name: "รองเท้าบูตเปียก",   icon: "🥾", sell: 1, junk: true },
  junk_can:      { name: "กระป๋องสนิม",       icon: "🥫", sell: 1, junk: true },
  junk_weed:     { name: "สาหร่ายพันเบ็ด",    icon: "🌿", sell: 1, junk: true },
  junk_bone:     { name: "กระดูกปลาเก่า",     icon: "🦴", sell: 2, junk: true },
  junk_bottle:   { name: "ขวดเปล่าไร้สาร",    icon: "🍾", sell: 2, junk: true },
  junk_sock:     { name: "ถุงเท้าข้างเดียว",   icon: "🧦", sell: 1, junk: true },
  junk_key:      { name: "กุญแจไขไม่เข้า",    icon: "🗝️", sell: 3, junk: true },
  junk_letter:   { name: "จดหมายรักผิดซอง",   icon: "💌", sell: 3, junk: true },
  junk_button:   { name: "กระดุมหลุดด้าย",    icon: "🔘", sell: 2, junk: true },
  junk_map:      { name: "แผนที่ขาดครึ่ง",     icon: "🗺️", sell: 5, junk: true },
  /* weapons — the main line follows ORE TIERS (copper -> iron -> mithril); gems appear
   * only in the endgame lance and jewelry, per the owner's 2026-08-15 rebalance */
  spear_oak:     { name: "หอกไม้โอ๊ค",      icon: "🔱", sell: 8,   slot: "weapon", dmg: 3 },
  sword_copper:  { name: "ดาบทองแดงรุ้ง",   icon: "🗡️", sell: 14,  slot: "weapon", dmg: 6 },
  sword_iron:    { name: "ดาบเหล็กเงา",     icon: "⚔️", sell: 38,  slot: "weapon", dmg: 11 },
  sword_mith:    { name: "ดาบมิธริลน้ำเงิน", icon: "🌊", sell: 90,  slot: "weapon", dmg: 22 },
  sword_night:   { name: "ดาบราตรีมืด",     icon: "🌑", sell: 151, slot: "weapon", dmg: 33 },
  sword_sun:     { name: "ดาบสุริยกานต์",    icon: "☀️", sell: 300, slot: "weapon", dmg: 40 },
  sword_eclipse: { name: "ดาบจันทรุปราคา",   icon: "🌘", sell: 480, slot: "weapon", dmg: 48 },
  sword_pharaoh: { name: "ดาบฟาโรห์",       icon: "🔱", sell: 900,  slot: "weapon", dmg: 72 },
  sword_nova:    { name: "ดาบดาวดับ",       icon: "🌟", sell: 1800, slot: "weapon", dmg: 108 },
  sword_fang:    { name: "ดาบเขี้ยวหมาป่า",  icon: "🦷", sell: 45,  slot: "weapon", dmg: 7 },
  blade_moon:    { name: "ดาบแสงจันทร์",    icon: "🌙", sell: 120, slot: "weapon", dmg: 13 },
  lance_dragon:  { name: "ทวนเกล็ดมังกร",   icon: "🐲", sell: 400, slot: "weapon", dmg: 44 },
  /* armor & trinkets */
  helm_copper:   { name: "หมวกทองแดงรุ้ง",   icon: "🪖", sell: 10,  slot: "head",    def: 2 },
  helm_iron:     { name: "หมวกเหล็กเงา",     icon: "⛑️", sell: 22,  slot: "head",    def: 4 },
  armor_copper:  { name: "เกราะทองแดงรุ้ง",  icon: "🦺", sell: 18,  slot: "body",    def: 3 },
  armor_scale:   { name: "เกราะเกล็ดมังกร",  icon: "🐉", sell: 260, slot: "body",    def: 8 },
  shield_oak:    { name: "โล่ไม้โอ๊ค",       icon: "🛡️", sell: 12,  slot: "offhand", def: 2 },
  shield_iron:   { name: "โล่เหล็กเงา",      icon: "🛡️", sell: 13,  slot: "offhand", def: 5 },
  ring_moon:     { name: "แหวนแสงจันทรา",   icon: "💍", sell: 130, slot: "ring",    dmg: 3 },
  ring_noble:    { name: "แหวนตราขุนนาง",    icon: "💠", sell: 90,  slot: "ring",    dmg: 2 },
  /* full armour ladder: ทองแดง -> เหล็ก -> เงิน -> ทอง -> มิธริล -> อดามันไทต์ -> ราตรี -> สุริยะ */
  shield_copper: { name: "โล่ทองแดงรุ้ง", icon: "🛡️", sell: 6, slot: "offhand", def: 2 },
  armor_iron:    { name: "เกราะเหล็กเงา", icon: "🥼", sell: 19, slot: "body", def: 5 },
  helm_silver:   { name: "หมวกเงินบริสุทธิ์", icon: "👒", sell: 18, slot: "head", def: 6 },
  armor_silver:  { name: "เกราะเงินบริสุทธิ์", icon: "🧥", sell: 32, slot: "body", def: 7 },
  shield_silver: { name: "โล่เงินบริสุทธิ์", icon: "🔰", sell: 21, slot: "offhand", def: 6 },
  sword_silver:  { name: "ดาบเงินบริสุทธิ์", icon: "🗡️", sell: 36, slot: "weapon", dmg: 14 },
  helm_gold:     { name: "หมวกทองคำเปลว", icon: "👑", sell: 29, slot: "head", def: 8 },
  armor_gold:    { name: "เกราะทองคำเปลว", icon: "🥇", sell: 52, slot: "body", def: 9 },
  shield_gold:   { name: "โล่ทองคำเปลว", icon: "🛡️", sell: 34, slot: "offhand", def: 8 },
  sword_gold:    { name: "ดาบทองคำเปลว", icon: "⚔️", sell: 58, slot: "weapon", dmg: 18 },
  helm_mith:     { name: "หมวกมิธริล", icon: "🎩", sell: 45, slot: "head", def: 10 },
  armor_mith:    { name: "เกราะมิธริล", icon: "🧿", sell: 81, slot: "body", def: 12 },
  shield_mith:   { name: "โล่มิธริล", icon: "🔷", sell: 54, slot: "offhand", def: 10 },
  helm_adamant:  { name: "หมวกอดามันไทต์", icon: "🪬", sell: 70, slot: "head", def: 12 },
  armor_adamant: { name: "เกราะอดามันไทต์", icon: "🟩", sell: 126, slot: "body", def: 15 },
  shield_adamant:{ name: "โล่อดามันไทต์", icon: "🛡️", sell: 84, slot: "offhand", def: 13 },
  sword_adamant: { name: "ดาบอดามันไทต์", icon: "🔱", sell: 140, slot: "weapon", dmg: 27 },
  armor_night:   { name: "เกราะราตรีมืด", icon: "🌑", sell: 189, slot: "body", def: 18 },
  shield_night:  { name: "โล่ราตรีมืด", icon: "🌘", sell: 126, slot: "offhand", def: 16 },
  helm_sun:      { name: "หมวกสุริยะ", icon: "😎", sell: 150, slot: "head", def: 17 },
  helm_leather:  { name: "หมวกหนังนักล่า",   icon: "🤠", sell: 20,  slot: "head",    def: 1, hpBonus: 8 },
  armor_leather: { name: "เกราะหนังเบา",     icon: "🧥", sell: 45,  slot: "body",    def: 2, hpBonus: 15 },
  amulet_pearl:  { name: "สร้อยไข่มุกลึก",   icon: "📿", sell: 120, slot: "amulet",  hpBonus: 25 },
  helm_night:    { name: "หมวกราตรีมืด",     icon: "🥷", sell: 105,  slot: "head",    def: 14 },
  shield_sun:    { name: "โล่สุริยะ",        icon: "🔆", sell: 180, slot: "offhand", def: 19 },
  armor_sun:     { name: "เกราะสุริยะ",      icon: "🌇", sell: 270, slot: "body",    def: 22 },
  helm_pharaoh:  { name: "หมวกฟาโรห์",      icon: "👑", sell: 420,  slot: "head",    def: 24 },
  shield_pharaoh:{ name: "โล่ฟาโรห์",       icon: "🛡️", sell: 520,  slot: "offhand", def: 28 },
  armor_pharaoh: { name: "เกราะฟาโรห์",     icon: "🏺", sell: 760,  slot: "body",    def: 34 },
  helm_nova:     { name: "หมวกดาวดับ",      icon: "🌌", sell: 850,  slot: "head",    def: 36 },
  shield_nova:   { name: "โล่ดาวดับ",       icon: "🌠", sell: 1050, slot: "offhand", def: 42 },
  armor_nova:    { name: "เกราะดาวดับ",     icon: "💫", sell: 1500, slot: "body",    def: 50 },
  armor_dragonhide: { name: "เกราะหนังมังกรเพลิง", icon: "🧥", sell: 130, slot: "body", def: 5, hpBonus: 30 },
  armor_storm:   { name: "ชุดขนนกพายุ",      icon: "🧣", sell: 300, slot: "body",    def: 6, hpBonus: 50 },
  ring_rune:     { name: "แหวนรูนเวหา",      icon: "🌀", sell: 260, slot: "ring",    dmg: 5 },
  amulet_ember:  { name: "สร้อยแกนเพลิง",    icon: "🧿", sell: 220, slot: "amulet",  hpBonus: 60 },
};

/* Shop upgrades: permanent tool tiers, one skill each, speed bonus stacks with mastery.
 * `requires` forces buying the cheaper tier first so the gold sink has a ladder. */
const SHOP = [
  { id: "axe_iron",    name: "ขวานเหล็กกล้า",   icon: "🪓", skill: "wc", bonus: 0.08, price: 200,  requires: null },
  { id: "axe_mith",    name: "ขวานมิธริล",      icon: "🪓", skill: "wc", bonus: 0.16, price: 900,  requires: "axe_iron" },
  { id: "axe_dragon",  name: "ขวานเพลิงมังกร",  icon: "🪓", skill: "wc", bonus: 0.25, price: 3200, requires: "axe_mith" },
  { id: "rod_bamboo",  name: "เบ็ดไผ่เวทย์",     icon: "🎣", skill: "fi", bonus: 0.08, price: 200,  requires: null },
  { id: "rod_silver",  name: "เบ็ดเงินระยับ",    icon: "🎣", skill: "fi", bonus: 0.16, price: 900,  requires: "rod_bamboo" },
  { id: "rod_kraken",  name: "เบ็ดหนวดคราเคน",  icon: "🎣", skill: "fi", bonus: 0.25, price: 3200, requires: "rod_silver" },
  { id: "pick_iron",   name: "อีเต้อเหล็กกล้า",  icon: "⛏️", skill: "mi", bonus: 0.08, price: 200,  requires: null },
  { id: "pick_mith",   name: "อีเต้อมิธริล",     icon: "⛏️", skill: "mi", bonus: 0.16, price: 900,  requires: "pick_iron" },
  { id: "pick_star",   name: "อีเต้อดาวตก",     icon: "⛏️", skill: "mi", bonus: 0.25, price: 3200, requires: "pick_mith" },
  { id: "pan_copper",  name: "กระทะทองแดง",     icon: "🍳", skill: "ck", bonus: 0.08, price: 200,  requires: null },
  { id: "pan_rune",    name: "กระทะรูน",        icon: "🍳", skill: "ck", bonus: 0.16, price: 900,  requires: "pan_copper" },
  { id: "pan_phoenix", name: "กระทะไฟฟีนิกซ์",  icon: "🍳", skill: "ck", bonus: 0.25, price: 3200, requires: "pan_rune" },
  { id: "can_clay",    name: "บัวรดน้ำดินเผา",  icon: "🚿", skill: "fa", bonus: 0.08, price: 200,  requires: null },
  { id: "can_moon",    name: "บัวรดน้ำแสงจันทร์", icon: "🚿", skill: "fa", bonus: 0.16, price: 900,  requires: "can_clay" },
  { id: "can_rain",    name: "บัวเรียกสายฝน",   icon: "🚿", skill: "fa", bonus: 0.25, price: 3200, requires: "can_moon" },
  { id: "ham_stone",   name: "ค้อนศิลา",        icon: "🔨", skill: "sm", bonus: 0.08, price: 250,  requires: null },
  { id: "ham_rune",    name: "ค้อนรูนโบราณ",    icon: "🔨", skill: "sm", bonus: 0.16, price: 1000, requires: "ham_stone" },
  { id: "ham_star",    name: "ค้อนดาวตก",       icon: "🔨", skill: "sm", bonus: 0.25, price: 3500, requires: "ham_rune" },
  /* tier 4 — spirit tools, the late-game gold sink */
  { id: "axe_spirit",  name: "ขวานวิญญาณป่า",   icon: "🪓", skill: "wc", bonus: 0.32, price: 12000, requires: "axe_dragon" },
  { id: "rod_spirit",  name: "เบ็ดวิญญาณสมุทร", icon: "🎣", skill: "fi", bonus: 0.32, price: 12000, requires: "rod_kraken" },
  { id: "pick_spirit", name: "อีเต้อวิญญาณผา",  icon: "⛏️", skill: "mi", bonus: 0.32, price: 12000, requires: "pick_star" },
  { id: "can_spirit",  name: "บัววิญญาณพฤกษา",  icon: "🚿", skill: "fa", bonus: 0.32, price: 12000, requires: "can_rain" },
  { id: "pan_spirit",  name: "กระทะวิญญาณไฟ",  icon: "🍳", skill: "ck", bonus: 0.32, price: 12000, requires: "pan_phoenix" },
  { id: "ham_spirit",  name: "ค้อนวิญญาณเหล็ก", icon: "🔨", skill: "sm", bonus: 0.32, price: 12000, requires: "ham_star" },
  /* tomes — permanent +10% xp for one skill */
  { id: "tome_wc", name: "คัมภีร์พฤกษา",     icon: "📗", kind: "tome", skill: "wc", value: 0.10, price: 2500 },
  { id: "tome_fi", name: "คัมภีร์วารี",       icon: "📘", kind: "tome", skill: "fi", value: 0.10, price: 2500 },
  { id: "tome_mi", name: "คัมภีร์ศิลา",       icon: "📙", kind: "tome", skill: "mi", value: 0.10, price: 2500 },
  { id: "tome_ck", name: "คัมภีร์รสมายา",     icon: "📕", kind: "tome", skill: "ck", value: 0.10, price: 2500 },
  { id: "tome_fm", name: "คัมภีร์เพลิงสงบ",   icon: "📔", kind: "tome", skill: "fm", value: 0.10, price: 2500 },
  { id: "tome_lw", name: "คัมภีร์เส้นด้าย",    icon: "📒", kind: "tome", skill: "lw", value: 0.10, price: 2500 },
  { id: "tome_th", name: "คัมภีร์เงามืด",     icon: "📓", kind: "tome", skill: "th", value: 0.10, price: 2500 },
  { id: "tome_sm", name: "คัมภีร์โลหะ",       icon: "📖", kind: "tome", skill: "sm", value: 0.10, price: 2500 },
  { id: "tome_fa", name: "คัมภีร์พรรณพฤกษ์",  icon: "📗", kind: "tome", skill: "fa", value: 0.10, price: 2500 },
  /* charms — permanent account-wide effects */
  { id: "charm_luck",  name: "ตาแมวนำโชค",      icon: "🍀", kind: "charm", effect: "luck", value: 0.5,  price: 8000 },
  { id: "charm_gold",  name: "เหรียญพ่อค้าเถื่อน", icon: "🪙", kind: "charm", effect: "gold", value: 0.25, price: 6000 },
  { id: "charm_guard", name: "หินเวทคุ้มกัน",     icon: "🪬", kind: "charm", effect: "def",  value: 3,    price: 5000 },
  { id: "charm_vital", name: "หัวใจโอ๊คโบราณ",   icon: "💗", kind: "charm", effect: "hp",   value: 30,   price: 7000 },
  /* 🎯 [added 2026-08-15] Measured mid-game income is ~30,000 gold/hour while the old top
   * price was 12,000 — the whole shop fell in under an hour. These are the real sinks. */
  { id: "charm_luck2",  name: "ดาวนำโชคจันทรา",  icon: "🌟", kind: "charm", effect: "luck", value: 1.0,  price: 60000,  requires: "charm_luck" },
  { id: "charm_gold2",  name: "ตราชั่งพ่อค้าหลวง", icon: "⚖️", kind: "charm", effect: "gold", value: 0.5,  price: 45000,  requires: "charm_gold" },
  { id: "charm_guard2", name: "โล่วิญญาณบรรพชน",  icon: "🛡️", kind: "charm", effect: "def",  value: 8,    price: 40000,  requires: "charm_guard" },
  { id: "charm_vital2", name: "หัวใจมังกรนิรันดร์", icon: "💖", kind: "charm", effect: "hp",   value: 90,   price: 55000,  requires: "charm_vital" },
  { id: "tome2_wc", name: "มหาคัมภีร์พฤกษา",   icon: "📗", kind: "tome", skill: "wc", value: 0.25, price: 30000, requires: "tome_wc" },
  { id: "tome2_fi", name: "มหาคัมภีร์วารี",     icon: "📘", kind: "tome", skill: "fi", value: 0.25, price: 30000, requires: "tome_fi" },
  { id: "tome2_mi", name: "มหาคัมภีร์ศิลา",     icon: "📙", kind: "tome", skill: "mi", value: 0.25, price: 30000, requires: "tome_mi" },
  { id: "tome2_ck", name: "มหาคัมภีร์รสมายา",   icon: "📕", kind: "tome", skill: "ck", value: 0.25, price: 30000, requires: "tome_ck" },
  { id: "tome2_fm", name: "มหาคัมภีร์เพลิงสงบ", icon: "📔", kind: "tome", skill: "fm", value: 0.25, price: 30000, requires: "tome_fm" },
  { id: "tome2_lw", name: "มหาคัมภีร์เส้นด้าย",  icon: "📒", kind: "tome", skill: "lw", value: 0.25, price: 30000, requires: "tome_lw" },
  { id: "tome2_th", name: "มหาคัมภีร์เงามืด",   icon: "📓", kind: "tome", skill: "th", value: 0.25, price: 30000, requires: "tome_th" },
  { id: "tome2_sm", name: "มหาคัมภีร์โลหะ",     icon: "📖", kind: "tome", skill: "sm", value: 0.25, price: 30000, requires: "tome_sm" },
  { id: "tome2_fa", name: "มหาคัมภีร์พรรณพฤกษ์", icon: "📗", kind: "tome", skill: "fa", value: 0.25, price: 30000, requires: "tome_fa" },
  /* master tools — the last speed tier, priced as a genuine long-term goal */
  { id: "axe_myth",  name: "ขวานตำนานมิธวูด",  icon: "🪓", skill: "wc", bonus: 0.40, price: 90000, requires: "axe_spirit" },
  { id: "rod_myth",  name: "เบ็ดตำนานมิธวูด",   icon: "🎣", skill: "fi", bonus: 0.40, price: 90000, requires: "rod_spirit" },
  { id: "pick_myth", name: "อีเต้อตำนานมิธวูด",  icon: "⛏️", skill: "mi", bonus: 0.40, price: 90000, requires: "pick_spirit" },
  { id: "pan_myth",  name: "กระทะตำนานมิธวูด",  icon: "🍳", skill: "ck", bonus: 0.40, price: 90000, requires: "pan_spirit" },
  { id: "ham_myth",  name: "ค้อนตำนานมิธวูด",   icon: "🔨", skill: "sm", bonus: 0.40, price: 90000, requires: "ham_spirit" },
  /* 🎯 [added 2026-08-15, owner's design] Parallel work slots — deliberately the most expensive
   * things in the game. Prices come from measured income rather than taste: x2 is about a day of
   * mid-game play, and every tier after pays for itself by multiplying output, so the ladder stays
   * long without becoming unreachable. Only ONE slot may hold a fight: HP is shared, so parallel
   * battles would be incoherent. */
  /* 🌻 Plots — the farm's own multiplier. Bought one at a time up to PLOTS_MAX. */
  { id: "plot4", name: "กระถางที่ 4", icon: "🪴", kind: "plot", price: 5000,     requires: null },
  { id: "plot5", name: "กระถางที่ 5", icon: "🪴", kind: "plot", price: 20000,    requires: "plot4" },
  { id: "plot6", name: "กระถางที่ 6", icon: "🪴", kind: "plot", price: 70000,   requires: "plot5" },
  { id: "plot7", name: "กระถางที่ 7", icon: "🪴", kind: "plot", price: 180000,   requires: "plot6" },
  { id: "plot8", name: "กระถางที่ 8", icon: "🪴", kind: "plot", price: 400000,  requires: "plot7" },
  { id: "plot9", name: "กระถางที่ 9", icon: "🪴", kind: "plot", price: 900000,  requires: "plot8" },
  /* 🎯 [owner 2026-08-23] "กดออกล่า มันบอกช่องเต็ม ... ให้เพิ่มการเก็บอีก 10 เท่า"
   *
   * The ceiling now matches what the game actually contains: 9 professions plus one hunt, so the
   * top of this ladder means "everything at once" rather than an arbitrary stop at five. There is
   * no eleventh rung because there is no tenth profession — past this you would only be running a
   * second action of a skill already running.
   *
   * The prices were the real complaint, not the ceiling. The old ladder went 1m → 10m → 60m →
   * 240m — a tenfold jump in cost for the same +1 slot, which is why it stalled dead at two for
   * the owner, who has 1.55m and a rung 3 priced at 10m.
   *
   * A slot is worth what the best job it can run earns. Measured against the owner's own save
   * (ขโมย lv100, ~45,000 💰/ชม.): rung 2 paid for itself in 22 hours of play, rung 3 in 222, and
   * rung 5 in over 1,300. Prices are set from that number now, against the income you actually
   * HAVE when you buy the rung — n-1 slots already running — so payback climbs gently from ~22
   * hours to ~350 across the whole ladder instead of exploding. The band is deliberately measured
   * against fixed per-slot income and therefore reads pessimistic: real income also grows with
   * levels and mastery, so every rung lands sooner than the number says. */
  { id: "multi2",  name: "ทำสองอย่างพร้อมกัน", icon: "⚡", kind: "multi", price: 1000000,   requires: null },
  { id: "multi3",  name: "ทำสามอย่างพร้อมกัน", icon: "⚡", kind: "multi", price: 2800000,   requires: "multi2" },
  { id: "multi4",  name: "ทำสี่อย่างพร้อมกัน",  icon: "⚡", kind: "multi", price: 6000000,   requires: "multi3" },
  { id: "multi5",  name: "ทำห้าอย่างพร้อมกัน",  icon: "⚡", kind: "multi", price: 11000000,  requires: "multi4" },
  { id: "multi6",  name: "ทำหกอย่างพร้อมกัน",   icon: "⚡", kind: "multi", price: 20000000,  requires: "multi5" },
  { id: "multi7",  name: "ทำเจ็ดอย่างพร้อมกัน", icon: "⚡", kind: "multi", price: 34000000,  requires: "multi6" },
  { id: "multi8",  name: "ทำแปดอย่างพร้อมกัน",  icon: "⚡", kind: "multi", price: 55000000,  requires: "multi7" },
  { id: "multi9",  name: "ทำเก้าอย่างพร้อมกัน", icon: "⚡", kind: "multi", price: 90000000,  requires: "multi8" },
  { id: "multi10", name: "ทำสิบอย่างพร้อมกัน",  icon: "⚡", kind: "multi", price: 142000000, requires: "multi9" },
];

/* Every skill is a list of actions: level gate, duration, xp, and what goes in/out.
 * `inputs` missing = gathering skill; present = crafting skill that consumes items.
 * `rare` = mastery-scaled bonus drop: chance = base + perLevel * masteryLevel. */
const SKILLS = [
  {
    id: "wc", name: "ตัดไม้", icon: "🌲", accent: "#5fbf77",
    flavor: "ป่ามายาที่ต้นไม้เรืองแสงยามค่ำ",
    actions: [
      { id: "oak",    name: "ต้นโอ๊คเก่าแก่",    area: "ป่าชายเมือง", level: 1,  seconds: 3.0, xp: 8,  outputs: { wood_oak: 1 },
        rare: { item: "resin_gold", base: 0.003, perLevel: 0.0008 } },
      { id: "willow", name: "วิลโลว์เงาพลิ้ว",   area: "ป่าชายเมือง", level: 5,  seconds: 4.0, xp: 15, outputs: { wood_willow: 1 },
        rare: { item: "resin_gold", base: 0.004, perLevel: 0.0009 } },
      { id: "moon",   name: "ต้นจันทราเรืองแสง", area: "ป่าชายเมือง", level: 12, seconds: 5.2, xp: 28, outputs: { wood_moon: 1 },
        rare: { item: "gem_moon", base: 0.001, perLevel: 0.0004 } },
      { id: "dragon", name: "พฤกษ์เกล็ดมังกร",   area: "ป่าชายเมือง", level: 20, seconds: 6.5, xp: 50, outputs: { wood_dragon: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "spirit", name: "ต้นวิญญาณโบราณ",   area: "ป่าชั้นใน", level: 26, seconds: 7.5, xp: 65,
        masteryReq: { actionId: "dragon", level: 10 },
        outputs: { wood_spirit: 1 },
        rare: [{ item: "resin_gold", base: 0.006, perLevel: 0.0012 },
               { item: "gem_moon", base: 0.003, perLevel: 0.0006 }] },
      { id: "solar",  name: "ต้นสุริยันเรืองรอง", area: "ป่าชั้นใน", level: 36, seconds: 8.5, xp: 95,
        masteryReq: { actionId: "spirit", level: 12 },
        outputs: { wood_solar: 1 },
        rare: { item: "gem_moon", base: 0.004, perLevel: 0.0008 } },
    ],
  },
  {
    id: "fm", name: "เผาถ่าน", icon: "🔥", accent: "#e87f5f",
    flavor: "เตาเผาดินโบราณ — ไม้กลายเป็นถ่านที่เตาหลอมและครัวต้องการ",
    actions: [
      { id: "oak",    name: "เผาไม้โอ๊ค",     area: "เตาดินโบราณ", level: 1,  seconds: 2.6, xp: 7,  inputs: { wood_oak: 1 },
        outputs: { charcoal: 1 }, rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "willow", name: "เผาไม้วิลโลว์",  area: "เตาดินโบราณ", level: 6,  seconds: 3.4, xp: 14, inputs: { wood_willow: 1 },
        outputs: { charcoal: 2 }, rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "moon",   name: "เผาไม้จันทรา",   area: "เตาดินโบราณ", level: 13, seconds: 4.2, xp: 26, inputs: { wood_moon: 1 },
        outputs: { charcoal: 3 }, rare: { item: "gem_moon", base: 0.0015, perLevel: 0.0003 } },
      { id: "dragon", name: "เผาไม้มังกร",    area: "เตาดินโบราณ", level: 20, seconds: 5.2, xp: 45, inputs: { wood_dragon: 1 },
        outputs: { charcoal: 5 }, rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "spirit", name: "เผาไม้วิญญาณ",   area: "เตาวิญญาณ", level: 30, seconds: 6.2, xp: 60,
        masteryReq: { actionId: "dragon", level: 10 },
        inputs: { wood_spirit: 1 }, outputs: { charcoal_spirit: 2 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "solar",  name: "เผาไม้สุริยัน",   area: "เตาวิญญาณ", level: 38, seconds: 7.0, xp: 95,
        masteryReq: { actionId: "spirit", level: 12 },
        inputs: { wood_solar: 1 }, outputs: { charcoal_spirit: 4 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
    ],
  },
  {
    id: "fi", name: "ตกปลา", icon: "🎣", accent: "#5fa8e8",
    flavor: "จากลำธารหมู่บ้านสู่เหวลึกพราวดาว — ยิ่งชำนาญ ยิ่งได้ปลาแพงและของดี",
    actions: [
      { id: "clear",  name: "ลำธารน้ำใส",      area: "ลำธารหมู่บ้าน", level: 1,  seconds: 3.5, xp: 9,
        catch: [{ item: "fish_clear", w: 62 }, { item: "fish_minnow", w: 26 }, { item: "fish_frog", w: 12 }], junk: 0.16,
        rare: { item: "pearl_deep", base: 0.003, perLevel: 0.0008 } },
      { id: "silver", name: "วังปลาเงิน",       area: "ลำธารหมู่บ้าน", level: 6,  seconds: 4.6, xp: 17,
        catch: [{ item: "fish_silver", w: 58 }, { item: "fish_carp", w: 28 }, { item: "fish_eel", w: 14 }], junk: 0.13,
        rare: [{ item: "pearl_deep", base: 0.004, perLevel: 0.0009 },
               { item: "gem_moon", base: 0.0015, perLevel: 0.0003 }] },
      { id: "moon",   name: "อ่าวแสงจันทร์",    area: "ทะเลสาบแสงจันทร์", level: 14, seconds: 5.8, xp: 32,
        catch: [{ item: "fish_moon", w: 56 }, { item: "fish_lantern", w: 30 }, { item: "crab_moon", w: 14 }], junk: 0.10,
        rare: { item: "gem_moon", base: 0.001, perLevel: 0.0004 } },
      { id: "wyrm",   name: "เหวมังกรหลับ",     area: "ทะเลสาบแสงจันทร์", level: 22, seconds: 7.2, xp: 55,
        catch: [{ item: "fish_wyrm", w: 55 }, { item: "fish_ray", w: 30 }, { item: "octo_night", w: 15 }], junk: 0.09,
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "saber",  name: "ร่องน้ำปลาดาบ",    area: "ทะเลลึกพราวดาว", level: 26, seconds: 8.0, xp: 70,
        masteryReq: { actionId: "wyrm", level: 12 },
        catch: [{ item: "fish_saber", w: 58 }, { item: "fish_lantern", w: 24 }, { item: "octo_night", w: 18 }], junk: 0.07,
        rare: [{ item: "pearl_deep", base: 0.005, perLevel: 0.001 },
               { item: "gem_moon", base: 0.003, perLevel: 0.0006 }] },
      { id: "squid",  name: "ดงหมึกมรกต",       area: "ทะเลลึกพราวดาว", level: 30, seconds: 8.8, xp: 90,
        masteryReq: { actionId: "saber", level: 12 },
        catch: [{ item: "squid_emerald", w: 60 }, { item: "fish_ray", w: 25 }, { item: "crab_moon", w: 15 }], junk: 0.06,
        rare: { item: "gem_moon", base: 0.004, perLevel: 0.0007 } },
      { id: "abyss",  name: "เหวลึกพราวดาว",    area: "ทะเลลึกพราวดาว", level: 35, seconds: 9.6, xp: 115,
        masteryReq: { actionId: "squid", level: 15 },
        catch: [{ item: "fish_abyss", w: 55 }, { item: "octo_night", w: 22 }, { item: "fish_saber", w: 15 },
                { item: "pearl_deep", w: 8 }], junk: 0.05,
        rare: [{ item: "gem_moon", base: 0.005, perLevel: 0.0008 },
               { item: "pearl_deep", base: 0.006, perLevel: 0.001 }] },
      { id: "golden", name: "วังปลามังกรทอง",   area: "ตำนานใต้สมุทร", level: 42, seconds: 10.5, xp: 150,
        masteryReq: { actionId: "abyss", level: 15 },
        catch: [{ item: "fish_gold", w: 52 }, { item: "fish_abyss", w: 28 }, { item: "squid_emerald", w: 12 },
                { item: "pearl_deep", w: 8 }], junk: 0.04,
        rare: [{ item: "gem_moon", base: 0.007, perLevel: 0.001 },
               { item: "pearl_deep", base: 0.008, perLevel: 0.0012 }] },
    ],
  },
  {
    id: "mi", name: "ขุดแร่", icon: "💎", accent: "#8fd0e8",
    flavor: "เหมืองผลึกที่ก้องเสียงสะท้อนจากใต้พิภพ — ไล่สายแร่จากผาตื้นสู่ใจพิภพ",
    actions: [
      { id: "stone",   name: "ผาหินโบราณ",       area: "เหมืองปากผา", level: 1,  seconds: 2.8, xp: 6,
        outputs: { ore_stone: 1 }, junk: 0.12,
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "copper",  name: "สายแร่ทองแดงรุ้ง",  area: "เหมืองปากผา", level: 4,  seconds: 3.6, xp: 13,
        outputs: { ore_copper: 1 }, junk: 0.10,
        rare: [{ item: "star_ore", base: 0.003, perLevel: 0.0007 },
               { item: "gem_moon", base: 0.0015, perLevel: 0.0003 }] },
      { id: "iron",    name: "สายแร่เหล็กเงา",    area: "เหมืองปากผา", level: 10, seconds: 4.4, xp: 24,
        outputs: { ore_iron: 1 }, junk: 0.08,
        rare: [{ item: "star_ore", base: 0.004, perLevel: 0.0008 },
               { item: "gem_moon", base: 0.002, perLevel: 0.0004 }] },
      { id: "silver",  name: "สายแร่เงินบริสุทธิ์", area: "เหมืองชั้นกลาง", level: 16, seconds: 5.0, xp: 36,
        masteryReq: { actionId: "iron", level: 8 },
        outputs: { ore_silver: 1 }, junk: 0.07,
        rare: [{ item: "star_ore", base: 0.004, perLevel: 0.0008 },
               { item: "gem_moon", base: 0.002, perLevel: 0.0005 }] },
      { id: "gold",    name: "สายแร่ทองคำเปลว",   area: "เหมืองชั้นกลาง", level: 22, seconds: 5.6, xp: 50,
        masteryReq: { actionId: "silver", level: 8 },
        outputs: { ore_gold: 1 }, junk: 0.06,
        rare: [{ item: "star_ore", base: 0.005, perLevel: 0.0009 },
               { item: "gem_moon", base: 0.003, perLevel: 0.0006 }] },
      { id: "mith",    name: "สายแร่มิธริล",      area: "เหมืองชั้นกลาง", level: 28, seconds: 6.2, xp: 68,
        masteryReq: { actionId: "gold", level: 10 },
        outputs: { ore_mith: 1 }, junk: 0.05,
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "adamant", name: "สายแร่อดามันไทต์",   area: "เหมืองใจพิภพ", level: 34, seconds: 7.0, xp: 90,
        masteryReq: { actionId: "mith", level: 10 },
        outputs: { ore_adamant: 1 }, junk: 0.04,
        rare: [{ item: "star_ore", base: 0.006, perLevel: 0.001 },
               { item: "gem_moon", base: 0.004, perLevel: 0.0007 }] },
      { id: "night",   name: "สายแร่ราตรีดำ",     area: "เหมืองใจพิภพ", level: 40, seconds: 7.6, xp: 115,
        masteryReq: { actionId: "adamant", level: 12 },
        outputs: { ore_night: 1 }, junk: 0.03,
        rare: [{ item: "star_ore", base: 0.006, perLevel: 0.001 },
               { item: "gem_moon", base: 0.004, perLevel: 0.0008 }] },
      { id: "sun",     name: "สายแร่สุริยะ",      area: "เหมืองใจพิภพ", level: 46, seconds: 8.4, xp: 145,
        masteryReq: { actionId: "night", level: 12 },
        outputs: { ore_sun: 1 }, junk: 0.02,
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
    ],
  },
  {
    id: "ck", name: "ครัวเวทมนตร์", icon: "🍜", accent: "#e8a05f",
    flavor: "เตาไฟที่ไม่เคยดับ กลิ่นหอมข้ามมิติ — อาหารคือยาเลือดของนักล่า",
    actions: [
      { id: "grill", name: "ย่างปลาน้ำใส",    area: "เตาแคมป์", level: 1,  seconds: 3.2, xp: 12,
        inputs: { wood_oak: 1, fish_clear: 1 },     outputs: { meal_grill: 1 },
        rare: { item: "spice_void", base: 0.003, perLevel: 0.0008 } },
      { id: "stew",  name: "ตุ๋นสตูว์ปลาเงิน", area: "เตาแคมป์", level: 8,  seconds: 4.8, xp: 24,
        inputs: { charcoal: 1, fish_silver: 1 },    outputs: { meal_stew: 1 },
        rare: { item: "spice_void", base: 0.004, perLevel: 0.0009 } },
      { id: "feast", name: "จัดจานแสงจันทร์",  area: "เตาแคมป์", level: 16, seconds: 6.0, xp: 42,
        inputs: { charcoal: 2, fish_moon: 1 },      outputs: { meal_feast: 1 },
        rare: { item: "spice_void", base: 0.005, perLevel: 0.001 } },
      { id: "royal", name: "มื้อราชามังกร",    area: "เตาแคมป์", level: 24, seconds: 7.5, xp: 70,
        inputs: { charcoal: 3, fish_wyrm: 1 },      outputs: { meal_royal: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "skewer", name: "ไม้ปิ้งปลาซิว-กบ",     area: "เมนูบ้าน ๆ", level: 4,  seconds: 3.4, xp: 15,
        inputs: { wood_oak: 1, fish_minnow: 1, fish_frog: 1 }, outputs: { meal_skewer: 1 },
        rare: { item: "spice_void", base: 0.002, perLevel: 0.0006 } },
      { id: "soup",  name: "ต้มยำปลาไนเกล็ดเงิน", area: "เมนูบ้าน ๆ", level: 10, seconds: 4.4, xp: 26,
        inputs: { charcoal: 1, fish_carp: 1 },      outputs: { meal_soup: 1 },
        rare: { item: "spice_void", base: 0.003, perLevel: 0.0008 } },
      { id: "crab",  name: "ปูจันทราอบเกลือ",     area: "เมนูบ้าน ๆ", level: 18, seconds: 5.6, xp: 46,
        inputs: { charcoal: 2, crab_moon: 1 },      outputs: { meal_crab: 1 },
        rare: { item: "spice_void", base: 0.004, perLevel: 0.0009 } },
      { id: "saber", name: "ย่างสเต๊กปลาดาบ",   area: "เมนูทะเลลึก", level: 27, seconds: 8.2, xp: 95,
        masteryReq: { actionId: "royal", level: 10 },
        inputs: { charcoal: 3, fish_saber: 1 },     outputs: { meal_saber: 1 },
        rare: { item: "spice_void", base: 0.005, perLevel: 0.001 } },
      { id: "octo",  name: "หมึกยักษ์ผัดพริกไทย",  area: "เมนูทะเลลึก", level: 30, seconds: 8.6, xp: 108,
        inputs: { charcoal_spirit: 1, octo_night: 1 }, outputs: { meal_octo: 1 },
        rare: { item: "spice_void", base: 0.005, perLevel: 0.001 } },
      { id: "squid", name: "ย่างหมึกมรกต",      area: "เมนูทะเลลึก", level: 31, seconds: 9.0, xp: 120,
        masteryReq: { actionId: "saber", level: 12 },
        inputs: { charcoal: 4, squid_emerald: 1 },  outputs: { meal_squid: 1 },
        rare: { item: "spice_void", base: 0.006, perLevel: 0.0012 } },
      { id: "abyss", name: "ต้มซุปวิญญาณเหวลึก", area: "เมนูทะเลลึก", level: 36, seconds: 9.8, xp: 150,
        masteryReq: { actionId: "squid", level: 15 },
        inputs: { charcoal: 5, fish_abyss: 1 },     outputs: { meal_abyss: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "emperor", name: "จัดมื้อจักรพรรดิมังกร", area: "ครัวหลวง", level: 42, seconds: 10.5, xp: 190,
        masteryReq: { actionId: "abyss", level: 15 },
        inputs: { charcoal_spirit: 2, fish_gold: 1 }, outputs: { meal_emperor: 1 },
        rare: { item: "gem_moon", base: 0.004, perLevel: 0.0008 } },
    ],
  },
  {
    id: "lw", name: "ช่างหนัง", icon: "🧵", accent: "#c8a878",
    flavor: "โรงฟอกหนังหอมกลิ่นเครื่องเทศ — หนังจากสนามล่ากลายเป็นชุดเบาคล่องตัว",
    actions: [
      { id: "tan",   name: "ฟอกหนังนุ่ม",     area: "โรงฟอกหนัง", level: 1,  seconds: 3.5, xp: 18, inputs: { hide_soft: 2, slime_goo: 1 },
        outputs: { leather: 2 }, rare: { item: "spice_void", base: 0.002, perLevel: 0.0006 } },
      { id: "helm",  name: "เย็บหมวกหนังนักล่า", area: "โรงฟอกหนัง", level: 5,  seconds: 5.0, xp: 40, inputs: { leather: 3 },
        outputs: { helm_leather: 1 }, rare: { item: "spice_void", base: 0.003, perLevel: 0.0007 } },
      { id: "armor", name: "เย็บเกราะหนังเบา",  area: "โรงฟอกหนัง", level: 10, seconds: 6.5, xp: 70, inputs: { leather: 5, hide_thick: 1 },
        outputs: { armor_leather: 1 }, rare: { item: "gem_moon", base: 0.0015, perLevel: 0.0004 } },
      { id: "dragonhide", name: "เย็บเกราะหนังมังกรเพลิง", area: "ช่างหลวง", level: 20, seconds: 8.0, xp: 120,
        masteryReq: { actionId: "armor", level: 10 },
        inputs: { hide_dragon: 4, leather: 4 }, outputs: { armor_dragonhide: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "storm", name: "ถักชุดขนนกพายุ",   area: "ช่างหลวง", level: 30, seconds: 9.5, xp: 170,
        masteryReq: { actionId: "dragonhide", level: 12 },
        inputs: { feather_storm: 5, leather: 6 }, outputs: { armor_storm: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "g_pouch", name: "เย็บกระเป๋าหนัง",      area: "งานขาย", level: 3,  seconds: 4.0, xp: 22,
        inputs: { leather: 2 },                            outputs: { good_pouch: 1 },
        rare: { item: "spice_void", base: 0.002, perLevel: 0.0006 } },
      { id: "g_boots", name: "ตัดรองเท้าหนัง",       area: "งานขาย", level: 8,  seconds: 5.0, xp: 40,
        inputs: { leather: 3, hide_thick: 1 },             outputs: { good_boots: 1 },
        rare: { item: "spice_void", base: 0.003, perLevel: 0.0007 } },
      { id: "g_coat",  name: "ตัดเสื้อคลุมหนังมังกร", area: "งานขาย", level: 18, seconds: 6.5, xp: 85,
        inputs: { leather: 4, hide_dragon: 2 },            outputs: { good_coat: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "g_cloak", name: "ถักผ้าคลุมขนนกพายุ",   area: "งานขาย", level: 28, seconds: 8.0, xp: 150,
        inputs: { leather: 5, feather_storm: 3 },          outputs: { good_cloak: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
    ],
  },
  {
    id: "fa", name: "ทำสวน", icon: "🌻", accent: "#7cc47f", farming: true,
    flavor: "แปลงดินใต้แสงจันทร์ — ปลูกทิ้งไว้ แล้วกลับมาเก็บทีเดียวทั้งสวน",
    actions: [
      { id: "carrot",  name: "แครอทแสงจันทร์",   area: "แปลงหลังบ้าน", level: 1,  seconds: 50,  xp: 22,
        inputs: { seed_carrot: 1 },  outputs: { crop_carrot: 5 },  seedBack: [1, 3] },
      { id: "potato",  name: "มันหวานราตรี",     area: "แปลงหลังบ้าน", level: 8,  seconds: 80,  xp: 40,
        inputs: { seed_potato: 1 },  outputs: { crop_potato: 6 },  seedBack: [1, 3] },
      { id: "pumpkin", name: "ฟักทองโคมไฟ",      area: "แปลงหลังบ้าน", level: 16, seconds: 120, xp: 70,
        inputs: { seed_pumpkin: 1 }, outputs: { crop_pumpkin: 8 }, seedBack: [2, 4] },
      { id: "grape",   name: "องุ่นน้ำค้าง",      area: "สวนผลไม้จันทรา", level: 24, seconds: 170, xp: 110,
        inputs: { seed_grape: 1 },   outputs: { crop_grape: 10 },  seedBack: [2, 4] },
      { id: "melon",   name: "แตงโมจันทรา",      area: "สวนผลไม้จันทรา", level: 30, seconds: 240, xp: 170,
        masteryReq: { actionId: "grape", level: 8 },
        inputs: { seed_melon: 1 },   outputs: { crop_melon: 20 },  seedBack: [2, 5] },
      { id: "berry",   name: "สตรอว์เบอร์รีเพลิง", area: "สวนผลไม้จันทรา", level: 36, seconds: 420, xp: 320,
        masteryReq: { actionId: "melon", level: 10 },
        inputs: { seed_berry: 1 },   outputs: { crop_berry: 23 },  seedBack: [2, 5] },
      { id: "pome",    name: "ทับทิมอมตะ",       area: "เรือนกระจกดาว", level: 42, seconds: 560, xp: 440,
        masteryReq: { actionId: "berry", level: 12 },
        inputs: { seed_pome: 1 },    outputs: { crop_pome: 25 },   seedBack: [2, 5] },
      { id: "star",    name: "ผลไม้ดาวนิรันดร์",  area: "เรือนกระจกดาว", level: 50, seconds: 720, xp: 620,
        masteryReq: { actionId: "pome", level: 15 },
        inputs: { seed_star: 1 },    outputs: { crop_star: 26 },   seedBack: [3, 6] },
    ],
  },
  {
    id: "th", name: "ขโมยของ", icon: "🕵️", accent: "#e88fb8",
    flavor: "ย่องเบาในตลาดเมืองจันทรา — มือไวได้ทอง มือพลาดได้แผล",
    actions: [
      { id: "villager", name: "ล้วงกระเป๋าชาวบ้าน",  area: "ตลาดเมืองจันทรา", level: 1,  seconds: 3.0, xp: 10,
        steal: { junk: 0.3, success: 0.8, failDmg: 3,  gold: [4, 12],
                 loot: [{ item: "bread", chance: 0.3, n: [1, 1] }] } },
      { id: "merchant", name: "ย่องหลังพ่อค้าเร่",   area: "ตลาดเมืองจันทรา", level: 7,  seconds: 3.6, xp: 20,
        steal: { junk: 0.25, success: 0.72, failDmg: 6,  gold: [10, 26],
                 loot: [{ item: "ore_copper", chance: 0.25, n: [1, 2] }] } },
      { id: "jeweler",  name: "เจาะร้านพ่อค้าอัญมณี", area: "ตลาดเมืองจันทรา", level: 15, seconds: 4.4, xp: 38,
        steal: { junk: 0.18, success: 0.65, failDmg: 12, gold: [22, 55],
                 loot: [{ item: "gem_moon", chance: 0.04, n: [1, 1] }] } },
      { id: "noble",    name: "แทรกซึมคฤหาสน์ขุนนาง", area: "ตลาดเมืองจันทรา", level: 23, seconds: 5.2, xp: 62,
        steal: { junk: 0.12, success: 0.6, failDmg: 20, gold: [45, 110],
                 loot: [{ item: "ring_noble", chance: 0.03, n: [1, 1] }] } },
      { id: "taxvault", name: "ปล้นคลังภาษีตลาด", area: "ตลาดเมืองจันทรา", level: 31, seconds: 5.6, xp: 115,
        masteryReq: { actionId: "noble", level: 12 },
        steal: { success: 0.62, failDmg: 22, gold: [55, 106],
                 loot: [{ item: "ring_noble", chance: 0.1, n: [1, 1] }, { item: "gem_moon", chance: 0.04, n: [1, 1] }] } },
      { id: "slimenest", name: "ย่องเก็บรังสไลม์",    area: "บุกรังมอนสเตอร์", level: 5,  seconds: 3.2, xp: 14,
        masteryReq: { actionId: "villager", level: 8 },
        steal: { junk: 0.28, success: 0.78, failDmg: 4,  gold: [2, 8],
                 loot: [{ item: "slime_goo", chance: 0.55, n: [1, 3] }, { item: "gem_moon", chance: 0.005, n: [1, 1] }] } },
      { id: "wolfnest",  name: "ขโมยจากรังหมาป่า",   area: "บุกรังมอนสเตอร์", level: 12, seconds: 3.8, xp: 30,
        masteryReq: { actionId: "slimenest", level: 10 },
        steal: { junk: 0.22, success: 0.7, failDmg: 8,  gold: [6, 16],
                 loot: [{ item: "hide_soft", chance: 0.5, n: [1, 2] }, { item: "wolf_fang", chance: 0.35, n: [1, 2] }] } },
      { id: "golemcave", name: "ล้วงแกนโกเลมหิมะ",   area: "บุกรังมอนสเตอร์", level: 20, seconds: 4.6, xp: 52,
        masteryReq: { actionId: "wolfnest", level: 12 },
        steal: { success: 0.66, failDmg: 15, gold: [12, 30],
                 loot: [{ item: "snow_core", chance: 0.35, n: [1, 1] }, { item: "ore_mith", chance: 0.2, n: [1, 2] }] } },
      { id: "dragonnest", name: "ฉกสมบัติรังมังกร",   area: "บุกรังมอนสเตอร์", level: 28, seconds: 5.6, xp: 85,
        masteryReq: { actionId: "golemcave", level: 15 },
        steal: { success: 0.6, failDmg: 24, gold: [30, 70],
                 loot: [{ item: "scale_ice", chance: 0.4, n: [1, 2] }, { item: "gem_moon", chance: 0.06, n: [1, 1] }] } },
      /* ⚠️ feather_storm is deliberately rare here. At a 30% drop this nest became a cheap supply
       * line for ผ้าคลุมขนนกพายุ, and econ_report measured the leather line jumping 39,136 -> 79,552/hr
       * — a stealing action quietly rebalancing a crafting line it has nothing to do with. Any new
       * drop that feeds a recipe has to be checked against the true-cost model, not just eyeballed. */
      { id: "stormnest", name: "ล้วงรังนกอินทรีพายุ", area: "บุกรังมอนสเตอร์", level: 36, seconds: 5.8, xp: 132,
        masteryReq: { actionId: "dragonnest", level: 10 },
        steal: { success: 0.6, failDmg: 28, gold: [63, 122],
                 loot: [{ item: "feather_storm", chance: 0.06, n: [1, 2] }, { item: "ash_star", chance: 0.02, n: [1, 1] }] } },
      { id: "icelair", name: "ปล้นถ้ำมังกรน้ำแข็ง", area: "บุกรังมอนสเตอร์", level: 44, seconds: 6.2, xp: 160,
        masteryReq: { actionId: "stormnest", level: 10 },
        steal: { success: 0.56, failDmg: 32, gold: [83, 160],
                 loot: [{ item: "scale_ice", chance: 0.28, n: [1, 2] }, { item: "armor_dragonhide", chance: 0.02, n: [1, 1] }] } },
      { id: "apprentice", name: "ล้วงย่ามศิษย์เวท",    area: "หอคอยจอมเวท", level: 26, seconds: 4.8, xp: 58,
        masteryReq: { actionId: "jeweler", level: 12 },
        steal: { success: 0.68, failDmg: 16, gold: [25, 60],
                 loot: [{ item: "tome_old", chance: 0.25, n: [1, 1] }] } },
      { id: "library", name: "ย่องห้องสมุดต้องห้าม",  area: "หอคอยจอมเวท", level: 32, seconds: 5.4, xp: 90,
        masteryReq: { actionId: "apprentice", level: 12 },
        steal: { success: 0.64, failDmg: 24, gold: [40, 90],
                 loot: [{ item: "tome_old", chance: 0.45, n: [1, 2] }, { item: "gem_moon", chance: 0.03, n: [1, 1] }] } },
      { id: "spire", name: "ฉกของยอดหอคอยจอมเวท", area: "หอคอยจอมเวท", level: 40, seconds: 6.2, xp: 140,
        masteryReq: { actionId: "library", level: 15 },
        steal: { success: 0.58, failDmg: 34, gold: [70, 160],
                 loot: [{ item: "rune_sky", chance: 0.06, n: [1, 1] }, { item: "gem_moon", chance: 0.08, n: [1, 1] }] } },
      { id: "archmage", name: "ฉกคทาอาจารย์ใหญ่", area: "หอคอยจอมเวท", level: 48, seconds: 6.6, xp: 173,
        masteryReq: { actionId: "spire", level: 12 },
        steal: { success: 0.54, failDmg: 38, gold: [94, 182],
                 loot: [{ item: "rune_sky", chance: 0.12, n: [1, 1] }, { item: "gem_moon", chance: 0.1, n: [1, 1] }] } },
      { id: "sailor", name: "ตัดถุงเงินกะลาสี", area: "ท่าเรือและกองคาราวาน", level: 18, seconds: 4.2, xp: 71,
        steal: { junk: 0.25, success: 0.72, failDmg: 14, gold: [24, 47],
                 loot: [{ item: "fish_gold", chance: 0.12, n: [1, 1] }] } },
      { id: "hold", name: "งัดหีบสินค้าใต้ท้องเรือ", area: "ท่าเรือและกองคาราวาน", level: 27, seconds: 4.8, xp: 102,
        masteryReq: { actionId: "sailor", level: 8 },
        steal: { junk: 0.2, success: 0.68, failDmg: 18, gold: [37, 72],
                 loot: [{ item: "amulet_pearl", chance: 0.05, n: [1, 1] }, { item: "hide_soft", chance: 0.2, n: [1, 2] }] } },
      { id: "caravan", name: "ปล้นกองคาราวานทะเลทราย", area: "ท่าเรือและกองคาราวาน", level: 35, seconds: 5.6, xp: 129,
        masteryReq: { actionId: "hold", level: 10 },
        steal: { success: 0.62, failDmg: 26, gold: [58, 113],
                 loot: [{ item: "sand_hour", chance: 0.1, n: [1, 1] }, { item: "gem_moon", chance: 0.05, n: [1, 1] }] } },
      { id: "customs", name: "ย่องด่านศุลกากรหลวง", area: "ท่าเรือและกองคาราวาน", level: 43, seconds: 6.0, xp: 156,
        masteryReq: { actionId: "caravan", level: 12 },
        steal: { success: 0.58, failDmg: 30, gold: [76, 148],
                 loot: [{ item: "crown_shard", chance: 0.06, n: [1, 1] }, { item: "ring_moon", chance: 0.05, n: [1, 1] }] } },
      { id: "handmaid", name: "ล้วงเครื่องประดับนางกำนัล", area: "เขตพระราชวัง", level: 52, seconds: 6.2, xp: 187,
        masteryReq: { actionId: "customs", level: 12 },
        steal: { success: 0.56, failDmg: 34, gold: [86, 166],
                 loot: [{ item: "good_earring", chance: 0.16, n: [1, 1] }, { item: "good_bangle", chance: 0.06, n: [1, 1] }] } },
      { id: "kitchenroyal", name: "เจาะห้องเครื่องต้น", area: "เขตพระราชวัง", level: 60, seconds: 6.6, xp: 214,
        masteryReq: { actionId: "handmaid", level: 12 },
        steal: { success: 0.52, failDmg: 40, gold: [102, 198],
                 loot: [{ item: "meal_emperor", chance: 0.14, n: [1, 1] }, { item: "good_pouch", chance: 0.05, n: [1, 1] }] } },
      { id: "treasury", name: "ฉกมงกุฎสำรองท้องพระคลัง", area: "เขตพระราชวัง", level: 68, seconds: 7.0, xp: 241,
        masteryReq: { actionId: "kitchenroyal", level: 14 },
        steal: { success: 0.48, failDmg: 46, gold: [120, 233],
                 loot: [{ item: "crown_shard", chance: 0.12, n: [1, 1] }, { item: "good_pendant", chance: 0.03, n: [1, 1] }] } },
      { id: "graveoffer", name: "รื้อเครื่องเซ่นหลุมศพ", area: "สุสานและซากปรักหักพัง", level: 56, seconds: 6.0, xp: 200,
        masteryReq: { actionId: "archmage", level: 10 },
        steal: { junk: 0.2, success: 0.58, failDmg: 36, gold: [82, 159],
                 loot: [{ item: "bone_ancient", chance: 0.28, n: [1, 2] }, { item: "tome_old", chance: 0.12, n: [1, 1] }] } },
      { id: "kingtomb", name: "ย่องสุสานกษัตริย์เก่า", area: "สุสานและซากปรักหักพัง", level: 64, seconds: 6.6, xp: 228,
        masteryReq: { actionId: "graveoffer", level: 12 },
        steal: { success: 0.52, failDmg: 44, gold: [103, 200],
                 loot: [{ item: "ring_rune", chance: 0.05, n: [1, 1] }, { item: "armor_scale", chance: 0.02, n: [1, 1] }] } },
      { id: "lichcoffin", name: "ปล้นหีบศพนักบวชลิช", area: "สุสานและซากปรักหักพัง", level: 72, seconds: 7.0, xp: 255,
        masteryReq: { actionId: "kingtomb", level: 12 },
        steal: { success: 0.48, failDmg: 50, gold: [121, 235],
                 loot: [{ item: "ash_star", chance: 0.1, n: [1, 1] }, { item: "rune_sky", chance: 0.06, n: [1, 1] }] } },
      { id: "underaltar", name: "ล้วงแท่นบูชาใต้พิภพ", area: "สุสานและซากปรักหักพัง", level: 80, seconds: 7.4, xp: 282,
        masteryReq: { actionId: "lichcoffin", level: 14 },
        steal: { success: 0.44, failDmg: 56, gold: [141, 274],
                 loot: [{ item: "core_nova", chance: 0.07, n: [1, 1] }, { item: "ash_star", chance: 0.12, n: [1, 1] }] } },
      { id: "starvault", name: "ย่องคลังสมบัติดาวดับ", area: "แดนดาวดับ", level: 88, seconds: 7.6, xp: 309,
        masteryReq: { actionId: "underaltar", level: 15 },
        steal: { success: 0.42, failDmg: 64, gold: [154, 299],
                 loot: [{ item: "core_nova", chance: 0.12, n: [1, 1] }, { item: "ash_star", chance: 0.16, n: [1, 2] }] } },
    ],
  },
  {
    id: "sm", name: "ช่างตีเหล็ก", icon: "🪨", accent: "#c08fe8",
    flavor: "โรงตีเหล็กที่เปลวไฟร้องเพลง — ไล่บันไดแร่ทีละขั้น ครบชุดเมื่อไรได้โบนัสเซ็ต",
    actions: [
      { id: "spear",   name: "ตีหอกไม้โอ๊ค",       area: "งานฝึกหัด", level: 1,  seconds: 4.0, xp: 22,
        inputs: { wood_oak: 5 },                              outputs: { spear_oak: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "shield0", name: "ประกอบโล่ไม้โอ๊ค",     area: "งานฝึกหัด", level: 5,  seconds: 4.5, xp: 30,
        inputs: { wood_oak: 6, ore_stone: 3 },                outputs: { shield_oak: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },

      { id: "helm_copper", name: "ตีหมวกทองแดงรุ้ง", area: "สายทองแดงรุ้ง", level: 3, seconds: 4.5, xp: 28,
        inputs: { ore_copper: 4, charcoal: 1 }, outputs: { helm_copper: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "sword_copper", name: "ตีดาบทองแดงรุ้ง", area: "สายทองแดงรุ้ง", level: 4, seconds: 4.5, xp: 32,
        inputs: { ore_copper: 5, charcoal: 1 }, outputs: { sword_copper: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "shield_copper", name: "ตีโล่ทองแดงรุ้ง", area: "สายทองแดงรุ้ง", level: 5, seconds: 4.5, xp: 36,
        inputs: { ore_copper: 4, charcoal: 1 }, outputs: { shield_copper: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "body_copper", name: "ตีเกราะทองแดงรุ้ง", area: "สายทองแดงรุ้ง", level: 6, seconds: 4.5, xp: 40,
        inputs: { ore_copper: 6, charcoal: 1 }, outputs: { armor_copper: 1 },
        rare: { item: "star_ore", base: 0.002, perLevel: 0.0006 } },
      { id: "helm_iron", name: "ตีหมวกเหล็กเงา", area: "สายเหล็กเงา", level: 11, seconds: 5.4, xp: 39,
        masteryReq: { actionId: "helm_copper", level: 8 },
        inputs: { ore_iron: 5, charcoal: 2 }, outputs: { helm_iron: 1 },
        rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "sword_iron", name: "ตีดาบเหล็กเงา", area: "สายเหล็กเงา", level: 12, seconds: 5.4, xp: 43,
        inputs: { ore_iron: 6, charcoal: 2 }, outputs: { sword_iron: 1 },
        rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "shield_iron", name: "ตีโล่เหล็กเงา", area: "สายเหล็กเงา", level: 13, seconds: 5.4, xp: 47,
        inputs: { ore_iron: 5, charcoal: 2 }, outputs: { shield_iron: 1 },
        rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "body_iron", name: "ตีเกราะเหล็กเงา", area: "สายเหล็กเงา", level: 14, seconds: 5.4, xp: 51,
        inputs: { ore_iron: 7, charcoal: 2 }, outputs: { armor_iron: 1 },
        rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "helm_silver", name: "ตีหมวกเงินบริสุทธิ์", area: "สายเงินบริสุทธิ์", level: 17, seconds: 6.3, xp: 56,
        masteryReq: { actionId: "helm_iron", level: 8 },
        inputs: { ore_silver: 5, charcoal: 2 }, outputs: { helm_silver: 1 },
        rare: { item: "star_ore", base: 0.004, perLevel: 0.0008 } },
      { id: "sword_silver", name: "ตีดาบเงินบริสุทธิ์", area: "สายเงินบริสุทธิ์", level: 18, seconds: 6.3, xp: 60,
        inputs: { ore_silver: 6, charcoal: 2 }, outputs: { sword_silver: 1 },
        rare: { item: "star_ore", base: 0.004, perLevel: 0.0008 } },
      { id: "shield_silver", name: "ตีโล่เงินบริสุทธิ์", area: "สายเงินบริสุทธิ์", level: 19, seconds: 6.3, xp: 64,
        inputs: { ore_silver: 5, charcoal: 2 }, outputs: { shield_silver: 1 },
        rare: { item: "star_ore", base: 0.004, perLevel: 0.0008 } },
      { id: "body_silver", name: "ตีเกราะเงินบริสุทธิ์", area: "สายเงินบริสุทธิ์", level: 20, seconds: 6.3, xp: 68,
        inputs: { ore_silver: 7, charcoal: 2 }, outputs: { armor_silver: 1 },
        rare: { item: "star_ore", base: 0.004, perLevel: 0.0008 } },
      { id: "helm_gold", name: "ตีหมวกทองคำเปลว", area: "สายทองคำเปลว", level: 23, seconds: 7.2, xp: 80,
        masteryReq: { actionId: "helm_silver", level: 8 },
        inputs: { ore_gold: 6, charcoal: 2 }, outputs: { helm_gold: 1 },
        rare: { item: "star_ore", base: 0.005, perLevel: 0.0009 } },
      { id: "sword_gold", name: "ตีดาบทองคำเปลว", area: "สายทองคำเปลว", level: 24, seconds: 7.2, xp: 84,
        inputs: { ore_gold: 7, charcoal: 2 }, outputs: { sword_gold: 1 },
        rare: { item: "star_ore", base: 0.005, perLevel: 0.0009 } },
      { id: "shield_gold", name: "ตีโล่ทองคำเปลว", area: "สายทองคำเปลว", level: 25, seconds: 7.2, xp: 88,
        inputs: { ore_gold: 6, charcoal: 2 }, outputs: { shield_gold: 1 },
        rare: { item: "star_ore", base: 0.005, perLevel: 0.0009 } },
      { id: "body_gold", name: "ตีเกราะทองคำเปลว", area: "สายทองคำเปลว", level: 26, seconds: 7.2, xp: 92,
        inputs: { ore_gold: 8, charcoal: 2 }, outputs: { armor_gold: 1 },
        rare: { item: "star_ore", base: 0.005, perLevel: 0.0009 } },
      { id: "helm_mith", name: "ตีหมวกมิธริล", area: "สายมิธริล", level: 29, seconds: 8.1, xp: 113,
        masteryReq: { actionId: "helm_gold", level: 8 },
        inputs: { ore_mith: 6, charcoal: 3 }, outputs: { helm_mith: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "sword_mith", name: "ตีดาบมิธริล", area: "สายมิธริล", level: 30, seconds: 8.1, xp: 117,
        inputs: { ore_mith: 7, charcoal: 3 }, outputs: { sword_mith: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "shield_mith", name: "ตีโล่มิธริล", area: "สายมิธริล", level: 31, seconds: 8.1, xp: 121,
        inputs: { ore_mith: 6, charcoal: 3 }, outputs: { shield_mith: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "body_mith", name: "ตีเกราะมิธริล", area: "สายมิธริล", level: 32, seconds: 8.1, xp: 125,
        inputs: { ore_mith: 8, charcoal: 3 }, outputs: { armor_mith: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "helm_adamant", name: "ตีหมวกอดามันไทต์", area: "สายอดามันไทต์", level: 35, seconds: 9.0, xp: 161,
        masteryReq: { actionId: "helm_mith", level: 8 },
        inputs: { ore_adamant: 7, charcoal_spirit: 3 }, outputs: { helm_adamant: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "sword_adamant", name: "ตีดาบอดามันไทต์", area: "สายอดามันไทต์", level: 36, seconds: 9.0, xp: 165,
        inputs: { ore_adamant: 8, charcoal_spirit: 3 }, outputs: { sword_adamant: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "shield_adamant", name: "ตีโล่อดามันไทต์", area: "สายอดามันไทต์", level: 37, seconds: 9.0, xp: 169,
        inputs: { ore_adamant: 7, charcoal_spirit: 3 }, outputs: { shield_adamant: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "body_adamant", name: "ตีเกราะอดามันไทต์", area: "สายอดามันไทต์", level: 38, seconds: 9.0, xp: 173,
        inputs: { ore_adamant: 9, charcoal_spirit: 3 }, outputs: { armor_adamant: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "helm_night", name: "ตีหมวกราตรีมืด", area: "สายราตรีมืด", level: 41, seconds: 9.9, xp: 229,
        masteryReq: { actionId: "helm_adamant", level: 8 },
        inputs: { ore_night: 7, charcoal_spirit: 3 }, outputs: { helm_night: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "sword_night", name: "ตีดาบราตรีมืด", area: "สายราตรีมืด", level: 42, seconds: 9.9, xp: 233,
        inputs: { ore_night: 8, charcoal_spirit: 3 }, outputs: { sword_night: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "shield_night", name: "ตีโล่ราตรีมืด", area: "สายราตรีมืด", level: 43, seconds: 9.9, xp: 237,
        inputs: { ore_night: 7, charcoal_spirit: 3 }, outputs: { shield_night: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "body_night", name: "ตีเกราะราตรีมืด", area: "สายราตรีมืด", level: 44, seconds: 9.9, xp: 241,
        inputs: { ore_night: 9, charcoal_spirit: 3 }, outputs: { armor_night: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "helm_sun", name: "ตีหมวกสุริยะ", area: "สายสุริยะ", level: 47, seconds: 10.8, xp: 325,
        masteryReq: { actionId: "helm_night", level: 8 },
        inputs: { ore_sun: 8, charcoal_spirit: 4 }, outputs: { helm_sun: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "sword_sun", name: "ตีดาบสุริยะ", area: "สายสุริยะ", level: 48, seconds: 10.8, xp: 329,
        inputs: { ore_sun: 9, charcoal_spirit: 4 }, outputs: { sword_sun: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "shield_sun", name: "ตีโล่สุริยะ", area: "สายสุริยะ", level: 49, seconds: 10.8, xp: 333,
        inputs: { ore_sun: 8, charcoal_spirit: 4 }, outputs: { shield_sun: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "body_sun", name: "ตีเกราะสุริยะ", area: "สายสุริยะ", level: 50, seconds: 10.8, xp: 337,
        inputs: { ore_sun: 10, charcoal_spirit: 4 }, outputs: { armor_sun: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.0009 } },
      { id: "ring",    name: "เจียรแหวนแสงจันทรา",   area: "งานอัญมณี", level: 24, seconds: 7.5, xp: 100,
        inputs: { gem_moon: 1, star_ore: 1 },                 outputs: { ring_moon: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "amulet",  name: "ร้อยสร้อยไข่มุกลึก",    area: "งานอัญมณี", level: 28, seconds: 7.5, xp: 105,
        inputs: { pearl_deep: 3, spirit_dust: 3 },            outputs: { amulet_pearl: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "amulet2", name: "ร้อยสร้อยแกนเพลิง",     area: "งานอัญมณี", level: 36, seconds: 11.0, xp: 300,
        masteryReq: { actionId: "amulet", level: 10 },
        inputs: { ember_core: 2, gem_moon: 1, charcoal_spirit: 1 }, outputs: { amulet_ember: 1 },
        rare: { item: "gem_moon", base: 0.004, perLevel: 0.0008 } },
      { id: "ring2",   name: "เจียรแหวนรูนเวหา",      area: "งานอัญมณี", level: 40, seconds: 11.5, xp: 330,
        masteryReq: { actionId: "ring", level: 10 },
        inputs: { rune_sky: 1, gem_moon: 1 },                 outputs: { ring_rune: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "lance",   name: "ตีทวนเกล็ดมังกร",      area: "งานตำนาน", level: 44, seconds: 9.0, xp: 380,
        inputs: { ore_adamant: 4, scale_ice: 5, gem_moon: 1, star_ore: 1, charcoal_spirit: 3 },
        outputs: { lance_dragon: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "body2",   name: "ประกอบเกราะเกล็ดมังกร", area: "งานตำนาน", level: 48, seconds: 10.0, xp: 430,
        inputs: { scale_ice: 6, ore_mith: 4, charcoal_spirit: 3 },   outputs: { armor_scale: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "eclipse", name: "หลอมดาบจันทรุปราคา",    area: "งานตำนาน", level: 52, seconds: 12.5, xp: 520,
        masteryReq: { actionId: "sword_sun", level: 12 },
        inputs: { ore_sun: 4, ore_night: 4, gem_moon: 2, star_ore: 2, charcoal_spirit: 3 },
        outputs: { sword_eclipse: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "g_earring", name: "สลักต่างหูเงิน",      area: "งานเครื่องประดับ", level: 18, seconds: 4.5, xp: 55,
        inputs: { ore_silver: 3 },                            outputs: { good_earring: 1 },
        rare: { item: "star_ore", base: 0.003, perLevel: 0.0007 } },
      { id: "g_bangle",  name: "ตีกำไลทองคำเปลว",    area: "งานเครื่องประดับ", level: 24, seconds: 5.5, xp: 80,
        inputs: { ore_gold: 3 },                              outputs: { good_bangle: 1 },
        rare: { item: "star_ore", base: 0.004, perLevel: 0.0008 } },
      { id: "g_ring",    name: "เกลียวแหวนมิธริล",    area: "งานเครื่องประดับ", level: 30, seconds: 6.5, xp: 120,
        inputs: { ore_mith: 3, charcoal: 2 },                 outputs: { good_ringmith: 1 },
        rare: { item: "gem_moon", base: 0.002, perLevel: 0.0005 } },
      { id: "g_pendant", name: "เจียรจี้อัญมณีจันทรา", area: "งานเครื่องประดับ", level: 38, seconds: 8.0, xp: 200,
        inputs: { gem_moon: 1, ore_gold: 4, charcoal_spirit: 1 }, outputs: { good_pendant: 1 },
        rare: { item: "gem_moon", base: 0.003, perLevel: 0.0006 } },
      { id: "g_crown",   name: "จำลองมงกุฎฟาโรห์",   area: "งานเครื่องประดับ", level: 50, seconds: 10.0, xp: 420,
        inputs: { crown_shard: 2, ore_sun: 4, charcoal_spirit: 2 }, outputs: { good_crownrep: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "ph_helm",  name: "ขึ้นรูปหมวกฟาโรห์",   area: "งานราชวงศ์", level: 56, seconds: 12.0, xp: 600,
        inputs: { crown_shard: 3, ore_sun: 6, charcoal_spirit: 4 },   outputs: { helm_pharaoh: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "ph_sword", name: "ตีดาบฟาโรห์",        area: "งานราชวงศ์", level: 58, seconds: 13.0, xp: 700,
        masteryReq: { actionId: "ph_helm", level: 8 },
        inputs: { crown_shard: 4, bone_ancient: 6, charcoal_spirit: 4 }, outputs: { sword_pharaoh: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "ph_shield", name: "ตีโล่ฟาโรห์",       area: "งานราชวงศ์", level: 60, seconds: 13.5, xp: 780,
        inputs: { crown_shard: 4, sand_hour: 5, charcoal_spirit: 4 },  outputs: { shield_pharaoh: 1 },
        rare: { item: "gem_moon", base: 0.005, perLevel: 0.001 } },
      { id: "ph_body",  name: "ประกอบเกราะฟาโรห์",   area: "งานราชวงศ์", level: 62, seconds: 14.0, xp: 860,
        inputs: { crown_shard: 6, bone_ancient: 8, charcoal_spirit: 5 }, outputs: { armor_pharaoh: 1 },
        rare: { item: "gem_moon", base: 0.006, perLevel: 0.001 } },
      { id: "nv_helm",  name: "หลอมหมวกดาวดับ",     area: "งานดาราจักร", level: 66, seconds: 15.0, xp: 1000,
        inputs: { core_nova: 3, ash_star: 6, charcoal_spirit: 6 },     outputs: { helm_nova: 1 },
        rare: { item: "gem_moon", base: 0.006, perLevel: 0.0012 } },
      { id: "nv_sword", name: "หลอมดาบดาวดับ",      area: "งานดาราจักร", level: 70, seconds: 16.0, xp: 1200,
        masteryReq: { actionId: "nv_helm", level: 8 },
        inputs: { core_nova: 5, ash_star: 8, star_ore: 4, charcoal_spirit: 6 }, outputs: { sword_nova: 1 },
        rare: { item: "gem_moon", base: 0.007, perLevel: 0.0012 } },
      { id: "nv_shield", name: "หลอมโล่ดาวดับ",     area: "งานดาราจักร", level: 72, seconds: 16.5, xp: 1300,
        inputs: { core_nova: 4, ash_star: 7, charcoal_spirit: 6 },     outputs: { shield_nova: 1 },
        rare: { item: "gem_moon", base: 0.007, perLevel: 0.0012 } },
      { id: "nv_body",  name: "หลอมเกราะดาวดับ",    area: "งานดาราจักร", level: 75, seconds: 18.0, xp: 1500,
        inputs: { core_nova: 7, ash_star: 10, ore_sun: 8, charcoal_spirit: 8 }, outputs: { armor_nova: 1 },
        rare: { item: "gem_moon", base: 0.008, perLevel: 0.0014 } },
    ],
  },
];

/* Combat: locations -> ordered stages. Clearing a stage (KILLS_TO_UNLOCK_NEXT_STAGE kills)
 * unlocks the next; the boss opens once every normal stage is cleared. */
const LOCATIONS = [
  {
    id: "meadow", name: "ทุ่งหญ้าพระจันทร์", icon: "🌙", levelReq: 1, petTier: 1,
    flavor: "ทุ่งกว้างใต้แสงจันทร์ ที่สัตว์วิเศษตัวเล็กออกหากิน",
    stages: [
      { id: "slime",  name: "สไลม์ดาว",      icon: "🔵", hp: 20,  dmg: 2,  interval: 3.0, xp: 15, gold: [1, 4],
        loot: [{ item: "slime_goo", chance: 0.9, n: [1, 2] }, { item: "gem_moon", chance: 0.01, n: [1, 1] }] },
      { id: "rabbit", name: "กระต่ายเขาเดียว", icon: "🐇", hp: 38,  dmg: 3,  interval: 2.8, xp: 26, gold: [2, 6],
        loot: [{ item: "horn_shard", chance: 0.7, n: [1, 1] }, { item: "hide_soft", chance: 0.5, n: [1, 2] }] },
      { id: "wolf",   name: "หมาป่าเงา",      icon: "🐺", hp: 60,  dmg: 5,  interval: 2.6, xp: 45, gold: [4, 10],
        loot: [{ item: "wolf_fang", chance: 0.8, n: [1, 2] }, { item: "hide_soft", chance: 0.6, n: [1, 2] },
               { item: "gem_moon", chance: 0.015, n: [1, 1] }] },
      { id: "boss",   name: "ราชากระต่ายจันทรา", icon: "🌕", boss: true, hp: 140, dmg: 8, interval: 2.6, xp: 110, gold: [25, 50],
        traits: { enrage: { at: 0.35, mult: 1.8 } },
        loot: [{ item: "horn_shard", chance: 1.0, n: [2, 4] }, { item: "gem_moon", chance: 0.1, n: [1, 1] }] },
    ],
  },
  {
    id: "forest", name: "ป่าลึกเงามืด", icon: "🌑", levelReq: 4, petTier: 2,
    flavor: "ป่าที่แสงแดดส่องไม่ถึง เสียงกระซิบมาจากทุกทิศ",
    stages: [
      { id: "shroom", name: "เห็ดเดินได้",     icon: "🍄", hp: 90,  dmg: 7,  interval: 3.0, xp: 62, gold: [6, 14],
        loot: [{ item: "spore_glow", chance: 0.85, n: [1, 2] }] },
      { id: "twig",   name: "ปีศาจกิ่งไม้",    icon: "🌿", hp: 130, dmg: 9,  interval: 2.8, xp: 88, gold: [8, 18],
        loot: [{ item: "twig_cursed", chance: 0.8, n: [1, 2] }, { item: "spirit_dust", chance: 0.3, n: [1, 1] }] },
      { id: "dryad",  name: "วิญญาณพฤกษา",    icon: "🧚", hp: 180, dmg: 12, interval: 2.6, xp: 125, gold: [12, 26],
        loot: [{ item: "spirit_dust", chance: 0.9, n: [1, 2] }, { item: "hide_thick", chance: 0.45, n: [1, 1] },
               { item: "gem_moon", chance: 0.03, n: [1, 1] }] },
      { id: "spider", name: "แมงมุมใยเงิน",      icon: "🕷️", hp: 220, dmg: 14, interval: 2.5, xp: 150, gold: [14, 30],
        loot: [{ item: "twig_cursed", chance: 0.6, n: [1, 2] }, { item: "hide_soft", chance: 0.4, n: [1, 2] },
               { item: "shield_oak", chance: 0.03, n: [1, 1] }] },
      { id: "boss",   name: "เจ้าป่าเงามืด",     icon: "🌳", boss: true, hp: 340, dmg: 16, interval: 2.8, xp: 280, gold: [60, 110],
        traits: { armored: { taken: 0.55, hits: 3 } },
        loot: [{ item: "spirit_dust", chance: 1.0, n: [3, 5] }, { item: "gem_moon", chance: 0.14, n: [1, 1] }] },
    ],
  },
  {
    id: "cave", name: "ถ้ำมังกรน้ำแข็ง", icon: "🧊", levelReq: 8, petTier: 3,
    flavor: "ลมหายใจเย็นเฉียบของสิ่งโบราณ ก้องอยู่ในผลึกน้ำแข็ง",
    stages: [
      { id: "bat",    name: "ค้างคาวน้ำแข็ง",  icon: "🦇", hp: 220, dmg: 15, interval: 2.6, xp: 160, gold: [15, 32],
        loot: [{ item: "bat_wing", chance: 0.85, n: [1, 2] }, { item: "hide_thick", chance: 0.5, n: [1, 1] }] },
      { id: "golem",  name: "โกเลมหิมะ",      icon: "⛄", hp: 320, dmg: 19, interval: 3.2, xp: 220, gold: [20, 42],
        loot: [{ item: "snow_core", chance: 0.8, n: [1, 2] }, { item: "star_ore", chance: 0.25, n: [1, 1] },
               { item: "gem_moon", chance: 0.04, n: [1, 1] }] },
      { id: "dragon", name: "มังกรน้ำแข็งเยาว์", icon: "🐉", hp: 400, dmg: 20, interval: 2.8, xp: 330, gold: [35, 70],
        loot: [{ item: "scale_ice", chance: 0.9, n: [1, 2] }, { item: "gem_moon", chance: 0.06, n: [1, 1] }] },
      { id: "yeti",   name: "เยติขนน้ำแข็ง",     icon: "🦍", hp: 470, dmg: 23, interval: 3.0, xp: 380, gold: [38, 76],
        loot: [{ item: "hide_thick", chance: 0.7, n: [1, 2] }, { item: "snow_core", chance: 0.4, n: [1, 1] },
               { item: "helm_iron", chance: 0.03, n: [1, 1] }] },
      { id: "boss",   name: "ราชินีมังกรน้ำแข็ง", icon: "🐲", boss: true, hp: 900, dmg: 30, interval: 3.0, xp: 700, gold: [150, 260],
        traits: { enrage: { at: 0.3, mult: 2.0 }, drain: { pct: 0.03, every: 8 } },
        loot: [{ item: "scale_ice", chance: 1.0, n: [3, 6] }, { item: "gem_moon", chance: 0.3, n: [1, 2] }] },
    ],
  },
  {
    id: "volcano", name: "ภูเขาไฟพิโรธ", icon: "🌋", levelReq: 14, petTier: 4,
    flavor: "ปล่องลาวาที่หายใจเป็นไฟ — บ้านของสิ่งที่เกิดจากเปลวเพลิง",
    stages: [
      { id: "rat",    name: "หนูลาวา",        icon: "🐀", hp: 550,  dmg: 26, interval: 2.8, xp: 400, gold: [40, 80],
        loot: [{ item: "ember_core", chance: 0.3, n: [1, 1] }, { item: "hide_dragon", chance: 0.25, n: [1, 1] }] },
      { id: "golem",  name: "โกเลมหินหลอม",   icon: "🗿", hp: 750,  dmg: 32, interval: 3.2, xp: 520, gold: [50, 100],
        loot: [{ item: "ember_core", chance: 0.45, n: [1, 2] }, { item: "ore_night", chance: 0.3, n: [1, 2] },
               { item: "star_ore", chance: 0.35, n: [1, 2] }] },
      { id: "fox",    name: "จิ้งจอกเพลิง",    icon: "🦊", hp: 1000, dmg: 38, interval: 2.6, xp: 680, gold: [60, 120],
        loot: [{ item: "hide_dragon", chance: 0.5, n: [1, 2] }, { item: "gem_moon", chance: 0.05, n: [1, 1] }] },
      { id: "salamander", name: "ซาลาแมนเดอร์เพลิง", icon: "🦎", hp: 1250, dmg: 42, interval: 2.7, xp: 820, gold: [70, 140],
        loot: [{ item: "hide_dragon", chance: 0.55, n: [1, 2] }, { item: "ember_core", chance: 0.4, n: [1, 2] },
               { item: "sword_gold", chance: 0.02, n: [1, 1] }] },
      { id: "boss",   name: "ราชันเพลิงพิโรธ",  icon: "👹", boss: true, hp: 1800, dmg: 48, interval: 3.0, xp: 1600, gold: [300, 500],
        traits: { enrage: { at: 0.4, mult: 2.2 }, armored: { taken: 0.6, hits: 4 } },
        loot: [{ item: "ember_core", chance: 1.0, n: [3, 5] }, { item: "gem_moon", chance: 0.2, n: [1, 1] }] },
    ],
  },
  {
    id: "sky", name: "ปราสาทลอยฟ้า", icon: "🏰", levelReq: 22, petTier: 5,
    flavor: "ซากปราสาทโบราณที่ลอยเหนือเมฆ — ที่สุดของนักล่าแห่งมิธวูด",
    stages: [
      { id: "knight",   name: "อัศวินเวหา",    icon: "🪽", hp: 1400, dmg: 45, interval: 2.8, xp: 800,  gold: [80, 150],
        loot: [{ item: "feather_storm", chance: 0.4, n: [1, 1] }] },
      { id: "gargoyle", name: "การ์กอยล์หิน",  icon: "🗿", hp: 1800, dmg: 52, interval: 3.2, xp: 1000, gold: [100, 180],
        loot: [{ item: "feather_storm", chance: 0.5, n: [1, 2] }, { item: "rune_sky", chance: 0.03, n: [1, 1] }] },
      { id: "cloud",    name: "อสูรเมฆา",      icon: "☁️", hp: 2400, dmg: 60, interval: 2.8, xp: 1300, gold: [120, 220],
        loot: [{ item: "feather_storm", chance: 0.6, n: [1, 2] }, { item: "gem_moon", chance: 0.08, n: [1, 1] }] },
      { id: "phoenix",  name: "ฟีนิกซ์เวหา",    icon: "🔥", hp: 3000, dmg: 66, interval: 2.6, xp: 1700, gold: [160, 300],
        loot: [{ item: "feather_storm", chance: 0.7, n: [1, 3] }, { item: "ember_core", chance: 0.5, n: [1, 2] },
               { item: "sword_night", chance: 0.02, n: [1, 1] }] },
      { id: "boss",     name: "นางพญาวายุ",    icon: "🌩️", boss: true, hp: 4000, dmg: 75, interval: 3.0, xp: 3000, gold: [600, 1000],
        traits: { drain: { pct: 0.04, every: 7 }, armored: { taken: 0.5, hits: 4 } },
        loot: [{ item: "rune_sky", chance: 1.0, n: [1, 2] }, { item: "gem_moon", chance: 0.4, n: [1, 2] }] },
    ],
  },
  {
    id: "void", name: "รอยแยกมิติ", icon: "🌌", levelReq: 30, petTier: 6,
    flavor: "รอยร้าวบนผืนฟ้าที่สิ่งไร้ชื่อมุดออกมา — ปลายทางของนักล่าแห่งมิธวูด",
    stages: [
      { id: "wisp",     name: "ดวงไฟไร้ชื่อ",   icon: "🔮", hp: 2400, dmg: 62,  interval: 2.6, xp: 2200, gold: [200, 380],
        loot: [{ item: "rune_sky", chance: 0.12, n: [1, 1] }, { item: "gem_moon", chance: 0.2, n: [1, 2] },
               { item: "star_ore", chance: 0.4, n: [1, 2] }] },
      { id: "watcher",  name: "ผู้เฝ้ารอยแยก",   icon: "👁️", hp: 3200, dmg: 72,  interval: 2.9, xp: 3000, gold: [280, 520],
        loot: [{ item: "rune_sky", chance: 0.2, n: [1, 2] }, { item: "ore_sun", chance: 0.35, n: [1, 3] },
               { item: "armor_night", chance: 0.02, n: [1, 1] }] },
      { id: "devourer", name: "ผู้กลืนแสง",    icon: "🕳️", hp: 4000, dmg: 85, interval: 2.7, xp: 4200, gold: [400, 700],
        loot: [{ item: "rune_sky", chance: 0.3, n: [1, 2] }, { item: "gem_moon", chance: 0.4, n: [2, 4] },
               { item: "sword_sun", chance: 0.02, n: [1, 1] }] },
      { id: "boss",     name: "ราชาไร้บัลลังก์", icon: "☄️", boss: true, hp: 7500, dmg: 110, interval: 3.0, xp: 12000, gold: [1500, 2800],
        traits: { enrage: { at: 0.35, mult: 2.4 }, armored: { taken: 0.5, hits: 5 }, drain: { pct: 0.03, every: 6 } },
        loot: [{ item: "rune_sky", chance: 1.0, n: [2, 4] }, { item: "gem_moon", chance: 0.8, n: [3, 6] },
               { item: "sword_eclipse", chance: 0.05, n: [1, 1] }] },
    ],
  },
  {
    id: "tomb", name: "สุสานกาลเวลา", icon: "⌛", levelReq: 36, petTier: 7,
    flavor: "สุสานที่เวลาไหลกลับ — ทุกสิ่งที่ตายแล้วยังเดินอยู่ที่นี่",
    stages: [
      { id: "husk",     name: "ร่างไร้กาล",      icon: "🧟", hp: 6500,  dmg: 51, interval: 2.7, xp: 5200,  gold: [500, 900],
        loot: [{ item: "bone_ancient", chance: 0.5, n: [1, 2] }, { item: "gem_moon", chance: 0.25, n: [1, 2] }] },
      { id: "scarab",   name: "ด้วงทรายทอง",     icon: "🪲", hp: 5500,  dmg: 56, interval: 2.5, xp: 6000,  gold: [560, 1000],
        loot: [{ item: "sand_hour", chance: 0.4, n: [1, 2] }, { item: "ore_sun", chance: 0.35, n: [1, 3] }] },
      { id: "mummy",    name: "มัมมี่ผู้เฝ้าสุสาน", icon: "🏺", hp: 6000, dmg: 60, interval: 2.9, xp: 7000,  gold: [640, 1150],
        loot: [{ item: "bone_ancient", chance: 0.6, n: [2, 3] }, { item: "rune_sky", chance: 0.1, n: [1, 1] }] },
      { id: "wraith",   name: "ภูตกาลเวลา",      icon: "👻", hp: 5000, dmg: 65, interval: 2.6, xp: 8200,  gold: [720, 1300],
        loot: [{ item: "sand_hour", chance: 0.55, n: [1, 3] }, { item: "spirit_dust", chance: 0.5, n: [2, 4] }] },
      { id: "sphinx",   name: "สฟิงซ์ปริศนา",    icon: "🦁", hp: 5500, dmg: 70, interval: 3.0, xp: 9500,  gold: [850, 1500],
        loot: [{ item: "crown_shard", chance: 0.3, n: [1, 1] }, { item: "gem_moon", chance: 0.4, n: [2, 4] }] },
      { id: "colossus", name: "โคลอสซัสหินทราย", icon: "🗿", hp: 5500, dmg: 74, interval: 3.2, xp: 11000, gold: [950, 1700],
        loot: [{ item: "crown_shard", chance: 0.4, n: [1, 2] }, { item: "ore_night", chance: 0.4, n: [2, 4] }] },
      { id: "boss",     name: "ฟาโรห์นิรันดร์",   icon: "🔱", boss: true, hp: 16000, dmg: 79, interval: 3.0, xp: 26000, gold: [3000, 5200],
        traits: { enrage: { at: 0.4, mult: 2.2 }, drain: { pct: 0.03, every: 7 } },
        loot: [{ item: "crown_shard", chance: 1.0, n: [3, 5] }, { item: "rune_sky", chance: 0.5, n: [1, 2] },
               { item: "sword_eclipse", chance: 0.05, n: [1, 1] }] },
    ],
  },
  {
    id: "nova", name: "แดนดาวดับ", icon: "💫", levelReq: 44, petTier: 8,
    flavor: "ซากดาวที่ดับไปแล้วแต่ยังหายใจ — ไม่มีใครเคยกลับมาเล่าว่าก้นเหวมีอะไร",
    stages: [
      { id: "cinder",    name: "เถ้าเดินได้",     icon: "🔥", hp: 6500, dmg: 79, interval: 2.6, xp: 15000, gold: [1200, 2100],
        loot: [{ item: "ash_star", chance: 0.5, n: [1, 2] }, { item: "ember_core", chance: 0.5, n: [2, 4] }] },
      { id: "shard",     name: "สะเก็ดดาวมีชีวิต", icon: "🌠", hp: 5500, dmg: 86, interval: 2.5, xp: 17000, gold: [1350, 2400],
        loot: [{ item: "ash_star", chance: 0.55, n: [1, 3] }, { item: "star_ore", chance: 0.6, n: [2, 4] }] },
      { id: "pulsar",    name: "พัลซาร์คลั่ง",    icon: "📡", hp: 5000, dmg: 93, interval: 2.4, xp: 19500, gold: [1500, 2700],
        loot: [{ item: "core_nova", chance: 0.3, n: [1, 1] }, { item: "rune_sky", chance: 0.25, n: [1, 2] }] },
      { id: "warden",    name: "ผู้คุมดาวดับ",    icon: "🛸", hp: 5500, dmg: 100, interval: 2.9, xp: 22000, gold: [1700, 3000],
        loot: [{ item: "core_nova", chance: 0.4, n: [1, 2] }, { item: "ore_sun", chance: 0.5, n: [3, 6] }] },
      { id: "eclipse",   name: "เงาสุริยุปราคา",  icon: "🌘", hp: 5000, dmg: 107, interval: 2.7, xp: 25000, gold: [1900, 3400],
        loot: [{ item: "ash_star", chance: 0.7, n: [2, 4] }, { item: "gem_moon", chance: 0.6, n: [3, 6] }] },
      { id: "leviathan", name: "เลวีอาธานอวกาศ",  icon: "🐋", hp: 5000, dmg: 114, interval: 3.1, xp: 28000, gold: [2100, 3800],
        loot: [{ item: "core_nova", chance: 0.5, n: [1, 3] }, { item: "scale_ice", chance: 0.5, n: [3, 6] }] },
      { id: "herald",    name: "ผู้ประกาศวาระ",   icon: "📯", hp: 4500, dmg: 122, interval: 2.8, xp: 32000, gold: [2400, 4200],
        loot: [{ item: "crown_shard", chance: 0.5, n: [2, 4] }, { item: "core_nova", chance: 0.4, n: [1, 2] }] },
      { id: "boss",      name: "ดาวดวงสุดท้าย",   icon: "🌟", boss: true, hp: 14500, dmg: 129, interval: 3.0, xp: 90000, gold: [9000, 16000],
        traits: { enrage: { at: 0.35, mult: 2.5 }, armored: { taken: 0.5, hits: 5 }, drain: { pct: 0.025, every: 6 } },
        loot: [{ item: "core_nova", chance: 1.0, n: [4, 8] }, { item: "ash_star", chance: 1.0, n: [4, 8] },
               { item: "gem_moon", chance: 1.0, n: [5, 10] }] },
    ],
  },
  /* 🎯 [added 2026-08-19, owner: "ขยายมอนเตอร์ และ เพดานการเล่น ให้รองรับเยอะๆ"] The ninth zone, and
   * the one that finally reaches the level cap. Measured before writing it: clearing the previous
   * eight lands a player at combat level 89 against a MAX_LEVEL of 99 — so the gap was never the
   * levelReq 44 that the last zone's gate suggests, it was the ten levels of nothing after nova.
   * This zone is sized to close exactly that: 800,000 xp across its five stages plus 130,000 from
   * the boss, against the 786,459 the projection said was missing.
   *
   * It is also the first zone whose era gear is sword_nova (108 dmg, smithing lv70) — the strongest
   * weapon in the game, which until now no zone was balanced around. Everything drops materials that
   * already existed; a new tier of loot would have meant new ITEMS entries, new sources, and new
   * sell-price checks, none of which this needed. petTier stays 8: novaling and starwhale live here
   * too, and inventing a tier 9 with no species behind it fails balance_check's own pet-tier check. */
  {
    id: "genesis", name: "ห้วงกำเนิด", icon: "🌌", levelReq: 60, petTier: 8,
    flavor: "ที่ที่ดาวดวงใหม่กำลังก่อตัว — แสงแรกยังไม่ทันส่อง ก็มีบางอย่างเฝ้ามันอยู่ก่อนแล้ว",
    stages: [
      /* Difficulty climbs through DAMAGE and swing speed, not health — deliberately, and not for
       * lack of trying. Damage taken has a floor of 30% of a hit regardless of armour, so it scales
       * with hp × dmg ÷ interval: raise both and the food cost explodes. Forcing hp upward alongside
       * dmg was measured at 3.6 → 5.7 meals across these five stages against a cap of 4. Kill time
       * therefore stays ~85-93s throughout while the enemies get faster and hit harder, which is
       * also the thing a player actually feels. */
      { id: "spark", name: "ประกายแรกเกิด", icon: "✨", hp: 7750, dmg: 96, interval: 2.8,
        xp: 12000, gold: [1600, 2600],
        loot: [{ item: "ember_core", chance: 0.55, n: [2, 4] }, { item: "star_ore", chance: 0.45, n: [1, 3] },
               { item: "seed_star", chance: 0.15, n: [1, 2] }] },
      { id: "dust", name: "ม่านฝุ่นดารา", icon: "🌫️", hp: 7500, dmg: 104, interval: 2.7,
        xp: 14000, gold: [1900, 3000],
        loot: [{ item: "ash_star", chance: 0.5, n: [1, 3] }, { item: "ore_sun", chance: 0.4, n: [2, 4] },
               { item: "rune_sky", chance: 0.2, n: [1, 2] }] },
      { id: "wisp", name: "วิญญาณแสงเร่ร่อน", icon: "🕯️", hp: 7500, dmg: 112, interval: 2.6,
        xp: 16000, gold: [2200, 3500],
        loot: [{ item: "gem_moon", chance: 0.4, n: [1, 2] }, { item: "rune_sky", chance: 0.35, n: [1, 3] },
               { item: "core_nova", chance: 0.12, n: [1, 1] }] },
      { id: "warden", name: "ผู้เฝ้าครรภ์ดารา", icon: "🛡️", hp: 7250, dmg: 120, interval: 2.5,
        xp: 18000, gold: [2600, 4200],
        loot: [{ item: "crown_shard", chance: 0.35, n: [1, 2] }, { item: "core_nova", chance: 0.25, n: [1, 2] },
               { item: "gem_moon", chance: 0.3, n: [1, 3] }] },
      { id: "eater", name: "ผู้กลืนแสง", icon: "🕳️", hp: 7000, dmg: 130, interval: 2.4,
        xp: 20000, gold: [3000, 5000],
        loot: [{ item: "core_nova", chance: 0.4, n: [1, 3] }, { item: "ash_star", chance: 0.5, n: [2, 4] },
               { item: "crown_shard", chance: 0.3, n: [1, 2] }] },
      { id: "boss", name: "ดาวแรกที่ยังไม่เกิด", icon: "🌠", boss: true,
        hp: 22500, dmg: 150, interval: 3, xp: 130000, gold: [18000, 30000],
        traits: { enrage: { at: 0.3, mult: 2.8 }, armored: { taken: 0.45, hits: 6 }, drain: { pct: 0.03, every: 6 } },
        loot: [{ item: "core_nova", chance: 1.0, n: [6, 12] }, { item: "crown_shard", chance: 1.0, n: [4, 8] },
               { item: "gem_moon", chance: 1.0, n: [6, 12] }, { item: "rune_sky", chance: 1.0, n: [4, 8] }] },
    ],
  },
];

/* 🎯 [added 2026-08-15, owner's design] The wandering trader's stall. These are materials the
 * regular shop never stocks — normally you mine, fish or farm them — offered for gold during a
 * five-minute window. Each visit rolls TRADER_OFFER_COUNT of them, so a stall is worth checking
 * rather than memorising. Prices sit above the item's own sell value (never a resale loop) but
 * below what the time to farm them is worth. */
const TRADER_OFFER_COUNT = 4;
const TRADER_WINDOW_SECONDS = 300;
/* Seeds fall in the wild too — one species per zone, deeper zones dropping the pricier seed.
 * The owner asked for both routes ("จะซื้อ หรือ ล่าจากมอนเตอร์"), and a hunter should be able to
 * fund a garden without ever visiting the stall. Injected in one place rather than hand-written
 * into 43 stages so the zone->seed mapping stays readable and cannot drift apart. */
const ZONE_SEEDS = {
  meadow: "seed_carrot", forest: "seed_potato", cave: "seed_pumpkin", volcano: "seed_grape",
  sky: "seed_melon", void: "seed_berry", tomb: "seed_pome", nova: "seed_star",
};
for (const loc of LOCATIONS) {
  const seed = ZONE_SEEDS[loc.id];
  if (!seed) continue;
  for (const st of loc.stages) {
    st.loot.push(st.boss
      ? { item: seed, chance: 1.0,  n: [3, 6] }    // a boss always hands over a season's planting
      : { item: seed, chance: 0.15, n: [1, 2] });
  }
}

/* The seed stall by the plots. Seeds are the one consumable bought with gold rather than earned,
 * so the price has to sit far above what the seed itself sells for — otherwise buying and
 * re-selling is free money with no farming involved. A seed pays for itself by being PLANTED. */
const SEED_SHOP = [
  { item: "seed_carrot",  price: 40,     level: 1 },
  { item: "seed_potato",  price: 120,    level: 8 },
  { item: "seed_pumpkin", price: 400,    level: 16 },
  { item: "seed_grape",   price: 1200,   level: 24 },
  { item: "seed_melon",   price: 3000,   level: 30 },
  { item: "seed_berry",   price: 9000,   level: 36 },
  { item: "seed_pome",    price: 26000,  level: 42 },
  { item: "seed_star",    price: 75000,  level: 50 },
];

const TRADER_STOCK = [
  { item: "ore_copper",  n: 40, price: 400 },
  { item: "ore_iron",    n: 30, price: 700 },
  { item: "ore_silver",  n: 25, price: 900 },
  { item: "ore_gold",    n: 20, price: 1400 },
  { item: "ore_mith",    n: 15, price: 2200 },
  { item: "ore_adamant", n: 12, price: 4200 },
  { item: "wood_moon",   n: 25, price: 800 },
  { item: "wood_dragon", n: 20, price: 1500 },
  { item: "wood_spirit", n: 15, price: 2000 },
  { item: "charcoal",    n: 50, price: 500 },
  { item: "charcoal_spirit", n: 20, price: 1600 },
  { item: "hide_soft",   n: 25, price: 1400 },
  { item: "hide_thick",  n: 20, price: 2400 },
  { item: "hide_dragon", n: 10, price: 4200 },
  { item: "leather",     n: 20, price: 2200 },
  { item: "star_ore",    n: 3,  price: 3000 },
  { item: "pearl_deep",  n: 5,  price: 3200 },
  { item: "spice_void",  n: 5,  price: 3600 },
  { item: "gem_moon",    n: 2,  price: 8000 },
  { item: "ember_core",  n: 4,  price: 5000 },
  { item: "feather_storm", n: 3, price: 9000 },
  { item: "rune_sky",    n: 1,  price: 12000 },
];

/* Wearing a whole tier's head+body+offhand grants a set bonus on top of the pieces, so a
 * complete lower tier can genuinely compete with mixed higher-tier gear (owner, 2026-08-15). */
/* Momentum: staying on one job builds a bonus; switching resets it. Fits a game whose clock
 * only runs while you watch (owner, 2026-08-15) — commitment becomes the decision. */
const MOMENTUM_TIERS = [
  { at: 0,   xp: 0,    name: "เริ่มต้น",   icon: "·" },
  { at: 120, xp: 0.05, name: "เข้าจังหวะ", icon: "✨" },
  { at: 300, xp: 0.12, name: "ลื่นไหล",    icon: "⚡" },
  { at: 600, xp: 0.25, name: "ไฟลุก",      icon: "🔥" },
];

/* Random interruptions while working. `roll` is the per-completed-action chance. Effects are
 * resolved in the engine so a new event type is a data row plus one small case. */
const EVENTS = [
  { id: "vein",    name: "สายแร่พิเศษ!",     icon: "💎", roll: 0.012, kind: "surge",
    text: "เจอสายที่อุดมผิดปกติ — 30 วินาทีนี้ได้ของเป็นสองเท่า", seconds: 30 },
  { id: "wind",    name: "ลมหนุนหลัง",       icon: "🍃", roll: 0.012, kind: "haste",
    text: "จู่ ๆ ทุกอย่างก็คล่องมือ — 30 วินาทีนี้ทำงานเร็วขึ้น 40%", seconds: 30 },
  { id: "trader",  name: "พ่อค้าเร่ผ่านมา",   icon: "🧙", roll: 0.008, kind: "trader",
    text: "กางแผงอยู่ 5 นาที — ไปที่ร้านค้า แผงของเขาจะอยู่บนสุด", seconds: 300 },
  { id: "cache",   name: "กรุสมบัติเล็ก ๆ",   icon: "🎁", roll: 0.008, kind: "loot",
    text: "สะดุดหีบเก่าใต้รากไม้", loot: ["gem_moon", "star_ore", "pearl_deep", "spice_void"] },
  /* 🎯 [owner 2026-08-22] "ซุ่มการโจมตี เอาออกเลย" — the ambush event lived here and is gone.
   *
   * Losing health while fishing or chopping wood taxed the calm half of the game, the half you
   * leave running, and it arrived with no decision attached to it. Health is now spent in exactly
   * two places, both of which you chose to be in: a failed steal (see the miss branch in
   * startAction — "the risk that funds the reward") and being hit in combat. Neither of those ever
   * went through this table. EVENTS is now purely good news, which is the right shape for a thing
   * that fires while you are not looking. */
  { id: "muse",    name: "แรงบันดาลใจ",      icon: "🌟", roll: 0.008, kind: "xp",
    text: "จับทางได้พอดี — ได้ XP ก้อนโตทันที", xpMult: 8 },
];

/* Achievements: permanent, small, and spread across every system so chasing them pulls the
 * player into corners of the game they would otherwise skip. `stat` names a counter the engine
 * keeps; `perk` is applied globally once earned. */
/* ---------- 🏘️ ลานหมู่บ้าน (village square) ----------
 * 🎯 [owner 2026-08-22] "ลานหมู่บ้าน > พื้นที่ npc รับเควส ให้ผลตอบแทนเป็นเงิน, พูดคุยได้ จีบได้
 * มีให้ของขวัญ จะมี npc ชายเสริมมาบ้างประปราย"
 *
 * The people first, the quests second. A board that hands out anonymous fetch jobs is a menu; the
 * same job from someone who will later be a friend, a partner or a stranger who never warms to you
 * is a relationship in progress. So the villagers exist now, and the courting they support lands
 * next — the quest board is the reason to walk into the square before any of that is built.
 *
 * `bonus` is what each one promotes once the relationship system is in. Recorded here rather than
 * invented later so the five women are already distinguishable by what they DO, not by their art.
 * Male villagers give quests and friendship, and no romance track — the owner's call.
 */
const VILLAGERS = [
  { id: "maya",  name: "มายา",  icon: "🌷", romance: true,
    job: "คนดูแลเรือนเพาะชำ", bonus: "พืชผลโตเร็วขึ้น",
    likes: ["seed", "crop", "spore"] },
  { id: "rin",   name: "ริน",   icon: "🔨", romance: true,
    job: "ช่างตีเหล็ก", bonus: "ดาเมจมากขึ้น อาวุธถูกลง",
    likes: ["ore", "charcoal", "wood"] },
  { id: "sora",  name: "โซระ",  icon: "🪙", romance: true,
    job: "ลูกสาวพ่อค้า", bonus: "ขายของได้ราคาดีขึ้น",
    likes: ["gem", "good", "crown"] },
  { id: "kano",  name: "คาโน",  icon: "🐟", romance: true,
    job: "คนหาปลาริมทะเลสาบ", bonus: "โอกาสได้ของหายากมากขึ้น",
    likes: ["fish", "crab", "pearl"] },
  { id: "ellie", name: "เอลลี่", icon: "📖", romance: true,
    job: "นักบันทึกของสถาบัน", bonus: "ได้ XP ทุกสายมากขึ้น",
    likes: ["tome", "rune", "star"] },
  { id: "borin", name: "โบริน", icon: "🪓", romance: false,
    job: "คนตัดไม้", bonus: null, likes: ["wood", "resin"] },
  { id: "tam",   name: "ตั้ม",   icon: "🍖", romance: false,
    job: "เจ้าของโรงเตี๊ยม", bonus: null, likes: ["meal", "bread", "spice"] },
];

/* ---------- 💗 ความสัมพันธ์ (relationships) ----------
 * 🎯 [owner 2026-08-22] "มีความสัมพันธ์กับตัวละครสาวๆ ได้ เช่น เพื่อน แฟน แต่งงาน ... ให้ของขวัญได้
 * ส่วนสาวๆ แต่ละคนจะส่งเสริมโบนัสต่างกัน"
 *
 * Rebirth halves affection and rolls the marriage back — the owner's rule, and it is the same rule
 * the combat stats already follow, so it needed no new vocabulary. affectionFloor mirrors
 * rebirthFloor: courting the same person again is faster every time, which turns rebirth into
 * going home rather than starting over.
 *
 * A gift the villager dislikes costs affection. Without that the whole system is one button held
 * down until the number stops.
 */
const REL_STAGES = [
  { at: 0,  id: "stranger", name: "คนแปลกหน้า", bonus: 0,    note: "ทักได้ ยังไม่รับของ" },
  { at: 15, id: "known",    name: "คนรู้จัก",    bonus: 0.25, note: "เริ่มรับของขวัญ" },
  { at: 35, id: "friend",   name: "เพื่อน",      bonus: 0.5,  note: "สั่งงานให้เราได้" },
  { at: 55, id: "close",    name: "คนสนิท",      bonus: 0.7,  note: "บอกของที่ชอบเอง" },
  /* 🐛 [owner 2026-08-22: "npc คงไม่บัค สเตตัสความสัมพันธ์ใช่ไหม ... แบบนั้นจะตลกมาก"] The top two rungs
     are romantic, and the ladder was shared by everyone — so gifting the woodcutter far enough
     labelled him "คนรัก" and then "พร้อมแต่งงาน". He could never actually be married (canPropose
     needs a REL_BONUS, which the non-romanceable villagers do not have), so this was the label
     lying rather than the rules breaking, which is worse in one way: the game looked wrong while
     behaving correctly. `alt` is what a villager with romance:false is called instead. */
  { at: 75, id: "lover",    name: "คนรัก",       bonus: 0.85, note: "ขอแต่งงานได้",
    alt: { name: "พี่น้องต่างสายเลือด", note: "นับกันเป็นพี่น้อง แม้ไม่ได้เกิดจากพ่อแม่เดียวกัน" } },
  /* 🐛 [owner 2026-08-22: "เอลลี่ฉันยังไม่ได้แต่งงาน มันควรเป็นสถานะสามารถแต่งงานได้"] Reaching this
     stage is not a wedding — it is the affection at which one is possible. Named "แต่งงาน", it
     told every maxed-out villager she was already your wife. */
  { at: 90, id: "wed",      name: "พร้อมแต่งงาน", bonus: 1,    note: "โบนัสเต็ม · ขอแต่งงานได้",
    alt: { name: "ยอมตายแทนกันได้", note: "ความผูกพันที่ลึกที่สุด — ไม่ใช่ความรัก แต่หนักแน่นไม่แพ้กัน" } },
];
const REL_MAX = 100;
const REL_GIFT_LOVED = 8;        // an item on their likes list
const REL_GIFT_PLAIN = 3;        // anything else they will accept
const REL_GIFT_DISLIKED = -5;    // junk, or something they hate
const REL_GIFTS_PER_DAY = 1;     // per villager — the limiter that makes a gift mean something
const REL_QUEST_BONUS = 2;       // handing in their job counts as attention
const REL_REBIRTH_MULT = 0.5;    // the owner's number

/* What each romance option actually promotes, at full marriage. Scaled by the stage's `bonus`, so
 * a friend gives a fraction of it and a spouse gives all of it. Every one of these hooks a system
 * that already exists rather than inventing a new stat to grow. */
const REL_BONUS = {
  maya:  { kind: "farmSpeed", amount: 0.20, label: "พืชผลโตเร็วขึ้น" },
  rin:   { kind: "dmg",       amount: 3,    label: "ดาเมจมากขึ้น" },
  sora:  { kind: "sellPrice", amount: 0.15, label: "ขายของได้ราคาดีขึ้น" },
  kano:  { kind: "luck",      amount: 0.12, label: "โอกาสได้ของหายากมากขึ้น" },
  ellie: { kind: "xpBonus",   amount: 0.15, label: "ได้ XP ทุกสายมากขึ้น" },
  /* 🎯 [owner 2026-08-22] "โดยมันไม่มีการขอแต่งงาน แต่จะให้โบนัสเล็กน้อยมากๆ ฟรี" — the two villagers
     who cannot be courted still repay a friendship taken to its end, at roughly a sixth of what a
     marriage pays. Small enough that nobody grinds them for it; large enough that the bond is not
     purely decorative. Note that these are NOT what gates a proposal — canPropose reads v.romance,
     precisely so that giving these two a bonus does not quietly make them marriageable. */
  borin: { kind: "dmg",       amount: 0.5,  label: "ดาเมจมากขึ้น" },
  tam:   { kind: "sellPrice", amount: 0.03, label: "ขายของได้ราคาดีขึ้น" },
};

/* ---------- 👶 ลูก (children) ----------
 * 🎯 [owner 2026-08-22] "หลังแต่งงาน ผ่านไปแต่ละวันจะมีโอกาสเพียง 3% ต่อวันที่จะเกิดลูก ... ไม่งั้น
 * หลังจุติ จีบใหม่ ลูกเกิดมากมาย วนๆ" · "ยิ่งเรียนรู้เยอะ ยิ่งเสริมโบนัสให้เรา ... ยิ่งระดับสูงยิ่งแพง
 * คืนทุนช้า พอจุติอาจไม่คุ้ม เพราะพอจุติ สเตตัสลูกก็หายไป"
 *
 * The 3% is the whole balance of the birth side. At that rate a child is a median ~23 game-days
 * away, which is long enough to read as an event rather than a button, and it is what stops the
 * loop the owner named: court, marry, spawn, rebirth, repeat.
 *
 * The education side is where the decisions are. Levels cost more than they return in the short
 * run, and a rebirth takes the whole investment with it — so "how close am I to jumping?" becomes
 * a real question with a different answer every run. That tension is the feature; without the loss
 * at rebirth this would just be somewhere to put spare gold.
 */
/* 🎯 [owner 2026-08-22] 3% → 1%. A game-day is 100 real seconds, so 3% filled the household's
 * four slots in under half an hour of play — children arrived faster than any of them could
 * grow up, which made the growing-up the player was meant to watch invisible. At 1% the wait
 * between births is roughly the time a child needs to reach adulthood. */
const CHILD_BIRTH_CHANCE = 0.01;      // per game-day, only while married
const CHILD_STAT_DIVISOR = 2;         // a child starts at half of what we were when they were born
/* 🎯 [owner 2026-08-22: "ภรรยา + ลูก ตามจำนวน ... ดึงเงินจากกระเป๋าระบบเดียวกัน แต่ของภรรยากับลูกดึงทุกวัน"]
 * A household costs money every game-day. Before this, marriage and children were pure bonus with
 * no running cost anywhere in the game — the only reason to stop at four children was the cap.
 *
 * Sized against the tax-free allowance, which is the game's own statement of what counts as a small
 * income: 700,000 a year over 360 days is about 1,944 a day. A spouse alone is 13% of that; a spouse
 * with two children schooled to three levels each is 910 a day, roughly half. Meaningful, survivable.
 *
 * Education is charged for on purpose. The owner's design is "ยิ่งเรียนรู้เยอะ ยิ่งเสริมโบนัสให้เรา" —
 * a child who gives more should eat more, or schooling is free money with a one-off entry fee.
 * One track taken to level 5 costs 90,000 to buy and 300 a day to keep. */
/* 🎯 [owner 2026-08-23] "ฟิกค่าใช้จ่ายลูก ควรเท่าแม่ ฟิกตายตัว ต่อวันคนละ 500 เพราะค่าเรียนเราจ่าย
   ตายตัวไปแล้ว ต่อขั้นการเรียน" — schooling is bought once, at a cubic price. Charging rent on it
   every day afterwards meant a fully-taught child cost 378,000 a year forever for a lesson already
   paid for. Flat now, and the same as a wife: a person in the household costs what a person costs. */
const FAMILY_UPKEEP_SPOUSE = 500;   // per game-day
const FAMILY_UPKEEP_CHILD = 500;    // per game-day, each — flat, whatever they have been taught
const FAMILY_UPKEEP_PER_EDU = 0;    // kept at zero rather than deleted: it is the owner's dial


/* 🎯 [owner 2026-08-23] "ต้องแก้ให้ค่าติดลบค้าง รอเงินสดมาคืน ครอบครัวจะไม่หักธนาคาร แค่มี counter
 * นับว่าค่าเลี้ยงดูยังติดลบ ไม่ได้ชำระมากี่วัน ครบ 90 วันก็ค่อยหัก แบบมี notis ถ้าหักจากกระเป๋าและธนาคารไม่ได้
 * เกมโอเวอร์"
 *
 * Upkeep used to reach straight into the bank the moment the wallet came up short, which meant
 * savings drained silently — the owner found 144 gold missing from a deposit slip by noticing it
 * himself, because nothing anywhere recorded it. Now an unpaid day is a DEBT that waits for cash,
 * and the savings are off limits until this many consecutive days of it have passed. */
const FAMILY_ARREARS_FATAL_DAYS = 90;
/* How often the shortfall warning repeats while the debt stands. Every day for ninety days is the
   toast flood the owner has already objected to twice; silence for ninety days is worse. So: the
   first day, every tenth day after it, and every day of the last week before the run ends. */
const FAMILY_ARREARS_WARN_EVERY = 10;
const FAMILY_ARREARS_WARN_FINAL = 7;
const CHILD_MAX = 4;                  // a ceiling, so a long marriage does not become a bonus farm
const CHILD_ADULT_DAY = 120;          // game-days from birth to setting out on their own

/* What a child can be taught. Three tracks, per the owner: trade, hunting, and making things.
 * Each level gives `per` of its bonus and costs `cost(level)` — steeply enough that the top of a
 * track is a commitment rather than a purchase. */
const CHILD_TRACKS = [
  { id: "trade", icon: "🪙", name: "การค้า", kind: "sellPrice", per: 0.03,
    desc: "ขายของได้ราคาดีขึ้น" },
  { id: "hunt",  icon: "🗡️", name: "การล่า",  kind: "dmg",       per: 1,
    desc: "ดาเมจของเรามากขึ้น" },
  { id: "craft", icon: "⚒️", name: "สายผลิต", kind: "xpBonus",   per: 0.02,
    desc: "ได้ XP ทุกสายมากขึ้น" },
];
/* 🎯 [owner 2026-08-23] "ลูกต้องทำการล่ามอน ... เราไม่ได้คุมเอง มันจะทำงานตามระบบหลังบ้าน ล่ามอน
 * เลเวลน้อยๆ ค่อยๆ เติบโต ซึ่งการล่าจะเฉลี่ยทุก 3-7 วัน ลูกเลเวลตันแค่ 99 เหมือน pet"
 *
 * A grown child is not a unit you play. It is something that reports back. Everything here is
 * therefore about pace and legibility rather than about tactics: how often it happens, what comes
 * back, and how long the climb takes.
 *
 * The level curve is the pet's, deliberately — petXpToReach is already fitted against what this
 * game actually yields, and a second curve would drift from it the first time either is retuned.
 * At roughly 72 hunts a game-year, a child reaches 99 in something like a decade of game time,
 * which is the "ค่อยๆ เติบโต" he asked for rather than a bar that fills in an evening. */
const CHILD_MAX_LEVEL = 99;
/* 🎯 [owner 2026-08-23] "ออกล่าทุกวัน วันละครั้ง ถ้าบาดเจ็บให้พักสามวัน ออกล่าใหม่" — was 3-7 days
   with a 2-day rest. Daily makes the injury mean something: it is now the only thing that ever
   costs a child a day, instead of one irregular gap among several. */
const CHILD_HUNT_MIN_DAYS = 1;
const CHILD_HUNT_MAX_DAYS = 1;
const CHILD_HURT_REST_DAYS = 3;      // days off after a hunt goes badly, on top of the daily gap
const CHILD_GROWTH = 0.02;           // +2% of birth stats per level, the pet's rate
/* How much of a stage's bounty a child brings home. Below the guild's share on purpose: a squad is
 * a business you pay wages for, a child is one person doing this on their own. */
const CHILD_HUNT_GOLD_SHARE = 0.55;
const CHILD_HUNT_LOOT_SHARE = 0.30;
/* 🎯 [owner 2026-08-23] "เหมือนมอนเกม rpg — มอนเขียวคือสู้ได้สบาย มอนเหลืองคือสู้ 80% ได้แต่บางครั้ง
 * อาจไม่ไหว แต่มอนแดงคือถ้าสู้ โอกาสชนะ 50%" — a child now reads a stage the way an RPG con-colour
 * does: against ITS OWN stats, not against where the stage sits on the map. That is the whole
 * difference between a level-99 child punching slimes and one working the hardest ground it can
 * still call green.
 *
 * The floor is the red line: below a coin-flip it will not go at all. */
const CHILD_HUNT_MIN_SUCCESS = 0.50;
const CHILD_HUNT_BAND_GREEN = 0.90;    // at or above this it is comfortable — green
const CHILD_HUNT_BAND_YELLOW = 0.75;   // green > yellow >= this; below it, down to the floor, is red
/* Weights across those three colours (owner: "ต่ำกว่าตัวเอง 60% มอนกลาง 40% ด่านมอนสูง 30%") — not
   percentages; they normalise to 46/31/23 when all three colours have somewhere to go. */
const CHILD_HUNT_TIER_WEIGHTS = { low: 60, mid: 40, high: 30 };
/* Within a colour, only the hardest few are in play (owner: "lv99 มันควรเลือกมอนเขียวตัวยากสุด"). A
   band is a difficulty, not a menu — without this a green day still averages down to the easiest
   green on the map, which is the bug the colours were meant to fix. */
const CHILD_HUNT_BAND_TOP = 3;
/* Above this many children hunting in one day the toast rail pools into a single line instead of
   naming each one — see childrenHuntDay. */
const CHILD_HUNT_TOAST_MAX = 4;

/* 🎯 [owner 2026-08-23] "นอกจากทุกวันต้องออกล่า มันจะมี event สุ่ม ตัดต้นไม้ ตกปลา ขุดแร่ และขโมย
 * แต่ขโมยล็อกว่าล้วงกระเป๋าชาวบ้านเท่านั้น ... หากลูกบาดเจ็บ ไม่ออกล่า แต่ยังต้องทำ event สุ่ม"
 *
 * A grown child's day is two things: an errand, drawn at random from these four, and a hunt. The
 * errand runs every single day — a child nursing a hunting injury still brings something home,
 * which is what keeps a bad week from being an empty one.
 *
 * These are the real skills, not a parallel loot table: the child works the same actions the player
 * does, gated by `actionOpen` so it can never reach a resource the player has not unlocked — the
 * same rule the hunt already follows. Thieving is pinned to `villager` by the owner: a child picks
 * pockets in the market, it does not burgle a noble's estate. */
const CHILD_ERRANDS = [
  { id: "wc", icon: "🌲", name: "ตัดไม้" },
  { id: "fi", icon: "🎣", name: "ตกปลา" },
  { id: "mi", icon: "💎", name: "ขุดแร่" },
  { id: "th", icon: "🕵️", name: "ล้วงกระเป๋า", only: "villager" },
];
/* Each errand keeps its own level per child ("แบบนี้จะเพิ่มความสามารถในการหาของได้") on the player's
   own XP curve, so a child that keeps fishing becomes a fisher rather than a generalist. */
const CHILD_ERRAND_XP = 0.5;         // share of the action's XP a child earns for running it
const CHILD_ERRAND_PER_LEVELS = 12;  // +1 copy of the haul per this many levels in that errand
/* 🎯 [owner 2026-08-23] "เกี่ยว เพราะว่ายิ่งเรียนรู้ยิ่งเอาโบนัสนั้นมาใช้ได้" — the hunting track a
 * child studies now also makes THEM stronger, not only their parent. */
const CHILD_HUNT_TRACK_POWER = 0.08;   // per level of the hunt track, on their own power

/* 🎯 [owner 2026-08-23] "เพิ่มระบบสัตว์เลี้ยงให้ลูก ... pet ก็จะคอยติดตามออกสู้ได้ มี lv เพิ่มได้ ·
 * เมื่อจุติ pet ของลูกๆ ก็จะยังไม่หาย แต่ค่าจะเหมือน pet เราที่โดนหารครึ่ง"
 *
 * A child's companion is the same object a player's is — same species table, same IV roll, same
 * petStats — so everything already written about pets applies to it without a second system. What
 * differs is only how much of the fight it accounts for and how fast it learns, because a child is
 * off doing this unattended and must not become the best place to park a legendary. */
const CHILD_PET_POWER = 0.5;    // share of the pet's own power added to the child's
const CHILD_PET_XP = 0.5;       // share of the child's hunt XP the companion earns alongside it

const CHILD_TRACK_MAX = 5;
/* Cost of taking a track from `lv` to `lv + 1`. Cubic on purpose: level 1 is pocket change and
 * level 5 is a decision you make instead of buying a building. */
function childTrainCost(lv) { return Math.round(400 * Math.pow(lv + 1, 3)); }

/* ---------- 📜 เควส (quests) ----------
 * 🎯 [owner 2026-08-22] "การเปิดเควส รับงาน เช่น กดดู ถ้าไม่มีของก็ต้องไปล่า ถ้ามีของก็จบงาน"
 *
 * Every piece this needs already exists: items to ask for, a bag to check, onNewDay to refresh the
 * board, and gotoSource() — the same "go and get this" jump the action cards already use when a
 * recipe is short. Opening a job is therefore not a new screen, it is a bag lookup with two
 * outcomes.
 *
 * Rewards are derived from the items' own sell values rather than hand-written per quest, so a
 * quest can never pay less than selling the goods outright — which would make the whole board a
 * trap — and adding an item to the game cannot silently create an exploit.
 */
/* 🎯 [owner 2026-08-22] "เควสควรขึ้นให้ครบทุกตัวละคร" — one job per villager rather than four
 * drawn at random, so the board is a row of people you know instead of a lottery. */
const QUEST_SLOTS = 7;                 // one per villager
const QUEST_DAYS = 6;                  // how long one stays before it is replaced
const QUEST_PAY_MULT = 2.4;            // gold, as a multiple of what the goods would sell for
const QUEST_XP_PER_GOLD = 0.06;        // combat xp alongside the money
const QUEST_MIN_QTY = 3;
const QUEST_MAX_QTY = 12;

/* ---------- 🎖️ ฉายา (titles) ----------
 * 🎯 [owner 2026-08-22] "ฉายา ที่มาจากความสำเร็จจำนวนมาก"
 *
 * Derived, never stored. `titleFor()` counts what the player already holds at render time, so
 * there is no new save field, no migrate() step, and no way for the title and the achievements to
 * disagree — they are the same number read twice.
 *
 * It is also the only thing in the game that cannot go down. doRebirth() touches neither
 * P.achieved nor P.slayer, so every other system halves or resets around a title that only ever
 * climbs. That contrast is the point of having it.
 *
 * Ordered high-to-low; titleFor walks down and takes the first the player clears.
 */
/* 🎯 [owner 2026-08-22] "ฉายา มองว่าได้มาง่าย และไม่ครอบคลุม ทั้งต่อมอนสเตอร์ตัวนั้นๆ และมุมมอง
 * มอนสเตอร์ทั้งหมด ลองออกแบบฉายาใหม่" — and the diagnosis under it: "มันควรแยกการนับ".
 *
 * 🐛 The old ladder compared one number against a pool of two different things. `done` was
 * achievements PLUS slayer marks, and the top rung asked for 18 — the count of achievements alone,
 * against a pool of 18 + 196 = 214. The crown therefore arrived at 8% of the game. The owner reached
 * it holding 16 achievements and 12 marks, with not one species hunted to its last tier.
 *
 * So the counts are separated, and each measures the thing it is named after:
 *
 *   ach   — 18 achievements. Have you SEEN the game.
 *   mark  — 196 slayer marks (49 species × 4 tiers). Have you hunted BROADLY.
 *   bane  — species taken all the way to ☠️ โกลาหล. Have you hunted DEEPLY.
 *
 * Breadth and depth are deliberately different ladders, because 196 marks spread thin and 10 species
 * mastered are different achievements and one should not stand in for the other. `rank` is what the
 * display sorts by: the player wears the most demanding title they hold, whichever ladder it came
 * from, and the ladders interleave on purpose so progress on any of them can be the next thing.
 *
 * 👑 ผู้พิชิตมิธวูด now sits where its name always claimed it did: every species in Mythwood mastered. */
const TITLES = [
  { id: "stranger", rank: 0,  track: "ach",  need: 0,
    name: "คนแปลกหน้าจากนอกป่า", icon: "🚪", desc: "เพิ่งมาถึงมิธวูด" },
  { id: "newcomer", rank: 1,  track: "ach",  need: 3,
    name: "ผู้มาใหม่แห่งมิธวูด",   icon: "🌱", desc: "ปลดความสำเร็จ 3 รายการ" },
  { id: "firstmark", rank: 2, track: "mark", need: 10,
    name: "ผู้เริ่มสะสมรอยล่า",    icon: "🔪", desc: "เก็บรอยล่า 10 ดวง" },
  { id: "seasoned", rank: 3,  track: "ach",  need: 7,
    name: "นักเดินทางผู้ช่ำชอง",   icon: "🧭", desc: "ปลดความสำเร็จ 7 รายการ" },
  { id: "restless", rank: 4,  track: "work",
    name: "มือที่ไม่เคยว่าง",      icon: "♾️", desc: "ครบทั้งสายทำงาน" },
  { id: "known",    rank: 5,  track: "ach",  need: 12,
    name: "ผู้เป็นที่รู้จักทั้งหุบเขา", icon: "⭐", desc: "ปลดความสำเร็จ 12 รายการ" },
  { id: "hunter",   rank: 6,  track: "mark", need: 40,
    name: "นักล่าประจำหุบเขา",     icon: "🏹", desc: "เก็บรอยล่า 40 ดวง" },
  { id: "returner", rank: 7,  track: "reb",  need: 5,
    name: "ผู้กลับมาเสมอ",         icon: "🌀", desc: "จุติครบ 5 ครั้ง" },
  { id: "firstbane", rank: 8, track: "bane", need: 1,
    name: "ผู้ปราบสายพันธุ์แรก",   icon: "☠️", desc: "ล่าสายพันธุ์หนึ่งจนถึงชั้นโกลาหล" },
  { id: "chronicle", rank: 9, track: "ach",  need: 18,
    name: "ผู้เก็บครบทุกเรื่องเล่า", icon: "📖", desc: "ปลดความสำเร็จครบทั้ง 18 รายการ" },
  { id: "relentless", rank: 10, track: "mark", need: 90,
    name: "ผู้ไล่ล่าไม่เลือกหน้า",  icon: "🩸", desc: "เก็บรอยล่า 90 ดวง" },
  { id: "feared",   rank: 11, track: "bane", need: 3,
    name: "ชื่อที่ถูกเอ่ยด้วยความกลัว", icon: "👁️", desc: "ล่า 3 สายพันธุ์จนถึงชั้นโกลาหล" },
  /* 🎯 [owner 2026-08-22] Named for what the world does when it sees you, not for a count you
   * cleared. This one is also a mechanic — every species at this tier flinches when it fights you
   * (see BANE above), so the title and the effect arrive together. */
  { id: "dread",    rank: 12, track: "bane", need: 8,
    name: "ผู้ที่มอนสเตอร์หวาดกลัว", icon: "😱", desc: "ล่า 8 สายพันธุ์จนถึงชั้นโกลาหล" },
  { id: "shadow",   rank: 13, track: "mark", need: 150,
    name: "เงาที่ทุกป่าจดจำ",      icon: "🌘", desc: "เก็บรอยล่า 150 ดวง" },
  { id: "nightmare", rank: 14, track: "bane", need: 20,
    name: "ฝันร้ายของทั้งหุบเขา",  icon: "🔥", desc: "ล่า 20 สายพันธุ์จนถึงชั้นโกลาหล" },
  { id: "purifier", rank: 15, track: "mark", need: null,   // null = every mark there is
    name: "ผู้ชำระล้าง",           icon: "🗡️", desc: "เก็บรอยล่าครบทุกดวง" },
  { id: "conqueror", rank: 16, track: "bane", need: null,  // null = every species there is
    name: "ผู้พิชิตมิธวูด",         icon: "👑", desc: "ล่าครบทุกสายพันธุ์จนถึงชั้นโกลาหล" },
];

const ACHIEVEMENTS = [
  { id: "first_steps", name: "ก้าวแรกในมิธวูด", icon: "🌱", stat: "actions",  goal: 50,
    perk: { speed: 0.01 }, desc: "ทำงานสำเร็จ 50 ครั้ง" },
  { id: "worker",      name: "มือขยัน",         icon: "🛠️", stat: "actions",  goal: 1000,
    perk: { speed: 0.02 }, desc: "ทำงานสำเร็จ 1,000 ครั้ง" },
  { id: "tireless",    name: "ไม่รู้จักเหนื่อย",  icon: "♾️", stat: "actions",  goal: 10000,
    perk: { speed: 0.03 }, desc: "ทำงานสำเร็จ 10,000 ครั้ง" },
  { id: "slayer1",     name: "นักล่าหน้าใหม่",   icon: "🗡️", stat: "kills",    goal: 100,
    perk: { dmg: 1 },     desc: "ปราบมอนสเตอร์ 100 ตัว" },
  { id: "slayer2",     name: "นักล่าผู้ช่ำชอง",  icon: "⚔️", stat: "kills",    goal: 1000,
    perk: { dmg: 2 },     desc: "ปราบมอนสเตอร์ 1,000 ตัว" },
  { id: "bosskiller",  name: "ผู้ปราบตำนาน",    icon: "👑", stat: "bosses",   goal: 5,
    perk: { dmg: 2, def: 2 }, desc: "โค่นบอส 5 ตัว" },
  { id: "sprout",      name: "มือใหม่หัดปลูก",   icon: "🌱", stat: "harvests", goal: 50,
    perk: { speed: 0.01 }, desc: "เก็บเกี่ยวสำเร็จ 50 ครั้ง" },
  { id: "greenthumb",  name: "มือเขียวแห่งมิธวูด", icon: "🌻", stat: "harvests", goal: 500,
    perk: { speed: 0.02 }, desc: "เก็บเกี่ยวสำเร็จ 500 ครั้ง" },
  { id: "botanist",    name: "นักพฤกษศาสตร์",   icon: "🪴", stat: "cropSpecies", goal: 8,
    perk: { luck: 0.1 },  desc: "ปลูกพืชให้ครบทั้ง 8 ชนิด" },
  { id: "angler",      name: "นักตกปลาตัวจริง",  icon: "🎣", stat: "species",  goal: 12,
    perk: { luck: 0.1 },  desc: "ตกปลาให้ได้ครบ 12 สายพันธุ์" },
  { id: "gourmet",     name: "เชฟแห่งมิธวูด",    icon: "🍳", stat: "cooked",   goal: 300,
    perk: { healBonus: 0.15 }, desc: "ปรุงอาหาร 300 จาน" },
  { id: "smith",       name: "ช่างตีมือทอง",     icon: "⚒️", stat: "crafted",  goal: 200,
    perk: { speed: 0.02 }, desc: "ตีของ 200 ชิ้น" },
  { id: "master1",     name: "ความชำนาญขั้นต้น", icon: "⭐", stat: "masterySum", goal: 100,
    perk: { speed: 0.02 }, desc: "ขั้นชำนาญรวมทุกสาย 100" },
  { id: "master2",     name: "ปรมาจารย์",       icon: "🌠", stat: "masterySum", goal: 400,
    perk: { speed: 0.04, luck: 0.1 }, desc: "ขั้นชำนาญรวมทุกสาย 400" },
  { id: "hoarder",     name: "นักสะสมทอง",      icon: "💰", stat: "goldEarned", goal: 100000,
    perk: { goldBonus: 0.1 }, desc: "หาทองสะสมครบ 100,000" },
  { id: "scavenger",   name: "นักเก็บของเก่า",   icon: "🗑️", stat: "junkSold",  goal: 500,
    perk: { goldBonus: 0.05 }, desc: "ขายขยะ 500 ชิ้น" },
  { id: "thief",       name: "เงาในตลาด",       icon: "🕵️", stat: "steals",    goal: 250,
    perk: { luck: 0.1 },  desc: "ขโมยสำเร็จ 250 ครั้ง" },
  { id: "collector",   name: "ผู้ครอบครองชุด",   icon: "👕", stat: "setsOwned", goal: 3,
    perk: { def: 3 },     desc: "มีชุดเกราะครบเซ็ต 3 ชุด" },
];


/* 🎯 [added 2026-08-15, owner's ask] One achievement per monster, built from LOCATIONS rather than
 * hand-listed — every creature in the game is guaranteed a hunting goal, and a new monster brings
 * its own the moment it is added. Depth sets the target and the reward: shallow creatures ask for
 * many kills and pay a little, bosses ask for few and pay well. */
const MONSTER_ACHIEVEMENTS = LOCATIONS.flatMap((loc, li) => loc.stages.map((st, si) => {
  const depth = li;
  const goal = st.boss ? 5 + depth * 5 : Math.max(25, 50 - depth * 5);
  const perk = st.boss
    ? (depth >= 3 ? { dmg: 2, def: 2 } : { dmg: 1, def: 1 })
    : (si % 2 ? { def: 1 } : { dmg: 1 });
  /* ⚠️ [2026-08-24] This table is MIGRATION-ONLY. The per-monster hunt achievements were removed
   * in v28→v29 and replaced by slayer marks; the only thing that still reads this array is that
   * migration step in game.js, and it reads .id and .perk. Nothing renders .name or .desc, and
   * nothing has since.
   *
   * Written down because the text below LOOKS like a translation gap and is not. It holds 2,629
   * Thai characters that never reach a screen, and this session spent a pass rewriting them into
   * language-aware getters — a correct fix to a problem no player has. Check who reads a field
   * before translating it. */
  return {
    id: `hunt_${loc.id}_${st.id}`,
    name: `${st.boss ? "ผู้พิชิต" : "นักล่า"}${st.name}`,
    icon: st.icon,
    stat: `kill:${loc.id}:${st.id}`,
    goal,
    perk,
    desc: `ปราบ ${st.name} ที่${loc.name} ${goal} ตัว`,
  };
}));

const ARMOR_SETS = [
  { id: "copper", name: "ชุดทองแดงรุ้ง", pieces: ["helm_copper", "armor_copper", "shield_copper"],
    bonus: { def: 2, hpBonus: 10 } },
  { id: "iron", name: "ชุดเหล็กเงา", pieces: ["helm_iron", "armor_iron", "shield_iron"],
    bonus: { def: 4, hpBonus: 18 } },
  { id: "silver", name: "ชุดเงินบริสุทธิ์", pieces: ["helm_silver", "armor_silver", "shield_silver"],
    bonus: { def: 6, hpBonus: 26 } },
  { id: "gold", name: "ชุดทองคำเปลว", pieces: ["helm_gold", "armor_gold", "shield_gold"],
    bonus: { def: 8, hpBonus: 34 } },
  { id: "mith", name: "ชุดมิธริล", pieces: ["helm_mith", "armor_mith", "shield_mith"],
    bonus: { def: 10, hpBonus: 42, dmg: 4 } },
  { id: "adamant", name: "ชุดอดามันไทต์", pieces: ["helm_adamant", "armor_adamant", "shield_adamant"],
    bonus: { def: 12, hpBonus: 50, dmg: 6 } },
  { id: "night", name: "ชุดราตรีมืด", pieces: ["helm_night", "armor_night", "shield_night"],
    bonus: { def: 14, hpBonus: 58, dmg: 8 } },
  { id: "sun", name: "ชุดสุริยะ", pieces: ["helm_sun", "armor_sun", "shield_sun"],
    bonus: { def: 16, hpBonus: 66, dmg: 10 } },
];

/* 🎯 [added 2026-08-15, owner: "เริ่มเล่นง่ายขึ้นเพราะเข้ากลางเกมแล้ว"] Elite modifiers turn any
 * cleared stage into a harder version for better pay. They are pure multipliers over the existing
 * stage data, so every future monster inherits them for free, and each tier opens only after
 * clearing the tier below — an opt-in difficulty dial, never a wall. */
/* 🎯 [added 2026-08-15, owner: "มีเรื่องบอส และบ้าคลั่ง"] Boss behaviours, declared per stage.
 * They read from the same combat loop every monster uses, so a new boss just names its trick.
 *   enrage  — below `at` of its HP, its damage multiplies by `mult`
 *   armored — takes reduced damage until `hits` land in a row without the player being hit
 *   drain   — heals itself a share of its max HP on a rhythm, punishing a weak damage race */
const BOSS_TRAITS = {
  enrage:  { name: "คลั่ง",     icon: "😡", desc: (t) => `เลือดต่ำกว่า ${Math.round(t.at * 100)}% แรงขึ้น ${t.mult}เท่า` },
  armored: { name: "เกราะแข็ง", icon: "🛡️", desc: (t) => `ลดดาเมจ ${Math.round((1 - t.taken) * 100)}% จนกว่าจะตีติดต่อกัน ${t.hits} ครั้ง` },
  drain:   { name: "ดูดพลัง",   icon: "🩸", desc: (t) => `ฟื้นเลือดตัวเอง ${Math.round(t.pct * 100)}% ทุก ${t.every}s` },
};

/* 🎯 [owner 2026-08-17] "ความสำเร็จในการล่า ควรมีแยกแต่ละหัวข้อ ... จะได้สเตตัสถาวรมาใช้ ต่อมอนสเตอร์"
 *
 * A kill count per monster PER DIFFICULTY, each crossing a threshold for a permanent stat. The two
 * old hunt achievements were global totals of 100 and 1,000 and the owner had passed both — there
 * was nothing left in the whole combat tree to chase, and 1,506 of their kills sat in one tier.
 *
 * Reaching every one of these means 70,735 kills, which is not a target so much as a direction. The
 * numbers are therefore set by what a REALISTIC haul gives: clearing the normal tier on all 43
 * monsters is 1,935 kills and pays +14 damage, +14 defence and +75 HP — real, and nowhere near the
 * 108 damage on a single top weapon. The full 172 would pay far more, and should: it is the tail of
 * a game whose other systems are measured in hours.
 *
 * Which stat a monster pays is fixed by its own id, so the three are spread across the roster and
 * a player chasing one of them has to hunt widely rather than farm the easiest thing they can kill. */
/* ---------- 😱 ความกลัว (bane) ----------
 * 🎯 [owner 2026-08-22] "ล่าสไลม์สะสม 1000 ตัว อาจปลดล็อก ... เมื่อล่าสไลม์ สไลม์จะกลัว ทำให้ติด debuff"
 *
 * The owner's number was already the game's number: SLAYER_TIERS tops out at exactly 1,000 kills.
 * So this needs no new counter and no new save field — holding the top slayer mark for a monster
 * IS the condition, and that mark already survives rebirth, which is the right answer for a
 * reputation. You do not stop being the thing slimes are afraid of because you started over.
 *
 * One effect, applied to that species only: it hits softer, because it is flinching. Deliberately
 * modest — 1,000 kills is a long road and the reward should be felt without turning the ground you
 * have already cleared into a place where nothing can hurt you.
 */
const BANE_TIER = "chaos";           // the SLAYER_TIERS entry that grants it
const BANE_DAMAGE_MULT = 0.85;       // the feared monster's damage, multiplied

const SLAYER_TIERS = [
  { tier: "normal", kills: 45 },
  { tier: "elite",  kills: 200 },
  { tier: "night",  kills: 500 },
  { tier: "chaos",  kills: 1000 },
];
const SLAYER_REWARDS = {
  /* Damage is the one that feeds back into income — faster kills, more gold — so it climbs the
   * slowest across the tiers. HP buys survival, which nothing else here does, and can afford to be
   * the generous one. Every figure is an integer: a permanent reward you cannot read is not one. */
  dmg: { name: "โจมตี",     icon: "🗡️", per: [1, 1, 1, 2] },
  def: { name: "ป้องกัน",   icon: "🛡️", per: [1, 1, 2, 2] },
  hp:  { name: "พลังชีวิต", icon: "❤️", per: [5, 8, 12, 20] },
};
const SLAYER_KEYS = ["dmg", "def", "hp"];
/* Fixed by the monster's id, not by its position, so inserting a monster never reshuffles what the
 * ones after it pay — a player who earned +damage from a wolf keeps earning it from that wolf. */
function slayerRewardKey(locId, stageId) {
  const s = `${locId}:${stageId}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SLAYER_KEYS[h % SLAYER_KEYS.length];
}

const ELITE_MODES = [
  { id: "normal", name: "ปกติ",        icon: "⚔️", hp: 1,   dmg: 1,   xp: 1,   gold: 1,   loot: 1 },
  { id: "elite",  name: "ชั้นยอด",      icon: "🔶", hp: 2.2, dmg: 1.5, xp: 2.6, gold: 2.4, loot: 1.5 },
  { id: "night",  name: "ราตรีต้องสาป", icon: "🌑", hp: 4.0, dmg: 2.1, xp: 5.0, gold: 4.5, loot: 2.2 },
  { id: "chaos",  name: "โกลาหล",       icon: "☠️", hp: 7.5, dmg: 3.0, xp: 10,  gold: 9,   loot: 3.2 },
];

/* Combat splits into three trainable stats (owner, 2026-08-15): the player picks a
 * training focus and hunt XP pours into that stat alone — each keeps its own stack.
 *   โจมตี (atk)      -> base damage
 *   ป้องกัน (defs)    -> flat damage reduction on top of gear
 *   พลังชีวิต (vit)   -> max HP
 * The overall combat level (location gates) is the rounded average of the three. */
const COMBAT_STATS = [
  { id: "atk",  name: "โจมตี",     icon: "🗡️" },
  { id: "defs", name: "ป้องกัน",   icon: "🛡️" },
  { id: "vit",  name: "พลังชีวิต", icon: "❤️" },
];
/* 🐛 [fixed 2026-08-15, owner: "เหมือนมันควร +1 แต่ที่เห็นน่าจะสองเวล +1"] Damage used
 * Math.floor(0.9 * (lv-1)) and defence Math.floor(lv/2), so both only moved every OTHER level —
 * a level-up often showed no stat change at all, which read as broken. Both are now a clean
 * +1 per level: every point spent visibly moves the number it was spent on. */
function playerMaxHp(vitLevel) { return 40 + 7 * (vitLevel - 1); }
function playerBaseDmg(atkLevel) { return 3 + (atkLevel - 1); }
function statDefBonus(defLevel) { return defLevel - 1; }
const PLAYER_ATTACK_INTERVAL = 2.4;
/* Auto-eat threshold is the player's call (owner, 2026-08-15) — some want a sip at 50%, some
 * want to ride it to 10% and save food. FOOD_SLOTS run in order: when the first is empty the
 * second is used, then the third, so a long hunt can stack three different dishes. */
const AUTO_EAT_OPTIONS = [0.1, 0.2, 0.3, 0.4, 0.5];
const AUTO_EAT_DEFAULT = 0.5;
const FOOD_SLOTS = 3;

/* 🎯 [added 2026-08-15, owner's design] Pets are companions with their own HP / level / attack /
 * defence, dropped by monsters — the deeper the ground, the better the breed. They fight beside
 * the player, take a share of incoming blows, and eat from the SAME provision slots the player
 * uses, so packing food now feeds two mouths. A fainted pet stops helping until it is healed. */
const PET_SPECIES = [
  { id: "slimelet",  name: "สไลม์น้อย",      icon: "🫧", tier: 1, hp: 30,  atk: 2,  def: 1 },
  { id: "bunbun",    name: "กระต่ายเขาเดียว", icon: "🐰", tier: 1, hp: 26,  atk: 3,  def: 1 },
  { id: "pupwolf",   name: "ลูกหมาป่าเงา",   icon: "🐺", tier: 2, hp: 45,  atk: 4,  def: 2 },
  { id: "sprout",    name: "หน่อพฤกษา",      icon: "🌿", tier: 2, hp: 60,  atk: 3,  def: 4 },
  { id: "batling",   name: "ค้างคาวน้อย",    icon: "🦇", tier: 3, hp: 70,  atk: 6,  def: 3 },
  { id: "snowpup",   name: "ลูกโกเลมหิมะ",   icon: "⛄", tier: 3, hp: 110, atk: 5,  def: 8 },
  { id: "emberfox",  name: "ลูกจิ้งจอกเพลิง", icon: "🦊", tier: 4, hp: 130, atk: 9, def: 6 },
  { id: "lavapup",   name: "หนูลาวา",        icon: "🐀", tier: 4, hp: 115, atk: 8, def: 8 },
  { id: "skyhawk",   name: "เหยี่ยวเวหา",    icon: "🪽", tier: 5, hp: 170, atk: 13, def: 9 },
  { id: "cloudcat",  name: "แมวเมฆา",        icon: "🐈", tier: 5, hp: 200, atk: 11, def: 14 },
  { id: "voidwisp",  name: "ดวงไฟไร้ชื่อ",   icon: "🌀", tier: 6, hp: 260, atk: 17, def: 16 },
  { id: "starcub",   name: "ลูกดาวตก",       icon: "☄️", tier: 6, hp: 300, atk: 15, def: 22 },
  { id: "scarabling", name: "ด้วงทองน้อย",   icon: "🪲", tier: 7, hp: 340, atk: 20, def: 26 },
  { id: "sandcat",   name: "แมวทะเลทราย",    icon: "🐈‍⬛", tier: 7, hp: 300, atk: 23, def: 20 },
  { id: "novaling",  name: "ลูกโนวา",        icon: "💥", tier: 8, hp: 400, atk: 28, def: 30 },
  { id: "starwhale", name: "วาฬดาวน้อย",     icon: "🐋", tier: 8, hp: 460, atk: 25, def: 34 },
];

/* A pet gains a level per fight it survives; stats climb by a share of its base each time, so a
 * tier-1 companion raised long enough still lags a tier-6 one but never becomes useless. */
/* 🎯 [added 2026-08-15, owner: "แต่ละตัวควรมีค่า hp atk ต่างกัน"] Every captured companion rolls
 * its own quality per stat, so catching a second slime is a real decision rather than a duplicate.
 * The spread is wide enough to matter and tight enough that a great low-tier pet never beats a
 * poor high-tier one — the tier ladder still leads. */
/* 🎯 [owner 2026-08-22] Grade bands, the catch ceiling and the fusion ceiling, set by the owner.
 *
 * Two ceilings, not one. A wild catch rolls up to PET_IV_CATCH_MAX, which is exactly where ตำนาน
 * ends — so the best thing the world hands you is a legend, and everything above it has to be bred.
 * Sharing one constant would have made กึ่งเทวะ and เทพสวรรค์ catchable and emptied fusion of its
 * purpose.
 *
 * The floor moved 0.80 → 0.70 because the owner's new bands put พอใช้ at 0.80: with the old floor
 * nothing could ever roll below it, so ธรรมดา became a grade that could not occur and
 * "ธรรมดา + ธรรมดา" was a rule about something that does not exist. It also pulls the catch curve
 * back down — at 0.80 a wild catch was ยอดเยี่ยม 57% of the time, which made the good grade the
 * default rather than a result. */
const PET_IV_MIN = 0.70;
/* 🎯 [owner 2026-08-22] "ควรเจอ ธรรมดา ดี ดีเยี่ยม เหมือนระบบเดิม แต่การจะหาสายพันธุ์ตำนาน กึ่งเทวะ
 * เทพ จากการจับมันยากแสนยาก ต้องผสมเอา"
 *
 * 1.20 rather than 1.25, and the difference is the whole feel of catching. At 1.25 a legend turned
 * up every 35 catches; at 1.20 it is one in two hundred, while ธรรมดา/พอใช้/ดี/ยอดเยี่ยม keep the
 * spread the game has always had. กึ่งเทวะ starts at 1.25 and so cannot be caught at all — the two
 * top grades are bred or they are not had.
 *
 * A caught legend also lands in the BOTTOM half of its band (1.15–1.20) and never the top, which
 * falls out of this rather than being designed: the ones you find are the lesser legends, and the
 * strong ones come from breeding. */
const PET_IV_CATCH_MAX = 1.20;

/* 🎯 [owner 2026-08-22] "กึ่งเทวะ เทพ ต้องผสมเอา จะง่ายกว่า แต่ถ้าถามว่ามีโอกาสไหมที่จะเจอจับได้ คือ <1%"
 *
 * So the door is not locked, it is just very rarely open. Two in a hundred wild catches are BLESSED
 * and roll against the fusion ceiling instead of the catch ceiling. That works out at 0.14% กึ่งเทวะ
 * and 0.15% เทพสวรรค์ across all catches — about one in seven hundred, which at the endgame catch
 * rate is some twenty-eight thousand kills. A once-in-a-playthrough story rather than a plan.
 *
 * A flat "1% chance of a demigod" would have been the easy version and the wrong one: it would make
 * the top grade a lottery you can grind, sitting alongside a breeding ladder that is supposed to be
 * the way there. This keeps breeding as the route and leaves room for a miracle. */
const PET_BLESSED_CATCH = 0.02;
const PET_IV_MAX = 1.50;         // fusion can climb past it; nothing else can
const PET_GRADES = [
  { at: 1.30, name: "เทพสวรรค์", cls: "sss" },
  { at: 1.25, name: "กึ่งเทวะ",  cls: "ss" },
  { at: 1.15, name: "ตำนาน",     cls: "s" },
  { at: 1.00, name: "ยอดเยี่ยม", cls: "a" },
  { at: 0.90, name: "ดี",        cls: "b" },
  { at: 0.80, name: "พอใช้",     cls: "c" },
  { at: 0,    name: "ธรรมดา",    cls: "d" },
];
function petGrade(iv) {
  const avg = (iv.hp + iv.atk + iv.def) / 3;
  return { ...PET_GRADES.find((g) => avg >= g.at), pct: Math.round(avg * 100) };
}
/* 🎯 [owner 2026-08-17] "ให้ pet ที่ใช้ประจำ ตัวยอดเยี่ยม ได้รับการเลือก ... ให้มันไปด้วยตอนจุติ
 * pet ก็จะโดนหาร ลด lv/2 เช่นกัน" — one companion comes through a rebirth on the same terms the
 * player does, halved rather than lost.
 *
 * Which one is deliberately not a ranking: it is THE PET YOU WERE FIELDING. A search for "your best
 * pet" would be a rule nobody can see the answer to without opening a menu, whereas the one walking
 * beside you is on screen already — which is exactly how the owner described it ("ดูง่ายคือ ตัวที่
 * ลงสนาม"). The two bars stop it being automatic: a companion has to have been worth raising. */
const PET_GRADE_RANK = ["d", "c", "b", "a", "s", "ss", "sss"];
/* 🎯 [owner 2026-08-17: "สัตว์เลี้ยงจุติ ไม่กำหนดขั้น ไม่งั้นมันจะยาก เพราะยิ่งต้นเกม กว่าจะไปขั้น 15
 * นานมาก"] There was a level-15 bar here as well. It was wrong for the moment it matters most: the
 * early rebirths come round fast, a companion takes many game-days to reach 15, and the bar meant
 * the answer was "ไม่มี" for every one of them — a rule whose only effect was to withhold the
 * feature from the players it was written for. GRADE is the whole test now: a pet worth keeping is
 * one that rolled well, which you know the moment you catch it, not something you grind toward. */
const PET_REBIRTH_MIN_GRADE = "b";   // ดี or better, per the owner's "ค่าดี หรือ ดีเยี่ยม"
function petGradeAtLeast(cls, min) {
  return PET_GRADE_RANK.indexOf(cls) >= PET_GRADE_RANK.indexOf(min);
}

/* ---------- 🧬 ผสมพันธุ์ (pet fusion) ----------
 * เจ้าของเสนอ 2026-08-18: สองตัวคุณภาพเดียวกันรวมร่างเป็นหนึ่งตัว มีโอกาสเลื่อนขั้นคุณภาพขึ้นไปหนึ่ง
 * ขั้น สายพันธุ์เดียวกันได้สายพันธุ์เดิม ต่างสายพันธุ์แตกแขนงสุ่มได้ตัวใดตัวหนึ่งของพ่อแม่ ระดับ
 * ผสมกันแบบเฉลี่ยแต่มีโชคบวกได้เล็กน้อย modelled and checked in pet_fusion_sim.mjs before this
 * touched game.js — same discipline as guild_sim/shop_sim. */
/* 🎯 [owner 2026-08-22] The chance of leaving a grade, keyed by the grade you are fusing FROM.
 * It falls as you climb — the owner's ladder, and the reason the top is a project rather than a
 * purchase. Missing is not a loss: you still get the grade you put in, so a fusion trades two
 * companions for one and a roll, never for something worse. */
const PET_FUSION_UP_BY_GRADE = {
  d: 0.80,     // ธรรมดา   → พอใช้
  c: 0.70,     // พอใช้    → ดี
  b: 0.60,     // ดี       → ยอดเยี่ยม
  a: 0.50,     // ยอดเยี่ยม → ตำนาน
  s: 0.40,     // ตำนาน    → กึ่งเทวะ
  ss: 0.30,    // กึ่งเทวะ  → เทพสวรรค์
};
/* Kept as the fallback for any grade not listed, and because the old constant is referenced by
 * name in the fusion simulator's own commentary. */
const PET_FUSION_GRADE_UP = 0.5;
const PET_FUSION_LEVEL_LO = 0.90;    // combined-level random multiplier on the parents' average
const PET_FUSION_LEVEL_HI = 1.35;    // owner's example: lv5 + lv1 (avg 3) "อาจได้ขั้น 3 หรือ 4"
/* The IV band a fresh roll must land in to score as a given grade — every one of hp/atk/def is
 * rolled independently WITHIN this range, so their average is mechanically guaranteed to fall in
 * it too, without needing to reverse-engineer petGrade()'s own threshold. PET_GRADES is sorted
 * highest-first, so the grade one row up the list is the next band up. */
function petGradeBand(cls) {
  const idx = PET_GRADES.findIndex((g) => g.cls === cls);
  const g = PET_GRADES[idx];
  const above = PET_GRADES[idx - 1];
  return { lo: Math.max(PET_IV_MIN, g.at), hi: above ? above.at : PET_IV_MAX };
}

/* 🎯 [raised 30 → 38, 2026-08-19] Not a round-number bump: the ninth zone added enough combat xp
 * that the two most generous PET_XP_OPTIONS both pinned a companion at the old cap of 30, so
 * "แบ่ง 8%" and "แบ่ง 10%" became the same choice and balance_check's every-option-differs rule
 * caught it. 38 is where the options separate again (1 / 24 / 31 / 36) AND where the effect
 * saturates — 40, 45 and 50 all produce those same four levels, so anything beyond 38 would be
 * ceiling for its own sake. */
/* 🎯 [owner 2026-08-22] "pet มีขั้นสูงสุดถึง 99" — and the growth per rank comes down to match, so
 * ninety-nine ranks are a longer road rather than a stronger companion. At the old +5% a rank-99
 * pet would sit at ×5.90 of its base, twice what rank 38 gave; at +2% it lands on ×2.96, which is
 * where rank 38 already was. The power ceiling is unchanged and what fills the road is skills. */
const PET_MAX_LEVEL = 99;
const PET_GROWTH = 0.02;          // +2% of base per level
const PET_DAMAGE_SHARE = 0.25;    // fraction of monster blows the pet soaks
const PET_EAT_BELOW = 0.4;        // it eats from your provisions under this
/* 🎯 [changed 2026-08-15, owner: "ดูดค่า exp เราไปใช้ 5-10%"] A companion no longer grows for
 * free — it takes a share of the combat XP that would have gone to your own training, so fielding
 * one is a trade: it gets stronger while you get stronger slower. The share is the player's to
 * pick, including 0 (fights beside you, learns nothing). The curve is tuned so a pet on the 8%
 * setting matures at roughly the pace its owner does, rather than lagging generations behind. */
const PET_XP_OPTIONS = [0, 0.05, 0.08, 0.10];
/* 🎯 [owner 2026-08-17] "มันเหมือนรอเทิร์นฟรี ที่คนต้องรอ pet ตี สลับมอนสเตอร์"
 * It is not a turn order — the player, the companion and the monster each run their own timer, so a
 * companion adds damage without giving the monster anything. What it did not have was a visible
 * rhythm: the fight drew two attack bars while three things were attacking, and hits that arrive
 * with no bar behind them look like they came out of someone else's turn. Naming the interval is
 * the first half of showing it. */
const PET_ATTACK_INTERVAL     = 3000;   // ms, at rank 1
const PET_ATTACK_INTERVAL_MIN = 2000;   // ms, at PET_MAX_LEVEL
/* 🎯 [owner 2026-08-17] "เราแทบไม่รู้ตัว ให้มันทำงานเบื้องหลัง การปลดล็อกแต่ละขั้น ตามที่ควร"
 * A rank-1 companion and a rank-30 one swung at exactly the same speed, so thirty ranks of growth
 * showed up only as a bigger number in the damage popup. Speed climbs with rank now, and one thing
 * UNLOCKS partway up — a curve you can feel and a moment you can point at, rather than either
 * alone. The floor is 2s rather than something faster because a companion that out-swings the
 * player stops being a companion. */
function petAttackInterval(level) {
  const t = (Math.min(Math.max(level, 1), PET_MAX_LEVEL) - 1) / (PET_MAX_LEVEL - 1);
  return Math.round(PET_ATTACK_INTERVAL - t * (PET_ATTACK_INTERVAL - PET_ATTACK_INTERVAL_MIN));
}
/* ---------- 🐾 ทักษะสัตว์เลี้ยง (companion skills) ----------
 * 🎯 [owner 2026-08-22] "ทุก 5 ขั้น จะมีทักษะเพิ่มในการโจมตีหรือป้องกัน หรือ 10 จะมีสกิลคอมโบ สกิลใหญ่
 * หรือฮีล ซึ่งใช้ฮีลตัวเองและเจ้าของได้"
 *
 * Ninety-nine ranks with nothing but a rising number is ninety-nine ranks nobody feels. Something
 * lands every five, and the every-ten ones are the ones you notice in a fight.
 *
 * The heavy blow at rank 10 is not new — it already existed as PET_SPECIAL_* and is simply the
 * first entry in this table now, so there is one place that answers "what does this rank give me".
 *
 * `kind`:
 *   atk / def   passive, folded into petStats
 *   heavy       a multiplied strike every Nth of its OWN swings
 *   combo       several strikes at once, on the same rhythm
 *   heal        restores the companion AND the player — the owner asked for both
 */
const PET_SKILLS = [
  { lv: 5,  kind: "atk",   value: 0.06, icon: "🗡️", name: "เขี้ยวคม" },
  { lv: 10, kind: "heavy", value: 2.0,  every: 6, icon: "💥", name: "ท่าหนัก" },
  { lv: 15, kind: "def",   value: 0.06, icon: "🛡️", name: "หนังหนา" },
  { lv: 20, kind: "heal",  value: 0.08, every: 8, icon: "💚", name: "ลมหายใจฟื้นฟู" },
  { lv: 25, kind: "atk",   value: 0.08, icon: "🗡️", name: "เขี้ยวคมขึ้น" },
  { lv: 30, kind: "combo", value: 3,    every: 9, icon: "🌀", name: "คอมโบสามชั้น" },
  { lv: 35, kind: "def",   value: 0.08, icon: "🛡️", name: "หนังหนาขึ้น" },
  { lv: 40, kind: "heavy", value: 2.6,  every: 6, icon: "💥", name: "ท่าหนักแท้" },
  { lv: 45, kind: "atk",   value: 0.10, icon: "🗡️", name: "เขี้ยวสังหาร" },
  { lv: 50, kind: "heal",  value: 0.14, every: 7, icon: "💚", name: "ลมหายใจศักดิ์สิทธิ์" },
  { lv: 55, kind: "def",   value: 0.10, icon: "🛡️", name: "เกล็ดแข็ง" },
  { lv: 60, kind: "combo", value: 4,    every: 8, icon: "🌀", name: "คอมโบสี่ชั้น" },
  { lv: 65, kind: "atk",   value: 0.12, icon: "🗡️", name: "เขี้ยวทำลายล้าง" },
  { lv: 70, kind: "heavy", value: 3.2,  every: 5, icon: "💥", name: "ท่าหนักทำลายล้าง" },
  { lv: 75, kind: "def",   value: 0.12, icon: "🛡️", name: "เกล็ดอมตะ" },
  { lv: 80, kind: "heal",  value: 0.20, every: 6, icon: "💚", name: "ลมหายใจอมตะ" },
  { lv: 85, kind: "atk",   value: 0.15, icon: "🗡️", name: "เขี้ยวเทพ" },
  { lv: 90, kind: "combo", value: 5,    every: 7, icon: "🌀", name: "คอมโบห้าชั้น" },
  { lv: 95, kind: "def",   value: 0.15, icon: "🛡️", name: "เกราะเทพ" },
];

/* Everything unlocked at this rank. Later entries of the same kind REPLACE earlier ones rather than
 * stacking — rank 70's heavy blow is the rank 10 one grown up, not a second blow beside it. The
 * passives do stack, because "a little more attack every ten ranks" is the shape of the ladder. */
function petSkillsAt(lv) {
  const got = PET_SKILLS.filter((s) => lv >= s.lv);
  const out = { atk: 0, def: 0, heavy: null, combo: null, heal: null, list: got };
  for (const s of got) {
    if (s.kind === "atk") out.atk += s.value;
    else if (s.kind === "def") out.def += s.value;
    else out[s.kind] = s;          // last one wins
  }
  return out;
}
function petNextSkill(lv) { return PET_SKILLS.find((s) => s.lv > lv) || null; }

/* Kept for the save-compat path and because the fight code reads them as fallbacks. */
const PET_SPECIAL_LEVEL = 10;
const PET_SPECIAL_EVERY = 6;
const PET_SPECIAL_MULT  = 2.0;

const PET_XP_DEFAULT = 0.05;
function petXpToReach(level) {
  /* Derived, not guessed: the whole game yields ~200k combat XP over one full clear, and the curve
   * is set so the 10% share raises a companion to the cap. Every setting therefore buys a visibly
   * different animal, which is the point of making it a choice.
   *
   * 🎯 [owner 2026-08-22] The cap moved 38 → 99, and the exponent came down 1.64 → 1.2916 to keep
   * that promise: reaching rank 99 now costs what rank 38 used to (354,465), so the same play
   * reaches the same place and what changed is how many stops there are on the way. Left at 1.64 a
   * rank-99 companion would have needed 1.75 million — about a hundred and seventy-five full clears
   * — which is not a ceiling, it is a number nobody would ever see.
   *
   * 1.2760 rather than the 1.2916 that merely matched the old cost: balance_check measures the XP
   * the game actually yields (3,299,900 over a full clear) and holds the promise in the first line
   * of this comment — the 10% share must reach the cap. At 1.2916 it stopped at rank 93, so the
   * comment and the number disagreed and the check said so. Fitted to the real yield instead. */
  return level <= 1 ? 0 : Math.floor(950 * Math.pow(level - 1, 1.2760));
}
function petStat(base, level) { return Math.round(base * (1 + (level - 1) * PET_GROWTH)); }

/* Which breeds a stage can drop, and how often. Deeper ground rolls better tiers. */
const PET_DROP_BASE = 0.012;      // per kill, before the tier weighting

/* 🎯 [added 2026-08-15, owner's ask] Items sort themselves into these four bags on sight, so a
 * fresh profile has useful tabs without anyone organising anything. Order matters: the first
 * matching rule wins, so cooked dishes land in อาหาร rather than ปลา even though they are made of
 * fish. A player-made category still overrides the automatic one for any single item. */
/* ---------- Bank ----------
 * "ยิ่งฝากนานยิ่งมีดอกเบี้ย" (owner). The rate is a function of how long the deposit has sat
 * UNTOUCHED: adding more money keeps the clock running, taking any out restarts it. That is the
 * whole tension — the bank is the safe route, but only if you can leave it alone. */
/* 🎯 [owner 2026-08-17] "100000 ได้กำไรน้อยแปลกๆ ... ยอดยังน้อยอยู่เลย"
 * They were right, and half of it was a lie on the card rather than the rate itself: the panel
 * printed the rate with toFixed(0), so a 1.5% account advertised 2% and a 2.5% one advertised 3%.
 * Every rung of the ladder read a notch high, which is exactly the shape of "the number promised
 * more than it paid".
 *
 * The rest was real. At 1.5% of a game-year on 131k the account paid about 198 gold an hour of real
 * time against a hunting income near 30,000 — not a modest option, an irrelevant one. The ladder
 * starts at 3% and tops out at 8% now. It stays UNDER property's 9% on purpose: the bank is the
 * safe liquid corner of the ladder and has to pay least of everything, or nothing else is worth
 * the risk — the ceiling sits under the WORST dividend in the market (7%), not under property's 9%,
 * because a risk-free rate that beats the weakest company makes every company pointless. Two gates
 * caught 8% doing exactly that. Property also still charges a 15% exit fee that this does not. */
const BANK_BASE_RATE = 0.03;       // per game year, on day one
const BANK_RATE_PER_YEAR = 0.015;  // added for each full year left untouched
const BANK_MAX_RATE = 0.065;
function bankRate(yearsHeld) {
  return Math.min(BANK_MAX_RATE, BANK_BASE_RATE + BANK_RATE_PER_YEAR * Math.floor(yearsHeld));
}

/* ---------- The market ----------
 * 30 businesses in three weight classes, priced so that owning one outright costs what the owner
 * asked for: small 1k-10k, medium 10k-100k, large 100k+. Every company is 100 shares, so a share
 * is literally one percent and holding all 100 makes you the owner.
 *
 * Risk and return are traded off the way they are in life: the corner bakery pays a fat yield and
 * lurches around, the star-core utility pays little and barely moves. `vol` is the daily swing,
 * and prices pull back toward `base` (MARKET_REVERSION) rather than trending — so the trading
 * game is buying a dip and selling a spike, not guessing a direction forever. */
const SHARES_PER_COMPANY = 100;
const MARKET_REVERSION = 0.06;    // per game day, pull back toward base
const MARKET_FLOOR = 0.35;        // price may not fall below this fraction of base
const MARKET_CEIL = 2.5;
const OWNER_DIVIDEND_BONUS = 0.2; // holding all 100 shares pays 20% more

const COMPANY_SIZES = [
  { id: "s", name: "กิจการเล็ก",  icon: "🏠", note: "ซื้อขาดหลักพัน–หมื่น · ปันผลสูง แต่ราคาเหวี่ยงแรง" },
  { id: "m", name: "กิจการกลาง", icon: "🏬", note: "ซื้อขาดหลักหมื่น–แสน · สมดุลระหว่างปันผลกับความนิ่ง" },
  { id: "l", name: "บริษัทใหญ่",  icon: "🏛️", note: "ซื้อขาดหลักแสนขึ้นไป · ปันผลต่ำแต่ราคานิ่ง ทนทาน" },
];

const COMPANIES = [
  /* --- small: 100 shares = 1,500-9,500 --- */
  { id: "bakery",   name: "แผงขนมปังป้าหอม",     icon: "🍞", size: "s", base: 15,    yield: 0.40, divDays: 15, vol: 0.10 },
  { id: "cobbler",  name: "ร้านซ่อมรองเท้าเดินทาง", icon: "👞", size: "s", base: 22,    yield: 0.36, divDays: 15, vol: 0.09 },
  { id: "inn",      name: "โรงเตี๊ยมหมาป่าหลับ",   icon: "🛏️", size: "s", base: 30,    yield: 0.34, divDays: 30, vol: 0.09 },
  { id: "florist",  name: "แผงดอกไม้จันทรา",      icon: "💐", size: "s", base: 38,    yield: 0.32, divDays: 15, vol: 0.10 },
  { id: "barber",   name: "ร้านตัดผมช่างเล่า",     icon: "✂️", size: "s", base: 45,    yield: 0.30, divDays: 30, vol: 0.08 },
  { id: "chandler", name: "โรงหล่อเทียนเวท",      icon: "🕯️", size: "s", base: 55,    yield: 0.28, divDays: 30, vol: 0.08 },
  { id: "teahouse", name: "ร้านชาใบหมอก",         icon: "🍵", size: "s", base: 64,    yield: 0.27, divDays: 30, vol: 0.07 },
  { id: "stable",   name: "คอกม้าเช่าเร็ว",        icon: "🐴", size: "s", base: 74,    yield: 0.25, divDays: 45, vol: 0.07 },
  { id: "driedfish",name: "แผงปลาแห้งท่าเรือ",     icon: "🐟", size: "s", base: 84,    yield: 0.23, divDays: 45, vol: 0.07 },
  { id: "armorfix", name: "ร้านซ่อมเกราะข้างตลาด",  icon: "🛡️", size: "s", base: 95,    yield: 0.20, divDays: 45, vol: 0.06 },
  { id: "honey",          name: "แผงน้ำผึ้งป่า",                icon: "🍯", size: "s", base: 12,       yield: 0.352, divDays: 1, vol: 0.1 },
  { id: "laundry",        name: "ร้านซักผ้าลำธาร",              icon: "🧺", size: "s", base: 18,       yield: 0.35, divDays: 3, vol: 0.097 },
  { id: "charcoal",       name: "เตาถ่านตาเจียม",               icon: "🪵", size: "s", base: 20,       yield: 0.357, divDays: 7, vol: 0.096 },
  { id: "pickle",         name: "แผงผลไม้ดองยาย",               icon: "🥒", size: "s", base: 25,       yield: 0.356, divDays: 15, vol: 0.093 },
  { id: "tailor",         name: "ร้านเย็บผ้าซอยกลาง",           icon: "🪡", size: "s", base: 27,       yield: 0.363, divDays: 30, vol: 0.092 },
  { id: "ricemill",       name: "โรงสีข้าวเนินลม",              icon: "🌾", size: "s", base: 33,       yield: 0.306, divDays: 1, vol: 0.089 },
  { id: "rootcafe",       name: "ร้านกาแฟรากไม้",               icon: "☕", size: "s", base: 35,       yield: 0.312, divDays: 3, vol: 0.089 },
  { id: "spice",          name: "แผงเครื่องเทศตะวันออก",        icon: "🧂", size: "s", base: 41,       yield: 0.308, divDays: 7, vol: 0.086 },
  { id: "locksmith",      name: "ร้านทำกุญแจ",                  icon: "🔑", size: "s", base: 48,       yield: 0.301, divDays: 15, vol: 0.082 },
  { id: "mushroom",       name: "โรงเพาะเห็ดใต้ดิน",            icon: "🍄", size: "s", base: 50,       yield: 0.305, divDays: 30, vol: 0.081 },
  { id: "ropenet",        name: "ร้านเชือกและตาข่าย",           icon: "🪢", size: "s", base: 52,       yield: 0.264, divDays: 1, vol: 0.08 },
  { id: "eggfarm",        name: "แผงไข่ฟาร์มเนินลม",            icon: "🥚", size: "s", base: 58,       yield: 0.259, divDays: 3, vol: 0.077 },
  { id: "tentfix",        name: "ร้านซ่อมร่มและเต็นท์",         icon: "⛺", size: "s", base: 60,       yield: 0.263, divDays: 7, vol: 0.076 },
  { id: "apiary",         name: "โรงเลี้ยงผึ้งจันทรา",          icon: "🐝", size: "s", base: 67,       yield: 0.255, divDays: 15, vol: 0.073 },
  { id: "wooddoll",       name: "ร้านตุ๊กตาไม้",                icon: "🪆", size: "s", base: 70,       yield: 0.255, divDays: 30, vol: 0.071 },
  { id: "herbstall",      name: "แผงยาสมุนไพรตายาย",            icon: "🌿", size: "s", base: 77,       yield: 0.209, divDays: 1, vol: 0.068 },
  { id: "usedbook",       name: "ร้านหนังสือมือสอง",            icon: "📚", size: "s", base: 80,       yield: 0.209, divDays: 3, vol: 0.066 },
  { id: "soap",           name: "โรงต้มสบู่ดอกไม้",             icon: "🧼", size: "s", base: 87,       yield: 0.2, divDays: 7, vol: 0.062 },
  { id: "hourglass",      name: "ร้านนาฬิกาทราย",               icon: "⏳", size: "s", base: 90,       yield: 0.199, divDays: 15, vol: 0.061 },
  { id: "grill",          name: "แผงปิ้งย่างหน้าตลาด",          icon: "🍢", size: "s", base: 92,       yield: 0.2, divDays: 30, vol: 0.06 },
  { id: "xs01",              name: "ร้านตัดผมซอยใน",                icon: "💈", size: "s", base:     16, yield: 0.39  , divDays:   3, vol: 0.098 },
  { id: "xs02",              name: "แผงผลไม้ตลาดเช้า",              icon: "🍊", size: "s", base:     18, yield: 0.381 , divDays:   7, vol: 0.096 },
  { id: "xs03",              name: "ร้านซ่อมร่มเก่า",               icon: "☂️", size: "s", base:     19, yield: 0.371 , divDays:  15, vol: 0.094 },
  { id: "xs04",              name: "โรงสีข้าวเล็ก",                 icon: "🌾", size: "s", base:     21, yield: 0.362 , divDays:  30, vol: 0.092 },
  { id: "xs05",              name: "ร้านขายเทียนหอม",               icon: "🕯️", size: "s", base:     23, yield: 0.352 , divDays:  45, vol: 0.09 },
  { id: "xs06",              name: "แผงปลาย่างริมคลอง",             icon: "🐟", size: "s", base:     25, yield: 0.343 , divDays:   3, vol: 0.089 },
  { id: "xs07",              name: "ร้านเช่าจักรยาน",               icon: "🚲", size: "s", base:     28, yield: 0.333 , divDays:   7, vol: 0.087 },
  { id: "xs08",              name: "โรงย้อมผ้าคราม",                icon: "🧵", size: "s", base:     30, yield: 0.324 , divDays:  15, vol: 0.085 },
  { id: "xs09",              name: "แผงของเล่นไม้",                 icon: "🪀", size: "s", base:     33, yield: 0.314 , divDays:  30, vol: 0.083 },
  { id: "xs10",              name: "ร้านชาใบหอม",                   icon: "🍵", size: "s", base:     37, yield: 0.305 , divDays:  45, vol: 0.081 },
  { id: "xs11",              name: "โรงเผาถ่านชายป่า",              icon: "🔥", size: "s", base:     40, yield: 0.295 , divDays:   3, vol: 0.079 },
  { id: "xs12",              name: "แผงเครื่องเทศ",                 icon: "🌶️", size: "s", base:     44, yield: 0.286 , divDays:   7, vol: 0.077 },
  { id: "xs13",              name: "ร้านซ่อมนาฬิกา",                icon: "⏰", size: "s", base:     48, yield: 0.276 , divDays:  15, vol: 0.075 },
  { id: "xs14",              name: "โรงทำสบู่ดอกไม้",               icon: "🧼", size: "s", base:     53, yield: 0.267 , divDays:  30, vol: 0.073 },
  { id: "xs15",              name: "แผงหมึกและปากกา",               icon: "🖋️", size: "s", base:     58, yield: 0.257 , divDays:  45, vol: 0.071 },
  { id: "xs16",              name: "ร้านเช่าเรือพาย",               icon: "🛶", size: "s", base:     64, yield: 0.248 , divDays:   3, vol: 0.07 },
  { id: "xs17",              name: "โรงทำเชือกป่าน",                icon: "🪢", size: "s", base:     70, yield: 0.238 , divDays:   7, vol: 0.068 },
  { id: "xs18",              name: "แผงขนมหวานจันทรา",              icon: "🍡", size: "s", base:     77, yield: 0.229 , divDays:  15, vol: 0.066 },
  { id: "xs19",              name: "ร้านซักรีดริมซอย",              icon: "🧺", size: "s", base:     84, yield: 0.219 , divDays:  30, vol: 0.064 },
  { id: "xs20",              name: "โรงทำแก้วเป่า",                 icon: "🫙", size: "s", base:     92, yield: 0.21  , divDays:  45, vol: 0.062 },
  /* --- medium: 100 shares = 15,000-95,000 --- */
  { id: "brewery",  name: "โรงเบียร์ราชาแคระ",     icon: "🍺", size: "m", base: 150,   yield: 0.22, divDays: 30, vol: 0.050 },
  { id: "quarry",   name: "เหมืองหินอ่อนเนินเงา",   icon: "⛰️", size: "m", base: 210,   yield: 0.21, divDays: 30, vol: 0.048 },
  { id: "troupe",   name: "คณะละครเร่แสงจันทร์",    icon: "🎭", size: "m", base: 280,   yield: 0.20, divDays: 45, vol: 0.050 },
  { id: "shipyard", name: "อู่ต่อเรือท่าน้ำลึก",     icon: "⛵", size: "m", base: 360,   yield: 0.19, divDays: 45, vol: 0.045 },
  { id: "dyeworks", name: "โรงย้อมผ้าสีคราม",      icon: "🧵", size: "m", base: 450,   yield: 0.18, divDays: 45, vol: 0.042 },
  { id: "courier",  name: "สำนักส่งสารนกเวท",      icon: "🕊️", size: "m", base: 540,   yield: 0.17, divDays: 30, vol: 0.040 },
  { id: "sawmill",  name: "โรงเลื่อยไม้วิญญาณ",     icon: "🪚", size: "m", base: 640,   yield: 0.16, divDays: 60, vol: 0.038 },
  { id: "bazaar",   name: "ตลาดนัดข้ามมิติ",       icon: "🎪", size: "m", base: 740,   yield: 0.15, divDays: 60, vol: 0.040 },
  { id: "perfume",  name: "โรงกลั่นน้ำหอมดาว",     icon: "🧴", size: "m", base: 850,   yield: 0.14, divDays: 60, vol: 0.035 },
  { id: "escort",   name: "สำนักรับจ้างคุ้มกัน",     icon: "⚔️", size: "m", base: 950,   yield: 0.13, divDays: 60, vol: 0.032 },
  { id: "papermill",      name: "โรงงานกระดาษเปลือกไม้",        icon: "📜", size: "m", base: 120,      yield: 0.207, divDays: 7, vol: 0.05 },
  { id: "saltmine",       name: "เหมืองเกลือหุบเขา",            icon: "🏔️", size: "m", base: 170,     yield: 0.208, divDays: 15, vol: 0.049 },
  { id: "orchestra",      name: "คณะนักดนตรีราชสำนัก",          icon: "🎻", size: "m", base: 190,      yield: 0.213, divDays: 30, vol: 0.049 },
  { id: "tannery",        name: "โรงฟอกหนังริมน้ำ",             icon: "🧳", size: "m", base: 240,      yield: 0.214, divDays: 45, vol: 0.047 },
  { id: "translator",     name: "สำนักแปลภาษาโบราณ",            icon: "📖", size: "m", base: 260,      yield: 0.216, divDays: 60, vol: 0.047 },
  { id: "warhorse",       name: "โรงเพาะพันธุ์ม้าศึก",          icon: "🐎", size: "m", base: 300,      yield: 0.189, divDays: 7, vol: 0.046 },
  { id: "wainwright",     name: "อู่ซ่อมเกวียนใหญ่",            icon: "🛞", size: "m", base: 330,      yield: 0.192, divDays: 15, vol: 0.046 },
  { id: "glasswork",      name: "โรงงานแก้วเป่า",               icon: "🫙", size: "m", base: 390,      yield: 0.192, divDays: 30, vol: 0.044 },
  { id: "vineyard",       name: "สวนองุ่นไวน์เนินใต้",          icon: "🍇", size: "m", base: 420,      yield: 0.194, divDays: 45, vol: 0.044 },
  { id: "canaldig",       name: "บริษัทรับเหมาขุดคลอง",         icon: "🪣", size: "m", base: 480,      yield: 0.191, divDays: 60, vol: 0.042 },
  { id: "fencing",        name: "โรงเรียนดาบประจำเมือง",        icon: "🤺", size: "m", base: 510,      yield: 0.168, divDays: 7, vol: 0.042 },
  { id: "press",          name: "สำนักพิมพ์ข่าวเมือง",          icon: "📰", size: "m", base: 570,      yield: 0.168, divDays: 15, vol: 0.041 },
  { id: "shiprope",       name: "โรงงานเชือกเรือ",              icon: "⚓", size: "m", base: 600,      yield: 0.17, divDays: 30, vol: 0.04 },
  { id: "silkfarm",       name: "ฟาร์มไหมจันทรา",               icon: "🕸️", size: "m", base: 680,     yield: 0.166, divDays: 45, vol: 0.038 },
  { id: "teakiln",        name: "โรงอบชาสูง",                   icon: "🫖", size: "m", base: 700,      yield: 0.167, divDays: 60, vol: 0.038 },
  { id: "porters",        name: "บริษัทรับจ้างขนของ",           icon: "📦", size: "m", base: 780,      yield: 0.142, divDays: 7, vol: 0.036 },
  { id: "pottery",        name: "โรงงานเครื่องปั้นดินเผา",      icon: "🏺", size: "m", base: 800,      yield: 0.144, divDays: 15, vol: 0.036 },
  { id: "astrolog",       name: "สำนักโหราจารย์",               icon: "🔭", size: "m", base: 880,      yield: 0.14, divDays: 30, vol: 0.034 },
  { id: "carpfarm",       name: "โรงเพาะปลาคาร์ป",              icon: "🐠", size: "m", base: 900,      yield: 0.143, divDays: 45, vol: 0.034 },
  { id: "waterworks",     name: "บริษัทประปาเมืองบน",           icon: "🚿", size: "m", base: 980,      yield: 0.137, divDays: 60, vol: 0.032 },
  { id: "xm01",              name: "โรงเบียร์ข้าวบาร์เลย์",         icon: "🍺", size: "m", base:    130, yield: 0.215 , divDays:   7, vol: 0.049 },
  { id: "xm02",              name: "บริษัทขนส่งเกวียนไว",           icon: "🐎", size: "m", base:    144, yield: 0.211 , divDays:  15, vol: 0.048 },
  { id: "xm03",              name: "โรงพิมพ์หนังสือเวท",            icon: "📚", size: "m", base:    160, yield: 0.207 , divDays:  30, vol: 0.047 },
  { id: "xm04",              name: "ฟาร์มไหมป่าเหนือ",                icon: "🕸️", size: "m", base:    178, yield: 0.202 , divDays:  45, vol: 0.046 },
  { id: "xm05",              name: "บริษัทบาดาลหมู่บ้าน",            icon: "🚰", size: "m", base:    198, yield: 0.198 , divDays:  60, vol: 0.046 },
  { id: "xm06",              name: "โรงหล่อระฆัง",                  icon: "🔔", size: "m", base:    220, yield: 0.194 , divDays:   7, vol: 0.045 },
  { id: "xm07",              name: "บริษัทรับเหมาถนน",              icon: "🛣️", size: "m", base:    244, yield: 0.19  , divDays:  15, vol: 0.044 },
  { id: "xm08",              name: "ฟาร์มผึ้งหลวง",                 icon: "🐝", size: "m", base:    272, yield: 0.186 , divDays:  30, vol: 0.043 },
  { id: "xm09",              name: "โรงงานเครื่องหนัง",             icon: "🧳", size: "m", base:    302, yield: 0.181 , divDays:  45, vol: 0.042 },
  { id: "xm10",              name: "บริษัทเดินเรือค้าขาย",          icon: "⛵", size: "m", base:    335, yield: 0.177 , divDays:  60, vol: 0.041 },
  { id: "xm11",              name: "โรงเลื่อยไม้สัก",               icon: "🪵", size: "m", base:    372, yield: 0.173 , divDays:   7, vol: 0.041 },
  { id: "xm12",              name: "บริษัทประกันคาราวาน",           icon: "📜", size: "m", base:    414, yield: 0.169 , divDays:  15, vol: 0.04 },
  { id: "xm13",              name: "โรงงานกระเบื้องเคลือบ",         icon: "🧱", size: "m", base:    460, yield: 0.164 , divDays:  30, vol: 0.039 },
  { id: "xm14",              name: "ฟาร์มม้าแข่ง",                  icon: "🏇", size: "m", base:    511, yield: 0.16  , divDays:  45, vol: 0.038 },
  { id: "xm15",              name: "บริษัทโทรเลขนกพิราบ",           icon: "🕊️", size: "m", base:    567, yield: 0.156 , divDays:  60, vol: 0.037 },
  { id: "xm16",              name: "โรงงานเครื่องครัว",             icon: "🍳", size: "m", base:    630, yield: 0.152 , divDays:   7, vol: 0.036 },
  { id: "xm17",              name: "บริษัทจัดสวนหลวง",              icon: "🌳", size: "m", base:    700, yield: 0.148 , divDays:  15, vol: 0.036 },
  { id: "xm18",              name: "โรงกลั่นน้ำหอม",                icon: "💐", size: "m", base:    778, yield: 0.143 , divDays:  30, vol: 0.035 },
  { id: "xm19",              name: "บริษัทเหมืองหินอ่อน",           icon: "🪨", size: "m", base:    864, yield: 0.139 , divDays:  45, vol: 0.034 },
  { id: "xm20",              name: "โรงงานเครื่องดนตรี",            icon: "🎻", size: "m", base:    960, yield: 0.135 , divDays:  60, vol: 0.033 },
  /* --- large: 100 shares = 180,000-2,000,000 --- */
  { id: "bankcorp", name: "ธนาคารมิธวูดกลาง",     icon: "🏦", size: "l", base: 1800,  yield: 0.13, divDays: 60, vol: 0.022 },
  { id: "mithmine", name: "บริษัทเหมืองมิธริล",     icon: "⛏️", size: "l", base: 2600,  yield: 0.125, divDays: 60, vol: 0.021 },
  { id: "caravan",  name: "สมาคมพ่อค้าทางไกล",     icon: "🐫", size: "l", base: 3600,  yield: 0.12, divDays: 60, vol: 0.020 },
  { id: "academy",  name: "หอคอยเวทวิทยาคม",      icon: "🔮", size: "l", base: 4800,  yield: 0.115, divDays: 90, vol: 0.019 },
  { id: "dragonco", name: "กิลด์นักล่ามังกร",       icon: "🐉", size: "l", base: 6200,  yield: 0.11, divDays: 90, vol: 0.020 },
  { id: "oceanic",  name: "บริษัทเดินเรือมหาสมุทร",  icon: "🚢", size: "l", base: 7800,  yield: 0.10, divDays: 90, vol: 0.017 },
  { id: "foundry",  name: "โรงถลุงเหล็กภูเขาไฟ",    icon: "🔥", size: "l", base: 9600,  yield: 0.095, divDays: 90, vol: 0.016 },
  { id: "railway",  name: "บริษัทรถไฟข้ามทวีป",     icon: "🚂", size: "l", base: 12000, yield: 0.09, divDays: 90, vol: 0.014 },
  { id: "estates",  name: "กองทุนอสังหาเมืองจันทรา", icon: "🏙️", size: "l", base: 15500, yield: 0.08, divDays: 90, vol: 0.012 },
  { id: "starcore", name: "บรรษัทพลังงานแกนดาว",   icon: "⚡", size: "l", base: 20000, yield: 0.07, divDays: 90, vol: 0.010 },
  { id: "coalcorp",       name: "บรรษัทเหมืองถ่านหินลึก",       icon: "🪨", size: "l", base: 1500,     yield: 0.13, divDays: 30, vol: 0.022 },
  { id: "forestfund",     name: "กองทุนป่าไม้แห่งชาติ",         icon: "🌲", size: "l", base: 2000,     yield: 0.135, divDays: 60, vol: 0.022 },
  { id: "insurance",      name: "บริษัทประกันภัยนักผจญภัย",     icon: "📋", size: "l", base: 2200,     yield: 0.138, divDays: 90, vol: 0.022 },
  { id: "borderbank",     name: "สมาคมธนาคารชายแดน",            icon: "💳", size: "l", base: 3000,     yield: 0.125, divDays: 30, vol: 0.021 },
  { id: "skyfreight",     name: "บรรษัทขนส่งทางอากาศ",          icon: "🎈", size: "l", base: 3200,     yield: 0.13, divDays: 60, vol: 0.021 },
  { id: "hospital",       name: "กลุ่มโรงพยาบาลเวทมนตร์",       icon: "🏥", size: "l", base: 4000,     yield: 0.131, divDays: 90, vol: 0.02 },
  { id: "armorstd",       name: "บริษัทผลิตเกราะมาตรฐาน",       icon: "🦺", size: "l", base: 4200,     yield: 0.121, divDays: 30, vol: 0.02 },
  { id: "gemfund",        name: "กองทุนเหมืองอัญมณี",           icon: "💎", size: "l", base: 5400,     yield: 0.122, divDays: 60, vol: 0.019 },
  { id: "crystalnet",     name: "บรรษัทสื่อสารคริสตัล",         icon: "📡", size: "l", base: 5600,     yield: 0.125, divDays: 90, vol: 0.019 },
  { id: "northport",      name: "บริษัทท่าเรือน้ำลึกเหนือ",     icon: "🏗️", size: "l", base: 6800,    yield: 0.112, divDays: 30, vol: 0.018 },
  { id: "grandhotel",     name: "กลุ่มโรงแรมเมืองหลวง",         icon: "🏨", size: "l", base: 7000,     yield: 0.117, divDays: 60, vol: 0.018 },
  { id: "windpower",      name: "บรรษัทพลังงานลม",              icon: "🌬️", size: "l", base: 8600,    yield: 0.114, divDays: 90, vol: 0.017 },
  { id: "elixirlab",      name: "บริษัทวิจัยยาอายุวัฒนะ",       icon: "🧪", size: "l", base: 8800,     yield: 0.105, divDays: 30, vol: 0.017 },
  { id: "plainsagri",     name: "กองทุนเกษตรที่ราบใหญ่",        icon: "🚜", size: "l", base: 10500,    yield: 0.104, divDays: 60, vol: 0.016 },
  { id: "expresscoach",   name: "บรรษัทเดินรถม้าด่วน",          icon: "🚐", size: "l", base: 11000,    yield: 0.105, divDays: 90, vol: 0.015 },
  { id: "castlebuild",    name: "บริษัทก่อสร้างปราสาท",         icon: "🏰", size: "l", base: 13000,    yield: 0.091, divDays: 30, vol: 0.014 },
  { id: "goldmine",       name: "กลุ่มเหมืองทองคำเหนือ",        icon: "🪙", size: "l", base: 14000,    yield: 0.092, divDays: 60, vol: 0.013 },
  { id: "navyyard",       name: "บรรษัทต่อเรือรบหลวง",          icon: "🚤", size: "l", base: 17000,    yield: 0.083, divDays: 90, vol: 0.011 },
  { id: "cityinfra",      name: "กองทุนโครงสร้างพื้นฐานเมือง",  icon: "🌉", size: "l", base: 18000,    yield: 0.073, divDays: 30, vol: 0.011 },
  { id: "warehouse",      name: "บรรษัทคลังสินค้าข้ามมิติ",     icon: "🏭", size: "l", base: 19000,    yield: 0.074, divDays: 60, vol: 0.01 },
  { id: "xl01",              name: "ธนาคารพาณิชย์มิธวูด",           icon: "🏦", size: "l", base:   1600, yield: 0.138 , divDays:  30, vol: 0.021 },
  { id: "xl02",              name: "บรรษัทเหมืองลึกใต้พิภพ",        icon: "⛏️", size: "l", base:   1825, yield: 0.135 , divDays:  60, vol: 0.02 },
  { id: "xl03",              name: "กลุ่มโรงแรมข้ามทวีป",           icon: "🏨", size: "l", base:   2082, yield: 0.131 , divDays:  90, vol: 0.02 },
  { id: "xl04",              name: "บริษัทรถไฟไอน้ำ",               icon: "🚂", size: "l", base:   2375, yield: 0.128 , divDays:  30, vol: 0.019 },
  { id: "xl05",              name: "กองทุนที่ดินหลวง",              icon: "🗺️", size: "l", base:   2709, yield: 0.124 , divDays:  60, vol: 0.019 },
  { id: "xl06",              name: "บรรษัทต่อเรือเหล็ก",            icon: "🚢", size: "l", base:   3089, yield: 0.121 , divDays:  90, vol: 0.018 },
  { id: "xl07",              name: "กลุ่มสถานพยาบาลชายแดน",        icon: "⚕️", size: "l", base:   3524, yield: 0.117 , divDays:  30, vol: 0.018 },
  { id: "xl08",              name: "บริษัทไฟฟ้าคริสตัล",            icon: "⚡", size: "l", base:   4020, yield: 0.114 , divDays:  60, vol: 0.017 },
  { id: "xl09",              name: "กองทุนศิลปะและสมบัติ",          icon: "🖼️", size: "l", base:   4585, yield: 0.11  , divDays:  90, vol: 0.017 },
  { id: "xl10",              name: "บรรษัทอาวุธหลวง",               icon: "🗡️", size: "l", base:   5230, yield: 0.107 , divDays:  30, vol: 0.016 },
  { id: "xl11",              name: "กลุ่มมหาวิทยาลัยเวท",           icon: "🎓", size: "l", base:   5966, yield: 0.103 , divDays:  60, vol: 0.016 },
  { id: "xl12",              name: "บริษัทเดินอากาศ",               icon: "🎈", size: "l", base:   6805, yield: 0.1   , divDays:  90, vol: 0.015 },
  { id: "xl13",              name: "กองทุนแร่หายากใต้ทะเล",            icon: "💎", size: "l", base:   7762, yield: 0.096 , divDays:  30, vol: 0.015 },
  { id: "xl14",              name: "บรรษัทสื่อสารข้ามมิติ",         icon: "📡", size: "l", base:   8853, yield: 0.093 , divDays:  60, vol: 0.014 },
  { id: "xl15",              name: "กลุ่มห้างสรรพสินค้า",           icon: "🛍️", size: "l", base:  10099, yield: 0.089 , divDays:  90, vol: 0.014 },
  { id: "xl16",              name: "บริษัทประกันชีวิตหลวง",         icon: "🛡️", size: "l", base:  11519, yield: 0.086 , divDays:  30, vol: 0.013 },
  { id: "xl17",              name: "กองทุนโครงสร้างท่าเรือ",        icon: "⚓", size: "l", base:  13139, yield: 0.082 , divDays:  60, vol: 0.013 },
  { id: "xl18",              name: "บรรษัทวิจัยธาตุหายาก",          icon: "🔬", size: "l", base:  14987, yield: 0.079 , divDays:  90, vol: 0.012 },
  { id: "xl19",              name: "กลุ่มพลังงานลมเหนือเมฆ",        icon: "🌬️", size: "l", base:  17095, yield: 0.075 , divDays:  30, vol: 0.012 },
  { id: "xl20",              name: "กองทุนความมั่งคั่งแห่งชาติ",    icon: "👑", size: "l", base:  19500, yield: 0.072 , divDays:  60, vol: 0.011 },
];


/* ---------- Your own shops ----------
 * Every number here was tuned in game/shop_sim.mjs before a line of this shipped, because six
 * interacting variables (headcount per role, wage ratio, hidden traits, loyalty, reputation,
 * season) cannot be balanced by reading code. Change a value here and re-run that file.
 *
 * THE CHAIN: hired hunters produce raw INTO THE SHOP (never the player's bag, so it can never
 * replace playing) -> crafters convert -> sellers sell to customers. The player can also ship
 * materials in from their own bag, which lands in the same stock pool: gold versus time.
 *
 * Why a shop is not just another investment: it is the only thing in the game with a RECURRING
 * COST. Wages go out every game-day whether anyone buys anything or not, which is what makes
 * "ขาดทุน" possible at all and gives the tax system's game-over rule real teeth. */

const SHOP_RAW_PER_GOLD = 12;    // 12 gold of shipped material = 1 raw unit

const SHOP_TYPES = [
  { id: "potion", name: "ร้านขายยา",   icon: "🧪", goodName: "ยาสมุนไพร",  goodValue: 100, rawPerGood: 2.0,
    base: 4.6, season: [0.80, 1.00, 1.60, 0.95],
    note: "ขายเยอะ กำไรต่อชิ้นน้อย · พีคหน้าฝน" },
  { id: "meat",   name: "ร้านขายเนื้อ", icon: "🥩", goodName: "เนื้อรมควัน", goodValue: 116, rawPerGood: 2.5,
    base: 3.9, season: [1.50, 0.95, 0.70, 1.20],
    note: "สมดุล · พีคหน้าหนาว ตกหนักหน้าฝน" },
  { id: "weapon", name: "ร้านตีอาวุธ", icon: "⚔️", goodName: "ดาบมาตรฐาน", goodValue: 157, rawPerGood: 4.0,
    base: 2.5, season: [1.00, 1.35, 0.85, 1.05],
    note: "ขายน้อย กำไรต่อชิ้นสูง · กินวัตถุดิบหนัก" },
];

/* SLOTS is the load-bearing number. Without a headcount cap the best play is always "hire one
 * more" and the ratio stops mattering; tier 1 holds exactly six so the first lesson is
 * "same six people, arranged better". */
const SHOP_TIERS = [
  { name: "แผงเล็ก",  slots:  6, demand: 1.00, regulars:  4.5, cost:  55000 },
  { name: "ร้านกลาง", slots:  9, demand: 1.45, regulars: 11.0, cost: 190000 },
  { name: "ห้างใหญ่", slots: 12, demand: 1.95, regulars: 20.0, cost: 420000 },
];

const STAFF_ROLES = [
  { id: "hunter",  name: "นักล่า", icon: "🏹", wage: 42, rate: 5,  what: "หาวัตถุดิบเข้าร้าน" },
  { id: "crafter", name: "ช่าง",   icon: "🔨", wage: 65, rate: 12, what: "แปรรูปวัตถุดิบเป็นสินค้า" },
  { id: "seller",  name: "พ่อค้า", icon: "💁", wage: 95, rate: 10, what: "ขายสินค้าให้ลูกค้า" },
  { id: "guard",   name: "การ์ด", icon: "🛡️", wage: 50, rate: 0,  what: "กันของหาย ไม่ได้ผลิตอะไร" },
];

const SHOP_GUARD_COVER = 0.55;      // one guard removes this share of theft; two do not stack fully
const SHOP_WAGE_SENIORITY = 0.04;   // asking wage rises per game-year of tenure with you...
const SHOP_SENIORITY_CAP = 10;      // ...and stops here, so no roster becomes a death clock
const SHOP_LOYALTY_YEARS = 5;       // tenure needed for full loyalty
const SHOP_REGULARS_SPEED = 0.00055; // a full customer base takes ~20 game-years to earn
const SHOP_BRAND_CARRY = 0.45;      // share of your best shop's regulars a new shop opens with
const SHOP_PRICE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.45, 1.6];
const SHOP_PAY_STEPS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25];
const SHOP_APPLICANTS = 4;          // how many candidates are on the board at once
const SHOP_VETTING_COST = 900;      // pay to see a candidate's real traits instead of a range

const STAFF_FIRST = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์", "แก้ว", "ดาว", "เมฆ",
  "ลม", "ฝน", "ไพร", "ธาร", "ผา", "ทราย", "เงิน", "ทอง", "หมอก", "ฟ้า", "ใบ", "ก้อน", "ปลา", "นก"];
const STAFF_LAST = ["ใจกล้า", "มือหนัก", "เท้าไว", "ตาไว", "หลังตรง", "ปากดี", "ใจเย็น", "มือสะอาด",
  "ขาลุย", "หัวไว", "แขนเหล็ก", "ใจซื่อ", "ลมกรด", "เงียบงัน", "ยิ้มง่าย", "ขยันยิ่ง"];

/* Morale from pay, SHIFTED by loyalty rather than floored by it. A floor makes morale flat below
 * it, so the best wage for a veteran becomes "as little as possible" and the decision vanishes.
 * Shifting keeps a real optimum at every loyalty level, it just arrives cheaper: a stranger needs
 * ~110% of the asking wage for full morale, a veteran gets there at ~90%. */
function staffLoyalty(w, gameDays) {
  return Math.min(1, Math.max(0, (gameDays - (w.hiredDay || 0)) / DAYS_PER_YEAR / SHOP_LOYALTY_YEARS));
}
function staffMorale(w, gameDays) {
  return Math.min(1.12, Math.max(0.35, Math.pow(w.payRatio + 0.22 * staffLoyalty(w, gameDays), 1.4)));
}
function staffTenure(w, gameDays) {
  return Math.min(SHOP_SENIORITY_CAP, Math.max(0, (gameDays - (w.hiredDay || 0)) / DAYS_PER_YEAR));
}
function staffSalary(w, gameDays) {
  return w.wage * w.payRatio * Math.pow(1 + SHOP_WAGE_SENIORITY, staffTenure(w, gameDays));
}
function staffOutput(w, gameDays) {
  return w.rate * w.diligence * staffMorale(w, gameDays);
}
/* Loyalty blunts theft but never removes it — cancelling it outright made squeezing wages free
 * once the crew was old enough, the opposite of the intent. */
function staffTheft(w, gameDays) {
  return (1 - w.honesty) * Math.max(0, 1 - w.payRatio) * 0.30 * (1 - 0.7 * staffLoyalty(w, gameDays));
}


/* ---------- Hired gardener ----------
 * 🎯 [owner's ask 2026-08-17] Pay someone to watch the plots for a stretch of game-time: they
 * harvest what is ripe and replant it, so the garden keeps running while you are elsewhere.
 *
 * The owner set the price himself, and the reasoning is the important part: "ขายได้ผลละ 4 ได้มา 10
 * ค่าจ้างต้องเสียไปราวๆ 5-6 ส่วน" — the wage takes a bit over half of what the plot produces, so
 * hiring is convenience bought at a real cost rather than free money. The contract is priced from
 * the CROP you point them at, so watching carrots is cheap and watching star-fruit is not.
 *
 * What keeps it a decision rather than a formality: the price is fixed when you sign, and it
 * assumes the seeds hold out. Run dry halfway and you have paid for hours nobody could work. */
const GARDENER_WAGE_SHARE = 0.55;   // of the crop value those harvests are worth

/* 🎯 [owner, twice] The contract is measured in HARVESTS, not time.
 *
 * It started as in-game hours because that is how the owner first described it — but a game-day is
 * 100 real seconds, so a "24 hour" contract was one growth cycle and then over: "มันทำงานก็จริงแต่
 * ทำรอบเดียว". Switching to days only moved the confusion. The owner's own correction is the right
 * unit: "ควรเขียนเป็นรอบดีกว่าไหม ว่าทำงานกี่รอบ".
 *
 * Counting harvests fixes more than the labelling. The price becomes exact rather than an estimate
 * of how many cycles fit in a window, a slow crop no longer buys fewer harvests than a fast one for
 * the same money, and buying a new plot mid-contract cannot silently change what you paid for. You
 * are buying a number of pickings; you get exactly that many. */
const GARDENER_ROUNDS = [5, 20, 60];   // full sweeps of the whole garden

/* What one plot yields in one picking, counting the surplus seed it hands back. No time in it —
 * that is the point. */
function cropValuePerHarvest(action, itemSell) {
  const [cropId, n] = Object.entries(action.outputs)[0];
  const seedId = Object.keys(action.inputs)[0];
  const surplus = (action.seedBack[0] + action.seedBack[1]) / 2 - 1;
  return n * itemSell(cropId) + surplus * itemSell(seedId);
}

/* ---------- Rebirth karma ----------
 * 🐛 [rewritten 2026-08-17] Karma used to be `rebirths x 5%` — the same reward whether you turned
 * back at the minimum level or at ninety. Reaching level 90 costs 114x the experience of reaching
 * 20, so the optimal play was to rebirth the instant the gate opened, over and over, which is the
 * exact opposite of the owner's rule that a run has to go FURTHER to be worth resetting.
 *
 * Karma is now earned per rebirth and scaled by how far that run actually got. The exponent is set
 * so the two strategies pay about the same PER HOUR — a shallow loop is no longer a better deal,
 * it is simply a smaller one — while a deep run hands over far more in a single event, which is
 * what makes the decision feel like something.
 *
 *     lv20 (the gate)  +1.0% XP     lv60   +9.0%
 *     lv40             +4.0%        lv90  +20.3%
 *
 * The cap is unchanged, so the ceiling now takes roughly seven deep rebirths instead of twenty
 * shallow ones. */
const KARMA_XP_AT_GATE   = 0.010;   // earned by a rebirth at exactly REBIRTH_MIN_LEVEL
const KARMA_GOLD_AT_GATE = 0.006;
const KARMA_LEVEL_POWER  = 2.0;     // (level / gate) ^ this — measured against the level curve's own 2.3
const KARMA_CAP = 1.0;

/* And the gate itself rises, so the cheapest rebirth cannot be farmed forever. */
/* 🎯 [owner 2026-08-23] "ปรับพลังหลังจุติ ... จากการหารครึ่ง ให้เป็น 90% ... เพราะมองในมุม
 * ระยะยาว เช่น lv 80-90 หารครึ่ง คงเล่นเป็นวันเป็นเดือน กว่าจะเลเวลเท่าเดิม"
 *
 * Halving is cheap early and brutal late, because the level curve is superlinear: the XP between
 * lv45 and lv90 is not half a climb, it is most of one. Measured on this game's own curve, the
 * climb back after a rebirth at lv90 was 708,887 XP; keeping 90% makes it 207,346 — 3.4x lighter,
 * and the ratio holds from lv30 to lv99 rather than punishing exactly the players who got furthest.
 *
 * Applied to all four things a rebirth reduces — the player, their companion, their children and
 * the children's companions — through this one constant, because the owner's rule has always been
 * that a child's companion matches the player's, and four copies of 0.9 would drift.
 *
 * Rebirthing does not become free: karma still takes 40+ rebirths to cap either way (measured),
 * and the gate still rises 3 levels per rebirth. What changes is that the climb back is a session
 * rather than a month. */
/* 🎯 [owner 2026-08-23] "งั้นมองเป็น fps ละ 30 / 50 หรือใดๆ เพื่อประหยัดแบท"
 *
 * This game has no frame loop — there is no requestAnimationFrame anywhere in it. Everything runs
 * on one setInterval, so its real "frame rate" is 4 a second, not 60, and there is no 60 to cap.
 * What the setting can honestly offer is that number, which is why the labels say times-per-second
 * rather than FPS: naming it FPS would imply a 60 that does not exist and a saving that is not
 * there.
 *
 * Safe to lower only because nextAt() now carries the remainder — before that, a slower tick bought
 * battery with damage (measured: 6.4% of all hits lost at 500ms, 13.6% at 1000ms). */
const TICK_RATES = [
  { ms: 250,  name: "ปกติ",         note: "4 ครั้ง/วินาที — ลื่นที่สุด" },
  { ms: 500,  name: "ประหยัด",       note: "2 ครั้ง/วินาที" },
  { ms: 1000, name: "ประหยัดมาก",    note: "1 ครั้ง/วินาที — แถบจะขยับเป็นช่วง ๆ" },
];
const TICK_MS_DEFAULT = 250;

const REBIRTH_KEEP = 0.9;

const REBIRTH_MIN_LEVEL = 20;
const REBIRTH_GATE_STEP = 3;
const REBIRTH_GATE_MAX  = 50;
function rebirthGateFor(rebirths) {
  return Math.min(REBIRTH_GATE_MAX, REBIRTH_MIN_LEVEL + (rebirths || 0) * REBIRTH_GATE_STEP);
}
function karmaGainFor(level, rebirths) {
  const gate = rebirthGateFor(rebirths);
  const reach = Math.pow(Math.max(1, level) / gate, KARMA_LEVEL_POWER);
  return { xp: KARMA_XP_AT_GATE * reach, gold: KARMA_GOLD_AT_GATE * reach };
}

/* ---------- Property ----------
 * The stable counterpart to the stock market: the only asset in the game whose VALUE NEVER MOVES
 * (owner: "ค่าทรัพย์สินจะตายตัว ไม่มีขึ้นลง"). There is no market to time and no price to watch.
 *
 * 🎯 [owner 2026-08-17] Two rules changed together. Furniture is bought with GOLD now, not crafted
 * materials, and a sale returns the house AND everything spent furnishing it, undiminished by wear
 * — but every sale is docked 15%, no exceptions.
 *
 * That fee is what stops the fixed value from being a free parking spot. Before it, buying and
 * selling was a perfect round trip, so a large sum could sit in property with no cost at all and
 * property strictly beat holding gold. Now it costs about 1.2 years of furnished rent to get out,
 * so property is a place to COMMIT capital rather than to park it — the long-horizon option next
 * to the bank's liquid 6% and the market's swings.
 *
 * What was lost with the material costs is the pull on the workshop: furniture used to be the one
 * reason to keep a finished leather coat instead of selling it. Rebuilding that link now means a
 * gold price and a materials DISCOUNT, not a materials-only gate. */

const PROPERTIES = [
  { id: "p01", name: "เพิงพักริมทาง",           icon: "⛺", price:     40000, slots: 2 },
  { id: "p02", name: "กระท่อมชายป่า",           icon: "🛖", price:     49000, slots: 2 },
  { id: "p03", name: "ห้องแถวท้ายตลาด",         icon: "🏚️", price:     60000, slots: 2 },
  { id: "p04", name: "ห้องเช่าซอยตลาด",         icon: "🏚️", price:     73000, slots: 2 },
  { id: "p05", name: "เรือนแพริมคลอง",          icon: "🛶", price:     89000, slots: 3 },
  { id: "p06", name: "บ้านไม้ชานเมือง",         icon: "🏠", price:    110000, slots: 3 },
  { id: "p07", name: "บ้านไม้ในเมือง",          icon: "🏠", price:    130000, slots: 3 },
  { id: "p08", name: "ตึกแถวสองคูหา",           icon: "🏢", price:    160000, slots: 3 },
  { id: "p09", name: "บ้านสวนหลังเล็ก",         icon: "🏡", price:    200000, slots: 4 },
  { id: "p10", name: "บ้านหินสองชั้น",          icon: "🏡", price:    240000, slots: 4 },
  { id: "p11", name: "เรือนไม้สักโบราณ",        icon: "🏯", price:    290000, slots: 4 },
  { id: "p12", name: "อพาร์ตเมนต์ซอยเงียบ",     icon: "🏢", price:    360000, slots: 4 },
  { id: "p13", name: "บ้านกลางไร่องุ่น",        icon: "🍇", price:    440000, slots: 5 },
  { id: "p14", name: "โกดังริมท่าเรือ",         icon: "📦", price:    530000, slots: 5 },
  { id: "p15", name: "คฤหาสน์ริมทะเลสาบ",       icon: "🏰", price:    650000, slots: 5 },
  { id: "p16", name: "เรือนกระจกดอกไม้",        icon: "🌸", price:    800000, slots: 5 },
  { id: "p17", name: "โฮสเทลนักเดินทาง",        icon: "🎒", price:    970000, slots: 6 },
  { id: "p18", name: "บ้านหอคอยนักเวท",         icon: "🗼", price:   1200000, slots: 6 },
  { id: "p19", name: "วิลล่าริมผา",             icon: "🏖️", price:   1400000, slots: 6 },
  { id: "p20", name: "ตึกออฟฟิศใจกลางเมือง",    icon: "🏙️", price:   1800000, slots: 6 },
  { id: "p21", name: "โรงแรมจันทราเล็ก",        icon: "🏨", price:   2200000, slots: 7 },
  { id: "p22", name: "คฤหาสน์สวนดาว",           icon: "🌟", price:   2600000, slots: 7 },
  { id: "p23", name: "ปราสาทหินเก่า",           icon: "🏰", price:   3200000, slots: 7 },
  { id: "p24", name: "ตลาดนัดมีหลังคา",         icon: "🎪", price:   3900000, slots: 7 },
  { id: "p25", name: "ท่าเรือส่วนตัว",          icon: "⚓", price:   4800000, slots: 8 },
  { id: "p26", name: "โรงละครกลางเมือง",        icon: "🎭", price:   5800000, slots: 8 },
  { id: "p27", name: "โรงแรมริมทะเลสาบ",        icon: "🏨", price:   7100000, slots: 8 },
  { id: "p28", name: "หมู่บ้านให้เช่า",         icon: "🏘️", price:   8700000, slots: 8 },
  { id: "p29", name: "หอคอยหอดูดาว",            icon: "🔭", price:  11000000, slots: 9 },
  { id: "p30", name: "สวนสนุกริมน้ำ",           icon: "🎡", price:  13000000, slots: 9 },
  { id: "p31", name: "ปราสาทลอยฟ้า",            icon: "🏯", price:  16000000, slots: 9 },
  { id: "p32", name: "เกาะส่วนตัว",             icon: "🏝️", price:  19000000, slots: 9 },
  { id: "p33", name: "เหมืองคริสตัลเก่า",       icon: "💎", price:  24000000, slots: 10 },
  { id: "p34", name: "นครใต้บาดาล",             icon: "🌊", price:  29000000, slots: 10 },
  { id: "p35", name: "วังใต้แสงจันทร์",         icon: "🌙", price:  35000000, slots: 10 },
  { id: "p36", name: "สวนลอยเหนือเมฆ",          icon: "☁️", price:  43000000, slots: 10 },
  { id: "p37", name: "วิหารดาวตก",              icon: "☄️", price:  52000000, slots: 10 },
  { id: "p38", name: "ป้อมปราการมังกร",         icon: "🐉", price:  64000000, slots: 10 },
  { id: "p39", name: "เมืองลอยฟ้า",             icon: "🕊️", price:  78000000, slots: 10 },
  { id: "p40", name: "พระราชวังนิรันดร์",       icon: "👑", price:  95000000, slots: 10 },
];

const RENT_YIELD = 0.09;          // per game-year of the purchase price, at perfect condition
const PROPERTY_SELL_BACK = 1.0;   // 🎯 the house itself never gains or loses value, ever
/* 🎯 [owner 2026-08-17: "ราคาขายทั้งหมดจะโดนหัก 15% ทุกกรณี"] Taken off the whole sale — house plus
 * furnishing — with no exception for condition, for how long it was held, or for selling at a loss.
 * One number, always applied, so the cost of getting out is knowable before getting in. */
const PROPERTY_SELL_FEE = 0.15;

/* Furniture is priced as a SHARE of the house it goes in, not a flat sum. The same bed earns 60×
 * more rent in a lakeside manor than in a forest hut, so a flat price would be a rounding error at
 * the top of the ladder and a serious purchase at the bottom. As a share, the decision reads the
 * same everywhere: every piece pays for itself in FURNITURE_PAYBACK_YEARS of the rent it adds. */
const FURNITURE_PAYBACK_YEARS = 2;
const FURNITURE = [
  { id: "bed",    name: "เตียงไม้สัก",      icon: "🛏️", rent: 0.10 },
  { id: "sofa",   name: "โซฟาหนังนุ่ม",     icon: "🛋️", rent: 0.10 },
  { id: "lamp",   name: "โคมไฟทองเหลือง",   icon: "🕯️", rent: 0.08 },
  { id: "mirror", name: "กระจกอัญมณี",      icon: "🪞", rent: 0.10 },
  { id: "garden", name: "สวนหน้าบ้าน",      icon: "🪴", rent: 0.08 },
  { id: "pantry", name: "ครัวพร้อมเสบียง",  icon: "🍷", rent: 0.09 },
  /* 🐛 [owner 2026-08-23: "บ้านที่เช่ามีเฟอร์นิเจอร์ไม่ครบ ทำให้บ้านมี slot เยอะ แต่ซื้อไม่ได้"] There
     were six kinds and houses have up to TEN slots — installFurniture allows one of each, so twenty
     of the twenty-eight properties could never be filled and sat at 6/10 for good. Four more, so
     the largest house can be finished; the rest of the ladder was already reachable.

     Priced by the same rule as the others (furniturePrice: each piece pays for itself in
     FURNITURE_PAYBACK_YEARS of the rent it adds), so adding kinds cannot unbalance the return —
     a fuller house costs proportionally more to fill. */
  { id: "hearth", name: "เตาผิงหินอ่อน",    icon: "🔥", rent: 0.09 },
  { id: "study",  name: "ห้องอ่านหนังสือ",   icon: "📚", rent: 0.08 },
  { id: "bath",   name: "ห้องอาบน้ำแร่",     icon: "🛁", rent: 0.10 },
  { id: "aviary", name: "กรงนกเรือนกระจก",  icon: "🐦", rent: 0.08 },
];
/* The one place a furniture price is computed. The sale refund reads what was actually PAID from
 * the estate instead of recomputing it here, so retuning this never silently rewrites the value of
 * a house someone already furnished. */
function furniturePrice(kind, f) {
  return Math.round(kind.price * f.rent * RENT_YIELD * FURNITURE_PAYBACK_YEARS);
}


/* ---------- Tax ----------
 * Charged once a year, and only on income the player did not swing a sword for: rent, dividends,
 * realised trading gains and bank interest. Grinding, crafting, shops and selling loot are untaxed
 * on purpose — the tax exists to keep passive income from running away from the game, not to
 * punish playing it. bookRentIncome and bookInvestmentProfit in game.js are the only two doors
 * that income walks through, so nothing can earn untaxed by accident.
 *
 * Both ladders are marginal, so crossing a threshold never costs more than it earns.
 *
 * The rates and thresholds live in TAX_KINDS below, one entry per kind. There used to ALSO be a
 * standalone TAX_FREE_ALLOWANCE / TAX_BRACKETS / taxOwedOn trio here, from before there was more
 * than one kind; the 2026-08-17 split superseded them and nothing in the game read them again.
 * They were deleted 2026-08-24 — but only after the five .mjs harnesses that still imported them
 * were re-pointed at TAX_KINDS, because until then the test suite was asserting hard against a
 * ladder (7/12/20/25/30/35/42%) that no player had ever been charged. */
const TAX_GRACE_DAYS = 90;        // three game months to clear a debt before the run ends
/* The same three months, counted from the assessment rather than from the balance going negative —
   an unpaid bill ends the run even if the wallet never dipped below zero. */
const TAX_FATAL_DAYS = 90;

/* ---------- Tax, in three kinds (owner, 2026-08-17) ----------
 * "ภาษีแยกเป็นสามประเภท ... การจ่ายภาษี แก้เป็นแยกออกมาเป็นหมวดพิเศษ ให้ผู้เล่นกดชำระเอง"
 *
 * The trade this pays for: businesses, property and shares now survive a rebirth, so wealth
 * compounds across lives — and the bill follows it. Rebirth used to be the reset that wiped the
 * board; it cannot also be the way out of what the board earned.
 *
 * Each kind is assessed on a different thing, has its own allowance and its own ladder, and every
 * ladder is MARGINAL — crossing a threshold never costs more than it earns. Money and property are
 * taxed on what you HOLD, once a year; business income on what you MADE. */
/* 🎯 [owner 2026-08-23] "ลองประเมินแล้ว ภาษีอสังหามันเยอะ ไม่คุ้มกับรายได้ ... ให้มีตัวนับรายได้ต่อปี
 * ในหน้าบัญชี แล้วใช้เงื่อนไขภาษีเงินได้อสังหาแทน · ยกเลิกภาษีทรัพย์สิน ให้เงินในมือและธนาคารปลอดภัย"
 *
 * Two kinds, and both are now taxes on INCOME rather than on holdings. That is the whole change.
 *
 * The property tax used to charge the VALUE of what you owned, every year, forever — so a house
 * that had already repaid itself kept being billed for existing, and at 300m of property the yearly
 * charge outran the rent. It charges the rent it actually collected instead.
 *
 * The hoarding tax is gone entirely: gold in the pocket and gold in the bank are safe. It was the
 * one line that punished having played well rather than any particular decision, and removing it is
 * what makes saving for a house or a company worth doing.
 *
 * `business` keeps its id so existing saves keep their paid-to-date and their outstanding bills. */
/* 🎯 [owner 2026-08-23] "เพิ่มอีกหมวดหมู่ คล้ายหุ้นคือ bitcoin ที่มี 50 รายการ ให้ซื้อขายได้ อัตรา
 * ความผันผวนสูง มีการปรับค่าทุกวัน บางตัวขึ้นลงแรง บางตัวขึ้นลงทีละนิด ไม่มีปันผล เลยต้องให้เน้นการเก็ง
 * กำไรการลงทุน หมวดนี้จะนับเป็นยอดขายของการลงทุน"
 *
 * The shares market is deliberately dull: it reverts hard toward `base`, pays a dividend, and the
 * profitable move is holding. This is the opposite instrument — no dividend at all, so the only way
 * it earns is being sold for more than it cost.
 *
 * Two dials per coin rather than one, which is what makes fifty of them different from fifty copies
 * of the same coin. `vol` is how far a day can move it; `rev` is how strongly it is dragged back
 * toward `base`. A high-vol, low-rev coin genuinely wanders and can sit far from where it started;
 * a low-vol, high-rev one barely leaves home. Both exist on purpose.
 *
 * Prices are NOT reset by a rebirth, for the same reason shares are not: the market is the world's,
 * not the run's. */
const CRYPTO_FLOOR = 0.08;        // a coin may fall to 8% of base — near-total loss is possible
const CRYPTO_CEIL = 12;           // and 12x is reachable, which is what pays for the risk
/* 🎯 [owner 2026-08-23] "ขยายเพดานกระเป๋า ให้เพิ่มของได้อีกสิบเท่า เพราะมันเต็มไวไป"
 *
 * The old ceiling bound the wrong end of the market. It is a flat unit count, so what it actually
 * limits is COST, and cost runs across three orders of magnitude here: filling up on เวอร์แดนท์
 * (ฐาน 4.97) took 497,000 gold — pocket change by the time coins unlock — while filling up on
 * ฮอลโลว์สกาย (ฐาน 2,844) would take 284 million. The cheap coins, which are the volatile ones
 * worth speculating on, were the only ones anyone could ever hit.
 *
 * Ten times the units moves the cheap end to ~5m and leaves the expensive end where it already was
 * — nowhere near binding. The rule it protects still holds: even at the new ceiling, cornering all
 * 50 coins costs 30 billion, so no single holding becomes the whole economy. */
const CRYPTO_MAX_UNITS = 1000000;  // per coin
const CRYPTOS = [
  { id: "moonbit", name: "มูนบิต", icon: "🌙", base: 8.89, vol: 0.194, rev: 0.04 },
  { id: "starcoin", name: "สตาร์คอยน์", icon: "⭐", base: 63.6, vol: 0.124, rev: 0.029 },
  { id: "emberx", name: "เอมเบอร์เอ็กซ์", icon: "🔥", base: 244, vol: 0.077, rev: 0.035 },
  { id: "glacia", name: "กลาเซีย", icon: "❄️", base: 2610, vol: 0.273, rev: 0.034 },
  { id: "verdant", name: "เวอร์แดนท์", icon: "🌿", base: 4.97, vol: 0.236, rev: 0.027 },
  { id: "obsidia", name: "ออบซิเดีย", icon: "⬛", base: 45.6, vol: 0.08, rev: 0.024 },
  { id: "aureus", name: "ออเรียส", icon: "🟡", base: 411, vol: 0.275, rev: 0.044 },
  { id: "pyrite", name: "ไพไรต์", icon: "🟠", base: 2322, vol: 0.23, rev: 0.008 },
  { id: "nimbus", name: "นิมบัส", icon: "☁️", base: 6.72, vol: 0.044, rev: 0.011 },
  { id: "thorne", name: "ธอร์น", icon: "🌵", base: 38.0, vol: 0.114, rev: 0.022 },
  { id: "mirefall", name: "ไมร์ฟอลล์", icon: "🕸️", base: 278, vol: 0.277, rev: 0.028 },
  { id: "lumen", name: "ลูเมน", icon: "💡", base: 1296, vol: 0.379, rev: 0.033 },
  { id: "cinder", name: "ซินเดอร์", icon: "🪵", base: 10.22, vol: 0.191, rev: 0.022 },
  { id: "quartzia", name: "ควอตเซีย", icon: "🔷", base: 52.4, vol: 0.197, rev: 0.023 },
  { id: "driftwood", name: "ดริฟต์วูด", icon: "🪸", base: 216, vol: 0.043, rev: 0.03 },
  { id: "hollowsky", name: "ฮอลโลว์สกาย", icon: "🌌", base: 2844, vol: 0.128, rev: 0.024 },
  { id: "saltvein", name: "ซอลต์เวน", icon: "🧂", base: 6.44, vol: 0.31, rev: 0.041 },
  { id: "brimstone", name: "บริมสโตน", icon: "🌋", base: 59.2, vol: 0.13, rev: 0.013 },
  { id: "frostbite", name: "ฟรอสต์ไบต์", icon: "🥶", base: 278, vol: 0.091, rev: 0.015 },
  { id: "gildenrat", name: "กิลเดนแรต", icon: "🐀", base: 2196, vol: 0.411, rev: 0.005 },
  { id: "tidewalker", name: "ไทด์วอล์คเกอร์", icon: "🌊", base: 7.7, vol: 0.157, rev: 0.022 },
  { id: "ashenmark", name: "แอชเชนมาร์ก", icon: "🪶", base: 33.2, vol: 0.354, rev: 0.044 },
  { id: "copperfang", name: "คอปเปอร์แฟง", icon: "🦷", base: 221, vol: 0.164, rev: 0.026 },
  { id: "sablecoin", name: "เซเบิลคอยน์", icon: "🖤", base: 1566, vol: 0.085, rev: 0.037 },
  { id: "wispcoin", name: "วิสป์คอยน์", icon: "👻", base: 6.93, vol: 0.229, rev: 0.02 },
  { id: "runestone", name: "รูนสโตน", icon: "🪨", base: 46.0, vol: 0.368, rev: 0.018 },
  { id: "halcyon", name: "ฮัลไซออน", icon: "🕊️", base: 400, vol: 0.11, rev: 0.036 },
  { id: "voidmark", name: "วอยด์มาร์ก", icon: "🕳️", base: 2142, vol: 0.182, rev: 0.028 },
  { id: "sunderite", name: "ซันเดอไรต์", icon: "⚡", base: 8.54, vol: 0.472, rev: 0.034 },
  { id: "mossbank", name: "มอสส์แบงก์", icon: "🍀", base: 61.6, vol: 0.35, rev: 0.034 },
  { id: "hearthx", name: "เฮิร์ธเอ็กซ์", icon: "🏮", base: 218, vol: 0.26, rev: 0.041 },
  { id: "nettlecoin", name: "เนตเทิลคอยน์", icon: "🌾", base: 2610, vol: 0.29, rev: 0.012 },
  { id: "prismic", name: "พริสมิก", icon: "🔺", base: 5.95, vol: 0.051, rev: 0.018 },
  { id: "bogiron", name: "บ็อกไอรอน", icon: "⛓️", base: 40.4, vol: 0.173, rev: 0.013 },
  { id: "skyshard", name: "สกายชาร์ด", icon: "🔹", base: 346, vol: 0.161, rev: 0.026 },
  { id: "dusklight", name: "ดัสก์ไลต์", icon: "🌆", base: 2430, vol: 0.288, rev: 0.007 },
  { id: "ferrox", name: "เฟอร์ร็อกซ์", icon: "⚙️", base: 6.72, vol: 0.237, rev: 0.022 },
  { id: "wyrmgold", name: "เวิร์มโกลด์", icon: "🐉", base: 30.8, vol: 0.165, rev: 0.016 },
  { id: "silt", name: "ซิลต์", icon: "🏜️", base: 369, vol: 0.195, rev: 0.024 },
  { id: "kelpcoin", name: "เคลป์คอยน์", icon: "🌱", base: 1638, vol: 0.05, rev: 0.016 },
  { id: "gravelmark", name: "กราเวลมาร์ก", icon: "🪧", base: 9.17, vol: 0.509, rev: 0.019 },
  { id: "aetherx", name: "เอเธอร์เอ็กซ์", icon: "💠", base: 55.6, vol: 0.09, rev: 0.007 },
  { id: "thistle", name: "ทิสเซิล", icon: "🌸", base: 408, vol: 0.174, rev: 0.029 },
  { id: "beacon", name: "บีคอน", icon: "🔦", base: 1404, vol: 0.13, rev: 0.024 },
  { id: "stonewake", name: "สโตนเวก", icon: "🗿", base: 6.86, vol: 0.266, rev: 0.033 },
  { id: "emberlace", name: "เอมเบอร์เลซ", icon: "🎀", base: 42.0, vol: 0.253, rev: 0.009 },
  { id: "nightfen", name: "ไนต์เฟน", icon: "🦇", base: 406, vol: 0.043, rev: 0.021 },
  { id: "gloamcoin", name: "กลูมคอยน์", icon: "🌒", base: 2718, vol: 0.4, rev: 0.009 },
  { id: "razorfin", name: "เรเซอร์ฟิน", icon: "🦈", base: 10.99, vol: 0.083, rev: 0.04 },
  { id: "terracoin", name: "เทอร์ราคอยน์", icon: "🌍", base: 30.4, vol: 0.29, rev: 0.047 },
];

const TAX_KINDS = [
  { id: "estate", name: "ภาษีเงินได้ค่าเช่า", icon: "🏠",
    what: "ค่าเช่าที่เก็บได้จริงตลอดปีนี้",
    free: 1000000,
    brackets: [
      { upTo:  10000000, rate: 0.07 },
      { upTo:  50000000, rate: 0.08 },
      { upTo: 100000000, rate: 0.09 },
      { upTo: 150000000, rate: 0.10 },
      { upTo: 200000000, rate: 0.11 },
      { upTo: 300000000, rate: 0.12 },
      { upTo:   Infinity, rate: 0.13 },
    ] },
  /* Same ladder, higher floor and a flatter top — the owner's own numbers: "ภาษีของปันผลและขาย ก็ใช้
     กฎเดียวกัน แต่เพดานจะสูงกว่า". Speculation is where the risk is, so the exemption is larger and
     the last rung does not climb. */
  { id: "business", name: "ภาษีเงินได้การลงทุน", icon: "📈",
    what: "ปันผล กำไรจากการขายหุ้นและคริปโต และดอกเบี้ยธนาคาร ตลอดปีนี้",
    free: 5000000,
    brackets: [
      { upTo:  10000000, rate: 0.07 },
      { upTo:  50000000, rate: 0.08 },
      { upTo: 100000000, rate: 0.09 },
      { upTo: 150000000, rate: 0.10 },
      { upTo: 200000000, rate: 0.11 },
      { upTo: 300000000, rate: 0.12 },
      { upTo:   Infinity, rate: 0.12 },
    ] },
];

/* Unpaid this long and the businesses that earned it are seized: income falls to zero until the
 * bill is settled. Three game months, the same countdown the game already uses elsewhere. */
/* 🎯 [owner 2026-08-22] "หลังปีใหม่ มีเวลาชำระใน 30 วัน เหลือเดือนแรก หลังจากนั้นดอกเบี้ยเดินเรื่อยๆ
 * รายวันทบต้นทบดอกที่ค้าง ... จนถึงเดือนสามคือ 90 วัน ถ้ายังไม่จ่ายก็แปลว่าเกมโอเวอร์"
 *
 * One month to pay in peace, then two months of daily compounding, then the run ends. This used to
 * be 90 — the same number as the game-over clock, which made the whole penalty unreachable: the run
 * ended on the very day the fee was first charged. */
const TAX_SEIZE_DAYS = 30;
/* Late interest, per game-day, on what is still owed. It is charged AND collected daily from the
 * pocket first and the bank second, so ignoring a bill costs more than paying it. */
const TAX_LATE_DAILY = 0.004;

/* One ladder function for all three kinds. */
function taxOwedFor(kindId, base) {
  const k = TAX_KINDS.find((x) => x.id === kindId);
  if (!k) return 0;
  let taxable = Math.max(0, base - k.free);
  if (!taxable) return 0;
  let owed = 0, floor = k.free;
  for (const b of k.brackets) {
    const slice = Math.min(taxable, b.upTo - floor);
    if (slice <= 0) break;
    owed += slice * b.rate;
    taxable -= slice;
    floor = b.upTo;
    if (taxable <= 0) break;
  }
  return Math.round(owed);
}

const AUTO_CATEGORIES = [
  { name: "อาหาร",    icon: "🍲", match: (id, it) => !!it.heal },
  { name: "อุปกรณ์",  icon: "⚔️", match: (id, it) => !!it.slot },
  { name: "สินค้า",   icon: "🏷️", match: (id, it) => !!it.goods },
  { name: "ปลา",     icon: "🐟", match: (id) => /^(fish|squid|crab|octo)_/.test(id) },
  { name: "เมล็ดพันธุ์", icon: "🌱", match: (id, it) => !!it.seed },
  /* Everything a recipe consumes lands here — ore, gems, hides, leather, wood, charcoal and the
   * monster parts the smith and leatherworker ask for — so "what can I build with?" is one tab. */
  { name: "วัตถุดิบ", icon: "🧱", match: (id) => /^(ore|gem|wood|hide|charcoal)/.test(id)
      || ["star_ore", "leather", "pearl_deep", "resin_gold", "spice_void", "slime_goo", "horn_shard",
          "wolf_fang", "spore_glow", "twig_cursed", "spirit_dust", "bat_wing", "snow_core",
          "scale_ice", "ember_core", "feather_storm", "rune_sky", "tome_old",
          "bone_ancient", "sand_hour", "crown_shard", "ash_star", "core_nova"].includes(id) },
];
const DEF_FLOOR_FRACTION = 0.3;

function findSkill(skillId) { return SKILLS.find((s) => s.id === skillId); }
function findAction(skill, actionId) { return skill.actions.find((a) => a.id === actionId); }
function findLocation(locId) { return LOCATIONS.find((l) => l.id === locId); }

/* Every monster in the game gets its own hunting goal. Appended here, at the end, because the
 * generated list is built from LOCATIONS and both arrays must already exist. */
/* 🎯 [owner 2026-08-17: "เหมือนเควสมันซ้อนกัน ต้องลบอันแรก แล้วมาชดเชย"] These are no longer part of
 * the live list — the slayer marks cover the same ground, per monster, with a rung for each of the
 * four difficulties instead of a single 25-50 kill target on normal. Two systems asking for the
 * same kills and paying separately is one system too many, and the older one is the smaller.
 *
 * The definition stays because migrate() reads it: a save that earned these keeps exactly the
 * perks they paid, in P.legacyPerk. Removing something a player earned is not a balance decision
 * to be made on their behalf. */
// ACHIEVEMENTS.push(...MONSTER_ACHIEVEMENTS);   ← replaced by SLAYER_TIERS, see migrate v28→v29

/* ---------- 🏹 สถาบันฮันเตอร์ (Hunter Guild) ----------
 * เจ้าของเสนอ 2026-08-17 · ดีไซน์เต็มอยู่ใน game/HUNTER_GUILD.md
 *
 * The late-game money sink: you build a school, take in trainees, feed and arm and train them, and
 * send squads out to hunt named monsters while you are doing something else. It pays in materials
 * and gold, and it can lose people.
 *
 * Three rules decided the shape of every number below, and guild_sim.mjs holds each of them:
 *
 *   1. It must NOT consume a job slot. Every system in this game that competes for slots fights
 *      the rest of the game; every one that does not (farm, bank, market, shops, property) works.
 *   2. Taking in more people must not be free money. There has to be a size past which the upkeep
 *      outruns what the extra bodies bring back, or "fill every bed" is the only decision.
 *   3. It is the NEXT STEP of the shop's 🏹 hunter, not a parallel copy of it. A shop hunter is
 *      day labour off the market at 42/day and brings back generic materials; these are people you
 *      raised, who go after a monster by name — better loot, cheaper per round, and they can die. */

const GUILD_TIERS = [
  { id: 1, name: "โรงเรียนล่าเล็ก",   cost:  2500000, beds:  8, squads: 1, zones: 4, upkeepMult: 1.00, fixed:  600 },
  { id: 2, name: "สถาบันประจำเมือง",  cost: 12000000, beds: 16, squads: 2, zones: 6, upkeepMult: 0.92, fixed: 3000 },
  { id: 3, name: "สำนักนักล่าใหญ่",    cost: 40000000, beds: 26, squads: 3, zones: 8, upkeepMult: 0.85, fixed: 9000 },
];

/* Rank is what a trainee becomes, and it is the only thing that raises their power. Wage is per
 * MISSION ROUND, not per day — the owner's framing: "จ้าง 550 อาจจ่ายให้เด็กในสังกัดแค่ 300-350". */
/* 🐛 [found by playing the built system for 12 game-years, 2026-08-18] Readiness used to be an
 * abstract xp number, and the engine handed out 20 a round against a 400-point first exam — rank C
 * inside the first year, rank A by year seven, which is not "เลี้ยงคนเป็นสิบปี" by any reading. Worse,
 * guild_sim assumed a flat 1.4 years per rank while game.js derived something else entirely, so the
 * model and the game disagreed about the one number the whole payback curve turns on.
 *
 * It is now ROUNDS OF FIELD WORK, in this table, read by both. It is also legible on screen: "ออกงาน
 * มาแล้ว 210/300 รอบ" is something a player can plan against, which an xp bar is not. Each rank takes
 * longer than the last (300 -> 1600 rounds ~= 0.8 -> 4.4 game-years), so S is a decade-plus goal and
 * the ranks you actually run on are D through B. */
const GUILD_RANKS = [
  { id: "F", name: "ฝึกหัด",   power:  1.0, wage:   0, examCost:      0, examRounds:    0 },
  { id: "E", name: "ชั้นต้น",  power:  1.8, wage: 120, examCost:   2500, examRounds:  300 },
  { id: "D", name: "ชั้นกลาง", power:  3.2, wage: 200, examCost:   8000, examRounds:  450 },
  { id: "C", name: "ชำนาญ",    power:  5.6, wage: 300, examCost:  22000, examRounds:  650 },
  { id: "B", name: "เชี่ยวชาญ", power: 9.5, wage: 430, examCost:  55000, examRounds:  900 },
  { id: "A", name: "ยอดฝีมือ", power: 16.0, wage: 620, examCost: 140000, examRounds: 1200 },
  { id: "S", name: "ตำนาน",    power: 27.0, wage: 880, examCost: 340000, examRounds: 1600 },
];
const GUILD_MARKET_WAGE = 550;   // what the open market charges for one round of the same work

/* Upkeep is per member per game-day, and every line has tiers you buy for the whole institute.
 * Food keeps them able to work at all; gear decides how much of a fight they survive; training
 * turns mission time into exam progress. Skipping a line is allowed and always regretted. */
const GUILD_UPKEEP = {
  food:  { name: "อาหาร",   icon: "🍲", tiers: [
    { name: "ข้าวต้มโรงครัว", cost:  13, effect: 0.85 },
    { name: "อาหารครบหมู่",   cost:  34, effect: 1.00 },
    /* 🐛 [guild_sim upkeep sweep, 2026-08-18] At 82 the banquet was the right answer from the first
     * day of the smallest school, which makes it a bill rather than a choice: a 12% share of a small
     * haul still covered a small fixed cost. Priced at 150 it needs about 2m a year of output before
     * it pays, so a young institute correctly eats plain food and a grown one correctly does not. */
    { name: "โต๊ะจีนทุกมื้อ",  cost: 150, effect: 1.12 },
  ] },
  gear:  { name: "อุปกรณ์", icon: "⚔️", tiers: [
    { name: "ของมือสอง",     cost:  17, effect: 0.80 },
    { name: "ชุดมาตรฐาน",     cost:  48, effect: 1.00 },
    { name: "ของสั่งทำ",      cost: 132, effect: 1.30 },
  ] },
  med:   { name: "ยาและหมอ", icon: "💊", tiers: [
    { name: "ไม่มี",          cost:   0, effect: 0.00 },
    { name: "ชุดปฐมพยาบาล",   cost:  28, effect: 0.55 },
    { name: "หมอประจำสถาบัน", cost:  92, effect: 0.85 },
  ] },
  train: { name: "การฝึก",   icon: "🎯", tiers: [
    { name: "ฝึกกันเอง",      cost:  11, effect: 0.70 },
    { name: "ครูประจำ",       cost:  38, effect: 1.00 },
    { name: "ครูจากเมืองหลวง", cost: 104, effect: 1.45 },
  ] },
};

/* A mission is one squad against one monster for a number of rounds. Difficulty comes from the
 * monster's own numbers, so adding a monster adds a mission target for free.
 *
 * 🐛 [caught by guild_sim before any of this reached game.js] A round was first modelled as ONE
 * kill, which no wage could ever cover — a zone-3 monster pays about 127 gold and drops, while four
 * rank-C hunters cost 1,200 a round. A round is a squad hunting for a game-day, so it is worth many
 * kills, and how many depends on how far the squad OUTCLASSES the target. That is what makes rank
 * worth buying: a stronger squad does not merely survive, it clears faster. */
const GUILD_MISSION_ROUNDS = [10, 30, 90];
const GUILD_KILLS_BASE = 20;       // kills a squad clears in a round when it exactly matches the target
const GUILD_KILLS_CAP = 2.2;       // however far you outclass it, a day is still a day
/* 🐛 [guild_sim, 2026-08-18] A bigger monster has to take LONGER, or the only thing that decides
 * income is how rich the target's loot table happens to be. Without this term a rank-S squad grossed
 * 195,000 a game-day off ดาวดวงสุดท้าย — 180x what the player earns hunting by hand, and more from
 * one squad than all 40 properties pay together. The falloff is gentle (a target at GUILD_KILL_SLOW
 * power is cleared at half speed), so a harder contract is still worth more per day; it just stops
 * being worth 180x more. */
const GUILD_KILL_SLOW = 40;
function guildKillsPerRound(power, target, foodEffect = 1) {
  const t = Math.max(1, target);
  return GUILD_KILLS_BASE * Math.min(GUILD_KILLS_CAP, power / t)
    * (GUILD_KILL_SLOW / (GUILD_KILL_SLOW + t)) * foodEffect;
}

/* 🎯 [owner 2026-08-17: "ต้องปรับให้มันมีตัวเลขตายตัว มีความผันผวนน้อย"] What a contract PAYS is set
 * by the guild board from the danger of the monster, not by what happens to fall out of it. That is
 * the whole reason the payout is a bounty and not the monster's loot value: the loot table was
 * written for a player killing one at a time and its value per unit of difficulty swings 5x between
 * zones — z7 monsters pay 65 gold per point of danger where z3 monsters pay 12. Read straight, that
 * swing decides the guild's entire economy and no wage or upkeep number can correct it. A bounty
 * priced off danger is smooth by construction, and it makes "which monster" a question about the
 * MATERIALS you want, which is the interesting half of the decision. */
const GUILD_BOUNTY = 15;           // gold per point of contract danger, per kill
function guildBounty(stage) { return Math.max(1, Math.round(GUILD_BOUNTY * guildTargetPower(stage))); }
/* Materials come back too — that is how the guild feeds your shops — but their VALUE is budgeted as
 * a share of the bounty rather than rolled straight off the loot table, for the same reason. The
 * items are the real ones; only how many arrive is bounded. */
const GUILD_LOOT_SHARE = 0.45;
const GUILD_SQUAD_MAX = 5;
/* Power needed to clear a target comfortably. Calibrated against the squads that should be facing
 * it, not guessed: a four-strong squad of F handles the meadow, of C the volcano, of S the rift —
 * which is what makes rank the thing you buy and the target list the thing you read. */
function guildTargetPower(stage) {
  return (stage.hp / 120) + (stage.dmg / 6);
}
/* Squad power has diminishing returns per extra body, or five weak members would always beat two
 * strong ones and the rank ladder would be decoration. */
const GUILD_BODY_FALLOFF = 0.75;
function guildSquadPower(members, gearEffect) {
  const sorted = [...members].sort((a, b) => b.power - a.power);
  let total = 0;
  sorted.forEach((m, i) => { total += m.power * Math.pow(GUILD_BODY_FALLOFF, i); });
  return total * gearEffect;
}
/* Success, injury and death all read off the same ratio, so one number decides whether a mission
 * is sensible — which is what makes "pick the right target" the actual decision. */
/* 🐛 [guild_sim, 2026-08-18, once a death was priced at what it cost to raise the body] The death
 * term was 0.5, which reads as harmless until you multiply it by a year of rounds: a squad sent one
 * rank short of its target lost 22 people per member per year. These are people you spend six game-
 * years training. Injury is the common outcome and death is the rare one — 0.05 puts a bad year at
 * roughly one funeral, which is a real cost to insure against without making the roster a turnstile. */
const GUILD_DEATH_RATE = 0.05;
function guildOutcome(power, target, medEffect) {
  const ratio = power / Math.max(1, target);
  const success = Math.max(0.05, Math.min(0.97, 1 - Math.exp(-1.6 * ratio)));
  const shortfall = Math.max(0, 1 - ratio);
  const hurt = Math.min(0.6, shortfall * 0.8);
  const died = Math.max(0, hurt * shortfall * GUILD_DEATH_RATE * (1 - medEffect));
  return { success, hurt: hurt - died, died };
}
