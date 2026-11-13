// Поиск свободных tee time на полях Troon через сайт golfwithaccess.com (Access by Troon).
// Используются те же публичные данные, что видит обычный посетитель сайта:
//  - список полей — из sitemap (https://golfwithaccess.com/sitemap/courses.xml);
//  - данные поля (город, координаты, id) — со страницы /course/<slug>/reserve-tee-time;
//  - свободное время — запрос /api/v1/tee-times, который делает сама страница бронирования.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.env.TROON_BASE_URL || 'https://golfwithaccess.com'; // переопределяется только для тестов
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

let httpFetch = fetch;
let catalogFile = null;
let catalog = null; // { updatedAt, facilities: [...] }
let catalogBuilding = null;

export function initTroon({ fetchImpl, dataDir }) {
  if (fetchImpl) httpFetch = fetchImpl;
  fs.mkdirSync(dataDir, { recursive: true });
  catalogFile = path.join(dataDir, 'troon-courses.json');
  if (fs.existsSync(catalogFile)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    } catch {
      catalog = null;
    }
  }
}

async function get(url, accept = 'text/html') {
  const res = await httpFetch(url, { headers: { 'user-agent': UA, accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Простой пул: не больше `limit` запросов одновременно
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          results[idx] = await fn(items[idx]);
        } catch (err) {
          results[idx] = { error: err.message };
        }
      }
    }),
  );
  return results;
}

// ---------- Каталог полей ----------
function parseFacilityPage(html, slug) {
  const str = (re) => html.match(re)?.[1];
  const num = (re) => {
    const v = html.match(re)?.[1];
    return v === undefined ? null : Number(v);
  };
  const courses = [];
  const re =
    /\{id:"([0-9a-f-]{36})",name:"((?:[^"\\]|\\.)*)",facilityName:"((?:[^"\\]|\\.)*)",slug:"([^"]*)",holeCount:(\d+),isBookable:(!0|!1)[^}]*?bookingWindowInDays:(\d+)/g;
  for (const m of html.matchAll(re)) {
    courses.push({ id: m[1], name: m[2], facilityName: m[3], holes: Number(m[5]), bookable: m[6] === '!0', bookingWindowDays: Number(m[7]) });
  }
  if (!courses.length) return null;
  return {
    slug,
    name: courses[0].facilityName,
    city: str(/city:"([^"]*)"/),
    state: str(/state:"([^"]*)"/),
    street: str(/street:"([^"]*)"/),
    phone: str(/phone:"([^"]*)"/),
    timezone: str(/timezone:"([^"]*)"/),
    lat: num(/latitude:(-?[\d.]+)/),
    lng: num(/longitude:(-?[\d.]+)/),
    url: `${BASE}/course/${slug}/reserve-tee-time`,
    courses: courses.map(({ facilityName, ...c }) => c),
  };
}

async function buildCatalog() {
  const xml = await (await get(`${BASE}/sitemap/courses.xml`, 'application/xml')).text();
  const slugs = [...new Set([...xml.matchAll(/\/course\/([a-z0-9-]+)\/reserve-tee-time</g)].map((m) => m[1]))];
  console.log(`Troon: собираю каталог, полей в sitemap: ${slugs.length}`);
  const pages = await mapLimit(slugs, 3, async (slug) => {
    const html = await (await get(`${BASE}/course/${slug}/reserve-tee-time`)).text();
    await sleep(300); // не нагружаем сайт
    return parseFacilityPage(html, slug);
  });
  const facilities = pages.filter((p) => p && !p.error);
  if (!facilities.length) throw new Error('Не удалось разобрать ни одной страницы поля');
  catalog = { updatedAt: Date.now(), facilities };
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  console.log(`Troon: каталог готов, площадок: ${facilities.length}`);
  return catalog;
}

export async function getCatalog() {
  if (catalog && Date.now() - catalog.updatedAt < CATALOG_MAX_AGE_MS) return catalog;
  if (catalog) {
    // Старый каталог отдаём сразу, обновляем в фоне
    if (!catalogBuilding) catalogBuilding = buildCatalog().catch((e) => console.error('Troon: каталог:', e.message)).finally(() => (catalogBuilding = null));
    return catalog;
  }
  catalogBuilding ||= buildCatalog().finally(() => (catalogBuilding = null));
  return catalogBuilding;
}

