ALTER TABLE conversations ADD COLUMN read_reply_seq bigint NOT NULL DEFAULT 0 CHECK (read_reply_seq >= 0);
