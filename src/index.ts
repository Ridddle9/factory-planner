import express from "express";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import multer from "multer";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { registerAssistant } from "./assistant";

const upload = multer({ storage: multer.memoryStorage() });

const app = express();

// Если задачу меняют не через планировщик (количество или бригада), её точная доля дня
// (loadShare) больше не верна — сбрасываем, загрузка посчитается как plannedQuantity / мощность
function dropStaleLoadShare(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  if (d["loadShare"] !== undefined) return;
  if ("plannedQuantity" in d || "teamId" in d || "team" in d) d["loadShare"] = null;
}

const prisma = new PrismaClient().$extends({
  query: {
    dailyTask: {
      update({ args, query }) { dropStaleLoadShare(args.data); return query(args); },
      updateMany({ args, query }) { dropStaleLoadShare(args.data); return query(args); },
      upsert({ args, query }) { dropStaleLoadShare(args.update); return query(args); },
    },
  },
});

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

// Доля бригадо-дня, которую занимает задача: точная доля от планировщика (loadShare),
// если задачу не меняли руками, иначе plannedQuantity / мощность
function taskLoad(task: { plannedQuantity: number; loadShare: number | null }, cap: number): number {
  if (task.loadShare !== null) return task.loadShare;
  return cap > 0 ? task.plannedQuantity / cap : 0;
}

// Helper: вычислить загрузку бригады на дату в долях бригадо-дня (0.0–1.0+)
// load = Σ доля дня по всем задачам (см. taskLoad)
async function calculateTeamLoad(teamId: string, date: Date): Promise<number> {
  const [tasks, team] = await Promise.all([
    prisma.dailyTask.findMany({
      where: { teamId, date },
      select: {
        plannedQuantity: true,
        loadShare: true,
        orderItem: {
          select: {
            product: {
              select: {
                id: true,
                capacityPerDay: true,
                category: { select: { capacityPerTeamPerDay: true } },
              },
            },
          },
        },
      },
    }),
    prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true, companyId: true } }),
  ]);

  const headcount = team?.headcount ?? 1;
  const loadCompanyId = team?.companyId ?? '';
  const productIds = [...new Set(tasks.map(t => t.orderItem.product.id))];
  const ptcList = productIds.length > 0 && loadCompanyId
    ? await prisma.productTeamCapacity.findMany({
        where: { productId: { in: productIds }, teamId, companyId: loadCompanyId },
        select: { productId: true, capacityPerDay: true },
      })
    : [];
  const ptcMap = new Map(ptcList.map(p => [p.productId, p.capacityPerDay]));
  return tasks.reduce((sum, task) => {
    const ptcCapacity = ptcMap.get(task.orderItem.product.id);
    const capPerPerson = ptcCapacity
      ?? task.orderItem.product.capacityPerDay
      ?? task.orderItem.product.category.capacityPerTeamPerDay;
    return sum + taskLoad(task, capPerPerson * headcount);
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


// ─── Скрытые категории и участки ─────────────────────────────────────────────
// Скрытие — только отображение: синк по-прежнему сохраняет заказы и товары скрытых категорий и участков
// (участок из 1С остаётся скрытым), планировщик их планирует, загрузка бригад их учитывает.
// Интерфейс их не показывает. Категория видна, только если видна она сама и её участок
const VISIBLE_PRODUCT = { category: { visible: true, workshop: { visible: true } } } as const;
// Поля категории для проверки видимости в выборках (select) и сама проверка
const CAT_VISIBILITY = { visible: true, workshop: { select: { visible: true } } } as const;
const catVisible = (c: { visible: boolean; workshop: { visible: boolean } }) => c.visible && c.workshop.visible;

// Бригады, вся работа которых — скрытые категории или участки (нормы, связи с категориями, задачи плана).
// Бригады без какой-либо работы не считаются скрытыми.
async function hiddenTeamIds(companyId: string): Promise<Set<string>> {
  const [hiddenCats, hiddenWorkshops] = await Promise.all([
    prisma.productCategory.count({ where: { companyId, visible: false } }),
    prisma.workshop.count({ where: { companyId, visible: false } }),
  ]);
  if (hiddenCats === 0 && hiddenWorkshops === 0) return new Set();
  const teams = await prisma.team.findMany({
    where: { companyId },
    select: {
      id: true,
      productCapacities: { where: { capacityPerDay: { gt: 0 } }, select: { product: { select: { category: { select: CAT_VISIBILITY } } } } },
      categories: { select: { category: { select: CAT_VISIBILITY } } },
      dailyTasks: { where: { plannedQuantity: { gt: 0 } }, select: { orderItem: { select: { product: { select: { category: { select: CAT_VISIBILITY } } } } } } },
    },
  });
  const hidden = new Set<string>();
  for (const t of teams) {
    const flags = [
      ...t.productCapacities.map(c => catVisible(c.product.category)),
      ...t.categories.map(c => catVisible(c.category)),
      ...t.dailyTasks.map(d => catVisible(d.orderItem.product.category)),
    ];
    if (flags.length > 0 && flags.every(v => !v)) hidden.add(t.id);
  }
  return hidden;
}

// Ключ очереди планирования — Дата передачи, как у Raytec: своя у строки (из 1С), иначе дата заказа;
// без даты — сегодня (Raytec подставляет ТекущаяДата), а не начало очереди
function queueDateMs(item: { transferDate?: Date | null; order: { raytecDate: Date | null } }): number {
  const d = item.transferDate ?? item.order.raytecDate;
  if (d) return d.getTime();
  const today = new Date();
  return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
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

// Helper: выбрать бригаду как у Raytec — позиция целиком идёт на бригаду, которая раньше освободится.
// «Освободится» = первый рабочий день от даты старта, где у бригады есть свободное время
// (с учётом корректировок мощности, блокировок категории и уже стоящих задач, в т.ч. ручных).
// В один день раньше свободна та, у кого в этот день меньше занято. Ничья — у кого выше мощность
// по товару (сделает быстрее), затем по названию.
async function selectEarliestFreeTeam(
  teamIds: string[],
  product: { id: string; categoryId: string },
  companyId: string,
  fallbackCapPerPerson: number | null,
  startDate: Date,
  skipDateMs: Set<number>
): Promise<string | null> {
  if (teamIds.length <= 1) return teamIds[0] ?? null;

  const [teams, tasks, dayCaps, blocks, ownPtcs] = await Promise.all([
    prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, headcount: true } }),
    prisma.dailyTask.findMany({
      where: { teamId: { in: teamIds }, date: { gte: startDate } },
      select: {
        teamId: true, date: true, plannedQuantity: true, loadShare: true,
        orderItem: { select: { product: { select: { id: true, capacityPerDay: true, category: { select: { capacityPerTeamPerDay: true } } } } } },
      },
    }),
    prisma.teamDayCapacity.findMany({ where: { teamId: { in: teamIds }, date: { gte: startDate } } }),
    prisma.categoryBlock.findMany({ where: { categoryId: product.categoryId, companyId }, select: { startDate: true, endDate: true } }),
    prisma.productTeamCapacity.findMany({ where: { productId: product.id, teamId: { in: teamIds }, companyId }, select: { teamId: true, capacityPerDay: true } }),
  ]);

  const taskProductIds = [...new Set(tasks.map(t => t.orderItem.product.id))];
  const ptcs = taskProductIds.length > 0
    ? await prisma.productTeamCapacity.findMany({
        where: { productId: { in: taskProductIds }, teamId: { in: teamIds }, companyId },
        select: { productId: true, teamId: true, capacityPerDay: true },
      })
    : [];
  const ptcMap = new Map(ptcs.map(p => [`${p.productId}|${p.teamId}`, p.capacityPerDay]));
  const headcount = new Map(teams.map(t => [t.id, t.headcount]));

  // Загрузка (доли бригадо-дня) по бригаде и дню — та же формула, что в calculateTeamLoad
  const load = new Map<string, number>();
  for (const t of tasks) {
    const p = t.orderItem.product;
    const capPerPerson = ptcMap.get(`${p.id}|${t.teamId}`) ?? p.capacityPerDay ?? p.category.capacityPerTeamPerDay;
    const key = `${t.teamId}|${t.date.getTime()}`;
    load.set(key, (load.get(key) ?? 0) + taskLoad(t, capPerPerson * (headcount.get(t.teamId!) ?? 1)));
  }
  const factor = new Map(dayCaps.map(c => [`${c.teamId}|${c.date.getTime()}`, c.factor]));

  const ownCap = new Map(ownPtcs.map(p => [p.teamId, p.capacityPerDay]));
  const candidates: { teamId: string; name: string; day: number; used: number; cap: number }[] = [];

  for (const team of teams) {
    const cur = new Date(startDate);
    for (let day = 0; day < 730; day++, cur.setDate(cur.getDate() + 1)) {
      const date = new Date(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      const ms = date.getTime();
      if (skipDateMs.has(ms) || !isWorkingDay(date)) continue;
      if (blocks.some(b => b.startDate <= date && b.endDate >= date)) continue;
      const used = load.get(`${team.id}|${ms}`) ?? 0;
      if ((factor.get(`${team.id}|${ms}`) ?? 1) - used > 1e-6) {
        const cap = (ownCap.get(team.id) ?? fallbackCapPerPerson ?? 0) * team.headcount;
        candidates.push({ teamId: team.id, name: team.name, day, used, cap });
        break;
      }
    }
  }

  candidates.sort((a, b) =>
    a.day - b.day || a.used - b.used || b.cap - a.cap || a.name.localeCompare(b.name, "ru", { numeric: true }));
  return candidates[0]?.teamId ?? teamIds[0] ?? null;
}

// Кто и когда закрепил задачу ручной правкой — показывается в «Графике» при наведении
function manualStamp(req: Request) {
  return { manualAt: new Date(), manualBy: req.user?.email ?? null };
}

// Запись в «Реестр переносов». Ошибка записи не должна ломать сам перенос — только в лог
type MoveEntry = {
  kind: "move" | "moveWhole" | "split" | "remove" | "removeWhole" | "return";
  orderItemId: string;
  qty: number;
  days?: number;
  from?: Date[];
  fromTeamIds?: (string | null)[];
  to?: Date[];
  toTeamId?: string | null;
  filled?: boolean;
  returnMode?: "fifo" | "date";
  snapshotId?: string;
};
async function logMove(req: Request, e: MoveEntry): Promise<string | null> {
  try {
    const item = await prisma.orderItem.findUnique({
      where: { id: e.orderItemId },
      select: { order: { select: { id: true, orderNumber: true, customer: true, companyId: true } }, product: { select: { code: true, name: true } } },
    });
    if (!item) return null;
    const ids = [...new Set([...(e.fromTeamIds ?? []), e.toTeamId ?? null].filter((t): t is string => !!t))];
    const names = new Map((await prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(t => [t.id, t.name]));
    const teamNames = (tids: (string | null)[] | undefined) => {
      const list = [...new Set((tids ?? []).map(t => (t ? names.get(t) ?? null : null)).filter((n): n is string => !!n))];
      return list.length ? list.join(", ") : null;
    };
    const span = (ds?: Date[]) => {
      if (!ds?.length) return [null, null] as const;
      const ms = ds.map(d => d.getTime());
      const lo = Math.min(...ms), hi = Math.max(...ms);
      return [new Date(lo), hi > lo ? new Date(hi) : null] as const;
    };
    const [fromDate, fromDateEnd] = span(e.from);
    const [toDate, toDateEnd] = span(e.to);
    const row = await prisma.planMove.create({
      data: {
        companyId: item.order.companyId, createdBy: req.user?.email ?? null, kind: e.kind,
        orderItemId: e.orderItemId, orderId: item.order.id, orderNumber: item.order.orderNumber, customer: item.order.customer,
        productCode: item.product.code, productName: item.product.name, qty: e.qty, days: e.days ?? 1,
        fromDate, fromDateEnd, fromTeamName: teamNames(e.fromTeamIds),
        toDate, toDateEnd, toTeamName: teamNames(e.toTeamId !== undefined ? [e.toTeamId] : undefined),
        filled: e.filled ?? null, returnMode: e.returnMode ?? null, snapshotId: e.snapshotId ?? null,
      },
    });
    return row.id;
  } catch (err) {
    console.error("logMove failed", err);
    return null;
  }
}

// «Отменить» сработало — запись реестра остаётся, но помечается отменённой (кем и когда)
async function markMoveUndone(req: Request, where: { id?: string; snapshotId?: string }) {
  const key = where.id ? { id: where.id } : where.snapshotId ? { snapshotId: where.snapshotId } : null;
  if (!key) return;
  await prisma.planMove.updateMany({
    where: { companyId: req.user!.companyId, undoneAt: null, ...key },
    data: { undoneAt: new Date(), undoneBy: req.user?.email ?? null },
  }).catch(err => console.error("markMoveUndone failed", err));
}

// Перенос «не заполняя освободившееся место»: в ячейке позиции на старый день показываем «оставлено пустым»
// (только если в этот день у позиции не осталось задачи — например, с фактом)
async function markEmptySlots(orderItemId: string, slots: { date: Date; teamId: string | null }[], by: string | null) {
  for (const slot of slots) {
    const left = await prisma.dailyTask.findUnique({ where: { orderItemId_date: { orderItemId, date: slot.date } }, select: { id: true } });
    if (left) continue;
    await prisma.emptySlot.upsert({
      where: { orderItemId_date: { orderItemId, date: slot.date } },
      update: { teamId: slot.teamId, createdAt: new Date(), createdBy: by },
      create: { orderItemId, date: slot.date, teamId: slot.teamId, createdBy: by },
    });
  }
}

// Ручные задачи позиции с даты from: их не трогает никакое автопланирование.
// Остаток позиции планируется вокруг них (reservedQty / skipDates) и на ту же бригаду.
async function manualPlanOf(orderItemId: string, from: Date) {
  const tasks = await prisma.dailyTask.findMany({
    where: { orderItemId, manuallyPlaced: true, actualQuantity: null, date: { gte: from } },
    select: { date: true, plannedQuantity: true },
  });
  return { reservedQty: tasks.reduce((s, t) => s + t.plannedQuantity, 0), skipDates: tasks.map(t => t.date) };
}

// Сколько штук позиции уже стоит в плане с даты from (без факта) — чтобы «Запланировать»
// дописывало только недостающее, а не дублировало план
async function plannedAheadQty(orderItemId: string, from: Date): Promise<number> {
  const agg = await prisma.dailyTask.aggregate({
    where: { orderItemId, actualQuantity: null, date: { gte: from } },
    _sum: { plannedQuantity: true },
  });
  return agg._sum.plannedQuantity ?? 0;
}

// Пересборка плана бригады с даты from тем же планировщиком (после ручного переноса задачи).
// Каскадный сдвиг по целым штукам терял дробные доли дня (у товаров на 1–2 шт/день — пробелы и
// удлинение очереди), поэтому план бригады с этой даты собирается заново: автоматические задачи
// удаляются и позиции планируются в порядке очереди на эту же бригаду. Ручные задачи, факт и всё,
// что раньше from, не трогаются; уже стоящее в плане с сегодняшнего дня не дублируется.
// keepStarts — перенос «не заполняя освободившееся место»: позиция не может встать раньше, чем стояла
// (её первый день с from — нижняя граница), поэтому задачи только сдвигаются вправо, а пустые дни остаются
async function replanTeamFrom(teamId: string, from: Date, opts: { keepStarts?: boolean } = {}): Promise<string[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = from < today ? today : from;
  const auto = await prisma.dailyTask.findMany({
    where: { teamId, date: { gte: start }, actualQuantity: null, manuallyPlaced: false, plannedQuantity: { gt: 0 } },
    select: { orderItemId: true, date: true },
  });
  const itemIds = [...new Set(auto.map(t => t.orderItemId))];
  const firstDay = new Map<string, number>();
  for (const t of auto) firstDay.set(t.orderItemId, Math.min(firstDay.get(t.orderItemId) ?? Infinity, t.date.getTime()));
  if (itemIds.length === 0) return [];
  await prisma.dailyTask.deleteMany({
    where: { teamId, date: { gte: start }, actualQuantity: null, manuallyPlaced: false, orderItemId: { in: itemIds } },
  });
  const items = await prisma.orderItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, quantity: true, transferDate: true, order: { select: { priority: true, raytecDate: true, approvedAt: true } } },
  });
  items.sort((a, b) =>
    a.order.priority - b.order.priority ||
    queueDateMs(a) - queueDateMs(b) ||
    (a.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  for (const item of items) {
    const reservedQty = await plannedAheadQty(item.id, today);
    if (reservedQty >= item.quantity) continue;
    try {
      const startDate = opts.keepStarts ? new Date(Math.max(start.getTime(), firstDay.get(item.id) ?? start.getTime())) : start;
      await autoPlanOrderItem(item.id, { startDate, preferredTeamId: teamId, reservedQty });
    } catch { /* нет бригады с нормой — позиция останется незапланированной, как при общем перепланировании */ }
  }
  return itemIds;
}

// Поставить позицию в план бригады (вернуть из «Не в графике», перенести позицию целиком):
// mode "date" — позиция встаёт с даты from первой (её задачи становятся ручными), "fifo" — в своё место
// очереди (приоритет → Дата передачи). Автоматические задачи других позиций бригады с from пересобираются
// и не встают раньше своего дня (только сдвигаются вправо); ручные задачи и факт не трогаются.
// planQty — сколько штук позиции поставить (остальное её количество уже стоит в плане)
async function placeItemOnTeam(
  orderItemId: string, teamId: string, from: Date,
  opts: { mode: "date" | "fifo"; planQty: number; stamp: { manualAt: Date; manualBy: string | null } },
): Promise<string[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = from < today ? today : from;
  const auto = await prisma.dailyTask.findMany({
    where: { teamId, date: { gte: start }, actualQuantity: null, manuallyPlaced: false, plannedQuantity: { gt: 0 }, orderItemId: { not: orderItemId } },
    select: { orderItemId: true, date: true },
  });
  const firstDay = new Map<string, number>();
  for (const t of auto) firstDay.set(t.orderItemId, Math.min(firstDay.get(t.orderItemId) ?? Infinity, t.date.getTime()));
  const otherIds = [...firstDay.keys()];
  if (otherIds.length > 0) {
    await prisma.dailyTask.deleteMany({
      where: { teamId, date: { gte: start }, actualQuantity: null, manuallyPlaced: false, orderItemId: { in: otherIds } },
    });
  }
  const items = await prisma.orderItem.findMany({
    where: { id: { in: [orderItemId, ...otherIds] } },
    select: { id: true, quantity: true, transferDate: true, order: { select: { priority: true, raytecDate: true, approvedAt: true } } },
  });
  items.sort((a, b) =>
    (opts.mode === "date" ? Number(b.id === orderItemId) - Number(a.id === orderItemId) : 0) ||
    a.order.priority - b.order.priority ||
    queueDateMs(a) - queueDateMs(b) ||
    (a.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const placedIds: string[] = [];
  for (const item of items) {
    try {
      if (item.id === orderItemId) {
        const { tasks } = await autoPlanOrderItem(item.id, {
          startDate: start, preferredTeamId: teamId, ignoreHold: true,
          reservedQty: Math.max(0, item.quantity - opts.planQty),
        });
        placedIds.push(...tasks.map((t: { id: string }) => t.id));
      } else {
        const reservedQty = await plannedAheadQty(item.id, today);
        if (reservedQty >= item.quantity) continue;
        const startDate = new Date(Math.max(start.getTime(), firstDay.get(item.id) ?? start.getTime()));
        await autoPlanOrderItem(item.id, { startDate, preferredTeamId: teamId, reservedQty });
      }
    } catch { /* нет бригады с нормой — позиция останется незапланированной */ }
  }
  // На конкретную дату — решение человека: задачи позиции закрепляются, автоматика их не сдвинет
  if (opts.mode === "date" && placedIds.length > 0) {
    await prisma.dailyTask.updateMany({ where: { id: { in: placedIds } }, data: { manuallyPlaced: true, ...opts.stamp } });
  }
  return placedIds;
}

// --- Снимки плана для «Отменить» ---
// Область действия: задачи без факта затронутых бригад с from и все задачи без факта самой позиции
function snapshotScope(teamIds: string[], from: Date, orderItemId: string) {
  return { actualQuantity: null, OR: [{ teamId: { in: teamIds }, date: { gte: from } }, { orderItemId }] };
}
const SNAP_TASK_SELECT = {
  id: true, orderItemId: true, teamId: true, date: true, plannedQuantity: true, loadShare: true,
  comment: true, manuallyPlaced: true, manualAt: true, manualBy: true,
} as const;

async function scopeFingerprint(teamIds: string[], from: Date, orderItemId: string): Promise<string> {
  const tasks = await prisma.dailyTask.findMany({ where: snapshotScope(teamIds, from, orderItemId), select: SNAP_TASK_SELECT, orderBy: { id: "asc" } });
  const line = tasks.map(t => [t.id, t.orderItemId, t.teamId, t.date.getTime(), t.plannedQuantity, t.manuallyPlaced].join("|")).join("\n");
  return createHash("sha1").update(line).digest("hex");
}

// До действия: запомнить область; после действия — saveSnapshot с отпечатком нового состояния
async function captureSnapshot(teamIds: string[], from: Date, orderItemId: string) {
  const [tasks, item, slots] = await Promise.all([
    prisma.dailyTask.findMany({ where: snapshotScope(teamIds, from, orderItemId), select: SNAP_TASK_SELECT }),
    prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { offPlanQty: true, offPlanAt: true, offPlanBy: true, offPlanTeamId: true } }),
    prisma.emptySlot.findMany({ where: { orderItemId }, select: { teamId: true, date: true, createdAt: true, createdBy: true } }),
  ]);
  return { teamIds, from, orderItemId, tasks, item: { ...item, emptySlots: slots } };
}

async function saveSnapshot(companyId: string, snap: Awaited<ReturnType<typeof captureSnapshot>>): Promise<string> {
  const fingerprint = await scopeFingerprint(snap.teamIds, snap.from, snap.orderItemId);
  const row = await prisma.planSnapshot.create({
    data: {
      companyId, teamIds: JSON.stringify(snap.teamIds), fromDate: snap.from, orderItemId: snap.orderItemId,
      tasks: JSON.stringify(snap.tasks), item: JSON.stringify(snap.item), fingerprint,
    },
  });
  // Старые снимки (больше суток) не нужны — «Отменить» живёт до следующего действия
  await prisma.planSnapshot.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
  return row.id;
}

// Срез плана бригад (по позициям: первый и последний день, штуки по дням) — чтобы после пересборки
// сообщить, у кого сдвинулось окончание и кто встал на освободившийся день
async function teamPlanSnapshot(teamIds: string[], from: Date) {
  const tasks = await prisma.dailyTask.findMany({
    where: { teamId: { in: teamIds }, date: { gte: from }, plannedQuantity: { gt: 0 } },
    select: { orderItemId: true, date: true, plannedQuantity: true },
  });
  const m = new Map<string, { first: number; last: number; byDay: Map<number, number> }>();
  for (const t of tasks) {
    const ms = t.date.getTime();
    const e = m.get(t.orderItemId) ?? { first: ms, last: ms, byDay: new Map() };
    e.first = Math.min(e.first, ms); e.last = Math.max(e.last, ms);
    e.byDay.set(ms, (e.byDay.get(ms) ?? 0) + t.plannedQuantity);
    m.set(t.orderItemId, e);
  }
  return m;
}

async function describeMove(
  before: Awaited<ReturnType<typeof teamPlanSnapshot>>,
  after: Awaited<ReturnType<typeof teamPlanSnapshot>>,
  freedDate: Date, movedItemId: string,
) {
  const ids = [...new Set([...before.keys(), ...after.keys()])].filter(id => id !== movedItemId);
  const items = ids.length
    ? await prisma.orderItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, order: { select: { orderNumber: true } }, product: { select: { code: true, name: true } } },
      })
    : [];
  const info = new Map(items.map(i => [i.id, { orderNumber: i.order.orderNumber, product: i.product.name || i.product.code }]));
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const shifted: { orderNumber: string; product: string; date: string; prevDate: string }[] = [];
  const pulled: { orderNumber: string; product: string; qty: number; date: string }[] = [];
  for (const id of ids) {
    const b = before.get(id), a = after.get(id), i = info.get(id);
    if (!i) continue;
    // Окончание позиции сдвинулось
    if (b && a && a.last !== b.last) shifted.push({ ...i, date: day(a.last), prevDate: day(b.last) });
    // Встала на освободившийся день (раньше её там не было)
    const fd = freedDate.getTime();
    if (a?.byDay.has(fd) && !b?.byDay.has(fd)) pulled.push({ ...i, qty: a.byDay.get(fd)!, date: b ? day(b.first) : day(fd) });
  }
  shifted.sort((x, y) => x.prevDate.localeCompare(y.prevDate));
  return { shifted, pulled, overload: null as { load: number; capacity: number } | null, mergedIntoOwn: false, filled: true };
}

