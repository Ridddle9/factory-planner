/**
 * Generates two synthetic Excel files to test the plan/fact import logic.
 * Uses real product codes that exist in the DB so brigade assignment works correctly.
 *
 * Upload order:
 *   1. node scripts/generate-test-xlsx.mjs
 *   2. Import test-data/day1_upload.xlsx  → seeds orders + plan
 *   3. Import test-data/day2_upload.xlsx  → triggers fact recording
 *   4. Run: node scripts/verify-fact.mjs  → checks DB against expected values
 *
 * Test scenarios:
 *   SC-01  Normal fact: K drops by exactly planned qty              → fact = 50
 *   SC-02  No production: K unchanged                               → no fact
 *   SC-03  Under-production: K drops less than planned              → fact = 50 (not 100)
 *   SC-04  Over-production: K drops more than planned               → fact = 40 (plan was 20)
 *   SC-05  Last-batch completion: K goes to 0 → row skipped by parser → BUG: fact not recorded
 */

import * as XLSX from "xlsx";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "../test-data");
mkdirSync(outDir, { recursive: true });

// ── date helpers ──────────────────────────────────────────────────────────────
function fmt(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

const today = new Date();
today.setHours(0, 0, 0, 0);
const tomorrow = new Date(today);
tomorrow.setDate(today.getDate() + 1);
const dayAfter = new Date(today);
dayAfter.setDate(today.getDate() + 2);
const dayAfter2 = new Date(today);
dayAfter2.setDate(today.getDate() + 3);

const D_TODAY = fmt(today);
const D_TMR = fmt(tomorrow);
const D_D2 = fmt(dayAfter);
const D_D3 = fmt(dayAfter2);

// ── header columns (matches real export format) ───────────────────────────────
const FIXED_HEADERS = [
  "Вид номенклатуры (для расчета графика производства)",
  "Код",
  "Номенклатура",
  "Клиент",
  "Номер",
  "Заказ",
  "График оплаты",
  "Менеджер",
  "Дата заказа",
  "Дата согласования",
  "Остаток на складе",
  "В резерве",
  "К обеспечению",
  "Доступно",
  "В производстве",
];

// ── scenario definitions ──────────────────────────────────────────────────────
// Real product codes from DB — ensures correct brigade assignment and load calculation.
// Categories and brigades:
//   SC-01: РУ000003200  AVRORA-90       → Бригада Аврора №1–4, Бригада №1–3 IP
//   SC-02: ЦБ-00012299  КОРПУСА SLIM    → Бригада упаковки, Бригада №1–3 IP
//   SC-03: ЦБ-00012270  КОРПУСА SLIM    → Бригада упаковки, Бригада №1–3 IP
//   SC-04: ЦБ-00003339  FLORA           → Бригада FLORA, Бригада №1–3 IP, и др.
//   SC-05: ЦБ-00010365  LUM (380 max)   → Бригада №1 IP, Бригада №4 IP, Бригада упаковки
const SCENARIOS = [
  {
    id: "SC-01",
    desc: "Normal fact — K drops by exactly planned qty",
    cat: "СВЕТИЛЬНИКИ AVRORA-90 (IP20 550 max)",
    code: "РУ000003200",
    name: "CSVT AVRORA 32 595x595х25 CRI80 4000 opal-sand IP20 белый армстронг",
    customer: "Тест ООО",
    orderNum: "ТЕ-001",
    day1K: 100,
    day2K: 50,                     // produced 50 yesterday (= planned)
    planDay1: { [D_TODAY]: 50, [D_TMR]: 50 },
    planDay2: { [D_TMR]: 50 },
    expectedFact: 50,
  },
  {
    id: "SC-02",
    desc: "No production — K unchanged",
    cat: "КОРПУСА SLIM (2000 max)",
    code: "ЦБ-00012299",
    name: "Корпус светильника Slim/MILKY (IP65), АЛБ",
    customer: "Тест ООО",
    orderNum: "ТЕ-002",
    day1K: 80,
    day2K: 80,                     // nothing was made
    planDay1: { [D_TODAY]: 40, [D_TMR]: 40 },
    planDay2: { [D_TMR]: 40, [D_D2]: 40 },
    expectedFact: 0,
  },
  {
    id: "SC-03",
    desc: "Under-production — brigade made less than planned",
    cat: "КОРПУСА SLIM (2000 max)",
    code: "ЦБ-00012270",
    name: "Корпус светильника Slim/TRANSPARENT (IP65), ГУЛОВ",
    customer: "Клиент АО",
    orderNum: "ТЕ-003",
    day1K: 200,
    day2K: 150,                    // produced 50, planned 100
    planDay1: { [D_TODAY]: 100, [D_TMR]: 100 },
    planDay2: { [D_TMR]: 100, [D_D2]: 50 },
    expectedFact: 50,
  },
  {
    id: "SC-04",
    desc: "Over-production — brigade made more than planned",
    cat: "СВЕТИЛЬНИКИ FLORA (150 max)",
    code: "ЦБ-00003339",
    name: "CSVT FLORA-50 52 1985х50х70 CRI80 4000 opal-sand IP40 черный",
    customer: "Клиент АО",
    orderNum: "ТЕ-004",
    day1K: 60,
    day2K: 20,                     // produced 40, planned only 20
    planDay1: { [D_TODAY]: 20, [D_TMR]: 20, [D_D2]: 20 },
    planDay2: { [D_TMR]: 20 },
    expectedFact: 40,
  },
  {
    id: "SC-05",
    desc: "⚠ BUG: Last-batch — K goes to 0, row skipped, fact NOT recorded",
    cat: "СВЕТИЛЬНИКИ LUM (380 max)",
    code: "ЦБ-00010365",
    name: "Корпус светильника CSVT ЛПП-АЙСБЕРГ 2хLED T8 1270х152х100 transparent IP65 серый G13 без лампы",
    customer: "Тест ООО",
    orderNum: "ТЕ-005",
    day1K: 20,
    day2K: 0,                      // K=0 → row skipped by import parser!
    planDay1: { [D_TODAY]: 20 },
    planDay2: {},
    expectedFact: 20,              // expected, but WON'T happen due to skip
    bugExpected: true,
  },
];

// ── build worksheet rows ──────────────────────────────────────────────────────
function buildSheet(scenarios, dateCols) {
  const headerRow = [...FIXED_HEADERS, ...dateCols];
  const dataRows = scenarios.map((s) => {
    const plan = s.currentPlan ?? s.planDay1;
    return [
      s.cat,
      s.code,
      s.name,
      s.customer,
      s.orderNum,
      `Заказ клиента ${s.orderNum}`,
      "Предоплата 100%",
      "Тест-менеджер",
      "01.01.2026",
      "05.01.2026",
      0,        // Остаток на складе
      0,        // В резерве
      s.currentK,
      0,        // Доступно
      0,        // В производстве
      ...dateCols.map((d) => plan[d] ?? null),
    ];
  });

  return [headerRow, ...dataRows];
}

// ── write xlsx ────────────────────────────────────────────────────────────────
function writeXlsx(filename, rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Лист_1");
  XLSX.writeFile(wb, filename);
  console.log(`✓ Written: ${filename}`);
}

// ── Day 1 ─────────────────────────────────────────────────────────────────────
const day1Scenarios = SCENARIOS
  .filter((s) => s.day1K > 0)
  .map((s) => ({ ...s, currentK: s.day1K, currentPlan: s.planDay1 }));

const day1DateCols = [D_TODAY, D_TMR, D_D2];
writeXlsx(
  path.join(outDir, "day1_upload.xlsx"),
  buildSheet(day1Scenarios, day1DateCols)
);

// ── Day 2 ─────────────────────────────────────────────────────────────────────
// SC-05 has K=0 → excluded (simulates the bug)
const day2Scenarios = SCENARIOS
  .filter((s) => s.day2K > 0)
  .map((s) => ({ ...s, currentK: s.day2K, currentPlan: s.planDay2 }));

const day2DateCols = [D_TMR, D_D2, D_D3];
writeXlsx(
  path.join(outDir, "day2_upload.xlsx"),
  buildSheet(day2Scenarios, day2DateCols)
);

// ── Print expected results ────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════");
console.log("  Ожидаемые результаты после загрузки day2_upload.xlsx");
console.log("═══════════════════════════════════════════════════════");
for (const s of SCENARIOS) {
  const status = s.bugExpected ? "⚠ БАГ" : s.expectedFact > 0 ? "✓" : "○";
  const note = s.bugExpected
    ? "(K=0 → строка пропускается, факт НЕ запишется)"
    : s.expectedFact === 0
    ? "(факт не записывается — ничего не производилось)"
    : `(факт = ${s.expectedFact} шт записан за вчера)`;
  console.log(`  ${status} ${s.id} [${s.orderNum}] ${s.code}: ${note}`);
}
console.log("\nПроверить результат:");
console.log("  node scripts/verify-fact.mjs");
console.log("═══════════════════════════════════════════════════════\n");
