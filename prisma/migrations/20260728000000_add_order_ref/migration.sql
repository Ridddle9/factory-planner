-- Чистим старые данные (планировочные данные сбрасываем)
DELETE FROM "DailyTask";
DELETE FROM "OrderItem";
DELETE FROM "Order";

-- Добавляем поле orderRef
ALTER TABLE "Order" ADD COLUMN "orderRef" TEXT;

-- Удаляем старый уникальный индекс по orderNumber+companyId
DROP INDEX IF EXISTS "Order_orderNumber_companyId_key";

-- Создаём новый уникальный индекс по orderRef+companyId
CREATE UNIQUE INDEX "Order_orderRef_companyId_key" ON "Order"("orderRef", "companyId");
