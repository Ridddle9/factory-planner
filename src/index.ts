import express from "express";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import multer from "multer";
import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "path";
import { randomUUID } from "crypto";

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const prisma = new PrismaClient();

const JWT_SECRET = process.env["JWT_SECRET"] ?? "dev-secret-change-in-production";
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const IS_PROD = process.env["NODE_ENV"] === "production";

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
    secure: false,
    sameSite: "lax",
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
    company = await prisma.company.create({ data: { inn: innClean, name: companyName.trim(), syncToken: randomUUID() } });
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

app.get("/admin/users", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { companyId: req.user!.companyId },
    select: { id: true, email: true, role: true, status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users);
});

app.get("/admin/sync-token", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const company = await prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { syncToken: true },
  });
  res.json({ syncToken: company?.syncToken ?? null });
});

app.post("/admin/sync-token/regenerate", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { randomUUID } = await import("crypto");
  const syncToken = randomUUID();
  await prisma.company.update({
    where: { id: req.user!.companyId },
    data: { syncToken },
  });
  res.json({ syncToken });
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

function getNextWorkingDay(date: Date): Date {
  const next = new Date(date);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isWorkingDay(next));
  return next;
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
// load = Σ(plannedQuantity / capacityPerDay) по всем задачам
async function calculateTeamLoad(teamId: string, date: Date): Promise<number> {
  const [tasks, team] = await Promise.all([
    prisma.dailyTask.findMany({
      where: { teamId, date },
      select: {
        plannedQuantity: true,
        orderItem: {
          select: {
            product: {
              select: {
                capacityPerDay: true,
                category: { select: { capacityPerTeamPerDay: true } },
              },
            },
          },
        },
      },
    }),
    prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }),
  ]);

  const headcount = team?.headcount ?? 1;
  return tasks.reduce((sum, task) => {
    const capPerPerson = task.orderItem.product.capacityPerDay
      ?? task.orderItem.product.category.capacityPerTeamPerDay;
    const cap = capPerPerson * headcount;
    return sum + (cap > 0 ? task.plannedQuantity / cap : 0);
  }, 0);
}

