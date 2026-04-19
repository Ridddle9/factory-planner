import express from "express";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import multer from "multer";
import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "path";

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const prisma = new PrismaClient();

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-in-production";
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const IS_PROD = process.env["NODE_ENV"] === "production";

app.use(express.json());
app.use(cookieParser());

// В продакшене фронтенд делает запросы на /api/..., стрипаем префикс
if (IS_PROD) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    else if (req.url === "/api") req.url = "/";
    next();
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

interface AuthUser {
  id: string;
  email: string;
  role: string;
  status: string;
  companyId: string;
  company: { id: string; inn: string; name: string };
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.["token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { company: true },
    });
    if (!user || user.status !== "APPROVED") {
      res.status(401).json({ error: "Unauthorized" }); return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "ADMIN") { res.status(403).json({ error: "Forbidden" }); return; }
  next();
}

function issueToken(res: Response, userId: string) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie("token", token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

app.post("/auth/register", async (req: Request, res: Response) => {
  const { inn, companyName, email, password } = req.body as {
    inn?: string; companyName?: string; email?: string; password?: string;
  };
  if (!inn || !companyName || !email || !password) {
    res.status(400).json({ error: "inn, companyName, email, password обязательны" }); return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Пароль минимум 6 символов" }); return;
  }

  const innClean = inn.trim();
  const emailClean = email.trim().toLowerCase();

  // Найти или создать компанию
  let company = await prisma.company.findUnique({ where: { inn: innClean } });
  const isFirstUser = !company;

  if (!company) {
    company = await prisma.company.create({ data: { inn: innClean, name: companyName.trim() } });
  }

  // Проверить дубль email в этой компании
  const existing = await prisma.user.findUnique({
    where: { email_companyId: { email: emailClean, companyId: company.id } },
  });
  if (existing) {
    res.status(409).json({ error: "Email уже зарегистрирован в этой компании" }); return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      email: emailClean,
      passwordHash,
      companyId: company.id,
      role: isFirstUser ? "ADMIN" : "MEMBER",
      status: isFirstUser ? "APPROVED" : "PENDING",
    },
  });

  if (isFirstUser) {
    issueToken(res, user.id);
    res.json({ status: "approved", role: "ADMIN", email: user.email, company: { inn: company.inn, name: company.name } });
  } else {
    res.json({ status: "pending", message: "Заявка отправлена руководителю на подтверждение" });
  }
});

app.post("/auth/login", async (req: Request, res: Response) => {
  const { inn, email, password } = req.body as { inn?: string; email?: string; password?: string };
  if (!inn || !email || !password) {
    res.status(400).json({ error: "inn, email, password обязательны" }); return;
  }

  const company = await prisma.company.findUnique({ where: { inn: inn.trim() } });
  if (!company) { res.status(401).json({ error: "Неверный ИНН, email или пароль" }); return; }

  const user = await prisma.user.findUnique({
    where: { email_companyId: { email: email.trim().toLowerCase(), companyId: company.id } },
  });
  if (!user) { res.status(401).json({ error: "Неверный ИНН, email или пароль" }); return; }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) { res.status(401).json({ error: "Неверный ИНН, email или пароль" }); return; }

  if (user.status === "PENDING") {
    res.status(403).json({ error: "pending", message: "Ваша заявка ещё не подтверждена руководителем" }); return;
  }
  if (user.status === "REJECTED") {
    res.status(403).json({ error: "rejected", message: "В доступе отказано" }); return;
  }

  issueToken(res, user.id);
  res.json({ email: user.email, role: user.role, company: { inn: company.inn, name: company.name } });
});

app.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/auth/me", async (req: Request, res: Response) => {
  const token = req.cookies?.["token"] as string | undefined;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { company: true },
    });
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      company: { id: user.company.id, inn: user.company.inn, name: user.company.name },
    });
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

app.get("/admin/users/pending", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { companyId: req.user!.companyId, status: "PENDING" },
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users);
});

app.patch("/admin/users/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { status } = req.body as { status?: string };
  if (status !== "APPROVED" && status !== "REJECTED") {
    res.status(400).json({ error: "status должен быть APPROVED или REJECTED" }); return;
  }
  const targetId = String(req.params["id"] ?? "");
  const user = await prisma.user.findUnique({ where: { id: targetId } });
  if (!user || user.companyId !== req.user!.companyId) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { status },
    select: { id: true, email: true, status: true },
  });
  res.json(updated);
});

// Российские нерабочие праздники (месяц 1-based, фиксированные даты)
const RUSSIAN_HOLIDAYS: { month: number; day: number }[] = [
  { month: 1, day: 1 }, { month: 1, day: 2 }, { month: 1, day: 3 },
  { month: 1, day: 4 }, { month: 1, day: 5 }, { month: 1, day: 6 },
  { month: 1, day: 7 }, { month: 1, day: 8 }, // Новый год + Рождество
  { month: 2, day: 23 }, // День защитника Отечества
  { month: 3, day: 8 },  // Международный женский день
  { month: 5, day: 1 },  // Праздник весны и труда
  { month: 5, day: 9 },  // День Победы
  { month: 6, day: 12 }, // День России
  { month: 11, day: 4 }, // День народного единства
];

function isWorkingDay(date: Date): boolean {
  const dow = date.getDay(); // 0=Вс, 6=Сб
  if (dow === 0 || dow === 6) return false;
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return !RUSSIAN_HOLIDAYS.some(h => h.month === m && h.day === d);
}

// Helper: возвращает «К обеспечению» для позиции заказа.
// orderItem.quantity хранит последнее значение «К обеспечению» из ERP (не исходный итог заказа).
// Вычитать уже записанные факты нельзя — они уже учтены в K на момент предыдущего импорта.
async function calculateRemainingQuantity(orderItemId: string): Promise<number> {
  const orderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { quantity: true },
  });
  return orderItem?.quantity ?? 0;
}

// Helper: вычислить загрузку бригады на дату в долях бригадо-дня (0.0–1.0+)
// load = Σ(plannedQuantity / capacityPerTeamPerDay) по всем задачам
async function calculateTeamLoad(teamId: string, date: Date): Promise<number> {
  const tasks = await prisma.dailyTask.findMany({
    where: { teamId, date },
    select: {
      plannedQuantity: true,
      orderItem: {
        select: {
          product: {
            select: {
              category: { select: { capacityPerTeamPerDay: true } },
            },
          },
        },
      },
    },
  });

  return tasks.reduce((sum, task) => {
    const cap = task.orderItem.product.category.capacityPerTeamPerDay;
    return sum + (cap > 0 ? task.plannedQuantity / cap : 0);
  }, 0);
}

// Helper: получить доступные бригады для категории
async function getAvailableTeamsForCategory(categoryId: string): Promise<string[]> {
  const links = await prisma.categoryTeam.findMany({
    where: { categoryId },
    select: { teamId: true },
  });

  return links.map((link) => link.teamId);
}


// Helper: выбрать бригаду с минимальной загрузкой на дату (нагрузка в долях)
async function selectTeamWithMinLoad(
  teamIds: string[],
  date: Date
): Promise<string | null> {
  if (teamIds.length === 0) {
    return null;
  }

  const loads = await Promise.all(
    teamIds.map(async (teamId) => {
      const load = await calculateTeamLoad(teamId, date);
      return { teamId, load };
    })
  );

  // Сортируем по загрузке в долях (меньше загружена = лучше)
  loads.sort((a, b) => a.load - b.load);

  return loads[0]?.teamId || null;
}

// Helper: автопланирование позиции заказа
async function autoPlanOrderItem(
  orderItemId: string,
  options?: { startDate?: Date; preferredTeamId?: string }
): Promise<{ tasks: any[]; overloaded: boolean }> {
  const orderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: {
      order: true,
      product: { include: { category: true } },
    },
  });

  if (!orderItem) {
    throw new Error("Order item not found");
  }

  const { quantity } = orderItem;
  const { capacityPerTeamPerDay } = orderItem.product.category;
  const dueDate = orderItem.order.dueDate; // may be null

  // Получаем доступные бригады для категории
  const availableTeamIds = await getAvailableTeamsForCategory(orderItem.product.categoryId);

  if (availableTeamIds.length === 0) {
    throw new Error("No teams available for this product category");
  }

  // Определяем дату начала
  let currentDate: Date;
  if (options?.startDate) {
    currentDate = new Date(options.startDate);
  } else {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    // Если dueDate есть и раньше завтра — начинаем с dueDate, иначе с завтра
    currentDate = (dueDate && dueDate < tomorrow) ? new Date(dueDate) : tomorrow;
  }

  const tasks: any[] = [];
  let remaining = quantity;
  let overloaded = false;

  // Планируем от текущей даты до dueDate (или дальше, если перегрузка)
  const maxDays = 365; // Защита от бесконечного цикла
  let daysPlanned = 0;

  while (remaining > 0 && daysPlanned < maxDays) {
    const dateStr = currentDate.toISOString().split("T")[0];
    if (!dateStr) break;
    const date = new Date(dateStr);

    // Пропускаем выходные и российские праздники
    if (!isWorkingDay(date)) {
      currentDate.setDate(currentDate.getDate() + 1);
      daysPlanned++;
      continue;
    }

    // Выбираем бригаду
    let teamId: string | null = null;

    if (options?.preferredTeamId && availableTeamIds.includes(options.preferredTeamId)) {
      teamId = options.preferredTeamId;
    } else {
      teamId = await selectTeamWithMinLoad(availableTeamIds, date);
    }

    if (!teamId) {
      throw new Error("No available team found");
    }

    // Проверяем текущую загрузку бригады (в долях бригадо-дня)
    const currentLoadFraction = await calculateTeamLoad(teamId, date);
    // Эффективная мощность с учётом корректировки на день
    const capOverride = await prisma.teamDayCapacity.findUnique({
      where: { teamId_date: { teamId, date } },
    });
    const effectiveFraction = capOverride ? capOverride.factor : 1.0;
    // Свободная ёмкость в штуках для текущей категории
    const availableFraction = Math.max(0, effectiveFraction - currentLoadFraction);
    const available = Math.floor(availableFraction * capacityPerTeamPerDay);

    // Планируем на этот день
    const plannedForDay = Math.min(remaining, available);

    if (plannedForDay > 0) {
      // Проверяем, не существует ли уже задача на эту дату для этой позиции
      const existingTask = await prisma.dailyTask.findUnique({
        where: {
          orderItemId_date: {
            orderItemId,
            date,
          },
        },
      });

      if (!existingTask) {
        const task = await prisma.dailyTask.create({
          data: {
            orderItem: { connect: { id: orderItemId } },
            team: { connect: { id: teamId } },
            date,
            plannedQuantity: plannedForDay,
          },
          include: {
            orderItem: {
              include: {
                order: true,
                product: { include: { category: true } },
              },
            },
            team: true,
          },
        });

        tasks.push(task);
      } else {
        // Обновляем существующую задачу
        const updatedTask = await prisma.dailyTask.update({
          where: { id: existingTask.id },
          data: {
            plannedQuantity: existingTask.plannedQuantity + plannedForDay,
            team: { connect: { id: teamId } },
          },
          include: {
            orderItem: {
              include: {
                order: true,
                product: { include: { category: true } },
              },
            },
            team: true,
          },
        });

        tasks.push(updatedTask);
      }

      remaining -= plannedForDay;
    }

    // Переходим на следующий день
    currentDate.setDate(currentDate.getDate() + 1);
    daysPlanned++;

    // Если прошли dueDate и ещё осталось - это перегрузка
    if (dueDate && currentDate > dueDate && remaining > 0) {
      overloaded = true;
    }
  }

  if (remaining > 0) {
    overloaded = true;
  }

  return { tasks, overloaded };
}

