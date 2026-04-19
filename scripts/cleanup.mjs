/**
 * Чистка базы данных:
 * 1. Перепривязка категорий к нужным участкам
 * 2. Удаление старых категорий AVRORA и hightech
 * 3. Удаление товаров 12343, 12344
 * 4. Удаление заказов менеджера Звонарев (с каскадом)
 * 5. Удаление участка "Завод CSVT"
 */
import http from 'http';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const WS_IP  = 'cmncbu8lz00exjli9mvog8hz0'; // Участок сборки светильников и корпусов IP
const WS_LED = 'cmncbu8mp00eyjli9y234kw25'; // Участок сборки светильников LED

// Категории → участок
const CAT_WORKSHOP = {
  // IP участок
  'cmncb08wl0024jli9x0h9si0a': WS_IP,  // КОРПУСА SLIM
  'cmncb08wn002bjli93e5u73e6': WS_IP,  // КОРПУСА АЙСБЕРГ
  'cmncb091r00bzjli9u6ehc1ni': WS_IP,  // СВЕТИЛЬНИКИ SLIM, FORMAT MAESTRO, SMILE
  'cmncb092500cujli9js04krh6': WS_IP,  // СВЕТИЛЬНИКИ АЙСБЕРГ, FORMAT PRO MAX, FORMAT DPO
  'cmncb091g00bdjli98h771ng6': WS_IP,  // СВЕТИЛЬНИКИ SLIM TUBE, LUMIN, FORMAT PRO
  'cmncb091500aujli9y0h3phjt': WS_IP,  // СВЕТИЛЬНИКИ LUM

  // LED участок
  'cmncb08y7005sjli9mrunm50z': WS_LED, // СВЕТИЛЬНИКИ FLORA
  'cmncb08yr0070jli9rknwo0vf': WS_LED, // СВЕТИЛЬНИКИ HIGHTECH ALUMOGIPS
  'cmncb08zn008mjli9mhypaieq': WS_LED, // СВЕТИЛЬНИКИ KSP NOTA CLIO
  'cmncb08zz0096jli9wru2owpb': WS_LED, // СВЕТИЛЬНИКИ LED-GR - ОДИНОЧНЫЕ
  'cmncb0908009mjli934srs2ge': WS_LED, // СВЕТИЛЬНИКИ LIRA
  'cmncb091d00b6jli9pp52vbqt': WS_LED, // СВЕТИЛЬНИКИ OPERLUX UNIVERSAL НЕСТАНДАРТ
  'cmncb091w00cajli9w5yf3n1h': WS_LED, // СВЕТИЛЬНИКИ VOLGA EU NEMO IP40
  'cmncb092900d6jli923qouq2v': WS_LED, // СВЕТИЛЬНИКИ ДИЗАЙНЕРСКИЕ
  'cmncb08x9003rjli9c0321r1m': WS_LED, // СВЕТИЛЬНИКИ AVRORA 1195мм
  'cmncb08xc003yjli99xw5z0yc': WS_LED, // СВЕТИЛЬНИКИ AVRORA-40
  'cmncb08xe0045jli98bq6gp84': WS_LED, // СВЕТИЛЬНИКИ AVRORA-90
  'cmncb08wu002rjli9saezmyiq': WS_LED, // ПАНЕЛИ KROKUS
  'cmncb08x5003gjli9jiq6oxa8': WS_LED, // ПАНЕЛИ SPARTA
  'cmncb08ue0009jli9pka36i27': WS_LED, // БЛОКИ АВАРИЙНОГО ПИТАНИЯ
  'cmncb08vp000ljli9krxjjfny': WS_LED, // КОМПЛЕКТУЮЩИЕ ПРОЧИЕ
  'cmncb08vw000wjli9q5pce51b': WS_LED, // КОМПЛЕКТЫ ДЛЯ СВЕТИЛЬНИКОВ
};

// Старые категории к удалению
const OLD_CATS = [
  'cmlxzujod000212iaj39hmle3', // AVRORA
  'cmmkwu94p0000xsmu7lqfyqv8', // hightech
];

