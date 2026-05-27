#!/usr/bin/env node
/**
 * Кросс-отчёт SEO: запросы Яндекс.Вебмастера (позиции/показы/клики/CTR)
 * × спрос из Яндекс.Wordstat (частотность запроса в месяц).
 *
 * Ни одна сторона по отдельности так не отвечает на вопрос «куда жать»:
 *   - Вебмастер знает, по каким запросам сайт показывается и на какой позиции,
 *     но не знает, СКОЛЬКО этот запрос вообще ищут (потенциал трафика).
 *   - Wordstat знает спрос, но не знает, где ранжируется ваш сайт.
 * Джойн по нормализованному тексту запроса даёт приоритет: дожимать в топ те
 * запросы 11–30, у которых высокий спрос — там максимум недобранного трафика.
 *
 * Почему не Метрика: Stat API массово прячет поисковые фразы Яндекса и жёстко
 * троттлит запросы с измерением searchPhrase («too complicated»). Серьёзные
 * RU-SEO-тулзы фразы из Метрики не тянут — авторитетный источник это Вебмастер,
 * а спрос берут из Wordstat. Wordstat — обогащение: нет токена/доступа → отчёт
 * деградирует к чистому Вебмастеру.
 *
 * Конфиг (.env в корне текущего проекта или env-переменные):
 *   # Вебмастер (обязательно)
 *   YANDEX_WEBMASTER_TOKEN — scope webmaster:read (fallback: YANDEX_OAUTH_TOKEN)
 *   WEBMASTER_HOST         — домен для выбора хоста (если их несколько)
 *   # Wordstat (опционально — без него отчёт только по Вебмастеру)
 *   YANDEX_WORDSTAT_TOKEN  — отдельный токен Wordstat API (Bearer); доступ
 *                            запрашивается формой внизу wordstat.yandex.ru
 *   WORDSTAT_REGIONS       — id регионов через запятую (напр. 11=Рязань,
 *                            213=Москва); пусто = вся Россия
 *   WORDSTAT_DEVICES       — all|desktop|phone|tablet (дефолт all)
 *
 * Запуск:
 *   node cross.mjs                 # топ-50, свежее окно Вебмастера
 *   node cross.mjs --days 14       # окно 14 дн (конец сдвинут на -2 дня)
 *   node cross.mjs --limit 100 --order position
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// --- .env из корня текущего проекта (без зависимостей) ---
function loadEnv() {
  try {
    const file = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of file.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* нет .env — читаем из окружения */ }
}
loadEnv();

