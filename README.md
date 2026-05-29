# seo-for-ru — SEO-инструменты для рунета (Claude Code plugin)

Коллекция из четырёх скиллов для Claude Code: Яндекс-стек (Метрика, Вебмастер, Wordstat) + Google PageSpeed. Превращает разрозненные кабинеты в **actionable-рекомендации прямо в разговоре с Клодом** — без подписок, локально, в одном `.env`. Чистый Node ≥18, без зависимостей.

## Скиллы

| Скилл | Что даёт | Источник |
|---|---|---|
| **yandex-metrika** | трафик, источники, поисковые системы, топ страниц входа, гео | [Stat API v1](https://yandex.ru/dev/metrika/ru/stat/) |
| **yandex-webmaster** | запросы с позициями/CTR (+ спам-фильтр накрутки), ИКС, индексация, диагностика со свежестью проверки | [Webmaster API v4](https://yandex.ru/dev/webmaster/) |
| **seo-report** | кросс-отчёт `позиции × поведение × спрос`, спам-фильтр, **снимки + diff во времени** | Webmaster + Метрика + Wordstat |
| **pagespeed** | скорость и Core Web Vitals (LCP/CLS/INP), Lighthouse-замечания, реальные данные Chrome UX Report | [Google PSI API](https://developers.google.com/speed/docs/insights/v5/about) |

Скиллы подхватываются автоматически по смыслу запроса («покажи трафик», «позиции в выдаче», «что дожать в топ», «скорость сайта», «core web vitals», «что изменилось за неделю»).

## Что отличает от Яндекс-UI и платных SaaS

- **Кросс-джойн позиций × поведения × спроса по фразе** с нормализацией (`ё↔е`, регистр, пробелы) — Яндекс между Метрикой/Вебмастером/Wordstat в UI ничего сам не сводит.
- **Бакеты-действия** вместо таблиц: 🎯 дожать в топ (по спросу), ✏️ переписать сниппет, 🚧 слабая посадочная, 💎 высокий спрос/слабая видимость.
- **Спам-фильтр накрутки** (`top-no-clicks`, слитные опечатки, пользовательский blocklist) — реальная боль рунета, в Яндекс-UI не отсечь.
- **Снимки + `--diff`** — каждый прогон пишет JSON-снимок в `.seo-snapshots/<домен>/`. История позиций / ИКС / диагностики без какой-либо БД, git-friendly.
- **Свежесть диагностики**: `[PRESENT, 10 дн назад]` vs `[UNDEFINED, не проверялось]` — отличает реальные проблемы от устаревших и непроверенных.
- **Мягкая деградация**: оси Метрика/Wordstat best-effort, при отказе колонки `·` и бакет скрыт — остальное работает.
- **AI-нативный workflow**: Клод сам триггерит скилл по теме, видит вывод, рассуждает дальше — не нужно копаться между тремя вкладками Яндекса.

## Установка

В любом проекте, открытом в Claude Code:

```
/plugin marketplace add temalev/seo-for-ru
/plugin install seo-for-ru@seo-for-ru
```

Для локальной разработки плагина:

```
claude --plugin-dir /путь/к/seo-for-ru
```

## Настройка

В корне проекта-сайта создайте `.env` (добавьте в `.gitignore`). Каждый скилл использует свой набор — задавайте только нужное:

```bash
# Метрика (yandex-metrika)
YANDEX_METRIKA_TOKEN=y0_...     # OAuth, scope metrika:read (fallback: YANDEX_OAUTH_TOKEN)
METRIKA_COUNTER_ID=12345678     # ID счётчика

# Вебмастер (yandex-webmaster, seo-report)
YANDEX_WEBMASTER_TOKEN=y0_...   # OAuth, scope webmaster:read (fallback: YANDEX_OAUTH_TOKEN)
WEBMASTER_HOST=рк-тек.рф        # если в Вебмастере несколько сайтов

# Wordstat для seo-report (опционально — добавляет ось спроса).
# Cloud Search API стал ПЛАТНЫМ с 18 мая 2026 (20 ₽/1000 запросов GetTop,
# 1 прогон cross.mjs ≈ 1.3 ₽). У новых юзеров Yandex Cloud обычно тестовый
# грант ~4000 ₽ на 60 дней — этого хватит на ~3000 прогонов.
# Один из двух наборов (скрипт выберет первый доступный):
YANDEX_WORDSTAT_TOKEN=y0_...           # A: прямой Wordstat API (OAuth, форма разблокировки на wordstat.yandex.ru)
# или
YANDEX_CLOUD_API_KEY=AQVN...           # B: Yandex Cloud Search API (API-ключ AI Studio со scope yc.search-api.execute)
YANDEX_CLOUD_FOLDER_ID=b1g...          #    + id каталога Cloud; нужен биллинг + роль search-api.webSearch.user
WORDSTAT_REGIONS=11                    # id регионов (11=Рязань, 213=Москва); пусто = вся Россия

# Спам-фильтр и снимки seo-report (всё опционально, дефолты разумные)
SEO_BLOCKLIST=skupik|казино|порн       # regex для сайт-специфичной накрутки (см. spam-filter в SKILL.md)
SEO_SNAPSHOT_DIR=.seo-snapshots        # куда писать снимки cross.mjs (для --diff)

# PageSpeed Insights — крайне рекомендуется свой ключ
# (общий no-key пул периодически выжигается, ловите 429 «Quota exceeded»):
PAGESPEED_API_KEY=AIza...              # бесплатно, 25k запросов/день, см. skills/pagespeed/SKILL.md
```

Удобно перевыпустить **один** `YANDEX_OAUTH_TOKEN` со scope `metrika:read` + `webmaster:read` — он подхватится как fallback для Метрики и Вебмастера.

### Как получить OAuth-токен (Метрика/Вебмастер)

1. https://oauth.yandex.ru/ → создать приложение → «Для доступа к API или отладки».
2. Дать права `metrika:read` и/или `webmaster:read`, скопировать **ClientID**.
3. Открыть `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>`.
4. Подтвердить → токен в адресной строке после `#access_token=`.

Counter ID — в URL интерфейса Метрики или в коде счётчика: `ym(<ID>, "init", ...)`. Доступ к Wordstat для `seo-report` описан в [skills/seo-report/SKILL.md](skills/seo-report/SKILL.md).

## Использование вручную

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/yandex-metrika/metrika.mjs"  --report all --days 30
node "${CLAUDE_PLUGIN_ROOT}/skills/yandex-webmaster/webmaster.mjs" --report all
node "${CLAUDE_PLUGIN_ROOT}/skills/seo-report/cross.mjs" --days 14 --order demand --diff
node "${CLAUDE_PLUGIN_ROOT}/skills/pagespeed/pagespeed.mjs" https://example.com/
```

- **metrika** `--report`: `overview` | `sources` | `search` | `pages` | `geo` | `all` · `--days N`
- **webmaster** `--report`: `queries` | `summary` | `indexing` | `diagnostics` | `all` · `--no-filter`
- **seo-report**: `--days N` · `--limit N` · `--order shows|clicks|position|ctr|demand|visits` · `--diff` · `--no-save` · `--no-filter`
- **pagespeed**: `<url>` · `--strategy mobile|desktop|both`

## Почему именно эти данные

Метрика знает поведение, но Яндекс **массово прячет поисковые фразы** и троттлит запросы с измерением `searchPhrase`. Поэтому источник запросов и позиций — **Вебмастер**, а спрос для `seo-report` берётся из **Wordstat**. Так выводы по позициям/CTR работают всегда, а спрос накладывается как обогащение.

## Структура

```
seo-for-ru/
├── .claude-plugin/
│   ├── plugin.json         # манифест плагина
│   └── marketplace.json    # каталог для /plugin marketplace add
├── skills/
│   ├── yandex-metrika/     # metrika.mjs + SKILL.md
│   ├── yandex-webmaster/   # webmaster.mjs + SKILL.md (+ PLAN.md)
│   ├── seo-report/         # cross.mjs + SKILL.md
│   └── pagespeed/          # pagespeed.mjs + SKILL.md
└── README.md
```

Снимки `seo-report` пишутся в `.seo-snapshots/<домен>/<timestamp>.json` **в директории проекта-сайта** (cwd при запуске), не в репозитории плагина. Если не хотите коммитить историю прогонов — добавьте `.seo-snapshots/` в `.gitignore` проекта.

## Лицензия

MIT