async function main() {
  // ── 1. Перепривязка категорий к участкам ──────────────────────
  console.log('\n=== 1. Перепривязка категорий ===');
  for (const [catId, wsId] of Object.entries(CAT_WORKSHOP)) {
    const r = await api('PUT', `/categories/${catId}`, { workshopId: wsId });
    const wsName = wsId === WS_IP ? 'IP' : 'LED';
    if (r.status === 200) {
      console.log(`  ✓ ${r.body.name} → ${wsName}`);
    } else {
      console.log(`  ✗ ${catId}: статус ${r.status}`, r.body);
    }
  }

  // ── 2. Удаление старых категорий (AVRORA, hightech) ───────────
  console.log('\n=== 2. Удаление старых категорий ===');
  for (const catId of OLD_CATS) {
    // Сначала получим имя
    const info = await api('GET', `/categories`);
    const cat = info.body.find ? info.body.find(c => c.id === catId) : null;
    const name = cat ? cat.name : catId;

    // Переведём продукты этой категории — проверим нет ли товаров
    const products = await api('GET', `/products`);
    const linked = (products.body || []).filter(p => p.categoryId === catId);
    if (linked.length > 0) {
      console.log(`  ! Категория "${name}" имеет ${linked.length} товаров — пропускаем`);
      continue;
    }

    const r = await api('DELETE', `/categories/${catId}`);
    if (r.status === 200 || r.status === 204) {
      console.log(`  ✓ Удалена: ${name}`);
    } else {
      console.log(`  ✗ Ошибка удаления "${name}": статус ${r.status}`, r.body);
    }
  }

  // ── 3. Удаление товаров 12343, 12344 ──────────────────────────
  console.log('\n=== 3. Удаление товаров ===');
  const products = await api('GET', '/products');
  const toDeleteProducts = (products.body || []).filter(p => p.code === '12343' || p.code === '12344');
  for (const p of toDeleteProducts) {
    const r = await api('DELETE', `/products/${p.id}`);
    if (r.status === 200 || r.status === 204) {
      console.log(`  ✓ Удалён товар: ${p.code} — ${p.name}`);
    } else {
      console.log(`  ✗ Ошибка удаления товара ${p.code}: статус ${r.status}`, r.body);
    }
  }
  if (toDeleteProducts.length === 0) console.log('  Товары 12343/12344 не найдены');

  // ── 4. Удаление заказов Звонарева (с каскадом: задачи → позиции → заказ) ──
  console.log('\n=== 4. Удаление заказов Звонарева ===');
  const orders = await api('GET', '/orders');
  const zvOrders = (orders.body || []).filter(o => o.manager && o.manager.includes('Звонарев'));

  for (const order of zvOrders) {
    console.log(`  Заказ ${order.orderNumber} (${order.id})`);

    // Получим позиции заказа
    const items = await api('GET', `/order-items?orderId=${order.id}`);
    const orderItems = items.body || [];

    for (const item of orderItems) {
      // Получим задачи позиции
      const tasks = await api('GET', `/daily-tasks?orderItemId=${item.id}`);
      const dailyTasks = tasks.body || [];

      for (const task of dailyTasks) {
        const r = await api('DELETE', `/daily-tasks/${task.id}`);
        if (r.status === 200 || r.status === 204) {
          console.log(`    ✓ Удалена задача ${task.id.slice(0,8)}`);
        } else {
          console.log(`    ✗ Ошибка задачи ${task.id}: ${r.status}`);
        }
      }

      const r = await api('DELETE', `/order-items/${item.id}`);
      if (r.status === 200 || r.status === 204) {
        console.log(`    ✓ Удалена позиция ${item.id.slice(0,8)}`);
      } else {
        console.log(`    ✗ Ошибка позиции ${item.id}: ${r.status}`);
      }
    }

    const r = await api('DELETE', `/orders/${order.id}`);
    if (r.status === 200 || r.status === 204) {
      console.log(`  ✓ Удалён заказ: ${order.orderNumber}`);
    } else {
      console.log(`  ✗ Ошибка удаления заказа ${order.orderNumber}: ${r.status}`, r.body);
    }
  }
  if (zvOrders.length === 0) console.log('  Заказы Звонарева не найдены');

  // ── 5. Удаление участка "Завод CSVT" ──────────────────────────
  console.log('\n=== 5. Удаление участка "Завод CSVT" ===');
  const workshops = await api('GET', '/workshops');
  const csvt = (workshops.body || []).find(w => w.name === 'Завод CSVT');
  if (csvt) {
    const r = await api('DELETE', `/workshops/${csvt.id}`);
    if (r.status === 200 || r.status === 204) {
      console.log('  ✓ Удалён участок "Завод CSVT"');
    } else {
      console.log(`  ✗ Ошибка: статус ${r.status}`, r.body);
    }
  } else {
    console.log('  Участок не найден');
  }

  console.log('\nГотово!');
}

main().catch(console.error);
