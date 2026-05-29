#!/usr/bin/env node
/**
 * Выгрузка данных из Яндекс.Вебмастера через Webmaster API v4.
 * Показывает то, что Метрика прячет: поисковые запросы с позициями/показами/
 * кликами/CTR, ИКС, индексацию, диагностику.
 *
 * Конфиг (env-переменные или .env в корне текущего проекта):
 *   YANDEX_WEBMASTER_TOKEN — OAuth-токен, scope webmaster:read (обязательно)
 *                            fallback: YANDEX_OAUTH_TOKEN
 *   WEBMASTER_HOST         — домен для выбора хоста (напр. рк-тек.рф или xn--…).
 *                            Если не задан и хост один — берётся он; если
 *                            несколько — скрипт выведет список и попросит указать.
 *
 * Запуск:
 *   node webmaster.mjs                    # весь отчёт
 *   node webmaster.mjs --report queries   # summary|queries|indexing|diagnostics|all
 *   node webmaster.mjs --days 7 --limit 50
 *   node webmaster.mjs --order position   # сортировка queries: shows|clicks|position|ctr
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

const TOKEN = process.env.YANDEX_WEBMASTER_TOKEN || process.env.YANDEX_OAUTH_TOKEN;
const HOST_FILTER = process.env.WEBMASTER_HOST || '';
const BASE = 'https://api.webmaster.yandex.net/v4';

// --- args ---
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const days = parseInt(getArg('days', '7'), 10);
const daysExplicit = args.includes('--days');
const limit = parseInt(getArg('limit', '50'), 10);
const report = getArg('report', 'all'); // summary|queries|indexing|diagnostics|all
const order = getArg('order', 'shows'); // shows|clicks|position|ctr
const noFilter = args.includes('--no-filter'); // выключить эвристику накрутки

// Спам/накрутка: три простые эвристики. Выключается --no-filter.
const SPAM_TOP_POS = 12;
const SPAM_SHOWS_MIN = 3;
const SPAM_GLUED_MIN = 14;
const SPAM_BLOCK_RE = process.env.SEO_BLOCKLIST ? new RegExp(process.env.SEO_BLOCKLIST, 'i') : null;
const SPAM_GLUED_RE = new RegExp(`^[а-я]{${SPAM_GLUED_MIN},}$`, 'i');
function isLikelySpam(r) {
  const t = (r.text || '').trim();
  if (SPAM_BLOCK_RE && SPAM_BLOCK_RE.test(t)) return 'blocklist';
  if (r.pos != null && r.pos <= SPAM_TOP_POS && r.shows >= SPAM_SHOWS_MIN && r.clicks === 0) return 'top-no-clicks';
  if (SPAM_GLUED_RE.test(t) && r.clicks === 0 && r.shows >= 2) return 'glued';
  return null;
}

if (!TOKEN) {
  console.error('❌ Не задан YANDEX_WEBMASTER_TOKEN (или YANDEX_OAUTH_TOKEN).');
  console.error('   В .env проекта:  YANDEX_WEBMASTER_TOKEN=y0_...');
  console.error('   Токен нужен со scope webmaster:read — см. SKILL.md.');
  process.exit(1);
}

const date2 = new Date();
const date1 = new Date(Date.now() - days * 86400_000);
const fmt = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Лимитер: не чаще 1 запроса / ~0.5с (у Вебмастера лимиты мягче Метрики).
let lastCall = 0;
async function throttle() {
  const wait = lastCall + 500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/** GET к Webmaster API. params: объект; значения-массивы → повтор параметра. */
async function api(path, params = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  await throttle();
  const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
  if (res.ok) return res.json();

  const body = await res.text();
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await sleep(1000 * (attempt + 1));
    return api(path, params, attempt + 1);
  }
  throw new Error(`API ${res.status} ${path}\n${body.slice(0, 400)}`);
}

