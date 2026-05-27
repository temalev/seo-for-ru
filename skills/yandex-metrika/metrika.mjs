#!/usr/bin/env node
/**
 * Выгрузка данных из Яндекс.Метрики через Stat API v1.
 *
 * Конфиг (env-переменные или .env в корне текущего проекта):
 *   YANDEX_METRIKA_TOKEN   — OAuth-токен, scope metrika:read (обязательно)
 *   METRIKA_COUNTER_ID     — ID счётчика (обязательно)
 *   METRIKA_ACCURACY       — точность/семплинг, дефолт 'low'
 *
 * Запуск:
 *   node metrika.mjs                      # весь отчёт, 30 дней
 *   node metrika.mjs --days 7
 *   node metrika.mjs --report sources     # overview|sources|search|pages|geo|all
 *
 * Как часть плагина запускается через ${CLAUDE_PLUGIN_ROOT} — см. SKILL.md.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Лёгкая загрузка .env из корня проекта, где запущена команда (без зависимостей).
// Не перезатирает уже заданные process.env.
function loadEnv() {
  try {
    const file = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of file.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* нет .env — читаем из окружения */ }
}
loadEnv();

const TOKEN = process.env.YANDEX_METRIKA_TOKEN;
const COUNTER_ID = process.env.METRIKA_COUNTER_ID;
const API = 'https://api-metrika.yandex.net/stat/v1/data';

// --- args ---
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const days = parseInt(getArg('days', '30'), 10);
const report = getArg('report', 'all'); // all | overview | sources | search | pages | geo

if (!TOKEN) {
  console.error('❌ Не задан YANDEX_METRIKA_TOKEN.');
  console.error('   Добавьте в .env проекта:  YANDEX_METRIKA_TOKEN=y0_...');
  console.error('   Токен (scope metrika:read) — см. README плагина.');
  process.exit(1);
}
if (!COUNTER_ID) {
  console.error('❌ Не задан METRIKA_COUNTER_ID.');
  console.error('   Добавьте в .env проекта:  METRIKA_COUNTER_ID=12345678');
  console.error('   ID счётчика виден в URL Метрики или в коде вставки ym(<ID>, "init", ...).');
  process.exit(1);
}

const date2 = new Date();
const date1 = new Date(Date.now() - days * 86400_000);
const fmt = (d) => d.toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Глобальный лимитер: не чаще 1 запроса в ~1.1с — Метрика троттлит бурсты
// и маскирует это под 400 "Query is too complicated".
let lastCall = 0;
const MIN_GAP = 1100;
async function throttle() {
  const wait = lastCall + MIN_GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * Базовый запрос к Stat API.
 * Метрика периодически отдаёт 400 "Query is too complicated" даже на лёгких
 * запросах (интермиттентный троттлинг по частоте). Тот же запрос проходит при
 * повторе — ретраим с растущим бэкоффом.
 */
async function query(params, attempt = 0) {
  const url = new URL(API);
  url.searchParams.set('ids', COUNTER_ID);
  url.searchParams.set('date1', fmt(date1));
  url.searchParams.set('date2', fmt(date2));
  url.searchParams.set('accuracy', process.env.METRIKA_ACCURACY || 'low');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  await throttle();
  const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
  if (res.ok) return res.json();

  const body = await res.text();
  const tooComplicated = body.includes('too complicated');
  const rateLimited = res.status === 429;
  if ((tooComplicated || rateLimited) && attempt < 8) {
    await sleep(1500 * (attempt + 1));
    return query(params, attempt + 1);
  }
  throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
}

const num = (n) => new Intl.NumberFormat('ru').format(Math.round(n));
const pct = (n) => `${(n).toFixed(1)}%`;
const sec = (n) => `${Math.floor(n / 60)}м ${Math.round(n % 60)}с`;

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);
}

async function overview() {
  section(`Обзор за ${days} дн. (${fmt(date1)} → ${fmt(date2)})`);
  const d = await query({
    metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds',
  });
  const t = d.totals;
  console.log(`  Визиты:            ${num(t[0])}`);
  console.log(`  Посетители:        ${num(t[1])}`);
  console.log(`  Просмотры:         ${num(t[2])}`);
  console.log(`  Отказы:            ${pct(t[3])}`);
  console.log(`  Глубина:           ${t[4].toFixed(2)} стр/визит`);
  console.log(`  Ср. время:         ${sec(t[5])}`);
}

async function sources() {
  section('Источники трафика');
  const d = await query({
    metrics: 'ym:s:visits,ym:s:users',
    dimensions: 'ym:s:lastsignTrafficSource',
    sort: '-ym:s:visits',
    limit: '10',
  });
  for (const row of d.data) {
    console.log(`  ${(row.dimensions[0].name || '—').padEnd(28)} ${num(row.metrics[0]).padStart(8)} визитов`);
  }
}

async function search() {
  section('Поисковые системы');
  const se = await query({
    metrics: 'ym:s:visits',
    dimensions: 'ym:s:searchEngineName',
    sort: '-ym:s:visits',
    limit: '10',
  });
  for (const row of se.data) {
    console.log(`  ${(row.dimensions[0].name || '—').padEnd(28)} ${num(row.metrics[0]).padStart(8)} визитов`);
  }

  section('Поисковые запросы (топ-20)');
  const ph = await query({
    metrics: 'ym:s:visits',
    dimensions: 'ym:s:searchPhrase',
    sort: '-ym:s:visits',
    limit: '20',
  });
  if (!ph.data.length) {
    console.log('  (нет данных — Яндекс часто скрывает запросы; смотрите Вебмастер)');
  }
  for (const row of ph.data) {
    console.log(`  ${(row.dimensions[0].name || '—').padEnd(40)} ${num(row.metrics[0]).padStart(6)}`);
  }
}

async function pages() {
  section('Топ страниц входа (landing)');
  const d = await query({
    metrics: 'ym:s:visits,ym:s:bounceRate',
    dimensions: 'ym:s:startURLPathFull',
    sort: '-ym:s:visits',
    limit: '20',
  });
  for (const row of d.data) {
    const path = (row.dimensions[0].name || '—').slice(0, 45);
    console.log(`  ${path.padEnd(46)} ${num(row.metrics[0]).padStart(6)} виз  ${pct(row.metrics[1]).padStart(6)} отказы`);
  }
}

async function geo() {
  section('География (топ городов)');
  const d = await query({
    metrics: 'ym:s:visits',
    dimensions: 'ym:s:regionCity',
    sort: '-ym:s:visits',
    limit: '10',
  });
  for (const row of d.data) {
    console.log(`  ${(row.dimensions[0].name || '—').padEnd(28)} ${num(row.metrics[0]).padStart(8)} визитов`);
  }
}

const reports = { overview, sources, search, pages, geo };

try {
  console.log(`Counter: ${COUNTER_ID}`);
  if (report === 'all') {
    for (const fn of Object.values(reports)) await fn();
  } else if (reports[report]) {
    await reports[report]();
  } else {
    console.error(`Неизвестный отчёт: ${report}. Доступны: ${Object.keys(reports).join(', ')}, all`);
    process.exit(1);
  }
  console.log('');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
}
