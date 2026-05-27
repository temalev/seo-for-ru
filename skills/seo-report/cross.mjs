#!/usr/bin/env node
/**
 * Кросс-отчёт SEO: запросы Яндекс.Вебмастера (позиции/показы/клики/CTR)
 * × поведение из Яндекс.Метрики (визиты/отказы по тем же запросам).
 *
 * Ни Вебмастер, ни Метрика по отдельности так не умеют:
 *   - Вебмастер знает, по каким запросам сайт показывается и на какой позиции,
 *     но не знает, что делают пришедшие люди.
 *   - Метрика знает поведение, но Яндекс часто скрывает сами запросы.
 * Здесь мы джойним по тексту запроса и подсвечиваем, что делать.
 *
 * ВАЖНО: Метрика массово прячет поисковые фразы Яндекса. Поэтому данные
 * Метрики — это ОБОГАЩЕНИЕ: actionable-выводы по позициям/CTR работают и без
 * матча, поведение накладывается там, где запрос сошёлся.
 *
 * Конфиг (.env в корне текущего проекта или env-переменные) — нужны ОБА набора:
 *   # Вебмастер
 *   YANDEX_WEBMASTER_TOKEN — scope webmaster:read (fallback: YANDEX_OAUTH_TOKEN)
 *   WEBMASTER_HOST         — домен для выбора хоста (если их несколько)
 *   # Метрика
 *   YANDEX_METRIKA_TOKEN   — scope metrika:read (fallback: YANDEX_OAUTH_TOKEN)
 *   METRIKA_COUNTER_ID     — ID счётчика
 *   METRIKA_ACCURACY       — точность/семплинг, дефолт 'low'
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
const HOST_FILTER = process.env.WEBMASTER_HOST || '';
const COUNTER_ID = process.env.METRIKA_COUNTER_ID;
const WM_BASE = 'https://api.webmaster.yandex.net/v4';
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
const order = getArg('order', 'shows'); // shows|clicks|position|ctr

// Пороги эвристик (подсветка действий). Сознательно простые — крутите под себя.
const NEAR_TOP_MIN = 11, NEAR_TOP_MAX = 30; // «почти в топе» — дожать
const SNIPPET_POS_MAX = 15;                 // ранжируется неплохо…
const SNIPPET_CTR_MAX = 0.03;               // …но кликают мало → переписать сниппет
const SNIPPET_SHOWS_MIN = 50;               // и показов достаточно, чтобы это значило
const LANDING_VISITS_MIN = 5;               // в Метрике есть заметный трафик…
const LANDING_BOUNCE_MIN = 50;              // …но отказы высокие → слабая посадочная

if (!WM_TOKEN) fail('Не задан YANDEX_WEBMASTER_TOKEN (или YANDEX_OAUTH_TOKEN со scope webmaster:read).');
if (!MT_TOKEN) fail('Не задан YANDEX_METRIKA_TOKEN (или YANDEX_OAUTH_TOKEN со scope metrika:read).');
if (!COUNTER_ID) fail('Не задан METRIKA_COUNTER_ID (ID счётчика Метрики).');

function fail(msg) {
  console.error(`❌ ${msg}\n   См. skills/seo-report/SKILL.md — нужны конфиги обоих скиллов.`);
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

// ─── Метрика API ─────────────────────────────────────────────────────────────
let mtLast = 0;
async function mtQuery(params, attempt = 0) {
  const url = new URL(MT_API);
  url.searchParams.set('ids', COUNTER_ID);
  url.searchParams.set('date1', fmt(periodFrom));
  url.searchParams.set('date2', fmt(periodTo));
  url.searchParams.set('accuracy', process.env.METRIKA_ACCURACY || 'low');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const wait = mtLast + 1100 - Date.now(); // Метрика троттлит бурсты под видом 400 "too complicated"
  if (wait > 0) await sleep(wait);
  mtLast = Date.now();

  const res = await fetch(url, { headers: { Authorization: `OAuth ${MT_TOKEN}` } });
  if (res.ok) return res.json();
  const body = await res.text();
  if ((body.includes('too complicated') || res.status === 429) && attempt < 8) {
    await sleep(1500 * (attempt + 1));
    return mtQuery(params, attempt + 1);
  }
  throw new Error(`Metrika ${res.status}: ${body.slice(0, 300)}`);
}

// Поведение по поисковым фразам: визиты + отказы. Карта normQ → {visits, bounce}.
async function fetchMtPhrases() {
  // searchPhrase — высококардинальное измерение; большой limit → 400 "too
  // complicated". Берём топ-200 фраз по визитам (хватает для матча с запросами).
  const d = await mtQuery({
    metrics: 'ym:s:visits,ym:s:bounceRate',
    dimensions: 'ym:s:searchPhrase',
    sort: '-ym:s:visits',
    limit: '200',
  });
  const map = new Map();
  for (const row of d.data || []) {
    const phrase = row.dimensions?.[0]?.name;
    if (!phrase) continue; // строка «не определено» / скрытые запросы
    map.set(normQ(phrase), { visits: row.metrics[0] || 0, bounce: row.metrics[1] || 0 });
  }
  return map;
}

// ─── Сборка ──────────────────────────────────────────────────────────────────
function sortRows(rows) {
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

try {
  const { userId, host } = await resolveHost();
  const hostName = host.unicode_host_url || host.ascii_host_url;
  console.log(`Host: ${hostName}  ·  Counter: ${COUNTER_ID}  ·  ${periodLabel}`);

  // Метрику тянем мягко: если фразы скрыты/ошибка — продолжаем без неё.
  let phrases = new Map();
  let mtNote = '';
  try {
    phrases = await fetchMtPhrases();
    if (!phrases.size) mtNote = 'Метрика не вернула поисковых фраз (Яндекс их скрывает) — поведение недоступно.';
  } catch (e) {
    mtNote = `Метрика недоступна (${e.message.split('\n')[0]}) — отчёт только по Вебмастеру.`;
  }

  const wmRows = await fetchWmQueries(userId, host);
  if (!wmRows.length) { console.log('\n  (Вебмастер не вернул запросов за период)\n'); process.exit(0); }

  // Джойн: к каждому запросу Вебмастера цепляем поведение из Метрики, если сошлось.
  let matched = 0;
  for (const r of wmRows) {
    const m = phrases.get(r.key);
    if (m) { r.visits = m.visits; r.bounce = m.bounce; matched++; }
  }

  const shown = sortRows([...wmRows]).slice(0, limit);

  section(`Запросы × поведение (топ-${limit}, сортировка: ${order})`);
  console.log(`  матч с Метрикой: ${matched} из ${wmRows.length} запросов` + (mtNote ? ` · ${mtNote}` : ''));
  console.log('');
  console.log(`  ${'запрос'.padEnd(38)} ${'показы'.padStart(7)} ${'клики'.padStart(6)} ${'CTR'.padStart(6)} ${'поз.'.padStart(5)} ${'виз.М'.padStart(6)} ${'отказы'.padStart(7)}`);
  for (const r of shown) {
    const pos = r.pos != null ? r.pos.toFixed(1) : '—';
    const v = r.visits != null ? num(r.visits) : '·';
    const b = r.bounce != null ? `${r.bounce.toFixed(0)}%` : '·';
    console.log(`  ${r.text.slice(0, 38).padEnd(38)} ${num(r.shows).padStart(7)} ${num(r.clicks).padStart(6)} ${pct(Math.min(r.ctr, 1)).padStart(6)} ${String(pos).padStart(5)} ${v.padStart(6)} ${b.padStart(7)}`);
  }

  // ─── Действия ───
  section('Что делать');

  const nearTop = wmRows
    .filter((r) => r.pos != null && r.pos >= NEAR_TOP_MIN && r.pos <= NEAR_TOP_MAX)
    .sort((a, b) => b.shows - a.shows).slice(0, 10);
  bucket(`🎯 Дожать в топ (позиция ${NEAR_TOP_MIN}–${NEAR_TOP_MAX}) — контент/перелинковка:`, nearTop,
    (r) => `${r.text.slice(0, 48).padEnd(48)} поз ${r.pos.toFixed(1).padStart(4)}  показы ${num(r.shows)}`);

  const snippet = wmRows
    .filter((r) => r.pos != null && r.pos <= SNIPPET_POS_MAX && r.ctr < SNIPPET_CTR_MAX && r.shows >= SNIPPET_SHOWS_MIN)
    .sort((a, b) => b.shows - a.shows).slice(0, 10);
  bucket(`✏️  Переписать title/description (ранжируется, но мало кликов):`, snippet,
    (r) => `${r.text.slice(0, 48).padEnd(48)} CTR ${pct(r.ctr).padStart(5)}  поз ${r.pos.toFixed(1)}  показы ${num(r.shows)}`);

  if (matched) {
    const landing = wmRows
      .filter((r) => r.visits != null && r.visits >= LANDING_VISITS_MIN && r.bounce >= LANDING_BOUNCE_MIN)
      .sort((a, b) => b.visits - a.visits).slice(0, 10);
    bucket(`🚧 Слабая посадочная (трафик есть, но отказы высокие):`, landing,
      (r) => `${r.text.slice(0, 48).padEnd(48)} визиты ${num(r.visits)}  отказы ${r.bounce.toFixed(0)}%`);
  }

  console.log('');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