const num = (n) => new Intl.NumberFormat('ru').format(Math.round(n));
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const section = (t) => console.log(`\n${'─'.repeat(64)}\n  ${t}\n${'─'.repeat(64)}`);

// --- резолв user_id + host_id ---
async function resolveHost() {
  const { user_id: userId } = await api('/user');
  const { hosts = [] } = await api(`/user/${userId}/hosts`);
  const verified = hosts.filter((h) => h.verified !== false);

  const norm = (s) => (s || '').toLowerCase();
  const match = (h) => {
    const f = norm(HOST_FILTER);
    return norm(h.ascii_host_url).includes(f) || norm(h.unicode_host_url).includes(f) || norm(h.host_id).includes(f);
  };

  let host;
  if (HOST_FILTER) {
    host = verified.find(match) || hosts.find(match);
    if (!host) throw new Error(`Хост по фильтру "${HOST_FILTER}" не найден. Доступные:\n${hosts.map((h) => `  - ${h.unicode_host_url || h.ascii_host_url} (${h.host_id})`).join('\n')}`);
  } else if (verified.length === 1) {
    host = verified[0];
  } else {
    throw new Error(`Несколько хостов — задайте WEBMASTER_HOST в .env. Доступные:\n${verified.map((h) => `  - ${h.unicode_host_url || h.ascii_host_url}`).join('\n')}`);
  }

  // Следуем главному зеркалу (напр. www → без www): данные поиска у него.
  const mainId = host.main_mirror?.host_id;
  if (mainId && mainId !== host.host_id) {
    host = hosts.find((h) => h.host_id === mainId) || { ...host, host_id: mainId };
  }
  return { userId, host };
}

// --- отчёты ---
async function summary(userId, host) {
  section(`Сводка: ${host.unicode_host_url || host.ascii_host_url}`);
  const s = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/summary`);
  console.log(`  ИКС (SQI):         ${s.sqi != null ? num(s.sqi) : '—'}`);
  if (s.site_problems) {
    const p = s.site_problems;
    const parts = Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    console.log(`  Проблемы сайта:    ${parts.length ? parts.join(', ') : 'нет'}`);
  }
}

async function queries(userId, host) {
  // order_by у API принимает только TOTAL_SHOWS|TOTAL_CLICKS — остальное сортируем клиентом.
  const params = {
    order_by: order === 'clicks' || order === 'ctr' ? 'TOTAL_CLICKS' : 'TOTAL_SHOWS',
    query_indicator: ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'],
  };
  // По умолчанию — без дат (API отдаёт свежее доступное окно). При --days
  // конец сдвигаем на 2 дня назад: последние дни Вебмастер ещё не обработал.
  let label = 'свежее окно Вебмастера';
  if (daysExplicit) {
    const to = new Date(Date.now() - 2 * 86400_000);
    const from = new Date(to.getTime() - days * 86400_000);
    params.date_from = fmt(from);
    params.date_to = fmt(to);
    label = `${fmt(from)} → ${fmt(to)}`;
  }
  section(`Поисковые запросы (топ-${limit}, ${label})`);

  const d = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/search-queries/popular`, params);
  let rows = (d.queries || []).map((q) => {
    const ind = q.indicators || {};
    const shows = ind.TOTAL_SHOWS || 0;
    const clicks = ind.TOTAL_CLICKS || 0;
    return { text: q.query_text || q.query_id || '—', shows, clicks, ctr: shows ? clicks / shows : 0, pos: ind.AVG_SHOW_POSITION };
  });
  if (order === 'ctr') rows.sort((a, b) => b.ctr - a.ctr);
  else if (order === 'position') rows.sort((a, b) => (a.pos ?? 999) - (b.pos ?? 999));

  // Спам-фильтр: накрутку держим отдельно от основной таблицы, печатаем
  // сводным 🚫-блоком ниже.
  const spam = [];
  if (!noFilter) {
    const clean = [];
    for (const r of rows) {
      const reason = isLikelySpam(r);
      if (reason) { r._spamReason = reason; spam.push(r); }
      else clean.push(r);
    }
    rows = clean;
  }
  rows = rows.slice(0, limit);

  if (spam.length) console.log(`  🚫 скрыто ${spam.length} подозрительных (накрутка) — --no-filter, чтобы показать.`);
  console.log(`  ${'запрос'.padEnd(40)} ${'показы'.padStart(7)} ${'клики'.padStart(6)} ${'CTR'.padStart(7)} ${'поз.'.padStart(6)}`);
  for (const r of rows) {
    const pos = r.pos != null ? r.pos.toFixed(1) : '—';
    console.log(`  ${r.text.slice(0, 40).padEnd(40)} ${num(r.shows).padStart(7)} ${num(r.clicks).padStart(6)} ${pct(r.ctr).padStart(7)} ${String(pos).padStart(6)}`);
  }
  if (!rows.length) console.log('  (нет данных)');

  if (spam.length) {
    const sample = [...spam].sort((a, b) => b.shows - a.shows).slice(0, 5);
    console.log(`\n  🚫 Похоже на накрутку (всего ${spam.length}; топ-${sample.length}):`);
    for (const r of sample) {
      const pos = r.pos != null ? r.pos.toFixed(1) : '—';
      console.log(`    ${r.text.slice(0, 40).padEnd(40)} показы ${num(r.shows).padStart(5)}  клики ${num(r.clicks).padStart(3)}  поз ${pos.padStart(4)}  [${r._spamReason}]`);
    }
  }
}

