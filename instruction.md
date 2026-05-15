# Глава 3. Реализация

В данной главе подробно описана реализация программного продукта для дискретно-событийного моделирования системы обслуживания аэропорта. Структура главы соответствует пунктам из файла `Развёрнутый план ВКР.docx`:

1. Реализация модуля для дискретно-событийного моделирования  
2. Реализация графического модуля  
3. Построение модели аэропорта  
4. Проведение моделирования  
5. Анализ результатов моделирования  
6. Рекомендации по оптимизации пассажиропотока  
7. Сравнение продукта с аналогами

---

## 3.1 Реализация модуля для дискретно-событийного моделирования

Модуль моделирования реализован в каталоге `server/modeling` и разделён на логические части:

- описание структур входных данных и валидации: [`server/modeling/schemas.py`](server/modeling/schemas.py)
- генерация случайных величин по распределениям: [`server/modeling/distributions.py`](server/modeling/distributions.py)
- ядро дискретно-событийного алгоритма: [`server/modeling/simulator.py`](server/modeling/simulator.py)
- сохранение и загрузка результатов: [`server/modeling/storage.py`](server/modeling/storage.py)

Связь модулей экспортируется через [`server/modeling/__init__.py`](server/modeling/__init__.py).

### 3.1.1 Структуры модели и валидация конфигурации

Базовые структуры описаны через Pydantic-модели:

- `DistributionConfig` - параметры закона распределения;
- `RouteConfig` - маршрут перехода заявки;
- `NodeConfig` - вершина графа (точка обслуживания);
- `EdgeConfig` - ребро графа (перемещение между вершинами);
- `GeneratorConfig` - генератор входного потока заявок;
- `SimulationConfig` - полная конфигурация запуска;
- `NodePosition` - координаты вершины на рабочем полотне;
- `SimulationRunRequest` - payload запуска (`model_name`, `config`, `node_positions`).

#### Подробно про каждый тип (Literal)

`DistributionType` задаёт математический закон, по которому генерируется случайная задержка (межприходная, сервисная или транспортная):

- `normal` - нормальное распределение; параметры: `mean`, `std`, `min_value`.
- `exponential` - экспоненциальное распределение; параметры: `scale`, `min_value`.
- `uniform` - равномерное распределение; параметры: `low`, `high`, `min_value`.
- `deterministic` - фиксированное значение; параметры: `value`, `min_value`.
- `poisson` - пуассоновский входной поток (через экспоненциальный межприходный интервал); параметры: `rate` (или `intensity`/`value`), `min_value`.
- `erlang` - распределение Эрланга; параметры: `shape`, `rate` (или `intensity`), `min_value`.
- `hyperexponential` - смесь двух экспонент; параметры: `rate1`, `rate2`, `mix_probability`, `min_value`.
- `intervals` - выбор из заданного набора интервалов; параметры: `intervals` (или `value`), `min_value`.
- `intensity` - экспоненциальный межприходный интервал через интенсивность; параметры: `intensity` (или `rate`/`value`), `min_value`.

Где используется:

- backend: генерация чисел в `SampleFromDistribution` ([`server/modeling/distributions.py`](server/modeling/distributions.py));
- frontend: выбор типа и параметров распределения в `DistributionEditor` ([`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx));
- валидация допустимых наборов: `GENERATOR_DISTRIBUTIONS` и `SERVICE_DISTRIBUTIONS` ([`server/modeling/schemas.py`](server/modeling/schemas.py)).

Для чего нужно: единый тип исключает неоднозначность в интерпретации параметров и гарантирует, что UI, API и симулятор понимают распределения одинаково.

`NodeType` задаёт роль вершины графа СМО:

- `service` - узел обслуживания с очередью, каналами и временем обслуживания;
- `generator` - узел-источник заявок, не обслуживает, а маршрутизирует сгенерированный поток дальше;
- `exit` - узел завершения заявки, не имеет исходящих маршрутов.

Где используется:

- в схеме узла `NodeConfig` ([`server/modeling/schemas.py`](server/modeling/schemas.py), [`ui/src/types.ts`](ui/src/types.ts));
- в логике симулятора при обработке `request_arrived` ([`server/modeling/simulator.py`](server/modeling/simulator.py));
- в UI редактора для переключения поведения формы ([`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)).

Для чего нужно: тип узла определяет, какие параметры разрешены/обязательны и как узел обрабатывается в алгоритме событий.

#### Подробно про каждую backend-модель (`server/modeling/schemas.py`)

`DistributionConfig`

- Состав параметров: `distribution_type`, `mean`, `std`, `scale`, `rate`, `shape`, `rate1`, `rate2`, `mix_probability`, `intervals`, `intensity`, `low`, `high`, `value`, `min_value`.
- Что делает: хранит универсальную конфигурацию случайного закона для генератора, обслуживания и перемещения.
- Где используется: `SampleFromDistribution` ([`server/modeling/distributions.py`](server/modeling/distributions.py)), `NodeConfig.service_distribution`, `EdgeConfig.travel_distribution`, `GeneratorConfig.interarrival_distribution`.
- Для чего нужно: единый формат для всех вероятностных параметров модели без дублирования структур.

`RouteConfig`

- Состав параметров: `target_node_id`, `edge_id`, `probability`.
- Что делает: описывает одно исходящее направление из узла и вероятность выбора этого направления.
- Где используется: `NodeConfig.routes`, выбор маршрута в `SelectRoute` ([`server/modeling/simulator.py`](server/modeling/simulator.py)).
- Для чего нужно: моделирует ветвление пассажиропотока и вероятностную маршрутизацию.

`NodeScheduleInterval`

- Состав параметров: `open_time`, `close_time`.
- Что делает: задаёт одно окно доступности узла; валидатор `ValidateWindow` проверяет `close_time > open_time`.
- Где используется: список `NodeConfig.schedule`, расчёт открытости узла (`GetActiveScheduleWindow`) и recheck-события.
- Для чего нужно: поддержка смен/окон работы узлов вместо одной пары `open/close`.

