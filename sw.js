const CACHE = 'melembre-v1';
const BASE = self.registration.scope;
const ASSETS = [BASE, BASE + 'index.html', BASE + 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  startAlarmCheck();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ─── Alarm check ────────────────────────────────────────────────────────────

let alarmInterval = null;

function startAlarmCheck() {
  if (alarmInterval) return;
  alarmInterval = setInterval(checkLembretes, 60 * 1000);
}

async function checkLembretes() {
  const allClients = await self.clients.matchAll();

  // Ask the active client for reminders data
  if (allClients.length > 0) {
    allClients[0].postMessage({ type: 'GET_LEMBRETES' });
  }
}

self.addEventListener('message', async e => {
  if (e.data && e.data.type === 'LEMBRETES_DATA') {
    const lembretes = e.data.lembretes || [];
    const agora = Date.now();

    for (const l of lembretes) {
      if (l.concluido || l.dispensado) continue;

      const alvo = new Date(l.data_alvo).getTime();
      const diff = alvo - agora;

      // Fire at exact time (±90s window)
      if (diff >= -90000 && diff <= 90000) {
        const key = `notif_fired_${l.id}`;
        const fired = await getCache(key);
        if (!fired) {
          fireAlarm(l);
          await setCache(key, '1', 120); // block re-fire for 2min
        }
      }
      // 1 hour before
      else if (diff > 0 && diff <= 3660000 && diff > 3540000) {
        const key = `notif_1h_${l.id}`;
        const fired = await getCache(key);
        if (!fired) {
          firePreview(l, '1h');
          await setCache(key, '1', 3700);
        }
      }
      // 1 day before
      else if (diff > 0 && diff <= 86460000 && diff > 86340000) {
        const key = `notif_1d_${l.id}`;
        const fired = await getCache(key);
        if (!fired) {
          firePreview(l, '1d');
          await setCache(key, '1', 86500);
        }
      }
    }

    // Also check snoozed reminders
    const snoozed = await getCache('snoozed_list');
    if (snoozed) {
      const list = JSON.parse(snoozed);
      const remaining = [];
      for (const item of list) {
        const diff = item.fireAt - agora;
        if (diff <= 0) {
          fireAlarm(item.lembrete);
        } else {
          remaining.push(item);
        }
      }
      await setCache('snoozed_list', JSON.stringify(remaining), 86400);
    }
  }

  if (e.data && e.data.type === 'SNOOZE_10') {
    const lembrete = e.data.lembrete;
    const fireAt = Date.now() + 10 * 60 * 1000;
    const snoozed = await getCache('snoozed_list');
    const list = snoozed ? JSON.parse(snoozed) : [];
    list.push({ lembrete, fireAt });
    await setCache('snoozed_list', JSON.stringify(list), 86400);
  }
});

function fireAlarm(l) {
  const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(new Date(l.data_alvo));

  self.registration.showNotification('🔔 ' + l.titulo, {
    body: l.emoji + ' ' + l.titulo + '\n' + dataFormatada,
    icon: BASE + 'icon-192.png',
    badge: BASE + 'icon-192.png',
    tag: 'alarme-' + l.id,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 200, 500, 200, 500],
    actions: [
      { action: 'dispensar', title: '✓ Dispensar' },
      { action: 'adiar10',   title: '⏱ +10 min'  }
    ],
    data: { lembrete_id: l.id, titulo: l.titulo, emoji: l.emoji, data_alvo: l.data_alvo, lembrete: l }
  });
}

function firePreview(l, tipo) {
  const hora = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(l.data_alvo));

  const body = tipo === '1h'
    ? `Daqui 1 hora: ${l.emoji} ${l.titulo} às ${hora}`
    : `Amanhã: ${l.emoji} ${l.titulo} às ${hora}`;

  self.registration.showNotification('MeLembre', {
    body,
    icon: BASE + 'icon-192.png',
    badge: BASE + 'icon-192.png',
    tag: 'preview-' + l.id + '-' + tipo,
    data: { lembrete_id: l.id, lembrete: l }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'adiar10') {
    const lembrete = e.notification.data.lembrete;
    const fireAt = Date.now() + 10 * 60 * 1000;
    getCache('snoozed_list').then(snoozed => {
      const list = snoozed ? JSON.parse(snoozed) : [];
      list.push({ lembrete, fireAt });
      setCache('snoozed_list', JSON.stringify(list), 86400);
    });
  } else if (e.action === 'dispensar') {
    const id = e.notification.data.lembrete_id;
    self.clients.matchAll().then(clients => {
      clients.forEach(c => c.postMessage({ type: 'DISPENSAR', id }));
    });
  } else {
    e.waitUntil(clients.openWindow(self.registration.scope));
  }
});

// ─── Simple key-value cache via CacheStorage ────────────────────────────────

async function setCache(key, value) {
  const cache = await caches.open('melembre-sw-kv');
  const resp = new Response(value);
  await cache.put('/_kv/' + key, resp);
}

async function getCache(key) {
  const cache = await caches.open('melembre-sw-kv');
  const resp = await cache.match('/_kv/' + key);
  if (!resp) return null;
  return resp.text();
}
