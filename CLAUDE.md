# pgoutput Notification PoC

## 상태: ✅ 구현 완료 (2025-11-02)

CDC 기반 notification PoC 구현

### 구현된 기능
- ✅ PostgreSQL pgoutput 플러그인 기반 CDC
- ✅ pg-logical-replication (v2.2.1) 라이브러리로 실시간 이벤트 캡처
- ✅ NotificationService: 콘솔 출력 + notification_log 테이블 기록
- ✅ DataGenerator: 가중치 기반 랜덤 데이터 생성 (50% INSERT, 30% UPDATE, 20% DELETE)
- ✅ 다양한 PostgreSQL 타입 지원 (17개 타입)
- ✅ 환경변수 기반 설정 (DATABASE_URL, .env 파일)

## 프로젝트 구조

```
/home/willing/poc/pgoutput/
├── docker-compose.yml          # PostgreSQL + 초기화 설정
├── .env.example                # 환경변수 예제
├── init-db/
│   ├── 01-setup.sql           # demo table 생성
│   ├── 02-publication.sql     # Publication + Replication Slot
│   └── 03-notification-log.sql # notification_log table
├── src/
│   ├── types.ts               # TypeScript 타입 정의
│   ├── notification-service.ts # CDC → Notification 처리
│   └── data-generator.ts       # 랜덤 데이터 생성기
├── package.json
├── tsconfig.json
├── CLAUDE.md                   # 이 파일
└── README.md
```

## Docker Compose 구성

**컨테이너:**
- `postgres` - PostgreSQL 16 (pgoutput 활성화)
  - Container name: `pgoutput-poc`
  - Port: 5432
  - Database: pubdb
  - WAL 설정: wal_level=logical

**특징:**
- 단일 PostgreSQL 인스턴스 사용 (PoC 간소화)
- pg-logical-replication은 외부 Node.js 프로세스로 실행
- init-db 볼륨 마운트로 초기화 SQL 자동 실행

## Demo Table 스키마

다양한 PostgreSQL 타입을 포함한 테이블 (17개 필드):
- **Numeric**: SMALLINT, BIGINT, DECIMAL, REAL
- **String**: TEXT, VARCHAR, CHAR
- **Date/Time**: TIMESTAMP WITH TIME ZONE, DATE, TIME
- **Boolean**: BOOLEAN
- **JSON**: JSONB
- **Array**: TEXT[]
- **UUID**: UUID
- **Binary**: BYTEA

상세 스키마: `init-db/01-setup.sql` 참조

## NotificationService

**기능:**
- pgoutput 이벤트 파싱 (INSERT/UPDATE/DELETE/TRUNCATE)
- 타임스탬프와 함께 콘솔 출력
- notification_log 테이블에 자동 기록
- Graceful shutdown 지원 (SIGINT/SIGTERM)

**구현:**
- LogicalReplicationService + PgoutputPlugin (proto_version: 1)
- Publication: demo_pub
- Replication Slot: demo_slot
- Auto acknowledge: 10초 타임아웃

## DataGenerator

**동작:**
- 2초 간격으로 랜덤 작업 실행
- 가중치: INSERT 50%, UPDATE 30%, DELETE 20%
- 모든 PostgreSQL 타입에 대한 랜덤 데이터 생성
- 삽입된 행 ID 추적 및 관리

## 실행 흐름

```
DataGenerator → PostgreSQL demo table
                     ↓ WAL (Write-Ahead Log)
                pgoutput plugin
                     ↓ Replication Stream
             NotificationService
                  ↓         ↓
       notification_log   Console Output
```

## 구현 내역

### ✅ 1. Docker Compose 작성
- PostgreSQL 16 컨테이너
- wal_level=logical, max_wal_senders=10, max_replication_slots=10
- init-db 볼륨 마운트로 자동 초기화
- Health check 설정

