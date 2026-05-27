---
name: yandex-webmaster
description: Выгружает данные Яндекс.Вебмастера, которых нет в Метрике — поисковые запросы с позициями, показами, кликами и CTR, индекс качества сайта (ИКС/SQI), число страниц в поиске, диагностику проблем сайта. Используй когда пользователь просит позиции в поиске, поисковые запросы (по которым показывается/ранжируется сайт), CTR в выдаче, ИКС, индексацию, «почему не в топе», проблемы сайта по Яндексу.
---

# Яндекс.Вебмастер — позиции, запросы, индексация

Тянет данные из [Webmaster API v4](https://yandex.ru/dev/webmaster/). Показывает то, что Метрика прячет: запросы с позициями/CTR. Чистый Node (≥18), без зависимостей.

## Когда использовать

Запросы про **позиции в поиске**, поисковые **запросы** сайта, **CTR** в выдаче, **ИКС**, **индексацию** (страниц в поиске), **диагностику** проблем. Метрика этого не даёт — это Вебмастер.

## Предусловия

Конфиг в `.env` корня проекта (или env-переменные):

```
YANDEX_WEBMASTER_TOKEN=y0_...   # OAuth-токен, scope webmaster:read
                                 # (или YANDEX_OAUTH_TOKEN с этим scope)
WEBMASTER_HOST=рк-тек.рф         # домен (если сайтов несколько); иначе авто
```

**Токен:** нужен scope `webmaster:read`. Если есть токен Метрики — перевыпустите его у того же приложения, добавив `webmaster:read` к `metrika:read`, и используйте как `YANDEX_OAUTH_TOKEN` для обоих скиллов. Либо отдельный токен → `YANDEX_WEBMASTER_TOKEN`.

Получение: https://oauth.yandex.ru/ → приложение «для доступа к API» → права `webmaster:read` (+ `metrika:read` если общий) → `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>`.

## Запуск

`${CLAUDE_PLUGIN_ROOT}` если плагин, либо путь user-скилла:

```bash
node ~/.claude/skills/yandex-webmaster/webmaster.mjs --report queries --days 7
node ~/.claude/skills/yandex-webmaster/webmaster.mjs --report summary
node "${CLAUDE_PLUGIN_ROOT}/skills/yandex-webmaster/webmaster.mjs" --report all
```

Аргументы:
- `--report` : `summary` | `queries` | `indexing` | `diagnostics` | `all` (дефолт `all`)
- `--days N` : период для запросов (дефолт 7)
- `--limit N` : сколько запросов (дефолт 50)
- `--order` : сортировка queries — `shows` | `clicks` | `position` | `ctr`

## Что отдаёт

| report | Данные |
|---|---|
| `summary` | ИКС (SQI) + число проблем сайта |
| `queries` | поисковые запросы: показы, клики, CTR, средняя позиция |
| `indexing` | страниц в поиске (динамика за 30 дн) |
| `diagnostics` | проблемы сайта по версии Яндекса |

## SEO-применение

- **Позиции 11–30** (`--order position`) — «почти в топе», дожать контентом/перелинковкой.
- **Высокие показы + низкий CTR** (`--order shows`, смотреть CTR) — переписать title/description.
- **ИКС** — общий вес сайта, динамика доверия Яндекса.

## Статус

Каркас готов. Точные форматы ответов API уточняются на живом тесте (нужен токен с `webmaster:read`) — скрипт написан защитно, мягко переживает отсутствие полей. См. [PLAN.md](PLAN.md).
