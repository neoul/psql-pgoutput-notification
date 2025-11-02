-- Setup demo table with various PostgreSQL types

CREATE TABLE IF NOT EXISTS demo (
  -- Primary key
  id            SERIAL PRIMARY KEY,

  -- Numeric types
  small_num     SMALLINT,
  big_num       BIGINT,
  decimal_val   DECIMAL(10,2),
  float_val     REAL,

  -- String types
  name          TEXT,
  code          VARCHAR(50),
  fixed_char    CHAR(10),

  -- Date/Time types
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  birth_date    DATE,
  work_time     TIME,

  -- Boolean
  is_active     BOOLEAN DEFAULT true,

  -- JSON
  metadata      JSONB,

  -- Array
  tags          TEXT[],

  -- UUID
  uuid_val      UUID DEFAULT gen_random_uuid(),

  -- Binary
  binary_data   BYTEA
);

-- Create index for better performance
CREATE INDEX idx_demo_created_at ON demo(created_at);
CREATE INDEX idx_demo_name ON demo(name);
CREATE INDEX idx_demo_metadata ON demo USING GIN(metadata);