const WM_TOKEN = process.env.YANDEX_WEBMASTER_TOKEN || process.env.YANDEX_OAUTH_TOKEN;
const WS_TOKEN = process.env.YANDEX_WORDSTAT_TOKEN; // отдельный доступ, без fallback
const HOST_FILTER = process.env.WEBMASTER_HOST || '';
const WS_REGIONS = (process.env.WORDSTAT_REGIONS || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const WS_DEVICES = (process.env.WORDSTAT_DEVICES || 'all');
const WM_BASE = 'https://api.webmaster.yandex.net/v4';
const WS_API = 'https://api.wordstat.yandex.net/v1';

// --- args ---
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const days = parseInt(getArg('days', '7'), 10);
const daysExplicit = args.includes('--days');
const limit = parseInt(getArg('limit', '50'), 10);
const order = getArg('order', 'shows'); // shows|clicks|position|ctr|demand

// Пороги эвристик (подсветка действий). Сознательно простые — крутите под себя.
const NEAR_TOP_MIN = 11, NEAR_TOP_MAX = 30; // «почти в топе» — дожать
const SNIPPET_POS_MAX = 15;                 // ранжируется неплохо…
const SNIPPET_CTR_MAX = 0.03;               // …но кликают мало → переписать сниппет
const SNIPPET_SHOWS_MIN = 50;               // и показов достаточно, чтобы это значило
const GAP_POS_MIN = 20;                     // ранжируемся слабо (поз > 20)…
const GAP_DEMAND_MIN = 300;                 // …при заметном спросе → недобираем трафик
const WS_MAX_LOOKUPS = 120;                 // потолок обращений к Wordstat за прогон

if (!WM_TOKEN) fail('Не задан YANDEX_WEBMASTER_TOKEN (или YANDEX_OAUTH_TOKEN со scope webmaster:read).');

function fail(msg) {
  console.error(`❌ ${msg}\n   См. skills/seo-report/SKILL.md — нужен хотя бы токен Вебмастера.`);
  process.exit(1);
}

const fmt = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (n) => new Intl.NumberFormat('ru').format(Math.round(n));
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`);

// Нормализация текста запроса для джойна: регистр, пробелы, ё→е.
const normQ = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Период. По умолчанию Вебмастеру дат не даём (он сам отдаёт свежее окно).
// При --days конец сдвигаем на -2 дня: последние дни Вебмастер ещё не обработал.
const periodTo = new Date(Date.now() - 2 * 86400_000);
const periodFrom = new Date(periodTo.getTime() - days * 86400_000);
const periodLabel = daysExplicit ? `${fmt(periodFrom)} → ${fmt(periodTo)}` : 'свежее окно Вебмастера';

// ─── Вебмастер API ───────────────────────────────────────────────────────────
let wmLast = 0;
async function wmApi(path, params = {}, attempt = 0) {
  const url = new URL(WM_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const wait = wmLast + 500 - Date.now();
  if (wait > 0) await sleep(wait);
  wmLast = Date.now();

  const res = await fetch(url, { headers: { Authorization: `OAuth ${WM_TOKEN}` } });
  if (res.ok) return res.json();
  const body = await res.text();
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await sleep(1000 * (attempt + 1));
    return wmApi(path, params, attempt + 1);
  }
  throw new Error(`Webmaster ${res.status} ${path}\n${body.slice(0, 300)}`);
}

async function resolveHost() {
  const { user_id: userId } = await wmApi('/user');
  const { hosts = [] } = await wmApi(`/user/${userId}/hosts`);
  const verified = hosts.filter((h) => h.verified !== false);
  const norm = (s) => (s || '').toLowerCase();
  const match = (h) => {
    const f = norm(HOST_FILTER);
    return norm(h.ascii_host_url).includes(f) || norm(h.unicode_host_url).includes(f) || norm(h.host_id).includes(f);
  };
  let host;
  if (HOST_FILTER) {
    host = verified.find(match) || hosts.find(match);
    if (!host) throw new Error(`Хост по фильтру "${HOST_FILTER}" не найден.`);
  } else if (verified.length === 1) {
    host = verified[0];
  } else {
    throw new Error(`Несколько хостов — задайте WEBMASTER_HOST в .env:\n${verified.map((h) => `  - ${h.unicode_host_url || h.ascii_host_url}`).join('\n')}`);
  }
  // Следуем главному зеркалу (www → без www): данные поиска у него.
  const mainId = host.main_mirror?.host_id;
  if (mainId && mainId !== host.host_id) {
    host = hosts.find((h) => h.host_id === mainId) || { ...host, host_id: mainId };
  }
  return { userId, host };
}

async function fetchWmQueries(userId, host) {
  const params = {
    order_by: order === 'clicks' || order === 'ctr' ? 'TOTAL_CLICKS' : 'TOTAL_SHOWS',
    query_indicator: ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION'],
  };
  if (daysExplicit) { params.date_from = fmt(periodFrom); params.date_to = fmt(periodTo); }
  const d = await wmApi(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/search-queries/popular`, params);
  return (d.queries || []).map((q) => {
    const ind = q.indicators || {};
    const shows = ind.TOTAL_SHOWS || 0;
    const clicks = ind.TOTAL_CLICKS || 0;
    const text = q.query_text || q.query_id || '—';
    return { text, key: normQ(text), shows, clicks, ctr: shows ? clicks / shows : 0, pos: ind.AVG_SHOW_POSITION };
  });
}

