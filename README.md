# yandex-metrika — Claude Code plugin

Скилл для Claude Code: выгрузка аналитики из **Яндекс.Метрики** через [Stat API v1](https://yandex.ru/dev/metrika/ru/stat/). Визиты, источники трафика, поисковые системы и запросы, топ страниц входа, география. Чистый Node (≥18), без зависимостей.

## Установка

В любом проекте, открытом в Claude Code:

```
/plugin marketplace add temalev/seo-for-ru
/plugin install yandex-metrika@artem-skills
```

Для локальной разработки плагина:

```
claude --plugin-dir /путь/к/seo-for-ru
```

## Настройка

В корне проекта, где будете смотреть статистику, создайте `.env` (добавьте его в `.gitignore`):

```
YANDEX_METRIKA_TOKEN=y0_...     # OAuth-токен, scope metrika:read
METRIKA_COUNTER_ID=12345678     # ID счётчика
```

### Как получить токен

1. https://oauth.yandex.ru/ → создать приложение → тип «Для доступа к API или отладки».
2. Дать право **`metrika:read`**, скопировать **ClientID**.
3. Открыть `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>`.
4. Подтвердить → токен в адресной строке после `#access_token=`.

### Где Counter ID

В URL интерфейса Метрики или в коде счётчика на сайте: `ym(<ID>, "init", ...)`.

## Использование

Скилл подхватывается автоматически, когда вы просите данные Метрики
(«покажи трафик», «откуда приходят», «топ страниц», «по каким запросам»).

Вручную:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/yandex-metrika/metrika.mjs" --report overview --days 30
```

`--report`: `overview` | `sources` | `search` | `pages` | `geo` | `all` · `--days N`

## Отчёты

| report | Данные |
|---|---|
| `overview` | визиты, посетители, просмотры, % отказов, глубина, ср. время |
| `sources` | источники трафика |
| `search` | поисковые системы + фразы |
| `pages` | топ страниц входа |
| `geo` | топ городов |

## Заметка про троттлинг

Stat API периодически возвращает `400 "Query is too complicated"` (интермиттентный rate-лимит, не реальная сложность). В скрипте есть интервал 1.1с + 8 ретраев. При жёстком троттле — запускайте секции по одной с паузами.

## Структура

```
seo-for-ru/
├── .claude-plugin/
│   ├── plugin.json         # манифест плагина
│   └── marketplace.json    # каталог для /plugin marketplace add
├── skills/
│   └── yandex-metrika/
│       ├── SKILL.md        # описание + инструкции
│       └── metrika.mjs     # скрипт (Stat API, .env, throttle+retry)
└── README.md
```

## Лицензия

MIT