// Healthcheck (публичный)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Все роуты ниже требуют авторизации
app.use(requireAuth);

// --- Workshops ---

app.get("/workshops", async (_req: Request, res: Response) => {
  const workshops = await prisma.workshop.findMany({
    orderBy: { name: "asc" },
  });
  res.json(workshops);
});

app.post("/workshops", async (req: Request, res: Response) => {
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const workshop = await prisma.workshop.create({
    data: { name },
  });

  res.status(201).json(workshop);
});

app.put("/workshops/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const workshop = await prisma.workshop.update({
      where: { id },
      data: { name },
    });
    res.json(workshop);
  } catch (err) {
    res.status(404).json({ error: "Workshop not found" });
  }
});

app.delete("/workshops/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.workshop.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Workshop not found" });
  }
});

// --- Product Categories ---

app.get("/categories", async (_req: Request, res: Response) => {
  const categories = await prisma.productCategory.findMany({
    include: { workshop: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

app.post("/categories", async (req: Request, res: Response) => {
  const { name, capacityPerTeamPerDay, workshopId } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  if (
    typeof capacityPerTeamPerDay !== "number" ||
    !Number.isInteger(capacityPerTeamPerDay) ||
    capacityPerTeamPerDay <= 0
  ) {
    return res
      .status(400)
      .json({ error: "capacityPerTeamPerDay must be a positive integer" });
  }

  if (!workshopId || typeof workshopId !== "string") {
    return res.status(400).json({ error: "workshopId is required" });
  }

  try {
    const category = await prisma.productCategory.create({
      data: {
        name,
        capacityPerTeamPerDay,
        workshop: { connect: { id: workshopId } },
      },
    });
    res.status(201).json(category);
  } catch (err) {
    res.status(400).json({ error: "Failed to create category" });
  }
});

app.put("/categories/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name, capacityPerTeamPerDay, workshopId } = req.body;

  const data: {
    name?: string;
    capacityPerTeamPerDay?: number;
    workshopId?: string;
  } = {};

  if (name !== undefined) {
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    data.name = name;
  }

  if (capacityPerTeamPerDay !== undefined) {
    if (
      typeof capacityPerTeamPerDay !== "number" ||
      !Number.isInteger(capacityPerTeamPerDay) ||
      capacityPerTeamPerDay <= 0
    ) {
      return res
        .status(400)
        .json({ error: "capacityPerTeamPerDay must be a positive integer" });
    }
    data.capacityPerTeamPerDay = capacityPerTeamPerDay;
  }

  if (workshopId !== undefined) {
    if (!workshopId || typeof workshopId !== "string") {
      return res.status(400).json({ error: "workshopId must be a string" });
    }
    data.workshopId = workshopId;
  }

  try {
    const category = await prisma.productCategory.update({
      where: { id },
      data,
    });
    res.json(category);
  } catch (err) {
    res.status(404).json({ error: "Category not found" });
  }
});

app.delete("/categories/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.productCategory.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Category not found" });
  }
});

// --- Products ---

app.get("/products", async (_req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    include: { category: true },
    orderBy: { code: "asc" },
  });
  res.json(products);
});

app.post("/products", async (req: Request, res: Response) => {
  const { code, name, categoryId } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "code is required" });
  }
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  if (!categoryId || typeof categoryId !== "string") {
    return res.status(400).json({ error: "categoryId is required" });
  }

  try {
    const product = await prisma.product.create({
      data: {
        code,
        name,
        category: { connect: { id: categoryId } },
      },
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: "Failed to create product" });
  }
});

app.put("/products/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { code, name, categoryId } = req.body;

  const data: { code?: string; name?: string; categoryId?: string } = {};

  if (code !== undefined) {
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "code must be a non-empty string" });
    }
    data.code = code;
  }
  if (name !== undefined) {
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    data.name = name;
  }
  if (categoryId !== undefined) {
    if (!categoryId || typeof categoryId !== "string") {
      return res
        .status(400)
        .json({ error: "categoryId must be a non-empty string" });
    }
    data.categoryId = categoryId;
  }

  try {
    const product = await prisma.product.update({
      where: { id },
      data,
    });
    res.json(product);
  } catch (err) {
    res.status(404).json({ error: "Product not found" });
  }
});

app.delete("/products/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.product.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Product not found" });
  }
});

// --- Teams ---

app.get("/teams", async (_req: Request, res: Response) => {
  const teams = await prisma.team.findMany({
    orderBy: { name: "asc" },
  });
  res.json(teams);
});

app.post("/teams", async (req: Request, res: Response) => {
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const team = await prisma.team.create({
      data: { name },
    });
    res.status(201).json(team);
  } catch (err) {
    res.status(400).json({ error: "Failed to create team" });
  }
});

app.put("/teams/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name } = req.body;

  if (name !== undefined) {
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
  }

  try {
    const team = await prisma.team.update({
      where: { id },
      data: { name },
    });
    res.json(team);
  } catch (err) {
    res.status(404).json({ error: "Team not found" });
  }
});

app.delete("/teams/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.team.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Team not found" });
  }
});

// --- Orders ---

app.get("/orders", async (req: Request, res: Response) => {
  const orders = await prisma.order.findMany({
    include: { items: { include: { product: true } } },
    orderBy: { orderNumber: "asc" },
  });
  res.json(orders);
});

app.post("/orders", async (req: Request, res: Response) => {
  const {
    orderNumber,
    customer,
    description,
    dueDate,
    manager,
    paymentTerms,
    approvedAt,
  } = req.body;

  if (!orderNumber || typeof orderNumber !== "string") {
    return res.status(400).json({ error: "orderNumber is required" });
  }
  if (!customer || typeof customer !== "string") {
    return res.status(400).json({ error: "customer is required" });
  }

  try {
    const order = await prisma.order.create({
      data: {
        orderNumber,
        customer,
        description: description || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        manager: manager || null,
        paymentTerms: paymentTerms || null,
        approvedAt: approvedAt ? new Date(approvedAt) : null,
      },
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: "Failed to create order" });
  }
});

app.put("/orders/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });
  const {
    orderNumber,
    customer,
    description,
    dueDate,
    manager,
    paymentTerms,
    approvedAt,
  } = req.body;

  const data: {
    orderNumber?: string;
    customer?: string;
    description?: string | null;
    dueDate?: Date | null;
    manager?: string | null;
    paymentTerms?: string | null;
    approvedAt?: Date | null;
  } = {};

  if (orderNumber !== undefined) {
    if (!orderNumber || typeof orderNumber !== "string") {
      return res.status(400).json({ error: "orderNumber must be a non-empty string" });
    }
    data.orderNumber = orderNumber;
  }

  if (customer !== undefined) {
    if (!customer || typeof customer !== "string") {
      return res.status(400).json({ error: "customer must be a non-empty string" });
    }
    data.customer = customer;
  }

  if (description !== undefined) {
    data.description = description === null || description === "" ? null : String(description);
  }

  if (dueDate !== undefined) {
    data.dueDate = dueDate === null || dueDate === "" ? null : new Date(dueDate);
  }

  if (manager !== undefined) {
    data.manager = manager === null || manager === "" ? null : String(manager);
  }

  if (paymentTerms !== undefined) {
    data.paymentTerms = paymentTerms === null || paymentTerms === "" ? null : String(paymentTerms);
  }

  if (approvedAt !== undefined) {
    data.approvedAt = approvedAt === null || approvedAt === "" ? null : new Date(approvedAt);
  }

  try {
    const order = await prisma.order.update({
      where: { id },
      data,
    });
    res.json(order);
  } catch (err) {
    res.status(404).json({ error: "Order not found" });
  }
});

app.delete("/orders/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.order.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Order not found" });
  }
});

// --- Order Items ---

app.get("/order-items", async (req: Request, res: Response) => {
  const orderId = req.query.orderId as string | undefined;

  const where = orderId ? { orderId } : {};

  const items = await prisma.orderItem.findMany({
    where,
    include: {
      order: true,
      product: { include: { category: true } },
    },
    orderBy: { id: "asc" },
  });

  // Добавляем «к обеспечению» для каждой позиции
  const itemsWithRemaining = await Promise.all(
    items.map(async (item) => {
      const remaining = await calculateRemainingQuantity(item.id);
      return {
        ...item,
        remainingQuantity: remaining,
      };
    })
  );

  res.json(itemsWithRemaining);
});

app.post("/order-items", async (req: Request, res: Response) => {
  const { orderId, productId, quantity, groupNumber } = req.body;

  if (!orderId || typeof orderId !== "string") {
    return res.status(400).json({ error: "orderId is required" });
  }
  if (!productId || typeof productId !== "string") {
    return res.status(400).json({ error: "productId is required" });
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    return res.status(400).json({ error: "quantity must be a positive integer" });
  }

  try {
    const item = await prisma.orderItem.create({
      data: {
        order: { connect: { id: orderId } },
        product: { connect: { id: productId } },
        quantity,
        groupNumber: groupNumber !== undefined ? (Number.isInteger(groupNumber) ? groupNumber : null) : null,
      },
      include: {
        order: true,
        product: { include: { category: true } },
      },
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(400).json({ error: "Failed to create order item" });
  }
});

app.put("/order-items/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });
  const { productId, quantity, groupNumber } = req.body;

  const data: {
    productId?: string;
    quantity?: number;
    groupNumber?: number | null;
  } = {};

  if (productId !== undefined) {
    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ error: "productId must be a non-empty string" });
    }
    data.productId = productId;
  }

  if (quantity !== undefined) {
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      return res.status(400).json({ error: "quantity must be a positive integer" });
    }
    data.quantity = quantity;
  }

  if (groupNumber !== undefined) {
    data.groupNumber = groupNumber === null || groupNumber === "" ? null : (Number.isInteger(Number(groupNumber)) ? Number(groupNumber) : null);
  }

  try {
    const item = await prisma.orderItem.update({
      where: { id },
      data,
      include: {
        order: true,
        product: { include: { category: true } },
      },
    });
    res.json(item);
  } catch (err) {
    res.status(404).json({ error: "Order item not found" });
  }
});

