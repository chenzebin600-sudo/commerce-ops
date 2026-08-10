ALTER TABLE app.growth_inventory_snapshots
  ADD COLUMN IF NOT EXISTS transfer_pending_shipment_quantity numeric;
