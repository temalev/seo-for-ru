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
const limit = parseInt(getArg('limit', '50'), 10);
const report = getArg('report', 'all'); // summary|queries|indexing|diagnostics|all
const order = getArg('order', 'shows'); // shows|clicks|position|ctr

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
  section(`Поисковые запросы (топ-${limit}, ${fmt(date1)} → ${fmt(date2)})`);
  const indicators = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'];
  const orderMap = { shows: 'TOTAL_SHOWS', clicks: 'TOTAL_CLICKS', position: 'AVG_SHOW_POSITION', ctr: 'TOTAL_CLICKS' };
  const d = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/search-queries/popular`, {
    order_by: orderMap[order] || 'TOTAL_SHOWS',
    query_indicator: indicators,
    date_from: fmt(date1),
    date_to: fmt(date2),
    limit,
  });
  const rows = (d.queries || []).map((q) => {
    const ind = q.indicators || {};
    const shows = ind.TOTAL_SHOWS || 0;
    const clicks = ind.TOTAL_CLICKS || 0;
    return {
      text: q.query_text || q.query_id || '—',
      shows,
      clicks,
      ctr: shows ? clicks / shows : 0,
      pos: ind.AVG_SHOW_POSITION,
    };
  });
  if (order === 'ctr') rows.sort((a, b) => b.ctr - a.ctr);

  console.log(`  ${'запрос'.padEnd(38)} ${'показы'.padStart(8)} ${'клики'.padStart(7)} ${'CTR'.padStart(7)} ${'поз.'.padStart(6)}`);
  for (const r of rows) {
    const pos = r.pos != null ? r.pos.toFixed(1) : '—';
    console.log(`  ${r.text.slice(0, 38).padEnd(38)} ${num(r.shows).padStart(8)} ${num(r.clicks).padStart(7)} ${pct(r.ctr).padStart(7)} ${String(pos).padStart(6)}`);
  }
  if (!rows.length) console.log('  (нет данных за период)');
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
  const d = await api(`/user/${userId}/hosts/${encodeURIComponent(host.host_id)}/diagnostics`);
  const problems = (d.problems || []).filter((p) => p.state !== 'NONE');
  if (!problems.length) { console.log('  Проблем не найдено ✓'); return; }
  for (const p of problems) {
    console.log(`  [${p.severity || p.state || '—'}] ${p.short_description || p.problem_type || JSON.stringify(p).slice(0, 80)}`);
  }
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