// Helper: каскадный сдвиг вправо (после ручного переноса на раннюю дату)
// Каскады идут по дням до естественной остановки (сдвиг вправо — пока день переполнен; подтягивание
// влево — до последнего дня, где у бригады есть задачи). maxIterations — только страховка от зацикливания
const CASCADE_SAFETY_DAYS = 1000;

async function cascadeShiftRight(teamId: string, startDate: Date, maxIterations = CASCADE_SAFETY_DAYS): Promise<number> {
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
            product: { include: { category: true, teamCapacities: { where: { teamId }, take: 1 } } },
            order: { select: { approvedAt: true, priority: true, raytecDate: true } },
          },
        },
      },
    });
    if (tasks.length === 0) return;

    let totalLoad = 0;
    for (const t of tasks) {
      const ptcCap = t.orderItem.product.teamCapacities[0]?.capacityPerDay;
      const cap = (ptcCap ?? t.orderItem.product.capacityPerDay ?? t.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      totalLoad += taskLoad(t, cap);
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
      const ra = queueDateMs(a.orderItem);
      const rb = queueDateMs(b.orderItem);
      if (ra !== rb) return rb - ra;
      const ta = a.orderItem.order.approvedAt?.getTime() ?? 0;
      const tb = b.orderItem.order.approvedAt?.getTime() ?? 0;
      return tb - ta;
    });

    let excessLoad = totalLoad - effectiveFactor;
    const nextDay = getNextWorkingDay(date);

    for (const task of sorted) {
      if (excessLoad <= 0.0001) break;
      const ptcCap = task.orderItem.product.teamCapacities[0]?.capacityPerDay;
      const cap = (ptcCap ?? task.orderItem.product.capacityPerDay ?? task.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      const thisLoad = taskLoad(task, cap);

      let moveQty: number;
      if (thisLoad <= excessLoad + 0.0001) {
        // Move entire task
        moveQty = task.plannedQuantity;
        excessLoad -= thisLoad;
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
async function cascadeShiftLeft(teamId: string, startDate: Date, maxIterations = CASCADE_SAFETY_DAYS): Promise<number> {
  let movedCount = 0;
  const teamHeadcount = (await prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }))?.headcount ?? 1;
  // Дальше последнего дня с задачами бригады подтягивать нечего — там и останавливаемся
  const last = await prisma.dailyTask.findFirst({
    where: { teamId, actualQuantity: null, plannedQuantity: { gt: 0 } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!last) return 0;
  const lastDate = last.date;

  const processDay = async (date: Date, iteration: number): Promise<void> => {
    if (iteration > maxIterations || date > lastDate) return;
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
      include: { orderItem: { include: { product: { include: { category: true, teamCapacities: { where: { teamId }, take: 1 } } } } } },
    });

    let currentLoad = 0;
    for (const t of currentTasks) {
      const ptcCap = t.orderItem.product.teamCapacities[0]?.capacityPerDay;
      const cap = (ptcCap ?? t.orderItem.product.capacityPerDay ?? t.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      currentLoad += taskLoad(t, cap);
    }

    // Day is full — nothing to pull into, but continue forward in case we created a gap earlier
    if (currentLoad >= effectiveFactor - 0.0001) return;

    const nextDay = getNextWorkingDay(date);
    const nextDayTasks = await prisma.dailyTask.findMany({
      where: { teamId, date: nextDay, actualQuantity: null, manuallyPlaced: false },
      include: {
        orderItem: {
          include: {
            product: { include: { category: true, teamCapacities: { where: { teamId }, take: 1 } } },
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
      const ra = queueDateMs(a.orderItem);
      const rb = queueDateMs(b.orderItem);
      if (ra !== rb) return ra - rb;
      const ta = a.orderItem.order.approvedAt?.getTime() ?? 0;
      const tb = b.orderItem.order.approvedAt?.getTime() ?? 0;
      return ta - tb;
    });

    let freeLoad = effectiveFactor - currentLoad;

    for (const task of sorted) {
      if (freeLoad <= 0.0001) break;
      const ptcCap = task.orderItem.product.teamCapacities[0]?.capacityPerDay;
      const cap = (ptcCap ?? task.orderItem.product.capacityPerDay ?? task.orderItem.product.category.capacityPerTeamPerDay) * teamHeadcount;
      const thisLoad = taskLoad(task, cap);

      let pullQty: number;
      if (thisLoad <= freeLoad + 0.0001) {
        pullQty = task.plannedQuantity;
        freeLoad -= thisLoad;
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
// Сколько штук позиции снято с графика вручную и ещё не возвращено — не больше, чем реально не стоит
// в плане (план без факта за любые дни): если позицию потом поставили руками или 1С уменьшила количество
async function offPlanHold(item: { id: string; quantity: number; offPlanQty: number }): Promise<number> {
  if (item.offPlanQty <= 0) return 0;
  const agg = await prisma.dailyTask.aggregate({ where: { orderItemId: item.id, actualQuantity: null }, _sum: { plannedQuantity: true } });
  return Math.max(0, Math.min(item.offPlanQty, item.quantity - (agg._sum.plannedQuantity ?? 0)));
}

async function autoPlanOrderItem(
  orderItemId: string,
  // ignoreHold — явное «поставить в график» (вернуть из «Не в графике», автоплан заказа): снятое вручную тоже планируется
  options?: { startDate?: Date; preferredTeamId?: string; skipDates?: Date[]; reservedQty?: number; ignoreHold?: boolean }
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
  const fallbackCapPerPerson = orderItem.product.capacityPerDay
    ?? orderItem.product.category.capacityPerTeamPerDay;
  // Бригады по товару: если у товара есть нормы из 1С — только бригады с нормой (как у Raytec).
  // Категория и запасная мощность — только для товаров без норм по бригадам.
  const ptcsForProduct = await prisma.productTeamCapacity.findMany({
    where: { productId: orderItem.product.id, companyId: orderItem.order.companyId, capacityPerDay: { gt: 0 } },
    select: { teamId: true, capacityPerDay: true },
  });
  const ptcCapMap = new Map(ptcsForProduct.map(p => [p.teamId, p.capacityPerDay]));

  let capableTeamIds: string[];
  if (ptcsForProduct.length > 0) {
    capableTeamIds = ptcsForProduct.map(p => p.teamId);
  } else {
    const availableTeamIds = await getAvailableTeamsForCategory(orderItem.product.categoryId, orderItem.order.companyId);
    if (availableTeamIds.length === 0) {
      throw new Error("No teams available for this product category");
    }
    capableTeamIds = (fallbackCapPerPerson ?? 0) > 0 ? availableTeamIds : [];
  }

  if (capableTeamIds.length === 0) {
    throw new Error("No teams with non-zero capacity for this product");
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
  // Дни, где у позиции стоит ручная задача, не трогаем — ни дописываем, ни меняем бригаду
  const manualTasks = await prisma.dailyTask.findMany({
    where: { orderItemId, manuallyPlaced: true },
    select: { date: true, teamId: true },
    orderBy: { date: "desc" },
  });
  for (const t of manualTasks) skipDateMs.add(t.date.getTime());

  // Бригада выбирается один раз на всю позицию (как у Raytec):
  // 1) явно указанная; 2) бригада ручной задачи или уже начатой работы (есть факт) по позиции;
  // 3) та, что раньше освободится
  let teamId: string | null = null;
  if (options?.preferredTeamId && capableTeamIds.includes(options.preferredTeamId)) {
    teamId = options.preferredTeamId;
  } else {
    const started = await prisma.dailyTask.findFirst({
      where: { orderItemId, teamId: { in: capableTeamIds }, actualQuantity: { gt: 0 } },
      select: { teamId: true },
      orderBy: { date: "desc" },
    });
    teamId = manualTasks.find(t => t.teamId && capableTeamIds.includes(t.teamId))?.teamId
      ?? started?.teamId
      ?? await selectEarliestFreeTeam(capableTeamIds, orderItem.product, orderItem.order.companyId, fallbackCapPerPerson, currentDate, skipDateMs);
  }
  if (!teamId) {
    throw new Error("No available team found");
  }

  const tasks: any[] = [];
  // Снятое с графика вручную автоматика обратно не ставит (ручные правки неприкосновенны)
  const hold = options?.ignoreHold ? 0 : await offPlanHold(orderItem);
  let remaining = Math.max(0, quantity - (options?.reservedQty ?? 0) - hold);
  let overloaded = false;

  const maxDays = 365; // Защита от бесконечного цикла
  let daysPlanned = 0;
  // Как у Raytec: время бригады непрерывное, позиция занимает target / мощность бригадо-дней.
  // progress — сколько штук «сделано» по времени (дробно), чтобы знать, где позиция кончается.
  const target = remaining;
  let progress = 0;

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

    // Проверяем текущую загрузку бригады (в долях бригадо-дня)
    const currentLoadFraction = await calculateTeamLoad(teamId, date);
    // Эффективная мощность с учётом корректировки на день
    const capOverride = await prisma.teamDayCapacity.findUnique({
      where: { teamId_date: { teamId, date } },
    });
    const effectiveFraction = capOverride ? capOverride.factor : 1.0;
    // Мощность бригады = на 1 человека × численность бригады
    const teamHeadcount = (await prisma.team.findUnique({ where: { id: teamId }, select: { headcount: true } }))?.headcount ?? 1;
    const ptc = await prisma.productTeamCapacity.findUnique({
      where: { productId_teamId_companyId: { productId: orderItem.product.id, teamId, companyId: orderItem.order.companyId } },
      select: { capacityPerDay: true },
    });
    const effectiveCapacity = (ptc?.capacityPerDay ?? fallbackCapPerPerson) * teamHeadcount;
    // Свободная доля бригадо-дня
    const availableFraction = Math.max(0, effectiveFraction - currentLoadFraction);
    // Доля дня, которую займёт позиция, и штуки на день: целая часть,
    // а остаток от округлений — в последний день позиции (как у Raytec: 22,5/день → 22, 22, 17)
    let share = 0;
    let plannedForDay = 0;
    if (effectiveCapacity > 0 && availableFraction > 1e-9) {
      const needFraction = (target - progress) / effectiveCapacity;
      share = Math.min(availableFraction, needFraction);
      progress += share * effectiveCapacity;
      const isLast = share >= needFraction - 1e-9;
      plannedForDay = isLast ? remaining : Math.min(remaining, Math.floor(share * effectiveCapacity + 1e-9));
    }

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
            loadShare: share,
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


// Факт из синка: сколько штук позиции обеспечено с прошлого синка (остаток «к обеспечению» уменьшился).
// Пишется в задачу позиции за день факта — к уже внесённому за день прибавляется, а не затирается.
// Если задачи на этот день нет — создаётся строка факта на бригаду, у которой позиция в плане
// (в 1С бригады нет — мастер может поправить её в «Плане на день»).
async function recordSyncFact(orderItemId: string, qty: number, dateMs: number): Promise<void> {
  if (qty <= 0) return;
  const date = new Date(dateMs);
  const task = await prisma.dailyTask.findUnique({ where: { orderItemId_date: { orderItemId, date } } });
  if (task) {
    await prisma.dailyTask.update({ where: { id: task.id }, data: { actualQuantity: (task.actualQuantity ?? 0) + qty } });
    return;
  }
  const tasks = await prisma.dailyTask.findMany({
    where: { orderItemId, teamId: { not: null }, plannedQuantity: { gt: 0 } },
    select: { date: true, teamId: true },
  });
  const nearest = tasks.sort((a, b) => Math.abs(a.date.getTime() - dateMs) - Math.abs(b.date.getTime() - dateMs))[0];
  await prisma.dailyTask.create({
    data: { orderItemId, date, plannedQuantity: 0, actualQuantity: qty, teamId: nearest?.teamId ?? null },
  });
}

type SyncMaterial = {
  productCode: string; specCode?: string; specOutputQty?: number;
  materialArticle?: string; materialCode?: string; materialName?: string; unit?: string;
  materialKind?: string; materialFolder?: string; materialGroup?: string; stage?: string; qty: number;
};
const COMPONENT_FALLBACK_CATEGORY = "Комплектующие без группы";

// Состав изделий из 1С. Хозяин — 1С: строки состава компании заменяются целиком.
// Полуфабрикат — своя комплектующая: заводим её как Product (kind "component"), чтобы потом планировать
// тем же движком, что и изделия; покупные материалы остаются только строками состава.
async function syncBom(companyId: string, workshopId: string, materials: SyncMaterial[]) {
  const stats = { bomLines: 0, bomComponents: 0, bomSkipped: 0 };
  const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, code: true } });
  const productByCode = new Map(products.map(p => [p.code, p.id]));
  const categoryByName = new Map<string, string>();
  const categoryFor = async (name: string) => {
    const known = categoryByName.get(name);
    if (known) return known;
    const cat = await prisma.productCategory.upsert({
      where: { name_companyId: { name, companyId } },
      update: {},
      create: { name, companyId, capacityPerTeamPerDay: 0, workshopId },
    });
    categoryByName.set(name, cat.id);
    return cat.id;
  };

  // Сначала заводим все свои комплектующие: полуфабрикат сам бывает изделием со своим составом (линейка LM-NANA),
  // и его строки должны найти его уже в этом синке, а не в следующем
  const codeOf = (m: SyncMaterial) => m.materialArticle?.trim() || m.materialCode?.trim() || "";
  const isComponent = (m: SyncMaterial) => /^полуфабрикат/i.test(m.materialKind?.trim() ?? "");
  for (const m of materials) {
    const code = codeOf(m);
    if (!code || !isComponent(m) || productByCode.has(code)) continue;
    const categoryId = await categoryFor(m.materialGroup?.trim() || COMPONENT_FALLBACK_CATEGORY);
    const p = await prisma.product.create({
      data: { code, name: m.materialName?.trim() || code, categoryId, companyId, kind: "component" },
    });
    productByCode.set(code, p.id);
    stats.bomComponents++;
  }

  const specOf = new Map<string, string>(); // productId → specCode: у изделия бывает две спецификации с одной датой
  const lines = new Map<string, {
    companyId: string; productId: string; componentProductId: string | null;
    materialCode: string; materialName: string; unit: string; materialKind: string;
    materialGroup: string | null; qtyPerUnit: number; specCode: string | null; stage: string | null;
  }>();
  for (const m of materials) {
    const productId = productByCode.get(m.productCode?.trim());
    const code = codeOf(m);
    const specCode = m.specCode?.trim() || null;
    if (!productId || !code || !(m.qty > 0)) { stats.bomSkipped++; continue; }
    const seenSpec = specOf.get(productId);
    if (seenSpec !== undefined && seenSpec !== (specCode ?? "")) { stats.bomSkipped++; continue; }
    specOf.set(productId, specCode ?? "");

    const kind = m.materialKind?.trim() ?? "";
    const group = m.materialGroup?.trim() || null;
    const componentProductId = isComponent(m) ? productByCode.get(code) ?? null : null;

    // Спецификация бывает на 60 или 100000 шт — храним расход на 1 шт; материал на разных этапах складываем
    const qtyPerUnit = m.qty / (m.specOutputQty && m.specOutputQty > 0 ? m.specOutputQty : 1);
    const key = `${productId}|${code}`;
    const prev = lines.get(key);
    if (prev) { prev.qtyPerUnit += qtyPerUnit; continue; }
    lines.set(key, {
      companyId, productId, componentProductId,
      materialCode: code, materialName: m.materialName?.trim() || code, unit: m.unit?.trim() ?? "",
      materialKind: kind, materialGroup: group, qtyPerUnit, specCode, stage: m.stage?.trim() || null,
    });
  }

  await prisma.$transaction([
    prisma.bomLine.deleteMany({ where: { companyId } }),
    prisma.bomLine.createMany({ data: Array.from(lines.values()) }),
  ]);
  stats.bomLines = lines.size;
  return stats;
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

  // fact из 1С (остаток «Не обеспечен» по своему запросу) больше не используется — факт считается по позициям заказов
  const { orders, categories, teams, teamCategories, capacity, materials } = req.body as {
    orders: { ref?: string; number: string; status?: string; customer: string; manager?: string; approvedAt?: string; description?: string; paymentTerms?: string; priority?: string; raytecDate?: string; productionInfo?: string; comment?: string; items: { productCode: string; productName: string; categoryName: string; quantity: number; transferDate?: string; barcode?: string }[] }[];
    categories: { code: string; name: string; capacity?: number }[];
    teams: { code: string; name: string; workshopName?: string; headcount?: number }[];
    teamCategories: { categoryName: string; teamName: string; workshopName?: string }[];
    fact: { orderNumber: string; productCode: string; remaining: number }[];
    capacity?: { productCode: string; productName?: string; categoryName?: string; teamName?: string; capacityPerDay: number }[];
    materials?: SyncMaterial[]; // старая версия BSL не шлёт — состав не трогаем
  };

  const stats = { categories: 0, teams: 0, products: 0, orders: 0, orderItems: 0, categoryTeamLinks: 0, factRecords: 0, capacityRecords: 0, bomLines: 0, bomComponents: 0, bomSkipped: 0 };
  // Пропало сразу много заказов — скорее всего синк не из той базы: факт за весь синк не пишем
  let factGuard: string | null = null;

  console.log("[sync/1c] received:", {
    orders: orders?.length ?? 0,
    categories: categories?.length ?? 0,
    teams: teams?.length ?? 0,
    teamCategories: teamCategories?.length ?? 0,
    capacity: capacity?.length ?? 0,
    materials: materials?.length ?? 0,
    sampleTeams: teams?.slice(0, 5).map(t => t.name),
    orderNumbers: orders?.map(o => o.number),
  });
  // Полный дамп тела запроса — для отладки структуры данных от 1С. Состав — десятки тысяч строк: в лог только образец
  const { materials: _materials, ...rawBody } = req.body ?? {};
  console.log("[sync/1c] raw body:", JSON.stringify({ ...rawBody, materialsSample: materials?.slice(0, 5) }, null, 2));

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

  const todayMs = (() => {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    msk.setUTCHours(0, 0, 0, 0);
    return msk.getTime();
  })();
  // Дата факта: выпуск на баланс бухгалтерия проводит вечером того же дня или утром следующего,
  // поэтому синк до 12:00 МСК — это выпуск предыдущего рабочего дня, после — сегодняшнего
  const factMs = (() => {
    const mskHour = new Date(Date.now() + 3 * 60 * 60 * 1000).getUTCHours();
    if (mskHour >= 12) return todayMs;
    const d = new Date(todayMs);
    do { d.setUTCDate(d.getUTCDate() - 1); } while (!isWorkingDay(d));
    return d.getTime();
  })();

  // Деактивировать заказы которых нет в текущем синке
  const incomingOrderRefs = new Set((orders ?? []).filter(o => o.ref).map(o => o.ref as string));
  const incomingOrderNumbers = new Set((orders ?? []).map(o => o.number));
  const vanishedWhere = incomingOrderRefs.size > 0
    ? { companyId, active: true, orderRef: { notIn: Array.from(incomingOrderRefs) } }
    : incomingOrderNumbers.size > 0
      ? { companyId, active: true, orderNumber: { notIn: Array.from(incomingOrderNumbers) } }
      : null;
  if (vanishedWhere) {
    // Заказ пропал из выгрузки — его остаток обеспечен (или заказ закрыт): остаток идёт в факт, позиции обнуляются
    const [vanished, activeBefore] = await Promise.all([
      prisma.order.findMany({ where: vanishedWhere, select: { id: true, items: { where: { quantity: { gt: 0 } }, select: { id: true, quantity: true } } } }),
      prisma.order.count({ where: { companyId, active: true } }),
    ]);
    if (vanished.length > Math.max(20, activeBefore * 0.3)) {
      factGuard = `из выгрузки пропало ${vanished.length} из ${activeBefore} активных заказов — факт за этот синк не записан (синк не из рабочей базы?)`;
      console.warn(`[sync/1c] ${factGuard}`);
    } else {
      for (const o of vanished) {
        for (const it of o.items) {
          await recordSyncFact(it.id, it.quantity, factMs);
          stats.factRecords++;
        }
        await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { quantity: 0 } });
      }
    }
    await prisma.order.updateMany({ where: vanishedWhere, data: { active: false } });
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
      // «Информация для производства» (реквизит заказа клиента); `comment` — имя поля в первой версии BSL.
      // Старая версия BSL его не шлёт (undefined) — не трогаем
      ...((orderData.productionInfo ?? orderData.comment) !== undefined
        ? { productionInfo: (orderData.productionInfo ?? orderData.comment ?? "").trim() || null } : {}),
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

      // Штрихкод: старая версия BSL его не шлёт (undefined) — не трогаем
      const barcode = itemData.barcode !== undefined ? { barcode: itemData.barcode.trim() || null } : {};
      const product = await prisma.product.upsert({
        where: { code_companyId: { code: itemData.productCode, companyId } },
        update: { name: itemData.productName, categoryId, ...barcode },
        create: { code: itemData.productCode, name: itemData.productName, categoryId, companyId, ...barcode },
      });
      stats.products++;
      syncedProductIds.push(product.id);

      const existingItem = await prisma.orderItem.findFirst({
        where: { orderId: order.id, productId: product.id },
      });
      // Дата передачи строки: старая версия BSL её не шлёт (undefined) — не трогаем; пустая строка — null
      const itemFields: { quantity: number; transferDate?: Date | null } = { quantity: itemData.quantity };
      if (itemData.transferDate !== undefined) {
        itemFields.transferDate = itemData.transferDate ? new Date(itemData.transferDate) : null;
      }
      if (existingItem) {
        // Остаток уменьшился — это обеспечено с прошлого синка (только если заказ и раньше был активен:
        // у вернувшихся из архива заказов прошлый остаток устаревший)
        if (existing?.active && !factGuard) {
          await recordSyncFact(existingItem.id, existingItem.quantity - itemData.quantity, factMs);
          if (existingItem.quantity > itemData.quantity) stats.factRecords++;
        }
        await prisma.orderItem.update({ where: { id: existingItem.id }, data: itemFields });
      } else {
        await prisma.orderItem.create({ data: { orderId: order.id, productId: product.id, ...itemFields } });
      }
      stats.orderItems++;
    }

    // Позиции, которые BSL больше не присылает: остаток обеспечен (или позицию сняли / стала «Со склада»).
    // Не удаляем, а обнуляем — иначе вместе с позицией пропали бы её факт и история плана.
    // Будущий автоматический план по ним убираем; ручные задачи не трогаем.
    const gone = await prisma.orderItem.findMany({
      where: { orderId: order.id, productId: { notIn: syncedProductIds }, quantity: { gt: 0 } },
      select: { id: true, quantity: true },
    });
    for (const it of gone) {
      if (existing?.active && !factGuard) {
        await recordSyncFact(it.id, it.quantity, factMs);
        stats.factRecords++;
      }
    }
    if (gone.length > 0) {
      await prisma.orderItem.updateMany({ where: { id: { in: gone.map(g => g.id) } }, data: { quantity: 0 } });
      await prisma.dailyTask.deleteMany({
        where: { orderItemId: { in: gone.map(g => g.id) }, actualQuantity: null, manuallyPlaced: false, date: { gte: new Date(todayMs) } },
      });
    }
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

    const teamName = cap.teamName?.trim();
    if (teamName) {
      const product = await prisma.product.findUnique({
        where: { code_companyId: { code: cap.productCode, companyId } },
        select: { id: true },
      });
      const team = await prisma.team.findUnique({
        where: { name_companyId: { name: teamName, companyId } },
        select: { id: true },
      });
      if (product && team) {
        await prisma.productTeamCapacity.upsert({
          where: { productId_teamId_companyId: { productId: product.id, teamId: team.id, companyId } },
          update: { capacityPerDay: cap.capacityPerDay },
          create: { productId: product.id, teamId: team.id, companyId, capacityPerDay: cap.capacityPerDay },
        });
        stats.capacityRecords++;
      }
    } else {
      // Нет teamName — обновляем глобальный Product.capacityPerDay как fallback
      const updated = await prisma.product.updateMany({
        where: { code: cap.productCode, companyId, capacityLocked: false },
        // Product.capacityPerDay целое, а норма из 1С может быть дробной
        data: { capacityPerDay: Math.max(1, Math.round(cap.capacityPerDay)) },
      });
      stats.capacityRecords += updated.count;
    }
  }

  if (materials) {
    Object.assign(stats, await syncBom(companyId, defaultWorkshop.id, materials));
    console.log(`[sync/1c] bom: ${stats.bomLines} строк, новых комплектующих ${stats.bomComponents}, пропущено ${stats.bomSkipped}`);
  }

  console.log(`[sync/1c] fact: ${stats.factRecords} записей${factGuard ? ` · ${factGuard}` : ""}`);
  res.json({ ok: true, stats, ...(factGuard ? { factGuard } : {}) });
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
    },
    include: { dailyTasks: true, order: { select: { approvedAt: true, priority: true, raytecDate: true } } },
  });
  // Очередь: приоритет → Дата передачи строки → дата согласования
  items.sort((a, b) =>
    a.order.priority - b.order.priority ||
    queueDateMs(a) - queueDateMs(b) ||
    (a.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER));

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
    // Снятое с графика вручную сюда не возвращается — только из списка «Не в графике»
    return futurePlanned + item.offPlanQty < K;
  });

  let planned = 0;
  let skipped = 0;
  let noTeam = 0;

  for (const item of unplanned) {
    try {
      const { tasks } = await autoPlanOrderItem(item.id, { reservedQty: await plannedAheadQty(item.id, today) });
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
  // ?hidden=1 — раздел «Скрытые» (восстановление)
  const hidden = req.query.hidden === "1";
  const workshops = await prisma.workshop.findMany({
    where: { companyId: cid, visible: !hidden },
    include: { _count: { select: { categories: true } } },
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
  const { name, visible } = req.body;

  // Скрыть / восстановить участок — отдельно от переименования
  if (name === undefined && typeof visible !== "boolean") {
    return res.status(400).json({ error: "name is required" });
  }
  if (name !== undefined && (!name || typeof name !== "string")) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const existing = await prisma.workshop.findFirst({ where: { id, companyId: cid } });
    if (!existing) { res.status(404).json({ error: "Workshop not found" }); return; }
    const workshop = await prisma.workshop.update({
      where: { id },
      data: { ...(name !== undefined ? { name } : {}), ...(typeof visible === "boolean" ? { visible } : {}) },
    });
    res.json(workshop);
  } catch (err) {
    res.status(404).json({ error: "Workshop not found" });
  }
});

app.delete("/workshops/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.workshop.findFirst({ where: { id, companyId: cid }, include: { _count: { select: { categories: true } } } });
    if (!existing) { res.status(404).json({ error: "Workshop not found" }); return; }
    // Удаление участка удалило бы его категории (каскадом) — не даём, объясняем
    if (existing._count.categories > 0) {
      const n = existing._count.categories;
      const word = n % 10 === 1 && n % 100 !== 11 ? "категория" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "категории" : "категорий";
      res.status(409).json({ error: `Нельзя удалить участок «${existing.name}»: в нём ${n} ${word}. Сначала перенесите или удалите все категории участка или скройте его.` });
      return;
    }
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
  // ?hidden=1 — раздел «Скрытые» (восстановление)
  const hidden = req.query.hidden === "1";
  const categories = await prisma.productCategory.findMany({
    where: hidden ? { companyId: cid, visible: false } : { companyId: cid, visible: true, workshop: { visible: true } },
    include: { workshop: true, _count: { select: { products: true } } },
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

    // Скрытие — только отображение: план и факт категории остаются, планирование продолжается
    res.json(category);
  } catch (err) {
    res.status(404).json({ error: "Category not found" });
  }
});

app.delete("/categories/:id", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = req.params.id as string;

  try {
    const existing = await prisma.productCategory.findFirst({ where: { id, companyId: cid }, include: { _count: { select: { products: true } } } });
    if (!existing) { res.status(404).json({ error: "Category not found" }); return; }
    // Товары категорию держат (связь Restrict) — объясняем, а не падаем с «не найдена»
    if (existing._count.products > 0) {
      const n = existing._count.products;
      const word = n % 10 === 1 && n % 100 !== 11 ? "товар" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "товара" : "товаров";
      res.status(409).json({ error: `Нельзя удалить категорию «${existing.name}»: в ней ${n} ${word}. Сначала удалите все товары категории или скройте её.` });
      return;
    }
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
    where: { companyId: cid, ...VISIBLE_PRODUCT },
    include: { category: true, teamCapacities: { include: { team: true } } },
    orderBy: { code: "asc" },
  });
  res.json(products);
});

