/**
 * Создаёт участки, бригады и привязки бригада→категория
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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // ── 1. Участки ──────────────────────────────────────────────────
  console.log('\n=== Участки ===');
  const ws1 = await api('POST', '/workshops', { name: 'Участок сборки светильников и корпусов IP' });
  console.log('Создан:', ws1.name);
  const ws2 = await api('POST', '/workshops', { name: 'Участок сборки светильников LED' });
  console.log('Создан:', ws2.name);

  // ── 2. Бригады ──────────────────────────────────────────────────
  console.log('\n=== Бригады ===');
  const teamDefs = [
    'Бригада упаковки',
    'Бригада №1 IP',
    'Бригада №2 IP',
    'Бригада №3 IP',
    'Бригада №4 IP (TUBE, LUMIN, LUM)',
    'Бригада FLORA',
    'Бригада LED GR',
    'Бригада «Универсал»',
    'Бригада Аврора №1',
    'Бригада Аврора №2',
    'Бригада Аврора №3',
    'Бригада Аврора №4',
    'Бригада круглых светильников',
    'Бригада сборки LED панелей',
    'Бригада сборки кольцевых светильников',
  ];

  const T = {};
  for (const name of teamDefs) {
    const t = await api('POST', '/teams', { name });
    T[name] = t.id;
    console.log('Создана:', name);
  }

  // ── 3. Категории (из текущей БД) ────────────────────────────────
  const C = {
    AVRORA:          'cmlxzujod000212iaj39hmle3',
    hightech:        'cmmkwu94p0000xsmu7lqfyqv8',
    KORPUSA_SLIM:    'cmncb08wl0024jli9x0h9si0a',
    KORPUSA_AISBERG: 'cmncb08wn002bjli93e5u73e6',
    KROKUS:          'cmncb08wu002rjli9saezmyiq',
    SPARTA:          'cmncb08x5003gjli9jiq6oxa8',
    AVRORA_1195:     'cmncb08x9003rjli9c0321r1m',
    AVRORA_40:       'cmncb08xc003yjli99xw5z0yc',
    AVRORA_90:       'cmncb08xe0045jli98bq6gp84',
    FLORA:           'cmncb08y7005sjli9mrunm50z',
    HIGHTECH:        'cmncb08yr0070jli9rknwo0vf',
    KSP:             'cmncb08zn008mjli9mhypaieq',
    LED_GR:          'cmncb08zz0096jli9wru2owpb',
    LIRA:            'cmncb0908009mjli934srs2ge',
    LUM:             'cmncb091500aujli9y0h3phjt',
    OPERLUX:         'cmncb091d00b6jli9pp52vbqt',
    SLIM_TUBE:       'cmncb091g00bdjli98h771ng6',
    SLIM:            'cmncb091r00bzjli9u6ehc1ni',
    VOLGA_NEMO:      'cmncb091w00cajli9w5yf3n1h',
    AISBERG:         'cmncb092500cujli9js04krh6',
    DIZAIN:          'cmncb092900d6jli923qouq2v',
  };

  const ALL_AVRORA = [C.AVRORA, C.AVRORA_1195, C.AVRORA_40, C.AVRORA_90];

  // ── 4. Привязки бригада → категории ─────────────────────────────
  const associations = {
    'Бригада упаковки':               [C.AISBERG, C.KORPUSA_AISBERG, C.SLIM, C.KORPUSA_SLIM, C.LUM],
    'Бригада №1 IP':                  [C.AISBERG, C.KORPUSA_AISBERG, C.SLIM, C.KORPUSA_SLIM,
                                        C.SLIM_TUBE, C.LUM, C.LED_GR, C.VOLGA_NEMO,
                                        ...ALL_AVRORA, C.LIRA, C.FLORA],
    'Бригада №2 IP':                  [C.AISBERG, C.KORPUSA_AISBERG, C.SLIM, C.KORPUSA_SLIM,
                                        C.LED_GR, C.VOLGA_NEMO, ...ALL_AVRORA, C.LIRA, C.FLORA],
    'Бригада №3 IP':                  [C.AISBERG, C.KORPUSA_AISBERG, C.SLIM, C.KORPUSA_SLIM,
                                        C.LED_GR, C.VOLGA_NEMO, ...ALL_AVRORA, C.LIRA, C.FLORA],
    'Бригада №4 IP (TUBE, LUMIN, LUM)': [C.SLIM_TUBE, C.LUM, C.SLIM, C.AISBERG, C.LED_GR],
    'Бригада FLORA':                  [C.FLORA, C.DIZAIN, C.LED_GR, C.VOLGA_NEMO],
    'Бригада LED GR':                 [C.LED_GR, C.FLORA, C.VOLGA_NEMO, C.LIRA, C.DIZAIN],
    'Бригада «Универсал»':            [C.FLORA, C.VOLGA_NEMO, C.LED_GR, C.LIRA, C.DIZAIN],
    'Бригада Аврора №1':              [...ALL_AVRORA, C.OPERLUX, C.HIGHTECH, C.hightech, C.LED_GR],
    'Бригада Аврора №2':              [C.HIGHTECH, C.hightech, ...ALL_AVRORA, C.OPERLUX, C.LED_GR],
    'Бригада Аврора №3':              [...ALL_AVRORA, C.LED_GR],
    'Бригада Аврора №4':              [...ALL_AVRORA],
    'Бригада круглых светильников':   [C.KSP],
    'Бригада сборки LED панелей':     [C.KROKUS, C.SPARTA],
    'Бригада сборки кольцевых светильников': [C.DIZAIN],
  };

  console.log('\n=== Привязки бригада → категория ===');
  let ok = 0, err = 0;
  for (const [teamName, catIds] of Object.entries(associations)) {
    const teamId = T[teamName];
    for (const categoryId of catIds) {
      const r = await api('POST', '/category-teams', { categoryId, teamId });
      if (r && r.categoryId) {
        ok++;
      } else {
        console.log(`  ОШИБКА: ${teamName} -> ${categoryId}`, JSON.stringify(r));
        err++;
      }
    }
    console.log(`${teamName}: ${catIds.length} категорий`);
  }

  console.log(`\n✓ Привязок создано: ${ok}, ошибок: ${err}`);
  console.log('Готово!');
}

main().catch(console.error);