`NodeConfig`

- Состав параметров: `node_id`, `name`, `node_type`, `open_time`, `close_time`, `schedule`, `channels`, `service_distribution`, `routes`.
- Что делает: описывает вершину графа и её операционные правила.
- Где используется: нормализация и валидация в `ValidateSchedule`, runtime-сборка `NodeRuntime`, UI-редактирование узлов.
- Для чего нужно: централизованно описывает поведение каждой точки обслуживания/генерации/выхода.

`EdgeConfig`

- Состав параметров: `edge_id`, `source_node_id`, `target_node_id`, `travel_distribution`.
- Что делает: описывает направленное ребро и задержку перемещения между узлами.
- Где используется: `edge_lookup`, `FindEdge`, `ScheduleRequestByRoute`.
- Для чего нужно: разделяет логику обслуживания в узле и логику перемещения между узлами.

`GeneratorConfig`

- Состав параметров: `target_node_id`, `interarrival_distribution`, `start_time`, `stop_time`.
- Что делает: описывает параметры одного источника заявок.
- Где используется: `SimulationConfig.generator/generators`, инициализация `request_generated` в `RunSimulation`.
- Для чего нужно: позволяет независимо настраивать входной поток для каждого генератора.

`SimulationConfig`

- Состав параметров: `simulation_duration`, `random_seed`, `max_requests`, `generator`, `generators`, `nodes`, `edges`.
- Что делает: хранит полную конфигурацию эксперимента и выполняет строгую валидацию графа (`ValidateGraph`).
- Где используется: главный вход `RunSimulation`, сохранение `model.json`, отправка с фронтенда.
- Для чего нужно: единый контракт «модель + ограничения запуска» между UI, API и симулятором.

`NodePosition`

- Состав параметров: `x`, `y`.
- Что делает: хранит координаты узла на полотне редактора/визуализации.
- Где используется: `SimulationRunRequest.node_positions`, отрисовка и drag/drop в UI.
- Для чего нужно: сохраняет визуальную компоновку модели независимо от вычислительной логики.

`SimulationRunRequest`

- Состав параметров: `model_name`, `config`, `node_positions`.
- Что делает: payload запроса запуска моделирования.
- Где используется: endpoint `/simulation/start` ([`server/api/main.py`](server/api/main.py)), клиент `StartSimulation` ([`ui/src/api/client.ts`](ui/src/api/client.ts)).
- Для чего нужно: атомарно передаёт на backend всю информацию, необходимую для запуска и последующего воспроизведения.

Ключевой код: [`SimulationConfig`](server/modeling/schemas.py), [`ValidateGraph`](server/modeling/schemas.py), [`NodeConfig.ValidateSchedule`](server/modeling/schemas.py).

Пример (из проекта):

```python
class RouteConfig(BaseModel):
    target_node_id: str | None = None
    edge_id: str | None = None
    probability: float = Field(default=1.0, gt=0.0)
```

#### Алгоритм валидации графа (реализован в `ValidateGraph`)

1. Проверяется уникальность `node_id` и `edge_id`.
2. Проверяется, что в графе есть хотя бы один узел типа `generator`.
3. Выполняется синхронизация совместимости `generator` и `generators`:
- если заполнен только `generator`, формируется `generators = [generator]`;
- если заполнен только `generators`, поле `generator` получает первый элемент.
4. Проверяется, что список `generators` не пустой и что:
- `target_node_id` каждого генератора существует в графе;
- `target_node_id` каждого генератора ссылается именно на узел типа `generator`;
- `target_node_id` в `generators` уникальны;
- для каждого узла `generator` есть соответствующая запись в `generators`.
5. Проверяется, что в графе есть хотя бы один узел типа `exit`.
6. Для каждого ребра проверяется существование узла-источника и узла-приёмника.
7. Для каждого не-выходного узла проверяется наличие хотя бы одного маршрута.
8. Для каждого не-выходного узла проверяется сумма вероятностей маршрутов:
- сумма должна быть строго `1.0` (то есть `100%`);
- при отклонении конфигурация отклоняется до запуска симуляции.
9. Для каждого маршрута:
- если `target_node_id = null`, это корректный выход из системы;
- иначе проверяется существование узла назначения;
- проверяется наличие `edge_id`;
- проверяется, что `edge_id` существует;
- проверяется направленное соответствие: `edge.source_node_id == node.node_id` и `edge.target_node_id == route.target_node_id`.

Таким образом, некорректные модели отсекаются до запуска симуляции.

### 3.1.2 Модуль распределений и поддержка законов генерации/обслуживания

Вся работа со случайными законами вынесена отдельно в [`server/modeling/distributions.py`](server/modeling/distributions.py), что полностью соответствует требованиям ТЗ.

Поддерживаются распределения:

- нормальное (`normal`);
- экспоненциальное (`exponential`);
- равномерное (`uniform`);
- детерминированное (`deterministic`);
- пуассоновский поток (`poisson`, через экспоненциальные межприходные интервалы);
- Эрланга (`erlang`);
- гиперэкспоненциальное (`hyperexponential`);
- интервальное (`intervals`);
- по интенсивности (`intensity`).

Разрешённые наборы законов дополнительно фиксируются в схемах:

- для генератора: `poisson`, `exponential`, `deterministic`, `erlang`, `intervals`, `intensity`;
- для обслуживающих узлов: `normal`, `uniform`, `exponential`, `hyperexponential`, `deterministic`, `erlang`.

См. константы `GENERATOR_DISTRIBUTIONS` и `SERVICE_DISTRIBUTIONS` в [`server/modeling/schemas.py`](server/modeling/schemas.py).

