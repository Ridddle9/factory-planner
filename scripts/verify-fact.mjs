/**
 * Verifies that fact (actualQuantity) was correctly recorded after
 * uploading day2_upload.xlsx.
 *
 * Run after:
 *   1. node scripts/generate-test-xlsx.mjs
 *   2. Import test-data/day1_upload.xlsx via UI
 *   3. Import test-data/day2_upload.xlsx via UI
 *   4. node scripts/verify-fact.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
yesterday.setHours(0, 0, 0, 0);

const EXPECTED = [
  { orderNum: "ТЕ-001", productCode: "РУ000003200",  expectedFact: 50,  bug: false },
  { orderNum: "ТЕ-002", productCode: "ЦБ-00012299",  expectedFact: 0,   bug: false },
  { orderNum: "ТЕ-003", productCode: "ЦБ-00012270",  expectedFact: 50,  bug: false },
  { orderNum: "ТЕ-004", productCode: "ЦБ-00003339",  expectedFact: 40,  bug: false },
  { orderNum: "ТЕ-005", productCode: "ЦБ-00010365",  expectedFact: 20,  bug: true  },
];

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Проверка факта (actualQuantity) за вчера:", yesterday.toLocaleDateString("ru-RU"));
console.log("═══════════════════════════════════════════════════════════════");

let passed = 0;
let failed = 0;

for (const { orderNum, productCode, expectedFact, bug } of EXPECTED) {
  const order = await prisma.order.findUnique({ where: { orderNumber: orderNum } });
  if (!order) {
    console.log(`  ✗ ${orderNum} / ${productCode}: заказ НЕ НАЙДЕН в БД`);
    failed++;
    continue;
  }

  const product = await prisma.product.findUnique({ where: { code: productCode } });
  if (!product) {
    console.log(`  ✗ ${orderNum} / ${productCode}: товар НЕ НАЙДЕН в БД`);
    failed++;
    continue;
  }

  const orderItem = await prisma.orderItem.findFirst({
    where: { orderId: order.id, productId: product.id },
  });
  if (!orderItem) {
    console.log(`  ✗ ${orderNum} / ${productCode}: позиция заказа НЕ НАЙДЕНА`);
    failed++;
    continue;
  }

  // Find yesterday's task
  const task = await prisma.dailyTask.findFirst({
    where: {
      orderItemId: orderItem.id,
      date: { gte: yesterday, lt: new Date(yesterday.getTime() + 86400000) },
    },
  });

  const actualFact = task?.actualQuantity ?? null;

  if (bug) {
    // We expect the bug to manifest: fact should be null/0 even though expectedFact > 0
    const bugHappened = actualFact === null || actualFact === 0;
    if (bugHappened) {
      console.log(`  ⚠ ${orderNum} / ${productCode}: БАГ подтверждён — K=0 пропускается, факт не записан (ожидалось ${expectedFact} шт)`);
    } else {
      console.log(`  ✓ ${orderNum} / ${productCode}: БАГ не проявился — факт ${actualFact} записан (неожиданно!)`);
    }
    continue;
  }

  if (expectedFact === 0) {
    const ok = actualFact === null || actualFact === 0;
    if (ok) {
      console.log(`  ✓ ${orderNum} / ${productCode}: факт = 0 (не записан, верно)`);
      passed++;
    } else {
      console.log(`  ✗ ${orderNum} / ${productCode}: ожидался факт=0, записан факт=${actualFact}`);
      failed++;
    }
  } else {
    const ok = actualFact === expectedFact;
    if (ok) {
      console.log(`  ✓ ${orderNum} / ${productCode}: факт = ${actualFact} шт (верно)`);
      passed++;
    } else {
      console.log(`  ✗ ${orderNum} / ${productCode}: ожидался факт=${expectedFact}, получен факт=${actualFact ?? "не записан"}`);
      failed++;
    }
  }
}

console.log(`\n  Итого: ${passed} ✓  ${failed} ✗`);
console.log("═══════════════════════════════════════════════════════════════\n");

// Also show all dailyTasks for test orders for debugging
console.log("  DailyTask по тестовым заказам:");
const testOrders = await prisma.order.findMany({
  where: { orderNumber: { in: EXPECTED.map((e) => e.orderNum) } },
  include: {
    items: {
      include: {
        product: true,
        dailyTasks: { orderBy: { date: "asc" } },
      },
    },
  },
});

for (const order of testOrders) {
  console.log(`\n  [${order.orderNumber}]`);
  for (const item of order.items) {
    console.log(`    Товар: ${item.product.code}  qty=${item.quantity}`);
    for (const t of item.dailyTasks) {
      const dateStr = t.date.toLocaleDateString("ru-RU");
      const fact = t.actualQuantity !== null ? `факт=${t.actualQuantity}` : "факт=—";
      console.log(`      ${dateStr}  план=${t.plannedQuantity}  ${fact}`);
    }
    if (item.dailyTasks.length === 0) console.log("      (нет задач)");
  }
}

await prisma.$disconnect();
