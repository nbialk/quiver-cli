# Prisma Schema Reference

Source: `prisma/schema.prisma`

## Workout

| Field         | Type           | Optional | Notes             |
| ------------- | -------------- | -------- | ----------------- |
| id            | String         |          | @id, cuid         |
| userId        | String         |          |                   |
| name          | String         |          | Workout type name |
| start         | DateTime       |          |                   |
| end           | DateTime       |          |                   |
| distanceKm    | Float          |          |                   |
| durationMin   | Float          |          |                   |
| avgHeartRate  | Float          | yes      |                   |
| maxHeartRate  | Float          | yes      |                   |
| minHeartRate  | Float          | yes      |                   |
| avgPaceMinKm  | Float          | yes      |                   |
| totalEnergyKj | Float          | yes      |                   |
| temperatureC  | Float          | yes      |                   |
| elevationUp   | Float          | yes      |                   |
| elevationDown | Float          | yes      |                   |
| createdAt     | DateTime       |          | @default(now())   |
| splits        | WorkoutSplit[] |          | Relation (1:many) |

- **Unique:** `[userId, name, start]`
- **Index:** `[userId]`

## WorkoutSplit

| Field        | Type   | Optional | Notes                  |
| ------------ | ------ | -------- | ---------------------- |
| id           | String |          | @id, cuid              |
| workoutId    | String |          | FK -> Workout.id       |
| km           | Int    |          | Split kilometer number |
| durationSec  | Float  |          |                        |
| avgHeartRate | Float  | yes      |                        |

- **Unique:** `[workoutId, km]`
- **Relation:** `workout` -> Workout (onDelete: Cascade)

## SleepRecord

| Field      | Type     | Optional | Notes           |
| ---------- | -------- | -------- | --------------- |
| id         | String   |          | @id, cuid       |
| userId     | String   |          |                 |
| date       | DateTime |          | Night date      |
| sleepStart | DateTime |          |                 |
| sleepEnd   | DateTime |          |                 |
| totalSleep | Float    |          | Hours           |
| deep       | Float    |          | Hours           |
| rem        | Float    |          | Hours           |
| core       | Float    |          | Hours           |
| awake      | Float    |          | Hours           |
| source     | String   | yes      |                 |
| createdAt  | DateTime |          | @default(now()) |

- **Unique:** `[userId, date]`
- **Index:** `[userId, date]`

## HealthMetric

| Field     | Type     | Optional | Notes           |
| --------- | -------- | -------- | --------------- |
| id        | String   |          | @id, cuid       |
| userId    | String   |          |                 |
| name      | String   |          | Metric name     |
| date      | DateTime |          |                 |
| qty       | Float    |          | Metric value    |
| units     | String   |          |                 |
| createdAt | DateTime |          | @default(now()) |

- **Unique:** `[userId, name, date]`
- **Index:** `[userId, name, date]`

### Known metric names

- `resting_heart_rate` (bpm)
- `heart_rate_variability` (ms)
- `vo2_max` (mL/kg/min)
- `step_count` (count)
- `walking_running_distance` (km)
- `active_energy_burned` (kJ)
- `basal_energy_burned` (kJ)
- `body_mass` (kg)
- `body_fat_percentage` (%)

## HealthWebhookLog

| Field     | Type     | Optional | Notes           |
| --------- | -------- | -------- | --------------- |
| id        | String   |          | @id, cuid       |
| requestId | String   |          |                 |
| event     | String   |          |                 |
| payload   | Json     |          |                 |
| createdAt | DateTime |          | @default(now()) |

- **Index:** `[requestId]`, `[createdAt]`

## TelegramWebhookLog

| Field     | Type     | Optional | Notes           |
| --------- | -------- | -------- | --------------- |
| id        | String   |          | @id, cuid       |
| requestId | String   |          |                 |
| event     | String   |          |                 |
| payload   | Json     |          |                 |
| createdAt | DateTime |          | @default(now()) |

- **Index:** `[requestId]`, `[createdAt]`

## Receipt

| Field         | Type          | Optional | Notes             |
| ------------- | ------------- | -------- | ----------------- |
| id            | String        |          | @id, cuid         |
| userId        | String        |          |                   |
| storeName     | String        |          |                   |
| storeAddress  | String        | yes      |                   |
| date          | DateTime      |          |                   |
| totalAmount   | Float         |          |                   |
| paymentMethod | String        | yes      |                   |
| createdAt     | DateTime      |          | @default(now())   |
| items         | ReceiptItem[] |          | Relation (1:many) |

- **Index:** `[userId, date]`

## ReceiptItem

| Field       | Type   | Optional | Notes                 |
| ----------- | ------ | -------- | --------------------- |
| id          | String |          | @id, cuid             |
| receiptId   | String |          | FK -> Receipt.id      |
| name        | String |          | Original scanned name |
| displayName | String | yes      | Cleaned display name  |
| price       | Float  |          |                       |
| quantity    | Float  | yes      |                       |
| unit        | String | yes      |                       |
| taxClass    | String | yes      |                       |
| category    | String | yes      |                       |

- **Index:** `[receiptId]`
- **Relation:** `receipt` -> Receipt (onDelete: Cascade)
