# seo-for-ru — SEO-инструменты для рунета (Claude Code plugin)

Коллекция скиллов для Claude Code под российский SEO-стек: **Яндекс.Метрика**, **Яндекс.Вебмастер** и кросс-отчёт, который их сводит. Чистый Node (≥18), без зависимостей. Токены и идентификаторы живут в `.env` проекта-сайта, не в репозитории плагина.

## Скиллы

| Скилл | Что даёт | Источник |
|---|---|---|
| **yandex-metrika** | трафик, источники, поисковые системы, топ страниц входа, гео | [Stat API v1](https://yandex.ru/dev/metrika/ru/stat/) |
| **yandex-webmaster** | поисковые запросы с позициями/показами/кликами/CTR, ИКС, индексация, диагностика | [Webmaster API v4](https://yandex.ru/dev/webmaster/) |
| **seo-report** | кросс-отчёт: позиции Вебмастера × спрос Wordstat → что дожимать в топ | Webmaster + Wordstat |

Скиллы подхватываются автоматически по смыслу запроса («покажи трафик», «по каким запросам показываемся», «позиции в выдаче», «что дожать в топ»).

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

# Wordstat для seo-report — один из двух вариантов доступа (опционально):
YANDEX_WORDSTAT_TOKEN=y0_...           # A: прямой Wordstat API (OAuth)
# или
YANDEX_CLOUD_API_KEY=AQVN...           # B: Yandex Cloud Search API (ключ AI Studio)
YANDEX_CLOUD_FOLDER_ID=b1g...          #    + id каталога Cloud
WORDSTAT_REGIONS=11                    # id регионов (11=Рязань, 213=Москва); пусто = вся Россия
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
node "${CLAUDE_PLUGIN_ROOT}/skills/seo-report/cross.mjs" --days 14 --order demand
```

- **metrika** `--report`: `overview` | `sources` | `search` | `pages` | `geo` | `all` · `--days N`
- **webmaster** `--report`: `queries` | `summary` | `indexing` | `diagnostics` | `all`
- **seo-report**: `--days N` · `--limit N` · `--order shows|clicks|position|ctr|demand`

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
│   └── seo-report/         # cross.mjs + SKILL.md
└── README.md
```

## Лицензия

MIT
