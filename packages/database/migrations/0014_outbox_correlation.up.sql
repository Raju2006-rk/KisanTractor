BEGIN;

-- Carries the originating request/job correlation identifier onto every outbox
-- event so worker logs and spans join the transaction that wrote the event.
-- The default reads the transaction-local setting written by withTransaction,
-- so stores that insert outbox rows with raw SQL are covered without changes.
-- Additive and nullable: events written before this migration keep NULL.
ALTER TABLE public.outbox_events
  ADD COLUMN correlation_id text
    DEFAULT NULLIF(current_setting('app.correlation_id', true), '');

ALTER TABLE public.outbox_events
  ADD CONSTRAINT outbox_events_correlation_id_chk CHECK (
    correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 200
  );

COMMIT;