// Состав изделия: свои комплектующие первыми
app.get("/bom", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const productId = String(req.query.productId ?? "");
  if (!productId) { res.status(400).json({ error: "productId обязателен" }); return; }
  const lines = await prisma.bomLine.findMany({
    where: { companyId: cid, productId },
    include: { component: { select: { id: true, code: true, name: true } } },
    orderBy: [{ componentProductId: { sort: "asc", nulls: "last" } }, { materialName: "asc" }],
  });
  res.json(lines);
});

// Свои комплектующие из составов: где используются и настроены ли для планирования (бригады, норма)
app.get("/bom/components", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const components = await prisma.product.findMany({
    where: { companyId: cid, usedIn: { some: {} } },
    select: {
      id: true, code: true, name: true, kind: true, capacityPerDay: true,
      category: { select: { id: true, name: true, _count: { select: { teams: true } } } },
      _count: { select: { usedIn: true, teamCapacities: true } },
    },
    orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
  });
  res.json(components.map(c => ({
    id: c.id, code: c.code, name: c.name, kind: c.kind,
    category: { id: c.category.id, name: c.category.name },
    usedInProducts: c._count.usedIn,
    configured: c._count.teamCapacities > 0 || (c.capacityPerDay != null && c.category._count.teams > 0),
  })));
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
  const hidden = await hiddenTeamIds(cid);
  const teams = await prisma.team.findMany({
    where: { companyId: cid, id: { notIn: [...hidden] } },
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
    include: { items: { include: { product: { include: { category: { select: CAT_VISIBILITY } } } } } },
    orderBy: { orderNumber: "asc" },
  });
  // Позиции скрытых категорий не показываем; заказ только из них — тоже
  res.json(orders
    .map(o => ({ ...o, visibleItems: o.items.filter(i => catVisible(i.product.category)) }))
    .filter(o => o.items.length === 0 || o.visibleItems.length > 0)
    .map(({ visibleItems, ...o }) => ({ ...o, items: visibleItems })));
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

  const where = orderId
    ? { orderId, order: { companyId: cid }, product: VISIBLE_PRODUCT }
    : { order: { companyId: cid }, product: VISIBLE_PRODUCT };

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
// Бригады, у которых есть норма на товар позиции, и их мощность в день (для окна переноса задачи)
app.get("/order-items/:id/teams", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const item = await prisma.orderItem.findFirst({
    where: { id: String(req.params.id), order: { companyId: cid } },
    select: { productId: true, product: { select: { categoryId: true, capacityPerDay: true, category: { select: { capacityPerTeamPerDay: true } } } } },
  });
  if (!item) return res.status(404).json({ error: "Order item not found" });
  const ptcs = await prisma.productTeamCapacity.findMany({
    where: { productId: item.productId, companyId: cid, capacityPerDay: { gt: 0 } },
    select: { capacityPerDay: true, team: { select: { id: true, name: true, headcount: true } } },
  });
  if (ptcs.length > 0) {
    return res.json(ptcs.map(p => ({ teamId: p.team.id, teamName: p.team.name, perDay: Math.round(p.capacityPerDay * p.team.headcount * 10) / 10 })));
  }
  // Норм по бригадам нет — бригады категории с её запасной мощностью (так же выбирает планировщик)
  const perPerson = item.product.capacityPerDay ?? item.product.category.capacityPerTeamPerDay;
  const catTeamIds = perPerson > 0 ? await getAvailableTeamsForCategory(item.product.categoryId, cid) : [];
  const catTeams = await prisma.team.findMany({ where: { id: { in: catTeamIds } }, select: { id: true, name: true, headcount: true }, orderBy: { name: "asc" } });
  res.json(catTeams.map(t => ({ teamId: t.id, teamName: t.name, perDay: Math.round(perPerson * t.headcount * 10) / 10 })));
});

