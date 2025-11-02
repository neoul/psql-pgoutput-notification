# Notification PoC using pgoutput in PostgreSQL

## Specification

- CDC (Change Data Capture) 기반 notification PoC
- PostgreSQL의 논리 복제(logical replication) 기능 활용
- `pgoutput` 출력 플러그인 사용
- 데이터 변경 이벤트를 실시간으로 캡처하여 NotificationService로 전송
  - **PostgreSQL pgoutput → pg-logical-replication → NotificationService**
- [pg-logical-replication](https://github.com/kibae/pg-logical-replication) 라이브러리 사용
  - Node.js 환경에서 PostgreSQL 논리 복제 스트림 처리
- PoC 목표
  - PostgreSQL 데이터 변경 이벤트를 실시간으로 감지
  - 감지된 이벤트를 NotificationService로 전송하여 알림 처리
  - PoC의 NotificationService는 message를 출력하고, 지정된 log table에 기록

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