app.delete("/order-items/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.orderItem.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Order item not found" });
  }
});

// Получить «к обеспечению» для позиции заказа
app.get("/order-items/:id/remaining", async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const remaining = await calculateRemainingQuantity(id);
    const orderItem = await prisma.orderItem.findUnique({
      where: { id },
      include: {
        order: true,
        product: { include: { category: true } },
      },
    });

    if (!orderItem) {
      return res.status(404).json({ error: "Order item not found" });
    }

    res.json({
      orderItemId: id,
      quantity: orderItem.quantity,
      remainingQuantity: remaining,
      orderItem,
    });
  } catch (err) {
    res.status(404).json({ error: "Order item not found" });
  }
});

// --- Daily Tasks (план по датам) ---

app.get("/daily-tasks", async (req: Request, res: Response) => {
  const orderItemId = req.query.orderItemId as string | undefined;
  const dateStr = req.query.date as string | undefined;

  const where: {
    orderItemId?: string;
    date?: Date;
  } = {};

  if (orderItemId) {
    where.orderItemId = orderItemId;
  }

  if (dateStr) {
    where.date = new Date(dateStr);
  }

  const tasks = await prisma.dailyTask.findMany({
    where,
    include: {
      orderItem: {
        include: {
          order: true,
          product: { include: { category: true } },
        },
      },
      team: true,
    },
    orderBy: { date: "asc" },
  });
  res.json(tasks);
});

// Просмотр плана с фильтрами
app.get("/daily-tasks/plan", async (req: Request, res: Response) => {
  const dateStr = req.query.date as string | undefined;
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;
  const workshopId = req.query.workshopId as string | undefined;
  const teamId = req.query.teamId as string | undefined;
  const orderId = req.query.orderId as string | undefined;
  const categoryId = req.query.categoryId as string | undefined;

  const where: any = {};

  // Фильтр по дате (одна дата или диапазон)
  if (dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ error: "Invalid date format (use YYYY-MM-DD)" });
    }
    where.date = date;
  } else if (dateFromStr || dateToStr) {
    if (dateFromStr) {
      const dateFrom = new Date(dateFromStr);
      if (isNaN(dateFrom.getTime())) {
        return res.status(400).json({ error: "Invalid dateFrom format (use YYYY-MM-DD)" });
      }
      where.date = { ...where.date, gte: dateFrom };
    }
    if (dateToStr) {
      const dateTo = new Date(dateToStr);
      if (isNaN(dateTo.getTime())) {
        return res.status(400).json({ error: "Invalid dateTo format (use YYYY-MM-DD)" });
      }
      where.date = { ...where.date, lte: dateTo };
    }
  } else {
    return res.status(400).json({ error: "date or dateFrom/dateTo query parameter is required" });
  }

  // Фильтр по бригаде
  if (teamId) {
    where.teamId = teamId;
  }

  // Фильтр по заказу
  if (orderId) {
    where.orderItem = { ...where.orderItem, orderId };
  }

  // Фильтр по категории
  if (categoryId) {
    where.orderItem = {
      ...where.orderItem,
      product: { ...where.orderItem?.product, categoryId },
    };
  }

  // Фильтр по участку
  if (workshopId) {
    where.orderItem = {
      ...where.orderItem,
      product: {
        ...where.orderItem?.product,
        category: { ...where.orderItem?.product?.category, workshopId },
      },
    };
  }

  const tasks = await prisma.dailyTask.findMany({
    where,
    include: {
      orderItem: {
        include: {
          order: true,
          product: { include: { category: { include: { workshop: true } } } },
        },
      },
      team: true,
    },
    orderBy: [
      { date: "asc" },
      { orderItem: { product: { category: { workshop: { name: "asc" } } } } },
      { orderItem: { product: { code: "asc" } } },
    ],
  });

  res.json(tasks);
});

// Сводка по участкам (для графика)
app.get("/daily-tasks/summary", async (req: Request, res: Response) => {
  const dateStr = req.query.date as string | undefined;
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;

  const dateWhere: any = {};

  if (dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ error: "Invalid date format (use YYYY-MM-DD)" });
    }
    dateWhere.date = date;
  } else if (dateFromStr || dateToStr) {
    if (dateFromStr) {
      const dateFrom = new Date(dateFromStr);
      if (isNaN(dateFrom.getTime())) {
        return res.status(400).json({ error: "Invalid dateFrom format (use YYYY-MM-DD)" });
      }
      dateWhere.date = { ...dateWhere.date, gte: dateFrom };
    }
    if (dateToStr) {
      const dateTo = new Date(dateToStr);
      if (isNaN(dateTo.getTime())) {
        return res.status(400).json({ error: "Invalid dateTo format (use YYYY-MM-DD)" });
      }
      dateWhere.date = { ...dateWhere.date, lte: dateTo };
    }
  } else {
    return res.status(400).json({ error: "date or dateFrom/dateTo query parameter is required" });
  }

  const tasks = await prisma.dailyTask.findMany({
    where: dateWhere,
    include: {
      orderItem: {
        include: {
          product: { include: { category: { include: { workshop: true } } } },
        },
      },
      team: true,
    },
  });

  // Группируем по участкам
  const summaryByWorkshop: Record<
    string,
    {
      workshopId: string;
      workshopName: string;
      totalPlanned: number;
      totalActual: number;
      tasksCount: number;
    }
  > = {};

  for (const task of tasks) {
    const workshopId = task.orderItem.product.category.workshop.id;
    const workshopName = task.orderItem.product.category.workshop.name;

    if (!summaryByWorkshop[workshopId]) {
      summaryByWorkshop[workshopId] = {
        workshopId,
        workshopName,
        totalPlanned: 0,
        totalActual: 0,
        tasksCount: 0,
      };
    }

    summaryByWorkshop[workshopId].totalPlanned += task.plannedQuantity;
    summaryByWorkshop[workshopId].totalActual += task.actualQuantity || 0;
    summaryByWorkshop[workshopId].tasksCount += 1;
  }

  res.json(Object.values(summaryByWorkshop));
});

app.post("/daily-tasks", async (req: Request, res: Response) => {
  const { orderItemId, date, plannedQuantity, teamId } = req.body;

  if (!orderItemId || typeof orderItemId !== "string") {
    return res.status(400).json({ error: "orderItemId is required" });
  }

  if (!date) {
    return res.status(400).json({ error: "date is required (ISO string)" });
  }

  const taskDate = new Date(date);
  if (isNaN(taskDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  if (
    plannedQuantity !== undefined &&
    (typeof plannedQuantity !== "number" ||
      !Number.isInteger(plannedQuantity) ||
      plannedQuantity < 0)
  ) {
    return res.status(400).json({ error: "plannedQuantity must be a non-negative integer" });
  }

  try {
    const createData: {
      orderItem: { connect: { id: string } };
      date: Date;
      plannedQuantity: number;
      team?: { connect: { id: string } };
    } = {
      orderItem: { connect: { id: orderItemId } },
      date: taskDate,
      plannedQuantity: plannedQuantity !== undefined ? plannedQuantity : 0,
    };
    if (teamId && typeof teamId === "string") {
      createData.team = { connect: { id: teamId } };
    }
    const task = await prisma.dailyTask.create({
      data: createData,
      include: {
        orderItem: {
          include: {
            order: true,
            product: { include: { category: true } },
          },
        },
        team: true,
      },
    });
    res.status(201).json(task);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Task for this order item and date already exists" });
    } else {
      res.status(400).json({ error: "Failed to create daily task" });
    }
  }
});

app.put("/daily-tasks/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });
  const { plannedQuantity, teamId, date } = req.body;

  const data: {
    plannedQuantity?: number;
    teamId?: string | null;
    date?: Date;
  } = {};

  if (plannedQuantity !== undefined) {
    if (
      typeof plannedQuantity !== "number" ||
      !Number.isInteger(plannedQuantity) ||
      plannedQuantity < 0
    ) {
      return res.status(400).json({ error: "plannedQuantity must be a non-negative integer" });
    }
    data.plannedQuantity = plannedQuantity;
  }

  if (teamId !== undefined) {
    if (teamId === null || teamId === "") {
      data.teamId = null;
    } else if (typeof teamId === "string") {
      data.teamId = teamId;
    } else {
      return res.status(400).json({ error: "teamId must be a string or null" });
    }
  }

  if (date !== undefined) {
    const taskDate = new Date(date);
    if (isNaN(taskDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format" });
    }
    data.date = taskDate;
  }

  try {
    const task = await prisma.dailyTask.update({
      where: { id },
      data,
      include: {
        orderItem: {
          include: {
            order: true,
            product: { include: { category: true } },
          },
        },
        team: true,
      },
    });
    res.json(task);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Task for this order item and date already exists" });
    } else {
      res.status(404).json({ error: "Daily task not found" });
    }
  }
});

app.delete("/daily-tasks/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.dailyTask.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Daily task not found" });
  }
});

// --- Разбить задачу на две части ---

app.post("/daily-tasks/:id/split", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  const { qty1, date2, qty2 } = req.body;

  if (
    typeof qty1 !== "number" || !Number.isInteger(qty1) || qty1 <= 0 ||
    typeof qty2 !== "number" || !Number.isInteger(qty2) || qty2 <= 0 ||
    !date2
  ) {
    return res.status(400).json({ error: "qty1, qty2 (positive integers) and date2 are required" });
  }

  const targetDate = new Date(date2);
  if (isNaN(targetDate.getTime())) {
    return res.status(400).json({ error: "Invalid date2 format" });
  }

  try {
    const original = await prisma.dailyTask.findUnique({ where: { id } });
    if (!original) return res.status(404).json({ error: "Daily task not found" });

    if (qty1 + qty2 !== original.plannedQuantity) {
      return res.status(400).json({ error: `qty1 + qty2 must equal the original plannedQuantity (${original.plannedQuantity})` });
    }

    // Обновляем первую задачу
    const task1 = await prisma.dailyTask.update({
      where: { id },
      data: { plannedQuantity: qty1 },
      include: { orderItem: { include: { order: true, product: { include: { category: { include: { workshop: true } } } } } }, team: true },
    });

    // Создаём вторую задачу
    const task2 = await prisma.dailyTask.create({
      data: {
        orderItemId: original.orderItemId,
        teamId: original.teamId,
        date: targetDate,
        plannedQuantity: qty2,
      },
      include: { orderItem: { include: { order: true, product: { include: { category: { include: { workshop: true } } } } } }, team: true },
    });

    res.json({ task1, task2 });
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "A task for this order item on date2 already exists" });
    } else {
      res.status(400).json({ error: "Failed to split task" });
    }
  }
});

