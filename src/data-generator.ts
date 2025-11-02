import { Client } from 'pg';
import { DemoRow } from './types';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:testpw@localhost:5432/pubdb';

const DB_CONFIG = {
  connectionString: DATABASE_URL,
};

class DataGenerator {
  private client: Client;
  private intervalId: NodeJS.Timeout | null = null;
  private insertedIds: number[] = [];

  constructor() {
    this.client = new Client(DB_CONFIG);
  }

  async start(intervalMs: number = 2000) {
    try {
      await this.client.connect();
      console.log('✅ Connected to PostgreSQL');
      console.log(`🔄 Generating random data every ${intervalMs}ms...\n`);

      this.intervalId = setInterval(async () => {
        await this.generateRandomOperation();
      }, intervalMs);
    } catch (error) {
      console.error('❌ Failed to start Data Generator:', error);
      process.exit(1);
    }
  }

  private async generateRandomOperation() {
    const operations = ['INSERT', 'UPDATE', 'DELETE'];
    const weights = [0.5, 0.3, 0.2]; // 50% INSERT, 30% UPDATE, 20% DELETE

    // Weighted random selection
    const random = Math.random();
    let operation: string;

    if (random < weights[0]) {
      operation = 'INSERT';
    } else if (random < weights[0] + weights[1]) {
      operation = 'UPDATE';
    } else {
      operation = 'DELETE';
    }

    // If no rows exist, force INSERT
    if (this.insertedIds.length === 0) {
      operation = 'INSERT';
    }

    try {
      switch (operation) {
        case 'INSERT':
          await this.insertRandomRow();
          break;
        case 'UPDATE':
          await this.updateRandomRow();
          break;
        case 'DELETE':
          await this.deleteRandomRow();
          break;
      }
    } catch (error) {
      console.error(`❌ Error during ${operation}:`, error);
    }
  }

  private async insertRandomRow() {
    const row = this.generateRandomData();

    const result = await this.client.query(
      `INSERT INTO demo (
        small_num, big_num, decimal_val, float_val,
        name, code, fixed_char,
        birth_date, work_time,
        is_active, metadata, tags, binary_data
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9,
        $10, $11, $12, $13
      ) RETURNING id`,
      [
        row.small_num,
        row.big_num,
        row.decimal_val,
        row.float_val,
        row.name,
        row.code,
        row.fixed_char,
        row.birth_date,
        row.work_time,
        row.is_active,
        row.metadata ? JSON.stringify(row.metadata) : null,
        row.tags,
        row.binary_data,
      ]
    );

    const insertedId = result.rows[0].id;
    this.insertedIds.push(insertedId);
    console.log(`✅ INSERT row id=${insertedId}`);
  }

  private async updateRandomRow() {
    if (this.insertedIds.length === 0) return;

    const randomId = this.insertedIds[Math.floor(Math.random() * this.insertedIds.length)];
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Randomly update some fields
    if (Math.random() > 0.5) {
      updates.push(`name = $${paramIndex++}`);
      values.push(this.randomName());
    }

    if (Math.random() > 0.5) {
      updates.push(`small_num = $${paramIndex++}`);
      values.push(this.randomInt(1, 100));
    }

    if (Math.random() > 0.5) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(Math.random() > 0.5);
    }

    if (Math.random() > 0.5) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify({ updated: true, timestamp: Date.now() }));
    }

    if (updates.length === 0) {
      updates.push(`name = $${paramIndex++}`);
      values.push(this.randomName() + '_UPDATED');
    }

    values.push(randomId);

    await this.client.query(
      `UPDATE demo SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    console.log(`✅ UPDATE row id=${randomId}`);
  }

  private async deleteRandomRow() {
    if (this.insertedIds.length === 0) return;

    const randomIndex = Math.floor(Math.random() * this.insertedIds.length);
    const idToDelete = this.insertedIds[randomIndex];

    await this.client.query('DELETE FROM demo WHERE id = $1', [idToDelete]);

    this.insertedIds.splice(randomIndex, 1);
    console.log(`✅ DELETE row id=${idToDelete}`);
  }

  private generateRandomData(): DemoRow {
    return {
      small_num: this.randomInt(1, 100),
      big_num: BigInt(this.randomInt(1000000, 9999999)),
      decimal_val: (Math.random() * 1000).toFixed(2),
      float_val: Math.random() * 100,
      name: this.randomName(),
      code: this.randomCode(),
      fixed_char: this.randomString(10),
      birth_date: this.randomDate(),
      work_time: this.randomTime(),
      is_active: Math.random() > 0.3,
      metadata: {
        category: this.randomChoice(['A', 'B', 'C', 'D']),
        priority: this.randomInt(1, 5),
        tags_count: this.randomInt(0, 10),
      },
      tags: this.randomTags(),
      binary_data: Buffer.from(this.randomString(20)),
    };
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private randomName(): string {
    const firstNames = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Henry'];
    const lastNames = ['Smith', 'Johnson', 'Brown', 'Davis', 'Wilson', 'Moore', 'Taylor'];
    return `${this.randomChoice(firstNames)} ${this.randomChoice(lastNames)}`;
  }

  private randomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private randomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private randomDate(): Date {
    const start = new Date(1970, 0, 1);
    const end = new Date(2010, 11, 31);
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  }

  private randomTime(): string {
    const hour = this.randomInt(0, 23).toString().padStart(2, '0');
    const minute = this.randomInt(0, 59).toString().padStart(2, '0');
    const second = this.randomInt(0, 59).toString().padStart(2, '0');
    return `${hour}:${minute}:${second}`;
  }

  private randomTags(): string[] {
    const allTags = ['urgent', 'important', 'review', 'archived', 'public', 'private', 'draft'];
    const count = this.randomInt(0, 4);
    const tags: string[] = [];

    for (let i = 0; i < count; i++) {
      const tag = this.randomChoice(allTags);
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return tags;
  }

  private randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    await this.client.end();
    console.log('\n✅ Data Generator stopped');
  }
}

// Main execution
const generator = new DataGenerator();

// Start generating data every 2 seconds
generator.start(2000);

// Graceful shutdown
process.on('SIGINT', async () => {
  await generator.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await generator.stop();
  process.exit(0);
});