// Ячейки «оставлено пустым» за период. stillFree — у бригады в этот день ещё есть свободное место
// (если место потом заняли, например «Перепланировать очередь», надпись не показывается)
app.get("/daily-tasks/empty-slots", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
  const date: { gte?: Date; lte?: Date } = {};
  if (dateFrom) date.gte = new Date(dateFrom);
  if (dateTo) date.lte = new Date(dateTo);
  const slots = await prisma.emptySlot.findMany({
    where: { orderItem: { order: { companyId: cid }, product: VISIBLE_PRODUCT }, ...(Object.keys(date).length ? { date } : {}) },
    select: {
      orderItemId: true, teamId: true, date: true, createdAt: true, createdBy: true,
      // Данные позиции — чтобы показать строку, даже если в периоде у неё не осталось задач
      orderItem: { select: { quantity: true, order: { select: { id: true, orderNumber: true } }, product: { select: { code: true, name: true, category: { select: { workshop: { select: { name: true } } } } } } } },
    },
  });
  const teamNames = new Map((await prisma.team.findMany({ where: { companyId: cid }, select: { id: true, name: true } })).map(t => [t.id, t.name]));
  const out = [];
  for (const s of slots) {
    const has = await prisma.dailyTask.findUnique({ where: { orderItemId_date: { orderItemId: s.orderItemId, date: s.date } }, select: { plannedQuantity: true } });
    if (has && has.plannedQuantity > 0) continue;
    let stillFree = true;
    if (s.teamId) {
      const load = await calculateTeamLoad(s.teamId, s.date);
      const cap = (await prisma.teamDayCapacity.findUnique({ where: { teamId_date: { teamId: s.teamId, date: s.date } } }))?.factor ?? 1;
      stillFree = load < cap - 0.01;
    }
    const oi = s.orderItem;
    out.push({
      orderItemId: s.orderItemId, date: s.date.toISOString().slice(0, 10), teamId: s.teamId,
      teamName: s.teamId ? teamNames.get(s.teamId) ?? null : null,
      createdAt: s.createdAt, createdBy: s.createdBy, stillFree,
      orderNumber: oi.order.orderNumber, orderId: oi.order.id, quantity: oi.quantity,
      productCode: oi.product.code, productName: oi.product.name, workshopName: oi.product.category.workshop?.name ?? "—",
    });
  }
  res.json(out);
});