async function indexing(userId, host) {
  section('Страниц в поиске (динамика)');
  const d = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/search-urls/in-search/history`, {
    date_from: fmt(new Date(Date.now() - 30 * 86400_000)),
    date_to: fmt(date2),
  });
  const hist = d.history || d.indicators || [];
  if (!hist.length) { console.log('  (нет данных)'); return; }
  const last = hist.slice(-7);
  for (const point of last) {
    const date = point.date || point.date_to || '—';
    const val = point.value ?? point.count ?? '—';
    console.log(`  ${String(date).slice(0, 10)}   ${num(val)} страниц`);
  }
}

async function diagnostics(userId, host) {
  section('Диагностика сайта');
  const d = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/diagnostics/`);
  // problems — объект { TYPE: { severity, state, last_state_update } }.
  // state ABSENT/NONE = проблемы нет; показываем только присутствующие.
  const entries = Object.entries(d.problems || {});
  const present = entries.filter(([, p]) => p && !['ABSENT', 'NONE'].includes(p.state));
  if (!present.length) {
    console.log(`  Активных проблем нет ✓ (проверено типов: ${entries.length})`);
    return;
  }
  for (const [type, p] of present) {
    console.log(`  [${p.severity || '—'} / ${p.state}, ${freshnessLabel(p.last_state_update)}] ${type}`);
  }
}

// «N дн назад» / «N ч назад» / «не проверялось». Помогает отличить свежий
// PRESENT (реально проблема сейчас) от устаревшего PRESENT (мог быть решён,
// Яндекс просто не пере-проверял) и UNDEFINED без даты.
function freshnessLabel(iso) {
  if (!iso) return 'не проверялось';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'не проверялось';
  const h = Math.floor(ms / 3600_000);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
}

const reports = { summary, queries, indexing, diagnostics };

try {
  const { userId, host } = await resolveHost();
  console.log(`Host: ${host.unicode_host_url || host.ascii_host_url}  (${host.host_id})`);
  if (report === 'all') {
    for (const fn of Object.values(reports)) {
      try { await fn(userId, host); } catch (e) { console.error(`  ⚠️ ${e.message}`); }
    }
  } else if (reports[report]) {
    await reports[report](userId, host);
  } else {
    console.error(`Неизвестный отчёт: ${report}. Доступны: ${Object.keys(reports).join(', ')}, all`);
    process.exit(1);
  }
  console.log('');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
