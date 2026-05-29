#!/usr/bin/env node
/**
 * PageSpeed Insights: скорость и Core Web Vitals страницы.
 *
 * Это техническое SEO, которого нет в наших Яндекс-скиллах: LCP/CLS/INP/TBT,
 * Performance + SEO score, топ-5 чего улучшить. Google PSI API — открытый,
 * без авторизации работает, key опционально (PAGESPEED_API_KEY) под выше
 * рейтлимит.
 *
 * Запуск:
 *   node pagespeed.mjs https://example.com/
 *   node pagespeed.mjs https://example.com/ --strategy mobile
 *   node pagespeed.mjs https://example.com/ --strategy both   # дефолт
 *
 * Под капотом Google запускает Lighthouse — это занимает 5-15с на стратегию.
 * Мобильная + десктоп = ~20-30с суммарно. Это нормально.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv() {
  try {
    const file = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of file.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const API_KEY = process.env.PAGESPEED_API_KEY || '';

const args = process.argv.slice(2);
const rawUrl = args.find((a) => !a.startsWith('--') && /^https?:\/\//i.test(a));
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const strategyArg = getArg('strategy', 'both'); // mobile|desktop|both

if (!rawUrl) {
  console.error('❌ Укажите URL: node pagespeed.mjs https://example.com/');
  console.error('   Опции: --strategy mobile|desktop|both (дефолт both)');
  process.exit(1);
}

// IDN→ASCII (punycode): Lighthouse в Google не умеет кириллические домены и
// падает с 'INVALID_URL'. URL-конструктор Node автоматически конвертит
// hostname в punycode, .href отдаёт ASCII-форму.
let url;
try { url = new URL(rawUrl).href; }
catch { console.error(`❌ Невалидный URL: ${rawUrl}`); process.exit(1); }

async function fetchPSI(strategy) {
  const u = new URL(API);
  u.searchParams.set('url', url);
  u.searchParams.set('strategy', strategy);
  u.searchParams.set('locale', 'ru'); // русские формулировки в рекомендациях
  u.searchParams.append('category', 'performance');
  u.searchParams.append('category', 'seo');
  if (API_KEY) u.searchParams.set('key', API_KEY);
  const res = await fetch(u);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 429) {
      const hint = API_KEY
        ? 'превышен лимит вашего ключа — подождите или поднимите квоту в Google Cloud Console.'
        : 'квота общего no-key пула исчерпана на сегодня. Это не баг — Google делит её на весь интернет. Решение: получить бесплатный ключ в Google Cloud Console → PAGESPEED_API_KEY в .env.';
      throw new Error(`PSI 429: ${hint}`);
    }
    throw new Error(`PSI ${res.status}: ${t.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return res.json();
}

function scoreEmoji(s) {
  if (s == null) return '·';
  return s >= 0.9 ? '🟢' : s >= 0.5 ? '🟡' : '🔴';
}

function scoreLabel(s) {
  if (s == null) return '— ·';
  return `${scoreEmoji(s)} ${Math.round(s * 100)}`;
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}с` : `${Math.round(ms)}мс`;
}

function metricLine(label, audit, norm) {
  if (!audit) return null;
  const value = audit.displayValue || '—';
  const e = scoreEmoji(audit.score);
  return `  ${e} ${label.padEnd(38)} ${value.padStart(10)}   ${norm}`;
}

function topOpportunities(audits) {
  return Object.values(audits || {})
    .filter((a) => a.details?.type === 'opportunity' && a.score != null && a.score < 0.9)
    .filter((a) => (a.details?.overallSavingsMs || 0) >= 100)
    .sort((a, b) => (b.details?.overallSavingsMs || 0) - (a.details?.overallSavingsMs || 0))
    .slice(0, 5);
}

async function runStrategy(strategy) {
  const head = strategy === 'mobile' ? '📱 МОБИЛЬНЫЙ' : '🖥  ДЕСКТОП';
  console.log(`\n${'─'.repeat(72)}\n  ${head}  (замер 5-15с)\n${'─'.repeat(72)}`);
  let data;
  try { data = await fetchPSI(strategy); }
  catch (e) { console.error(`  ❌ ${e.message.split('\n')[0]}`); return; }

  const lhr = data.lighthouseResult || {};
  const audits = lhr.audits || {};
  const cats = lhr.categories || {};

  console.log(`  Performance: ${scoreLabel(cats.performance?.score)}    SEO: ${scoreLabel(cats.seo?.score)}`);

  console.log('\n  Core Web Vitals:');
  const lines = [
    metricLine('LCP — Largest Contentful Paint', audits['largest-contentful-paint'], 'норма < 2.5с'),
    metricLine('CLS — Cumulative Layout Shift',  audits['cumulative-layout-shift'],  'норма < 0.1'),
    metricLine('TBT — Total Blocking Time',      audits['total-blocking-time'],      'норма < 200мс'),
    metricLine('FCP — First Contentful Paint',   audits['first-contentful-paint'],   'норма < 1.8с'),
    metricLine('SI  — Speed Index',              audits['speed-index'],              'норма < 3.4с'),
    metricLine('TTI — Time to Interactive',      audits['interactive'],              'норма < 3.8с'),
  ].filter(Boolean);
  for (const l of lines) console.log(l);

  // CrUX полевые данные (если есть — реальные пользователи, не Lighthouse-лаб).
  const lo = data.loadingExperience;
  if (lo?.metrics) {
    console.log('\n  Реальные пользователи (Chrome UX Report, последние 28 дн):');
    const m = lo.metrics;
    const fmt = (k, label, isMs) => {
      const v = m[k];
      if (!v) return null;
      const value = isMs ? fmtMs(v.percentile) : (v.percentile / 100).toFixed(2);
      const cat = v.category; // FAST|AVERAGE|SLOW
      const e = cat === 'FAST' ? '🟢' : cat === 'AVERAGE' ? '🟡' : '🔴';
      return `  ${e} ${label.padEnd(38)} ${value.padStart(10)}`;
    };
    const cruxLines = [
      fmt('LARGEST_CONTENTFUL_PAINT_MS', 'LCP', true),
      fmt('CUMULATIVE_LAYOUT_SHIFT_SCORE', 'CLS', false),
      fmt('INTERACTION_TO_NEXT_PAINT', 'INP', true),
      fmt('FIRST_CONTENTFUL_PAINT_MS', 'FCP', true),
    ].filter(Boolean);
    for (const l of cruxLines) console.log(l);
    if (!cruxLines.length) console.log('  (мало трафика — Chrome UX Report не накопил данные)');
  }

  const opps = topOpportunities(audits);
  if (opps.length) {
    console.log('\n  🎯 Что улучшить (по убыванию импакта):');
    for (const o of opps) {
      const savings = fmtMs(o.details.overallSavingsMs);
      const title = (o.title || o.id || '?').slice(0, 60);
      console.log(`    • ${title.padEnd(60)} ~ ${savings}`);
    }
  }

  // SEO-замечания Lighthouse: те, что fail'нулись.
  const seoFails = Object.values(audits)
    .filter((a) => cats.seo?.auditRefs?.some((r) => r.id === a.id))
    .filter((a) => a.score != null && a.score < 1)
    .slice(0, 5);
  if (seoFails.length) {
    console.log('\n  ⚠️ SEO-замечания:');
    for (const a of seoFails) console.log(`    • ${(a.title || a.id).slice(0, 60)}`);
  }
}

console.log(`URL: ${url}${API_KEY ? '  ·  PAGESPEED_API_KEY ✓' : ''}`);

if (strategyArg === 'both') {
  await runStrategy('mobile');
  await runStrategy('desktop');
} else if (['mobile', 'desktop'].includes(strategyArg)) {
  await runStrategy(strategyArg);
} else {
  console.error(`❌ --strategy: ожидалось mobile|desktop|both, получено "${strategyArg}"`);
  process.exit(1);
}
console.log('');
