BEGIN;

-- A Tractor may expose a Service once without Equipment and once per Equipment item.
-- COALESCE makes the no-Equipment configuration unique as well.
CREATE UNIQUE INDEX service_offerings_tractor_service_equipment_uniq
  ON public.service_offerings (
    tractor_id,
    service_id,
    COALESCE(equipment_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX equipment_owner_inventory_idx
  ON public.equipment (owner_id, tractor_id, availability_status, updated_at DESC, id DESC);

CREATE INDEX documents_tractor_eligibility_idx
  ON public.documents (tractor_id, owner_id, document_kind, scan_status, expires_at)
  WHERE scan_status = 'ACCEPTED';

COMMIT;