// Сколько у позиции стоит в графике (без факта): дни и штуки — для галочек «вся позиция» в «Графике»
app.get("/order-items/:id/plan-summary", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const tasks = await prisma.dailyTask.findMany({
    where: { orderItemId: String(req.params.id), orderItem: { order: { companyId: cid } }, actualQuantity: null, plannedQuantity: { gt: 0 } },
    select: { plannedQuantity: true },
  });
  res.json({ days: tasks.length, qty: tasks.reduce((s, t) => s + t.plannedQuantity, 0) });
});

// «Не в графике»: позиции активных заказов, у которых часть количества не стоит в плане
// (количество из 1С минус план без факта за любые дни). Причина: снято вручную / нет бригады с нормой / не запланировано
app.get("/order-items/off-schedule", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const items = await prisma.orderItem.findMany({
    where: { quantity: { gt: 0 }, order: { companyId: cid, active: true }, product: VISIBLE_PRODUCT },
    select: {
      id: true, quantity: true, transferDate: true, offPlanQty: true, offPlanAt: true, offPlanBy: true, offPlanTeamId: true,
      order: { select: { orderNumber: true, customer: true, priority: true, raytecDate: true, approvedAt: true } },
      product: { select: { id: true, code: true, name: true, categoryId: true, category: { select: { name: true } } } },
    },
  });
  const planned = await prisma.dailyTask.groupBy({
    by: ["orderItemId"],
    where: { orderItemId: { in: items.map(i => i.id) }, actualQuantity: null },
    _sum: { plannedQuantity: true },
  });
  const plannedMap = new Map(planned.map(p => [p.orderItemId, p._sum.plannedQuantity ?? 0]));
  const off = items
    .map(i => ({ i, planned: plannedMap.get(i.id) ?? 0 }))
    .filter(x => x.i.quantity - x.planned > 0);

  // Есть ли кому делать: бригады с нормой на товар, иначе — бригады категории
  const withNorm = new Set((await prisma.productTeamCapacity.findMany({
    where: { productId: { in: off.map(x => x.i.product.id) }, companyId: cid, capacityPerDay: { gt: 0 } },
    select: { productId: true },
  })).map(p => p.productId));
  const catTeams = new Map<string, boolean>();
  for (const x of off) {
    const catId = x.i.product.categoryId;
    if (!withNorm.has(x.i.product.id) && !catTeams.has(catId)) catTeams.set(catId, (await getAvailableTeamsForCategory(catId, cid)).length > 0);
  }
  const teamNames = new Map((await prisma.team.findMany({ where: { companyId: cid }, select: { id: true, name: true } })).map(t => [t.id, t.name]));

  off.sort((a, b) =>
    a.i.order.priority - b.i.order.priority ||
    queueDateMs(a.i) - queueDateMs(b.i) ||
    (a.i.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.i.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  res.json(off.map(({ i, planned }) => {
    const gap = i.quantity - planned;
    const manualQty = Math.min(i.offPlanQty, gap);
    const hasTeam = withNorm.has(i.product.id) || !!catTeams.get(i.product.categoryId);
    return {
      orderItemId: i.id,
      orderNumber: i.order.orderNumber,
      customer: i.order.customer,
      productCode: i.product.code,
      productName: i.product.name,
      categoryName: i.product.category.name,
      transferDate: (i.transferDate ?? i.order.raytecDate)?.toISOString().slice(0, 10) ?? null,
      quantity: i.quantity,
      planned,
      gap,
      manualQty,
      offPlanAt: manualQty > 0 ? i.offPlanAt : null,
      offPlanBy: manualQty > 0 ? i.offPlanBy : null,
      offPlanTeamId: i.offPlanTeamId,
      offPlanTeamName: i.offPlanTeamId ? teamNames.get(i.offPlanTeamId) ?? null : null,
      reason: manualQty > 0 ? "manual" : hasTeam ? "unplanned" : "noTeam",
    };
  }));
});

// Вернуть в график то, что не стоит в плане: mode "fifo" — в своё место очереди бригады,
// "date" — с указанной даты (закреплённо); остальные задачи бригады только сдвигаются вправо
app.post("/order-items/:id/return", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const id = String(req.params.id);
  const { mode, date, teamId } = req.body as { mode?: string; date?: string; teamId?: string };
  if (mode !== "fifo" && mode !== "date") return res.status(400).json({ error: "mode: fifo или date" });
  if (!teamId || typeof teamId !== "string") return res.status(400).json({ error: "Выберите бригаду" });
  const item = await prisma.orderItem.findFirst({ where: { id, order: { companyId: cid } }, select: { id: true, quantity: true } });
  if (!item) return res.status(404).json({ error: "Позиция не найдена" });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let from = today;
  if (mode === "date") {
    const d = date ? new Date(date) : null;
    if (!d || isNaN(d.getTime())) return res.status(400).json({ error: "Укажите дату" });
    from = d;
  }
  const agg = await prisma.dailyTask.aggregate({ where: { orderItemId: id, actualQuantity: null }, _sum: { plannedQuantity: true } });
  const gap = item.quantity - (agg._sum.plannedQuantity ?? 0);
  if (gap <= 0) return res.status(400).json({ error: "Позиция уже целиком в графике" });
  // Бригада должна делать этот товар (норма на товар, а без норм — бригада категории), иначе ничего не трогаем
  const full = await prisma.orderItem.findUnique({ where: { id }, select: { productId: true, product: { select: { categoryId: true } } } });
  const ptcTeams = (await prisma.productTeamCapacity.findMany({ where: { productId: full!.productId, companyId: cid, capacityPerDay: { gt: 0 } }, select: { teamId: true } })).map(p => p.teamId);
  const capable = ptcTeams.length > 0 ? ptcTeams : await getAvailableTeamsForCategory(full!.product.categoryId, cid);
  if (!capable.includes(teamId)) return res.status(400).json({ error: "Эта бригада не делает этот товар — выберите бригаду из списка" });

  const before = await teamPlanSnapshot([teamId], from);
  const undo = await captureSnapshot([teamId], from < today ? today : from, id);
  const placed = await placeItemOnTeam(id, teamId, from, { mode, planQty: gap, stamp: manualStamp(req) });
  await prisma.orderItem.update({ where: { id }, data: { offPlanQty: 0, offPlanAt: null, offPlanBy: null, offPlanTeamId: null } });
  const undoId = await saveSnapshot(cid, undo);
  // Позиция не встала (нет мощности) — план бригады возвращаем как был
  const aggPlaced = await prisma.dailyTask.aggregate({ where: { orderItemId: id, actualQuantity: null }, _sum: { plannedQuantity: true } });
  if ((aggPlaced._sum.plannedQuantity ?? 0) <= (agg._sum.plannedQuantity ?? 0)) {
    await restoreSnapshot(cid, undoId);
    return res.status(400).json({ error: "Не получилось поставить позицию: у бригады нет свободной мощности на этот товар" });
  }
  const after = await teamPlanSnapshot([teamId], from);
  const cascade = { ...(await describeMove(before, after, from, id)), filled: true };
  const tasks = placed.length
    ? await prisma.dailyTask.findMany({ where: { id: { in: placed } }, select: { date: true, plannedQuantity: true, teamId: true }, orderBy: { date: "asc" } })
    : [];
  // Сколько встало: прирост плана позиции (задача в день, где позиция уже стояла, дописывается к ней)
  const aggAfter = await prisma.dailyTask.aggregate({ where: { orderItemId: id, actualQuantity: null }, _sum: { plannedQuantity: true } });
  const returnedQty = (aggAfter._sum.plannedQuantity ?? 0) - (agg._sum.plannedQuantity ?? 0);
  await logMove(req, {
    kind: "return", orderItemId: id, qty: returnedQty, days: tasks.length,
    to: tasks.map(t => t.date), toTeamId: teamId, returnMode: mode, snapshotId: undoId,
  });
  res.json({
    qty: returnedQty,
    gap,
    firstDate: tasks[0]?.date.toISOString().slice(0, 10) ?? null,
    lastDate: tasks[tasks.length - 1]?.date.toISOString().slice(0, 10) ?? null,
    teamId: tasks[0]?.teamId ?? null,
    cascade,
    undoId,
  });
});

// «Отменить»: вернуть область ровно как была до действия, если с тех пор в ней ничего не меняли
async function restoreSnapshot(companyId: string, snapId: string): Promise<{ ok: true; restored: number } | { ok: false; status: number; error: string }> {
  const snap = await prisma.planSnapshot.findFirst({ where: { id: snapId, companyId } });
  if (!snap) return { ok: false, status: 404, error: "Отменить уже нельзя" };
  const teamIds = JSON.parse(snap.teamIds) as string[];
  if (await scopeFingerprint(teamIds, snap.fromDate, snap.orderItemId) !== snap.fingerprint) {
    return { ok: false, status: 409, error: "После этого график бригады уже меняли — отменить автоматически нельзя" };
  }
  type SnapTask = { orderItemId: string; teamId: string | null; date: string; plannedQuantity: number; loadShare: number | null; comment: string | null; manuallyPlaced: boolean; manualAt: string | null; manualBy: string | null };
  const tasks = JSON.parse(snap.tasks) as SnapTask[];
  const item = JSON.parse(snap.item) as { offPlanQty: number; offPlanAt: string | null; offPlanBy: string | null; offPlanTeamId: string | null; emptySlots: { teamId: string | null; date: string; createdAt: string; createdBy: string | null }[] };
  await prisma.$transaction(async tx => {
    await tx.dailyTask.deleteMany({ where: snapshotScope(teamIds, snap.fromDate, snap.orderItemId) });
    for (const t of tasks) {
      await tx.dailyTask.create({
        data: {
          orderItemId: t.orderItemId, teamId: t.teamId, date: new Date(t.date), plannedQuantity: t.plannedQuantity,
          loadShare: t.loadShare, comment: t.comment, manuallyPlaced: t.manuallyPlaced,
          manualAt: t.manualAt ? new Date(t.manualAt) : null, manualBy: t.manualBy,
        },
      });
    }
    await tx.orderItem.update({
      where: { id: snap.orderItemId },
      data: { offPlanQty: item.offPlanQty, offPlanAt: item.offPlanAt ? new Date(item.offPlanAt) : null, offPlanBy: item.offPlanBy, offPlanTeamId: item.offPlanTeamId },
    });
    await tx.emptySlot.deleteMany({ where: { orderItemId: snap.orderItemId } });
    for (const sl of item.emptySlots) {
      await tx.emptySlot.create({ data: { orderItemId: snap.orderItemId, teamId: sl.teamId, date: new Date(sl.date), createdAt: new Date(sl.createdAt), createdBy: sl.createdBy } });
    }
    await tx.planSnapshot.delete({ where: { id: snap.id } });
  });
  return { ok: true, restored: tasks.length };
}

