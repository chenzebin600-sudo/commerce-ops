-- Migration 027 deliberately stores the Foundation operation-plan reference
-- without a foreign key because legacy adoption can run it before migration 033
-- creates that relation. At this later point the prerequisite exists. NOT VALID
-- enforces all new writes without making adoption depend on historical rows.
ALTER TABLE "app"."shopee_discount_plans"
  ADD CONSTRAINT "shopee_discount_plans_foundation_plan_fk"
  FOREIGN KEY ("foundation_plan_id")
  REFERENCES "app"."foundation_operation_plans" ("id")
  ON DELETE RESTRICT
  NOT VALID;
