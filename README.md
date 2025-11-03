# Notification PoC using pgoutput in PostgreSQL

## Specification

- CDC (Change Data Capture) 기반 notification PoC
- PostgreSQL의 논리 복제(logical replication) 기능 활용
- `pgoutput` 출력 플러그인 사용
- 데이터 변경 이벤트를 실시간으로 캡처하여 NotificationService로 전송
  - **PostgreSQL pgoutput → pg-logical-replication → NotificationService**
- [pg-logical-replication](https://github.com/kibae/pg-logical-replication) 라이브러리 사용
  - Node.js 환경에서 PostgreSQL 논리 복제 스트림 처리
  - **Manual acknowledge 전략**: 이벤트 처리 성공 시에만 LSN 확인 (At-Least-Once 보장)
  - **자동 재연결**: 연결 끊김 시 5초 간격으로 무한 재시도
  - **Blue-Green 배포 지원**: Replication slot 경합 감지 및 대기
- PoC 목표
  - PostgreSQL 데이터 변경 이벤트를 실시간으로 감지
  - 감지된 이벤트를 NotificationService로 전송하여 알림 처리
  - PoC의 NotificationService는 message를 출력하고, 지정된 log table에 기록
  - 프로덕션 환경 안정성: 다중 인스턴스 배포, 장애 복구, 이벤트 누락 방지

## Quick Start

### 1. Start PostgreSQL

```bash
docker-compose up -d
```

Wait for initialization:

```bash
docker-compose logs -f postgres
# Wait until you see "database system is ready to accept connections"
# Press Ctrl+C to exit logs
```

### 2. Create .env file

```bash
cp .env.example .env
```

You can customize the `DATABASE_URL` in `.env` if needed:

```bash
DATABASE_URL=postgresql://test:testpw@localhost:5432/pubdb
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Build TypeScript

```bash
npm run build
```

### 5. Start Notification Service

```bash
npm run dev
# Or: npm start (for compiled version)
```

Expected output:

```
🚀 Starting Notification Service...
✅ Connected to PostgreSQL for logging
✅ Subscribed to replication slot: demo_slot
👂 Listening for changes on demo table...
```

### 6. Generate Test Data (in another terminal)

```bash
npm run generate
```

Expected output:

```
✅ Connected to PostgreSQL
🔄 Generating random data every 2000ms...

✅ INSERT row id=1
✅ INSERT row id=2
✅ UPDATE row id=1
✅ DELETE row id=2
...
```

### 7. Watch Notifications

In the Notification Service terminal, you should see:

```
[2025-11-02T10:30:00.123Z] [INSERT] demo id=1
  New data: {
    "id": 1,
    "name": "Alice Smith",
    "small_num": 42,
    "is_active": true,
    ...
  }

[2025-11-02T10:30:02.456Z] [UPDATE] demo id=1
  Old data: {...}
  New data: {...}

[2025-11-02T10:30:04.789Z] [DELETE] demo id=1
  Deleted data: {...}
```

### 8. Check Notification Log

```bash
docker exec pgoutput-poc psql -U test -d pubdb -c \
  "SELECT operation, table_name, row_id, timestamp FROM notification_log ORDER BY timestamp DESC LIMIT 10;"
```

## Project Structure

```
.
├── docker-compose.yml          # PostgreSQL setup
├── init-db/
│   ├── 01-setup.sql           # Demo table schema
│   ├── 02-publication.sql     # Publication & replication slot
│   └── 03-notification-log.sql # Notification log table
├── src/
│   ├── types.ts               # TypeScript type definitions
│   ├── notification-service.ts # Main CDC→Notification service
│   └── data-generator.ts       # Random data generator
├── package.json
├── tsconfig.json
└── README.md
```

## Demo Table Schema

The `demo` table includes various PostgreSQL data types:

- **Numeric**: SMALLINT, BIGINT, DECIMAL, REAL
- **String**: TEXT, VARCHAR, CHAR
- **Date/Time**: TIMESTAMP, DATE, TIME
- **Boolean**: BOOLEAN
- **JSON**: JSONB
- **Array**: TEXT[]
- **UUID**: UUID
- **Binary**: BYTEA

See `init-db/01-setup.sql` for full schema.

## How It Works

```
Data Generator → PostgreSQL demo table
                     ↓ WAL (Write-Ahead Log)
                pgoutput plugin
                     ↓ Replication Stream
             NotificationService
                  ↓         ↓
       notification_log   Console Output
```

1. **Data Generator** inserts/updates/deletes random data
2. **PostgreSQL** writes changes to WAL
3. **pgoutput** plugin decodes WAL into logical changes
4. **pg-logical-replication** receives replication stream
5. **NotificationService** processes events and:
   - Prints to console
   - Logs to `notification_log` table

## Manual Acknowledge Strategy

### What is Manual Acknowledge?

PostgreSQL logical replication tracks progress using **LSN (Log Sequence Number)**. The `confirmed_flush_lsn` in `pg_replication_slots` indicates the last acknowledged position.

**Auto Acknowledge (기존 방식)**:

```typescript
acknowledge: {
  auto: true,
  timeoutSeconds: 10  // LSN을 10초마다 자동 업데이트
}
```

- ❌ 처리 성공/실패와 관계없이 주기적으로 LSN 업데이트
- ❌ 이벤트 처리 실패 시에도 LSN이 진행되어 **이벤트 유실 가능**
- ❌ 재시작 시 실패한 이벤트를 재처리할 수 없음

**Manual Acknowledge (현재 방식)**:

```typescript
acknowledge: {
  auto: false,
  timeoutSeconds: 0  // Manual mode에서는 사용 안 됨
}

// Data handler
this.replicationService.on('data', async (lsn: string, log: any) => {
  try {
    await this.handleReplicationEvent(log);
    // ✅ 처리 성공 시에만 acknowledge
    await this.replicationService.acknowledge(lsn);
  } catch (error) {
    // ❌ 실패 시 acknowledge 안 함 -> 재시작 시 재처리
    console.error(`Failed to process event at LSN ${lsn}:`, error);
  }
});
```

- ✅ 처리 성공 시에만 명시적으로 LSN 업데이트
- ✅ 실패 시 acknowledge 안 함 → `confirmed_flush_lsn`이 진행되지 않음
- ✅ 재시작 시 마지막 성공한 LSN부터 재처리 (**At-Least-Once 보장**)

### Event Processing Flow

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Event 수신 (LSN: 0/1A2B3C4)                               │
│    ↓                                                         │
│ 2. handleReplicationEvent() 호출                             │
│    ├─ 성공: notification_log INSERT 완료                     │
│    │   ↓                                                     │
│    │   3. acknowledge(0/1A2B3C4) 호출                        │
│    │      ↓                                                  │
│    │      confirmed_flush_lsn = 0/1A2B3C4 업데이트           │
│    │                                                         │
│    └─ 실패: Exception throw                                  │
│        ↓                                                     │
│        acknowledge 안 함 (LSN 업데이트 안 됨)                │
│        ↓                                                     │
│        재시작 시 동일한 LSN부터 재처리                       │
└──────────────────────────────────────────────────────────────┘
```

### Blue-Green Deployment Support

다중 인스턴스 배포 시 replication slot은 **단일 연결만 허용**합니다.

**시나리오**: Blue (기존) + Green (신규) 동시 실행

```text
┌──────────────┐           ┌───────────────────────────┐
│ Blue (기존)  │ ────────▶ │ Replication Slot (active) │
└──────────────┘           └───────────────────────────┘
                                          ▲
                                          │ 연결 시도 실패
                              ┌───────────┴──────────┐
                              │ Green (신규)         │
                              │ → Retry every 5s     │
                              └──────────────────────┘
```

**구현**:

```typescript
// Slot 사용 가능 여부 확인
const result = await client.query(
  `SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = $1`,
  ['demo_slot']
);

if (result.rows.length > 0 && result.rows[0].active === true) {
  // Slot이 active (다른 인스턴스가 사용 중)
  throw new Error(`Replication slot is active for another instance`);
}
```

**동작**:

1. **Green 시작**: Slot이 active → 에러 throw → 5초 후 재시도
2. **Blue 종료**: Slot이 inactive로 변경
3. **Green 성공**: Slot 연결 성공 → 마지막 LSN부터 이어받아 처리

이렇게 하면 **무중단 배포**와 **이벤트 누락 없음**을 동시에 보장합니다.

## Cleanup

```bash
# Stop all processes (Ctrl+C in each terminal)

# Stop and remove containers
docker-compose down -v

# Remove node_modules (optional)
rm -rf node_modules dist
```

## **pgoutput** testing for PostgreSQL

This repository contains tools and scripts for testing the `pgoutput` logical decoding output plugin in PostgreSQL.

> **Note:** When creating a subscription in the same PostgreSQL cluster (pubdb and subdb in the same instance), `CREATE SUBSCRIPTION` with `create_slot=true` will hang. This guide uses separate Docker containers to avoid this issue.

### Setup: Two PostgreSQL Containers

#### Create Docker Network

```bash
docker network create pgnet
```

#### Start Publisher Container

```bash
docker run -d \
  --name pg-pub \
  --network pgnet \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=pubdb \
  -p 5432:5432 \
  postgres:16
```

#### Start Subscriber Container

```bash
docker run -d \
  --name pg-sub \
  --network pgnet \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=testpw \
  -e POSTGRES_DB=subdb \
  -p 5433:5432 \
  postgres:16
```

### Setup Publisher (pg-pub)

#### Configure Logical Replication

```bash
docker exec pg-pub psql -U test -d pubdb -c "ALTER SYSTEM SET wal_level = logical;"
docker exec pg-pub psql -U test -d pubdb -c "ALTER SYSTEM SET max_wal_senders = 10;"
docker exec pg-pub psql -U test -d pubdb -c "ALTER SYSTEM SET max_replication_slots = 10;"
docker restart pg-pub
```

Wait for restart:

```bash
sleep 5
```

#### Verify Settings

```bash
docker exec pg-pub psql -U test -d pubdb -c "SHOW wal_level;"
```

Expected output: `logical`

#### Create Table and Publication

```bash
docker exec pg-pub psql -U test -d pubdb << 'EOF'
CREATE TABLE public.demo(
  id   int PRIMARY KEY,
  name text
);

CREATE PUBLICATION pub_demo
  FOR TABLE public.demo
  WITH (publish = 'insert,update,delete,truncate');

-- Insert initial data
INSERT INTO public.demo VALUES (1, 'alice'), (2, 'bob'), (3, 'charlie');

-- Verify
SELECT * FROM public.demo;
SELECT * FROM pg_publication_tables WHERE pubname='pub_demo';
EOF
```

### Setup Subscriber (pg-sub)

#### Create Table and Subscription

```bash
docker exec pg-sub psql -U test -d subdb << 'EOF'
CREATE TABLE public.demo(
  id   int PRIMARY KEY,
  name text
);

CREATE SUBSCRIPTION sub_demo
  CONNECTION 'host=pg-pub port=5432 dbname=pubdb user=test password=testpw'
  PUBLICATION pub_demo
  WITH (copy_data = true, create_slot = true, slot_name = sub_demo);

-- Wait a moment for initial sync
\! sleep 2

-- Verify initial data copied
SELECT * FROM public.demo ORDER BY id;
EOF
```

Expected output: 3 rows (alice, bob, charlie)

### Verify Replication Status

#### Check Replication Slots (Publisher)

```bash
docker exec pg-pub psql -U test -d pubdb -c "
SELECT
  slot_name,
  plugin,
  slot_type,
  active,
  confirmed_flush_lsn IS NOT NULL as has_flushed
FROM pg_replication_slots;
"
```

#### Check Replication Statistics (Publisher)

```bash
docker exec pg-pub psql -U test -d pubdb -c "
SELECT
  application_name,
  client_addr,
  state,
  sync_state,
  sent_lsn,
  write_lsn,
  flush_lsn
FROM pg_stat_replication;
"
```

#### Check Subscription Status (Subscriber)

```bash
docker exec pg-sub psql -U test -d subdb -c "
SELECT
  subname,
  subenabled,
  subconninfo
FROM pg_subscription;
"
```

#### Check Subscription Statistics (Subscriber)

```bash
docker exec pg-sub psql -U test -d subdb -c "
SELECT
  subname,
  received_lsn,
  last_msg_receipt_time,
  latest_end_lsn,
  latest_end_time
FROM pg_stat_subscription;
"
```

### Test Data Synchronization

#### Test INSERT

```bash
docker exec pg-pub psql -U test -d pubdb -c \
  "INSERT INTO public.demo VALUES (4, 'david'), (5, 'eve');"

# Wait a moment and check subscriber
sleep 1
docker exec pg-sub psql -U test -d subdb -c \
  "SELECT * FROM public.demo ORDER BY id;"
```

Expected: 5 rows including david and eve

#### Test UPDATE

```bash
docker exec pg-pub psql -U test -d pubdb -c \
  "UPDATE public.demo SET name = 'ALICE_UPDATED' WHERE id = 1;"

# Check subscriber
sleep 1
docker exec pg-sub psql -U test -d subdb -c \
  "SELECT * FROM public.demo WHERE id = 1;"
```

Expected: name changed to 'ALICE_UPDATED'

#### Test DELETE

```bash
docker exec pg-pub psql -U test -d pubdb -c \
  "DELETE FROM public.demo WHERE id = 5;"

# Check subscriber
sleep 1
docker exec pg-sub psql -U test -d subdb -c \
  "SELECT * FROM public.demo ORDER BY id;"
```

Expected: Row with id=5 removed

#### Check Replication Lag

```bash
docker exec pg-sub psql -U test -d subdb -c \
  "SELECT subname,
          latest_end_time,
          now() - latest_end_time AS replication_lag
   FROM pg_stat_subscription
   WHERE subname = 'sub_demo';"
```

### Test pgoutput Plugin Directly

#### Using pg_recvlogical (Human-Readable: test_decoding)

```bash
# 디버깅용 슬롯 생성 (test_decoding 플러그인)
docker exec pg-pub pg_recvlogical -d pubdb -U test \
  --slot debug_slot --create-slot -P test_decoding

# 슬롯 생성 확인
docker exec pg-pub psql -U test -d pubdb -c \
  "SELECT slot_name, plugin, slot_type, active FROM pg_replication_slots WHERE slot_name = 'debug_slot';"

# 데이터 변경 생성
docker exec pg-pub psql -U test -d pubdb -c \
  "INSERT INTO demo VALUES (100, 'debug_test'); \
   UPDATE demo SET name = 'debug_updated' WHERE id = 100; \
   DELETE FROM demo WHERE id = 100;"

# 읽기 쉬운 형태로 출력 확인
docker exec pg-pub bash -c \
  "timeout 1 pg_recvlogical -d pubdb -U test --slot debug_slot -f - --start || true"

# 슬롯 삭제
docker exec pg-pub psql -U test -d pubdb -c \
  "SELECT pg_drop_replication_slot('debug_slot');"
```

**Expected output:**

```sql
BEGIN 765
table public.demo: INSERT: id[integer]:100 name[text]:'debug_test'
table public.demo: UPDATE: id[integer]:100 name[text]:'debug_updated'
table public.demo: DELETE: id[integer]:100
COMMIT 765
```

### Using pg_recvlogical (Binary: pgoutput)

```bash
# pgoutput 슬롯 생성
docker exec pg-pub pg_recvlogical -d pubdb -U test \
  --slot pgoutput_test --create-slot -P pgoutput

# 데이터 변경 생성
docker exec pg-pub psql -U test -d pubdb -c \
  "INSERT INTO demo VALUES (200, 'pgoutput_test'); \
   UPDATE demo SET name = 'pgoutput_updated' WHERE id = 200;"

# pgoutput raw output 확인 (바이너리)
docker exec pg-pub bash -c \
  "timeout 1 pg_recvlogical -d pubdb -U test --slot pgoutput_test -f - --start \
   -o proto_version=1 -o publication_names=pub_demo 2>&1 | cat -v || true"

# 슬롯 삭제
docker exec pg-pub psql -U test -d pubdb -c \
  "SELECT pg_drop_replication_slot('pgoutput_test');"
```

**Expected output (binary protocol):**

```
B^@^@^@...              (Begin transaction)
R^@^@@^Npublic^@demo... (Relation metadata)
I^@^@@^NN...            (Insert)
U^@^@@^NN...            (Update)
C^@^@^@...              (Commit)
```

#### Understanding pgoutput Messages

| Message | Description |
|---------|-------------|
| `B` | Begin - 트랜잭션 시작 |
| `R` | Relation - 테이블 스키마 정보 |
| `I` | Insert - 새 행 삽입 |
| `U` | Update - 행 업데이트 |
| `D` | Delete - 행 삭제 |
| `C` | Commit - 트랜잭션 커밋 |
| `T` | Truncate - 테이블 비우기 |

### Cleanup

#### Stop and Remove Containers

```bash
docker stop pg-pub pg-sub
docker rm pg-pub pg-sub
docker network rm pgnet
```

#### Clean Specific Replication Slot

```bash
# On publisher
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_drop_replication_slot('slot_name');
"
```

### Troubleshooting

#### Check if subscription is created

```bash
docker exec pg-sub psql -U test -d subdb -c "
SELECT COUNT(*) FROM pg_subscription WHERE subname = 'sub_demo';
"
```

If returns `0`, subscription was not created. Run the subscription creation command again.

#### Replication slot issues

```bash
# Check inactive slots on publisher
docker exec pg-pub psql -U test -d pubdb -c "
SELECT slot_name, active, active_pid
FROM pg_replication_slots
WHERE NOT active;
"

# Drop unused slot
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_drop_replication_slot('slot_name');
"
```

#### Check replication lag

```bash
docker exec pg-sub psql -U test -d subdb -c "
SELECT
  subname,
  latest_end_lsn,
  latest_end_time,
  now() - latest_end_time AS lag
FROM pg_stat_subscription;
"
```

#### Active slot error

If you see `ERROR: replication slot "xxx" is active for PID nnn`:

```bash
# Kill the process holding the slot
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_terminate_backend(active_pid)
FROM pg_replication_slots
WHERE slot_name = 'xxx';
"

# Or drop and recreate the slot
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_drop_replication_slot('xxx');
"
```

#### Same-Cluster Subscription Issue

If creating subscription in the same PostgreSQL cluster (pubdb and subdb in same instance):

**Problem:** `CREATE SUBSCRIPTION` with `create_slot=true` will hang indefinitely.

**Solution:** Use separate PostgreSQL instances (as shown in this guide) OR manually create slot first:

```bash
# On publisher
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_create_logical_replication_slot('sub_demo', 'pgoutput');
"

# Then create subscription with create_slot=false
docker exec pg-sub psql -U test -d subdb -c "
CREATE SUBSCRIPTION sub_demo
  CONNECTION 'host=pg-pub port=5432 dbname=pubdb user=test password=testpw'
  PUBLICATION pub_demo
  WITH (copy_data = true, create_slot = false, slot_name = 'sub_demo');
"
```

### PostgreSQL Logical Replication Overview

PostgreSQL의 **논리 복제(subscription)**는 “항상 연결되어 있어야만 작동하지만, 끊어져도 안전하게 재시도·복구되는 구조”로 설계

```text
[Publisher]
  └── Replication Slot (pg_replication_slots)
         ↓
  WAL(Logical) → 네트워크로 전송
         ↓
[Subscriber]
  └── apply worker (pg_stat_subscription)
```

- Publisher 쪽 replication slot이 “데이터 변경(WAL)”을 버퍼링.
- Subscriber 쪽 apply worker가 주기적으로 붙어서 받아감.
- 네트워크 단절 시에도 replication slot에 쌓여있던 변경분을 apply worker가 재접속 후 받아감.
- 접속하지 않을 경우 replication slot에 쌓여있는 변경분이 `max_slot_wal_keep_size`(기본값 없음) 한도까지 쌓임.
- Subscriber가 장시간 멈추면 WAL이 쌓이므로, 디스크 용량 관리에 주의

### Remove Replication Setup

#### Drop Subscription (on Subscriber)

```bash
# Drop subscription and slot on publisher
docker exec pg-sub psql -U test -d subdb -c "
DROP SUBSCRIPTION IF EXISTS sub_demo;
"
```

Note: By default, `DROP SUBSCRIPTION` does NOT drop the replication slot on the publisher. To drop both:

```bash
# This will fail if subscription doesn't exist, use IF EXISTS
docker exec pg-sub psql -U test -d subdb -c "
ALTER SUBSCRIPTION sub_demo DISABLE;
ALTER SUBSCRIPTION sub_demo SET (slot_name = NONE);
DROP SUBSCRIPTION sub_demo;
"

# Then manually drop slot on publisher
docker exec pg-pub psql -U test -d pubdb -c "
SELECT pg_drop_replication_slot('sub_demo');
"
```

#### Drop Publication (on Publisher)

```bash
docker exec pg-pub psql -U test -d pubdb -c "
DROP PUBLICATION IF EXISTS pub_demo;
"
```