app.post("/plan-snapshots/:id/restore", async (req: Request, res: Response) => {
  const r = await restoreSnapshot(req.user!.companyId, String(req.params.id));
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  await markMoveUndone(req, { snapshotId: String(req.params.id) });
  res.json({ restored: r.restored });
});

// «Реестр переносов» за период по времени действия: ?from=&to= — ISO-моменты (границы дней считает браузер
// в своём часовом поясе), по умолчанию последние 30 дней
app.get("/plan-moves", async (req: Request, res: Response) => {
  const at = (s: unknown) => { const d = typeof s === "string" ? new Date(s) : null; return d && !isNaN(d.getTime()) ? d : null; };
  const to = at(req.query.to) ?? new Date();
  const from = at(req.query.from) ?? new Date(to.getTime() - 30 * 86400000);
  const rows = await prisma.planMove.findMany({
    where: { companyId: req.user!.companyId, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  res.json(rows);
});

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

  // Скрытые категории и участки в графике не показываем
  where.orderItem = {
    ...where.orderItem,
    product: { ...where.orderItem?.product, category: { ...where.orderItem?.product?.category, visible: true, workshop: { visible: true } } },
  };

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
    // Задача, добавленная вручную, — ручная правка: автопланирование её не трогает
    const createData: {
      orderItem: { connect: { id: string } };
      date: Date;
      plannedQuantity: number;
      manuallyPlaced: boolean;
      manualAt: Date;
      manualBy: string | null;
      team?: { connect: { id: string } };
    } = {
      orderItem: { connect: { id: orderItemId } },
      date: taskDate,
      plannedQuantity: plannedQuantity !== undefined ? plannedQuantity : 0,
      manuallyPlaced: true,
      ...manualStamp(req),
    };
    if (teamId && typeof teamId === "string") {
      createData.team = { connect: { id: teamId } };
    }
    // Поставили позицию в график руками — столько же снятого вручную уже не «висит»
    if (createData.plannedQuantity > 0) {
      const oi = await prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { offPlanQty: true } });
      if (oi && oi.offPlanQty > 0) {
        const left = Math.max(0, oi.offPlanQty - createData.plannedQuantity);
        await prisma.orderItem.update({
          where: { id: orderItemId },
          data: left > 0 ? { offPlanQty: left } : { offPlanQty: 0, offPlanAt: null, offPlanBy: null, offPlanTeamId: null },
        });
      }
    }
    await prisma.emptySlot.deleteMany({ where: { orderItemId, date: taskDate } });
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
    // «Отменить» снятие с графика восстанавливает задачи этим же запросом — запись реестра помечаем отменённой
    if (typeof req.body.undoOf === "string") await markMoveUndone(req, { id: req.body.undoOf });
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
  const { plannedQuantity, teamId, date, manuallyPlaced } = req.body;
  // Заполнять ли освободившееся место при переносе (по умолчанию да): false — очередь не подтягивается
  const fill = req.body.fill !== false;

  const data: {
    plannedQuantity?: number;
    teamId?: string | null;
    date?: Date;
    manuallyPlaced?: boolean;
    manualAt?: Date | null;
    manualBy?: string | null;
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
    const current = await prisma.dailyTask.findUnique({
      where: { id },
      select: { date: true, teamId: true, orderItemId: true, plannedQuantity: true, actualQuantity: true },
    });
    if (!current) return res.status(404).json({ error: "Daily task not found" });
    const dateChanged = data.date !== undefined && data.date.getTime() !== current.date.getTime();
    const teamChanged = data.teamId !== undefined && data.teamId !== current.teamId;

    // Реальная правка количества, бригады или даты — ручная: перепланирование её больше не трогает.
    // Снять закрепление — явный manuallyPlaced: false (задача снова отдаётся автопланированию)
    const changed =
      (data.plannedQuantity !== undefined && data.plannedQuantity !== current.plannedQuantity) ||
      (data.teamId !== undefined && data.teamId !== current.teamId) ||
      (data.date !== undefined && data.date.getTime() !== current.date.getTime());
    if (changed) Object.assign(data, { manuallyPlaced: true, ...manualStamp(req) });
    if (manuallyPlaced === true && !changed) Object.assign(data, { manuallyPlaced: true, ...manualStamp(req) });
    if (manuallyPlaced === false) Object.assign(data, { manuallyPlaced: false, manualAt: null, manualBy: null });

    // Перенос позиции целиком: все её задачи без факта (все дни, все бригады) встают с новой даты в новую
    // бригаду одним куском (закреплённо, как обычный перенос), остальные задачи бригады сдвигаются вправо.
    // Освободившееся место в старых днях — по fill, как при переносе одной задачи
    if (req.body.wholeItem === true && (dateChanged || teamChanged)) {
      const itemTasks = await prisma.dailyTask.findMany({
        where: { orderItemId: current.orderItemId, actualQuantity: null, plannedQuantity: { gt: 0 } },
        select: { id: true, date: true, teamId: true, plannedQuantity: true },
      });
      const qty = itemTasks.reduce((sum, t) => sum + t.plannedQuantity, 0);
      const targetTeamId = data.teamId !== undefined ? data.teamId : current.teamId;
      const targetDate = data.date ?? current.date;
      if (!targetTeamId) return res.status(400).json({ error: "Для переноса позиции целиком нужна бригада" });
      // Бригада должна делать этот товар — иначе позиция не встанет, а её задачи уже будут удалены
      const oiProd = await prisma.orderItem.findUnique({ where: { id: current.orderItemId }, select: { productId: true, product: { select: { categoryId: true } }, order: { select: { companyId: true } } } });
      const ptcTeams = (await prisma.productTeamCapacity.findMany({ where: { productId: oiProd!.productId, companyId: oiProd!.order.companyId, capacityPerDay: { gt: 0 } }, select: { teamId: true } })).map(p => p.teamId);
      const capable = ptcTeams.length > 0 ? ptcTeams : await getAvailableTeamsForCategory(oiProd!.product.categoryId, oiProd!.order.companyId);
      if (!capable.includes(targetTeamId)) return res.status(400).json({ error: "Эта бригада не делает этот товар — для переноса позиции целиком выберите бригаду с нормой" });
      const srcTeams = [...new Set(itemTasks.map(t => t.teamId).filter((t): t is string => !!t))];
      const srcFrom = itemTasks.reduce((m, t) => (t.date < m ? t.date : m), current.date);
      const teamIds = [...new Set([...srcTeams, targetTeamId])];
      const snapFrom = srcFrom < targetDate ? srcFrom : targetDate;
      const before = await teamPlanSnapshot(teamIds, snapFrom);
      const undo = await captureSnapshot(teamIds, snapFrom, current.orderItemId);
      await prisma.dailyTask.deleteMany({ where: { id: { in: itemTasks.map(t => t.id) } } });
      const placed = await placeItemOnTeam(current.orderItemId, targetTeamId, targetDate, { mode: "date", planQty: qty, stamp: manualStamp(req) });
      if (fill) for (const t of srcTeams) await replanTeamFrom(t, srcFrom);
      else await markEmptySlots(current.orderItemId, itemTasks.map(t => ({ date: t.date, teamId: t.teamId })), req.user?.email ?? null);
      const after = await teamPlanSnapshot(teamIds, snapFrom);
      let cascade = { ...(await describeMove(before, after, current.date, current.orderItemId)), filled: fill };
      const load = await calculateTeamLoad(targetTeamId, targetDate);
      const cap = (await prisma.teamDayCapacity.findUnique({ where: { teamId_date: { teamId: targetTeamId, date: targetDate } } }))?.factor ?? 1;
      if (load > cap + 0.005) cascade = { ...cascade, overload: { load: Math.round(load * 100), capacity: Math.round(cap * 100) } };
      const undoId = await saveSnapshot(req.user!.companyId, undo);
      // Встало меньше, чем снимали (нет мощности) — возвращаем всё как было
      const placedAgg = await prisma.dailyTask.aggregate({ where: { orderItemId: current.orderItemId, actualQuantity: null }, _sum: { plannedQuantity: true } });
      if ((placedAgg._sum.plannedQuantity ?? 0) < qty) {
        await restoreSnapshot(req.user!.companyId, undoId);
        return res.status(400).json({ error: "Не получилось перенести позицию целиком: у бригады нет свободной мощности на этот товар" });
      }
      const placedDates = (await prisma.dailyTask.findMany({ where: { id: { in: placed } }, select: { date: true } })).map(t => t.date);
      await logMove(req, {
        kind: "moveWhole", orderItemId: current.orderItemId, qty, days: itemTasks.length,
        from: itemTasks.map(t => t.date), fromTeamIds: itemTasks.map(t => t.teamId),
        to: placedDates.length ? placedDates : [targetDate], toTeamId: targetTeamId, filled: fill, snapshotId: undoId,
      });
      return res.json({ id: placed[0] ?? null, wholeItem: true, qty, days: itemTasks.length, autoAdjust: true, cascade, undoId });
    }

    // «Отменить» переноса — через снимок плана: задача могла влиться в автоматическую задачу позиции и после
    // пересборки бригады получить другой id. Задача с фактом — по-старому, обратным переносом (факт в снимок не входит)
    const snapTarget = data.date ?? current.date;
    const snapTeams = [...new Set([current.teamId, data.teamId !== undefined ? data.teamId : current.teamId].filter((t): t is string => !!t))];
    const undoSnap = (dateChanged || teamChanged) && current.actualQuantity === null && snapTeams.length > 0
      ? await captureSnapshot(snapTeams, current.date < snapTarget ? current.date : snapTarget, current.orderItemId)
      : null;

    const include = {
      orderItem: { include: { order: true, product: { include: { category: true } } } },
      team: true,
    } as const;
    let task;
    // Перенос в день, где у позиции уже идёт автоматическая задача: количество сливается в неё
    let mergedIntoOwn = false;
    const dst = data.date !== undefined && data.date.getTime() !== current.date.getTime()
      ? await prisma.dailyTask.findUnique({ where: { orderItemId_date: { orderItemId: current.orderItemId, date: data.date } } })
      : null;
    if (data.date !== undefined && data.date.getTime() !== current.date.getTime() && (current.actualQuantity !== null || dst)) {
      // Переезжает только план: на новую дату ставится плановая задача, а если у позиции там уже есть
      // задача — количество дописывается в неё. Факт остаётся на своём дне (план 0), задача без факта удаляется
      const qty = data.plannedQuantity ?? current.plannedQuantity;
      const teamId = data.teamId !== undefined ? data.teamId : current.teamId;
      // Если в этом дне у позиции уже есть автоматическая задача — сливаемся в неё и остаёмся
      // автоматическими: иначе вся задача станет ручной и каскад не сможет сдвинуть лишнее
      mergedIntoOwn = !!dst && !dst.manuallyPlaced;
      const moved = dst
        ? await prisma.dailyTask.update({ where: { id: dst.id }, data: { plannedQuantity: dst.plannedQuantity + qty, teamId, manuallyPlaced: dst.manuallyPlaced }, include })
        : await prisma.dailyTask.create({ data: { orderItemId: current.orderItemId, date: data.date, plannedQuantity: qty, teamId, manuallyPlaced: true, ...manualStamp(req) }, include });
      if (current.actualQuantity !== null) await prisma.dailyTask.update({ where: { id }, data: { plannedQuantity: 0 } });
      else await prisma.dailyTask.delete({ where: { id } });
      task = moved;
    } else {
      task = await prisma.dailyTask.update({ where: { id }, data, include });
    }

    // Перенос (другая дата или бригада): план затронутых бригад пересобирается планировщиком с самого
    // раннего затронутого дня — лишнее в новом дне уходит дальше, освободившееся место занимает очередь.
    // fill: false — «не заполнять»: старая бригада не трогается, новая пересобирается с нового дня
    // без сдвига задач раньше их дня (место остаётся пустым: полуфабрикаты не готовы, бригада нужна под
    // другое). Делаем сразу (не в фоне), чтобы ответить, что сдвинулось и что встало на место задачи.
    let cascade: Awaited<ReturnType<typeof describeMove>> | null = null;
    if (dateChanged || teamChanged) {
      const minDate = (a: Date, b: Date) => (a < b ? a : b);
      const plans: { teamId: string; from: Date }[] = [];
      if (fill) {
        if (task.teamId) plans.push({ teamId: task.teamId, from: task.teamId === current.teamId ? minDate(task.date, current.date) : task.date });
        if (current.teamId && current.teamId !== task.teamId) plans.push({ teamId: current.teamId, from: current.date });
      } else if (task.teamId) {
        plans.push({ teamId: task.teamId, from: task.date });
      }
      const from = plans.reduce((m, p) => minDate(m, p.from), minDate(task.date, current.date));
      const teamIds = [...new Set([...plans.map(p => p.teamId), ...(current.teamId ? [current.teamId] : [])])];
      const before = await teamPlanSnapshot(teamIds, from);
      for (const p of plans) await replanTeamFrom(p.teamId, p.from, { keepStarts: !fill });
      if (!fill && dateChanged) await markEmptySlots(current.orderItemId, [{ date: current.date, teamId: current.teamId }], req.user?.email ?? null);
      // Позиция снова встала в этот день — пометка «оставлено пустым» здесь больше не нужна
      await prisma.emptySlot.deleteMany({ where: { orderItemId: current.orderItemId, date: task.date } });
      const after = await teamPlanSnapshot(teamIds, from);
      cascade = { ...(await describeMove(before, after, current.date, current.orderItemId)), mergedIntoOwn, filled: fill };
      // День всё ещё перегружен — значит, там только ручные задачи (их пересборка не двигает): сообщаем
      if (task.teamId) {
        const load = await calculateTeamLoad(task.teamId, task.date);
        const cap = (await prisma.teamDayCapacity.findUnique({ where: { teamId_date: { teamId: task.teamId, date: task.date } } }))?.factor ?? 1;
        if (load > cap + 0.005) cascade = { ...cascade, overload: { load: Math.round(load * 100), capacity: Math.round(cap * 100) } };
      }
    }

    // Реестр переносов: «Отменить» (undoOf) не пишет новую строку, а помечает отменённой исходную
    const undoId = undoSnap ? await saveSnapshot(req.user!.companyId, undoSnap) : undefined;
    let moveId: string | null = null;
    if (dateChanged || teamChanged) {
      if (typeof req.body.undoOf === "string") await markMoveUndone(req, { id: req.body.undoOf });
      else moveId = await logMove(req, {
        kind: "move", orderItemId: current.orderItemId, qty: data.plannedQuantity ?? current.plannedQuantity,
        from: [current.date], fromTeamIds: [current.teamId], to: [task.date], toTeamId: task.teamId, filled: fill,
        ...(undoId ? { snapshotId: undoId } : {}),
      });
    }

    res.json({ ...task, autoAdjust: dateChanged || teamChanged, cascade, moveId, undoId });
  } catch (err: any) {
    if (err.code === "P2002") {
      res.status(409).json({ error: "Task for this order item and date already exists" });
    } else {
      res.status(404).json({ error: "Daily task not found" });
    }
  }
});