// ---------- Поиск площадок ----------
function distanceMiles(a, b) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function findFacilities({ query, lat, lng, radius_miles = 50, limit = 10 } = {}) {
  const { facilities } = await getCatalog();
  let list = facilities.filter((f) => f.courses.some((c) => c.bookable));
  if (query) {
    const words = norm(query).split(/[\s,]+/).filter(Boolean);
    list = list.filter((f) => {
      const hay = norm([f.name, f.city, f.state, f.slug, ...f.courses.map((c) => c.name)].join(' '));
      return words.every((w) => hay.includes(w));
    });
  }
  if (typeof lat === 'number' && typeof lng === 'number') {
    list = list
      .filter((f) => f.lat != null && f.lng != null)
      .map((f) => ({ ...f, distance: Math.round(distanceMiles({ lat, lng }, f)) }))
      .filter((f) => f.distance <= radius_miles)
      .sort((a, b) => a.distance - b.distance);
  }
  return list.slice(0, limit);
}

// ---------- Свободное время ----------
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => `${pad(t.hour)}:${pad(t.minute)}`;

function normTime(t, fallback) {
  if (!t) return fallback;
  const m = String(t).match(/^(\d{1,2})(?::(\d{2}))?/);
  return m ? `${pad(Number(m[1]))}:${m[2] || '00'}:00` : fallback;
}

// ---------- Браузер ----------
// Сайт отдаёт свободное время только обычному браузеру (защита Cloudflare),
// поэтому страницу поля открываем в headless Chromium, как это сделал бы человек,
// и читаем данные, которые страница загружает сама.
let browserPromise = null;
let browserIdleTimer = null;

async function getBrowser() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(closeBrowser, 5 * 60 * 1000); // закрываем после 5 минут простоя
  if (!browserPromise) {
    browserPromise = (async () => {
      const require = createRequire(import.meta.url);
      const { chromium } = require('playwright');
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      let proxyOpt;
      if (proxy) {
        const u = new URL(proxy);
        proxyOpt = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
      }
      const browser = await chromium.launch({ proxy: proxyOpt });
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
      return { browser, context };
    })().catch((err) => {
      browserPromise = null;
      throw new Error(`Не удалось запустить браузер (npx playwright install chromium): ${err.message}`);
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  clearTimeout(browserIdleTimer);
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p.catch(() => null))?.browser.close().catch(() => {});
}

// Ссылка на страницу поля с уже выбранными датой, игроками и временем
function bookingUrl(slug, { date, players, time_from, time_to }) {
  // Сайт принимает часы: startAt — с какого часа, endAt — до какого (не включая)
  const from = normTime(time_from, '00:00:00');
  const to = normTime(time_to, '24:00:00');
  const endHour = Number(to.slice(0, 2)) + (to.slice(3, 5) !== '00' ? 1 : 0);
  const qs = new URLSearchParams({
    date,
    players: String(players),
    startAt: String(Number(from.slice(0, 2))),
    endAt: String(Math.min(24, endHour)),
    view: 'time',
    payMode: 'dollars',
  });
  return `${BASE}/course/${slug}/reserve-tee-time?${qs}`;
}

// id слота — base64 JSON, внутри courseId (нужен для площадок с несколькими полями)
function courseIdOfTeeTime(t) {
  try {
    return JSON.parse(Buffer.from(t.id, 'base64').toString('utf8')).courseId;
  } catch {
    return null;
  }
}

async function loadFacilityTeeTimes(facility, params) {
  const { context } = await getBrowser();
  const page = await context.newPage();
  const responses = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/tee-times') && r.request().method() === 'GET') {
      responses.push(r.json().catch(() => null));
    }
  });
  try {
    const first = page.waitForResponse((r) => r.url().includes('/api/v1/tee-times'), { timeout: 45000 });
    await page.goto(bookingUrl(facility.slug, params), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await first;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const all = (await Promise.all(responses)).flatMap((j) => j?.teeTimes || []);
    // убираем дубли (страница может запросить одно и то же дважды)
    const seen = new Set();
    return all.filter((t) => !seen.has(t.id) && seen.add(t.id));
  } finally {
    await page.close().catch(() => {});
  }
}

function mapTeeTime(t, players) {
  const rates = (t.rates || [])
    .filter((r) => r.isAvailableToUser !== false && (!r.players || r.players.includes(players)))
    .map((r) => ({
      name: r.name,
      price: r.price?.dollars?.displayValue,
      points: r.price?.points ?? null,
      prepaid: r.isPrePaid,
      hot_deal: r.isHotDeal || undefined,
    }));
  return {
    time: hhmm(t.dayTime),
    holes: t.holesOption === 'NINE' ? 9 : 18,
    players: `${t.players?.min}-${t.players?.max}`,
    price_from: t.price?.min?.displayValue,
    cart_included: t.cartIncluded,
    rates: rates.slice(0, 3),
  };
}

