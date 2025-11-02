// Type definitions for the PoC

export interface DemoRow {
  id?: number;
  small_num?: number | null;
  big_num?: bigint | null;
  decimal_val?: string | null;
  float_val?: number | null;
  name?: string | null;
  code?: string | null;
  fixed_char?: string | null;
  created_at?: Date | null;
  birth_date?: Date | null;
  work_time?: string | null;
  is_active?: boolean | null;
  metadata?: Record<string, any> | null;
  tags?: string[] | null;
  uuid_val?: string | null;
  binary_data?: Buffer | null;
}

export interface NotificationLogEntry {
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
  table_name: string;
  row_id?: number | null;
  data?: Record<string, any> | null;
  old_data?: Record<string, any> | null;
  timestamp?: Date;
}

export interface ReplicationEvent {
  tag: 'insert' | 'update' | 'delete' | 'truncate' | 'begin' | 'commit' | 'relation';
  relation?: {
    schema: string;
    name: string;
  };
  new?: Record<string, any>;
  old?: Record<string, any>;
}
