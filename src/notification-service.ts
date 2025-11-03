import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { Client } from 'pg';
import { NotificationLogEntry, ReplicationEvent } from './types';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:testpw@localhost:5432/pubdb';

const DB_CONFIG = {
  connectionString: DATABASE_URL,
};

class NotificationService {
  private logClient: Client;
  private replicationService: LogicalReplicationService;
  private plugin: PgoutputPlugin;
  private isActive = false;
  private isShuttingDown = false;

  constructor() {
    // Client for logging to notification_log table
    this.logClient = new Client(DB_CONFIG);

    // Logical replication service (Manual acknowledge)
    this.replicationService = new LogicalReplicationService(DB_CONFIG, {
      acknowledge: {
        auto: false,
        timeoutSeconds: 0, // auto가 false일 때는 사용 안 됨
      },
    });

    // pgoutput plugin configuration
    this.plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: ['demo_pub'],
    });
  }

  async start() {
    await this.connectWithRetry();
  }

  /**
   * 재연결 로직 포함한 복제 서비스 시작
   */
  private async connectWithRetry(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        await this.startReplication();
        this.isActive = true;
        // 연결 성공 시 루프 종료
        return;
      } catch (error) {
        // Slot 경합 에러는 조용히 처리
        const isSlotActive = error instanceof Error && error.message.toLowerCase().includes('is active');

        if (isSlotActive) {
          console.warn('⚠️  Replication slot is in use by another instance, will retry in 5s...');
        } else {
          console.error('❌ Failed to start Notification Service:', error);
        }

        // Shutdown 중이면 재시도 중단
        if (this.isShuttingDown) {
          console.warn('⚠️  Stopping retry attempts due to shutdown');
          return;
        }

        // 5초 대기 후 재시도
        console.log('🔄 Retrying in 5000ms...');
        await this.sleep(5000);
      }
    }
  }

  /**
   * 복제 서비스 시작
   */
  private async startReplication(): Promise<void> {
    console.log('🚀 Starting Notification Service...');
    console.log(`  - Slot: demo_slot`);
    console.log(`  - Publication: demo_pub`);
    console.log(`  - Acknowledge: manual`);

    // Replication slot 사용 중 여부 확인
    await this.checkSlotAvailability();

    // Connect log client
    await this.logClient.connect();
    console.log('✅ Connected to PostgreSQL for logging');

    // 변경사항 이벤트 핸들러 (명시적 acknowledge)
    this.replicationService.on('data', async (lsn: string, log: any) => {
      try {
        // 이벤트 처리
        await this.handleReplicationEvent(log);

        // 처리 성공 시에만 acknowledge
        await this.replicationService.acknowledge(lsn);
        console.log(`✅ Event processed and acknowledged: ${lsn}`);
      } catch (error) {
        // 처리 실패 시 acknowledge 안 함 -> 재시작 시 재처리
        console.error(`❌ Failed to process event at LSN ${lsn}:`, error);
      }
    });

    // 에러 이벤트 핸들러 - 런타임 연결 끊김 시 재연결
    this.replicationService.on('error', async (error: Error) => {
      console.error('❌ Replication error:', error);

      // 연결 끊김으로 간주하고 재연결 시도
      this.isActive = false;

      if (!this.isShuttingDown) {
        console.warn('🔄 Connection lost, attempting to reconnect...');
        await this.connectWithRetry();
      }
    });

    // Subscribe to replication stream
    await this.replicationService.subscribe(this.plugin, 'demo_slot');
    this.isActive = true;

    console.log('✅ Subscribed to replication slot: demo_slot');
    console.log('👂 Listening for changes on demo table...\n');
  }

  /**
   * Replication slot 사용 가능 여부 확인
   * - slot이 active (사용 중)이면 에러 throw → retry
   * - slot이 없거나 inactive면 진행 (pg-logical-replication이 생성)
   */
  private async checkSlotAvailability(): Promise<void> {
    const client = new Client(DB_CONFIG);

    try {
      await client.connect();

      // Replication slot 사용 중 여부 확인
      const result = await client.query(
        `SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = $1`,
        ['demo_slot'],
      );

      if (result.rows.length > 0 && result.rows[0].active === true) {
        // Slot이 active (다른 인스턴스가 사용 중)
        throw new Error(`Replication slot 'demo_slot' is active for another instance`);
      }

      // Slot이 없거나 inactive면 진행
      if (result.rows.length === 0) {
        console.log(`ℹ️  Replication slot 'demo_slot' does not exist, will be created by subscribe()`);
      } else {
        console.log(`ℹ️  Replication slot 'demo_slot' exists but is inactive, proceeding`);
      }
    } finally {
      await client.end();
    }
  }

  /**
   * 복제 이벤트 핸들러 (에러는 상위로 전파)
   */
  private async handleReplicationEvent(log: ReplicationEvent): Promise<void> {
    // Skip non-data events
    if (log.tag === 'begin' || log.tag === 'commit' || log.tag === 'relation') {
      return;
    }

    const tableName = log.relation?.name || 'unknown';
    const schema = log.relation?.schema || 'public';

    let operation: NotificationLogEntry['operation'];
    let rowId: number | null = null;
    let data: Record<string, any> | null = null;
    let oldData: Record<string, any> | null = null;

    switch (log.tag) {
      case 'insert':
        operation = 'INSERT';
        data = log.new || null;
        rowId = data?.id || null;
        break;

      case 'update':
        operation = 'UPDATE';
        data = log.new || null;
        oldData = log.old || null;
        rowId = data?.id || oldData?.id || null;
        break;

      case 'delete':
        operation = 'DELETE';
        oldData = log.old || null;
        rowId = oldData?.id || null;
        break;

      case 'truncate':
        operation = 'TRUNCATE';
        break;

      default:
        console.warn(`⚠️  Unknown operation: ${log.tag}`);
        return;
    }

    // Print to console
    this.printNotification(operation, tableName, rowId, data, oldData);

    // Log to database
    await this.logToDatabase({
      operation,
      table_name: `${schema}.${tableName}`,
      row_id: rowId,
      data,
      old_data: oldData,
    });
  }

  private printNotification(
    operation: string,
    tableName: string,
    rowId: number | null,
    data: Record<string, any> | null,
    oldData: Record<string, any> | null
  ) {
    const timestamp = new Date().toISOString();
    const rowIdStr = rowId ? `id=${rowId}` : '';

    console.log(`[${timestamp}] [${operation}] ${tableName} ${rowIdStr}`);

    if (operation === 'INSERT' && data) {
      console.log('  New data:', JSON.stringify(data, null, 2));
    } else if (operation === 'UPDATE') {
      if (oldData) console.log('  Old data:', JSON.stringify(oldData, null, 2));
      if (data) console.log('  New data:', JSON.stringify(data, null, 2));
    } else if (operation === 'DELETE' && oldData) {
      console.log('  Deleted data:', JSON.stringify(oldData, null, 2));
    }

    console.log('');
  }

  private async logToDatabase(entry: NotificationLogEntry) {
    await this.logClient.query(
      `INSERT INTO notification_log (operation, table_name, row_id, data, old_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.operation,
        entry.table_name,
        entry.row_id,
        entry.data ? JSON.stringify(entry.data) : null,
        entry.old_data ? JSON.stringify(entry.old_data) : null,
      ]
    );
  }

  /**
   * Sleep 유틸리티
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stop() {
    this.isShuttingDown = true;

    console.log('\n🛑 Stopping Notification Service...');
    await this.replicationService.stop();
    await this.logClient.end();
    console.log('✅ Service stopped');
  }
}

// Main execution
const service = new NotificationService();

service.start();

// Graceful shutdown
process.on('SIGINT', async () => {
  await service.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await service.stop();
  process.exit(0);
});