function inWindow(t, time_from, time_to) {
  const v = hhmm(t.dayTime) + ':00';
  return v >= normTime(time_from, '00:00:00') && v <= normTime(time_to, '23:59:59');
}

// Главная функция для бота
export async function searchTeeTimes({ date, players = 2, time_from, time_to, course_query, lat, lng, radius_miles = 50, max_courses = 6, max_times_per_course = 8 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'date должна быть в формате YYYY-MM-DD' };
  players = Math.min(4, Math.max(1, Number(players) || 2));
  const facilities = await findFacilities({ query: course_query, lat, lng, radius_miles, limit: max_courses });
  if (!facilities.length) return { error: 'Подходящих полей Troon не найдено. Уточните город/штат или название поля.' };

  const params = { date, players, time_from, time_to };
  const results = await mapLimit(facilities, 3, (f) => loadFacilityTeeTimes(f, params));

  return {
    date,
    players,
    time_window: `${normTime(time_from, '00:00:00').slice(0, 5)}–${normTime(time_to, '23:59:59').slice(0, 5)} (местное время поля)`,
    courses: facilities.flatMap((f, i) => {
      const r = results[i];
      const base = {
        facility: f.name,
        location: [f.city, f.state].filter(Boolean).join(', '),
        distance_miles: f.distance,
        booking_url: bookingUrl(f.slug, params),
        phone: f.phone,
      };
      if (!Array.isArray(r)) return [{ ...base, error: r?.error || 'не удалось получить расписание' }];
      const bookable = f.courses.filter((c) => c.bookable);
      return bookable.map((c) => {
        const times = r
          .filter((t) => bookable.length === 1 || courseIdOfTeeTime(t) === c.id)
          .filter((t) => inWindow(t, time_from, time_to))
          .sort((a, b) => hhmm(a.dayTime).localeCompare(hhmm(b.dayTime)))
          .map((t) => mapTeeTime(t, players));
        return {
          ...base,
          course: c.name,
          booking_window_days: c.bookingWindowDays,
          available: times.length,
          tee_times: times.slice(0, max_times_per_course),
        };
      });
    }),
  };
}

// Описание инструментов для Claude
export const TROON_TOOLS = [
  {
    name: 'search_tee_times',
    description:
      'Ищет свободные tee time (время для игры в гольф) на полях Troon через сайт golfwithaccess.com. ' +
      'Задай либо course_query (название поля, город или штат по-английски), либо координаты lat/lng ' +
      '(например, центра города, который назвал пользователь) — тогда поля сортируются по расстоянию. ' +
      'Время — местное время поля. Возвращает поля, доступное время, цены и ссылку на бронирование.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата игры, YYYY-MM-DD' },
        players: { type: 'integer', minimum: 1, maximum: 4, description: 'Число игроков (по умолчанию 2)' },
        time_from: { type: 'string', description: 'Не раньше, HH:MM (24 ч). Не задавай, если пользователь не ограничил время' },
        time_to: { type: 'string', description: 'Не позже, HH:MM (24 ч)' },
        course_query: { type: 'string', description: 'Название поля / город / штат по-английски, например "Scottsdale" или "Kapalua"' },
        lat: { type: 'number', description: 'Широта точки, рядом с которой искать' },
        lng: { type: 'number', description: 'Долгота точки, рядом с которой искать' },
        radius_miles: { type: 'number', description: 'Радиус поиска в милях при поиске по координатам (по умолчанию 50)' },
        max_courses: { type: 'integer', description: 'Сколько площадок проверить (по умолчанию 6, максимум 12)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'find_troon_courses',
    description:
      'Находит поля сети Troon (Access by Troon) по названию/городу/штату или рядом с координатами. ' +
      'Используй, когда пользователь спрашивает, какие поля есть, или нужно уточнить, о каком поле речь.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Название, город или штат по-английски' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        radius_miles: { type: 'number' },
        limit: { type: 'integer', description: 'По умолчанию 15' },
      },
    },
  },
];

export async function runTroonTool(name, input) {
  if (name === 'search_tee_times') {
    return searchTeeTimes({ ...input, max_courses: Math.min(12, input.max_courses || 6) });
  }
  if (name === 'find_troon_courses') {
    const list = await findFacilities({ ...input, limit: input.limit || 15 });
    return list.map((f) => ({
      name: f.name,
      location: [f.city, f.state].filter(Boolean).join(', '),
      distance_miles: f.distance,
      courses: f.courses.map((c) => `${c.name} (${c.holes} лунок)`),
      phone: f.phone,
      booking_url: f.url,
    }));
  }
  return { error: `Неизвестный инструмент ${name}` };
}
