-- Notification log table to store captured events

CREATE TABLE IF NOT EXISTS notification_log (
  id            SERIAL PRIMARY KEY,
  operation     VARCHAR(10) NOT NULL,  -- INSERT, UPDATE, DELETE, TRUNCATE
  table_name    VARCHAR(100) NOT NULL,
  row_id        INTEGER,               -- ID of affected row (if available)
  data          JSONB,                 -- Full row data
  old_data      JSONB,                 -- Old data (for UPDATE/DELETE)
  timestamp     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for querying
CREATE INDEX idx_notification_log_timestamp ON notification_log(timestamp DESC);
CREATE INDEX idx_notification_log_operation ON notification_log(operation);
CREATE INDEX idx_notification_log_table ON notification_log(table_name);

-- Grant permissions (for notification service to insert)
GRANT INSERT ON notification_log TO test;
GRANT USAGE, SELECT ON SEQUENCE notification_log_id_seq TO test;