// Снять задачу с графика. ?whole=1 — всю позицию: все её задачи без факта (дни с фактом — история, не трогаем).
// Снятое запоминается у позиции (offPlanQty): автоматика его обратно не ставит, позиция видна в «Не в графике»
app.delete("/daily-tasks/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string") return res.status(400).json({ error: "Invalid id" });
  const whole = req.query.whole === "1";

  try {
    // Факт не удаляем никогда: у задачи с фактом убирается только план
    const task = await prisma.dailyTask.findUniqueOrThrow({
      where: { id },
      select: { id: true, orderItemId: true, date: true, teamId: true, plannedQuantity: true, actualQuantity: true, manuallyPlaced: true },
    });
    const targets = whole
      ? await prisma.dailyTask.findMany({
          where: { orderItemId: task.orderItemId, actualQuantity: null, plannedQuantity: { gt: 0 } },
          select: { id: true, orderItemId: true, date: true, teamId: true, plannedQuantity: true, actualQuantity: true, manuallyPlaced: true },
        })
      : [task];
    let removed = 0;
    const deleted: { date: Date; teamId: string | null; plannedQuantity: number; manuallyPlaced: boolean }[] = [];
    for (const t of targets) {
      if (t.actualQuantity !== null) {
        await prisma.dailyTask.update({ where: { id: t.id }, data: { plannedQuantity: 0 } });
      } else {
        await prisma.dailyTask.delete({ where: { id: t.id } });
        removed += t.plannedQuantity;
        deleted.push({ date: t.date, teamId: t.teamId, plannedQuantity: t.plannedQuantity, manuallyPlaced: t.manuallyPlaced });
      }
    }
    if (removed > 0) {
      await prisma.orderItem.update({
        where: { id: task.orderItemId },
        data: { offPlanQty: { increment: removed }, offPlanAt: new Date(), offPlanBy: req.user?.email ?? null, offPlanTeamId: task.teamId },
      });
    }
    const moveId = removed > 0
      ? await logMove(req, {
          kind: whole ? "removeWhole" : "remove", orderItemId: task.orderItemId, qty: removed, days: deleted.length,
          from: deleted.map(t => t.date), fromTeamIds: deleted.map(t => t.teamId),
        })
      : null;
    res.json({ removed, deleted, moveId });
  } catch (err) {
    res.status(404).json({ error: "Daily task not found" });
  }
});

// --- Очистить весь график (только план; факт остаётся) ---

