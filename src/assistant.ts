// Чат-помощник на Alice AI (Yandex AI Studio, OpenAI-совместимый API).
// Модель не ходит в базу сама: она вызывает наши функции только для чтения (TOOLS),
// бэкенд выполняет их с companyId текущего пользователя и возвращает результат модели.

import type { Express, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";

// Читаем при каждом запросе: на проде переменные приходят из .env, который загружает Prisma
function config() {
  return {
    base: process.env["YANDEX_API_BASE"] ?? "https://ai.api.cloud.yandex.net/v1",
    key: process.env["YANDEX_API_KEY"] ?? "",
    folder: process.env["YANDEX_FOLDER_ID"] ?? "",
    model: process.env["YANDEX_MODEL"] ?? "aliceai-llm",
  };
}

const MAX_STEPS = 6;           // шагов «модель → функция» на один вопрос
const MAX_HISTORY = 20;        // сообщений истории, которые отправляем модели
const MAX_TOOL_CHARS = 30000;  // ответ функции длиннее — обрезаем
const MAX_RANGE_DAYS = 31;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type Args = Record<string, unknown>;

// ─── Описание функций для модели ─────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "find_orders",
      description: "Найти заказы по части номера, клиенту или менеджеру. Возвращает краткую сводку: сколько осталось сделать, сколько запланировано, когда закончится по плану.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Часть номера заказа (например 007988), название клиента или фамилия менеджера" },
          include_archive: { type: "boolean", description: "Искать также в архивных (неактивных) заказах" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order",
      description: "Подробно по одному заказу: все позиции, сколько осталось сделать, сколько запланировано и произведено, даты начала и окончания по плану, бригады.",
      parameters: {
        type: "object",
        properties: {
          order_number: { type: "string", description: "Номер заказа целиком или его часть, например 00ЦБ-007988 или 7988" },
        },
        required: ["order_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_schedule",
      description: "План работ по дням: что, по какому заказу и сколько штук делает бригада. Без бригады — по всем бригадам.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "Бригада: номер (8), «#8» или часть названия («кольцевых»). Пусто — все бригады" },
          date_from: { type: "string", description: "Начало периода, YYYY-MM-DD" },
          date_to: { type: "string", description: "Конец периода, YYYY-MM-DD (не больше 31 дня от начала)" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_load",
      description: "Загрузка бригад по дням в процентах (100% = бригада занята весь день). Для вопросов «кто свободен», «кто перегружен», «насколько загружена бригада».",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "Бригада: номер или часть названия. Пусто — все бригады" },
          date_from: { type: "string", description: "Начало периода, YYYY-MM-DD" },
          date_to: { type: "string", description: "Конец периода, YYYY-MM-DD (не больше 31 дня от начала)" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_products",
      description: "Найти товар по артикулу или части названия: категория, нормы выработки по бригадам (какие бригады могут его делать и сколько штук в день), в скольких активных заказах он есть.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Артикул или часть названия товара" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unplanned_items",
      description: "Позиции активных заказов, которые не запланированы или запланированы не полностью, с причиной (например, нет нормы ни для одной бригады).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "orders_by_finish_date",
      description: "Активные заказы, которые по плану заканчиваются в заданный период. Для вопросов «что отгружаем на этой неделе», «какие заказы закончатся до 15-го».",
      parameters: {
        type: "object",
        properties: {
          date_from: { type: "string", description: "Начало периода, YYYY-MM-DD" },
          date_to: { type: "string", description: "Конец периода, YYYY-MM-DD" },
        },
        required: ["date_from", "date_to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_teams",
      description: "Список бригад: численность, для скольких товаров заведены нормы, ближайший свободный рабочий день.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function systemPrompt(companyName: string): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("ru-RU", { weekday: "long", timeZone: "Europe/Moscow" });
  return [
    `Ты — помощник по производственному планированию компании «${companyName}» (производство светильников).`,
    `Сегодня ${today}, ${weekday}. Рабочие дни — пн–пт, кроме государственных праздников.`,
    "",
    "Как работать:",
    "- Любые цифры, даты, номера заказов и названия бери ТОЛЬКО из результатов функций. Не придумывай.",
    "- Если для ответа нужны данные — сначала вызови функцию. Можно вызвать несколько подряд.",
    "- Если функция ничего не нашла — так и скажи и предложи, как уточнить вопрос.",
    "- Если на вопрос нельзя ответить имеющимися функциями — честно скажи, что этих данных у тебя нет.",
    "- Отвечай по-русски, коротко и по делу. Списки — маркированные. Даты пиши как ДД.ММ.ГГГГ.",
    "- «На этой неделе», «завтра», «в ноябре» переводи в даты сам, исходя из сегодняшней. Неделя — с понедельника по пятницу; если сегодня суббота или воскресенье, «эта неделя» — ближайшая наступающая.",
    "- Даты в аргументах функций — строго YYYY-MM-DD.",
    "",
    "Термины:",
    "- Бригада — производственная бригада или рабочий центр (ВРЦ, станок). У бригады есть численность.",
    "- Норма — сколько штук товара бригада делает за день. Товар планируется только на бригады, у которых для него есть норма.",
    "- «Осталось» — сколько штук по позиции ещё нужно произвести по данным 1С (К обеспечению).",
    "- «Запланировано» — сколько штук стоит в плане по дням; «произведено» — внесённый факт.",
    "- Окончание заказа по плану — последний день, на который запланирована хоть одна его позиция.",
    "- planned_qty — весь план, включая прошедшие дни; planned_from_today_qty — план с сегодняшнего дня.",
    "- Если окончание по плану уже прошло, а «осталось» больше нуля — план просрочен, скажи об этом.",
    "- Загрузка 100% — бригада занята весь рабочий день.",
    "- production_queue_date — дата передачи заказа в производство из 1С (по ней строится очередь планирования). Это НЕ дата отгрузки и НЕ дата закрытия.",
    "- Заказ «в архиве» — его больше нет среди актуальных в 1С (выполнен или снят), он не планируется.",
  ].join("\n");
}

// ─── Вспомогательное ─────────────────────────────────────────────────────────

const day = (d: Date) => d.toISOString().slice(0, 10);
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/ё/g, "е");

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function parseRange(args: Args, maxDays: number | null): { from: Date; to: Date } | { error: string } {
  // Модель иногда присылает ДД.ММ.ГГГГ — приводим к YYYY-MM-DD
  const iso = (v: string) => v.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, "$3-$2-$1");
  const a = iso(str(args, "date_from"));
  const b = iso(str(args, "date_to")) || a;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return { error: "Даты нужны в формате YYYY-MM-DD" };
  }
  const from = new Date(a + "T00:00:00.000Z");
  const to = new Date(b + "T00:00:00.000Z");
  if (to < from) return { error: "date_to раньше date_from" };
  if (maxDays !== null && (to.getTime() - from.getTime()) / 86400000 + 1 > maxDays) {
    return { error: `Период не больше ${maxDays} дней — разбей запрос на части` };
  }
  return { from, to };
}

// «8», «#8», «бригада 8», «8 бригада» → «Бригада #8» (а не #18); иначе — поиск по части названия
function matchTeams<T extends { name: string }>(teams: T[], query: string): T[] {
  const q = lc(query).trim();
  if (!q) return teams;
  const num = q.match(/^(?:бригада\s*)?#?\s*(\d+)(?:\s*бригада)?$/);
  if (num) return teams.filter(t => new RegExp(`#${num[1]}(?!\\d)`).test(t.name));
  return teams.filter(t => lc(t.name).includes(q));
}

// ─── Реализация функций ──────────────────────────────────────────────────────

function makeTools(prisma: PrismaClient, cid: string) {
  async function capacityMaps(productIds: string[]) {
    const [ptcs, teams, products] = await Promise.all([
      prisma.productTeamCapacity.findMany({
        where: { companyId: cid, productId: { in: productIds } },
        select: { productId: true, teamId: true, capacityPerDay: true },
      }),
      prisma.team.findMany({ where: { companyId: cid }, select: { id: true, name: true, headcount: true } }),
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, capacityPerDay: true, category: { select: { capacityPerTeamPerDay: true } } },
      }),
    ]);
    const ptc = new Map(ptcs.map(p => [`${p.productId}|${p.teamId}`, p.capacityPerDay]));
    const teamById = new Map(teams.map(t => [t.id, t]));
    const productById = new Map(products.map(p => [p.id, p]));
    // Мощность бригады по товару в шт/день — так же, как calculateTeamLoad в index.ts
    const teamCap = (productId: string, teamId: string) => {
      const perPerson = ptc.get(`${productId}|${teamId}`)
        ?? productById.get(productId)?.capacityPerDay
        ?? productById.get(productId)?.category.capacityPerTeamPerDay
        ?? 0;
      return perPerson * (teamById.get(teamId)?.headcount ?? 1);
    };
    return { teamById, teamCap };
  }

  async function orderSummaries(orderIds: string[]) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds }, companyId: cid },
      select: {
        id: true, orderNumber: true, customer: true, manager: true, priority: true, active: true, raytecDate: true,
        items: { select: { quantity: true, dailyTasks: { select: { date: true, plannedQuantity: true, actualQuantity: true } } } },
      },
    });
    return orders.map(o => {
      const today = day(new Date());
      let remaining = 0, planned = 0, plannedAhead = 0, produced = 0, unplanned = 0;
      let start: Date | null = null, finish: Date | null = null;
      for (const it of o.items) {
        remaining += it.quantity;
        let itPlanned = 0;
        for (const t of it.dailyTasks) {
          itPlanned += t.plannedQuantity;
          if (day(t.date) >= today) plannedAhead += t.plannedQuantity;
          produced += t.actualQuantity ?? 0;
          if (t.plannedQuantity > 0) {
            if (!start || t.date < start) start = t.date;
            if (!finish || t.date > finish) finish = t.date;
          }
        }
        planned += itPlanned;
        if (itPlanned < it.quantity) unplanned++;
      }
      return {
        order: o.orderNumber,
        customer: o.customer,
        manager: o.manager,
        status: o.active ? "активный" : "в архиве (закрыт или снят в 1С)",
        production_queue_date: o.raytecDate ? day(o.raytecDate) : null,
        positions: o.items.length,
        positions_not_fully_planned: unplanned,
        remaining_qty: remaining,
        planned_qty: planned,
        planned_from_today_qty: plannedAhead,
        produced_qty: produced,
        plan_start: start ? day(start) : null,
        plan_finish: finish ? day(finish) : null,
      };
    });
  }

  async function findOrderIds(query: string, includeArchive: boolean) {
    const q = lc(query);
    const orders = await prisma.order.findMany({
      where: { companyId: cid, ...(includeArchive ? {} : { active: true }) },
      select: { id: true, orderNumber: true, customer: true, manager: true },
    });
    const exact = orders.filter(o => lc(o.orderNumber) === q);
    if (exact.length) return exact.map(o => o.id);
    return orders
      .filter(o => lc(o.orderNumber).includes(q) || lc(o.customer).includes(q) || lc(o.manager).includes(q))
      .map(o => o.id);
  }

  return {
    async find_orders(args: Args) {
      const query = str(args, "query");
      if (!query) return { error: "Пустой запрос" };
      const ids = await findOrderIds(query, args["include_archive"] === true);
      const list = await orderSummaries(ids.slice(0, 20));
      return { found: ids.length, shown: list.length, orders: list };
    },

    async get_order(args: Args) {
      const query = str(args, "order_number");
      if (!query) return { error: "Не указан номер заказа" };
      let ids = await findOrderIds(query, false);
      if (ids.length === 0) ids = await findOrderIds(query, true);
      if (ids.length === 0) return { error: `Заказ «${query}» не найден` };
      if (ids.length > 1) {
        return { error: "Под запрос подходит несколько заказов — уточни номер", candidates: await orderSummaries(ids.slice(0, 10)) };
      }
      const order = await prisma.order.findFirst({
        where: { id: ids[0]!, companyId: cid },
        select: {
          orderNumber: true, customer: true, manager: true, priority: true, active: true, raytecDate: true, description: true,
          items: {
            select: {
              quantity: true,
              transferDate: true,
              product: { select: { code: true, name: true, category: { select: { name: true } } } },
              dailyTasks: {
                select: { date: true, plannedQuantity: true, actualQuantity: true, team: { select: { name: true } } },
                orderBy: { date: "asc" },
              },
            },
          },
        },
      });
      if (!order) return { error: "Заказ не найден" };
      const [summary] = await orderSummaries(ids);
      return {
        ...summary,
        description: order.description,
        items: order.items.map(it => {
          const tasks = it.dailyTasks.filter(t => t.plannedQuantity > 0);
          const planned = it.dailyTasks.reduce((s, t) => s + t.plannedQuantity, 0);
          return {
            product_code: it.product.code,
            product: it.product.name,
            category: it.product.category.name,
            remaining_qty: it.quantity,
            production_queue_date: it.transferDate ? day(it.transferDate) : summary?.production_queue_date ?? null,
            planned_qty: planned,
            produced_qty: it.dailyTasks.reduce((s, t) => s + (t.actualQuantity ?? 0), 0),
            plan_start: tasks[0] ? day(tasks[0].date) : null,
            plan_finish: tasks.at(-1) ? day(tasks.at(-1)!.date) : null,
            teams: [...new Set(tasks.map(t => t.team?.name ?? "без бригады"))],
            status: planned === 0 ? "не запланирована" : planned < it.quantity ? "запланирована частично" : "запланирована",
          };
        }),
      };
    },

    async team_schedule(args: Args) {
      const range = parseRange(args, MAX_RANGE_DAYS);
      if ("error" in range) return range;
      const allTeams = await prisma.team.findMany({ where: { companyId: cid }, select: { id: true, name: true } });
      const teams = matchTeams(allTeams, str(args, "team"));
      if (teams.length === 0) return { error: `Бригада «${str(args, "team")}» не найдена`, teams: allTeams.map(t => t.name) };
      const tasks = await prisma.dailyTask.findMany({
        where: {
          teamId: { in: teams.map(t => t.id) },
          date: { gte: range.from, lte: range.to },
          plannedQuantity: { gt: 0 },
          orderItem: { order: { companyId: cid } },
        },
        select: {
          date: true, plannedQuantity: true, actualQuantity: true, loadShare: true, teamId: true,
          orderItem: { select: { productId: true, order: { select: { orderNumber: true, customer: true } }, product: { select: { code: true, name: true } } } },
        },
        orderBy: [{ date: "asc" }],
        take: 201,
      });
      const { teamById, teamCap } = await capacityMaps([...new Set(tasks.map(t => t.orderItem.productId))]);
      // Строки вместо объектов — так ответ в 3–4 раза короче и помещается целиком
      return {
        shown: Math.min(tasks.length, 200),
        truncated: tasks.length > 200 ? "Показаны первые 200 строк — для полного ответа сузь период или укажи бригаду" : false,
        columns: "дата | бригада | заказ | клиент | товар | план шт | факт шт | доля дня бригады",
        tasks: tasks.slice(0, 200).map(t => {
          const cap = teamCap(t.orderItem.productId, t.teamId!);
          const share = t.loadShare ?? (cap > 0 ? t.plannedQuantity / cap : 0);
          const product = `${t.orderItem.product.code} ${t.orderItem.product.name}`;
          return [
            day(t.date),
            teamById.get(t.teamId!)?.name,
            t.orderItem.order.orderNumber,
            t.orderItem.order.customer.slice(0, 40),
            product.length > 70 ? product.slice(0, 70) + "…" : product,
            t.plannedQuantity,
            t.actualQuantity ?? "-",
            `${Math.round(share * 100)}%`,
          ].join(" | ");
        }),
      };
    },

    async team_load(args: Args) {
      const range = parseRange(args, MAX_RANGE_DAYS);
      if ("error" in range) return range;
      const allTeams = await prisma.team.findMany({ where: { companyId: cid }, select: { id: true, name: true } });
      const teams = matchTeams(allTeams, str(args, "team"));
      if (teams.length === 0) return { error: `Бригада «${str(args, "team")}» не найдена`, teams: allTeams.map(t => t.name) };
      const tasks = await prisma.dailyTask.findMany({
        where: { teamId: { in: teams.map(t => t.id) }, date: { gte: range.from, lte: range.to }, plannedQuantity: { gt: 0 } },
        select: { date: true, plannedQuantity: true, loadShare: true, teamId: true, orderItem: { select: { productId: true } } },
      });
      const { teamCap } = await capacityMaps([...new Set(tasks.map(t => t.orderItem.productId))]);
      const load = new Map<string, number>(); // teamId|date → доля дня
      for (const t of tasks) {
        const cap = teamCap(t.orderItem.productId, t.teamId!);
        const key = `${t.teamId}|${day(t.date)}`;
        load.set(key, (load.get(key) ?? 0) + (t.loadShare ?? (cap > 0 ? t.plannedQuantity / cap : 0)));
      }
      const days: string[] = [];
      for (let d = new Date(range.from); d <= range.to; d.setUTCDate(d.getUTCDate() + 1)) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) days.push(day(d));
      }
      return {
        working_days: days.length,
        teams: teams
          .map(t => {
            const byDay = days.map(ds => ({ date: ds, load_pct: Math.round((load.get(`${t.id}|${ds}`) ?? 0) * 100) }));
            const avg = byDay.length ? Math.round(byDay.reduce((s, x) => s + x.load_pct, 0) / byDay.length) : 0;
            return { team: t.name, avg_load_pct: avg, free_days: byDay.filter(x => x.load_pct === 0).length, days: byDay };
          })
          // По всем бригадам — без пустых ВРЦ, чтобы не раздувать ответ
          .filter(t => teams.length === 1 || t.avg_load_pct > 0),
      };
    },

    async find_products(args: Args) {
      const q = lc(str(args, "query"));
      if (!q) return { error: "Пустой запрос" };
      const products = await prisma.product.findMany({
        where: { companyId: cid },
        select: { id: true, code: true, name: true },
      });
      const exact = products.filter(p => lc(p.code) === q);
      const matched = exact.length ? exact : products.filter(p => lc(p.code).includes(q) || lc(p.name).includes(q));
      const shown = await prisma.product.findMany({
        where: { id: { in: matched.slice(0, 10).map(p => p.id) } },
        select: {
          code: true, name: true, capacityPerDay: true,
          category: { select: { name: true } },
          teamCapacities: { where: { capacityPerDay: { gt: 0 } }, select: { capacityPerDay: true, team: { select: { name: true, headcount: true } } } },
          orderItems: { where: { order: { active: true } }, select: { quantity: true } },
        },
      });
      return {
        found: matched.length,
        products: shown.map(p => ({
          code: p.code,
          name: p.name,
          category: p.category.name,
          norms: p.teamCapacities.map(c => ({
            team: c.team.name,
            per_person_per_day: c.capacityPerDay,
            headcount: c.team.headcount,
            team_per_day: Math.round(c.capacityPerDay * c.team.headcount * 10) / 10,
          })),
          no_norms_note: p.teamCapacities.length === 0 ? "Норм по бригадам нет — товар не будет запланирован" : undefined,
          active_order_positions: p.orderItems.length,
          active_remaining_qty: p.orderItems.reduce((s, i) => s + i.quantity, 0),
        })),
      };
    },

    async unplanned_items() {
      const items = await prisma.orderItem.findMany({
        where: { order: { companyId: cid, active: true }, quantity: { gt: 0 } },
        select: {
          quantity: true,
          order: { select: { orderNumber: true, customer: true } },
          product: {
            select: {
              code: true, name: true, capacityPerDay: true,
              teamCapacities: { where: { capacityPerDay: { gt: 0 } }, select: { id: true } },
            },
          },
          dailyTasks: { select: { plannedQuantity: true } },
        },
      });
      const rows = items
        .map(it => ({ it, planned: it.dailyTasks.reduce((s, t) => s + t.plannedQuantity, 0) }))
        .filter(x => x.planned < x.it.quantity)
        .map(({ it, planned }) => ({
          order: it.order.orderNumber,
          customer: it.order.customer,
          product: `${it.product.code} ${it.product.name}`,
          remaining_qty: it.quantity,
          planned_qty: planned,
          reason: it.product.teamCapacities.length === 0 && !it.product.capacityPerDay
            ? "нет нормы ни для одной бригады"
            : planned === 0 ? "не запланирована (норма есть)" : "запланирована частично",
        }));
      return { count: rows.length, shown: Math.min(rows.length, 60), items: rows.slice(0, 60) };
    },

    async orders_by_finish_date(args: Args) {
      const range = parseRange(args, null);
      if ("error" in range) return range;
      const orders = await prisma.order.findMany({ where: { companyId: cid, active: true }, select: { id: true } });
      const all = await orderSummaries(orders.map(o => o.id));
      const from = day(range.from), to = day(range.to);
      const list = all
        .filter(o => o.plan_finish && o.plan_finish >= from && o.plan_finish <= to)
        .sort((a, b) => a.plan_finish!.localeCompare(b.plan_finish!));
      return { count: list.length, shown: Math.min(list.length, 40), orders: list.slice(0, 40) };
    },

    async list_teams() {
      const today = new Date(day(new Date()) + "T00:00:00.000Z");
      const teams = await prisma.team.findMany({
        where: { companyId: cid },
        select: {
          name: true, headcount: true,
          _count: { select: { productCapacities: { where: { capacityPerDay: { gt: 0 } } } } },
          dailyTasks: { where: { date: { gte: today }, plannedQuantity: { gt: 0 } }, select: { date: true }, orderBy: { date: "desc" }, take: 1 },
        },
        orderBy: { name: "asc" },
      });
      return {
        teams: teams.map(t => ({
          team: t.name,
          headcount: t.headcount,
          products_with_norms: t._count.productCapacities,
          planned_until: t.dailyTasks[0] ? day(t.dailyTasks[0].date) : null,
        })),
      };
    },
  };
}