// --- Предложения для заполнения освободившегося слота ---

app.get("/daily-tasks/:id/move-suggestions", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  const freedDateStr = req.query.freedDate as string | undefined;
  if (!freedDateStr) return res.status(400).json({ error: "freedDate query param is required" });

  const freedDate = new Date(freedDateStr);
  if (isNaN(freedDate.getTime())) return res.status(400).json({ error: "Invalid freedDate" });

  try {
    const task = await prisma.dailyTask.findUnique({
      where: { id },
      include: { orderItem: { include: { product: { include: { category: true } } } } },
    });
    if (!task) return res.status(404).json({ error: "Daily task not found" });

    const teamId = task.teamId;
    if (!teamId) return res.json({ suggestions: [] });

    // Категории, с которыми работает эта бригада
    const categoryLinks = await prisma.categoryTeam.findMany({ where: { teamId }, select: { categoryId: true } });
    const categoryIds = categoryLinks.map((l) => l.categoryId);

    // Свободное место = мощность минус уже запланированное
    const dayTasks = await prisma.dailyTask.findMany({
      where: { teamId, date: freedDate },
      select: { plannedQuantity: true },
    });
    const usedCapacity = dayTasks.reduce((s, t) => s + t.plannedQuantity, 0);

    // Находим позиции заказов с остатком, которые подходят бригаде и не запланированы на эту дату
    const orderItems = await prisma.orderItem.findMany({
      where: {
        product: { categoryId: { in: categoryIds } },
        dailyTasks: { none: { date: freedDate } },
      },
      include: {
        order: true,
        product: { include: { category: true } },
        dailyTasks: { select: { actualQuantity: true } },
      },
      take: 20,
    });

    // Вычисляем остаток: oi.quantity уже хранит К обеспечению (текущий остаток из ERP)
    const withRemaining = orderItems
      .map((oi) => {
        return { ...oi, remainingQuantity: oi.quantity };
      })
      .filter((oi) => oi.remainingQuantity > 0)
      .sort((a, b) => {
        const da = a.order.dueDate ? new Date(a.order.dueDate).getTime() : Infinity;
        const db = b.order.dueDate ? new Date(b.order.dueDate).getTime() : Infinity;
        return da - db;
      })
      .slice(0, 5);

    res.json({ freedDate: freedDateStr, usedCapacity, suggestions: withRemaining });
  } catch {
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

// --- Корректировка мощностей бригад по дням ---

app.get("/team-day-capacity", async (req: Request, res: Response) => {
  const dateStr = req.query.date as string | undefined;
  const teamId = req.query.teamId as string | undefined;

  const where: { date?: Date; teamId?: string } = {};
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) where.date = d;
  }
  if (teamId) where.teamId = teamId;

  const records = await prisma.teamDayCapacity.findMany({
    where,
    include: { team: true },
    orderBy: { date: "asc" },
  });
  res.json(records);
});

app.post("/team-day-capacity", async (req: Request, res: Response) => {
  const { teamId, date, factor, note } = req.body;

  if (!teamId || typeof teamId !== "string") return res.status(400).json({ error: "teamId is required" });
  if (!date) return res.status(400).json({ error: "date is required" });
  if (typeof factor !== "number" || factor < 0 || factor > 1) return res.status(400).json({ error: "factor must be a number between 0 and 1" });

  const dayDate = new Date(date);
  if (isNaN(dayDate.getTime())) return res.status(400).json({ error: "Invalid date" });

  try {
    const record = await prisma.teamDayCapacity.upsert({
      where: { teamId_date: { teamId, date: dayDate } },
      update: { factor, note: note ?? null },
      create: { teamId, date: dayDate, factor, note: note ?? null },
      include: { team: true },
    });
    res.status(201).json(record);
  } catch {
    res.status(400).json({ error: "Failed to save team day capacity" });
  }
});

app.delete("/team-day-capacity/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.teamDayCapacity.delete({ where: { id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Record not found" });
  }
});

// --- Category-Team связь (какие бригады работают с какими категориями) ---

app.get("/category-teams", async (req: Request, res: Response) => {
  const categoryId = req.query.categoryId as string | undefined;
  const teamId = req.query.teamId as string | undefined;

  const where: {
    categoryId?: string;
    teamId?: string;
  } = {};

  if (categoryId) {
    where.categoryId = categoryId;
  }

  if (teamId) {
    where.teamId = teamId;
  }

  const links = await prisma.categoryTeam.findMany({
    where,
    include: {
      category: { include: { workshop: true } },
      team: true,
    },
    orderBy: { categoryId: "asc" },
  });
  res.json(links);
});

// Получить бригады для категории
app.get("/categories/:categoryId/teams", async (req: Request, res: Response) => {
  const categoryId = req.params.categoryId as string | undefined;
  if (typeof categoryId !== "string") {
    return res.status(400).json({ error: "Invalid categoryId" });
  }

  const links = await prisma.categoryTeam.findMany({
    where: { categoryId },
    include: { team: true },
  });

  const teams = links.map((link) => (link as { team: { id: string; name: string } }).team);
  res.json(teams);
});

// Загрузка бригады на дату + мощность
app.get("/teams/:teamId/load", async (req: Request, res: Response) => {
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") return res.status(400).json({ error: "Invalid teamId" });

  const dateStr = req.query.date as string | undefined;
  if (!dateStr) return res.status(400).json({ error: "date query param required" });

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return res.status(400).json({ error: "Invalid date" });

  // Текущая загрузка в долях бригадо-дня
  const load = await calculateTeamLoad(teamId, date);

  // Корректировка мощности на день: effectiveCapacity = factor (доля доступного бригадо-дня)
  const capOverride = await prisma.teamDayCapacity.findUnique({ where: { teamId_date: { teamId, date } } });
  const effectiveCapacity = capOverride ? capOverride.factor : 1.0;

  // available — свободная доля бригадо-дня
  const available = Math.max(0, effectiveCapacity - load);

  res.json({ teamId, date: dateStr, load, effectiveCapacity, available });
});

// Перебалансировка дня: перенос излишка на следующий день
app.post("/teams/:teamId/rebalance-day", async (req: Request, res: Response) => {
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") return res.status(400).json({ error: "Invalid teamId" });

  const { date } = req.body;
  if (!date) return res.status(400).json({ error: "date is required" });

  const dayDate = new Date(date);
  if (isNaN(dayDate.getTime())) return res.status(400).json({ error: "Invalid date" });

  // Эффективная мощность на день
  const links = await prisma.categoryTeam.findMany({ where: { teamId }, include: { category: true } });
  const baseCapacity = links.length > 0
    ? Math.max(...links.map((l) => (l.category as { capacityPerTeamPerDay: number }).capacityPerTeamPerDay))
    : null;
  if (baseCapacity === null) return res.status(400).json({ error: "No capacity data for this team" });

  const capOverride = await prisma.teamDayCapacity.findUnique({ where: { teamId_date: { teamId, date: dayDate } } });
  const effectiveCapacity = capOverride ? Math.round(baseCapacity * capOverride.factor) : baseCapacity;

  // Задачи бригады на этот день
  const tasks = await prisma.dailyTask.findMany({
    where: { teamId, date: dayDate },
    orderBy: { plannedQuantity: "asc" }, // сначала уменьшаем меньшие задачи
  });

  const totalPlanned = tasks.reduce((s, t) => s + t.plannedQuantity, 0);
  let excess = totalPlanned - effectiveCapacity;

  if (excess <= 0) return res.json({ moved: 0, tasks: [] });

  // Следующий рабочий день (просто +1 день)
  const nextDay = new Date(dayDate);
  nextDay.setDate(nextDay.getDate() + 1);

  const moved: { orderItemId: string; qty: number }[] = [];

  for (const task of tasks) {
    if (excess <= 0) break;
    const trim = Math.min(task.plannedQuantity, excess);
    const newQty = task.plannedQuantity - trim;

    // Обновляем текущую задачу
    if (newQty === 0) {
      await prisma.dailyTask.delete({ where: { id: task.id } });
    } else {
      await prisma.dailyTask.update({ where: { id: task.id }, data: { plannedQuantity: newQty } });
    }

    // Добавляем излишек к следующему дню (upsert: если уже есть задача — увеличиваем)
    const existing = await prisma.dailyTask.findUnique({
      where: { orderItemId_date: { orderItemId: task.orderItemId, date: nextDay } },
    });
    if (existing) {
      await prisma.dailyTask.update({
        where: { id: existing.id },
        data: { plannedQuantity: existing.plannedQuantity + trim },
      });
    } else {
      await prisma.dailyTask.create({
        data: { orderItemId: task.orderItemId, teamId, date: nextDay, plannedQuantity: trim },
      });
    }

    moved.push({ orderItemId: task.orderItemId, qty: trim });
    excess -= trim;
  }

  res.json({ moved: moved.reduce((s, m) => s + m.qty, 0), nextDay: nextDay.toISOString().slice(0, 10), tasks: moved });
});

// Получить категории для бригады
app.get("/teams/:teamId/categories", async (req: Request, res: Response) => {
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") {
    return res.status(400).json({ error: "Invalid teamId" });
  }

  const links = await prisma.categoryTeam.findMany({
    where: { teamId },
    include: { category: { include: { workshop: true } } },
  });

  const categories = links.map((link) => (link as { category: unknown }).category);
  res.json(categories);
});

// Назначить бригаду на категорию
app.post("/category-teams", async (req: Request, res: Response) => {
  const { categoryId, teamId } = req.body;

  if (!categoryId || typeof categoryId !== "string") {
    return res.status(400).json({ error: "categoryId is required" });
  }
  if (!teamId || typeof teamId !== "string") {
    return res.status(400).json({ error: "teamId is required" });
  }

  try {
    const link = await prisma.categoryTeam.create({
      data: {
        category: { connect: { id: categoryId } },
        team: { connect: { id: teamId } },
      },
      include: {
        category: { include: { workshop: true } },
        team: true,
      },
    });
    res.status(201).json(link);
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "This team is already assigned to this category" });
    } else {
      res.status(400).json({ error: "Failed to create category-team link" });
    }
  }
});

