ALTER TABLE dispatch_outbox
    ADD COLUMN next_attempt_at timestamptz,
    ADD COLUMN may_have_been_sent boolean NOT NULL DEFAULT false;

UPDATE dispatch_outbox
SET next_attempt_at = created_at,
    may_have_been_sent = acked_at IS NULL;

ALTER TABLE dispatch_outbox
    ALTER COLUMN next_attempt_at SET NOT NULL,
    ALTER COLUMN next_attempt_at SET DEFAULT now();

DROP INDEX dispatch_outbox_due;

CREATE INDEX dispatch_outbox_node_due
    ON dispatch_outbox (target_node_id, next_attempt_at, id)
    WHERE acked_at IS NULL AND action = 'prepare';

CREATE INDEX dispatch_outbox_node_lease
    ON dispatch_outbox (target_node_id, lease_until)
    WHERE acked_at IS NULL AND action = 'prepare';