// ─── Вызов модели ────────────────────────────────────────────────────────────

async function callModel(messages: ChatMessage[]): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const { base, key, folder, model } = config();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${key}`,
      "OpenAI-Project": folder,
    },
    body: JSON.stringify({
      model: `gpt://${folder}/${model}`,
      messages,
      tools: TOOLS,
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Yandex AI Studio ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { choices?: { message?: { content: string | null; tool_calls?: ToolCall[] } }[] };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error(`Пустой ответ модели: ${text.slice(0, 300)}`);
  return msg;
}

export function registerAssistant(app: Express, prisma: PrismaClient) {
  app.post("/assistant/chat", async (req: Request, res: Response) => {
    const { key, folder } = config();
    if (!key || !folder) {
      res.status(503).json({ error: "Помощник не настроен: на сервере нет YANDEX_API_KEY или YANDEX_FOLDER_ID" });
      return;
    }
    const body = (req.body ?? {}) as { messages?: unknown };
    const raw = Array.isArray(body.messages) ? body.messages as unknown[] : [];
    const history: ChatMessage[] = raw
      .filter((m): m is { role: "user" | "assistant"; content: string } =>
        !!m && typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string")
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    const question = history.at(-1);
    if (question?.role !== "user") {
      res.status(400).json({ error: "Последнее сообщение должно быть вопросом пользователя" });
      return;
    }

    const user = req.user!;
    const tools = makeTools(prisma, user.companyId) as Record<string, (args: Args) => Promise<unknown>>;
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(user.company.name) }, ...history];
    const used: { name: string; args: Args }[] = [];

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const msg = await callModel(messages);
        if (!msg.tool_calls?.length) {
          console.log(`[assistant] ${user.email}: «${question.content.slice(0, 200)}» tools=${used.map(u => u.name).join(",") || "-"}`);
          res.json({ reply: msg.content ?? "", tools: used });
          return;
        }
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) {
          let args: Args = {};
          try { args = JSON.parse(call.function.arguments || "{}") as Args; } catch { /* пустые аргументы */ }
          used.push({ name: call.function.name, args });
          const fn = tools[call.function.name];
          let result: unknown;
          try {
            result = fn ? await fn(args) : { error: `Нет функции ${call.function.name}` };
          } catch (e) {
            result = { error: `Ошибка функции: ${(e as Error).message}` };
          }
          let content = JSON.stringify(result);
          if (content.length > MAX_TOOL_CHARS) {
            content = content.slice(0, MAX_TOOL_CHARS) + "…[ответ обрезан — сузь запрос: меньше период или конкретная бригада]";
          }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
      }
      res.json({ reply: "Не получилось ответить за отведённое число шагов — попробуйте сформулировать вопрос конкретнее.", tools: used });
    } catch (e) {
      console.error("[assistant] error:", (e as Error).message);
      res.status(502).json({ error: (e as Error).message, tools: used });
    }
  });

  // Для отладки: вызвать функцию напрямую, без модели (только админ)
  app.post("/assistant/tool/:name", async (req: Request, res: Response) => {
    if (req.user?.role !== "ADMIN") { res.status(403).json({ error: "Forbidden" }); return; }
    const tools = makeTools(prisma, req.user.companyId) as Record<string, (args: Args) => Promise<unknown>>;
    const fn = tools[String(req.params["name"])];
    if (!fn) { res.status(404).json({ error: "Нет такой функции", tools: Object.keys(tools) }); return; }
    try {
      res.json(await fn((req.body ?? {}) as Args));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