// Убрать бригаду с категории
app.delete("/category-teams", async (req: Request, res: Response) => {
  const { categoryId, teamId } = req.query;

  if (!categoryId || typeof categoryId !== "string") {
    return res.status(400).json({ error: "categoryId query parameter is required" });
  }
  if (!teamId || typeof teamId !== "string") {
    return res.status(400).json({ error: "teamId query parameter is required" });
  }

  try {
    await prisma.categoryTeam.delete({
      where: {
        categoryId_teamId: {
          categoryId,
          teamId,
        },
      },
    });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Category-team link not found" });
  }
});

// --- Массовое назначение бригады на задачи на день ---

app.post("/daily-tasks/assign-team", async (req: Request, res: Response) => {
  const { taskIds, teamId } = req.body;

  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: "taskIds must be a non-empty array" });
  }

  if (teamId !== null && teamId !== undefined && typeof teamId !== "string") {
    return res.status(400).json({ error: "teamId must be a string or null" });
  }

  try {
    const updateData = teamId === null || teamId === "" ? { teamId: null } : { team: { connect: { id: teamId } } };

    const tasks = await prisma.dailyTask.updateMany({
      where: {
        id: { in: taskIds },
      },
      data: updateData,
    });

    // Получаем обновлённые задачи
    const updatedTasks = await prisma.dailyTask.findMany({
      where: { id: { in: taskIds } },
      include: {
        orderItem: {
          include: {
            order: true,
            product: { include: { category: true } },
          },
        },
        team: true,
      },
    });

    res.json({ count: tasks.count, tasks: updatedTasks });
  } catch (err) {
    res.status(400).json({ error: "Failed to assign team to tasks" });
  }
});

// --- Ввод факта (actualQuantity + comment) ---

// Ввод факта для одной задачи
app.put("/daily-tasks/:id/actual", async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { actualQuantity, comment } = req.body;

  const data: {
    actualQuantity?: number | null;
    comment?: string | null;
  } = {};

  if (actualQuantity !== undefined) {
    if (actualQuantity === null || actualQuantity === "") {
      data.actualQuantity = null;
    } else if (
      typeof actualQuantity === "number" &&
      Number.isInteger(actualQuantity) &&
      actualQuantity >= 0
    ) {
      data.actualQuantity = actualQuantity;
    } else {
      return res.status(400).json({ error: "actualQuantity must be a non-negative integer or null" });
    }
  }

  if (comment !== undefined) {
    data.comment = comment === null || comment === "" ? null : String(comment);
  }

  try {
    const task = await prisma.dailyTask.update({
      where: { id },
      data,
      include: {
        orderItem: {
          include: {
            order: true,
            product: { include: { category: true } },
          },
        },
        team: true,
      },
    });

    // Вычисляем «к обеспечению» для позиции заказа
    const remaining = await calculateRemainingQuantity(task.orderItemId);
    const orderItem = (task as { orderItem: Record<string, unknown> }).orderItem;

    res.json({
      ...task,
      orderItem: orderItem
        ? { ...orderItem, remainingQuantity: remaining }
        : { remainingQuantity: remaining },
    });
  } catch (err) {
    res.status(404).json({ error: "Daily task not found" });
  }
});

// Массовый ввод факта для нескольких задач
app.post("/daily-tasks/actual", async (req: Request, res: Response) => {
  const { updates } = req.body;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: "updates must be a non-empty array" });
  }

  const results = [];

  for (const update of updates) {
    const { taskId, actualQuantity, comment } = update;

    if (!taskId || typeof taskId !== "string") {
      results.push({ taskId: taskId || "unknown", error: "taskId is required" });
      continue;
    }

    const data: {
      actualQuantity?: number | null;
      comment?: string | null;
    } = {};

    if (actualQuantity !== undefined) {
      if (actualQuantity === null || actualQuantity === "") {
        data.actualQuantity = null;
      } else if (
        typeof actualQuantity === "number" &&
        Number.isInteger(actualQuantity) &&
        actualQuantity >= 0
      ) {
        data.actualQuantity = actualQuantity;
      } else {
        results.push({ taskId, error: "actualQuantity must be a non-negative integer or null" });
        continue;
      }
    }

    if (comment !== undefined) {
      data.comment = comment === null || comment === "" ? null : String(comment);
    }

    try {
      const task = await prisma.dailyTask.update({
        where: { id: taskId },
        data,
        include: {
          orderItem: {
            include: {
              order: true,
              product: { include: { category: true } },
            },
          },
          team: true,
        },
      });

      // Вычисляем «к обеспечению» для позиции заказа
      const remaining = await calculateRemainingQuantity(task.orderItemId);

      results.push({
        taskId,
        success: true,
        task: {
          ...task,
          orderItem: {
            ...task.orderItem,
            remainingQuantity: remaining,
          },
        },
      });
    } catch (err) {
      results.push({ taskId, error: "Task not found" });
    }
  }

  res.json({ results });
});

// --- Автопланирование ---

