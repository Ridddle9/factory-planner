-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "description" TEXT,
    "dueDate" DATETIME,
    "manager" TEXT,
    "paymentTerms" TEXT,
    "approvedAt" DATETIME,
    "replanCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "companyId" TEXT NOT NULL,
    CONSTRAINT "Order_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("approvedAt", "companyId", "customer", "description", "dueDate", "id", "manager", "orderNumber", "paymentTerms", "replanCount") SELECT "approvedAt", "companyId", "customer", "description", "dueDate", "id", "manager", "orderNumber", "paymentTerms", "replanCount" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_orderNumber_companyId_key" ON "Order"("orderNumber", "companyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