// Helper: получить доступные бригады для категории
async function getAvailableTeamsForCategory(categoryId: string, companyId: string): Promise<string[]> {
  const links = await prisma.categoryTeam.findMany({
    where: { categoryId, team: { companyId } },
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

// Helper: сжать план позиции заказа влево (после ручного переноса на позднюю дату)
async function compactOrderItem(orderItemId: string, preserveDate?: Date): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // If the user manually placed a task on preserveDate, keep it untouched
  let preservedQty = 0;
  if (preserveDate) {
    const preserved = await prisma.dailyTask.findUnique({
      where: { orderItemId_date: { orderItemId, date: preserveDate } },
      select: { plannedQuantity: true },
    });
    preservedQty = preserved?.plannedQuantity ?? 0;

    await prisma.dailyTask.deleteMany({
      where: {
        orderItemId,
        date: { gte: today, not: preserveDate },
        actualQuantity: null,
      },
    });
  } else {
    await prisma.dailyTask.deleteMany({
      where: { orderItemId, date: { gte: today }, actualQuantity: null },
    });
  }

  try {
    const planOpts: { startDate: Date; skipDates?: Date[]; reservedQty?: number } = {
      startDate: today,
      reservedQty: preservedQty,
    };
    if (preserveDate) planOpts.skipDates = [preserveDate];
    await autoPlanOrderItem(orderItemId, planOpts);
  } catch {
    // нет бригады / категории — оставляем незапланированным
  }
}

// Helper: каскадный сдвиг вправо (после ручного переноса на раннюю дату)
async function cascadeShiftRight(teamId: string, startDate: Date, maxIterations = 60): Promise<number> {
  let movedCount = 0;
  const teamHeadcount = (await prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }))?.headcount ?? 1;

  const processDay = async (date: Date, iteration: number): Promise<void> => {
    if (iteration > maxIterations) return;

    const capOverride = await prisma.teamDayCapacity.findUnique({
      where: { teamId_date: { teamId, date } },
    });
    const effectiveFactor = capOverride?.factor ?? 1.0;

    const tasks = await prisma.dailyTask.findMany({
      where: { teamId, date, actualQuantity: null },
      include: {
        orderItem: {
          include: {
            product: { include: { category: true } },
            order: { select: { approvedAt: true, priority: true, raytecDate: true } },
          },
        },
      },
    });
    if (tasks.length === 0) return;

    let totalLoad = 0;
    for (const t of tasks) {
      const cap = (t.orderItem.product.capacityPerDay ?? t.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      totalLoad += cap > 0 ? t.plannedQuantity / cap : 0;
    }
    if (totalLoad <= effectiveFactor + 0.0001) return;

    // Only shift auto-planned tasks; manually placed ones stay put
    const shiftable = tasks.filter(t => !t.manuallyPlaced);
    if (shiftable.length === 0) return;

    // Вытесняем наименее приоритетные первыми (высокий priority-номер = низкий приоритет)
    const sorted = [...shiftable].sort((a, b) => {
      const pa = a.orderItem.order.priority ?? 20;
      const pb = b.orderItem.order.priority ?? 20;
      if (pa !== pb) return pb - pa;
      const ra = a.orderItem.order.raytecDate?.getTime() ?? 0;
      const rb = b.orderItem.order.raytecDate?.getTime() ?? 0;
      if (ra !== rb) return rb - ra;
      const ta = a.orderItem.order.approvedAt?.getTime() ?? 0;
      const tb = b.orderItem.order.approvedAt?.getTime() ?? 0;
      return tb - ta;
    });

    let excessLoad = totalLoad - effectiveFactor;
    const nextDay = getNextWorkingDay(date);

    for (const task of sorted) {
      if (excessLoad <= 0.0001) break;
      const cap = (task.orderItem.product.capacityPerDay ?? task.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      const taskLoad = cap > 0 ? task.plannedQuantity / cap : 0;

      let moveQty: number;
      if (taskLoad <= excessLoad + 0.0001) {
        // Move entire task
        moveQty = task.plannedQuantity;
        excessLoad -= taskLoad;
        await prisma.dailyTask.delete({ where: { id: task.id } });
      } else {
        // Move partial (just the excess)
        moveQty = Math.ceil(excessLoad * cap);
        excessLoad = 0;
        await prisma.dailyTask.update({
          where: { id: task.id },
          data: { plannedQuantity: task.plannedQuantity - moveQty },
        });
      }

      movedCount++;
      const existing = await prisma.dailyTask.findUnique({
        where: { orderItemId_date: { orderItemId: task.orderItemId, date: nextDay } },
      });
      if (existing) {
        await prisma.dailyTask.update({
          where: { id: existing.id },
          data: { plannedQuantity: existing.plannedQuantity + moveQty },
        });
      } else {
        await prisma.dailyTask.create({
          data: {
            orderItemId: task.orderItemId,
            teamId: task.teamId,
            date: nextDay,
            plannedQuantity: moveQty,
          },
        });
      }
    }

    await processDay(nextDay, iteration + 1);
  };

  await processDay(startDate, 0);
  return movedCount;
}

// Helper: каскадный сдвиг влево (после ручного переноса на позднюю дату — подтягивает очередь вперёд)
async function cascadeShiftLeft(teamId: string, startDate: Date, maxIterations = 60): Promise<number> {
  let movedCount = 0;
  const teamHeadcount = (await prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }))?.headcount ?? 1;

  const processDay = async (date: Date, iteration: number): Promise<void> => {
    if (iteration > maxIterations) return;
    if (!isWorkingDay(date)) {
      await processDay(getNextWorkingDay(date), iteration + 1);
      return;
    }

    const capOverride = await prisma.teamDayCapacity.findUnique({
      where: { teamId_date: { teamId, date } },
    });
    const effectiveFactor = capOverride?.factor ?? 1.0;

    const currentTasks = await prisma.dailyTask.findMany({
      where: { teamId, date, actualQuantity: null },
      include: { orderItem: { include: { product: { include: { category: true } } } } },
    });

    let currentLoad = 0;
    for (const t of currentTasks) {
      const cap = (t.orderItem.product.capacityPerDay ?? t.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      currentLoad += cap > 0 ? t.plannedQuantity / cap : 0;
    }

    // Day is full — nothing to pull into, but continue forward in case we created a gap earlier
    if (currentLoad >= effectiveFactor - 0.0001) return;

    const nextDay = getNextWorkingDay(date);
    const nextDayTasks = await prisma.dailyTask.findMany({
      where: { teamId, date: nextDay, actualQuantity: null, manuallyPlaced: false },
      include: {
        orderItem: {
          include: {
            product: { include: { category: true } },
            order: { select: { approvedAt: true, priority: true, raytecDate: true } },
          },
        },
      },
    });

    if (nextDayTasks.length === 0) {
      // Nothing to pull from nextDay — look further
      await processDay(nextDay, iteration + 1);
      return;
    }

    // Тянем наиболее приоритетные первыми (низкий priority-номер = высокий приоритет)
    const sorted = [...nextDayTasks].sort((a, b) => {
      const pa = a.orderItem.order.priority ?? 20;
      const pb = b.orderItem.order.priority ?? 20;
      if (pa !== pb) return pa - pb;
      const ra = a.orderItem.order.raytecDate?.getTime() ?? 0;
      const rb = b.orderItem.order.raytecDate?.getTime() ?? 0;
      if (ra !== rb) return ra - rb;
      const ta = a.orderItem.order.approvedAt?.getTime() ?? 0;
      const tb = b.orderItem.order.approvedAt?.getTime() ?? 0;
      return ta - tb;
    });

    let freeLoad = effectiveFactor - currentLoad;

    for (const task of sorted) {
      if (freeLoad <= 0.0001) break;
      const cap = (task.orderItem.product.capacityPerDay ?? task.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      const taskLoad = cap > 0 ? task.plannedQuantity / cap : 0;

      let pullQty: number;
      if (taskLoad <= freeLoad + 0.0001) {
        pullQty = task.plannedQuantity;
        freeLoad -= taskLoad;
        await prisma.dailyTask.delete({ where: { id: task.id } });
      } else {
        pullQty = Math.floor(freeLoad * cap);
        if (pullQty <= 0) break;
        freeLoad = 0;
        await prisma.dailyTask.update({
          where: { id: task.id },
          data: { plannedQuantity: task.plannedQuantity - pullQty },
        });
      }

      movedCount++;
      const existing = await prisma.dailyTask.findUnique({
        where: { orderItemId_date: { orderItemId: task.orderItemId, date } },
      });
      if (existing) {
        await prisma.dailyTask.update({
          where: { id: existing.id },
          data: { plannedQuantity: existing.plannedQuantity + pullQty },
        });
      } else {
        await prisma.dailyTask.create({
          data: { orderItemId: task.orderItemId, teamId: task.teamId, date, plannedQuantity: pullQty },
        });
      }
    }

    // nextDay may now have a gap from what we pulled — process it
    await processDay(nextDay, iteration + 1);
  };

  await processDay(startDate, 0);
  return movedCount;
}

// Helper: автопланирование позиции заказа
async function autoPlanOrderItem(
  orderItemId: string,
  options?: { startDate?: Date; preferredTeamId?: string; skipDates?: Date[]; reservedQty?: number }
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
  const capacityPerTeamPerDay = orderItem.product.capacityPerDay
    ?? orderItem.product.category.capacityPerTeamPerDay;
  // Получаем доступные бригады для категории
  const availableTeamIds = await getAvailableTeamsForCategory(orderItem.product.categoryId, orderItem.order.companyId);

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

    currentDate = tomorrow;
  }

  const skipDateMs = new Set((options?.skipDates ?? []).map(d => d.getTime()));

  const tasks: any[] = [];
  let remaining = Math.max(0, quantity - (options?.reservedQty ?? 0));
  let overloaded = false;

  const maxDays = 365; // Защита от бесконечного цикла
  let daysPlanned = 0;

  while (remaining > 0 && daysPlanned < maxDays) {
    // Используем локальные компоненты даты, чтобы избежать сдвига UTC+ (напр. Москва UTC+3)
    const y = currentDate.getFullYear();
    const mo = String(currentDate.getMonth() + 1).padStart(2, "0");
    const d = String(currentDate.getDate()).padStart(2, "0");
    const dateStr = `${y}-${mo}-${d}`;
    const date = new Date(dateStr);

    // Пропускаем даты, которые были вручную поставлены пользователем
    if (skipDateMs.has(date.getTime())) {
      currentDate.setDate(currentDate.getDate() + 1);
      daysPlanned++;
      continue;
    }

    // Пропускаем выходные и российские праздники
    if (!isWorkingDay(date)) {
      currentDate.setDate(currentDate.getDate() + 1);
      daysPlanned++;
      continue;
    }

    // Пропускаем даты, заблокированные для этой категории
    const categoryBlock = await prisma.categoryBlock.findFirst({
      where: {
        categoryId: orderItem.product.categoryId,
        companyId: orderItem.order.companyId,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    });
    if (categoryBlock) {
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
    // Мощность бригады = на 1 человека × численность бригады
    const teamHeadcount = (await prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }))?.headcount ?? 1;
    const effectiveCapacity = capacityPerTeamPerDay * teamHeadcount;
    // Свободная ёмкость в штуках для текущей категории
    const availableFraction = Math.max(0, effectiveFraction - currentLoadFraction);
    const available = Math.round(availableFraction * effectiveCapacity);

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

// ─── Синхронизация с 1С (без JWT, своя авторизация) ─────────────────────────

function parseCapacity(name: string): number {
  const m = name.match(/(\d+)\s*max|max\s*(\d+)/i);
  if (!m) return 220;
  return parseInt((m[1] ?? m[2])!, 10);
}

function mapPriority(p?: string): number {
  if (p === 'Критический') return 5;
  if (p === 'Высокий')     return 10;
  if (p === 'Средний')     return 20;
  if (p === 'Низкий')      return 30;
  return 20;
}


app.post("/sync/1c", async (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"] as string | undefined;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const syncToken = authHeader.slice(7);
  const syncCompany = await prisma.company.findUnique({ where: { syncToken } });
  if (!syncCompany) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }
  const companyId = syncCompany.id;

  const { orders, categories, teams, teamCategories, fact, capacity } = req.body as {
    orders: { ref?: string; number: string; status?: string; customer: string; manager?: string; approvedAt?: string; description?: string; paymentTerms?: string; priority?: string; raytecDate?: string; items: { productCode: string; productName: string; categoryName: string; quantity: number }[] }[];
    categories: { code: string; name: string; capacity?: number }[];
    teams: { code: string; name: string; workshopName?: string; headcount?: number }[];
    teamCategories: { categoryName: string; teamName: string; workshopName?: string }[];
    fact: { orderNumber: string; productCode: string; remaining: number }[];
    capacity?: { productCode: string; productName?: string; categoryName?: string; capacityPerDay: number }[];
  };

  const stats = { categories: 0, teams: 0, products: 0, orders: 0, orderItems: 0, categoryTeamLinks: 0, factRecords: 0, capacityRecords: 0 };
  const factSkipped = { noOrder: 0, noProduct: 0, noOrderItem: 0 };

  console.log("[sync/1c] received:", {
    orders: orders?.length ?? 0,
    categories: categories?.length ?? 0,
    teams: teams?.length ?? 0,
    teamCategories: teamCategories?.length ?? 0,
    fact: fact?.length ?? 0,
    capacity: capacity?.length ?? 0,
    sampleTeams: teams?.slice(0, 5).map(t => t.name),
    orderNumbers: orders?.map(o => o.number),
  });
  // Полный дамп тела запроса — для отладки структуры данных от 1С
  console.log("[sync/1c] raw body:", JSON.stringify(req.body, null, 2));

  let defaultWorkshop = await prisma.workshop.findFirst({ where: { name: "1С", companyId } });
  if (!defaultWorkshop) {
    defaultWorkshop = await prisma.workshop.create({ data: { name: "1С", companyId } });
  }

  const categoryMap = new Map<string, string>();
  for (const cat of (categories ?? [])) {
    const capValue = cat.capacity ?? parseCapacity(cat.name);
    const existing = await prisma.productCategory.findUnique({ where: { name_companyId: { name: cat.name, companyId } } });
    if (existing) {
      if (existing.capacityPerTeamPerDay !== capValue) {
        await prisma.productCategory.update({ where: { id: existing.id }, data: { capacityPerTeamPerDay: capValue } });
      }
      categoryMap.set(cat.name, existing.id);
    } else {
      const created = await prisma.productCategory.create({
        data: { name: cat.name, capacityPerTeamPerDay: capValue, workshopId: defaultWorkshop.id, companyId },
      });
      categoryMap.set(cat.name, created.id);
      stats.categories++;
    }
  }

  // Создаём участки из workshopName бригад
  const workshopMap = new Map<string, string>();
  workshopMap.set("1С", defaultWorkshop.id);
  for (const t of (teams ?? [])) {
    const wName = t.workshopName?.trim();
    if (!wName || workshopMap.has(wName)) continue;
    const ws = await prisma.workshop.upsert({
      where: { name_companyId: { name: wName, companyId } },
      update: {},
      create: { name: wName, companyId },
    });
    workshopMap.set(wName, ws.id);
  }

  // Если бригады не пришли отдельно — извлекаем уникальные имена из teamCategories
  const teamsToProcess: { code: string; name: string; workshopName?: string; headcount?: number }[] = (teams && teams.length > 0)
    ? teams
    : [...new Set((teamCategories ?? []).map(tc => tc.teamName).filter(Boolean))].map(n => ({ code: n, name: n }));

  // teamName → workshopId (для обновления workshopId категорий)
  const teamWorkshopMap = new Map<string, string>();
  for (const t of teamsToProcess) {
    const wName = (t as { workshopName?: string }).workshopName?.trim();
    if (wName && workshopMap.has(wName)) {
      teamWorkshopMap.set(t.name, workshopMap.get(wName)!);
    }
  }

  const teamMap = new Map<string, string>();
  for (const t of teamsToProcess) {
    const upserted = await prisma.team.upsert({
      where: { name_companyId: { name: t.name, companyId } },
      update: { headcount: t.headcount ?? 1 },
      create: { name: t.name, companyId, headcount: t.headcount ?? 1 },
    });
    teamMap.set(t.name, upserted.id);
    stats.teams++;
  }

  const ACTIVE_STATUSES = new Set(['КОбеспечению', 'КОтгрузке']);

  // Деактивировать заказы которых нет в текущем синке
  const incomingOrderRefs = new Set((orders ?? []).filter(o => o.ref).map(o => o.ref as string));
  const incomingOrderNumbers = new Set((orders ?? []).map(o => o.number));
  if (incomingOrderRefs.size > 0) {
    await prisma.order.updateMany({
      where: { companyId, active: true, orderRef: { notIn: Array.from(incomingOrderRefs) } },
      data: { active: false },
    });
  } else if (incomingOrderNumbers.size > 0) {
    await prisma.order.updateMany({
      where: { companyId, active: true, orderNumber: { notIn: Array.from(incomingOrderNumbers) } },
      data: { active: false },
    });
  }

  const todayMs = (() => {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    msk.setUTCHours(0, 0, 0, 0);
    return msk.getTime();
  })();

  // Факт обрабатывается ДО заказов: orderItem.quantity на этот момент = НеОбеспечен прошлого синка.
  // Дельта = prevRemaining - currRemaining = сколько произвели с прошлого синка.
  for (const factEntry of (fact ?? [])) {
    const { orderNumber, productCode, remaining } = factEntry;
    if (!orderNumber || !productCode || remaining == null) continue;

    const order = await prisma.order.findFirst({ where: { orderNumber, companyId, active: true } });
    if (!order) { factSkipped.noOrder++; continue; }

    const product = await prisma.product.findUnique({ where: { code_companyId: { code: productCode, companyId } } });
    if (!product) { factSkipped.noProduct++; continue; }

    const orderItem = await prisma.orderItem.findFirst({ where: { orderId: order.id, productId: product.id } });
    if (!orderItem) { factSkipped.noOrderItem++; continue; }

    const todayDelta = Math.max(0, orderItem.quantity - Number(remaining));
    if (todayDelta <= 0) continue;

    await prisma.dailyTask.upsert({
      where: { orderItemId_date: { orderItemId: orderItem.id, date: new Date(todayMs) } },
      update: { actualQuantity: todayDelta },
      create: { orderItemId: orderItem.id, date: new Date(todayMs), plannedQuantity: 0, actualQuantity: todayDelta },
    });
    stats.factRecords++;
  }

  for (const orderData of (orders ?? [])) {
    const isActive = !orderData.status || ACTIVE_STATUSES.has(orderData.status);
    const ref = orderData.ref as string | undefined;

    const orderFields = {
      orderNumber: orderData.number,
      customer: orderData.customer,
      manager: orderData.manager ?? null,
      approvedAt: orderData.approvedAt ? new Date(orderData.approvedAt) : null,
      description: orderData.description ?? null,
      paymentTerms: orderData.paymentTerms ?? null,
      active: isActive,
      priority: mapPriority(orderData.priority),
      raytecDate: orderData.raytecDate ? new Date(orderData.raytecDate) : null,
    };

    const existing = ref
      ? await prisma.order.findFirst({ where: { orderRef: ref, companyId } })
      : await prisma.order.findFirst({ where: { orderNumber: orderData.number, companyId } });

    const order = existing
      ? await prisma.order.update({ where: { id: existing.id }, data: orderFields })
      : await prisma.order.create({ data: { ...orderFields, orderRef: ref ?? null, companyId } });
    stats.orders++;

    const syncedProductIds: string[] = [];

    for (const itemData of (orderData.items ?? [])) {
      let categoryId = categoryMap.get(itemData.categoryName);
      if (!categoryId) {
        const capacity = parseCapacity(itemData.categoryName);
        const cat = await prisma.productCategory.upsert({
          where: { name_companyId: { name: itemData.categoryName, companyId } },
          update: {},
          create: { name: itemData.categoryName, capacityPerTeamPerDay: capacity, workshopId: defaultWorkshop.id, companyId },
        });
        categoryId = cat.id;
        categoryMap.set(itemData.categoryName, categoryId);
      }

      const product = await prisma.product.upsert({
        where: { code_companyId: { code: itemData.productCode, companyId } },
        update: { name: itemData.productName, categoryId },
        create: { code: itemData.productCode, name: itemData.productName, categoryId, companyId },
      });
      stats.products++;
      syncedProductIds.push(product.id);

      const existingItem = await prisma.orderItem.findFirst({
        where: { orderId: order.id, productId: product.id },
      });
      if (existingItem) {
        await prisma.orderItem.update({ where: { id: existingItem.id }, data: { quantity: itemData.quantity } });
      } else {
        await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, quantity: itemData.quantity } });
      }
      stats.orderItems++;
    }

    // Удаляем позиции которые BSL больше не присылает (например, стали СоСклада)
    await prisma.orderItem.deleteMany({
      where: { orderId: order.id, productId: { notIn: syncedProductIds } },
    });
  }

  await prisma.categoryTeam.deleteMany({ where: { category: { companyId } } });

  const seenLinks = new Set<string>();
  for (const tc of (teamCategories ?? [])) {
    const categoryId = categoryMap.get(tc.categoryName);
    if (!categoryId) continue;

    const teamId = teamMap.get(tc.teamName);
    if (!teamId) continue;

    const key = `${categoryId}|${teamId}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);

    await prisma.categoryTeam.upsert({
      where: { categoryId_teamId: { categoryId, teamId } },
      update: {},
      create: { categoryId, teamId },
    });
    stats.categoryTeamLinks++;

    // Обновляем workshopId категории если она всё ещё на дефолтном "1С"
    const wsId = teamWorkshopMap.get(tc.teamName);
    if (wsId && wsId !== defaultWorkshop.id) {
      await prisma.productCategory.updateMany({
        where: { id: categoryId, workshopId: defaultWorkshop.id },
        data: { workshopId: wsId },
      });
    }
  }

  for (const cap of (capacity ?? [])) {
    if (!cap.productCode) continue;

    // Upsert product from capacity data (covers products with no active orders)
    const catName = cap.categoryName?.trim();
    const prodName = cap.productName?.trim();
    if (catName && prodName) {
      const cat = await prisma.productCategory.upsert({
        where: { name_companyId: { name: catName, companyId } },
        update: {},
        create: { name: catName, companyId, capacityPerTeamPerDay: 0, workshopId: defaultWorkshop.id },
      });
      await prisma.product.upsert({
        where: { code_companyId: { code: cap.productCode, companyId } },
        update: { name: prodName, categoryId: cat.id },
        create: { code: cap.productCode, name: prodName, categoryId: cat.id, companyId },
      });
    }

    const updated = await prisma.product.updateMany({
      where: { code: cap.productCode, companyId, capacityLocked: false },
      data: { capacityPerDay: cap.capacityPerDay },
    });
    stats.capacityRecords += updated.count;
  }

  const skippedTotal = factSkipped.noOrder + factSkipped.noProduct + factSkipped.noOrderItem;
  if (skippedTotal > 0) {
    console.log(`[sync/1c] fact skipped ${skippedTotal}: noOrder=${factSkipped.noOrder} noProduct=${factSkipped.noProduct} noOrderItem=${factSkipped.noOrderItem}`);
  }
  res.json({ ok: true, stats, factSkipped });
});

// Продакшн: статические файлы фронтенда (до auth, чтобы /index.html не требовал авторизации)
if (IS_PROD) {
  const frontendDist = path.join(__dirname, "../frontend/dist");
  app.use(express.static(frontendDist));
}

// Все роуты ниже требуют авторизации
app.use(requireAuth);

// --- Onboarding seed ---

app.post("/onboarding/seed", requireAdmin, async (req: Request, res: Response) => {
  const cid = req.user!.companyId;

  // Idempotency check
  const existingWorkshop = await prisma.workshop.findFirst({ where: { companyId: cid } });
  if (existingWorkshop) {
    return res.json({ ok: true, skipped: true });
  }

  // Workshop
  const workshop = await prisma.workshop.create({
    data: { name: "Цех сборки", companyId: cid },
  });

  // Category
  const category = await prisma.productCategory.create({
    data: {
      name: "СВЕТИЛЬНИКИ FLORA",
      capacityPerTeamPerDay: 150,
      workshopId: workshop.id,
      companyId: cid,
    },
  });

  // Team
  const team = await prisma.team.create({
    data: { name: "Бригада № 1", companyId: cid },
  });

  // CategoryTeam link
  await prisma.categoryTeam.create({
    data: { categoryId: category.id, teamId: team.id },
  });

  // Products
  const p1 = await prisma.product.create({
    data: { code: "FLORA-01", name: "Светильник FLORA 500×500", categoryId: category.id, companyId: cid },
  });
  const p2 = await prisma.product.create({
    data: { code: "FLORA-02", name: "Светильник FLORA 300×300", categoryId: category.id, companyId: cid },
  });

  // Orders
  const order1 = await prisma.order.create({
    data: {
      orderNumber: "ЗК-001",
      customer: "ООО «Ромашка»",
      manager: "Иванов А.А.",
      companyId: cid,
    },
  });
  const order2 = await prisma.order.create({
    data: {
      orderNumber: "ЗК-002",
      customer: "ООО «Орион»",
      manager: "Петрова И.В.",
      companyId: cid,
    },
  });

  // OrderItems
  const item1 = await prisma.orderItem.create({
    data: { orderId: order1.id, productId: p1.id, quantity: 450 },
  });
  const item2 = await prisma.orderItem.create({
    data: { orderId: order2.id, productId: p2.id, quantity: 300 },
  });

  // Helper: advance a YYYY-MM-DD string to the next Mon–Fri day
  function nextWorkingDay(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString().slice(0, 10);
  }

  // Start from today; if weekend, advance to Monday
  function todayWorkingDateStr(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    let dateStr = `${y}-${m}-${day}`;
    const dt = new Date(dateStr + "T00:00:00.000Z");
    while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) {
      dt.setUTCDate(dt.getUTCDate() + 1);
      dateStr = dt.toISOString().slice(0, 10);
    }
    return dateStr;
  }

  const CAPACITY = 150;

  // DailyTasks for item1: 450 qty → 3 days × 150
  let currentDateStr = todayWorkingDateStr();
  for (let i = 0; i < 3; i++) {
    await prisma.dailyTask.create({
      data: {
        orderItem: { connect: { id: item1.id } },
        team: { connect: { id: team.id } },
        date: new Date(currentDateStr + "T00:00:00.000Z"),
        plannedQuantity: CAPACITY,
      },
    });
    currentDateStr = nextWorkingDay(currentDateStr);
  }

  // DailyTasks for item2: 300 qty → 2 days × 150, starting where item1 left off
  for (let i = 0; i < 2; i++) {
    await prisma.dailyTask.create({
      data: {
        orderItem: { connect: { id: item2.id } },
        team: { connect: { id: team.id } },
        date: new Date(currentDateStr + "T00:00:00.000Z"),
        plannedQuantity: CAPACITY,
      },
    });
    currentDateStr = nextWorkingDay(currentDateStr);
  }

  return res.json({ ok: true });
});

// --- Bulk plan unplanned items ---

app.post("/order-items/plan-unplanned", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items = await prisma.orderItem.findMany({
    where: {
      quantity: { gt: 0 },
      order: { companyId: cid, active: true },
      product: { category: { visible: true, workshop: { visible: true } } },
    },
    include: { dailyTasks: true, order: { select: { approvedAt: true, priority: true, raytecDate: true } } },
    orderBy: [
      { order: { priority: "asc" } },
      { order: { raytecDate: "asc" } },
      { order: { approvedAt: "asc" } },
    ],
  });

  const unplanned = items.filter((item) => {
    // Как у Raytec: "выполнено" — только то, что было явно запланировано и подтверждено.
    // Факт-синк из 1С (plannedQuantity=0) не считается выполненным — это Зарезервировано,
    // а не физически произведённый товар.
    const done = item.dailyTasks
      .filter((t) => t.plannedQuantity > 0 && t.actualQuantity !== null)
      .reduce((s, t) => s + t.actualQuantity!, 0);
    const K = item.quantity - done;
    if (K <= 0) return false;
    const futurePlanned = item.dailyTasks
      .filter((t) => t.date >= today && t.actualQuantity === null)
      .reduce((s, t) => s + t.plannedQuantity, 0);
    return futurePlanned < K;
  });

  let planned = 0;
  let skipped = 0;
  let noTeam = 0;

  for (const item of unplanned) {
    try {
      const { tasks } = await autoPlanOrderItem(item.id);
      if (tasks.length > 0) planned++;
      else skipped++;
    } catch (err: any) {
      if (err?.message?.includes("No teams available")) noTeam++;
      else skipped++;
    }
  }

  res.json({ total: unplanned.length, planned, skipped, noTeam });
});

// --- Workshops ---

app.get("/workshops", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const workshops = await prisma.workshop.findMany({
    where: { companyId: cid, visible: true },
    orderBy: { name: "asc" },
  });
  res.json(workshops);
});

app.post("/workshops", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const workshop = await prisma.workshop.create({
    data: { name, companyId: cid },
  });

  res.status(201).json(workshop);
});

app.put("/workshops/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const existing = await prisma.workshop.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Workshop not found" }); return; }
    const workshop = await prisma.workshop.update({ where: { id }, data: { name } });
    res.json(workshop);
  } catch (err) {
    res.status(404).json({ error: "Workshop not found" });
  }
});

app.delete("/workshops/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.workshop.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Workshop not found" }); return; }
    await prisma.workshop.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Workshop not found" });
  }
});

// --- Product Categories ---

app.get("/categories/no-team", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const categories = await prisma.productCategory.findMany({
    where: { companyId: cid, visible: true, workshop: { visible: true } },
    include: { workshop: true, teams: true },
    orderBy: { name: "asc" },
  });
  const noTeam = categories.filter((c) => c.teams.length === 0);
  res.json(noTeam.map((c) => ({ id: c.id, name: c.name, workshopName: c.workshop.name })));
});

app.get("/categories", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const categories = await prisma.productCategory.findMany({
    where: { companyId: cid, visible: true, workshop: { visible: true } },
    include: { workshop: true },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

app.post("/categories", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
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
        company: { connect: { id: cid } },
      },
    });
    res.status(201).json(category);
  } catch (err) {
    res.status(400).json({ error: "Failed to create category" });
  }
});

app.put("/categories/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;
  const { name, capacityPerTeamPerDay, workshopId, visible } = req.body;

  const data: {
    name?: string;
    capacityPerTeamPerDay?: number;
    workshopId?: string;
    visible?: boolean;
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

  if (visible !== undefined) {
    if (typeof visible !== "boolean") {
      return res.status(400).json({ error: "visible must be a boolean" });
    }
    data.visible = visible;
  }

  try {
    const existing = await prisma.productCategory.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Category not found" }); return; }

    const category = await prisma.productCategory.update({ where: { id }, data });

    // При скрытии категории удаляем все плановые задачи по её позициям
    if (visible === false && existing.visible === true) {
      await prisma.dailyTask.deleteMany({
        where: {
          orderItem: { product: { categoryId: id } },
          actualQuantity: null,
        },
      });
    }

    res.json(category);
  } catch (err) {
    res.status(404).json({ error: "Category not found" });
  }
});

app.delete("/categories/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.productCategory.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Category not found" }); return; }
    await prisma.productCategory.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Category not found" });
  }
});

// --- Category blocks ---

app.get("/categories/:id/blocks", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const categoryId = req.params.id as string;
  const blocks = await prisma.categoryBlock.findMany({
    where: { categoryId, companyId: cid },
    orderBy: { startDate: "asc" },
  });
  res.json(blocks);
});

app.post("/categories/:id/blocks", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const categoryId = req.params.id as string;
  const { startDate, endDate, reason, cascadeTasks } = req.body as {
    startDate?: string; endDate?: string; reason?: string; cascadeTasks?: boolean;
  };

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate и endDate обязательны" }); return;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    res.status(400).json({ error: "Некорректные даты" }); return;
  }

  const cat = await prisma.productCategory.findFirst({ where: { id: categoryId, companyId: cid } });
  if (!cat) { res.status(404).json({ error: "Категория не найдена" }); return; }

  const block = await prisma.categoryBlock.create({
    data: { categoryId, companyId: cid, startDate: start, endDate: end, reason: reason ?? null },
  });

  // Optionally push tasks that fall inside the blocked period to after the block
  if (cascadeTasks) {
    const affectedTasks = await prisma.dailyTask.findMany({
      where: {
        date: { gte: start, lte: end },
        actualQuantity: null,
        manuallyPlaced: false,
        orderItem: { product: { categoryId, companyId: cid } },
      },
      orderBy: { date: "asc" },
    });

    // Sum deleted quantity per orderItem
    const byOrderItem = new Map<string, { qty: number; teamId: string | null }>();
    for (const t of affectedTasks) {
      const cur = byOrderItem.get(t.orderItemId) ?? { qty: 0, teamId: t.teamId };
      cur.qty += t.plannedQuantity;
      byOrderItem.set(t.orderItemId, cur);
    }

    // Delete tasks inside blocked period
    if (affectedTasks.length > 0) {
      await prisma.dailyTask.deleteMany({
        where: { id: { in: affectedTasks.map(t => t.id) } },
      });
    }

    // Pile the deleted quantity onto the first working day after the block, then cascade right
    const dayAfterBlock = getNextWorkingDay(end);
    const teamsToShift = new Set<string>();

    for (const [orderItemId, { qty, teamId }] of byOrderItem) {
      if (qty <= 0) continue;
      const existing = await prisma.dailyTask.findUnique({
        where: { orderItemId_date: { orderItemId, date: dayAfterBlock } },
      });
      if (existing) {
        await prisma.dailyTask.update({
          where: { id: existing.id },
          data: { plannedQuantity: existing.plannedQuantity + qty },
        });
      } else {
        await prisma.dailyTask.create({
          data: { orderItemId, teamId, date: dayAfterBlock, plannedQuantity: qty },
        });
      }
      if (teamId) teamsToShift.add(teamId);
    }

    setImmediate(async () => {
      for (const teamId of teamsToShift) {
        try { await cascadeShiftRight(teamId, dayAfterBlock); } catch { /* ignore */ }
      }
    });
  }

  res.status(201).json(block);
});

app.delete("/category-blocks/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;
  const block = await prisma.categoryBlock.findFirst({ where: { id, companyId: cid } });
  if (!block) { res.status(404).json({ error: "Блок не найден" }); return; }
  await prisma.categoryBlock.delete({ where: { id } });
  res.status(204).send();
});

// --- Products ---

app.get("/products", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const products = await prisma.product.findMany({
    where: { companyId: cid },
    include: { category: true },
    orderBy: { code: "asc" },
  });
  res.json(products);
});

app.post("/products", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
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
        company: { connect: { id: cid } },
      },
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: "Failed to create product" });
  }
});

app.put("/products/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;
  const { code, name, categoryId, capacityPerDay, capacityLocked } = req.body;

  const data: {
    code?: string; name?: string; categoryId?: string;
    capacityPerDay?: number | null; capacityLocked?: boolean;
  } = {};

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
      return res.status(400).json({ error: "categoryId must be a non-empty string" });
    }
    data.categoryId = categoryId;
  }
  if (capacityPerDay !== undefined) {
    if (capacityPerDay === null) {
      data.capacityPerDay = null;
    } else if (typeof capacityPerDay !== "number" || !Number.isInteger(capacityPerDay) || capacityPerDay <= 0) {
      return res.status(400).json({ error: "capacityPerDay must be a positive integer or null" });
    } else {
      data.capacityPerDay = capacityPerDay;
      data.capacityLocked = true; // manual edit → lock automatically
    }
  }
  // Explicit unlock (reset to auto from 1C)
  if (capacityLocked === false) {
    data.capacityLocked = false;
  }

  try {
    const existing = await prisma.product.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Product not found" }); return; }
    const product = await prisma.product.update({ where: { id }, data });
    res.json(product);
  } catch (err) {
    res.status(404).json({ error: "Product not found" });
  }
});

app.delete("/products/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.product.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Product not found" }); return; }
    await prisma.product.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Product not found" });
  }
});

// --- Teams ---

app.get("/teams", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const teams = await prisma.team.findMany({
    where: { companyId: cid },
    orderBy: { name: "asc" },
  });
  res.json(teams);
});

app.post("/teams", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { name } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const team = await prisma.team.create({
      data: { name, companyId: cid },
    });
    res.status(201).json(team);
  } catch (err) {
    res.status(400).json({ error: "Failed to create team" });
  }
});

app.put("/teams/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;
  const { name, headcount } = req.body;

  if (name !== undefined) {
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
  }
  if (headcount !== undefined) {
    if (typeof headcount !== "number" || headcount < 1 || !Number.isInteger(headcount)) {
      return res.status(400).json({ error: "headcount must be a positive integer" });
    }
  }

  try {
    const existing = await prisma.team.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Team not found" }); return; }
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (headcount !== undefined) data.headcount = headcount;
    const team = await prisma.team.update({ where: { id }, data });
    res.json(team);
  } catch (err) {
    res.status(404).json({ error: "Team not found" });
  }
});

app.delete("/teams/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.team.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Team not found" }); return; }
    await prisma.team.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Team not found" });
  }
});

// --- Orders ---

app.get("/orders", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const orders = await prisma.order.findMany({
    where: { companyId: cid, active: true },
    include: { items: { include: { product: true } } },
    orderBy: { orderNumber: "asc" },
  });
  res.json(orders);
});

app.post("/orders", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const {
    orderNumber,
    customer,
    description,
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
        manager: manager || null,
        paymentTerms: paymentTerms || null,
        approvedAt: approvedAt ? new Date(approvedAt) : null,
        companyId: cid,
      },
    });
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: "Failed to create order" });
  }
});

app.put("/orders/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });
  const {
    orderNumber,
    customer,
    description,
    manager,
    paymentTerms,
    approvedAt,
  } = req.body;

  const data: {
    orderNumber?: string;
    customer?: string;
    description?: string | null;
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
    const existing = await prisma.order.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
    const order = await prisma.order.update({ where: { id }, data });
    res.json(order);
  } catch (err) {
    res.status(404).json({ error: "Order not found" });
  }
});

app.delete("/orders/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.order.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
    await prisma.order.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    res.status(404).json({ error: "Order not found" });
  }
});

// --- Order Items ---

app.get("/order-items", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const orderId = req.query.orderId as string | undefined;

  const where = orderId ? { orderId, order: { companyId: cid } } : { order: { companyId: cid } };

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
  const cid = req.user!.companyId;
  const orderItemId = req.query.orderItemId as string | undefined;
  const dateStr = req.query.date as string | undefined;

  const where: any = { orderItem: { order: { companyId: cid } } };

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
  const cid = req.user!.companyId;
  const dateStr = req.query.date as string | undefined;
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;
  const workshopId = req.query.workshopId as string | undefined;
  const teamId = req.query.teamId as string | undefined;
  const orderId = req.query.orderId as string | undefined;
  const categoryId = req.query.categoryId as string | undefined;

  const where: any = { orderItem: { order: { companyId: cid } } };

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
  const cid = req.user!.companyId;
  const dateStr = req.query.date as string | undefined;
  const dateFromStr = req.query.dateFrom as string | undefined;
  const dateToStr = req.query.dateTo as string | undefined;

  const dateWhere: any = { orderItem: { order: { companyId: cid } } };

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
    manuallyPlaced?: boolean;
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
    data.manuallyPlaced = true;
  }

  try {
    // Read old state before update (needed for date-change logic)
    const oldTask = date !== undefined
      ? await prisma.dailyTask.findUnique({ where: { id }, select: { date: true, teamId: true, orderItemId: true } })
      : null;

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

    // Auto-compact / cascade when a date change occurred
    if (oldTask && date !== undefined) {
      const oldDate = oldTask.date;
      const newDate = new Date(date);
      const oldMs = oldDate.getTime();
      const newMs = newDate.getTime();

      if (newMs > oldMs) {
        // Task moved later → compact this orderItem, then pull the queue forward into freed capacity
        const freedTeamId = oldTask.teamId;
        const freedDate = oldDate;
        setImmediate(async () => {
          await compactOrderItem(oldTask.orderItemId, newDate);
          if (freedTeamId) await cascadeShiftLeft(freedTeamId, freedDate);
        });
      } else if (newMs < oldMs) {
        // Task moved earlier → cascade-push excess tasks on the new date rightward
        const effectiveTeamId = (data.teamId !== undefined ? data.teamId : oldTask.teamId) as string | null;
        if (effectiveTeamId) {
          setImmediate(() => cascadeShiftRight(effectiveTeamId, newDate));
        }
      }
    }

    res.json({ ...task, autoAdjust: oldTask && date !== undefined && new Date(date).getTime() !== oldTask.date.getTime() });
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

// --- Очистить весь график (только плановые задачи) ---

app.delete("/daily-tasks", requireAuth, async (req: Request, res: Response) => {
  const companyId = (req as any).user.companyId;
  const { count } = await prisma.dailyTask.deleteMany({
    where: {
      plannedQuantity: { gt: 0 },
      orderItem: { order: { companyId } },
    },
  });
  res.json({ deleted: count });
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
        const da = a.order.approvedAt ? new Date(a.order.approvedAt).getTime() : Infinity;
        const db = b.order.approvedAt ? new Date(b.order.approvedAt).getTime() : Infinity;
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
  const cid = req.user!.companyId;
  const dateStr = req.query.date as string | undefined;
  const teamId = req.query.teamId as string | undefined;

  const where: any = { team: { companyId: cid } };
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
  const cid = req.user!.companyId;
  const { teamId, date, factor, note } = req.body;

  if (!teamId || typeof teamId !== "string") return res.status(400).json({ error: "teamId is required" });
  if (!date) return res.status(400).json({ error: "date is required" });
  if (typeof factor !== "number" || factor < 0 || factor > 1) return res.status(400).json({ error: "factor must be a number between 0 and 1" });

  const dayDate = new Date(date);
  if (isNaN(dayDate.getTime())) return res.status(400).json({ error: "Invalid date" });

  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

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
  const cid = req.user!.companyId;
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });

  try {
    const existing = await prisma.teamDayCapacity.findFirst({ where: { id, team: { companyId: cid } } });
    if (!existing) { res.status(404).json({ error: "Record not found" }); return; }
    await prisma.teamDayCapacity.delete({ where: { id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Record not found" });
  }
});

// --- Category-Team связь (какие бригады работают с какими категориями) ---

app.get("/category-teams", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const categoryId = req.query.categoryId as string | undefined;
  const teamId = req.query.teamId as string | undefined;

  const where: any = { category: { companyId: cid } };

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
  const cid = req.user!.companyId;
  const categoryId = req.params.categoryId as string | undefined;
  if (typeof categoryId !== "string") {
    return res.status(400).json({ error: "Invalid categoryId" });
  }

  const links = await prisma.categoryTeam.findMany({
    where: { categoryId, category: { companyId: cid } },
    include: { team: true },
  });

  const teams = links.map((link) => (link as { team: { id: string; name: string } }).team);
  res.json(teams);
});

// Загрузка бригады на дату + мощность
app.get("/teams/:teamId/load", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") return res.status(400).json({ error: "Invalid teamId" });
  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

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
  const cid = req.user!.companyId;
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") return res.status(400).json({ error: "Invalid teamId" });
  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

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
  const cid = req.user!.companyId;
  const teamId = req.params.teamId as string | undefined;
  if (typeof teamId !== "string") {
    return res.status(400).json({ error: "Invalid teamId" });
  }

  const links = await prisma.categoryTeam.findMany({
    where: { teamId, team: { companyId: cid } },
    include: { category: { include: { workshop: true } } },
  });

  const categories = links.map((link) => (link as { category: unknown }).category);
  res.json(categories);
});

// Назначить бригаду на категорию
app.post("/category-teams", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { categoryId, teamId } = req.body;

  if (!categoryId || typeof categoryId !== "string") {
    return res.status(400).json({ error: "categoryId is required" });
  }
  if (!teamId || typeof teamId !== "string") {
    return res.status(400).json({ error: "teamId is required" });
  }

  const catOwned = await prisma.productCategory.findFirst({ where: { id: categoryId, companyId: cid } });
  if (!catOwned) return res.status(404).json({ error: "Category not found" });
  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

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
  const cid = req.user!.companyId;
  const { categoryId, teamId } = req.query;

  if (!categoryId || typeof categoryId !== "string") {
    return res.status(400).json({ error: "categoryId query parameter is required" });
  }
  if (!teamId || typeof teamId !== "string") {
    return res.status(400).json({ error: "teamId query parameter is required" });
  }

  const catOwned = await prisma.productCategory.findFirst({ where: { id: categoryId, companyId: cid } });
  if (!catOwned) return res.status(404).json({ error: "Category-team link not found" });

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

// Перегрузка: задачи после срока (концепция убрана вместе с dueDate)
app.get("/planning/overload", async (_req: Request, res: Response) => {
  res.json({ count: 0, tasks: [] });
});

// Недогрузка: бригады, загруженные менее чем на 100%
app.get("/planning/underload", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
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
      orderItem: { order: { companyId: cid } },
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
  const cid = req.user!.companyId;
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

  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

  // Получаем задачи бригады
  const tasks = await prisma.dailyTask.findMany({
    where: {
      teamId,
      date: { gte: dateFrom, lte: dateTo },
      orderItem: { order: { companyId: cid } },
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

// Аналитика по заказам: что успевается к сроку, что нет (dueDate удалён)
app.get("/planning/orders-status", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const orderId = req.query.orderId as string | undefined;

  const where: any = { companyId: cid, active: true };
  if (orderId) where.id = orderId;

  const orders = await prisma.order.findMany({
    where,
    include: {
      items: {
        include: {
          product: { include: { category: true } },
          dailyTasks: { orderBy: { date: "asc" } },
        },
      },
    },
    orderBy: { approvedAt: "asc" },
  });

  const ordersStatus = orders.map((order) => {
    const itemsStatus = order.items.map((item) => {
      const totalPlanned = item.dailyTasks.reduce((s, t) => s + t.plannedQuantity, 0);
      const remaining = item.quantity - totalPlanned;
      const status = totalPlanned === 0 ? "not_planned" : remaining > 0 ? "partial" : "on_time";
      return { orderItemId: item.id, productCode: item.product.code, productName: item.product.name, quantity: item.quantity, totalPlanned, remaining, status };
    });
    const status = itemsStatus.some(i => i.status === "not_planned") ? "not_planned"
      : itemsStatus.some(i => i.status === "partial") ? "partial" : "on_time";
    return { orderId: order.id, orderNumber: order.orderNumber, customer: order.customer, status, items: itemsStatus };
  });

  res.json({
    count: ordersStatus.length,
    orders: ordersStatus,
  });
});

// Перепланирование заказа (удаление старых задач и перепланирование)
app.post("/orders/:id/replan", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string | undefined;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { force = false } = req.body; // force: игнорировать текущую загрузку и перепланировать агрессивно

  try {
    // Получаем заказ с позициями
    const order = await prisma.order.findFirst({
      where: { id, companyId: cid },
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
  const cid = req.user!.companyId;
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
    let defaultWorkshop = await prisma.workshop.findFirst({ where: { companyId: cid } });
    if (!defaultWorkshop) {
      defaultWorkshop = await prisma.workshop.create({ data: { name: "Основное производство", companyId: cid } });
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
      const existingCat = await prisma.productCategory.findFirst({ where: { name: categoryName, companyId: cid } });
      let category;
      if (existingCat) {
        category = await prisma.productCategory.update({
          where: { id: existingCat.id },
          data: { capacityPerTeamPerDay },
        });
        summary.categories.updated++;
      } else {
        category = await prisma.productCategory.create({
          data: { name: categoryName, capacityPerTeamPerDay, workshopId: defaultWorkshop.id, companyId: cid },
        });
        summary.categories.created++;
      }

      // Upsert product
      const existingProduct = await prisma.product.findUnique({ where: { code_companyId: { code: String(code), companyId: cid } } });
      let product;
      if (existingProduct) {
        product = await prisma.product.update({
          where: { id: existingProduct.id },
          data: { name: productName, categoryId: category.id },
        });
        summary.products.updated++;
      } else {
        product = await prisma.product.create({
          data: { code: String(code), name: productName, categoryId: category.id, companyId: cid },
        });
        summary.products.created++;
      }

      // Upsert order
      const existingOrder = await prisma.order.findFirst({ where: { orderNumber: String(orderNum), companyId: cid } });
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
            companyId: cid,
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
          orderItem: { order: { companyId: cid } },
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
  const cid = req.user!.companyId;
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
    let defaultWorkshop = await prisma.workshop.findFirst({ where: { companyId: cid } });
    if (!defaultWorkshop) {
      defaultWorkshop = await prisma.workshop.create({ data: { name: "Основное производство", companyId: cid } });
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
      const existingCat = await prisma.productCategory.findFirst({ where: { name: categoryName, companyId: cid } });
      let category;
      if (existingCat) {
        category = await prisma.productCategory.update({
          where: { id: existingCat.id },
          data: { capacityPerTeamPerDay },
        });
        summary.categories.updated++;
      } else {
        category = await prisma.productCategory.create({
          data: { name: categoryName, capacityPerTeamPerDay, workshopId: defaultWorkshop.id, companyId: cid },
        });
        summary.categories.created++;
      }

      // Upsert product
      const existingProduct = await prisma.product.findUnique({ where: { code_companyId: { code: productCode, companyId: cid } } });
      let product;
      if (existingProduct) {
        product = await prisma.product.update({
          where: { id: existingProduct.id },
          data: { name: productName, categoryId: category.id },
        });
        summary.products.updated++;
      } else {
        product = await prisma.product.create({
          data: { code: productCode, name: productName, categoryId: category.id, companyId: cid },
        });
        summary.products.created++;
      }

      // Upsert order
      const orderNumber = String(row.orderNumber).trim();
      const existingOrder = await prisma.order.findFirst({ where: { orderNumber, companyId: cid } });
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
            companyId: cid,
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

app.get("/planning/export-excel", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { from, to } = req.query as { from?: string; to?: string };

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from) dateFilter.gte = new Date(from);
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    dateFilter.lte = toDate;
  }

  const tasks = await prisma.dailyTask.findMany({
    where: {
      orderItem: { order: { companyId: cid } },
      ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
    },
    include: {
      orderItem: {
        include: {
          order: { select: { id: true, orderNumber: true, customer: true, approvedAt: true } },
          product: { include: { category: true } },
        },
      },
      team: true,
    },
    orderBy: [{ date: "asc" }],
  });

  const isoDate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const fmtShort = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;
  const fmtFull = (d: Date | null | undefined) =>
    d ? d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

  // Collect unique ISO dates, sorted
  const dateSet = new Set<string>();
  for (const t of tasks) dateSet.add(isoDate(t.date));
  const isoDates = Array.from(dateSet).sort();

  // Group: order → orderItem
  type ItemData = {
    productCode: string; productName: string;
    categoryName: string; teamName: string;
    byDate: Map<string, number>; totalActual: number;
  };
  type OrderData = {
    orderNumber: string; customer: string;
    approvedAt: Date | null;
    items: Map<string, ItemData>;
  };
  const orderMap = new Map<string, OrderData>();

  for (const t of tasks) {
    const oid = t.orderItem.order.id;
    if (!orderMap.has(oid)) {
      orderMap.set(oid, {
        orderNumber: t.orderItem.order.orderNumber,
        customer: t.orderItem.order.customer,
        approvedAt: t.orderItem.order.approvedAt,
        items: new Map(),
      });
    }
    const order = orderMap.get(oid)!;
    const iid = t.orderItemId;
    if (!order.items.has(iid)) {
      order.items.set(iid, {
        productCode: t.orderItem.product.code,
        productName: t.orderItem.product.name,
        categoryName: t.orderItem.product.category.name,
        teamName: t.team?.name ?? "—",
        byDate: new Map(),
        totalActual: 0,
      });
    }
    const item = order.items.get(iid)!;
    // Prefer a named team over "—" (fact-only tasks have no team)
    if (item.teamName === "—" && t.team?.name) item.teamName = t.team.name;
    const dk = isoDate(t.date);
    if (t.plannedQuantity > 0) item.byDate.set(dk, (item.byDate.get(dk) ?? 0) + t.plannedQuantity);
    item.totalActual += t.actualQuantity ?? 0;
  }

  const sortedOrders = Array.from(orderMap.values()).sort(
    (a, b) => (a.approvedAt?.getTime() ?? 0) - (b.approvedAt?.getTime() ?? 0)
  );

  // Build AOA (array of arrays)
  const FIXED_COLS = ["Заказ", "Клиент", "Артикул", "Товар", "Категория", "Бригада", "Итого план", "Итого факт"];
  const dateHeaders = isoDates.map(fmtShort);
  const aoa: (string | number)[][] = [[...FIXED_COLS, ...dateHeaders]];

  // Track which rows are order headers (for potential styling)
  const orderRowIndexes: number[] = [];

  const unplannedRows: (string | number)[][] = [
    ["Заказ", "Клиент", "Артикул", "Товар", "Категория", "Итого факт"],
  ];

  for (const order of sortedOrders) {
    const plannedItems = Array.from(order.items.values()).filter(i => i.byDate.size > 0);
    const unplannedItems = Array.from(order.items.values()).filter(i => i.byDate.size === 0 && i.totalActual > 0);

    // Unplanned actuals → separate sheet
    for (const item of unplannedItems) {
      unplannedRows.push([
        order.orderNumber, order.customer,
        item.productCode, item.productName, item.categoryName, item.totalActual,
      ]);
    }

    if (plannedItems.length === 0) continue;

    orderRowIndexes.push(aoa.length);
    aoa.push([
      order.orderNumber,
      order.customer,
      "", "", "", "", "", "",
      ...isoDates.map(() => "" as string | number),
    ]);
    for (const item of plannedItems) {
      const totalPlan = Array.from(item.byDate.values()).reduce((s, v) => s + v, 0);
      aoa.push([
        "", "",
        item.productCode,
        item.productName,
        item.categoryName,
        item.teamName,
        totalPlan,
        item.totalActual || "",
        ...isoDates.map(d => item.byDate.get(d) ?? ""),
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Merge Заказ / Клиент across all product rows of each order
  const merges: XLSX.Range[] = [];
  for (let i = 0; i < orderRowIndexes.length; i++) {
    const startRow = orderRowIndexes[i] as number;
    const nextStart = orderRowIndexes[i + 1] as number | undefined;
    const endRow = nextStart !== undefined ? nextStart - 1 : aoa.length - 1;
    if (endRow > startRow) {
      for (const col of [0, 1]) {
        merges.push({ s: { r: startRow, c: col }, e: { r: endRow, c: col } });
      }
    }
  }
  ws["!merges"] = merges;

  // Column widths
  ws["!cols"] = [
    { wch: 20 }, { wch: 24 },
    { wch: 18 }, { wch: 32 }, { wch: 18 }, { wch: 14 },
    { wch: 11 }, { wch: 11 },
    ...isoDates.map(() => ({ wch: 7 })),
  ];

  // Freeze header row + first 2 info columns
  ws["!sheetViews"] = [{ state: "frozen", xSplit: 2, ySplit: 1, topLeftCell: "C2" }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "План производства");
  if (unplannedRows.length > 1) {
    const wsU = XLSX.utils.aoa_to_sheet(unplannedRows);
    wsU["!cols"] = [{ wch: 20 }, { wch: 24 }, { wch: 18 }, { wch: 32 }, { wch: 18 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsU, "Незапланированный факт");
  }

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="plan.xlsx"');
  res.send(buf);
});

app.post("/planning/replan-queue", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  try {
    // 1. Delete only future unstarted tasks (preserve past history)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deleted = await prisma.dailyTask.deleteMany({
      where: { actualQuantity: null, date: { gte: today }, orderItem: { order: { companyId: cid } } },
    });

    // 2. Get all order items with their orders
    const allItems = await prisma.orderItem.findMany({
      where: { order: { companyId: cid } },
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
  const cid = req.user!.companyId;
  const orders = await prisma.order.findMany({
    where: { companyId: cid, active: true },
    include: {
      items: {
        include: {
          product: { include: { category: true } },
          dailyTasks: {
            where: { plannedQuantity: { gt: 0 } },
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

// ─── Факт за день: сводка по бригадам и категориям ───────────────────────────

app.get("/planning/fact-day", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { date } = req.query as { date?: string };
  if (!date) return res.status(400).json({ error: "date required (YYYY-MM-DD)" });

  const dayStart = new Date(date + "T00:00:00.000Z");
  const dayEnd   = new Date(date + "T23:59:59.999Z");

  const tasks = await prisma.dailyTask.findMany({
    where: {
      date: { gte: dayStart, lte: dayEnd },
      actualQuantity: { gt: 0 },
      orderItem: { order: { companyId: cid } },
    },
    include: {
      team: { select: { id: true, name: true } },
      orderItem: {
        include: {
          product: { include: { category: { select: { id: true, name: true } } } },
          order:   { select: { orderNumber: true } },
        },
      },
    },
  });

  // Group by team → category
  const byTeam = new Map<string, {
    teamId: string; teamName: string;
    categories: Map<string, { categoryId: string; categoryName: string; actual: number; items: number }>;
    totalActual: number;
  }>();

  for (const t of tasks) {
    const teamId   = t.team?.id   ?? "no-team";
    const teamName = t.team?.name ?? "Без бригады";
    const catId    = t.orderItem.product.category?.id   ?? "no-cat";
    const catName  = t.orderItem.product.category?.name ?? "Без категории";
    const actual   = t.actualQuantity ?? 0;

    if (!byTeam.has(teamId)) byTeam.set(teamId, { teamId, teamName, categories: new Map(), totalActual: 0 });
    const teamRow = byTeam.get(teamId)!;
    teamRow.totalActual += actual;

    if (!teamRow.categories.has(catId)) teamRow.categories.set(catId, { categoryId: catId, categoryName: catName, actual: 0, items: 0 });
    const catRow = teamRow.categories.get(catId)!;
    catRow.actual += actual;
    catRow.items  += 1;
  }

  const result = Array.from(byTeam.values()).map(row => ({
    teamId:      row.teamId,
    teamName:    row.teamName,
    totalActual: row.totalActual,
    categories:  Array.from(row.categories.values()).sort((a, b) => b.actual - a.actual),
  })).sort((a, b) => b.totalActual - a.totalActual);

  res.json({ date, taskCount: tasks.length, teams: result });
});

// ─── Перенос недодела на сегодня ─────────────────────────────────────────────

app.post("/planning/rollover-shortfall", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;

  const todayMs = (() => {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    msk.setUTCHours(0, 0, 0, 0);
    return msk.getTime();
  })();
  const yesterdayDate = new Date(todayMs - 86400000);
  const todayDate = new Date(todayMs);

  const yesterdayTasks = await prisma.dailyTask.findMany({
    where: {
      date: yesterdayDate,
      actualQuantity: { not: null },
      orderItem: { order: { companyId: cid } },
    },
    include: {
      orderItem: {
        include: {
          product: { include: { category: { select: { capacityPerTeamPerDay: true } } } },
          order: { select: { orderNumber: true } },
        },
      },
    },
  });

  const shortfalls = yesterdayTasks.filter(
    t => t.actualQuantity !== null && t.actualQuantity < t.plannedQuantity
  );

  if (shortfalls.length === 0) {
    return res.json({ rolled: 0, items: [], overloaded: [] });
  }

  const items: { orderNumber: string; productCode: string; shortfall: number }[] = [];
  const overloadedTeams = new Set<string>();

  for (const task of shortfalls) {
    const shortfall = task.plannedQuantity - task.actualQuantity!;
    const { orderItemId, teamId } = task;

    const existing = await prisma.dailyTask.findUnique({
      where: { orderItemId_date: { orderItemId, date: todayDate } },
    });

    if (existing) {
      await prisma.dailyTask.update({
        where: { id: existing.id },
        data: { plannedQuantity: existing.plannedQuantity + shortfall },
      });
    } else {
      await prisma.dailyTask.create({
        data: { orderItemId, teamId, date: todayDate, plannedQuantity: shortfall },
      });
    }

    items.push({
      orderNumber: task.orderItem.order.orderNumber,
      productCode: task.orderItem.product.code,
      shortfall,
    });

    // Check if team is now overloaded on today
    if (teamId) {
      const capacity = task.orderItem.product.category?.capacityPerTeamPerDay;
      if (capacity && capacity > 0) {
        const sum = await prisma.dailyTask.aggregate({
          where: { teamId, date: todayDate, orderItem: { order: { companyId: cid } } },
          _sum: { plannedQuantity: true },
        });
        if ((sum._sum.plannedQuantity ?? 0) > capacity) {
          overloadedTeams.add(teamId);
        }
      }
    }
  }

  res.json({ rolled: items.length, items, overloadedTeams: Array.from(overloadedTeams) });
});

// ─── Незапланированный факт ──────────────────────────────────────────────────

app.get("/planning/unplanned-production", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;

  // Последняя дата с фактом по компании
  const latest = await prisma.dailyTask.findFirst({
    where: {
      actualQuantity: { gt: 0 },
      orderItem: { order: { companyId: cid } },
    },
    orderBy: { date: "desc" },
    select: { date: true },
  });

  if (!latest) return res.json({ date: null, count: 0, items: [] });

  const tasks = await prisma.dailyTask.findMany({
    where: {
      date: latest.date,
      plannedQuantity: 0,
      actualQuantity: { gt: 0 },
      orderItem: { order: { companyId: cid } },
    },
    include: {
      orderItem: {
        include: {
          product: { include: { category: { select: { id: true, name: true } } } },
          order: { select: { orderNumber: true, customer: true } },
        },
      },
    },
    orderBy: { actualQuantity: "desc" },
  });

  const items = tasks.map((t) => ({
    taskId: t.id,
    orderNumber: t.orderItem.order.orderNumber,
    customer: t.orderItem.order.customer,
    productCode: t.orderItem.product.code,
    productName: t.orderItem.product.name,
    categoryName: t.orderItem.product.category?.name ?? null,
    actualQuantity: t.actualQuantity!,
  }));

  res.json({ date: latest.date, count: items.length, items });
});

// ─── Продакшн: SPA fallback ──────────────────────────────────────────────────

if (IS_PROD) {
  const frontendDist = path.join(__dirname, "../frontend/dist");
  app.get("*path", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// ─── Server start ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