// Автопланирование одной позиции заказа
app.post("/order-items/:id/auto-plan", async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { startDate, preferredTeamId } = req.body;

  try {
    const options: { startDate?: Date; preferredTeamId?: string } = {};

    if (startDate) {
      const date = new Date(startDate);
      if (isNaN(date.getTime())) {
        return res.status(400).json({ error: "Invalid startDate format" });
      }
      options.startDate = date;
    }

    if (preferredTeamId && typeof preferredTeamId === "string") {
      options.preferredTeamId = preferredTeamId;
    }

    const result = await autoPlanOrderItem(id, options);

    res.json({
      orderItemId: id,
      tasksCreated: result.tasks.length,
      tasks: result.tasks,
      overloaded: result.overloaded,
      message: result.overloaded
        ? "Planning completed, but some tasks extend beyond due date"
        : "Planning completed successfully",
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to auto-plan order item" });
  }
});

// Автопланирование всего заказа
app.post("/orders/:id/auto-plan", async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { startDate, preferredTeamId } = req.body;

  try {
    // Получаем все позиции заказа
    const orderItems = await prisma.orderItem.findMany({
      where: { orderId: id },
      include: {
        order: true,
        product: { include: { category: true } },
      },
    });

    if (orderItems.length === 0) {
      return res.status(400).json({ error: "Order has no items" });
    }

    const options: { startDate?: Date; preferredTeamId?: string } = {};

    if (startDate) {
      const date = new Date(startDate);
      if (isNaN(date.getTime())) {
        return res.status(400).json({ error: "Invalid startDate format" });
      }
      options.startDate = date;
    }

    if (preferredTeamId && typeof preferredTeamId === "string") {
      options.preferredTeamId = preferredTeamId;
    }

    const results = await Promise.all(
      orderItems.map(async (item) => {
        const product = (item as { product: { code: string } }).product;
        try {
          const result = await autoPlanOrderItem(item.id, options);
          return {
            orderItemId: item.id,
            productCode: product.code,
            success: true,
            tasksCreated: result.tasks.length,
            overloaded: result.overloaded,
          };
        } catch (err: any) {
          return {
            orderItemId: item.id,
            productCode: product.code,
            success: false,
            error: err.message,
          };
        }
      })
    );

    const successful = results.filter((r) => r.success).length;
    const overloaded = results.filter((r) => r.success && r.overloaded).length;

    res.json({
      orderId: id,
      totalItems: orderItems.length,
      successful,
      failed: orderItems.length - successful,
      overloaded,
      results,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to auto-plan order" });
  }
});

// --- Аналитика планирования ---

// Перегрузка: задачи, которые не успеем к сроку
app.get("/planning/overload", async (req: Request, res: Response) => {
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;

  const dateFrom = dateFromStr ? new Date(dateFromStr) : new Date();
  const dateTo = dateToStr ? new Date(dateToStr) : null;

  const where: any = {
    orderItem: {
      order: {
        dueDate: { not: null },
      },
    },
  };

  if (dateTo) {
    where.date = { gte: dateFrom, lte: dateTo };
  } else {
    where.date = { gte: dateFrom };
  }

  const tasks = await prisma.dailyTask.findMany({
    where,
    include: {
      orderItem: {
        include: {
          order: true,
          product: { include: { category: { include: { workshop: true } } } },
        },
      },
      team: true,
    },
  });

  // Фильтруем задачи, которые после dueDate
  const overloaded = tasks.filter((task) => {
    const dueDate = task.orderItem.order.dueDate;
    if (!dueDate) return false;
    const taskDate = new Date(task.date);
    const due = new Date(dueDate);
    return taskDate > due;
  });

  res.json({
    count: overloaded.length,
    tasks: overloaded,
  });
});

// Недогрузка: бригады, загруженные менее чем на 100%
app.get("/planning/underload", async (req: Request, res: Response) => {
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;

  if (!dateFromStr || !dateToStr) {
    return res.status(400).json({ error: "dateFrom and dateTo are required (YYYY-MM-DD)" });
  }

  const dateFrom = new Date(dateFromStr);
  const dateTo = new Date(dateToStr);

  if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  // Получаем все задачи в диапазоне дат
  const tasks = await prisma.dailyTask.findMany({
    where: {
      date: { gte: dateFrom, lte: dateTo },
      teamId: { not: null },
    },
    include: {
      team: true,
      orderItem: {
        include: {
          product: { include: { category: true } },
        },
      },
    },
  });

  // Группируем по бригаде и дате, считаем нагрузку в долях бригадо-дня
  const teamLoads: Record<
    string,
    Record<
      string,
      {
        teamId: string;
        teamName: string;
        date: string;
        planned: number;
        loadFraction: number;
        utilization: number;
      }
    >
  > = {};

  for (const task of tasks) {
    const tid = task.teamId;
    if (!tid) continue;

    const dateStr = task.date.toISOString().split("T")[0];
    if (!dateStr) continue;
    const category = (task.orderItem as { product: { category: { capacityPerTeamPerDay: number } } }).product.category;
    const cap = category.capacityPerTeamPerDay;

    if (!teamLoads[tid]) {
      teamLoads[tid] = {};
    }

    if (!teamLoads[tid][dateStr]) {
      teamLoads[tid][dateStr] = {
        teamId: tid,
        teamName: (task.team as { name: string } | null)?.name || "",
        date: dateStr,
        planned: 0,
        loadFraction: 0,
        utilization: 0,
      };
    }

    teamLoads[tid][dateStr].planned += task.plannedQuantity;
    teamLoads[tid][dateStr].loadFraction += cap > 0 ? task.plannedQuantity / cap : 0;
  }

  // Вычисляем utilization и фильтруем недогрузки (< 100%)
  const underloaded: any[] = [];

  for (const teamId of Object.keys(teamLoads)) {
    const byDate = teamLoads[teamId];
    if (!byDate) continue;
    for (const dateStr of Object.keys(byDate)) {
      const load = byDate[dateStr];
      if (!load) continue;
      load.utilization = load.loadFraction * 100;

      // Недогрузка: загружено менее чем на 100%
      if (load.utilization < 100) {
        underloaded.push(load);
      }
    }
  }

  // Сортируем по utilization (по возрастанию - самые недогруженные первыми)
  underloaded.sort((a, b) => a.utilization - b.utilization);

  res.json({
    count: underloaded.length,
    underloaded,
  });
});

// Загрузка бригады по датам
app.get("/planning/team-load", async (req: Request, res: Response) => {
  const teamId = req.query.teamId as string | undefined;
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;

  if (!teamId) {
    return res.status(400).json({ error: "teamId is required" });
  }

  if (!dateFromStr || !dateToStr) {
    return res.status(400).json({ error: "dateFrom and dateTo are required (YYYY-MM-DD)" });
  }

  const dateFrom = new Date(dateFromStr);
  const dateTo = new Date(dateToStr);

  if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  // Получаем задачи бригады
  const tasks = await prisma.dailyTask.findMany({
    where: {
      teamId,
      date: { gte: dateFrom, lte: dateTo },
    },
    include: {
      orderItem: {
        include: {
          product: { include: { category: true } },
        },
      },
    },
  });

  // Группируем по дате и категории
  const loadsByDate: Record<
    string,
    {
      date: string;
      totalLoadFraction: number;
      categories: Record<
        string,
        {
          categoryId: string;
          categoryName: string;
          capacity: number;
          planned: number;
          utilization: number;
        }
      >;
    }
  > = {};

  for (const task of tasks) {
    const dateStr = task.date.toISOString().split("T")[0];
    if (!dateStr) continue;
    const orderItem = task.orderItem as { product: { category: { id: string; name: string; capacityPerTeamPerDay: number } } };
    const category = orderItem.product.category;

    if (!loadsByDate[dateStr]) {
      loadsByDate[dateStr] = {
        date: dateStr,
        totalLoadFraction: 0,
        categories: {},
      };
    }

    const dayLoad = loadsByDate[dateStr]!;
    if (!dayLoad.categories[category.id]) {
      dayLoad.categories[category.id] = {
        categoryId: category.id,
        categoryName: category.name,
        capacity: category.capacityPerTeamPerDay,
        planned: 0,
        utilization: 0,
      };
    }

    const catEntry = dayLoad.categories[category.id];
    if (catEntry) {
      catEntry.planned += task.plannedQuantity;
    }
    dayLoad.totalLoadFraction += category.capacityPerTeamPerDay > 0
      ? task.plannedQuantity / category.capacityPerTeamPerDay
      : 0;
  }

  // Вычисляем utilization по каждой категории
  for (const dateStr of Object.keys(loadsByDate)) {
    const dayLoad = loadsByDate[dateStr];
    if (!dayLoad) continue;
    for (const categoryId of Object.keys(dayLoad.categories)) {
      const cat = dayLoad.categories[categoryId];
      if (cat) cat.utilization = (cat.planned / cat.capacity) * 100;
    }
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
  });

  res.json({
    teamId,
    teamName: team?.name || "",
    dateFrom: dateFromStr,
    dateTo: dateToStr,
    loads: Object.values(loadsByDate),
  });
});

// Аналитика по заказам: что успевается к сроку, что нет
app.get("/planning/orders-status", async (req: Request, res: Response) => {
  const orderId = req.query.orderId as string | undefined;

  const where: any = {
    dueDate: { not: null },
  };

  if (orderId) {
    where.id = orderId;
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      items: {
        include: {
          product: { include: { category: true } },
          dailyTasks: {
            orderBy: { date: "asc" },
          },
        },
      },
    },
    orderBy: { dueDate: "asc" },
  });

  const ordersStatus = await Promise.all(
    orders.map(async (order) => {
      if (!order.dueDate) {
        return {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customer: order.customer,
          dueDate: null,
          status: "no_due_date",
          message: "Order has no due date",
          items: [],
        };
      }

      const dueDate = new Date(order.dueDate);
      dueDate.setHours(23, 59, 59, 999); // Конец дня

      const itemsStatus = await Promise.all(
        order.items.map(async (item) => {
          // Проверяем все задачи позиции
          const tasksAfterDue = item.dailyTasks.filter((task) => {
            const taskDate = new Date(task.date);
            return taskDate > dueDate;
          });

          // Считаем, сколько уже запланировано до срока и после
          const plannedBeforeDue = item.dailyTasks
            .filter((task) => {
              const taskDate = new Date(task.date);
              return taskDate <= dueDate;
            })
            .reduce((sum, task) => sum + task.plannedQuantity, 0);

          const plannedAfterDue = tasksAfterDue.reduce(
            (sum, task) => sum + task.plannedQuantity,
            0
          );

          const totalPlanned = plannedBeforeDue + plannedAfterDue;
          const remaining = item.quantity - totalPlanned;

          // Статус позиции
          let status: "on_time" | "overdue" | "not_planned" | "partial";
          let message: string;

          if (totalPlanned === 0) {
            status = "not_planned";
            message = "Not planned yet";
          } else if (plannedAfterDue > 0 || remaining > 0) {
            if (plannedAfterDue > 0 && remaining > 0) {
              status = "overdue";
              message = `Partially planned, ${plannedAfterDue} after due date, ${remaining} not planned`;
            } else if (plannedAfterDue > 0) {
              status = "overdue";
              message = `${plannedAfterDue} items planned after due date`;
            } else {
              status = "partial";
              message = `${remaining} items not planned yet`;
            }
          } else {
            status = "on_time";
            message = "All items planned before due date";
          }

          return {
            orderItemId: item.id,
            productCode: item.product.code,
            productName: item.product.name,
            quantity: item.quantity,
            plannedBeforeDue,
            plannedAfterDue,
            totalPlanned,
            remaining,
            status,
            message,
            tasksAfterDue: tasksAfterDue.map((task) => ({
              taskId: task.id,
              date: task.date,
              plannedQuantity: task.plannedQuantity,
            })),
          };
        })
      );

      // Статус заказа: если хотя бы одна позиция не успевает - заказ не успевает
      const hasOverdue = itemsStatus.some((item) => item.status === "overdue");
      const hasNotPlanned = itemsStatus.some((item) => item.status === "not_planned");
      const hasPartial = itemsStatus.some((item) => item.status === "partial");

      let orderStatus: "on_time" | "overdue" | "not_planned" | "partial";
      let orderMessage: string;

      if (hasNotPlanned) {
        orderStatus = "not_planned";
        orderMessage = "Some items are not planned";
      } else if (hasOverdue) {
        orderStatus = "overdue";
        orderMessage = "Some items are planned after due date";
      } else if (hasPartial) {
        orderStatus = "partial";
        orderMessage = "Some items are partially planned";
      } else {
        orderStatus = "on_time";
        orderMessage = "All items are planned and will be ready on time";
      }

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customer: order.customer,
        dueDate: order.dueDate,
        status: orderStatus,
        message: orderMessage,
        items: itemsStatus,
      };
    })
  );

  res.json({
    count: ordersStatus.length,
    orders: ordersStatus,
  });
});

