/* Two languages, retrofitted into a game that was written in Thai throughout.
 *
 * 🎯 [owner 2026-08-22] "เพิ่มการปรับภาษา th/en ... ปล่อย ver สมบูรณ์สองภาษา"
 *
 * The obvious approach — invent a key for every string and rewrite 2,000 call sites — is the one
 * that never finishes and breaks the game halfway through. Two decisions avoid it:
 *
 * 1. THE THAI STRING IS THE KEY. No key invention, and an entry nobody has translated yet renders
 *    in Thai rather than as `menu.settings.title`. A half-finished dictionary is a game that is
 *    partly in Thai, which is a normal thing for a player to see; a half-finished keyed system is
 *    a game showing its own variable names.
 *
 * 2. THE DATA IS TRANSLATED IN PLACE, ONCE, AT SWITCH TIME. data.js holds ~900 `name`, `desc`,
 *    `flavor` and `note` fields, and every screen already reads them. Walking those tables and
 *    swapping the strings means all of it — item names, monsters, skills, achievements, villagers —
 *    changes language with zero changes to the code that renders it. The Thai original is kept
 *    beside each translated field so switching back is exact rather than a reverse lookup.
 *
 * What still needs touching by hand is game.js's own UI text, which is what T() is for.
 */

/* eslint-disable no-unused-vars */
const I18N = (() => {
  const STORE_KEY = "idle_lang";

  /* Thai → English. Everything not listed here stays Thai, on purpose — see decision 1 above.
   * Grouped by where the strings come from so a gap is easy to spot and fill. */
  const EN = {
    /* ---- equipment slots ---- */
    "หมวก": "Helmet", "เกราะ": "Armour", "อาวุธ": "Weapon", "มือรอง": "Off-hand",
    "แหวน": "Ring", "สร้อย": "Amulet",

    /* ---- skills ---- */
    "ตัดไม้": "Woodcutting", "เผาถ่าน": "Charcoal Burning", "ตกปลา": "Fishing",
    "ขุดแร่": "Mining", "ครัวเวทมนตร์": "Arcane Kitchen", "ช่างหนัง": "Leatherworking",
    "ทำสวน": "Farming", "ขโมยของ": "Thieving", "ช่างตีเหล็ก": "Smithing",

    /* ---- main navigation ---- */
    "ร้านค้า": "Shop", "ล่ามอนสเตอร์": "Hunt", "สถาบันฮันเตอร์": "Hunters' Institute",
    "ธุรกิจของเรา": "Our Businesses", "ธนาคาร/ลงทุน": "Bank & Investing", "ภาษี": "Tax",
    "การจุติ": "Rebirth", "ความสำเร็จ": "Achievements", "สถิติ": "Statistics",
    "กระเป๋าเก็บของ": "Inventory", "ลานหมู่บ้าน": "Village Square", "ครอบครัว": "Family",

    /* ---- village and relationships ---- */
    "ภารกิจเควส": "Quests", "ความสัมพันธ์": "Relationships", "คนในหมู่บ้าน": "Villagers",
    "มายา": "Maya", "ริน": "Rin", "โซระ": "Sora", "คาโน": "Kano", "เอลลี่": "Ellie",
    "โบริน": "Borin", "ตั้ม": "Tam",
    "คนดูแลเรือนเพาะชำ": "Nursery keeper", "ช่างตีเหล็ก ": "Blacksmith",
    "ลูกสาวพ่อค้า": "Merchant's daughter", "คนหาปลาริมทะเลสาบ": "Lakeside angler",
    "ดาเมจมากขึ้น อาวุธถูกลง": "More damage, cheaper weapons",
    "นักบันทึกของสถาบัน": "Institute archivist", "คนตัดไม้": "Woodcutter",
    "เจ้าของโรงเตี๊ยม": "Innkeeper",
    "คนแปลกหน้า": "Stranger", "คนรู้จัก": "Acquaintance", "เพื่อน": "Friend",
    "คนสนิท": "Close friend", "คนรัก": "Sweetheart", "แต่งงาน": "Married",
    "ทักได้ ยังไม่รับของ": "Will talk, not yet accept gifts",
    "เริ่มรับของขวัญ": "Accepts gifts",
    "สั่งงานให้เราได้": "Will ask you for work",
    "บอกของที่ชอบเอง": "Tells you what they like",
    "ขอแต่งงานได้": "You may propose",
    "โบนัสเต็ม · เปิดระบบลูก": "Full bonus · children unlocked",
    "พืชผลโตเร็วขึ้น": "Crops grow faster",
    "ดาเมจมากขึ้น": "More damage",
    "ขายของได้ราคาดีขึ้น": "Better selling prices",
    "โอกาสได้ของหายากมากขึ้น": "Better chance of rare finds",
    "ได้ XP ทุกสายมากขึ้น": "More XP in every skill",

    /* ---- family and children ---- */
    "การค้า": "Trade", "การล่า": "Hunting", "สายผลิต": "Crafting",
    "ดาเมจของเรามากขึ้น": "Raises your damage",
    "ได้ XP ทุกสายมากขึ้น ": "More XP in every skill",

    /* ---- items: raw materials ---- */
    "ไม้โอ๊ค": "Oak Log", "ไม้วิลโลว์เงา": "Shadow Willow", "ไม้จันทรา": "Moonwood",
    "ไม้เกล็ดมังกร": "Dragonscale Timber", "ไม้วิญญาณโบราณ": "Ancient Spirit Wood",
    "ไม้สุริยัน": "Sunwood",
    "หินผาโบราณ": "Ancient Stone", "แร่ทองแดงรุ้ง": "Rainbow Copper Ore",
    "แร่เหล็กเงา": "Sheen Iron Ore", "แร่มิธริลน้ำเงิน": "Azure Mithril Ore",
    "แร่เงินบริสุทธิ์": "Pure Silver Ore", "แร่ทองคำเปลว": "Gilded Gold Ore",
    "แร่อดามันไทต์": "Adamantite Ore", "แร่ราตรีดำ": "Blacknight Ore", "แร่สุริยะ": "Solar Ore",
    "ถ่านวิญญาณ": "Spirit Charcoal", "ถ่านไม้มายา": "Arcane Charcoal",
    "หนังสัตว์นุ่ม": "Soft Hide", "หนังสัตว์หนา": "Thick Hide", "หนังฟอกเวท": "Enchanted Leather",
    "หนังมังกรเพลิง": "Flame Dragon Hide",

    /* ---- items: fish and the sea ---- */
    "ปลาน้ำใส": "Clearwater Fish", "ปลาเงินระยับ": "Glimmering Silverfish",
    "ปลาแสงจันทร์": "Moonlight Fish", "ปลามังกรน้อย": "Wyrmling Fish",
    "ปลาซิวแก้ว": "Glass Minnow", "กบภูเขา": "Mountain Frog", "ปลาไนเกล็ดเงิน": "Silverscale Carp",
    "ปลาไหลสายฟ้า": "Thunder Eel", "ปลาโคมไฟ": "Lantern Fish", "ปูจันทรา": "Moon Crab",
    "กระเบนราตรี": "Night Ray", "หมึกยักษ์ราตรี": "Night Kraken", "ปลาดาบเงา": "Shadow Sabrefish",
    "หมึกมรกต": "Emerald Squid", "ปลาผีเหวลึก": "Abyss Wraithfish", "ปลามังกรทอง": "Golden Dragonfish",

    /* ---- items: cooking ---- */
    "ขนมปังโฮมเมด": "Homemade Bread", "ปลาย่างหอมกรุ่น": "Grilled Fish",
    "สตูว์ปลาเงิน": "Silverfish Stew", "จานแสงจันทร์": "Moonlight Platter",
    "มื้อราชามังกร": "Dragon King's Feast", "สเต๊กปลาดาบเงา": "Sabrefish Steak",
    "หมึกย่างมรกต": "Grilled Emerald Squid", "ซุปวิญญาณเหวลึก": "Abyssal Spirit Soup",
    "ไม้ปิ้งรวมมิตร": "Mixed Skewer", "ต้มยำปลาไน": "Spiced Carp Soup",
    "ปูจันทราอบเกลือ": "Salt-Baked Moon Crab", "หมึกผัดพริกไทย": "Peppered Squid",
    "มื้อจักรพรรดิมังกร": "Dragon Emperor's Banquet",

    /* ---- items: seeds and crops ---- */
    "เมล็ดแครอทแสงจันทร์": "Moonlight Carrot Seed", "เมล็ดมันหวานราตรี": "Night Yam Seed",
    "เมล็ดฟักทองโคมไฟ": "Lantern Pumpkin Seed", "เมล็ดองุ่นน้ำค้าง": "Dewdrop Grape Seed",
    "เมล็ดแตงโมจันทรา": "Moon Melon Seed", "เมล็ดสตรอว์เบอร์รีเพลิง": "Ember Strawberry Seed",
    "เมล็ดทับทิมอมตะ": "Undying Pomegranate Seed", "เมล็ดผลไม้ดาวนิรันดร์": "Eternal Star Fruit Seed",
    "แครอทแสงจันทร์": "Moonlight Carrot", "มันหวานราตรี": "Night Yam",
    "ฟักทองโคมไฟ": "Lantern Pumpkin", "องุ่นน้ำค้าง": "Dewdrop Grapes",
    "แตงโมจันทรา": "Moon Melon", "สตรอว์เบอร์รีเพลิง": "Ember Strawberry",
    "ทับทิมอมตะ": "Undying Pomegranate", "ผลไม้ดาวนิรันดร์": "Eternal Star Fruit",

    /* ---- items: rare drops ---- */
    "เรซินทองคำ": "Golden Resin", "ไข่มุกน้ำลึก": "Deepwater Pearl", "เครื่องเทศมิติ": "Void Spice",
    "แร่ดาวตก": "Meteor Ore", "เมือกสไลม์ดาว": "Star Slime Goo", "เศษเขาเดียว": "Horn Shard",
    "เขี้ยวหมาป่าเงา": "Shadow Wolf Fang", "สปอร์เรืองแสง": "Glowing Spore",
    "กิ่งไม้ต้องสาป": "Cursed Twig", "ผงวิญญาณ": "Spirit Dust", "ปีกค้างคาวน้ำแข็ง": "Frost Bat Wing",
    "แกนหิมะโบราณ": "Ancient Snow Core", "เกล็ดมังกรน้ำแข็ง": "Ice Dragon Scale",
    "อัญมณีจันทรา": "Moon Gem", "แกนเพลิงนิรันดร์": "Eternal Ember Core",
    "ขนนกพายุ": "Storm Feather", "รูนเวหา": "Sky Rune", "คัมภีร์โบราณ": "Ancient Tome",
    "กระดูกกาลเวลา": "Bone of Ages", "ทรายนาฬิกา": "Hourglass Sand",
    "เศษมงกุฎผุพัง": "Crumbled Crown Shard", "เถ้าดาวดับ": "Dead Star Ash", "แกนโนวา": "Nova Core",

    /* ---- items: leatherwork goods ---- */
    "กระเป๋าหนังเย็บมือ": "Hand-stitched Pouch", "รองเท้าหนังนุ่ม": "Soft Leather Boots",
    "เสื้อคลุมหนังมังกร": "Dragonhide Coat", "ผ้าคลุมขนนกพายุ": "Storm Feather Cloak",
    "ต่างหูเงินสลัก": "Engraved Silver Earrings", "กำไลทองคำเปลว": "Gilded Bangle",
    "แหวนมิธริลเกลียว": "Twisted Mithril Ring", "จี้อัญมณีจันทรา": "Moon Gem Pendant",
    "มงกุฎจำลองฟาโรห์": "Replica Pharaoh Crown",

    /* ---- items: junk ---- */
    "รองเท้าบูตเปียก": "Soggy Boot", "กระป๋องสนิม": "Rusted Can", "สาหร่ายพันเบ็ด": "Tangled Weed",
    "กระดูกปลาเก่า": "Old Fish Bone", "ขวดเปล่าไร้สาร": "Empty Bottle", "ถุงเท้าข้างเดียว": "Odd Sock",
    "กุญแจไขไม่เข้า": "Key That Fits Nothing", "จดหมายรักผิดซอง": "Misdelivered Love Letter",
    "กระดุมหลุดด้าย": "Loose Button", "แผนที่ขาดครึ่ง": "Torn Half-Map",

    /* ---- items: weapons ---- */
    "หอกไม้โอ๊ค": "Oak Spear", "ดาบทองแดงรุ้ง": "Rainbow Copper Sword",
    "ดาบเหล็กเงา": "Sheen Iron Sword", "ดาบมิธริลน้ำเงิน": "Azure Mithril Sword",
    "ดาบราตรีมืด": "Blacknight Sword", "ดาบสุริยกานต์": "Solar Sword",
    "ดาบจันทรุปราคา": "Eclipse Blade", "ดาบฟาโรห์": "Pharaoh's Sword", "ดาบดาวดับ": "Dead Star Sword",
    "ดาบเขี้ยวหมาป่า": "Wolf Fang Sword", "ดาบแสงจันทร์": "Moonlight Blade",
    "ทวนเกล็ดมังกร": "Dragonscale Lance", "ดาบเงินบริสุทธิ์": "Pure Silver Sword",
    "ดาบทองคำเปลว": "Gilded Sword", "ดาบอดามันไทต์": "Adamantite Sword",

    /* ---- items: armour ---- */
    "หมวกทองแดงรุ้ง": "Rainbow Copper Helm", "หมวกเหล็กเงา": "Sheen Iron Helm",
    "หมวกเงินบริสุทธิ์": "Pure Silver Helm", "หมวกทองคำเปลว": "Gilded Helm",
    "หมวกมิธริล": "Mithril Helm", "หมวกอดามันไทต์": "Adamantite Helm",
    "หมวกสุริยะ": "Solar Helm", "หมวกหนังนักล่า": "Hunter's Leather Cap",
    "หมวกราตรีมืด": "Blacknight Helm", "หมวกฟาโรห์": "Pharaoh's Helm", "หมวกดาวดับ": "Dead Star Helm",
    "เกราะทองแดงรุ้ง": "Rainbow Copper Armour", "เกราะเกล็ดมังกร": "Dragonscale Armour",
    "เกราะเหล็กเงา": "Sheen Iron Armour", "เกราะเงินบริสุทธิ์": "Pure Silver Armour",
    "เกราะทองคำเปลว": "Gilded Armour", "เกราะมิธริล": "Mithril Armour",
    "เกราะอดามันไทต์": "Adamantite Armour", "เกราะราตรีมืด": "Blacknight Armour",
    "เกราะหนังเบา": "Light Leather Armour", "เกราะสุริยะ": "Solar Armour",
    "เกราะฟาโรห์": "Pharaoh's Armour", "เกราะดาวดับ": "Dead Star Armour",
    "เกราะหนังมังกรเพลิง": "Flame Dragonhide Armour", "ชุดขนนกพายุ": "Storm Feather Garb",
    "โล่ไม้โอ๊ค": "Oak Shield", "โล่เหล็กเงา": "Sheen Iron Shield",
    "โล่ทองแดงรุ้ง": "Rainbow Copper Shield", "โล่เงินบริสุทธิ์": "Pure Silver Shield",
    "โล่ทองคำเปลว": "Gilded Shield", "โล่มิธริล": "Mithril Shield",
    "โล่อดามันไทต์": "Adamantite Shield", "โล่ราตรีมืด": "Blacknight Shield",
    "โล่สุริยะ": "Solar Shield", "โล่ฟาโรห์": "Pharaoh's Shield", "โล่ดาวดับ": "Dead Star Shield",
    "แหวนแสงจันทรา": "Moonlight Ring", "แหวนตราขุนนาง": "Noble Signet Ring",
    "แหวนรูนเวหา": "Sky Rune Ring", "สร้อยไข่มุกลึก": "Deep Pearl Amulet",
    "สร้อยแกนเพลิง": "Ember Core Amulet",

    /* ---- skill zones and actions: woodcutting, charcoal ---- */
    "ต้นโอ๊คเก่าแก่": "Old Oak", "วิลโลว์เงาพลิ้ว": "Swaying Shadow Willow",
    "ต้นจันทราเรืองแสง": "Glowing Moon Tree", "พฤกษ์เกล็ดมังกร": "Dragonscale Tree",
    "ต้นวิญญาณโบราณ": "Ancient Spirit Tree", "ต้นสุริยันเรืองรอง": "Radiant Sun Tree",
    "เผาไม้โอ๊ค": "Burn Oak", "เผาไม้วิลโลว์": "Burn Willow", "เผาไม้จันทรา": "Burn Moonwood",
    "เผาไม้มังกร": "Burn Dragonwood", "เผาไม้วิญญาณ": "Burn Spirit Wood",
    "เผาไม้สุริยัน": "Burn Sunwood",

    /* ---- skill zones and actions: fishing ---- */
    "ลำธารน้ำใส": "Clear Stream", "วังปลาเงิน": "Silverfish Pool", "อ่าวแสงจันทร์": "Moonlight Bay",
    "ร่องน้ำปลาดาบ": "Sabrefish Channel", "ดงหมึกมรกต": "Emerald Squid Beds",
    "เหวลึกพราวดาว": "Starlit Abyss", "วังปลามังกรทอง": "Golden Dragonfish Pool",

    /* ---- skill zones and actions: mining ---- */
    "ผาหินโบราณ": "Ancient Cliff", "สายแร่ทองแดงรุ้ง": "Rainbow Copper Vein",
    "สายแร่เหล็กเงา": "Sheen Iron Vein", "สายแร่มิธริล": "Mithril Vein",
    "สายแร่เงินบริสุทธิ์": "Pure Silver Vein", "สายแร่ทองคำเปลว": "Gilded Gold Vein",
    "สายแร่อดามันไทต์": "Adamantite Vein", "สายแร่ราตรีดำ": "Blacknight Vein",
    "สายแร่สุริยะ": "Solar Vein",

    /* ---- skill zones and actions: cooking ---- */
    "ย่างปลาน้ำใส": "Grill Clearwater Fish", "ตุ๋นสตูว์ปลาเงิน": "Simmer Silverfish Stew",
    "จัดจานแสงจันทร์": "Plate the Moonlight Platter", "จัดมื้อจักรพรรดิมังกร": "Serve the Dragon Emperor's Banquet",
    "ย่างสเต๊กปลาดาบ": "Grill Sabrefish Steak", "ย่างหมึกมรกต": "Grill Emerald Squid",
    "ต้มซุปวิญญาณเหวลึก": "Boil Abyssal Spirit Soup", "ไม้ปิ้งปลาซิว-กบ": "Minnow & Frog Skewer",
    "ต้มยำปลาไนเกล็ดเงิน": "Spiced Silverscale Carp Soup", "หมึกยักษ์ผัดพริกไทย": "Peppered Kraken",

    /* ---- skill zones and actions: leatherworking ---- */
    "ฟอกหนังนุ่ม": "Tan Soft Hide", "เย็บกระเป๋าหนัง": "Stitch Leather Pouch",
    "ตัดรองเท้าหนัง": "Cut Leather Boots", "ตัดเสื้อคลุมหนังมังกร": "Cut Dragonhide Coat",
    "ถักผ้าคลุมขนนกพายุ": "Weave Storm Feather Cloak", "ถักชุดขนนกพายุ": "Weave Storm Feather Garb",
    "เย็บหมวกหนังนักล่า": "Sew Hunter's Cap", "เย็บเกราะหนังเบา": "Sew Light Leather Armour",
    "เย็บเกราะหนังมังกรเพลิง": "Sew Flame Dragonhide Armour",
    "สลักต่างหูเงิน": "Engrave Silver Earrings", "ตีกำไลทองคำเปลว": "Forge Gilded Bangle",
    "เกลียวแหวนมิธริล": "Twist Mithril Ring", "เจียรจี้อัญมณีจันทรา": "Cut Moon Gem Pendant",
    "เจียรแหวนแสงจันทรา": "Cut Moonlight Ring", "เจียรแหวนรูนเวหา": "Cut Sky Rune Ring",
    "ร้อยสร้อยไข่มุกลึก": "String Deep Pearl Amulet", "ร้อยสร้อยแกนเพลิง": "String Ember Core Amulet",
    "จำลองมงกุฎฟาโรห์": "Replicate Pharaoh Crown", "ตัดถุงเงินกะลาสี": "Cut a Sailor's Purse",

    /* ---- skill zones and actions: thieving ---- */
    "ล้วงกระเป๋าชาวบ้าน": "Pick a Villager's Pocket", "ย่องเก็บรังสไลม์": "Raid a Slime Nest",
    "ขโมยจากรังหมาป่า": "Rob a Wolf Den", "ย่องหลังพ่อค้าเร่": "Slip Behind the Pedlar",
    "ล้วงย่ามศิษย์เวท": "Lift an Apprentice's Satchel", "เจาะร้านพ่อค้าอัญมณี": "Crack the Gem Trader's Shop",
    "แทรกซึมคฤหาสน์ขุนนาง": "Infiltrate the Noble's Manor", "ปล้นคลังภาษีตลาด": "Rob the Market Tax Vault",
    "ฉกคทาอาจารย์ใหญ่": "Snatch the Headmaster's Staff", "ย่องห้องสมุดต้องห้าม": "Slip into the Forbidden Library",
    "ล้วงเครื่องประดับนางกำนัล": "Lift a Lady-in-Waiting's Jewels", "เจาะห้องเครื่องต้น": "Breach the Royal Kitchen",
    "ปล้นกองคาราวานทะเลทราย": "Raid the Desert Caravan", "ย่องด่านศุลกากรหลวง": "Slip Past the Royal Customs",
    "ฉกมงกุฎสำรองท้องพระคลัง": "Take the Spare Crown from the Treasury",
    "ย่องสุสานกษัตริย์เก่า": "Creep into the Old Kings' Tomb", "รื้อเครื่องเซ่นหลุมศพ": "Rifle the Grave Offerings",
    "ปล้นหีบศพนักบวชลิช": "Loot the Lich Priest's Casket", "ล้วงแท่นบูชาใต้พิภพ": "Rob the Underworld Altar",
    "ปล้นถ้ำมังกรน้ำแข็ง": "Raid the Ice Dragon's Cave", "ล้วงแกนโกเลมหิมะ": "Prise Out a Snow Golem Core",
    "ล้วงรังนกอินทรีพายุ": "Rob a Storm Eagle's Nest", "ฉกของยอดหอคอยจอมเวท": "Steal from the Archmage's Spire",
    "ฉกสมบัติรังมังกร": "Snatch a Dragon Hoard", "ย่องคลังสมบัติดาวดับ": "Slip into the Dead Star Vault",
    "งัดหีบสินค้าใต้ท้องเรือ": "Prise Open the Ship's Hold",

    /* ---- skill zones and actions: smithing ---- */
    "ตีหอกไม้โอ๊ค": "Forge Oak Spear", "ประกอบโล่ไม้โอ๊ค": "Assemble Oak Shield",
    "ตีดาบทองแดงรุ้ง": "Forge Rainbow Copper Sword", "ตีหมวกทองแดงรุ้ง": "Forge Rainbow Copper Helm",
    "ตีเกราะทองแดงรุ้ง": "Forge Rainbow Copper Armour", "ตีโล่ทองแดงรุ้ง": "Forge Rainbow Copper Shield",
    "ตีดาบเหล็กเงา": "Forge Sheen Iron Sword", "ตีหมวกเหล็กเงา": "Forge Sheen Iron Helm",
    "ตีเกราะเหล็กเงา": "Forge Sheen Iron Armour", "ตีโล่เหล็กเงา": "Forge Sheen Iron Shield",
    "ตีดาบเงินบริสุทธิ์": "Forge Pure Silver Sword", "ตีหมวกเงินบริสุทธิ์": "Forge Pure Silver Helm",
    "ตีเกราะเงินบริสุทธิ์": "Forge Pure Silver Armour", "ตีโล่เงินบริสุทธิ์": "Forge Pure Silver Shield",
    "ตีดาบทองคำเปลว": "Forge Gilded Sword", "ตีหมวกทองคำเปลว": "Forge Gilded Helm",
    "ตีเกราะทองคำเปลว": "Forge Gilded Armour", "ตีโล่ทองคำเปลว": "Forge Gilded Shield",
    "ตีดาบมิธริล": "Forge Mithril Sword", "ตีหมวกมิธริล": "Forge Mithril Helm",
    "ตีเกราะมิธริล": "Forge Mithril Armour", "ตีโล่มิธริล": "Forge Mithril Shield",
    "ตีดาบอดามันไทต์": "Forge Adamantite Sword", "ตีหมวกอดามันไทต์": "Forge Adamantite Helm",
    "ตีเกราะอดามันไทต์": "Forge Adamantite Armour", "ตีโล่อดามันไทต์": "Forge Adamantite Shield",
    "ตีดาบราตรีมืด": "Forge Blacknight Sword", "ตีหมวกราตรีมืด": "Forge Blacknight Helm",
    "ตีเกราะราตรีมืด": "Forge Blacknight Armour", "ตีโล่ราตรีมืด": "Forge Blacknight Shield",
    "ตีดาบสุริยะ": "Forge Solar Sword", "ตีหมวกสุริยะ": "Forge Solar Helm",
    "ตีเกราะสุริยะ": "Forge Solar Armour", "ตีโล่สุริยะ": "Forge Solar Shield",
    "ตีดาบฟาโรห์": "Forge Pharaoh's Sword", "ขึ้นรูปหมวกฟาโรห์": "Shape Pharaoh's Helm",
    "ประกอบเกราะฟาโรห์": "Assemble Pharaoh's Armour", "ตีโล่ฟาโรห์": "Forge Pharaoh's Shield",
    "หลอมดาบดาวดับ": "Smelt Dead Star Sword", "หลอมหมวกดาวดับ": "Smelt Dead Star Helm",
    "หลอมเกราะดาวดับ": "Smelt Dead Star Armour", "หลอมโล่ดาวดับ": "Smelt Dead Star Shield",
    "หลอมดาบจันทรุปราคา": "Smelt Eclipse Blade", "ตีทวนเกล็ดมังกร": "Forge Dragonscale Lance",
    "ประกอบเกราะเกล็ดมังกร": "Assemble Dragonscale Armour",

    /* ---- hunting grounds ---- */
    "ทุ่งหญ้าพระจันทร์": "Moonlit Meadow", "ป่าลึกเงามืด": "Deep Shadow Forest",
    "ถ้ำมังกรน้ำแข็ง": "Ice Dragon Cave", "ภูเขาไฟพิโรธ": "Wrathful Volcano",
    "สุสานกาลเวลา": "Tomb of Ages", "ปราสาทลอยฟ้า": "Floating Castle",
    "รอยแยกมิติ": "Dimensional Rift", "แดนดาวดับ": "Dead Star Reach", "ห้วงกำเนิด": "The Birthing Void",
    "สไลม์ดาว": "Star Slime", "กระต่ายเขาเดียว": "One-horned Hare", "หมาป่าเงา": "Shadow Wolf",
    "ราชากระต่ายจันทรา": "Moon Hare King", "เห็ดเดินได้": "Walking Mushroom",
    "ปีศาจกิ่งไม้": "Twig Fiend", "วิญญาณพฤกษา": "Dryad", "แมงมุมใยเงิน": "Silverweb Spider",
    "เจ้าป่าเงามืด": "Lord of the Dark Wood", "ค้างคาวน้ำแข็ง": "Frost Bat",
    "โกเลมหิมะ": "Snow Golem", "เยติขนน้ำแข็ง": "Ice-furred Yeti", "มังกรน้ำแข็งเยาว์": "Young Ice Dragon",
    "ราชินีมังกรน้ำแข็ง": "Ice Dragon Queen", "หนูลาวา": "Lava Rat", "ซาลาแมนเดอร์เพลิง": "Flame Salamander",
    "จิ้งจอกเพลิง": "Ember Fox", "โกเลมหินหลอม": "Molten Stone Golem", "ราชันเพลิงพิโรธ": "Wrathful Flame King",
    "ด้วงทรายทอง": "Golden Sand Beetle", "มัมมี่ผู้เฝ้าสุสาน": "Tomb Warden Mummy",
    "โคลอสซัสหินทราย": "Sandstone Colossus", "สฟิงซ์ปริศนา": "Riddling Sphinx",
    "ฟาโรห์นิรันดร์": "The Eternal Pharaoh", "การ์กอยล์หิน": "Stone Gargoyle",
    "อัศวินเวหา": "Sky Knight", "ฟีนิกซ์เวหา": "Sky Phoenix", "นางพญาวายุ": "Storm Empress",
    "ราชาไร้บัลลังก์": "The Throneless King", "ภูตกาลเวลา": "Time Sprite",
    "เถ้าเดินได้": "Walking Ash", "ร่างไร้กาล": "The Timeless One", "ผู้เฝ้ารอยแยก": "Warden of the Rift",
    "ดวงไฟไร้ชื่อ": "Nameless Flame", "วิญญาณแสงเร่ร่อน": "Wandering Lightwisp",
    "อสูรเมฆา": "Cloud Demon", "ผู้ประกาศวาระ": "Herald of the Hour",
    "สะเก็ดดาวมีชีวิต": "Living Starshard", "เลวีอาธานอวกาศ": "Void Leviathan",
    "เงาสุริยุปราคา": "Eclipse Shade", "ผู้กลืนแสง": "The Light-Swallower",
    "ม่านฝุ่นดารา": "Veil of Star Dust", "พัลซาร์คลั่ง": "Raging Pulsar",
    "ผู้คุมดาวดับ": "Keeper of the Dead Star", "ดาวดวงสุดท้าย": "The Last Star",
    "ประกายแรกเกิด": "First Spark", "ดาวแรกที่ยังไม่เกิด": "The Star Not Yet Born",
    "ผู้เฝ้าครรภ์ดารา": "Warden of the Stellar Womb",

    /* ---- companions ---- */
    "สไลม์น้อย": "Slimelet", "หน่อพฤกษา": "Sprout", "ลูกหมาป่าเงา": "Shadow Wolf Pup",
    "ค้างคาวน้อย": "Batling", "ลูกโกเลมหิมะ": "Snow Golem Whelp", "ลูกจิ้งจอกเพลิง": "Ember Fox Kit",
    "ด้วงทองน้อย": "Scarabling", "แมวทะเลทราย": "Sand Cat", "เหยี่ยวเวหา": "Sky Hawk",
    "แมวเมฆา": "Cloud Cat", "ลูกดาวตก": "Star Cub", "ลูกโนวา": "Novaling",
    "วาฬดาวน้อย": "Star Whale",

    /* ---- achievements ---- */
    "ก้าวแรกในมิธวูด": "First Steps in Mythwood", "มือขยัน": "Diligent Hands",
    "ไม่รู้จักเหนื่อย": "Tireless", "นักล่าหน้าใหม่": "Fresh Hunter",
    "นักล่าผู้ช่ำชอง": "Seasoned Hunter", "ผู้ปราบตำนาน": "Legend Slayer",
    "นักล่า": "Hunter", "นักสะสมทอง": "Gold Hoarder", "นักเก็บของเก่า": "Junk Collector",
    "เชฟแห่งมิธวูด": "Chef of Mythwood", "ช่างตีมือทอง": "Golden-handed Smith",
    "เงาในตลาด": "Shadow in the Market", "มือใหม่หัดปลูก": "Novice Gardener",
    "มือเขียวแห่งมิธวูด": "Green Thumb of Mythwood", "นักพฤกษศาสตร์": "Botanist",
    "นักตกปลาตัวจริง": "True Angler", "ผู้ครอบครองชุด": "Set Collector",
    "ความชำนาญขั้นต้น": "Early Mastery", "ปรมาจารย์": "Grandmaster",
    "ทำงานสำเร็จ 50 ครั้ง": "Complete 50 actions", "ทำงานสำเร็จ 1,000 ครั้ง": "Complete 1,000 actions",
    "ทำงานสำเร็จ 10,000 ครั้ง": "Complete 10,000 actions",
    "ปราบมอนสเตอร์ 100 ตัว": "Defeat 100 monsters", "ปราบมอนสเตอร์ 1,000 ตัว": "Defeat 1,000 monsters",
    "โค่นบอส 5 ตัว": "Fell 5 bosses", "หาทองสะสมครบ 100,000": "Earn 100,000 gold",
    "ขายขยะ 500 ชิ้น": "Sell 500 pieces of junk", "ปรุงอาหาร 300 จาน": "Cook 300 dishes",
    "ตีของ 200 ชิ้น": "Forge 200 items", "ขโมยสำเร็จ 250 ครั้ง": "250 successful thefts",
    "เก็บเกี่ยวสำเร็จ 50 ครั้ง": "Harvest 50 times", "เก็บเกี่ยวสำเร็จ 500 ครั้ง": "Harvest 500 times",
    "ปลูกพืชให้ครบทั้ง 8 ชนิด": "Grow all 8 crops",
    "ตกปลาให้ได้ครบ 12 สายพันธุ์": "Catch 12 species of fish",
    "มีชุดเกราะครบเซ็ต 3 ชุด": "Complete 3 armour sets",
    "ขั้นชำนาญรวมทุกสาย 100": "100 total mastery levels",
    "ขั้นชำนาญรวมทุกสาย 400": "400 total mastery levels",

    /* ---- small tables ---- */
    "ปกติ": "Normal", "ชั้นยอด": "Elite", "ราตรีต้องสาป": "Cursed Night", "โกลาหล": "Chaos",
    "ธรรมดา": "Common", "พอใช้": "Fair", "ดี": "Good", "ยอดเยี่ยม": "Excellent", "ตำนาน": "Legendary",
    "กึ่งเทวะ": "Demigod", "เทพสวรรค์": "Celestial",

    "ผสมพันธุ์": "Fuse", "ผสมอัตโนมัติ": "Auto-fuse", "คู่": "pairs",
    "จับคู่ผสมให้อัตโนมัติ — ไม่แตะตัวที่พาลงสนาม และไม่ผสมขั้นสูงสุด":
      "Pairs everything it safely can — never the companion you are fielding, never the top grade",
    "ไม่มีคู่ที่ผสมได้": "No pair can be fused",
    "จะผสมอัตโนมัติ": "This will fuse",
    "ตัวที่พาลงสนามและขั้นสูงสุดจะไม่ถูกแตะ": "The companion you are fielding and the top grade are left alone",
    "ผสมแล้วสัตว์เลี้ยงสองตัวจะกลายเป็นตัวเดียว": "Each fusion turns two companions into one",
    "เลื่อนขั้นสำเร็จ": "moved up a grade", "ตัว": "",

    /* ---- companion skills ---- */
    "เขี้ยวคม": "Sharp Fangs", "เขี้ยวคมขึ้น": "Sharper Fangs",
    "เขี้ยวสังหาร": "Killing Fangs", "เขี้ยวทำลายล้าง": "Ruinous Fangs", "เขี้ยวเทพ": "Divine Fangs",
    "หนังหนา": "Thick Hide", "หนังหนาขึ้น": "Thicker Hide",
    "เกล็ดแข็ง": "Hard Scales", "เกล็ดอมตะ": "Undying Scales", "เกราะเทพ": "Divine Scales",
    "ท่าหนัก": "Heavy Blow", "ท่าหนักแท้": "True Heavy Blow", "ท่าหนักทำลายล้าง": "Ruinous Blow",
    "คอมโบสามชั้น": "Three-hit Combo", "คอมโบสี่ชั้น": "Four-hit Combo", "คอมโบห้าชั้น": "Five-hit Combo",
    "ลมหายใจฟื้นฟู": "Restoring Breath", "ลมหายใจศักดิ์สิทธิ์": "Sacred Breath",
    "ลมหายใจอมตะ": "Undying Breath",
    "ฝึกหัด": "Apprentice", "ชั้นต้น": "Junior", "ชั้นกลาง": "Adept", "ชำนาญ": "Skilled",
    "เชี่ยวชาญ": "Expert", "ยอดฝีมือ": "Master",
    "เริ่มต้น": "Warming up", "เข้าจังหวะ": "In rhythm", "ลื่นไหล": "Flowing", "ไฟลุก": "On fire",
    "วัตถุดิบ": "Materials", "สินค้า": "Goods", "อาหาร": "Food", "อุปกรณ์": "Equipment",
    "เมล็ดพันธุ์": "Seeds",
    "คลั่ง": "Enraged", "ดูดพลัง": "Draining", "เกราะแข็ง": "Armoured",
    "ครบทั้งสายทำงาน": "Complete the whole working line",
    "จุติครบ 5 ครั้ง": "Rebirth 5 times",
    "เก็บรอยล่าครบทุกชั้น": "Earn every slayer mark",
    "ล่าครบ 1,000 ตัว ใน 2 สายพันธุ์": "1,000 kills across 2 species",
    "ล่าครบ 1,000 ตัว ใน 5 สายพันธุ์": "1,000 kills across 5 species",

    /* ---- shop: tools, tomes and charms ---- */
    "ขวานเหล็กกล้า": "Steel Axe", "ขวานมิธริล": "Mithril Axe", "ขวานเพลิงมังกร": "Dragonflame Axe",
    "ขวานวิญญาณป่า": "Forest Spirit Axe", "ขวานตำนานมิธวูด": "Mythwood Legend Axe",
    "เบ็ดไผ่เวทย์": "Enchanted Bamboo Rod", "เบ็ดเงินระยับ": "Glimmering Silver Rod",
    "เบ็ดหนวดคราเคน": "Kraken Tendril Rod", "เบ็ดวิญญาณสมุทร": "Ocean Spirit Rod",
    "เบ็ดตำนานมิธวูด": "Mythwood Legend Rod",
    "อีเต้อเหล็กกล้า": "Steel Pickaxe", "อีเต้อมิธริล": "Mithril Pickaxe",
    "อีเต้อดาวตก": "Meteor Pickaxe", "อีเต้อวิญญาณผา": "Cliff Spirit Pickaxe",
    "อีเต้อตำนานมิธวูด": "Mythwood Legend Pickaxe",
    "กระทะทองแดง": "Copper Pan", "กระทะรูน": "Rune Pan", "กระทะไฟฟีนิกซ์": "Phoenix Flame Pan",
    "กระทะวิญญาณไฟ": "Fire Spirit Pan", "กระทะตำนานมิธวูด": "Mythwood Legend Pan",
    "บัวรดน้ำดินเผา": "Clay Watering Can", "บัวรดน้ำแสงจันทร์": "Moonlight Watering Can",
    "บัวเรียกสายฝน": "Rain-calling Can", "บัววิญญาณพฤกษา": "Dryad Spirit Can",
    "ค้อนศิลา": "Stone Hammer", "ค้อนรูนโบราณ": "Ancient Rune Hammer",
    "ค้อนดาวตก": "Meteor Hammer", "ค้อนวิญญาณเหล็ก": "Iron Spirit Hammer",
    "ค้อนตำนานมิธวูด": "Mythwood Legend Hammer",
    "คัมภีร์พฤกษา": "Tome of Groves", "คัมภีร์วารี": "Tome of Waters",
    "คัมภีร์ศิลา": "Tome of Stone", "คัมภีร์รสมายา": "Tome of Flavours",
    "คัมภีร์เส้นด้าย": "Tome of Threads", "คัมภีร์พรรณพฤกษ์": "Tome of Flora",
    "คัมภีร์เงามืด": "Tome of Shadows", "คัมภีร์โลหะ": "Tome of Metals",
    "คัมภีร์เพลิงสงบ": "Tome of the Quiet Flame",
    "มหาคัมภีร์พฤกษา": "Great Tome of Groves", "มหาคัมภีร์วารี": "Great Tome of Waters",
    "มหาคัมภีร์ศิลา": "Great Tome of Stone", "มหาคัมภีร์รสมายา": "Great Tome of Flavours",
    "มหาคัมภีร์เส้นด้าย": "Great Tome of Threads", "มหาคัมภีร์พรรณพฤกษ์": "Great Tome of Flora",
    "มหาคัมภีร์เงามืด": "Great Tome of Shadows", "มหาคัมภีร์โลหะ": "Great Tome of Metals",
    "มหาคัมภีร์เพลิงสงบ": "Great Tome of the Quiet Flame",
    "ดาวนำโชคจันทรา": "Moon Lucky Star", "ตาแมวนำโชค": "Lucky Cat's Eye",
    "ตราชั่งพ่อค้าหลวง": "Royal Merchant's Scales", "เหรียญพ่อค้าเถื่อน": "Smuggler's Coin",
    "หินเวทคุ้มกัน": "Warding Stone", "โล่วิญญาณบรรพชน": "Ancestral Spirit Shield",
    "หัวใจโอ๊คโบราณ": "Heart of the Old Oak", "หัวใจมังกรนิรันดร์": "Eternal Dragon Heart",
    "ทำสองอย่างพร้อมกัน": "Two jobs at once", "ทำสามอย่างพร้อมกัน": "Three jobs at once",
    "ทำสี่อย่างพร้อมกัน": "Four jobs at once", "ทำห้าอย่างพร้อมกัน": "Five jobs at once",
    "กระถางที่ 4": "Plot 4", "กระถางที่ 5": "Plot 5", "กระถางที่ 6": "Plot 6",
    "กระถางที่ 7": "Plot 7", "กระถางที่ 8": "Plot 8", "กระถางที่ 9": "Plot 9",

    /* ---- property ---- */
    "เพิงพักริมทาง": "Roadside Shack", "กระท่อมชายป่า": "Woodland Hut",
    "ห้องเช่าซอยตลาด": "Market Lane Room", "บ้านไม้ชานเมือง": "Suburban Timber House",
    "บ้านสวนหลังเล็ก": "Small Garden House", "บ้านไม้ในเมือง": "Town Timber House",
    "ห้องแถวท้ายตลาด": "Shophouse by the Market", "อพาร์ตเมนต์ซอยเงียบ": "Quiet Lane Apartment",
    "บ้านหินสองชั้น": "Two-storey Stone House", "เรือนแพริมคลอง": "Canal Houseboat",
    "โฮสเทลนักเดินทาง": "Traveller's Hostel", "ตึกแถวสองคูหา": "Two-unit Terrace",
    "บ้านกลางไร่องุ่น": "Vineyard House", "เรือนไม้สักโบราณ": "Old Teak House",
    "เรือนกระจกดอกไม้": "Flower Glasshouse", "โกดังริมท่าเรือ": "Dockside Warehouse",
    "โรงแรมจันทราเล็ก": "Little Moon Inn", "หมู่บ้านให้เช่า": "Rental Village",
    "ตลาดนัดมีหลังคา": "Covered Market", "คฤหาสน์ริมทะเลสาบ": "Lakeside Manor",
    "บ้านหอคอยนักเวท": "Mage's Tower House", "วิลล่าริมผา": "Clifftop Villa",
    "ท่าเรือส่วนตัว": "Private Harbour", "ตึกออฟฟิศใจกลางเมือง": "City Centre Offices",
    "โรงแรมริมทะเลสาบ": "Lakeside Hotel", "โรงละครกลางเมือง": "City Theatre",
    "เหมืองคริสตัลเก่า": "Old Crystal Mine", "สวนสนุกริมน้ำ": "Riverside Funfair",
    "หอคอยหอดูดาว": "Observatory Tower", "ปราสาทหินเก่า": "Old Stone Castle",
    "คฤหาสน์สวนดาว": "Star Garden Manor", "เกาะส่วนตัว": "Private Island",
    "ป้อมปราการมังกร": "Dragon Fortress", "วังใต้แสงจันทร์": "Palace Beneath the Moon",
    "สวนลอยเหนือเมฆ": "Garden Above the Clouds", "วิหารดาวตก": "Meteor Temple",
    "เมืองลอยฟ้า": "Floating City", "นครใต้บาดาล": "Undersea City",
    "พระราชวังนิรันดร์": "The Eternal Palace",
    "เตียงไม้สัก": "Teak Bed", "โซฟาหนังนุ่ม": "Soft Leather Sofa",
    "โคมไฟทองเหลือง": "Brass Lamp", "กระจกอัญมณี": "Jewelled Mirror",
    "ครัวพร้อมเสบียง": "Stocked Kitchen", "สวนหน้าบ้าน": "Front Garden",

    /* ---- armour sets ---- */
    "ชุดทองแดงรุ้ง": "Rainbow Copper Set", "ชุดเหล็กเงา": "Sheen Iron Set",
    "ชุดเงินบริสุทธิ์": "Pure Silver Set", "ชุดทองคำเปลว": "Gilded Set",
    "ชุดมิธริล": "Mithril Set", "ชุดอดามันไทต์": "Adamantite Set",
    "ชุดราตรีมืด": "Blacknight Set", "ชุดสุริยะ": "Solar Set",

    /* ---- random events ---- */
    "สายแร่พิเศษ!": "Rich Vein!", "ลมหนุนหลัง": "Wind at Your Back",
    "พ่อค้าเร่ผ่านมา": "A Pedlar Passes", "กรุสมบัติเล็ก ๆ": "A Small Cache",
    "แรงบันดาลใจ": "Inspiration",
    "เจอสายที่อุดมผิดปกติ — 30 วินาทีนี้ได้ของเป็นสองเท่า": "An unusually rich seam — double yield for 30 seconds",
    "จู่ ๆ ทุกอย่างก็คล่องมือ — 30 วินาทีนี้ทำงานเร็วขึ้น 40%": "Everything comes easily — 40% faster for 30 seconds",
    "กางแผงอยู่ 5 นาที — ไปที่ร้านค้า แผงของเขาจะอยู่บนสุด": "Stall up for 5 minutes — find it at the top of the Shop",
    "สะดุดหีบเก่าใต้รากไม้": "You stumble on an old chest under the roots",
    "จับทางได้พอดี — ได้ XP ก้อนโตทันที": "It all clicks — a burst of XP",

    /* ---- business, guild and tax tables ---- */
    "แผงเล็ก": "Small Stall", "ร้านกลาง": "Mid-sized Shop", "ห้างใหญ่": "Grand Store",
    "ร้านขายยา": "Apothecary", "ร้านขายเนื้อ": "Butcher", "ร้านตีอาวุธ": "Weaponsmith",
    "พ่อค้า": "Trader", "ช่าง": "Artisan", "การ์ด": "Guard",
    "กิจการเล็ก": "Small Business", "กิจการกลาง": "Mid-sized Business", "บริษัทใหญ่": "Large Company",
    "โรงเรียนล่าเล็ก": "Small Hunting School", "สถาบันประจำเมือง": "Town Institute",
    "สำนักนักล่าใหญ่": "Great Hunters' Hall",
    "ภาษีเงินได้": "Income Tax", "ภาษีทรัพย์สิน": "Wealth Tax", "ภาษีอสังหา": "Property Tax",
    "โจมตี": "Attack", "ป้องกัน": "Defence", "พลังชีวิต": "Vitality",
    "ฝึกกันเอง": "Train each other", "ครูประจำ": "Resident tutor", "ครูจากเมืองหลวง": "Tutor from the capital",
    "ข้าวต้มโรงครัว": "Kitchen porridge", "อาหารครบหมู่": "Balanced meals", "โต๊ะจีนทุกมื้อ": "Banquet every meal",
    "ชุดปฐมพยาบาล": "First-aid kit", "ยาและหมอ": "Medicine and a physician",
    "หมอประจำสถาบัน": "Resident physician",
    "ของมือสอง": "Second-hand gear", "ชุดมาตรฐาน": "Standard gear", "ของสั่งทำ": "Bespoke gear",
    "การฝึก": "Training",
    "ขายน้อย กำไรต่อชิ้นสูง · กินวัตถุดิบหนัก": "Few sales, high margin · hungry for materials",
    "ขายเยอะ กำไรต่อชิ้นน้อย · พีคหน้าฝน": "Many sales, thin margin · peaks in the rains",
    "สมดุล · พีคหน้าหนาว ตกหนักหน้าฝน": "Balanced · peaks in winter, slumps in the rains",
    "ซื้อขาดหลักพัน–หมื่น · ปันผลสูง แต่ราคาเหวี่ยงแรง": "Thousands to buy outright · high dividends, volatile price",
    "ซื้อขาดหลักหมื่น–แสน · สมดุลระหว่างปันผลกับความนิ่ง": "Tens of thousands · balanced dividends and steadiness",
    "ซื้อขาดหลักแสนขึ้นไป · ปันผลต่ำแต่ราคานิ่ง ทนทาน": "Hundreds of thousands · low dividends, steady and durable",

    /* ---- companies you can buy shares in ----
     * Flavour, and a lot of it. Kept as plain descriptive names rather than invented brand words:
     * the list is read as a market, and a market reads better when you can tell at a glance what
     * each line actually does. */
    "แผงขนมปังป้าหอม": "Auntie Hom's Bread Stall", "แผงผลไม้ตลาดเช้า": "Morning Market Fruit Stall",
    "แผงปลาย่างริมคลอง": "Canalside Grilled Fish Stall", "แผงดอกไม้จันทรา": "Moon Flower Stall",
    "แผงของเล่นไม้": "Wooden Toy Stall", "แผงน้ำผึ้งป่า": "Wild Honey Stall",
    "แผงเครื่องเทศ": "Spice Stall", "แผงเครื่องเทศตะวันออก": "Eastern Spice Stall",
    "แผงผลไม้ดองยาย": "Granny's Pickled Fruit Stall", "แผงยาสมุนไพรตายาย": "Grandparents' Herbal Stall",
    "แผงหมึกและปากกา": "Ink and Quill Stall", "แผงปิ้งย่างหน้าตลาด": "Market-front Grill",
    "แผงปลาแห้งท่าเรือ": "Harbour Dried Fish Stall", "แผงขนมหวานจันทรา": "Moon Sweets Stall",
    "แผงไข่ฟาร์มเนินลม": "Windy Hill Egg Stall",
    "ร้านกาแฟรากไม้": "Rootwood Coffee House", "ร้านชาใบหอม": "Fragrant Leaf Teahouse",
    "ร้านชาใบหมอก": "Misted Leaf Teahouse", "ร้านซักผ้าลำธาร": "Streamside Laundry",
    "ร้านซักรีดริมซอย": "Lane Laundry", "ร้านซ่อมนาฬิกา": "Clock Repair Shop",
    "ร้านซ่อมรองเท้าเดินทาง": "Traveller's Cobbler", "ร้านซ่อมร่มเก่า": "Old Umbrella Repairs",
    "ร้านซ่อมร่มและเต็นท์": "Umbrella and Tent Repairs", "ร้านซ่อมเกราะข้างตลาด": "Market Armour Repairs",
    "ร้านตัดผมช่างเล่า": "The Talkative Barber", "ร้านตัดผมซอยใน": "Backstreet Barber",
    "ร้านตุ๊กตาไม้": "Wooden Doll Shop", "ร้านทำกุญแจ": "Locksmith",
    "ร้านนาฬิกาทราย": "Hourglass Shop", "ร้านหนังสือมือสอง": "Second-hand Bookshop",
    "ร้านเชือกและตาข่าย": "Rope and Net Shop", "ร้านเช่าจักรยาน": "Bicycle Hire",
    "ร้านเช่าเรือพาย": "Rowboat Hire", "ร้านเย็บผ้าซอยกลาง": "Middle Lane Tailor",
    "ร้านขายเทียนหอม": "Scented Candle Shop", "คอกม้าเช่าเร็ว": "Quick Horse Hire",
    "เตาถ่านตาเจียม": "Uncle Chiam's Charcoal Kiln",
    "โรงสีข้าวเล็ก": "Small Rice Mill", "โรงสีข้าวเนินลม": "Windy Hill Rice Mill",
    "โรงทำสบู่ดอกไม้": "Flower Soap Works", "โรงต้มสบู่ดอกไม้": "Flower Soap Boilery",
    "โรงทำเชือกป่าน": "Hemp Rope Works", "โรงเชือกเรือ": "Ship Rope Works",
    "โรงงานเชือกเรือ": "Ship Rope Factory", "โรงทำแก้วเป่า": "Glassblowing Works",
    "โรงงานแก้วเป่า": "Glassblowing Factory", "โรงย้อมผ้าคราม": "Indigo Dyeworks",
    "โรงย้อมผ้าสีคราม": "Indigo Dye House", "โรงฟอกหนังริมน้ำ": "Riverside Tannery",
    "โรงงานเครื่องหนัง": "Leather Goods Factory", "โรงงานเครื่องปั้นดินเผา": "Pottery Works",
    "โรงงานกระเบื้องเคลือบ": "Glazed Tile Factory", "โรงงานกระดาษเปลือกไม้": "Bark Paper Mill",
    "โรงงานเครื่องครัว": "Kitchenware Factory", "โรงงานเครื่องดนตรี": "Instrument Workshop",
    "โรงหล่อระฆัง": "Bell Foundry", "โรงหล่อเทียนเวท": "Arcane Candle Foundry",
    "โรงอบชาสูง": "High Tea Roastery", "โรงเบียร์ข้าวบาร์เลย์": "Barley Brewery",
    "โรงเบียร์ราชาแคระ": "Dwarf King Brewery", "โรงเตี๊ยมหมาป่าหลับ": "The Sleeping Wolf Inn",
    "โรงเผาถ่านชายป่า": "Woodland Charcoal Kiln", "โรงเลื่อยไม้สัก": "Teak Sawmill",
    "โรงเลื่อยไม้วิญญาณ": "Spirit Wood Sawmill", "โรงเพาะเห็ดใต้ดิน": "Underground Mushroom Farm",
    "โรงเพาะปลาคาร์ป": "Carp Hatchery", "โรงเพาะพันธุ์ม้าศึก": "Warhorse Stud",
    "โรงเลี้ยงผึ้งจันทรา": "Moon Apiary", "โรงเรียนดาบประจำเมือง": "Town Sword School",
    "โรงพิมพ์หนังสือเวท": "Arcane Book Press", "โรงกลั่นน้ำหอม": "Perfume Distillery",
    "โรงกลั่นน้ำหอมดาว": "Star Perfume Distillery", "โรงถลุงเหล็กภูเขาไฟ": "Volcano Ironworks",
    "ฟาร์มผึ้งหลวง": "Royal Bee Farm", "ฟาร์มม้าแข่ง": "Racehorse Farm",
    "ฟาร์มไหมจันทรา": "Moon Silk Farm", "ฟาร์มไหมป่าเหนือ": "Northern Wild Silk Farm",
    "สวนองุ่นไวน์เนินใต้": "South Hill Vineyard", "เหมืองเกลือหุบเขา": "Valley Salt Mine",
    "เหมืองหินอ่อนเนินเงา": "Shadow Hill Marble Quarry", "อู่ซ่อมเกวียนใหญ่": "Great Wagon Yard",
    "อู่ต่อเรือท่าน้ำลึก": "Deepwater Shipyard", "หอคอยเวทวิทยาคม": "Arcane Academy Tower",
    "สำนักพิมพ์ข่าวเมือง": "City News Press", "สำนักรับจ้างคุ้มกัน": "Escort Company",
    "สำนักส่งสารนกเวท": "Arcane Bird Post", "สำนักแปลภาษาโบราณ": "Ancient Language Bureau",
    "สำนักโหราจารย์": "Astrologers' Office", "สมาคมพ่อค้าทางไกล": "Long-distance Traders' Guild",
    "สมาคมธนาคารชายแดน": "Frontier Banking Association", "กิลด์นักล่ามังกร": "Dragon Hunters' Guild",
    "คณะนักดนตรีราชสำนัก": "Royal Court Musicians", "คณะละครเร่แสงจันทร์": "Moonlight Travelling Players",
    "ตลาดนัดข้ามมิติ": "Cross-dimensional Market", "บริษัทบาดาลหมู่บ้าน": "Village Well Company",
    "บริษัทประปาเมืองบน": "Upper City Waterworks", "บริษัทไฟฟ้าคริสตัล": "Crystal Power Company",
    "บริษัทโทรเลขนกพิราบ": "Pigeon Telegraph Company", "บริษัทรับจ้างขนของ": "Hauling Company",
    "บริษัทขนส่งเกวียนไว": "Swift Wagon Freight", "บริษัทรับเหมาถนน": "Road Contractors",
    "บริษัทรับเหมาขุดคลอง": "Canal Contractors", "บริษัทก่อสร้างปราสาท": "Castle Builders",
    "บริษัทจัดสวนหลวง": "Royal Landscapers", "บริษัทเดินเรือค้าขาย": "Merchant Shipping Company",
    "บริษัทเดินเรือมหาสมุทร": "Ocean Shipping Company", "บริษัทท่าเรือน้ำลึกเหนือ": "Northern Deepwater Port",
    "บริษัทเดินอากาศ": "Airways Company", "บริษัทรถไฟไอน้ำ": "Steam Railway Company",
    "บริษัทรถไฟข้ามทวีป": "Transcontinental Railway", "บริษัทเหมืองหินอ่อน": "Marble Quarry Company",
    "บริษัทเหมืองมิธริล": "Mithril Mining Company", "บริษัทผลิตเกราะมาตรฐาน": "Standard Armour Works",
    "บริษัทประกันคาราวาน": "Caravan Insurance", "บริษัทประกันภัยนักผจญภัย": "Adventurers' Insurance",
    "บริษัทประกันชีวิตหลวง": "Royal Life Assurance", "บริษัทวิจัยยาอายุวัฒนะ": "Longevity Research Company",
    "บรรษัทเดินรถม้าด่วน": "Express Coach Corporation", "บรรษัทต่อเรือเหล็ก": "Ironclad Shipbuilders",
    "บรรษัทต่อเรือรบหลวง": "Royal Naval Shipbuilders", "บรรษัทขนส่งทางอากาศ": "Air Freight Corporation",
    "บรรษัทคลังสินค้าข้ามมิติ": "Cross-dimensional Warehousing",
    "บรรษัทสื่อสารคริสตัล": "Crystal Communications", "บรรษัทสื่อสารข้ามมิติ": "Cross-dimensional Communications",
    "บรรษัทพลังงานลม": "Wind Power Corporation", "บรรษัทพลังงานแกนดาว": "Stellar Core Power",
    "บรรษัทวิจัยธาตุหายาก": "Rare Element Research", "บรรษัทอาวุธหลวง": "Royal Armaments",
    "บรรษัทเหมืองถ่านหินลึก": "Deep Coal Mining Corporation",
    "บรรษัทเหมืองลึกใต้พิภพ": "Deep Underworld Mining", "ธนาคารพาณิชย์มิธวูด": "Mythwood Commercial Bank",
    "ธนาคารมิธวูดกลาง": "Central Bank of Mythwood",
    "กลุ่มห้างสรรพสินค้า": "Department Store Group", "กลุ่มโรงแรมเมืองหลวง": "Capital Hotels Group",
    "กลุ่มโรงแรมข้ามทวีป": "Transcontinental Hotels Group",
    "กลุ่มสถานพยาบาลชายแดน": "Frontier Clinics Group", "กลุ่มโรงพยาบาลเวทมนตร์": "Arcane Hospitals Group",
    "กลุ่มมหาวิทยาลัยเวท": "Arcane Universities Group", "กลุ่มเหมืองทองคำเหนือ": "Northern Gold Mines Group",
    "กลุ่มพลังงานลมเหนือเมฆ": "Above-the-Clouds Wind Power Group",
    "กองทุนที่ดินหลวง": "Royal Land Fund", "กองทุนป่าไม้แห่งชาติ": "National Forest Fund",
    "กองทุนอสังหาเมืองจันทรา": "Moon City Property Fund", "กองทุนเกษตรที่ราบใหญ่": "Great Plains Agriculture Fund",
    "กองทุนเหมืองอัญมณี": "Gem Mining Fund", "กองทุนแร่หายากใต้ทะเล": "Undersea Rare Mineral Fund",
    "กองทุนโครงสร้างท่าเรือ": "Port Infrastructure Fund",
    "กองทุนโครงสร้างพื้นฐานเมือง": "Urban Infrastructure Fund",
    "กองทุนศิลปะและสมบัติ": "Art and Treasures Fund",
    "กองทุนความมั่งคั่งแห่งชาติ": "National Wealth Fund",

    /* ---- flavour: the line under each place's name ----
     * These carry the tone of the game more than anything else in the tables, so they are written
     * rather than converted — the English says what the Thai says, in the voice the Thai uses. */
    "ป่ามายาที่ต้นไม้เรืองแสงยามค่ำ": "An enchanted wood where the trees glow after dark",
    "เตาเผาดินโบราณ — ไม้กลายเป็นถ่านที่เตาหลอมและครัวต้องการ":
      "An ancient clay kiln — wood becomes the charcoal the forge and the kitchen live on",
    "จากลำธารหมู่บ้านสู่เหวลึกพราวดาว — ยิ่งชำนาญ ยิ่งได้ปลาแพงและของดี":
      "From the village stream to the starlit abyss — the better you get, the richer the catch",
    "เหมืองผลึกที่ก้องเสียงสะท้อนจากใต้พิภพ — ไล่สายแร่จากผาตื้นสู่ใจพิภพ":
      "A crystal mine echoing from below — follow the veins from the shallow cliffs to the world's heart",
    "เตาไฟที่ไม่เคยดับ กลิ่นหอมข้ามมิติ — อาหารคือยาเลือดของนักล่า":
      "A fire that never goes out, a scent that crosses worlds — food is a hunter's medicine",
    "โรงฟอกหนังหอมกลิ่นเครื่องเทศ — หนังจากสนามล่ากลายเป็นชุดเบาคล่องตัว":
      "A tannery thick with spice — hides from the hunt become light, quick armour",
    "แปลงดินใต้แสงจันทร์ — ปลูกทิ้งไว้ แล้วกลับมาเก็บทีเดียวทั้งสวน":
      "Beds under the moon — plant them, walk away, come back and harvest the lot",
    "ย่องเบาในตลาดเมืองจันทรา — มือไวได้ทอง มือพลาดได้แผล":
      "Light feet in the Moon City market — quick hands take gold, slow hands take a wound",
    "โรงตีเหล็กที่เปลวไฟร้องเพลง — ไล่บันไดแร่ทีละขั้น ครบชุดเมื่อไรได้โบนัสเซ็ต":
      "A forge where the flames sing — climb the ore ladder a rung at a time, and a full set pays a bonus",
    "ทุ่งกว้างใต้แสงจันทร์ ที่สัตว์วิเศษตัวเล็กออกหากิน":
      "Open fields under the moon, where small magical creatures come out to feed",
    "ป่าที่แสงแดดส่องไม่ถึง เสียงกระซิบมาจากทุกทิศ":
      "A forest the sun never reaches, whispering from every direction",
    "ลมหายใจเย็นเฉียบของสิ่งโบราณ ก้องอยู่ในผลึกน้ำแข็ง":
      "The cold breath of something ancient, ringing in the ice",
    "ปล่องลาวาที่หายใจเป็นไฟ — บ้านของสิ่งที่เกิดจากเปลวเพลิง":
      "A lava vent breathing fire — home to things born of flame",
    "สุสานที่เวลาไหลกลับ — ทุกสิ่งที่ตายแล้วยังเดินอยู่ที่นี่":
      "A tomb where time runs backwards — everything that died here is still walking",
    "ซากปราสาทโบราณที่ลอยเหนือเมฆ — ที่สุดของนักล่าแห่งมิธวูด":
      "An ancient castle adrift above the clouds — the summit of Mythwood's hunters",
    "รอยร้าวบนผืนฟ้าที่สิ่งไร้ชื่อมุดออกมา — ปลายทางของนักล่าแห่งมิธวูด":
      "A crack in the sky where nameless things crawl through — the end of a hunter's road",
    "ซากดาวที่ดับไปแล้วแต่ยังหายใจ — ไม่มีใครเคยกลับมาเล่าว่าก้นเหวมีอะไร":
      "A dead star that still breathes — nobody has come back to say what lies at the bottom",
    "ที่ที่ดาวดวงใหม่กำลังก่อตัว — แสงแรกยังไม่ทันส่อง ก็มีบางอย่างเฝ้ามันอยู่ก่อนแล้ว":
      "Where a new star is forming — before its first light, something was already watching it",
    "เหวมังกรหลับ": "Sleeping Dragon Chasm",
    "ปลา": "Fish", "ไม่มี": "None",

    /* ---- skill-page zone tabs (`area` in data.js) ----
     * 🐛 [audit-qa 2026-08-22] These render through T() at the tab, NOT through the in-place walk:
     * `area` is also the key that decides which cards a page shows (openArea, action.area === shown,
     * data-area on the button), so translating the value would break the lookup. ป่าชายเมือง and
     * ป่าชั้นใน were already sitting in the chrome block below and could never fire, because the tab
     * printed the raw string. Every one of the 42 is listed, and smoke_render pins that. */
    "ป่าชายเมือง": "Town Edge Wood", "ป่าชั้นใน": "Inner Forest",
    "เตาดินโบราณ": "Ancient Clay Kiln", "เตาวิญญาณ": "Spirit Kiln",
    "ลำธารหมู่บ้าน": "Village Brook", "ทะเลสาบแสงจันทร์": "Moonlight Lake",
    "ทะเลลึกพราวดาว": "Starlit Deep", "ตำนานใต้สมุทร": "Legends Beneath the Sea",
    "เหมืองปากผา": "Cliffmouth Mine", "เหมืองชั้นกลาง": "Middle Seam",
    "เหมืองใจพิภพ": "Earthheart Mine",
    "เตาแคมป์": "Camp Stove", "เมนูบ้าน ๆ": "Home Cooking", "เมนูทะเลลึก": "Deep-Sea Menu",
    "ครัวหลวง": "Royal Kitchen",
    "โรงฟอกหนัง": "Tannery", "ช่างหลวง": "Royal Workshop", "งานขาย": "Goods for Sale",
    "แปลงหลังบ้าน": "Back Garden", "สวนผลไม้จันทรา": "Moonfruit Orchard",
    "เรือนกระจกดาว": "Star Greenhouse", "ตลาดเมืองจันทรา": "Moon City Market",
    "บุกรังมอนสเตอร์": "Monster Dens", "หอคอยจอมเวท": "Sorcerer’s Tower",
    "ท่าเรือและกองคาราวาน": "Docks and Caravans", "เขตพระราชวัง": "Palace Quarter",
    "สุสานและซากปรักหักพัง": "Tombs and Ruins",
    "งานฝึกหัด": "Apprentice Work", "สายทองแดงรุ้ง": "Rainbow Copper Line",
    "สายเหล็กเงา": "Sheen Iron Line", "สายเงินบริสุทธิ์": "Pure Silver Line",
    "สายทองคำเปลว": "Gilded Gold Line", "สายมิธริล": "Mithril Line",
    "สายอดามันไทต์": "Adamantite Line", "สายราตรีมืด": "Blacknight Line",
    "สายสุริยะ": "Solar Line", "งานอัญมณี": "Gemwork", "งานตำนาน": "Legendary Work",
    "งานเครื่องประดับ": "Jewellery", "งานราชวงศ์": "Royal Regalia",
    "งานดาราจักร": "Galactic Work",

    /* ---- interface chrome ----
     * Wrapped by hand at each site in game.js, because these are fragments inside template
     * literals with values interpolated between them — the in-place table walk cannot reach them. */
    "เลเวล": "Level", "ขั้น": "Tier", "ต่อรอบ": "per cycle", "เร็วขึ้น": "faster",
    "ของดี": "rare finds", "ขยะ": "junk", "ฝึก": "training", "รอเก็บเกี่ยว": "ready to harvest",
    "ช่องงาน": "Job slots", "ช่องงานเต็ม": "All job slots are full",
    "หยุดงานใดงานหนึ่งก่อน": "stop one first", "หยุด": "Stop",
    "ความชำนาญรวมของสายนี้": "Total mastery in this skill",
    "ขั้นรวม": "Total tiers", "ช่องที่ MAX แล้ว": "maxed",
    "ปลดแล้ว": "unlocked", "พ่อค้าเร่!": "Pedlar!", "เหลือ": "left",
    "อัปเกรดเครื่องมือ": "Upgrade your tools",
    "ส่งงานได้": "ready to hand in", "งานบนกระดาน": "jobs on the board",
    "ส่งได้เลย": "ready now", "คนในหมู่บ้าน": "Villagers",
    "เรากับสัตว์เลี้ยง": "You and your companions", "ยังมีแค่เรา": "Just you so far",
    "สัตว์เลี้ยง": "Companions", "โบนัสจากลูก": "From the children",
    "ยังไม่ได้สร้าง": "Not founded yet", "ออกล่า": "out hunting", "คน": "members",
    "ยังไม่ได้เปิดร้าน": "No shop opened yet", "ร้าน": "shops",
    "ค้างภาษี!": "Tax overdue!", "ทรัพย์สิน": "Assets", "ถูกยึด": "Seized",
    "ค้าง": "Owed", "ปีนี้": "This year", "ไม่มีค้างชำระ": "Nothing owed",
    "จุติแล้ว": "Reborn", "ครั้ง": "times", "พร้อมจุติแล้ว": "Ready to be reborn",
    "ต้องเลเวลรวม": "Needs total level", "เล่นต่อ": "Resume", "พัก": "Pause",
    /* 🐛 [owner 2026-08-22] The settings dialog was the one screen that stayed Thai after a switch,
       and it is the screen the player is looking at WHEN they switch — so an instant, working change
       read as a button that did nothing. Everything visible in that dialog belongs here. */
    /* The notification list inside the settings dialog — NOTIF_KINDS is walked by i18n, but
       nothing here matched it, so the panel stayed Thai in English mode. */
    "ล้มมอนสเตอร์และของที่ดรอป":
      "Kills and drops",
    "ทุกตัวที่ล้มได้ — ตัวที่ขึ้นถี่ที่สุด (บอสยังขึ้นเสมอ)":
      "Every monster you fell — the noisiest of these (bosses always show)",
    "ของและ XP จากงาน":
      "Job yields and XP",
    "ตัดไม้ ขุด ตกปลา ปลูกผัก คราฟต์ และย่องเก็บของ":
      "Woodcutting, mining, fishing, farming, crafting and thieving",
    "เลเวลอัพ / ขั้นชำนาญ":
      "Levels and mastery",
    "เลเวลสายอาชีพ สเตตัสการล่า และขั้นชำนาญ":
      "Skill levels, combat stats and mastery ranks",
    "ปันผลและการซื้อขาย":
      "Dividends and trading",
    "ปันผลรายวัน ดอกเบี้ย ซื้อ-ขายหุ้นและของ":
      "Daily dividends, interest, buying and selling",
    "รายละเอียดการต่อสู้":
      "Combat detail",
    "กินอัตโนมัติ เกราะแตก โหมดคลั่ง สัตว์เลี้ยงหมดแรง":
      "Auto-eating, broken armour, frenzy, a companion going down",
    "พ่อค้าเร่":
      "The pedlar",
    "ตอนมาตั้งแผง ตอนเก็บแผง และตอนซื้อของจากแผง":
      "When the stall opens, when it packs up, and what you buy from it",
    "ทีมกลับถึงสถาบัน รับของอัตโนมัติ บาดเจ็บ และรับเด็กเข้าสังกัด":
      "Squads returning, auto-collected loot, injuries, and new recruits",
    "ลูกเกิด ลูกโตพอออกผจญภัย การเรียน และค่าเลี้ยงดูรายวัน":
      "Births, a child coming of age, their schooling, and the daily upkeep",
    "งานจากลานหมู่บ้าน":
      "Village jobs",
    "ตอนส่งงานสำเร็จและได้ค่าจ้าง":
      "Handing a job in and being paid for it",
    "แจ้งว่าเซฟแล้ว":
      "Save confirmations",
    "เซฟอัตโนมัติทุก 10 นาที (เซฟไม่สำเร็จจะเตือนเสมอ)":
      "Auto-saves every 10 minutes (a failed save always warns)",
    /* The keep-awake block: its status text is built in JS, so it needs entries of its own. */
    "เกม idle มีจังหวะที่นั่งดูเฉย ๆ มือถือจะได้ไม่ล็อกจอ — ปล่อยเองเมื่อสลับแอปหรือกดพัก":
      "An idle game has long stretches you just watch, so the phone should not lock. Released on its own when you switch apps or pause.",
    "(ใช้วิธีเล่นวิดีโอเงียบ เพราะหน้านี้เป็น http)":
      "(using the silent-video fallback, because this page is http)",
    "สถานะตอนนี้":
      "Right now",
    "กำลังทำงาน (Wake Lock API)":
      "Working (Wake Lock API)",
    "ยังไม่ได้จับ — จะจับเมื่อกลับมาดูหน้าจอ":
      "Not held yet — it takes hold when you come back to the screen",
    "ไม่มีวิธีสำรองในหน้านี้":
      "No fallback available on this page",
    "กำลังทำงาน (วิดีโอเงียบ)":
      "Working (silent video)",
    "วิดีโอเล่นแบบ mute — Android มักไม่ยอมกันจอดับให้ ต้องใช้ https":
      "The video is muted — Android usually ignores a muted clip, so this needs https",
    "วิดีโอถูกปฏิเสธ":
      "Video refused",
    "แตะหน้าจอหนึ่งครั้งแล้วเปิดดูใหม่":
      "tap the screen once, then reopen this",
    "ยังไม่เริ่ม — แตะหน้าจอหนึ่งครั้ง":
      "Not started — tap the screen once",
    "แต่งงานแล้ว": "Married", "พร้อมแต่งงาน": "Ready to marry",
    "โบนัสเต็ม · ขอแต่งงานได้": "Full bonus · you may propose",
    "คู่ชีวิตของคุณ": "Your spouse",
    "สนิทที่สุดแล้ว — ขอแต่งงานได้": "As close as it gets — you may propose",
    "ไล่ออกจากตระกูล": "Disown",
    "⚙️ ตั้งค่า": "⚙️ Settings",
    "ภาษา / Language": "Language / ภาษา",
    "🇹🇭 ไทย": "🇹🇭 Thai",
    "ยังแปลไม่ครบทุกคำ — คำที่ยังไม่ได้แปลจะแสดงเป็นภาษาไทยไว้ก่อน / Not everything is translated yet; untranslated text stays in Thai.":
      "Not everything is translated yet — anything untranslated stays in Thai rather than breaking.",
    "การแจ้งเตือน": "Notifications",
    "เลือกว่าจะให้อะไรเด้งขึ้นมาบ้าง — คำเตือน ความพ่ายแพ้ และข้อความที่ตอบสิ่งที่คุณเพิ่งกด จะแสดงเสมอ ปิดไม่ได้":
      "Choose what pops up. Warnings, defeats, and replies to something you just pressed always show and cannot be switched off.",
    "🔔 เสียงประกอบ": "🔔 Sound effects",
    "🎵 เพลงประกอบ": "🎵 Music",
    "ทำนองช้า ๆ วนไปเรื่อย ๆ — ปิดไว้เป็นค่าเริ่มต้น": "A slow looping theme — off by default",
    "📱 กันจอดับตอนดูเกม": "📱 Keep the screen awake",
    "ค่าเลี้ยงดู": "Upkeep", "วัน": "day",
    "กระเป๋าเก็บของ": "Inventory",
    "เวลาในเกมหยุดอยู่ — งาน แปลงปลูก ปฏิทิน และการต่อสู้หยุดหมด":
      "Game time is stopped — jobs, crops, the calendar and combat are all paused",
    "หยุดเวลาในเกมชั่วคราว (งาน แปลงปลูก ปฏิทิน การต่อสู้)":
      "Pause game time (jobs, crops, calendar, combat)",
    "ตั้งค่า — เสียง เพลง และการแจ้งเตือน": "Settings — sound, music and notifications",
    "ออกจากโหมดเต็มจอ": "Leave fullscreen", "ขยายเต็มจอ": "Go fullscreen",
    "ทุกอย่างที่ทำมาตั้งแต่เริ่มโปรไฟล์นี้": "Everything this profile has done",
    "ทุกอันที่ปลดได้ให้โบนัสถาวรกับทั้งโปรไฟล์": "Each one unlocked is a permanent bonus for the whole profile",
    "บ้านของเรา — คู่ชีวิต ลูก และเพื่อนร่วมทาง": "Your household — partner, children and companions",
    "รับงานจากคนในหมู่บ้าน — มีของอยู่แล้วก็ส่งได้ทันที":
      "Take work from the villagers — hand it in on the spot if you already have the goods",
    "ให้ของขวัญเพื่อสนิทขึ้น — แต่ละคนหนุนคนละอย่าง":
      "Give gifts to grow closer — each of them helps with something different",

    "เซฟตอนนี้": "Save now", "ออกไปหน้าโปรไฟล์": "Back to profiles",
    "ได้": "got", "เซฟล่าสุด": "Last saved",
    "รับปันผล": "Dividends", "จาก": "from", "การลงทุน": "investments",
    "ปันผล": "Dividends", "กิจการ": "companies",

    /* ---- panel labels ----
     * Wrapped by a rule rather than by hand: Thai text sitting cleanly between two HTML tags is a
     * label, so >ทองในมือ< became >${T("ทองในมือ")}<. Anything with a value interpolated into it was
     * left alone, which is why some sentences here are short and others are whole. */
    "ทองในมือ": "Gold in hand", "ฝากธนาคาร": "In the bank", "เงินฝากในธนาคาร": "Bank deposits",
    "มูลค่าหุ้นที่ถือ": "Value of shares held", "ปันผลรอบหน้าของคุณ": "Your next dividend",
    "ราคาตอนนี้": "Price now", "ราคายุติธรรม": "Fair value", "ผลตอบแทนต่อทุน": "Return on capital",
    "ความเหวี่ยงต่อวัน": "Daily volatility", "ถือ ": "Held ", "ปันผล ": "Dividend ",
    "จ่ายทุก ": "Pays every ", "หุ้นทุกตัว": "All shares", "ซื้อเท่าที่ไหว": "Buy what you can afford",
    "ยืนยันขาย": "Confirm sale", "ขายทั้งหมด": "Sell all", "ฝาก": "Deposit", "ถอน": "Withdraw",
    "ฝากทั้งหมด": "Deposit all", "ฝากครึ่งหนึ่ง": "Deposit half", "ถอนทั้งหมด": "Withdraw all",
    "ฝากแต่ละครั้งเป็นใบของตัวเอง": "Each deposit is its own certificate",
    "ต้องขายแล้วเอาไปฝากก่อน": "Sell it and deposit the proceeds first",
    "น้อยกว่าปันผลหุ้น": "Less than share dividends",
    "กำไรเฉลี่ย/วันในเกม": "Average profit per in-game day",

    "ภาษีที่ต้องจ่ายถ้าจบปีนี้": "Tax due if the year ended today",
    "ปีนี้สะสมถึงวันนี้": "Accrued so far this year", "ค้างชำระ (ปีก่อน)": "Overdue (previous years)",
    "ค้างมาแล้ว": "Overdue for", "จ่ายภาษีสะสมทั้งชีวิต": "Tax paid over this lifetime",
    "ชำระใบนี้": "Pay this bill", "จ่ายส่วนนี้": "Pay this part", "ช่วง": "Band", "อัตรา": "Rate",
    "ยกเว้น": "Exempt", "สถานะ": "Status",
    "หักจากทองในมือก่อน แล้วจึงดึงจากเงินฝาก (ใบใหม่สุดก่อน)":
      "Taken from gold in hand first, then from deposits (newest certificate first)",

    "สถาบัน": "Institute", "คนในสังกัด": "Members", "ค่าเลี้ยง/วันในเกม": "Upkeep per in-game day",
    "รอรับ": "Waiting to collect", "รับของและเงิน": "Collect goods and gold", "รับของ": "Collect",
    "รับกี่คน": "How many to take", "สร้างสถาบัน": "Found the institute", "อัปเกรด": "Upgrade",
    "ชื่อเสียง": "Reputation", "สถาบันฮันเตอร์คืออะไร": "What is the Hunters' Institute?",
    "เลี้ยงเด็กเอง ฝึกเอง ส่งออกล่าเอง — ขาดทุนช่วงแรก คืนทุนในระยะยาว":
      "Feed them, train them, send them hunting — a loss at first, and it pays back in time",
    "อยากเป็นฮันเตอร์ ยังไม่เคยออกสนามจริง": "Wants to be a hunter, has never been in the field",
    "แต่ช่วงแรกขาดทุนแน่นอน": "It will lose money at first, without question",
    "ไม่กินช่องงาน": "Does not use a job slot",

    "ค่าเช่า/วันในเกม": "Rent per in-game day", "ค่าเช่าสะสม": "Rent collected",
    "ทุนที่จมอยู่ (ขายคืนได้เต็ม)": "Capital tied up (fully refundable)",
    "บ้านที่ถือ": "Properties held", "ที่อยู่อื่น": "Other properties", "เฟอร์นิเจอร์": "Furniture",
    "ค่าจ้างรวม/วัน": "Total wages per day", "ลูกค้าประจำ": "Regulars", "พนักงาน": "Staff",
    "วัตถุดิบ / สินค้า": "Materials / goods", "หักจากส่วนของคุณ": "Taken from your share",
    "ขาดทุนได้จริง": "It really can lose money", "ไม่ต้องลุ้น": "No gamble involved",

    "จุติมาแล้ว": "Reborn", "จุติตอนนี้จะได้บุญ": "Rebirth now would grant karma",
    "เลเวลรวมตอนนี้": "Total level now", "เลเวลรวมตอนที่จุติ": "Total level at rebirth",
    "เริ่มการผจญภัยใหม่": "Begin a new adventure",
    "ไม่เหมือนการจุติ ตรงที่ไม่มีอะไรถูกเก็บไว้เลย": "Unlike rebirth, nothing at all is carried over",

    "สายพันธุ์ที่เคยเจอ (เก็บไว้)": "Species encountered (kept)",
    "จับสัตว์เลี้ยงได้จากการล่ามอนสเตอร์": "Companions are caught while hunting",
    "ยังไม่มีเพื่อนร่วมทาง": "No companion yet", "ยังไม่มีคู่ชีวิต": "No partner yet",
    "ไปสนิทกับใครสักคนที่ลานหมู่บ้านก่อน": "Grow closer to someone in the village square first",
    "ไม่มีของที่ส่งได้": "Nothing you can hand in",

    "สร้างโปรไฟล์": "Create profile", "ลบโปรไฟล์": "Delete profile", "เล่นต่อ ": "Continue ",
    "อ่านเซฟช่องนี้ไม่ได้": "This slot could not be read", "ลองอ่านใหม่": "Try again",
    "ข้อมูลยังอยู่ครบ ไม่ได้ถูกลบ": "The data is still there; nothing has been deleted",
    "จะนำเข้าด้วยปุ่มก็ได้ หรือก๊อปไฟล์ไปวางเป็น ": "Import it with the button, or copy the file in as ",
    "ความซื่อสัตย์คือค่าที่คุ้มที่สุดที่จะรู้": "Being told the truth is worth more than a tidy screen",

    "การแจ้งเตือน": "Notifications", "เสียงและหน้าจอ": "Sound and screen",
    "เสียงสั้น ๆ ตอนได้ของ เลเวลอัพ เก็บเกี่ยว หรือมีคำเตือน":
      "Short sounds when you gain something, level up, harvest, or are warned",
    "เปิดทั้งหมด": "Turn all on", "ปิดทั้งหมด": "Turn all off", "ลบหมวดนี้": "Clear this category",
    "เข้าใจแล้ว": "Got it", "เสร็จ": "Done", "ปิด": "Close", "ยกเลิก": "Cancel",
    "ขาย": "Sell", "ว่าง": "Empty",

    /* ---- titles ---- */
    "คนแปลกหน้าจากนอกป่า": "Stranger from Beyond the Wood",
    "ผู้มาใหม่แห่งมิธวูด": "Newcomer of Mythwood",
    "นักเดินทางผู้ช่ำชอง": "Seasoned Traveller",
    "ผู้เป็นที่รู้จักทั้งหุบเขา": "Known Throughout the Valley",
    "ตำนานที่ยังมีลมหายใจ": "A Living Legend",
    "ผู้พิชิตมิธวูด": "Conqueror of Mythwood",
    "ผู้ชำระล้าง": "The Cleanser",
    "มือที่ไม่เคยว่าง": "Never Idle",
    "ผู้กลับมาเสมอ": "Ever Returning",
    "ผู้ที่มอนสเตอร์หวาดกลัว": "The One Monsters Fear",
    "ชื่อที่ถูกเอ่ยด้วยความกลัว": "A Name Spoken in Fear",
  };

  /* Which fields carry text a player reads. Anything else in the tables is a number, an id or an
   * icon, and must not be touched — translating an id would break every lookup that uses it. */
  const TEXT_FIELDS = ["name", "desc", "text", "note", "flavor", "job", "label", "bonus"];

  let lang = "th";
  const originals = new WeakMap();   // object -> { field: thai } for exact restoration

  function t(s) {
    if (lang !== "en" || typeof s !== "string") return s;
    return EN[s] || s;
  }

  /* Walk anything and translate the text fields in place. Depth-limited rather than trusting the
   * shape: these tables nest (locations hold stages hold drops) and a cycle would hang the boot. */
  function walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    let keep = originals.get(node);
    for (const f of TEXT_FIELDS) {
      const v = node[f];
      if (typeof v !== "string") continue;
      if (!keep) { keep = {}; originals.set(node, keep); }
      if (!(f in keep)) keep[f] = v;               // remember the Thai exactly once
      node[f] = lang === "en" ? (EN[keep[f]] || keep[f]) : keep[f];
    }
    for (const k of Object.keys(node)) {
      if (TEXT_FIELDS.includes(k)) continue;
      walk(node[k], depth + 1);
    }
  }

  return {
    get lang() { return lang; },
    t,
    /* Called at boot and whenever the player switches. `tables` is whatever data.js exposes; the
     * caller passes them in so this file has no idea what the game contains. */
    apply(next, tables) {
      lang = next === "en" ? "en" : "th";
      try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* private mode — not fatal */ }
      for (const tbl of tables) walk(tbl);
      return lang;
    },
    saved() {
      try { return localStorage.getItem(STORE_KEY) === "en" ? "en" : "th"; } catch (e) { return "th"; }
    },
    /* How much of the game is actually translated, for the coverage check in the test suite. */
    stats() { return { entries: Object.keys(EN).length }; },
    _EN: EN,
  };
})();