Ключевая функция: [`SampleFromDistribution`](server/modeling/distributions.py#L16).  
Защита от некорректных значений (`NaN`, `inf`, отрицательные интервалы) реализована в [`ResolvePositiveValue`](server/modeling/distributions.py#L10).

Пример (экспоненциальное распределение):

```python
if distribution_type == "exponential":
    scale = distribution.scale if distribution.scale is not None else 1.0
    sampled = float(rng.exponential(scale))
    return ResolvePositiveValue(sampled, min_value)
```

Это напрямую используется для генерации межприходных интервалов у генератора, что эквивалентно пуассоновскому входному потоку:

- если интервалы между заявками имеют экспоненциальное распределение `Exp(lambda)`,
- то число заявок за интервал времени имеет распределение Пуассона `Pois(lambdat)`.

В реализации параметр `scale = 1 / lambda`.

### 3.1.3 Ядро дискретно-событийного моделирования

Ядро реализовано в [`RunSimulation`](server/modeling/simulator.py#L202).  
Алгоритм построен на календаре событий (priority queue на `heapq`).

Типы событий:

- `request_generated`
- `request_arrived`
- `service_started`
- `service_completed`
- `request_exited`
- `node_recheck` (внутреннее событие проверки открытия узла)

Назначение каждого типа события:

- `request_generated` - создана новая заявка генератором; после этого планируется `request_arrived` в узел-генератор и следующее событие генерации.
- `request_arrived` - заявка прибыла в вершину; дальше логика зависит от `node_type` (мгновенная маршрутизация, постановка в очередь или немедленный выход).
- `service_started` - заявка взята в обслуживание и заняла один канал узла.
- `service_completed` - обслуживание завершено; канал освобождается, после чего выбирается следующий маршрут.
- `request_exited` - заявка покинула систему и фиксируется как завершённая.
- `node_recheck` - служебное событие, которое повторно пытается запустить обслуживание в момент открытия узла по расписанию.

См. объявления в [`server/modeling/simulator.py`](server/modeling/simulator.py#L14).

#### Структуры runtime-состояния

- `CalendarEvent` - элемент календаря с `event_time` и `sequence` для стабильного порядка;
- `NodeRuntime` - состояние узла: очередь, занятые каналы, интегральные накопители, статистика;
- `RequestRuntime` - состояние заявки в системе.

Подробно по каждой runtime-модели:

`CalendarEvent`

- Состав параметров: `event_time`, `sequence`, `event_type`, `request_id`, `node_id`, `from_node_id`, `to_node_id`, `details`.
- Что делает: представляет единицу календаря событий; сортируется по `event_time` и затем по `sequence`.
- Где используется: очередь `heapq` в `RunSimulation`, планирование генерации/прихода/завершения/выхода.
- Для чего нужно: гарантирует детерминированный порядок обработки событий при совпадении времени.

`RequestRuntime`

- Состав параметров: `request_id`, `created_time`, `exited_time`.
- Что делает: хранит жизненный цикл конкретной заявки.
- Где используется: `request_lookup`, расчёт `average_time_in_system`, учёт завершённых заявок.
- Для чего нужно: позволяет считать сводные метрики по времени пребывания в системе.

`NodeRuntime`

- Состав параметров: `node_id`, `name`, `schedule_windows`, `channels`, `queue`, `queue_arrival_times`, `active_service_start`, `planned_recheck_times`, `busy_channels`, `queue_area`, `busy_area`, `last_queue_time`, `last_busy_time`, `last_queue_value`, `last_busy_value`, `max_queue_value`, `arrivals`, `started`, `completed`, `waiting_times`, `service_times`.
- Что делает: хранит текущее и накопленное состояние узла во время симуляции, включая очереди и интегралы для метрик.
- Где используется: `StartServiceIfPossible`, `AppendEvent`, финальный расчёт `metrics_rows`.
- Для чего нужно: отделяет runtime-динамику от статической конфигурации (`NodeConfig`) и обеспечивает корректный сбор статистики.

См.: [`CalendarEvent`](server/modeling/simulator.py#L22), [`NodeRuntime`](server/modeling/simulator.py#L42), [`RequestRuntime`](server/modeling/simulator.py#L35).

#### Алгоритм обработки событий

Высокоуровневый цикл (реализован в [`while calendar:`](server/modeling/simulator.py#L245)):

1. Извлечь ближайшее событие из календаря.
2. Перейти к его времени (`current_time`).
3. Обработать по типу события.
4. При необходимости добавить новые события в календарь.
5. Завершить при исчерпании календаря или выходе за `simulation_duration`.

Псевдокод:

```text
initialize calendar with request_generated for each configured generator
while calendar not empty:
    event = pop_min_time(calendar)
    if event.time > simulation_duration: break

    switch event.type:
        request_generated -> create request, schedule request_arrived and next generation
        request_arrived -> put to node queue, try start service
        service_completed -> free channel, route request to next node or exit
        request_exited -> finalize request
        node_recheck -> retry start service when node opens
```

В актуальной версии инициализация выполняется по списку `effective_generators`, а интервалы/границы генерации отслеживаются отдельно для каждого генератора (`generator_interval_index_refs`, `generator_stop_time_lookup`).

#### Очередь и запуск обслуживания

Логика обслуживания реализована в [`StartServiceIfPossible`](server/modeling/simulator.py#L131):

- очередь FIFO (`node.queue.pop(0)`) - приоритет по времени прихода;
- запуск до заполнения доступных каналов;
- учёт `open_time/close_time`;
- генерация события `service_completed` с задержкой по распределению обслуживания.

Это обеспечивает многоканальную СМО с расписанием работы узлов.

#### Маршрутизация заявок

После завершения обслуживания маршрут выбирается стохастически с учётом вероятностей через [`SelectRoute`](server/modeling/simulator.py#L89):

```python
total = sum(route.probability for route in routes)
threshold = float(rng.uniform(0.0, total))
...
```

Если `route.target_node_id is None`, заявка переводится в событие выхода из системы (тип `request_exited`) - это реализация узла «Выход из системы».

Если задан целевой узел, то:

- подбирается ребро (`FindEdge`);
- генерируется задержка перемещения;
- планируется `request_arrived` в следующий узел.

См. участок кода: [`server/modeling/simulator.py#L377`](server/modeling/simulator.py#L377).

### 3.1.4 Расчёт метрик

Метрики рассчитываются по завершении обработки календаря в блоке [`metrics_rows`](server/modeling/simulator.py#L459).

Для каждого узла сохраняются:

- `arrivals`, `started`, `completed`;
- `average_queue_length`;
- `max_queue_length`;
- `average_waiting_time`;
- `average_service_time`;
- `utilization`.

Формулы в реализации:

- средняя длина очереди  
  `average_queue_length = queue_area / simulation_duration`
- загрузка узла  
  `utilization = busy_area / (channels * schedule_window)`
- среднее время в системе  
  `average_time_in_system = mean(exited_time - created_time)`
- пропускная способность  
  `throughput = requests_exited / simulation_duration`

См. расчёты в [`server/modeling/simulator.py#L465`](server/modeling/simulator.py#L465), [`#L474`](server/modeling/simulator.py#L474), [`#L492`](server/modeling/simulator.py#L492).

### 3.1.5 Сохранение результатов по прогонам

Сохранение артефактов выполнено в [`SaveRunArtifacts`](server/modeling/storage.py#L32):

- `events.csv` - журнал событий;
- `metrics.csv` - агрегированные метрики по узлам;
- `model.json` - исходная структура модели;
- `summary.json` - сводные показатели прогона.

Для каждого запуска создаётся отдельная директория:

- формируется безопасное имя модели (`SanitizeModelName`);
- добавляется UTC-таймстамп;
- создаётся каталог `server/csv_result/<model_name>_<timestamp>`.

В обновлённой версии добавлены операции обмена прогонами в ZIP:

- экспорт прогона через `BuildRunExportArchive(run_id)` с обязательным набором файлов `events.csv`, `metrics.csv`, `model.json`, `summary.json`;
- импорт прогона через `ImportRunFromZipArchive`, включая:
- чтение CSV/JSON с fallback-кодировками (`utf-8`, `cp1251`);
- нормализацию структуры `model.json` и `summary.json`;
- восстановление `node_positions`;
- автодополнение отсутствующих колонок в таблицах событий и метрик.

Для безопасной адресации каталогов используется `ResolveRunFolder`, предотвращающий выход за пределы `server/csv_result`.

См. [`CreateRunFolder`](server/modeling/storage.py), [`ResolveRunFolder`](server/modeling/storage.py), [`BuildRunExportArchive`](server/modeling/storage.py), [`ImportRunFromZipArchive`](server/modeling/storage.py).

---

## 3.2 Реализация графического модуля

Графический модуль реализован на React + TypeScript (папка `ui/src`) и разделён по страницам:

- редактор модели: [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)
- результаты моделирования: [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- список сохранённых прогонов: [`ui/src/pages/ModelsPage.tsx`](ui/src/pages/ModelsPage.tsx)
- страница входа: [`ui/src/pages/LoginPage.tsx`](ui/src/pages/LoginPage.tsx)

### 3.2.1 Авторизация и защита маршрутов

Проверка авторизации реализована в `App.tsx`:

- если токена нет, пользователь принудительно переходит на `/login`;
- если токен есть, доступна рабочая оболочка приложения.

См. [`ProtectedShell`](ui/src/App.tsx#L23), [`Navigate to /login`](ui/src/App.tsx#L29).

Токен хранится в `localStorage`, автоматически подставляется в заголовок `Authorization: Bearer ...` для всех API-запросов.

См. [`ui/src/api/client.ts#L24`](ui/src/api/client.ts#L24).

### 3.2.2 Визуальный редактор модели без работы с JSON

Пользователь не взаимодействует с JSON напрямую:

- структура модели хранится в состоянии React (`config`, `node_positions`);
- интерфейс представлен формами, селектами и интерактивным полотном;
- сериализация в JSON выполняется только при отправке запроса на backend.

Ключевые места:

- инициализация шаблона: [`BuildBaseTemplate`](ui/src/model/defaultModel.ts#L48)
- состояние редактора: [`EditorPage`](ui/src/pages/EditorPage.tsx#L481)
- отправка на сервер: [`HandleStartModeling`](ui/src/pages/EditorPage.tsx#L900)

### 3.2.3 Масштабирование, перемещение и полноэкранная рабочая область

В редакторе реализованы:

- zoom (кнопки + слайдер, без масштабирования колёсиком): [`HandleSetZoom`](ui/src/pages/EditorPage.tsx)
- pan всей схемы (перетаскивание пустой области): [`HandleCanvasMouseDown`](ui/src/pages/EditorPage.tsx#L788)
- drag отдельных узлов: [`HandleNodeMouseDown`](ui/src/pages/EditorPage.tsx#L807), [`mousemove`](ui/src/pages/EditorPage.tsx#L841)

UI оформлен как крупная рабочая зона:

- полноширинный контейнер `main` без ограничений по `max-width`: [`ui/src/styles.css#L59`](ui/src/styles.css#L59)
- большая область схемы: [`canvas-viewport`](ui/src/styles.css#L505)
- увеличенная сетка и мировые размеры: [`world_width/world_height`](ui/src/pages/EditorPage.tsx#L68)

### 3.2.4 Закреплённые кнопки моделирования

Основные действия вынесены наверх и закреплены:

- `Моделирование`
- `Результаты моделирования`

См. блок [`editor-sticky-actions`](ui/src/pages/EditorPage.tsx#L975), стили `position: sticky` - [`ui/src/styles.css#L439`](ui/src/styles.css#L439).

Это исключает необходимость прокрутки к кнопкам при больших моделях.

### 3.2.5 Редактирование параметров: выпадающие списки и ручной ввод

В актуальной версии интерфейса параметры редактируются по типам данных:

- текстовый ввод: название модели, название узла, название ребра;
- числовой ввод: длительность моделирования, `seed`, число каналов, время открытия/закрытия, вероятности маршрутов;
- выпадающие списки: тип узла, целевая вершина маршрута, параметры с фиксированным набором вариантов.

Ключевое изменение по вероятностям маршрутов:

- значение `0` является допустимым;
- при очистке поля или нечисловом вводе значение приводится к `0`;
- принудительная подстановка `0.0001` исключена.

См. реализацию: [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx), функции `ParseProbabilityPercent`, `HandleRouteProbabilityChange`, блок нормализации маршрутов в `NormalizeConfigAndLayout`.

### 3.2.6 Реализация «Генератора заявок» и «Выхода из системы»

Визуально и логически в редактор добавлены специальные роли:

- «Генератор заявок» - выделяется бейджем на каждом узле типа `generator`.
- «Выход из системы» - специальный пункт маршрута `target_node_id = null`.

В текущей версии поддерживаются множественные генераторы:

- настройки генерации (`start_time`, `stop_time`, `interarrival_distribution`) хранятся в `config.generators` отдельно для каждого узла-генератора;
- при нормализации модели `config.generators` синхронизируется со списком узлов типа `generator`;
- поле `config.generator` сохраняется как совместимое представление первого генератора;
- запрещено удалить или «разгенераторить» последний узел типа `generator`.

Для генератора в UI доступен выбор законов:

- пуассоновский;
- экспоненциальный;
- детерминированный;
- Эрланга;
- интервальный;
- по интенсивности.

Для обслуживающих узлов доступны:

- нормальный;
- равномерный;
- экспоненциальный;
- гиперэкспоненциальный;
- детерминированный;
- Эрланга.

Ключевые места:

- бейдж генератора: [`ui/src/pages/EditorPage.tsx#L1136`](ui/src/pages/EditorPage.tsx#L1136)
- редактирование параметров выбранного генератора: `UpdateSelectedGeneratorConfig` в [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)
- синхронизация `generators` в `NormalizeConfigAndLayout`: [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)
- опция «Выход из системы» в маршруте: [`ui/src/pages/EditorPage.tsx#L1448`](ui/src/pages/EditorPage.tsx#L1448)

### 3.2.7 Табличный редактор рёбер и контроль вероятностей

Редактирование рёбер в узле переведено в единый табличный формат, что существенно повышает удобство работы с разветвлёнными маршрутами.

Структура таблицы:

- столбец «Название ребра»;
- столбец «Куда идет»;
- столбец «Вероятность, %»;
- два action-столбца справа (иконки «ручка» и «корзина») без текстовых заголовков.

Под таблицей реализована строка контроля суммы вероятностей:

- вычисляется суммарная вероятность перехода по всем исходящим маршрутам узла;
- при отклонении от `100%` выводится предупреждение «Суммарная вероятность перехода должна быть 100%»;
- предупреждение исчезает автоматически, как только сумма снова становится `100%`.

При запуске моделирования выполняется жёсткая проверка суммы вероятностей для каждого узла:

- если сумма не равна `100%`, запуск блокируется;
- пользователю выводится ошибка с указанием конкретной вершины, в которой нарушено условие.

См.:

- таблица маршрутов и action-кнопки: [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)
- проверка суммы вероятностей: `ValidateProbabilitySums` в [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx)
- стили таблицы и action-колонок: [`ui/src/styles.css`](ui/src/styles.css)

### 3.2.8 Выравнивание формы параметров и визуальная иерархия

Правая панель параметров приведена к единому двухколоночному шаблону:

- слева - название параметра;
- справа - поле установки значения.

Для повышения читаемости реализованы дополнительные правила верстки:

- все поля ввода выровнены строго по одной вертикали;
- добавлены верхние и нижние отступы у `input/select/textarea`, чтобы исключить «слипание» полей;
- в таблице рёбер action-кнопки осветлены и уменьшены до компактного размера иконок.

См. стили формы и таблицы: [`ui/src/styles.css`](ui/src/styles.css).

### 3.2.9 Список сохранённых моделей в формате карточек

Страница списка прогонов (`ModelsPage`) приведена к карточному формату:

- в карточке отображаются название модели;
- ниже - дата и время запуска в формате `дд.мм.гг чч.мм`;
- ниже - «Количество заявок в системе» и «Количество событий в системе»;
- справа - действия «Просмотреть», «Взять за основу», «Выгрузить ZIP», «Удалить».

Дополнительно реализована загрузка прогонов из ZIP через кнопку «Загрузить из ZIP» в верхней панели страницы.

«Взять за основу» открывает редактор с параметром `from_run`, после чего модель запуска загружается и используется как шаблон.

При выгрузке имя файла берётся из `Content-Disposition` (включая `filename*` для UTF-8), при импорте выполняется валидация расширения `.zip` и обработка серверных ошибок через `detail`.

См. [`ui/src/pages/ModelsPage.tsx`](ui/src/pages/ModelsPage.tsx).

### 3.2.10 Закрываемые сообщения об ошибках

Для всех основных страниц используется единый компонент сообщений об ошибках с кнопкой закрытия:

- сообщение выводится в `DismissibleError`;
- пользователь может скрыть его кнопкой `x`;
- состояние синхронизировано с локальным `on_dismiss`.

См. [`ui/src/components/DismissibleError.tsx`](ui/src/components/DismissibleError.tsx) и стили `.error-box-close` в [`ui/src/styles.css`](ui/src/styles.css).

### 3.2.11 Подробно про frontend/API типы и модели данных

Основной клиентский контракт расположен в [`ui/src/types.ts`](ui/src/types.ts). Ниже приведено назначение каждой структуры.

`DistributionType` (frontend)

- Состав: `"normal" | "exponential" | "uniform" | "deterministic" | "poisson" | "erlang" | "hyperexponential" | "intervals" | "intensity"`.
- Что делает: типизирует допустимые значения поля `distribution_type` в интерфейсе.
- Где используется: селекты распределений в `EditorPage`, нормализация `NormalizeDistributionConfig`.
- Для чего нужно: статически предотвращает выбор несуществующего закона на этапе разработки UI.

`NodeType` (frontend)

- Состав: `"service" | "generator" | "exit"`.
- Что делает: определяет UI-сценарии формы узла и доступные поля.
- Где используется: `CreateDefaultNode`, `HandleSelectedNodeTypeChange`, условная отрисовка блоков параметров.
- Для чего нужно: синхронизирует логику экрана с backend-ограничениями по ролям узла.

`DistributionConfig`, `RouteConfig`, `NodeScheduleInterval`, `NodeConfig`, `EdgeConfig`, `GeneratorConfig`, `NodePosition`, `SimulationConfig`, `SimulationRunRequest`

- Состав: frontend-интерфейсы 1:1 повторяют server-схемы с теми же именами полей.
- Что делает: задаёт строгую форму объекта модели в React-состоянии.
- Где используется: `BuildBaseTemplate`, `EditorPage`, отправка в `StartSimulation`.
- Для чего нужно: исключает расхождение формата данных между клиентом и сервером.

`StartTaskResponse`

- Состав: `task_id`, `status`.
- Что делает: возвращает идентификатор фоновой задачи после запуска.
- Где используется: ответ `/simulation/start`, polling-цикл в `EditorPage`.
- Для чего нужно: связывает действие «Запустить» с дальнейшим отслеживанием статуса.

`TaskStatusResponse`

- Состав: `task_id`, `status`, `model_name`, `created_at`, `updated_at`, `error`, `run_id`, `summary`.
- Что делает: представляет текущее состояние фоновой задачи (`queued`, `running`, `completed`, `failed`).
- Где используется: `GetSimulationStatus`, панель статуса и обработка завершения/ошибки в `EditorPage`.
- Для чего нужно: даёт прозрачный контроль асинхронного расчёта без блокировки UI.

`SavedRun`

- Состав: `run_id`, `model_name`, `created_at`, `summary`.
- Что делает: краткая карточка сохранённого прогона.
- Где используется: список прогонов в `ModelsPage`.
- Для чего нужно: быстрый просмотр и выбор прогона без полной загрузки `events/metrics`.

`ImportRunResponse`

- Состав: `status`, `run_id`, `model_name`, `summary`, `files`.
- Что делает: подтверждает успешный импорт ZIP-архива и возвращает данные созданного прогона.
- Где используется: `ImportRunZip`, уведомления после импорта в `ModelsPage`.
- Для чего нужно: позволяет сразу перейти к импортированному сценарию.

`RunData`

- Состав: `run_id`, `model`, `summary`, `events`, `metrics`.
- Что делает: полная структура сохранённого прогона.
- Где используется: `GetSimulationResult`, `GetRunById`, `ResultsPage` (анимация + графики + таблицы).
- Для чего нужно: единый объект для детального анализа, воспроизведения и сравнения результатов.

Дополнительно в API-сервере определены pydantic-модели авторизации и статуса:

- `LoginRequest` (`username`, `password`) и `TokenResponse` (`access_token`, `token_type`, `expires_at`) в [`server/api/auth.py`](server/api/auth.py);
- `StartTaskResponse` и `TaskStatusResponse` в [`server/api/main.py`](server/api/main.py), которые соответствуют frontend-интерфейсам.

---

## 3.3 Построение модели аэропорта

### 3.3.1 Представление аэропорта в виде графа СМО

Аэропорт представляется ориентированным графом:

- вершины (`NodeConfig`) - точки обслуживания пассажиров;
- рёбра (`EdgeConfig`) - переходы между этапами;
- генераторы (`GeneratorConfig`) - один или несколько источников входящего потока;
- выход из системы - маршрут с `target_node_id = null`.

Типы структур: [`ui/src/types.ts`](ui/src/types.ts), серверные аналоги - [`server/modeling/schemas.py`](server/modeling/schemas.py).

### 3.3.2 Логика соответствия реальным процессам аэропорта

При построении модели каждый этап пассажирского потока отображается отдельным узлом. Пример набора узлов:

1. «Вход в терминал / первичный контроль»
2. «Регистрация»
3. «Досмотр безопасности»
4. «Паспортный контроль»
5. «Гейт посадки»

Далее задаются альтернативные маршруты (например, часть пассажиров уходит на международный контроль, часть - на внутренний) через `routes` с вероятностями.

### 3.3.3 Пример конфигурации аэропортовой модели

Ниже показан фрагмент конфигурации (структура соответствует типам проекта и передаётся через API):

```json
{
  "simulation_duration": 180,
  "random_seed": 42,
  "max_requests": 3000,
  "generators": [
    {
      "target_node_id": "node_entry",
      "start_time": 0,
      "stop_time": 170,
      "interarrival_distribution": {
        "distribution_type": "exponential",
        "scale": 0.8,
        "min_value": 0.01
      }
    }
  ]
}
```

При `distribution_type = "exponential"` генератор формирует пуассоновский входной поток.

### 3.3.4 Алгоритм настройки модели аэропорта в редакторе

1. В «Общих настройках» выбрать длительность моделирования, seed и лимит заявок.
2. Добавить узлы всех этапов обслуживания пассажиров.
3. Для каждого узла задать:
- число каналов;
- время открытия/закрытия;
- распределение времени обслуживания.
4. Создать рёбра между этапами пассажирского пути.
5. Для каждого узла задать маршруты и вероятности переходов.
6. Задать генераторы:
- один или несколько узлов-входов;
- интервалы генерации;
- окно работы генератора.
7. Добавить маршруты выхода из системы для финальных узлов.

Код интерфейса для этих операций: [`ui/src/pages/EditorPage.tsx`](ui/src/pages/EditorPage.tsx).

---

## 3.4 Проведение моделирования

### 3.4.1 Запуск и асинхронная обработка

Пайплайн запуска:

1. Frontend отправляет `SimulationRunRequest` (`model_name`, `config`, `node_positions`) на `/simulation/start`.
2. Backend создаёт задачу и возвращает `task_id`.
3. Моделирование выполняется асинхронно в фоне.
4. Frontend опрашивает `/simulation/status/{task_id}`.
5. После завершения данные доступны по `/models/{run_id}` или `/simulation/result/{task_id}`.
6. Сохранённый прогон может быть выгружен через `/models/{run_id}/export` и импортирован обратно через `/models/import`.

Ссылки:

- запуск/статус/result API: [`server/api/main.py`](server/api/main.py)
- фоновая задача: [`StartSimulationTask`](server/api/tasks.py), [`ExecuteSimulationTask`](server/api/tasks.py)
- polling на клиенте: [`ui/src/pages/EditorPage.tsx#L869`](ui/src/pages/EditorPage.tsx#L869)

### 3.4.2 Почему фронтенд не блокируется при расчёте

Симуляция запускается в отдельном потоке через `asyncio.to_thread`:

```python
simulation_output = await asyncio.to_thread(RunSimulation, config)
```

Это позволяет FastAPI обрабатывать другие запросы, а пользователь продолжает работу в интерфейсе.

См. [`server/api/tasks.py#L43`](server/api/tasks.py#L43).

### 3.4.3 Пример фактического прогона

В проекте сохранён прогон:

- `server/csv_result/Базовая_линия_20260422_105448/summary.json`
- `server/csv_result/Базовая_линия_20260422_105448/events.csv`
- `server/csv_result/Базовая_линия_20260422_105448/metrics.csv`

Итоги прогона (из `summary.json`):

- `requests_created = 79`
- `requests_exited = 53`
- `requests_in_system = 26`
- `events_count = 534`

Это демонстрирует полный цикл: генерация -> прохождение узлов -> частичный выход за заданный горизонт моделирования.

### 3.4.4 Воспроизведение моделирования на вкладке результатов

На странице результатов реализован полноценный проигрыватель:

- старт;
- остановка;
- шаг вперёд;
- шаг назад;
- слайдер позиции по событию;
- регулятор скорости (событий/сек);
- масштабирование схемы кнопками и слайдером;
- перемещение всей схемы зажатием левой кнопки мыши;
- перетаскивание отдельных узлов прямо во время анализа результата.

См. блок управления: [`ui/src/pages/ResultsPage.tsx#L648`](ui/src/pages/ResultsPage.tsx#L648).

### 3.4.5 Экспорт и импорт прогонов

Для обмена результатами между окружениями реализован двусторонний сценарий:

1. Пользователь выбирает сохранённый прогон в `ModelsPage`.
2. Нажатием «Выгрузить ZIP» получает архив с `events.csv`, `metrics.csv`, `model.json`, `summary.json`.
3. В другом окружении нажимает «Загрузить из ZIP» и выбирает архив.
4. Backend валидирует архив и создаёт новый `run_id` с нормализованными артефактами.

См. API: [`server/api/main.py`](server/api/main.py), storage-слой: [`server/modeling/storage.py`](server/modeling/storage.py), клиент: [`ui/src/api/client.ts`](ui/src/api/client.ts), UI: [`ui/src/pages/ModelsPage.tsx`](ui/src/pages/ModelsPage.tsx).

---

## 3.5 Анализ результатов моделирования

### 3.5.1 Визуальная анимация процесса

Во вкладке результатов отображаются:

- граф узлов и рёбер;
- движение каждой заявки между узлами;
- текущая очередь у каждого узла;
- количество заявок в обработке;
- общее количество заявок в узле.

Принципы визуального состояния узла:

- закрытый узел отрисовывается полупрозрачным;
- открытый узел отображается в обычном режиме;
- заявки показываются оранжевыми маркерами (`request-dot`);
- очередь показывается отдельной полосой маркеров (`queue-dot`).

Особенности отображения типов узлов:

- для `generator` и `exit` скрываются сервисные показатели (`Каналы`, `Обрабатываются`, `Очередь`);
- для `service` дополнительно показываются `Каналы`, `Всего в узле`, `Обрабатываются`, `Очередь`.

Ключевая логика:

- сбор моментального снимка по событиям: `BuildSnapshot` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- выделение движущихся заявок: `active_movements` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- отрисовка маркеров движения: `moving_tokens` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- визуализация очереди: вычисление `queue_by_node` и отрисовка `result-queue-strip` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)

### 3.5.2 Графики и навигация по вершинам

Компоновка страницы построена по схеме `2/3 + 1/3`:

- в левой колонке: визуализация модели, под ней общие графики и таблица общих метрик;
- в правой колонке: выбор вершины, параметры вершины, графики по выбранной вершине и её метрики.

Реализованы общие графики:

- общий график загрузки узлов;
- минимальная очередь по узлам;
- средняя очередь по узлам;
- максимальная очередь по узлам;
- время обработки заявок по узлам.

Для выбранной вершины реализованы:

- график размера очереди по времени;
- график загруженности по времени;
- отдельный блок метрик выбранной вершины;
- навигация по вершинам `предыдущая / select / следующая`.

См.:

- `global_chart_data` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- `selected_node_queue_chart_data` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- `selected_node_utilization_chart_data` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)
- блок `node-navigation` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx)

Размеры графиков ограничены шириной своих колонок (`width: 100%`, `max-width: 100%`), чтобы визуализации и таблицы не выходили за экран.

Стили: [`ui/src/styles.css#L188`](ui/src/styles.css#L188), [`#L325`](ui/src/styles.css#L325).

### 3.5.3 Удаление таблицы событий

Таблица событий пользователю не отображается, основной анализ вынесен в анимацию + графики + метрики по узлам.  
На странице оставлена только таблица агрегированных узловых метрик (`metrics`) как итоговая сводка.

См. итоговый блок: [`ui/src/pages/ResultsPage.tsx#L886`](ui/src/pages/ResultsPage.tsx#L886).

### 3.5.4 Локализация и форматирование метрик

Для метрик реализовано единообразное отображение:

- `task_id` исключён из summary и таблиц метрик;
- целочисленные значения выводятся без дробной части;
- дробные значения округляются до `3` знаков;
- дата создания (`created_at`) выводится в две строки: сверху `чч:мм`, снизу `дд.мм.гггг`;
- ключи метрик преобразуются в русские подписи без технических `_`.

См. функции `FormatMetricDisplayValue`, `GetMetricLabel`, `FormatCreatedAt` в [`ui/src/pages/ResultsPage.tsx`](ui/src/pages/ResultsPage.tsx).

### 3.5.5 Пример интерпретации метрик из проекта

По сохранённому прогону:

- узел `node_1` («Прием заявок»): `max_queue_length = 4`, `utilization ~ 0.56`;
- узел `node_2` («Проверка»): `max_queue_length = 30`, `average_queue_length ~ 19.47`, `utilization ~ 0.97`.

Вывод: второй узел является узким местом и формирует устойчивое накопление очереди.

Источник данных: `server/csv_result/Базовая_линия_20260422_105448/metrics.csv`.

---

## 3.6 Рекомендации по оптимизации пассажиропотока

На основании реализованных метрик и механики модели оптимизация предлагается как итеративный сценарный анализ.

### 3.6.1 Методика оптимизации

1. Зафиксировать базовый сценарий (seed, длительность, структура графа).
2. Выбрать целевые KPI:
- средняя длина очереди;
- максимум очереди;
- среднее время ожидания;
- загрузка каналов;
- пропускная способность.
3. Изменить один класс параметров.
4. Выполнить серию прогонов.
5. Сравнить результат по сохранённым `summary.json` и `metrics.csv`.
6. Зафиксировать изменение как улучшение только при устойчивом эффекте.

### 3.6.2 Практические рычаги оптимизации в текущей системе

1. Увеличение числа каналов на перегруженных узлах  
Пример: если `utilization > 0.9` и растёт очередь, увеличить `channels` (редактор узла, [`ui/src/pages/EditorPage.tsx#L1349`](ui/src/pages/EditorPage.tsx#L1349)).

2. Перераспределение вероятностей маршрутов  
Снижение нагрузки на узкое место через изменение `route.probability` (см. [`ui/src/pages/EditorPage.tsx#L1460`](ui/src/pages/EditorPage.tsx#L1460), выбор в симуляторе - [`SelectRoute`](server/modeling/simulator.py#L89)).

3. Оптимизация времени обслуживания  
Изменение параметров закона обслуживания (`mean`, `std`) для операций контроля/досмотра (см. [`DistributionEditor`](ui/src/pages/EditorPage.tsx#L326)).

4. Управление входным потоком  
Через параметры генератора (`scale` экспоненциального закона): меньше `scale` -> выше интенсивность входа (см. [`CreateInterarrivalDistribution`](ui/src/pages/EditorPage.tsx#L95)).

5. Снижение времени перемещения между узлами  
Подстройка `travel_distribution` на рёбрах (см. [`ui/src/pages/EditorPage.tsx#L1618`](ui/src/pages/EditorPage.tsx#L1618)).

### 3.6.3 Пример стратегии для обнаруженного узкого места

Для узла `node_2` с высокой загрузкой:

1. Увеличить каналы с `1` до `2`.
2. Выполнить прогон.
3. Сравнить:
- `average_queue_length` узла 2;
- `average_waiting_time` узла 2;
- `throughput` по всей системе.
4. Если улучшение недостаточно - дополнительно уменьшить `mean` обслуживания на узле 2 или снизить входную интенсивность генератора.

---

## 3.7 Сравнение продукта с аналогами

### 3.7.1 Критерии сравнения

Для оценки использованы практические критерии:

1. Порог входа для пользователя.
2. Прозрачность модели и воспроизводимость.
3. Гибкость настройки СМО.
4. Наличие анимации событий.
5. Возможность быстрой итерации сценариев.
6. Стоимость внедрения и локального запуска.

### 3.7.2 Позиционирование реализованного решения

По отношению к универсальным промышленным пакетам моделирования (AnyLogic, Arena, Simul8 и др.) разработанный продукт:

- проще в освоении для учебных и прикладных задач СМО;
- ориентирован на графовую модель обслуживания и понятный UX без явного редактирования JSON;
- даёт воспроизводимые артефакты каждого прогона (`events.csv`, `metrics.csv`, `model.json`, `summary.json`);
- поддерживает перенос прогонов между установками через экспорт/импорт ZIP;
- реализует встроенную визуализацию пошагового прохождения заявок, очередей и загрузки узлов;
- легко развертывается локально (React + FastAPI, без тяжёлой desktop-инфраструктуры).

### 3.7.3 Ограничения текущей версии и направления развития

По сравнению с крупными коммерческими платформами, текущая реализация пока не включает:

- оптимизационные решатели «из коробки»;
- готовые библиотеки отраслевых шаблонов;
- многоуровневые отчёты и расширенную статистическую верификацию.

Тем не менее архитектура проекта уже подготовлена к расширению:

- модульная backend-логика (`schemas`, `distributions`, `simulator`, `storage`);
- изолированный API-слой;
- масштабируемый фронтенд с отдельными страницами редактора и аналитики.

---

## Вывод по главе

В ходе реализации создан цельный программный комплекс для дискретно-событийного моделирования:

- реализовано серверное ядро с календарём событий, маршрутами, очередями и метриками;
- реализован визуальный редактор модели с интерактивной графовой схемой, масштабированием, сохранением `node_positions` и удобной настройкой параметров;
- реализована поддержка множественных генераторов заявок с отдельными настройками по каждому узлу-генератору;
- реализован табличный редактор рёбер с автоматическим контролем суммы вероятностей и валидацией запуска по условию `100%`;
- добавлены механизмы авторизации и защищённого доступа;
- реализована наглядная вкладка результатов с анимацией движения заявок, отображением очередей, блоком параметров выбранной вершины и навигацией по графикам;
- реализована карточная страница сохранённых моделей с действиями «Просмотреть / Взять за основу / Выгрузить ZIP / Удалить» и верхней командой «Загрузить из ZIP»;
- реализовано русифицированное и типобезопасное форматирование метрик с корректным округлением;
- обеспечено сохранение каждого прогона в отдельный набор файлов для анализа, повторного использования и переноса между окружениями.

Таким образом, требования к реализации главы 3 выполнены: программный продукт поддерживает построение и исследование моделей пассажиропотока аэропорта, а также создаёт основу для последующей оптимизации системы обслуживания.
