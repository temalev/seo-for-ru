#!/usr/bin/env node
/**
 * Кросс-отчёт SEO: позиции Яндекс.Вебмастера + два независимых обогащения.
 *
 * Оси:
 *   1) ВЕБМАСТЕР (обязательно) — позиции/показы/клики/CTR по запросам сайта.
 *   2) WORDSTAT (опционально) — спрос фразы в месяц (totalCount). Даёт приоритет
 *      «дожать в топ» по потенциалу трафика и подсвечивает высокоспросные фразы
 *      со слабой видимостью. Два равноценных по данным режима доступа: прямой
 *      Wordstat API (OAuth) ИЛИ Yandex Cloud Search API (API-ключ + folderId).
 *   3) МЕТРИКА (опционально) — поведение пришедших по фразе: визиты + отказы.
 *      Подсвечивает «слабые посадочные» — фразы, которые приводят трафик с
 *      высокими отказами. Внимание: Stat API массово прячет фразы Яндекса; на
 *      тяжёлых счётчиках dimension-запрос отбивается 400 «too complicated»
 *      (детерминирован для данной формы запроса) — НЕ ретраим, сразу деградируем.
 *
 * Каждая ось — best-effort: нет токена/доступа/данных → колонки этой оси заполнены
 * «·», бакет этой оси пропускается, остальное работает.
 *
 * Конфиг (.env в корне текущего проекта или env-переменные):
 *   # Вебмастер (обязательно)
 *   YANDEX_WEBMASTER_TOKEN — scope webmaster:read (fallback: YANDEX_OAUTH_TOKEN)
 *   WEBMASTER_HOST         — домен для выбора хоста (если их несколько)
 *   # Метрика (опционально)
 *   YANDEX_METRIKA_TOKEN   — scope metrika:read (fallback: YANDEX_OAUTH_TOKEN)
 *   METRIKA_COUNTER_ID     — id счётчика
 *   METRIKA_ACCURACY       — accuracy для Stat API (дефолт 'low')
 *   # Wordstat (опционально). Один из двух наборов, скрипт выберет:
 *   #   A) прямой Wordstat API (OAuth, форма разблокировки на wordstat.yandex.ru):
 *   YANDEX_WORDSTAT_TOKEN  — Bearer-токен Wordstat API
 *   #   B) Yandex Cloud Search API (API-ключ AI Studio + folderId; Preview, платный):
 *   YANDEX_CLOUD_API_KEY   — ключ AI Studio (или YC_API_KEY)
 *   YANDEX_CLOUD_FOLDER_ID — id каталога Cloud (или YC_FOLDER_ID)
 *   WORDSTAT_REGIONS       — id регионов через запятую (напр. 11=Рязань,
 *                            213=Москва); пусто = вся Россия
 *   WORDSTAT_DEVICES       — all|desktop|phone|tablet (дефолт all; только для A)
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
const MT_TOKEN = process.env.YANDEX_METRIKA_TOKEN || process.env.YANDEX_OAUTH_TOKEN;
const MT_COUNTER = process.env.METRIKA_COUNTER_ID;
const MT_MODE = !!(MT_TOKEN && MT_COUNTER);
// Wordstat: два варианта доступа (равноценны по данным). oauth приоритетнее.
const WS_OAUTH = process.env.YANDEX_WORDSTAT_TOKEN;
const YC_KEY = process.env.YANDEX_CLOUD_API_KEY || process.env.YC_API_KEY;
const YC_FOLDER = process.env.YANDEX_CLOUD_FOLDER_ID || process.env.YC_FOLDER_ID;
const WS_MODE = WS_OAUTH ? 'oauth' : (YC_KEY && YC_FOLDER ? 'cloud' : null);
const HOST_FILTER = process.env.WEBMASTER_HOST || '';
const WS_REGIONS = (process.env.WORDSTAT_REGIONS || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const WS_DEVICES = (process.env.WORDSTAT_DEVICES || 'all');
const WM_BASE = 'https://api.webmaster.yandex.net/v4';
const WS_OAUTH_API = 'https://api.wordstat.yandex.net/v1/topRequests';
const WS_CLOUD_API = 'https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests';
const MT_API = 'https://api-metrika.yandex.net/stat/v1/data';

// --- args ---
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const days = parseInt(getArg('days', '7'), 10);
const daysExplicit = args.includes('--days');
const limit = parseInt(getArg('limit', '50'), 10);
const order = getArg('order', 'shows'); // shows|clicks|position|ctr|demand|visits
const noFilter = args.includes('--no-filter'); // выключить эвристику накрутки

// Пороги эвристик (подсветка действий). Сознательно простые — крутите под себя.
const NEAR_TOP_MIN = 11, NEAR_TOP_MAX = 30; // «почти в топе» — дожать
const SNIPPET_POS_MAX = 15;                 // ранжируется неплохо…
const SNIPPET_CTR_MAX = 0.03;               // …но кликают мало → переписать сниппет
const SNIPPET_SHOWS_MIN = 50;               // и показов достаточно, чтобы это значило
const GAP_POS_MIN = 20;                     // ранжируемся слабо (поз > 20)…
const GAP_DEMAND_MIN = 300;                 // …при заметном спросе → недобираем трафик
const LANDING_VISITS_MIN = 5;               // в Метрике есть заметный трафик по фразе…
const LANDING_BOUNCE_MIN = 50;              // …но отказы высокие → слабая посадочная
const WS_MAX_LOOKUPS = 120;                 // потолок обращений к Wordstat за прогон
// Спам/накрутка: три простые эвристики (см. isLikelySpam). Отключается --no-filter.
const SPAM_TOP_POS = 12;                    // первая страница + 0 кликов при показах ≥ 3 → аномалия
const SPAM_SHOWS_MIN = 3;
const SPAM_GLUED_MIN = 14;                  // одно слитное кирил. слово ≥ 14 букв
const SPAM_BLOCK_RE = process.env.SEO_BLOCKLIST ? new RegExp(process.env.SEO_BLOCKLIST, 'i') : null;
const SPAM_GLUED_RE = new RegExp(`^[а-я]{${SPAM_GLUED_MIN},}$`, 'i');

if (!WM_TOKEN) fail('Не задан YANDEX_WEBMASTER_TOKEN (или YANDEX_OAUTH_TOKEN со scope webmaster:read).');

function fail(msg) {
  console.error(`❌ ${msg}\n   См. skills/seo-report/SKILL.md — нужен хотя бы токен Вебмастера.`);
  process.exit(1);
}

const fmt = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (n) => new Intl.NumberFormat('ru').format(Math.round(n));
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const section = (t) => console.log(`\n${'─'.repeat(80)}\n  ${t}\n${'─'.repeat(80)}`);

// Нормализация текста запроса для джойна: регистр, пробелы, ё→е.
const normQ = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Эвристика накрутки. Возвращает причину или null.
//   blocklist     — попадание под SEO_BLOCKLIST из .env (regex)
//   top-no-clicks — позиция ≤ 10 + показов ≥ 3 + 0 кликов: на топе так не бывает
//   glued         — слитная опечатка ≥ 14 кирил. без пробелов + 0 кликов
function isLikelySpam(r) {
  const t = (r.text || '').trim();
  if (SPAM_BLOCK_RE && SPAM_BLOCK_RE.test(t)) return 'blocklist';
  if (r.pos != null && r.pos <= SPAM_TOP_POS && r.shows >= SPAM_SHOWS_MIN && r.clicks === 0) return 'top-no-clicks';
  if (SPAM_GLUED_RE.test(t) && r.clicks === 0 && r.shows >= 2) return 'glued';
  return null;
}

// Период. По умолчанию Вебмастеру дат не даём (он сам отдаёт свежее окно).
// При --days конец сдвигаем на -2 дня: последние дни Вебмастер ещё не обработал.
const periodTo = new Date(Date.now() - 2 * 86400_000);
const periodFrom = new Date(periodTo.getTime() - days * 86400_000);
const periodLabel = daysExplicit ? `${fmt(periodFrom)} → ${fmt(periodTo)}` : 'свежее окно Вебмастера';
// Для Метрики дата всегда нужна; если --days не задан, берём последние 7 дн.
const mtFrom = daysExplicit ? periodFrom : new Date(periodTo.getTime() - 7 * 86400_000);
const mtTo = periodTo;

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

// ─── Метрика Stat API ────────────────────────────────────────────────────────
// searchPhrase: один запрос на окно, возвращает Map normQ → {visits, bounce}.
// «too complicated» — детерминирован для тяжёлых dimension-запросов, ретрай его
// НЕ пробивает (вчера прошли 9× — все упали) и каждый отказ висит ~11с. Сразу
// деградируем. Ретраим только настоящий 429 по Retry-After (как у polyakov).
async function fetchMtPhrases() {
  const u = new URL(MT_API);
  u.searchParams.set('ids', MT_COUNTER);
  u.searchParams.set('date1', fmt(mtFrom));
  u.searchParams.set('date2', fmt(mtTo));
  u.searchParams.set('accuracy', process.env.METRIKA_ACCURACY || 'low');
  u.searchParams.set('metrics', 'ym:s:visits,ym:s:bounceRate');
  u.searchParams.set('dimensions', 'ym:s:searchPhrase');
  u.searchParams.set('sort', '-ym:s:visits');
  u.searchParams.set('limit', '200');

  async function call(retried = false) {
    const res = await fetch(u, { headers: { Authorization: `OAuth ${MT_TOKEN}` } });
    if (res.ok) return res.json();
    if (res.status === 429 && !retried) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      await sleep((Number.isFinite(ra) && ra <= 60 ? ra : 2) * 1000 + Math.random() * 1000);
      return call(true);
    }
    const txt = await res.text();
    throw new Error(`Metrika ${res.status}: ${txt.slice(0, 200)}`);
  }
  const d = await call();
  const map = new Map();
  for (const row of d.data || []) {
    const phrase = row.dimensions?.[0]?.name;
    if (!phrase) continue; // строка «не определено» / скрытые запросы
    map.set(normQ(phrase), { visits: row.metrics[0] || 0, bounce: row.metrics[1] || 0 });
  }
  return map;
}

// ─── Wordstat API ──────────────────────────────────────────────────────────────
// topRequests: спрос фразы = totalCount (широкое соответствие, показов/мес).
// Два режима с почти одинаковым телом: A (oauth) — phrases[] + Bearer; B (cloud)
// — phrase + folderId + Api-Key. totalCount в Cloud приходит строкой → Number().
// Лимит щедрый (троттла как у Метрики нет): пейсим ~160мс, один ретрай 429.
let wsLast = 0;
async function wsTopRequests(phrase, retried = false) {
  const wait = wsLast + 160 - Date.now();
  if (wait > 0) await sleep(wait);
  wsLast = Date.now();

  let url, headers, body;
  if (WS_MODE === 'cloud') {
    url = WS_CLOUD_API;
    headers = { Authorization: `Api-Key ${YC_KEY}`, 'Content-Type': 'application/json' };
    body = { phrase, numPhrases: 1, folderId: YC_FOLDER };
    if (WS_REGIONS.length) body.regions = WS_REGIONS;
  } else {
    url = WS_OAUTH_API;
    headers = { Authorization: `Bearer ${WS_OAUTH}`, 'Content-Type': 'application/json; charset=utf-8' };
    body = { phrases: [phrase], numPhrases: 1, devices: [WS_DEVICES] };
    if (WS_REGIONS.length) body.regions = WS_REGIONS;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.ok) {
    const d = await res.json();
    const tc = Number(d.totalCount);
    return Number.isFinite(tc) ? tc : null;
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
  if (order === 'visits') return rows.sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1));
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

// Приоритет дожима: спрос если есть, иначе визиты, иначе показы.
const potential = (r) => (r.demand != null ? r.demand : (r.visits != null ? r.visits * 10 : r.shows));

try {
  const { userId, host } = await resolveHost();
  const hostName = host.unicode_host_url || host.ascii_host_url;
  const regLabel = WS_REGIONS.length ? `регионы ${WS_REGIONS.join(',')}` : 'вся Россия';
  const wsLabel = WS_MODE ? `${WS_MODE === 'cloud' ? 'Cloud, ' : ''}${regLabel}` : 'нет';
  const mtLabel = MT_MODE ? `счётчик ${MT_COUNTER}` : 'нет';
  console.log(`Host: ${hostName}  ·  Метрика: ${mtLabel}  ·  Wordstat: ${wsLabel}  ·  ${periodLabel}`);

  let wmRows = await fetchWmQueries(userId, host);
  if (!wmRows.length) { console.log('\n  (Вебмастер не вернул запросов за период)\n'); process.exit(0); }

  // Спам-фильтр: отделяем подозрение на накрутку, чтобы оно не засоряло таблицу
  // и бакеты. Скрытое не молчим — печатаем сводный 🚫-бакет ниже.
  const spamRows = [];
  if (!noFilter) {
    const clean = [];
    for (const r of wmRows) {
      const reason = isLikelySpam(r);
      if (reason) { r._spamReason = reason; spamRows.push(r); }
      else clean.push(r);
    }
    wmRows = clean;
  }

  // Метрика — мягко: один запрос, на ошибке (включая "too complicated") деградируем.
  let mtNote = MT_MODE ? '' : 'нет YANDEX_METRIKA_TOKEN/METRIKA_COUNTER_ID — поведение недоступно.';
  let behaviorMap = new Map();
  if (MT_MODE) {
    try {
      behaviorMap = await fetchMtPhrases();
      for (const r of wmRows) {
        const b = behaviorMap.get(r.key);
        if (b) { r.visits = b.visits; r.bounce = b.bounce; }
      }
      if (!behaviorMap.size) mtNote = 'Метрика не вернула поисковых фраз (Яндекс часто прячет).';
    } catch (e) {
      mtNote = `Метрика недоступна (${e.message.split('\n')[0]}) — поведение недоступно.`;
    }
  }

  const shown = sortRows([...wmRows]).slice(0, limit);

  // Wordstat — мягко: нет доступа/ошибка → продолжаем без спроса.
  let wsNote = WS_MODE ? '' : 'нет доступа к Wordstat (YANDEX_WORDSTAT_TOKEN либо YANDEX_CLOUD_API_KEY+FOLDER_ID) — спрос недоступен.';
  let demandMap = new Map();
  if (WS_MODE) {
    // Обогащаем то, что покажем + кандидатов на дожим (поз 11–30) — там спрос решает.
    const nearTop = wmRows.filter((r) => r.pos != null && r.pos >= NEAR_TOP_MIN && r.pos <= NEAR_TOP_MAX);
    const seen = new Set();
    const toLookup = [...shown, ...nearTop].filter((r) => (seen.has(r.key) ? false : seen.add(r.key)));
    try {
      demandMap = await fetchDemand(toLookup);
      for (const r of wmRows) if (demandMap.has(r.key)) r.demand = demandMap.get(r.key);
      if (!demandMap.size) wsNote = 'Wordstat не вернул спроса по запросам.';
    } catch (e) {
      wsNote = `Wordstat недоступен (${e.message.split('\n')[0]}).`;
    }
  }

  // Пересортировка с учётом обогащений (если просили).
  const shownFinal = (order === 'demand' || order === 'visits') ? sortRows([...wmRows]).slice(0, limit) : shown;

  section(`Запросы × спрос × поведение (топ-${limit}, сортировка: ${order})`);
  if (mtNote) console.log(`  ⚐ ${mtNote}`);
  if (wsNote) console.log(`  ⚐ ${wsNote}`);
  if (spamRows.length) console.log(`  🚫 скрыто ${spamRows.length} подозрительных (накрутка) — --no-filter, чтобы показать.`);
  console.log('');
  console.log(`  ${'запрос'.padEnd(34)} ${'показы'.padStart(6)} ${'клики'.padStart(5)} ${'CTR'.padStart(6)} ${'поз.'.padStart(5)} ${'спрос'.padStart(8)} ${'виз.М'.padStart(6)} ${'отказы'.padStart(7)}`);
  for (const r of shownFinal) {
    const pos = r.pos != null ? r.pos.toFixed(1) : '—';
    const dem = r.demand != null ? num(r.demand) : '·';
    const v = r.visits != null ? num(r.visits) : '·';
    const b = r.bounce != null ? `${r.bounce.toFixed(0)}%` : '·';
    console.log(`  ${r.text.slice(0, 34).padEnd(34)} ${num(r.shows).padStart(6)} ${num(r.clicks).padStart(5)} ${pct(Math.min(r.ctr, 1)).padStart(6)} ${String(pos).padStart(5)} ${dem.padStart(8)} ${v.padStart(6)} ${b.padStart(7)}`);
  }

  // ─── Действия ───
  section('Что делать');

  // 🎯 Дожать в топ: позиция 11–30, приоритет по спросу → визитам → показам.
  const nearTop = wmRows
    .filter((r) => r.pos != null && r.pos >= NEAR_TOP_MIN && r.pos <= NEAR_TOP_MAX)
    .sort((a, b) => potential(b) - potential(a)).slice(0, 10);
  bucket(`🎯 Дожать в топ (позиция ${NEAR_TOP_MIN}–${NEAR_TOP_MAX}) — приоритет по потенциалу:`, nearTop,
    (r) => `${r.text.slice(0, 40).padEnd(40)} поз ${r.pos.toFixed(1).padStart(4)}  спрос ${(r.demand != null ? num(r.demand) : '·').padStart(6)}  виз ${(r.visits != null ? num(r.visits) : '·').padStart(4)}  показы ${num(r.shows)}`);

  // ✏️ Переписать сниппет: ранжируется, но кликают мало.
  const snippet = wmRows
    .filter((r) => r.pos != null && r.pos <= SNIPPET_POS_MAX && r.ctr < SNIPPET_CTR_MAX && r.shows >= SNIPPET_SHOWS_MIN)
    .sort((a, b) => potential(b) - potential(a)).slice(0, 10);
  bucket(`✏️  Переписать title/description (ранжируется, но мало кликов):`, snippet,
    (r) => `${r.text.slice(0, 40).padEnd(40)} CTR ${pct(r.ctr).padStart(5)}  поз ${r.pos.toFixed(1)}  спрос ${(r.demand != null ? num(r.demand) : '·')}`);

  // 💎 Высокий спрос, слабая видимость (только при наличии данных Wordstat).
  if (demandMap.size) {
    const gap = wmRows
      .filter((r) => r.demand != null && r.demand >= GAP_DEMAND_MIN && r.pos != null && r.pos > GAP_POS_MIN)
      .sort((a, b) => b.demand - a.demand).slice(0, 10);
    bucket(`💎 Высокий спрос — слабая видимость (поз > ${GAP_POS_MIN}): новый контент/страница:`, gap,
      (r) => `${r.text.slice(0, 40).padEnd(40)} спрос ${num(r.demand).padStart(7)}  поз ${r.pos.toFixed(1)}  показы ${num(r.shows)}`);
  }

  // 🚧 Слабая посадочная: Метрика показывает заметный трафик, но отказы высокие.
  if (behaviorMap.size) {
    const landing = wmRows
      .filter((r) => r.visits != null && r.visits >= LANDING_VISITS_MIN && r.bounce >= LANDING_BOUNCE_MIN)
      .sort((a, b) => b.visits - a.visits).slice(0, 10);
    bucket(`🚧 Слабая посадочная (трафик есть, отказы ≥ ${LANDING_BOUNCE_MIN}%): чинить страницу/интент:`, landing,
      (r) => `${r.text.slice(0, 40).padEnd(40)} визиты ${num(r.visits).padStart(4)}  отказы ${r.bounce.toFixed(0)}%  поз ${r.pos != null ? r.pos.toFixed(1) : '—'}`);
  }

  // 🚫 Похоже на накрутку: что мы отфильтровали — топ-5 по показам + причина.
  if (spamRows.length) {
    const sample = [...spamRows].sort((a, b) => b.shows - a.shows).slice(0, 5);
    console.log(`\n  🚫 Похоже на накрутку (всего ${spamRows.length}; топ-${sample.length}):`);
    for (const r of sample) {
      const pos = r.pos != null ? r.pos.toFixed(1) : '—';
      console.log(`    ${r.text.slice(0, 40).padEnd(40)} показы ${num(r.shows).padStart(5)}  клики ${num(r.clicks).padStart(3)}  поз ${pos.padStart(4)}  [${r._spamReason}]`);
    }
  }

  console.log('');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