// ─── Wordstat API ──────────────────────────────────────────────────────────────
// POST /v1/topRequests, Bearer-токен. Спрос фразы = totalCount (широкое
// соответствие, показов/мес). Лимит API щедрый (10/с, 1000/день) — троттла как
// у Метрики нет; пейсим ~150мс и один раз ретраим 429 по Retry-After.
let wsLast = 0;
async function wsTopRequests(phrase, retried = false) {
  const wait = wsLast + 160 - Date.now();
  if (wait > 0) await sleep(wait);
  wsLast = Date.now();

  const body = { phrases: [phrase], numPhrases: 1, devices: [WS_DEVICES] };
  if (WS_REGIONS.length) body.regions = WS_REGIONS;
  const res = await fetch(`${WS_API}/topRequests`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WS_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const d = await res.json();
    return typeof d.totalCount === 'number' ? d.totalCount : null;
  }
  if (res.status === 429 && !retried) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const w = (Number.isFinite(ra) && ra <= 60 ? ra : 2) * 1000 + Math.random() * 1000;
    await sleep(w);
    return wsTopRequests(phrase, true);
  }
  const txt = await res.text();
  throw new Error(`Wordstat ${res.status}: ${txt.slice(0, 200)}`);
}

// Спрос по списку фраз. Возвращает Map normQ → demand. Один запрос на фразу,
// с потолком WS_MAX_LOOKUPS. Бьётся первая же ошибка (бросаем — caller деградирует).
async function fetchDemand(phrases) {
  const map = new Map();
  const list = phrases.slice(0, WS_MAX_LOOKUPS);
  for (const p of list) {
    const demand = await wsTopRequests(p.text);
    if (demand != null) map.set(p.key, demand);
  }
  return map;
}

// ─── Сборка ──────────────────────────────────────────────────────────────────
function sortRows(rows) {
  if (order === 'demand') return rows.sort((a, b) => (b.demand ?? -1) - (a.demand ?? -1));
  if (order === 'ctr') return rows.sort((a, b) => b.ctr - a.ctr);
  if (order === 'position') return rows.sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999));
  if (order === 'clicks') return rows.sort((a, b) => b.clicks - a.clicks);
  return rows.sort((a, b) => b.shows - a.shows);
}

function bucket(label, rows, fmtLine) {
  if (!rows.length) return;
  console.log(`\n  ${label}`);
  for (const r of rows) console.log(`    ${fmtLine(r)}`);
}

// Приоритет дожима: спрос если есть, иначе показы (деградация без Wordstat).
const potential = (r) => (r.demand != null ? r.demand : r.shows);