// Перепланирование заказа (удаление старых задач и перепланирование)
app.post("/orders/:id/replan", async (req: Request, res: Response) => {
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { force = false } = req.body; // force: игнорировать текущую загрузку и перепланировать агрессивно

  try {
    // Получаем заказ с позициями
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: { include: { category: true } },
            dailyTasks: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!order.dueDate) {
      return res.status(400).json({ error: "Order must have dueDate for replanning" });
    }

    const orderWithItems = order as typeof order & {
      items: Array<{ id: string; product: { code: string }; dailyTasks: unknown[] }>;
    };

    // Удаляем все старые задачи заказа
    for (const item of orderWithItems.items) {
      if (item.dailyTasks.length > 0) {
        await prisma.dailyTask.deleteMany({
          where: { orderItemId: item.id },
        });
      }
    }

    // Перепланируем все позиции
    const results = await Promise.all(
      orderWithItems.items.map(async (item) => {
        try {
          const result = await autoPlanOrderItem(item.id, force ? {} : { startDate: new Date() });
          return {
            orderItemId: item.id,
            productCode: item.product.code,
            success: true,
            tasksCreated: result.tasks.length,
            overloaded: result.overloaded,
          };
        } catch (err: any) {
          return {
            orderItemId: item.id,
            productCode: item.product.code,
            success: false,
            error: err.message,
          };
        }
      })
    );

    const successful = results.filter((r: { success: boolean }) => r.success).length;
    const overloaded = results.filter((r: { success: boolean; overloaded?: boolean }) => r.success && r.overloaded).length;

    res.json({
      orderId: id,
      orderNumber: order.orderNumber,
      totalItems: orderWithItems.items.length,
      successful,
      failed: orderWithItems.items.length - successful,
      overloaded,
      results,
      message: `Replanned ${successful} items. ${overloaded > 0 ? `${overloaded} items are overloaded.` : "All items planned on time."}`,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to replan order" });
  }
});

// --- Excel Import ---

app.post("/import/excel", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) return res.status(400).json({ error: "Empty workbook" });

    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Find header row — the row containing "Код" and "К обеспечению"
    let headerRowIdx = -1;
    let headerRow: any[] = [];
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const row = rows[i] ?? [];
      if (row.some((v) => typeof v === "string" && v.includes("К обеспечению"))) {
        headerRowIdx = i;
        headerRow = row;
        break;
      }
    }

    if (headerRowIdx === -1) {
      return res.status(400).json({ error: "Cannot find header row with 'К обеспечению'" });
    }

    // Map column names to indices
    const col = (name: string): number =>
      headerRow.findIndex((v) => typeof v === "string" && v.includes(name));

    const iCat = col("Вид номенклатуры");
    const iCode = col("Код");
    const iName = col("Номенклатура");
    const iCustomer = col("Клиент");
    const iOrderNum = col("Номер");
    const iPayment = col("График оплаты");
    const iManager = col("Менеджер");
    const iOrderDate = col("Дата заказа");
    const iApproved = col("Дата согласования");
    const iRemaining = col("К обеспечению");

    if (iCode === -1 || iOrderNum === -1 || iRemaining === -1) {
      return res.status(400).json({ error: "Missing required columns: Код, Номер, К обеспечению" });
    }

    // Get or create default workshop
    let defaultWorkshop = await prisma.workshop.findFirst();
    if (!defaultWorkshop) {
      defaultWorkshop = await prisma.workshop.create({ data: { name: "Основное производство" } });
    }

    // Detect date columns in header (format "DD.MM.YYYY")
    const dateCols: { index: number; date: Date; label: string }[] = [];
    for (let i = 0; i < headerRow.length; i++) {
      const v = headerRow[i];
      if (typeof v === "string") {
        const m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (m) {
          dateCols.push({ index: i, date: new Date(`${m[3]}-${m[2]}-${m[1]}`), label: v });
        }
      }
    }

    // Yesterday's date (for fact recording)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const summary = {
      categories: { created: 0, updated: 0 },
      products: { created: 0, updated: 0 },
      orders: { created: 0, updated: 0 },
      orderItems: { created: 0, updated: 0 },
      dailyTasks: { created: 0, updated: 0 },
      factRecorded: 0,
      skipped: 0,
    };

    // Conflicts: yesterday's task already has actualQuantity set manually
    const conflicts: {
      orderItemId: string;
      orderNumber: string;
      productCode: string;
      taskId: string;
      existingFact: number;
      calculatedFact: number;
    }[] = [];

    // Fact details: positions where fact was auto-recorded
    const factDetails: {
      orderNumber: string;
      productCode: string;
      fact: number;
    }[] = [];

    // Parse dates helper (defined once outside loop)
    function parseExcelDate(val: any): Date | null {
      if (!val) return null;
      if (typeof val === "number") {
        return new Date((val - 25569) * 86400 * 1000);
      }
      if (typeof val === "string") {
        const m = val.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
        if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
        const m2 = val.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T${m2[4]}:${m2[5]}:${m2[6]}`);
      }
      return null;
    }

    const dataRows = rows.slice(headerRowIdx + 1);
    const seenOrderItemIds = new Set<string>();

    for (const row of dataRows) {
      if (!row || !row.length) continue;

      const remaining = row[iRemaining];
      const code = row[iCode];
      const orderNum = row[iOrderNum];

      if (!code || !orderNum || remaining === null || remaining === undefined || Number(remaining) < 0) {
        summary.skipped++;
        continue;
      }

      const categoryName: string = iCat !== -1 ? String(row[iCat] ?? "Без категории") : "Без категории";
      const productName: string = iName !== -1 ? String(row[iName] ?? code) : String(code);
      const customer: string = iCustomer !== -1 ? String(row[iCustomer] ?? "") : "";
      const paymentTerms: string | null = iPayment !== -1 ? String(row[iPayment] ?? "") || null : null;
      const manager: string | null = iManager !== -1 ? String(row[iManager] ?? "") || null : null;
      const quantity = Math.round(Number(remaining));

      const approvedAt = iApproved !== -1 ? parseExcelDate(row[iApproved]) : null;
      const orderDate = iOrderDate !== -1 ? parseExcelDate(row[iOrderDate]) : null;

      const capMatch = categoryName.match(/\((\d+)\s*max\)/i);
      const capacityPerTeamPerDay = capMatch ? parseInt(capMatch[1]!, 10) : 100;

      // Upsert category
      const existingCat = await prisma.productCategory.findFirst({ where: { name: categoryName } });
      let category;
      if (existingCat) {
        category = await prisma.productCategory.update({
          where: { id: existingCat.id },
          data: { capacityPerTeamPerDay },
        });
        summary.categories.updated++;
      } else {
        category = await prisma.productCategory.create({
          data: { name: categoryName, capacityPerTeamPerDay, workshopId: defaultWorkshop.id },
        });
        summary.categories.created++;
      }

      // Upsert product
      const existingProduct = await prisma.product.findUnique({ where: { code: String(code) } });
      let product;
      if (existingProduct) {
        product = await prisma.product.update({
          where: { id: existingProduct.id },
          data: { name: productName, categoryId: category.id },
        });
        summary.products.updated++;
      } else {
        product = await prisma.product.create({
          data: { code: String(code), name: productName, categoryId: category.id },
        });
        summary.products.created++;
      }

      // Upsert order
      const existingOrder = await prisma.order.findUnique({ where: { orderNumber: String(orderNum) } });
      let order;
      if (existingOrder) {
        order = await prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            customer,
            ...(manager !== null && { manager }),
            ...(paymentTerms !== null && { paymentTerms }),
            ...(approvedAt && { approvedAt }),
          },
        });
        summary.orders.updated++;
      } else {
        order = await prisma.order.create({
          data: {
            orderNumber: String(orderNum),
            customer,
            manager: manager ?? null,
            paymentTerms: paymentTerms ?? null,
            approvedAt: approvedAt ?? null,
            description: orderDate ? `Дата заказа: ${orderDate.toLocaleDateString("ru-RU")}` : null,
          },
        });
        summary.orders.created++;
      }

      // Upsert order item
      const existingItem = await prisma.orderItem.findFirst({
        where: { orderId: order.id, productId: product.id },
      });
      let orderItem;
      let isNewItem = false;
      if (existingItem) {
        // Calculate fact: old remaining in DB - new remaining from Excel
        const oldRemaining = await calculateRemainingQuantity(existingItem.id);
        const calculatedFact = oldRemaining - quantity;

        if (calculatedFact > 0) {
          // Check if yesterday's task already has a manually entered fact
          const yesterdayTask = await prisma.dailyTask.findFirst({
            where: {
              orderItemId: existingItem.id,
              date: yesterday,
              actualQuantity: { not: null },
            },
          });

          if (yesterdayTask && yesterdayTask.actualQuantity !== calculatedFact) {
            // Conflict: manual fact differs from calculated
            conflicts.push({
              orderItemId: existingItem.id,
              orderNumber: String(orderNum),
              productCode: String(code),
              taskId: yesterdayTask.id,
              existingFact: yesterdayTask.actualQuantity!,
              calculatedFact,
            });
          } else if (!yesterdayTask) {
            // No task for yesterday yet — find or create and set fact
            // Find team from category-teams
            const categoryTeam = await prisma.categoryTeam.findFirst({
              where: { categoryId: category.id },
            });
            const teamId = categoryTeam?.teamId ?? null;

            const existingYesterdayTask = await prisma.dailyTask.findFirst({
              where: { orderItemId: existingItem.id, date: yesterday },
            });

            if (existingYesterdayTask) {
              await prisma.dailyTask.update({
                where: { id: existingYesterdayTask.id },
                data: { actualQuantity: calculatedFact },
              });
            } else {
              await prisma.dailyTask.create({
                data: {
                  orderItemId: existingItem.id,
                  date: yesterday,
                  plannedQuantity: calculatedFact,
                  actualQuantity: calculatedFact,
                  teamId,
                },
              });
            }
            summary.factRecorded++;
            factDetails.push({
              orderNumber: String(orderNum),
              productCode: String(code),
              fact: calculatedFact,
            });
          }
        }

        await prisma.orderItem.update({
          where: { id: existingItem.id },
          data: { quantity },
        });
        orderItem = existingItem;
        seenOrderItemIds.add(existingItem.id);
        summary.orderItems.updated++;
        isNewItem = false;
      } else {
        orderItem = await prisma.orderItem.create({
          data: { orderId: order.id, productId: product.id, quantity },
        });
        seenOrderItemIds.add(orderItem.id);
        summary.orderItems.created++;
        isNewItem = true;
      }

      // If K=0, the order is fully done — no future plan tasks needed
      if (quantity === 0) continue;

      // Planners own the schedule — only auto-plan on first appearance of an order item.
      // On subsequent imports, task dates/quantities are not touched (only K is updated above).
      if (isNewItem) {
        try {
          const { tasks } = await autoPlanOrderItem(orderItem.id);
          summary.dailyTasks.created += tasks.length;
        } catch {
          // No teams configured for this category — leave unplanned, will appear in unplanned list
        }
      }
    }

    // Detect order items that were planned for yesterday with no fact AND disappeared from this import.
    // Typical cause: K→0, ERP excluded the row — last-batch production wasn't captured.
    const possiblyCompleted: { orderItemId: string; orderNumber: string; productCode: string; remainingInDb: number }[] = [];
    if (seenOrderItemIds.size > 0) {
      const yesterdayPlanned = await prisma.dailyTask.findMany({
        where: {
          date: yesterday,
          plannedQuantity: { gt: 0 },
          actualQuantity: null,
        },
        include: {
          orderItem: {
            include: { order: true, product: true },
          },
        },
      });
      for (const task of yesterdayPlanned) {
        if (!seenOrderItemIds.has(task.orderItemId) && task.orderItem.quantity > 0) {
          possiblyCompleted.push({
            orderItemId: task.orderItemId,
            orderNumber: task.orderItem.order.orderNumber,
            productCode: task.orderItem.product.code,
            remainingInDb: task.orderItem.quantity,
          });
        }
      }
    }

    // Compute unplanned remainders: items where K > Σ(future planned tasks)
    const todayBoundary = new Date();
    todayBoundary.setHours(0, 0, 0, 0);
    const unplanned: { orderItemId: string; orderNumber: string; productCode: string; remaining: number; planned: number; gap: number }[] = [];
    if (seenOrderItemIds.size > 0) {
      const itemsWithTasks = await prisma.orderItem.findMany({
        where: { id: { in: [...seenOrderItemIds] }, quantity: { gt: 0 } },
        include: {
          order: true,
          product: true,
          dailyTasks: { where: { date: { gte: todayBoundary }, actualQuantity: null } },
        },
      });
      for (const item of itemsWithTasks) {
        const plannedSum = item.dailyTasks.reduce((s, t) => s + t.plannedQuantity, 0);
        if (item.quantity > plannedSum) {
          unplanned.push({
            orderItemId: item.id,
            orderNumber: item.order.orderNumber,
            productCode: item.product.code,
            remaining: item.quantity,
            planned: plannedSum,
            gap: item.quantity - plannedSum,
          });
        }
      }
    }

    res.json({ summary, conflicts, factDetails, possiblyCompleted, unplanned });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Import failed" });
  }
});

// --- 1C Import (JSON) ---

interface OneCImportRow {
  categoryName: string;
  productCode: string;
  productName?: string;
  customer?: string;
  orderNumber: string;
  paymentTerms?: string;
  manager?: string;
  orderDate?: string;
  approvedAt?: string;
  remaining: number;
}

app.post("/import/1c", async (req: Request, res: Response) => {
  try {
    const rows: OneCImportRow[] = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Body must be a non-empty array of rows" });
    }

    // Validate required fields
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!r.categoryName || !r.productCode || !r.orderNumber || r.remaining == null) {
        return res.status(400).json({
          error: `Row ${i}: missing required fields (categoryName, productCode, orderNumber, remaining)`,
        });
      }
    }

    function parseDate(val: string | undefined): Date | null {
      if (!val) return null;
      const m = val.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
      if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
      const iso = Date.parse(val);
      if (!isNaN(iso)) return new Date(iso);
      return null;
    }

    // Get or create default workshop
    let defaultWorkshop = await prisma.workshop.findFirst();
    if (!defaultWorkshop) {
      defaultWorkshop = await prisma.workshop.create({ data: { name: "Основное производство" } });
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const summary = {
      categories: { created: 0, updated: 0 },
      products: { created: 0, updated: 0 },
      orders: { created: 0, updated: 0 },
      orderItems: { created: 0, updated: 0 },
      factRecorded: 0,
      skipped: 0,
    };

    const conflicts: {
      orderItemId: string;
      orderNumber: string;
      productCode: string;
      taskId: string;
      existingFact: number;
      calculatedFact: number;
    }[] = [];

    const factDetails: { orderNumber: string; productCode: string; fact: number }[] = [];

    for (const row of rows) {
      const quantity = Math.round(Number(row.remaining));
      if (quantity < 0) {
        summary.skipped++;
        continue;
      }

      const categoryName = row.categoryName.trim();
      const productCode = String(row.productCode).trim();
      const productName = row.productName?.trim() || productCode;
      const customer = row.customer?.trim() || "";
      const manager = row.manager?.trim() || null;
      const paymentTerms = row.paymentTerms?.trim() || null;
      const approvedAt = parseDate(row.approvedAt);
      const orderDate = parseDate(row.orderDate);

      const capMatch = categoryName.match(/\((\d+)\s*max\)/i);
      const capacityPerTeamPerDay = capMatch ? parseInt(capMatch[1]!, 10) : 100;

      // Upsert category
      const existingCat = await prisma.productCategory.findFirst({ where: { name: categoryName } });
      let category;
      if (existingCat) {
        category = await prisma.productCategory.update({
          where: { id: existingCat.id },
          data: { capacityPerTeamPerDay },
        });
        summary.categories.updated++;
      } else {
        category = await prisma.productCategory.create({
          data: { name: categoryName, capacityPerTeamPerDay, workshopId: defaultWorkshop.id },
        });
        summary.categories.created++;
      }

      // Upsert product
      const existingProduct = await prisma.product.findUnique({ where: { code: productCode } });
      let product;
      if (existingProduct) {
        product = await prisma.product.update({
          where: { id: existingProduct.id },
          data: { name: productName, categoryId: category.id },
        });
        summary.products.updated++;
      } else {
        product = await prisma.product.create({
          data: { code: productCode, name: productName, categoryId: category.id },
        });
        summary.products.created++;
      }

      // Upsert order
      const orderNumber = String(row.orderNumber).trim();
      const existingOrder = await prisma.order.findUnique({ where: { orderNumber } });
      let order;
      if (existingOrder) {
        order = await prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            customer,
            ...(manager !== null && { manager }),
            ...(paymentTerms !== null && { paymentTerms }),
            ...(approvedAt && { approvedAt }),
          },
        });
        summary.orders.updated++;
      } else {
        order = await prisma.order.create({
          data: {
            orderNumber,
            customer,
            manager,
            paymentTerms,
            approvedAt,
            description: orderDate ? `Дата заказа: ${orderDate.toLocaleDateString("ru-RU")}` : null,
          },
        });
        summary.orders.created++;
      }

      // Upsert order item
      const existingItem = await prisma.orderItem.findFirst({
        where: { orderId: order.id, productId: product.id },
      });

      if (existingItem) {
        const oldRemaining = await calculateRemainingQuantity(existingItem.id);
        const calculatedFact = oldRemaining - quantity;

        if (calculatedFact > 0) {
          const yesterdayTask = await prisma.dailyTask.findFirst({
            where: { orderItemId: existingItem.id, date: yesterday, actualQuantity: { not: null } },
          });

          if (yesterdayTask && yesterdayTask.actualQuantity !== calculatedFact) {
            conflicts.push({
              orderItemId: existingItem.id,
              orderNumber,
              productCode,
              taskId: yesterdayTask.id,
              existingFact: yesterdayTask.actualQuantity!,
              calculatedFact,
            });
          } else if (!yesterdayTask) {
            const categoryTeam = await prisma.categoryTeam.findFirst({ where: { categoryId: category.id } });
            const teamId = categoryTeam?.teamId ?? null;

            const existingYesterdayTask = await prisma.dailyTask.findFirst({
              where: { orderItemId: existingItem.id, date: yesterday },
            });

            if (existingYesterdayTask) {
              await prisma.dailyTask.update({
                where: { id: existingYesterdayTask.id },
                data: { actualQuantity: calculatedFact },
              });
            } else {
              await prisma.dailyTask.create({
                data: {
                  orderItemId: existingItem.id,
                  date: yesterday,
                  plannedQuantity: calculatedFact,
                  actualQuantity: calculatedFact,
                  teamId,
                },
              });
            }
            summary.factRecorded++;
            factDetails.push({ orderNumber, productCode, fact: calculatedFact });
          }
        }

        await prisma.orderItem.update({ where: { id: existingItem.id }, data: { quantity } });
        summary.orderItems.updated++;
      } else {
        await prisma.orderItem.create({
          data: { orderId: order.id, productId: product.id, quantity },
        });
        summary.orderItems.created++;
      }
      // If K=0, the order is fully done — skip any further processing
      if (quantity === 0) continue;
    }

    res.json({ summary, conflicts, factDetails });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Import failed" });
  }
});

// Resolve import conflict: choose which fact value to keep
app.post("/import/resolve-conflict", async (req: Request, res: Response) => {
  try {
    const { taskId, useCalculated, calculatedFact } = req.body as {
      taskId: string;
      useCalculated: boolean;
      calculatedFact: number;
    };

    if (!taskId) return res.status(400).json({ error: "taskId required" });

    if (useCalculated) {
      await prisma.dailyTask.update({
        where: { id: taskId },
        data: { actualQuantity: calculatedFact },
      });
    }
    // If !useCalculated — keep existing fact, do nothing

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Replan queue (sort by approvedAt asc, nulls last) ---

app.post("/planning/replan-queue", async (_req: Request, res: Response) => {
  try {
    // 1. Delete only future unstarted tasks (preserve past history)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deleted = await prisma.dailyTask.deleteMany({
      where: { actualQuantity: null, date: { gte: today } },
    });

    // 2. Get all order items with their orders
    const allItems = await prisma.orderItem.findMany({
      include: { order: true },
    });

    // 3. Calculate remaining for each and filter > 0
    const withRemaining = await Promise.all(
      allItems.map(async (item) => {
        const remaining = await calculateRemainingQuantity(item.id);
        return { item, remaining };
      })
    );

    const toplan = withRemaining
      .filter(({ remaining }) => remaining > 0)
      .sort((a, b) => {
        const dateA = a.item.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const dateB = b.item.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (dateA !== dateB) return dateA - dateB;
        // Fallback: order creation order
        return a.item.order.id.localeCompare(b.item.order.id);
      });

    // 4. Plan sequentially (order matters — each sees load from previous)
    const results: any[] = [];
    let plannedCount = 0;
    let failedCount = 0;
    const affectedOrderIds = new Set<string>();

    for (const { item } of toplan) {
      try {
        const { tasks, overloaded } = await autoPlanOrderItem(item.id);
        results.push({
          orderItemId: item.id,
          success: true,
          tasksCreated: tasks.length,
          overloaded,
        });
        plannedCount++;
        affectedOrderIds.add(item.order.id);
      } catch (err: any) {
        results.push({
          orderItemId: item.id,
          success: false,
          error: err.message,
        });
        failedCount++;
      }
    }

    // 5. Increment replanCount for all affected orders
    if (affectedOrderIds.size > 0) {
      await prisma.order.updateMany({
        where: { id: { in: Array.from(affectedOrderIds) } },
        data: { replanCount: { increment: 1 } },
      });
    }

    res.json({
      message: `Replanned ${plannedCount} order items.${failedCount > 0 ? ` ${failedCount} failed (no teams assigned?).` : ""}`,
      deletedTasks: deleted.count,
      planned: plannedCount,
      failed: failedCount,
      results,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Replan failed" });
  }
});

// Ожидаемые даты завершения заказов на основе текущего плана
app.get("/planning/orders-completion", async (req: Request, res: Response) => {
  const orders = await prisma.order.findMany({
    include: {
      items: {
        include: {
          product: { include: { category: true } },
          dailyTasks: {
            orderBy: { date: "desc" },
            take: 1,
          },
        },
      },
    },
    orderBy: { approvedAt: "asc" },
  });

  const result = await Promise.all(
    orders.map(async (order) => {
      let lastPlannedDate: Date | null = null;
      let totalQuantity = 0;
      let totalPlanned = 0;
      let totalProduced = 0;
      let unplannedItems = 0;

      for (const item of order.items) {
        totalQuantity += item.quantity;

        const produced = await prisma.dailyTask.aggregate({
          where: { orderItemId: item.id, actualQuantity: { not: null } },
          _sum: { actualQuantity: true },
        });
        totalProduced += produced._sum.actualQuantity ?? 0;

        const planned = await prisma.dailyTask.aggregate({
          where: { orderItemId: item.id },
          _sum: { plannedQuantity: true },
        });
        totalPlanned += planned._sum.plannedQuantity ?? 0;

        if (item.dailyTasks.length > 0 && item.dailyTasks[0]) {
          const taskDate = item.dailyTasks[0].date;
          if (!lastPlannedDate || taskDate > lastPlannedDate) {
            lastPlannedDate = taskDate;
          }
        } else {
          unplannedItems++;
        }
      }

      // totalQuantity = Σ K_current (remaining per ERP). originalTotal = K_current + already produced.
      const originalTotal = totalQuantity + totalProduced;
      const remaining = totalQuantity; // K is the current remaining
      const completionPct = originalTotal > 0
        ? Math.round((totalProduced / originalTotal) * 100)
        : 0;

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customer: order.customer,
        manager: order.manager,
        approvedAt: order.approvedAt,
        dueDate: order.dueDate,
        totalItems: order.items.length,
        unplannedItems,
        totalQuantity,
        totalPlanned,
        totalProduced,
        remaining,
        completionPct,
        expectedCompletionDate: lastPlannedDate,
        replanCount: order.replanCount,
      };
    })
  );

  res.json({ count: result.length, orders: result });
});

// ─── Продакшн: раздача фронтенда ─────────────────────────────────────────────

if (IS_PROD) {
  const frontendDist = path.join(__dirname, "../frontend/dist");
  app.use(express.static(frontendDist));
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// ─── Server start ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

