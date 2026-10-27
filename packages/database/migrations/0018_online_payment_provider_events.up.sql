BEGIN;

-- Online payments (task 16.1, Requirements 11.5, 11.6, 12.3).

-- One provider intent belongs to exactly one payment record, so a verified provider event can
-- settle at most one payment. Webhooks also look the payment up by this pair.
CREATE UNIQUE INDEX payments_provider_reference_uniq
  ON public.payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- A replayed signed body under a different event id header is found by its digest and applied
-- at most once (the event id header is not covered by the provider signature).
CREATE INDEX provider_events_payload_digest_idx
  ON public.provider_events (provider, payload_digest);

COMMIT;