### ✅ 2. SQL 초기화 스크립트
- `01-setup.sql`: demo 테이블 + 인덱스 (created_at, name, metadata GIN)
- `02-publication.sql`: publication (demo_pub) + replication slot (demo_slot)
- `03-notification-log.sql`: notification_log 테이블 + 인덱스 + 권한

### ✅ 3. TypeScript 프로젝트 설정
- **Dependencies**: pg@8.16.3, pg-logical-replication@2.2.1
- **DevDependencies**: typescript@5.3.3, ts-node@10.9.2, @types/node, @types/pg
- **tsconfig.json**: CommonJS, ES2022 타겟
- **Scripts**: build, start, dev, generate, watch

### ✅ 4. NotificationService 구현
- DATABASE_URL 환경변수 지원
- LogicalReplicationService 설정
- 이벤트 핸들러 (insert/update/delete/truncate)
- notification_log 자동 기록 (JSONB 저장)
- 포맷팅된 콘솔 출력 (타임스탬프, 작업, 데이터)

### ✅ 5. DataGenerator 구현
- DATABASE_URL 환경변수 지원
- 랜덤 데이터 생성 (17개 타입)
- 가중치 기반 작업 선택
- ID 추적 및 관리 (삽입된 행 배열)
- 2초 간격 자동 실행

### ✅ 6. 환경 설정
- DATABASE_URL 환경변수 지원
- `.env.example` 제공
- Node.js `--env-file` 옵션 사용 (dotenv 불필요)
- `.gitignore`에 .env 파일 추가

### ✅ 7. 문서화
- README.md 전체 업데이트
- Quick Start 가이드 (8단계)
- 프로젝트 구조 설명
- Troubleshooting 섹션

## 기술 스택

| 항목 | 선택 | 버전/설정 |
|------|------|-----------|
| **Database** | PostgreSQL 16 | wal_level=logical |
| **언어** | TypeScript | CommonJS, ES2022 |
| **Runtime** | Node.js | --env-file, -r ts-node/register |
| **CDC 라이브러리** | pg-logical-replication | 2.2.1 |
| **DB 클라이언트** | pg | 8.16.3 |
| **컨테이너** | Docker Compose | postgres:16 |

## 주요 결정 사항

### 1. 단일 PostgreSQL 인스턴스
- PoC 간소화를 위해 단일 인스턴스 사용
- pg-logical-replication이 외부 Node.js 프로세스로 연결
- 같은 cluster 내 subscription hang 이슈 회피

### 2. CommonJS 모듈 시스템
- `module: "commonjs"` (tsconfig.json)
- `-r ts-node/register` 사용 (ESM 로더 에러 회피)
- 안정성 우선, 대부분의 라이브러리와 호환

### 3. 환경변수 관리
- DATABASE_URL 환경변수 지원
- Node.js 20.6+ `--env-file` 옵션 활용
- dotenv 의존성 제거 (간소화)

### 4. Replication Slot 관리
- 초기화 시 수동 생성 (`pg_create_logical_replication_slot`)
- Slot name: demo_slot
- Auto acknowledge 활성화 (10초 타임아웃)

## 트러블슈팅 이력

| 이슈 | 원인 | 해결 |
|------|------|------|
| pg-logical-replication@3.1.1 없음 | npm 패키지 버전 불일치 | v2.2.1로 다운그레이드 |
| ESM 로더 순환 참조 에러 | `--loader ts-node/esm` 사용 | `-r ts-node/register`로 변경 |
| Buffer 타입 에러 | @types/node 미설치 | @types/node 설치 |
| 환경변수 로드 안됨 | dotenv 설정 누락 | Node.js --env-file 옵션 사용 |

## 실행 방법

```bash
# 1. PostgreSQL 시작
docker-compose up -d

# 2. 환경변수 설정
cp .env.example .env

# 3. 의존성 설치
npm install

# 4. 빌드
npm run build

# 5. NotificationService 실행 (터미널 1)
npm run dev

# 6. DataGenerator 실행 (터미널 2)
npm run generate
```

## 개발 완료일

2025-11-02
