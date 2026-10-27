BEGIN;
-- Account deletion (Requirement 12.5) redacts the contact details a deleted Farmer supplied for a
-- booking Recipient. booking_recipients stays append-only for every other change. The only UPDATE
-- allowed replaces name, phone, and directions with the redaction values, inside a transaction
-- that set app.account_erasure = 'on', and leaves every other column unchanged. DELETE is still
-- refused. This guards against accidental mutation; database roles are the authorization boundary.
-- Additive: one new function; the existing trigger now calls it. No column or row changes.
CREATE FUNCTION public.guard_booking_recipient_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.account_erasure', true) = 'on'
     AND NEW.id = OLD.id
     AND NEW.booking_id = OLD.booking_id
     AND NEW.coordination_consent = OLD.coordination_consent
     AND NEW.service_location_snapshot = OLD.service_location_snapshot
     AND NEW.created_at = OLD.created_at
     AND NEW.name = 'Redacted recipient'
     AND NEW.phone_ciphertext IS NULL
     AND NEW.phone_lookup_hash IS NULL
     AND NEW.landmark_or_directions IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE TRIGGER booking_recipients_append_only
  BEFORE UPDATE OR DELETE ON public.booking_recipients
  FOR EACH ROW EXECUTE FUNCTION public.guard_booking_recipient_mutation();
COMMIT;