try {
  const { userId, host } = await resolveHost();
  const hostName = host.unicode_host_url || host.ascii_host_url;
  const regLabel = WS_REGIONS.length ? `регионы ${WS_REGIONS.join(',')}` : 'вся Россия';
  console.log(`Host: ${hostName}  ·  Wordstat: ${WS_TOKEN ? regLabel : 'нет токена'}  ·  ${periodLabel}`);

  const wmRows = await fetchWmQueries(userId, host);
  if (!wmRows.length) { console.log('\n  (Вебмастер не вернул запросов за период)\n'); process.exit(0); }

  const shown = sortRows([...wmRows]).slice(0, limit);

  // Wordstat — мягко: нет токена/ошибка → продолжаем без спроса.
  let wsNote = WS_TOKEN ? '' : 'нет YANDEX_WORDSTAT_TOKEN — спрос недоступен, отчёт по Вебмастеру.';
  let demandMap = new Map();
  if (WS_TOKEN) {
    // Обогащаем то, что покажем + кандидатов на дожим (поз 11–30) — там спрос решает.
    const nearTop = wmRows.filter((r) => r.pos != null && r.pos >= NEAR_TOP_MIN && r.pos <= NEAR_TOP_MAX);
    const seen = new Set();
    const toLookup = [...shown, ...nearTop].filter((r) => (seen.has(r.key) ? false : seen.add(r.key)));
    try {
      demandMap = await fetchDemand(toLookup);
      for (const r of wmRows) if (demandMap.has(r.key)) r.demand = demandMap.get(r.key);
      if (!demandMap.size) wsNote = 'Wordstat не вернул спроса по запросам.';
    } catch (e) {
      wsNote = `Wordstat недоступен (${e.message.split('\n')[0]}) — отчёт по Вебмастеру.`;
    }
  }

  // Пересортировка с учётом спроса, если просили --order demand (демонд уже проставлен).
  const shownFinal = order === 'demand' ? sortRows([...wmRows]).slice(0, limit) : shown;

  section(`Запросы × спрос (топ-${limit}, сортировка: ${order})`);
  if (wsNote) console.log(`  ${wsNote}`);
  console.log('');
  console.log(`  ${'запрос'.padEnd(38)} ${'показы'.padStart(7)} ${'клики'.padStart(6)} ${'CTR'.padStart(6)} ${'поз.'.padStart(5)} ${'спрос/мес'.padStart(10)}`);
  for (const r of shownFinal) {
    const pos = r.pos != null ? r.pos.toFixed(1) : '—';
    const dem = r.demand != null ? num(r.demand) : '·';
    console.log(`  ${r.text.slice(0, 38).padEnd(38)} ${num(r.shows).padStart(7)} ${num(r.clicks).padStart(6)} ${pct(Math.min(r.ctr, 1)).padStart(6)} ${String(pos).padStart(5)} ${dem.padStart(10)}`);
  }

  // ─── Действия ───
  section('Что делать');

  // 🎯 Дожать в топ: позиция 11–30, приоритет по спросу (или показам без Wordstat).
  const nearTop = wmRows
    .filter((r) => r.pos != null && r.pos >= NEAR_TOP_MIN && r.pos <= NEAR_TOP_MAX)
    .sort((a, b) => potential(b) - potential(a)).slice(0, 10);
  bucket(`🎯 Дожать в топ (позиция ${NEAR_TOP_MIN}–${NEAR_TOP_MAX}) — приоритет по спросу:`, nearTop,
    (r) => `${r.text.slice(0, 44).padEnd(44)} поз ${r.pos.toFixed(1).padStart(4)}  спрос ${(r.demand != null ? num(r.demand) : '·').padStart(7)}  показы ${num(r.shows)}`);

  // ✏️ Переписать сниппет: ранжируется, но кликают мало.
  const snippet = wmRows
    .filter((r) => r.pos != null && r.pos <= SNIPPET_POS_MAX && r.ctr < SNIPPET_CTR_MAX && r.shows >= SNIPPET_SHOWS_MIN)
    .sort((a, b) => potential(b) - potential(a)).slice(0, 10);
  bucket(`✏️  Переписать title/description (ранжируется, но мало кликов):`, snippet,
    (r) => `${r.text.slice(0, 44).padEnd(44)} CTR ${pct(r.ctr).padStart(5)}  поз ${r.pos.toFixed(1)}  спрос ${(r.demand != null ? num(r.demand) : '·')}`);

  // 💎 Высокий спрос, слабая видимость (только при наличии данных Wordstat).
  if (demandMap.size) {
    const gap = wmRows
      .filter((r) => r.demand != null && r.demand >= GAP_DEMAND_MIN && r.pos != null && r.pos > GAP_POS_MIN)
      .sort((a, b) => b.demand - a.demand).slice(0, 10);
    bucket(`💎 Высокий спрос — слабая видимость (поз > ${GAP_POS_MIN}): новый контент/страница:`, gap,
      (r) => `${r.text.slice(0, 44).padEnd(44)} спрос ${num(r.demand).padStart(7)}  поз ${r.pos.toFixed(1)}  показы ${num(r.shows)}`);
  }

  console.log('');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
