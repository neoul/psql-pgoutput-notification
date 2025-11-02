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

  constructor() {
    // Client for logging to notification_log table
    this.logClient = new Client(DB_CONFIG);

    // Logical replication service
    this.replicationService = new LogicalReplicationService(DB_CONFIG, {
      acknowledge: {
        auto: true,
        timeoutSeconds: 10,
      },
    });

    // pgoutput plugin configuration
    this.plugin = new PgoutputPlugin({
      protoVersion: 1,
      publicationNames: ['demo_pub'],
    });
  }

  async start() {
    try {
      console.log('🚀 Starting Notification Service...');

      // Connect log client
      await this.logClient.connect();
      console.log('✅ Connected to PostgreSQL for logging');

      // Subscribe to replication stream
      this.replicationService.on('data', async (lsn: string, log: any) => {
        await this.handleReplicationEvent(log);
      });

      this.replicationService.on('error', (err: Error) => {
        console.error('❌ Replication error:', err);
      });

      await this.replicationService.subscribe(this.plugin, 'demo_slot');
      console.log('✅ Subscribed to replication slot: demo_slot');
      console.log('👂 Listening for changes on demo table...\n');
    } catch (error) {
      console.error('❌ Failed to start Notification Service:', error);
      process.exit(1);
    }
  }

  private async handleReplicationEvent(log: ReplicationEvent) {
    try {
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
    } catch (error) {
      console.error('❌ Error handling replication event:', error);
    }
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
    try {
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
    } catch (error) {
      console.error('❌ Failed to log to database:', error);
    }
  }

  async stop() {
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
