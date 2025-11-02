-- Create publication for logical replication

CREATE PUBLICATION demo_pub FOR TABLE demo
  WITH (publish = 'insert,update,delete,truncate');

-- Create replication slot manually (to avoid hang issue)
SELECT pg_create_logical_replication_slot('demo_slot', 'pgoutput');

-- Verify publication
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
FROM pg_publication WHERE pubname='demo_pub';

-- Verify replication slot
SELECT slot_name, plugin, slot_type, active
FROM pg_replication_slots WHERE slot_name='demo_slot';