app.delete("/daily-tasks", requireAuth, async (req: Request, res: Response) => {
  const companyId = (req as any).user.companyId;
  const scope = { plannedQuantity: { gt: 0 }, orderItem: { order: { companyId } } };
  // Задачи без факта удаляем, у задач с фактом обнуляем план — факт не трогаем никогда
  const { count } = await prisma.dailyTask.deleteMany({ where: { ...scope, actualQuantity: null } });
  const kept = await prisma.dailyTask.updateMany({ where: { ...scope, actualQuantity: { not: null } }, data: { plannedQuantity: 0 } });
  res.json({ deleted: count, keptFact: kept.count });
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
    // Обе части — ручные правки
    const task1 = await prisma.dailyTask.update({
      where: { id },
      data: { plannedQuantity: qty1, manuallyPlaced: true, ...manualStamp(req) },
      include: { orderItem: { include: { order: true, product: { include: { category: { include: { workshop: true } } } } } }, team: true },
    });

    // Создаём вторую задачу
    const task2 = await prisma.dailyTask.create({
      data: {
        orderItemId: original.orderItemId,
        teamId: original.teamId,
        date: targetDate,
        plannedQuantity: qty2,
        manuallyPlaced: true,
        ...manualStamp(req),
      },
      include: { orderItem: { include: { order: true, product: { include: { category: { include: { workshop: true } } } } } }, team: true },
    });

    await logMove(req, {
      kind: "split", orderItemId: original.orderItemId, qty: qty2,
      from: [original.date], fromTeamIds: [original.teamId], to: [targetDate], toTeamId: original.teamId,
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

// Мощность бригады на день в долях: 1 = 100%. Больше 1 — бригада успевает больше (сверхурочные, усиление)
const MAX_DAY_FACTOR = 5;

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
  if (typeof factor !== "number" || factor < 0 || factor > MAX_DAY_FACTOR) return res.status(400).json({ error: `Мощность — от 0 до ${MAX_DAY_FACTOR * 100}%` });

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

// Корректировка мощности на период: раскладывается на рабочие дни (в выходные и праздники планировщик
// не планирует). 100% без причины — сброс: корректировки в периоде удаляются.
app.post("/team-day-capacity/range", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const { teamId, dateFrom, dateTo, factor, note } = req.body;

  if (!teamId || typeof teamId !== "string") return res.status(400).json({ error: "teamId is required" });
  if (typeof factor !== "number" || factor < 0 || factor > MAX_DAY_FACTOR) return res.status(400).json({ error: `Мощность — от 0 до ${MAX_DAY_FACTOR * 100}%` });
  const from = new Date(String(dateFrom ?? "") + "T00:00:00.000Z");
  const to = new Date(String(dateTo ?? dateFrom ?? "") + "T00:00:00.000Z");
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return res.status(400).json({ error: "Даты нужны в формате YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "Дата «по» раньше даты «с»" });
  if ((to.getTime() - from.getTime()) / 86400000 > 366) return res.status(400).json({ error: "Период — не больше года" });

  const teamOwned = await prisma.team.findFirst({ where: { id: teamId, companyId: cid } });
  if (!teamOwned) return res.status(404).json({ error: "Team not found" });

  const noteText = typeof note === "string" && note.trim() ? note.trim() : null;
  const days: Date[] = [];
  for (const d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (isWorkingDay(new Date(d))) days.push(new Date(d));
  }

  if (factor === 1 && !noteText) {
    const { count } = await prisma.teamDayCapacity.deleteMany({ where: { teamId, date: { gte: from, lte: to } } });
    res.json({ saved: 0, removed: count, days: days.length });
    return;
  }
  for (const date of days) {
    await prisma.teamDayCapacity.upsert({
      where: { teamId_date: { teamId, date } },
      update: { factor, note: noteText },
      create: { teamId, date, factor, note: noteText },
    });
  }
  res.json({ saved: days.length, removed: 0, days: days.length });
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

  // Ручные задачи и задачи с фактом не переносим
  const movable = tasks.filter(t => !t.manuallyPlaced && t.actualQuantity === null);

  // Следующий рабочий день (просто +1 день)
  const nextDay = new Date(dayDate);
  nextDay.setDate(nextDay.getDate() + 1);

  const moved: { orderItemId: string; qty: number }[] = [];

  for (const task of movable) {
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
    // Назначение бригады вручную — ручная правка
    const updateData = { teamId: teamId === null || teamId === "" ? null : teamId, manuallyPlaced: true, ...manualStamp(req) };

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
    const options: { startDate?: Date; preferredTeamId?: string; reservedQty?: number } = {};

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

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    options.reservedQty = await plannedAheadQty(id, today);
    // «Автоплан» позиции — явное «поставить в график»: снятое вручную тоже планируется
    const result = await autoPlanOrderItem(id, { ...options, ignoreHold: true });
    await prisma.orderItem.update({ where: { id }, data: { offPlanQty: 0, offPlanAt: null, offPlanBy: null, offPlanTeamId: null } });

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

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const results = [];
    for (const item of orderItems) {
      results.push(await (async () => {
        const product = (item as { product: { code: string } }).product;
        try {
          const result = await autoPlanOrderItem(item.id, { ...options, reservedQty: await plannedAheadQty(item.id, today), ignoreHold: true });
          await prisma.orderItem.update({ where: { id: item.id }, data: { offPlanQty: 0, offPlanAt: null, offPlanBy: null, offPlanTeamId: null } });
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
      })());
    }

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

// ─── Загрузка бригад (аналитика) ─────────────────────────────────────────────
// Загрузка считается так же, как в планировщике: Σ доли бригадо-дня (loadShare или
// штуки / норма бригады × численность), с учётом корректировок мощности на день.

function parseRangeQuery(req: Request): { from: Date; to: Date } | null {
  const from = new Date(String(req.query.dateFrom ?? "") + "T00:00:00.000Z");
  const to = new Date(String(req.query.dateTo ?? "") + "T00:00:00.000Z");
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) return null;
  return { from, to };
}

function daysInRange(from: Date, to: Date): { date: string; working: boolean }[] {
  const out: { date: string; working: boolean }[] = [];
  for (const d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push({ date: d.toISOString().slice(0, 10), working: isWorkingDay(new Date(d)) });
  }
  return out;
}

// Задачи бригад за период с долей дня по каждой задаче
async function teamTasksWithLoad(companyId: string, from: Date, to: Date, teamIds?: string[]) {
  const tasks = await prisma.dailyTask.findMany({
    where: {
      date: { gte: from, lte: to },
      teamId: teamIds ? { in: teamIds } : { not: null },
      orderItem: { order: { companyId } },
    },
    select: {
      id: true, date: true, teamId: true, plannedQuantity: true, actualQuantity: true, loadShare: true, manuallyPlaced: true,
      orderItem: {
        select: {
          id: true,
          order: { select: { orderNumber: true, customer: true } },
          product: { select: { id: true, code: true, name: true, capacityPerDay: true, category: { select: { capacityPerTeamPerDay: true, ...CAT_VISIBILITY } } } },
        },
      },
    },
    orderBy: { date: "asc" },
  });
  const ids = [...new Set(tasks.map(t => t.teamId!))];
  const productIds = [...new Set(tasks.map(t => t.orderItem.product.id))];
  const [teams, ptcs] = await Promise.all([
    prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, headcount: true } }),
    productIds.length > 0
      ? prisma.productTeamCapacity.findMany({ where: { companyId, productId: { in: productIds }, teamId: { in: ids } }, select: { productId: true, teamId: true, capacityPerDay: true } })
      : Promise.resolve([]),
  ]);
  const headcount = new Map(teams.map(t => [t.id, t.headcount]));
  const ptcMap = new Map(ptcs.map(p => [`${p.productId}|${p.teamId}`, p.capacityPerDay]));
  return tasks.map(t => {
    const p = t.orderItem.product;
    const capPerPerson = ptcMap.get(`${p.id}|${t.teamId}`) ?? p.capacityPerDay ?? p.category.capacityPerTeamPerDay;
    const cap = capPerPerson * (headcount.get(t.teamId!) ?? 1);
    return { ...t, date: t.date.toISOString().slice(0, 10), cap, share: taskLoad(t, cap) };
  });
}

// Матрица «бригада × день»: загрузка в долях дня. Бригады — те, у кого есть нормы или задачи в периоде.
// Перегрузка (> мощности дня) и недогрузка (рабочий день < 100%) считаются на фронте из этой матрицы.
app.get("/planning/load-matrix", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const range = parseRangeQuery(req);
  if (!range) return res.status(400).json({ error: "dateFrom и dateTo обязательны (YYYY-MM-DD)" });
  if ((range.to.getTime() - range.from.getTime()) / 86400000 > 92) return res.status(400).json({ error: "Период не больше 3 месяцев" });

  const [tasks, teams, dayCaps] = await Promise.all([
    teamTasksWithLoad(cid, range.from, range.to),
    prisma.team.findMany({
      where: { companyId: cid },
      select: { id: true, name: true, headcount: true, _count: { select: { productCapacities: { where: { capacityPerDay: { gt: 0 } } } } } },
    }),
    prisma.teamDayCapacity.findMany({ where: { team: { companyId: cid }, date: { gte: range.from, lte: range.to } } }),
  ]);
  const days = daysInRange(range.from, range.to);
  const factor = new Map(dayCaps.map(c => [`${c.teamId}|${c.date.toISOString().slice(0, 10)}`, c.factor]));
  const cells = new Map<string, { load: number; planned: number; actual: number; tasks: number }>();
  for (const t of tasks) {
    const key = `${t.teamId}|${t.date}`;
    const c = cells.get(key) ?? { load: 0, planned: 0, actual: 0, tasks: 0 };
    c.load += t.share; c.planned += t.plannedQuantity; c.actual += t.actualQuantity ?? 0; c.tasks += t.plannedQuantity > 0 ? 1 : 0;
    cells.set(key, c);
  }
  const withTasks = new Set(tasks.map(t => t.teamId));
  // Бригады, занятые только скрытыми категориями, не показываем; у остальных загрузка
  // считается со скрытой работой — она реально занимает бригаду
  const hidden = await hiddenTeamIds(cid);

  const result = teams
    .filter(t => !hidden.has(t.id) && (t._count.productCapacities > 0 || withTasks.has(t.id)))
    .map(t => {
      const byDay = days.map(d => {
        const c = cells.get(`${t.id}|${d.date}`);
        return {
          date: d.date,
          load: Math.round((c?.load ?? 0) * 1000) / 1000,
          capacity: d.working ? (factor.get(`${t.id}|${d.date}`) ?? 1) : 0,
          planned: c?.planned ?? 0,
          actual: c?.actual ?? 0,
          tasks: c?.tasks ?? 0,
        };
      });
      const working = byDay.filter(d => d.capacity > 0);
      const avg = working.length ? working.reduce((s, d) => s + d.load / d.capacity, 0) / working.length : 0;
      return { teamId: t.id, teamName: t.name, headcount: t.headcount, avgLoad: Math.round(avg * 1000) / 1000, days: byDay };
    })
    .sort((a, b) => a.teamName.localeCompare(b.teamName, "ru", { numeric: true }));

  res.json({ days, teams: result });
});

// Загрузка одной бригады: позиции × дни (штуки и доля дня) + итог по дню
app.get("/planning/team-load", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  const teamId = req.query.teamId as string | undefined;
  const range = parseRangeQuery(req);
  if (!teamId) return res.status(400).json({ error: "teamId is required" });
  if (!range) return res.status(400).json({ error: "dateFrom и dateTo обязательны (YYYY-MM-DD)" });

  const team = await prisma.team.findFirst({ where: { id: teamId, companyId: cid }, select: { id: true, name: true, headcount: true } });
  if (!team) return res.status(404).json({ error: "Team not found" });

  const [tasks, dayCaps] = await Promise.all([
    teamTasksWithLoad(cid, range.from, range.to, [teamId]),
    prisma.teamDayCapacity.findMany({ where: { teamId, date: { gte: range.from, lte: range.to } } }),
  ]);
  const factor = new Map(dayCaps.map(c => [c.date.toISOString().slice(0, 10), c.factor]));
  const days = daysInRange(range.from, range.to).map(d => {
    const dayTasks = tasks.filter(t => t.date === d.date);
    return {
      date: d.date,
      capacity: d.working ? (factor.get(d.date) ?? 1) : 0,
      load: Math.round(dayTasks.reduce((s, t) => s + t.share, 0) * 1000) / 1000,
    };
  });

  const rows = new Map<string, { orderItemId: string; orderNumber: string; customer: string; productCode: string; productName: string; capPerDay: number; cells: Record<string, { planned: number; actual: number | null; share: number; manual: boolean }> }>();
  for (const t of tasks) {
    if (t.plannedQuantity <= 0 && !t.actualQuantity) continue;
    // Скрытые категории и участки — одной строкой, чтобы загрузка дня сходилась с позициями
    if (!catVisible(t.orderItem.product.category)) {
      const h = rows.get("hidden") ?? { orderItemId: "hidden", orderNumber: "Скрытые категории", customer: "", productCode: "", productName: "позиции скрытых категорий и участков", capPerDay: 0, cells: {} };
      const c = h.cells[t.date] ?? { planned: 0, actual: null, share: 0, manual: false };
      c.planned += t.plannedQuantity;
      c.share = Math.round((c.share + t.share) * 1000) / 1000;
      if (t.actualQuantity) c.actual = (c.actual ?? 0) + t.actualQuantity;
      h.cells[t.date] = c;
      rows.set("hidden", h);
      continue;
    }
    const r = rows.get(t.orderItem.id) ?? {
      orderItemId: t.orderItem.id,
      orderNumber: t.orderItem.order.orderNumber,
      customer: t.orderItem.order.customer,
      productCode: t.orderItem.product.code,
      productName: t.orderItem.product.name,
      capPerDay: Math.round(t.cap * 10) / 10,
      cells: {},
    };
    r.cells[t.date] = { planned: t.plannedQuantity, actual: t.actualQuantity, share: Math.round(t.share * 1000) / 1000, manual: t.manuallyPlaced };
    rows.set(t.orderItem.id, r);
  }
  // Позиции в порядке, в котором бригада их делает
  const list = [...rows.values()].sort((a, b) =>
    (Object.keys(a.cells).sort()[0] ?? "").localeCompare(Object.keys(b.cells).sort()[0] ?? ""));

  res.json({ teamId, teamName: team.name, headcount: team.headcount, days, rows: list });
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

    // Удаляем будущие автоматические задачи заказа; факт и ручные правки остаются
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await prisma.dailyTask.deleteMany({
      where: { orderItemId: { in: orderWithItems.items.map(i => i.id) }, actualQuantity: null, manuallyPlaced: false, date: { gte: today } },
    });

    // Перепланируем позиции по очереди (параллельно они видели бы устаревшую загрузку бригад)
    const results = [];
    for (const item of orderWithItems.items) {
      results.push(await (async () => {
        try {
          const manual = await manualPlanOf(item.id, today);
          const result = await autoPlanOrderItem(item.id, force ? manual : { startDate: new Date(), ...manual });
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
      })());
    }

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

// Выгрузка плана в Excel (формат export_to_be.xlsx): плоская таблица, строка = позиция заказа × бригада,
// в каждой строке номер заказа и клиент (удобно фильтровать), строки — в порядке очереди планировщика,
// колонки дней — дни периода, в которые есть план. Факт не выгружается.
const PRIORITY_LABEL = (p: number) => (p <= 5 ? "Критический" : p <= 10 ? "Высокий" : p <= 20 ? "Средний" : "Низкий");

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
      orderItem: { order: { companyId: cid }, product: VISIBLE_PRODUCT },
      plannedQuantity: { gt: 0 },
      ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}),
    },
    include: {
      orderItem: {
        include: {
          order: { select: { orderNumber: true, customer: true, approvedAt: true, priority: true, raytecDate: true, productionInfo: true } },
          product: { include: { category: true } },
        },
      },
      team: true,
    },
  });

  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const fmtShort = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;
  // Даты в базе — полночь UTC; ExcelJS пишет Date по UTC, так что в Excel будет ровно этот день
  const excelDate = (d: Date | null | undefined) =>
    d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;

  type Row = {
    item: (typeof tasks)[number]["orderItem"];
    teamName: string;
    byDate: Map<string, number>;
  };
  const rows = new Map<string, Row>();
  const dateSet = new Set<string>();
  for (const t of tasks) {
    const key = `${t.orderItemId}|${t.teamId ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      row = { item: t.orderItem, teamName: t.team?.name ?? "—", byDate: new Map() };
      rows.set(key, row);
    }
    const dk = isoDate(t.date);
    dateSet.add(dk);
    row.byDate.set(dk, (row.byDate.get(dk) ?? 0) + t.plannedQuantity);
  }
  const isoDates = Array.from(dateSet).sort();

  // Порядок очереди, как у планировщика: приоритет → Дата передачи строки → дата согласования
  const sorted = Array.from(rows.values()).sort((a, b) =>
    a.item.order.priority - b.item.order.priority ||
    queueDateMs(a.item) - queueDateMs(b.item) ||
    (a.item.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.item.order.approvedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
    a.item.order.orderNumber.localeCompare(b.item.order.orderNumber) ||
    a.item.id.localeCompare(b.item.id) || // строки одного заказа — в порядке строк заказа (id растёт по мере создания)
    a.teamName.localeCompare(b.teamName));

  // Колонки и ширины — как в образце export_to_be.xlsx
  const HEAD: { title: string; width: number }[] = [
    { title: "Заказ", width: 21 },
    { title: "Артикул", width: 19 },
    { title: "Товар", width: 44 },
    { title: "Штрихкод номенклатуры", width: 22 },
    { title: "Категория", width: 22 },
    { title: "Клиент", width: 25 },
    { title: "Приоритет", width: 13 },
    { title: "Дата передачи", width: 12 },
    { title: "Бригада", width: 15 },
    { title: "Информация для производства", width: 30 },
    { title: "Итого план", width: 10 },
  ];
  const DAY_WIDTH = 8;
  const fixedCount = HEAD.length;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("План производства", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    ...HEAD.map(h => ({ width: h.width })),
    ...isoDates.map(() => ({ width: DAY_WIDTH })),
  ];
  const widths = [...HEAD.map(h => h.width), ...isoDates.map(() => DAY_WIDTH)];

  ws.addRow([...HEAD.map(h => h.title), ...isoDates.map(fmtShort)]);
  for (const r of sorted) {
    const { item } = r;
    const totalPlan = Array.from(r.byDate.values()).reduce((s, v) => s + v, 0);
    ws.addRow([
      item.order.orderNumber,
      item.product.code,
      item.product.name,
      item.product.barcode,
      item.product.category.name,
      item.order.customer,
      PRIORITY_LABEL(item.order.priority),
      excelDate(item.transferDate ?? item.order.raytecDate),
      r.teamName,
      item.order.productionInfo,
      totalPlan,
      ...isoDates.map(d => r.byDate.get(d) ?? null),
    ]);
  }

  // Оформление как в образце: шапка — белый текст на сером (50%), строки чередуются белая / светло-серая,
  // тонкие белые границы, Calibri 12, перенос текста во всех ячейках
  const FONT = { name: "Calibri", size: 12 };
  const WHITE_BORDER = { style: "thin" as const, color: { argb: "FFFFFFFF" } };
  const border = { top: WHITE_BORDER, left: WHITE_BORDER, bottom: WHITE_BORDER, right: WHITE_BORDER };
  const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
  const HEADER_FILL = fill("FF7F7F7F");
  const STRIPE_FILL = fill("FFF2F2F2");
  const LINE_HEIGHT = 15.6; // строка текста Calibri 12, пт

  // Excel сам не подбирает высоту строк с переносом в файле, сгенерированном программой — считаем:
  // слова раскладываются по строкам ширины колонки (символов в строке ≈ ширина колонки, шрифт 12 чуть шире 11)
  const linesFor = (value: unknown, width: number) => {
    if (typeof value !== "string" || value === "") return 1; // числа и даты — в одну строку
    const perLine = Math.max(1, Math.floor(width * 0.9) - 1);
    let lines = 1, used = 0;
    for (const word of String(value).split(/\s+/)) {
      const len = word.length;
      if (used === 0) used = len;
      else if (used + 1 + len <= perLine) used += 1 + len;
      else { lines++; used = len; }
      while (used > perLine) { lines++; used -= perLine; }
    }
    return lines;
  };

  ws.eachRow((row, rowNumber) => {
    const isHeader = rowNumber === 1;
    let lines = 1;
    for (let c = 1; c <= widths.length; c++) {
      const cell = row.getCell(c);
      cell.font = isHeader ? { ...FONT, bold: c <= fixedCount - 1, color: { argb: "FFFFFFFF" } } : FONT;
      cell.border = border;
      cell.alignment = { wrapText: true };
      if (isHeader) cell.fill = HEADER_FILL;
      else if (rowNumber % 2 === 1) cell.fill = STRIPE_FILL;
      if (!isHeader && c === fixedCount - 3) cell.numFmt = "dd.mm.yyyy"; // Дата передачи
      if (c <= fixedCount) lines = Math.max(lines, linesFor(cell.value, widths[c - 1]!));
    }
    row.height = Math.max(2, lines) * LINE_HEIGHT;
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="plan.xlsx"');
  res.send(Buffer.from(buf as ArrayBuffer));
});

app.post("/planning/replan-queue", async (req: Request, res: Response) => {
  const cid = req.user!.companyId;
  try {
    // 1. Удаляем только будущие автоматические задачи без факта: история и ручные правки остаются
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deleted = await prisma.dailyTask.deleteMany({
      where: { actualQuantity: null, manuallyPlaced: false, date: { gte: today }, orderItem: { order: { companyId: cid } } },
    });

    // 2. Get all order items with their orders
    const allItems = await prisma.orderItem.findMany({
      where: { order: { companyId: cid, active: true } },
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
        // Приоритет (наше решение — оставляем), затем Дата передачи строки (как у Raytec), затем дата согласования
        if (a.item.order.priority !== b.item.order.priority) return a.item.order.priority - b.item.order.priority;
        const rayA = queueDateMs(a.item);
        const rayB = queueDateMs(b.item);
        if (rayA !== rayB) return rayA - rayB;
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

    for (const { item, remaining } of toplan) {
      try {
        // Остаток позиции — вокруг её ручных задач
        const manual = await manualPlanOf(item.id, today);
        if (manual.reservedQty >= remaining) continue;
        const { tasks, overloaded } = await autoPlanOrderItem(item.id, manual);
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
    where: { companyId: cid, active: true, items: { some: { product: VISIBLE_PRODUCT } } },
    include: {
      items: {
        where: { product: VISIBLE_PRODUCT },
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
      orderItem: { order: { companyId: cid }, product: VISIBLE_PRODUCT },
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
      orderItem: { order: { companyId: cid }, product: VISIBLE_PRODUCT },
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
      orderItem: { order: { companyId: cid }, product: VISIBLE_PRODUCT },
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

// ─── Чат-помощник (Alice AI) ─────────────────────────────────────────────────

registerAssistant(app, prisma as unknown as PrismaClient);

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

