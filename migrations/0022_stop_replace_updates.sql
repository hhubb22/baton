DROP TABLE IF EXISTS node_update_requests;
DROP TABLE IF EXISTS node_update_management;
DROP TABLE IF EXISTS node_upgrades;

ALTER TABLE node_credentials DROP CONSTRAINT IF EXISTS node_credentials_expires_after_create;
ALTER TABLE node_credentials DROP COLUMN IF EXISTS expires_at;
ALTER TABLE node_credentials DROP COLUMN IF EXISTS last_business_at;
