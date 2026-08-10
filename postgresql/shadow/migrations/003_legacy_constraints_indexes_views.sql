ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_2" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_lifecycle_items" ADD CONSTRAINT "fk_file_lifecycle_items_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_protected_files" ADD CONSTRAINT "fk_file_lifecycle_protected_files_1" FOREIGN KEY ("file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_scans" ADD CONSTRAINT "fk_file_lifecycle_scans_1" FOREIGN KEY ("report_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_1" FOREIGN KEY ("managed_file_id") REFERENCES "app"."managed_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_account_capabilities" ADD CONSTRAINT "fk_foundation_account_capabilities_1" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_identity_links" ADD CONSTRAINT "fk_foundation_identity_links_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_integration_accounts" ADD CONSTRAINT "fk_foundation_integration_accounts_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_owners" ADD CONSTRAINT "fk_foundation_owners_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_source_runs" ADD CONSTRAINT "fk_foundation_source_runs_1" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_source_runs" ADD CONSTRAINT "fk_foundation_source_runs_2" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_task_events" ADD CONSTRAINT "fk_foundation_task_events_1" FOREIGN KEY ("task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_task_leases" ADD CONSTRAINT "fk_foundation_task_leases_1" FOREIGN KEY ("task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_2" FOREIGN KEY ("warehouse_id") REFERENCES "app"."foundation_warehouses" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_3" FOREIGN KEY ("store_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_4" FOREIGN KEY ("owner_id") REFERENCES "app"."foundation_owners" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_5" FOREIGN KEY ("source_run_id") REFERENCES "app"."foundation_source_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_6" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_1" FOREIGN KEY ("country_mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_2" FOREIGN KEY ("rule_set_id") REFERENCES "app"."growth_rule_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_3" FOREIGN KEY ("inventory_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_data_quality_issues" ADD CONSTRAINT "fk_growth_data_quality_issues_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_1" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_2" FOREIGN KEY ("signal_id") REFERENCES "app"."growth_signals" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_3" FOREIGN KEY ("focus_item_id") REFERENCES "app"."growth_focus_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_1" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_2" FOREIGN KEY ("last_analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_3" FOREIGN KEY ("first_analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_4" FOREIGN KEY ("current_signal_id") REFERENCES "app"."growth_signals" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_raw_rows" ADD CONSTRAINT "fk_growth_inventory_raw_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_snapshots" ADD CONSTRAINT "fk_growth_inventory_snapshots_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_snapshots" ADD CONSTRAINT "fk_growth_inventory_snapshots_2" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_mapping_issues" ADD CONSTRAINT "fk_growth_mapping_issues_1" FOREIGN KEY ("source_row_id") REFERENCES "app"."growth_order_raw_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_mapping_issues" ADD CONSTRAINT "fk_growth_mapping_issues_2" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_3" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_1" FOREIGN KEY ("inventory_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_2" FOREIGN KEY ("inventory_snapshot_id") REFERENCES "app"."growth_inventory_snapshots" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_3" FOREIGN KEY ("order_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_4" FOREIGN KEY ("order_line_id") REFERENCES "app"."growth_order_lines" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_2" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_3" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_4" FOREIGN KEY ("order_header_id") REFERENCES "app"."growth_order_headers" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_raw_rows" ADD CONSTRAINT "fk_growth_order_raw_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_1" FOREIGN KEY ("country_mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_3" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_coverage_snapshots" ADD CONSTRAINT "fk_growth_shop_sku_coverage_snapshots_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_coverage_snapshots" ADD CONSTRAINT "fk_growth_shop_sku_coverage_snapshots_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_3" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_3" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_4" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_3" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_signals" ADD CONSTRAINT "fk_growth_signals_1" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_signals" ADD CONSTRAINT "fk_growth_signals_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_daily_metrics" ADD CONSTRAINT "fk_growth_sku_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_daily_metrics" ADD CONSTRAINT "fk_growth_sku_daily_metrics_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_daily_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_daily_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_daily_metrics_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_1" FOREIGN KEY ("order_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_2" FOREIGN KEY ("inventory_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_3" FOREIGN KEY ("inventory_snapshot_id") REFERENCES "app"."growth_inventory_snapshots" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_source_batches" ADD CONSTRAINT "fk_growth_source_batches_1" FOREIGN KEY ("source_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_warehouse_country_mappings" ADD CONSTRAINT "fk_growth_warehouse_country_mappings_1" FOREIGN KEY ("mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_filter_option_cache" ADD CONSTRAINT "fk_mabang_filter_option_cache_1" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_2" FOREIGN KEY ("account_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_3" FOREIGN KEY ("sync_run_id") REFERENCES "app"."mabang_sku_image_sync_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_checkpoints" ADD CONSTRAINT "fk_mabang_sku_image_checkpoints_1" FOREIGN KEY ("batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_discoveries" ADD CONSTRAINT "fk_mabang_sku_image_discoveries_1" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."mabang_sku_image_discoveries" ADD CONSTRAINT "fk_mabang_sku_image_discoveries_2" FOREIGN KEY ("batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_discovery_images" ADD CONSTRAINT "fk_mabang_sku_image_discovery_images_1" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."mabang_sku_image_discovery_images" ADD CONSTRAINT "fk_mabang_sku_image_discovery_images_2" FOREIGN KEY ("discovery_id") REFERENCES "app"."mabang_sku_image_discoveries" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_sync_runs" ADD CONSTRAINT "fk_mabang_sku_image_sync_runs_1" FOREIGN KEY ("account_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."price_control_automation_settings" ADD CONSTRAINT "fk_price_control_automation_settings_1" FOREIGN KEY ("dingtalk_config_id") REFERENCES "app"."dingtalk_robot_configs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."price_control_price_snapshots" ADD CONSTRAINT "fk_price_control_price_snapshots_1" FOREIGN KEY ("apply_no") REFERENCES "app"."price_control_source_batches" ("apply_no") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."price_control_price_snapshots" ADD CONSTRAINT "fk_price_control_price_snapshots_2" FOREIGN KEY ("sync_run_id") REFERENCES "app"."price_control_sync_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."price_control_source_batches" ADD CONSTRAINT "fk_price_control_source_batches_1" FOREIGN KEY ("last_sync_run_id") REFERENCES "app"."price_control_sync_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."price_control_sync_runs" ADD CONSTRAINT "fk_price_control_sync_runs_1" FOREIGN KEY ("foundation_source_run_id") REFERENCES "app"."foundation_source_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_ai_contents" ADD CONSTRAINT "fk_product_ai_contents_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_3" FOREIGN KEY ("parent_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_override_events" ADD CONSTRAINT "fk_product_field_override_events_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_overrides" ADD CONSTRAINT "fk_product_field_overrides_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_3" FOREIGN KEY ("internal_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_image_generation_items" ADD CONSTRAINT "fk_product_image_generation_items_1" FOREIGN KEY ("task_id") REFERENCES "app"."product_image_generation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."product_image_generation_tasks" ADD CONSTRAINT "fk_product_image_generation_tasks_1" FOREIGN KEY ("listing_draft_id") REFERENCES "app"."product_listing_drafts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_image_generation_tasks" ADD CONSTRAINT "fk_product_image_generation_tasks_2" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_images" ADD CONSTRAINT "fk_product_images_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_1" FOREIGN KEY ("product_package_row_id") REFERENCES "app"."product_package_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_2" FOREIGN KEY ("import_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_3" FOREIGN KEY ("import_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_files" ADD CONSTRAINT "fk_product_import_files_1" FOREIGN KEY ("export_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_files" ADD CONSTRAINT "fk_product_import_files_2" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_issues" ADD CONSTRAINT "fk_product_import_issues_1" FOREIGN KEY ("row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_issues" ADD CONSTRAINT "fk_product_import_issues_2" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_rows" ADD CONSTRAINT "fk_product_import_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_inventory_snapshots" ADD CONSTRAINT "fk_product_inventory_snapshots_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_inventory_snapshots" ADD CONSTRAINT "fk_product_inventory_snapshots_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_listing_drafts" ADD CONSTRAINT "fk_product_listing_drafts_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_listing_publish_records" ADD CONSTRAINT "fk_product_listing_publish_records_1" FOREIGN KEY ("listing_draft_id") REFERENCES "app"."product_listing_drafts" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_media_links" ADD CONSTRAINT "fk_product_media_links_1" FOREIGN KEY ("product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_media_links" ADD CONSTRAINT "fk_product_media_links_2" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_3" FOREIGN KEY ("category_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_1" FOREIGN KEY ("latest_import_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_2" FOREIGN KEY ("latest_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_3" FOREIGN KEY ("import_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_4" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_packaging_profiles" ADD CONSTRAINT "fk_product_packaging_profiles_1" FOREIGN KEY ("source_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_packaging_profiles" ADD CONSTRAINT "fk_product_packaging_profiles_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_price_change_events" ADD CONSTRAINT "fk_product_price_change_events_1" FOREIGN KEY ("foundation_task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_price_change_events" ADD CONSTRAINT "fk_product_price_change_events_2" FOREIGN KEY ("source_apply_no") REFERENCES "app"."price_control_source_batches" ("apply_no") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_price_change_events" ADD CONSTRAINT "fk_product_price_change_events_3" FOREIGN KEY ("sync_run_id") REFERENCES "app"."price_control_sync_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_current_prices" ADD CONSTRAINT "fk_product_sku_current_prices_1" FOREIGN KEY ("source_snapshot_id") REFERENCES "app"."price_control_price_snapshots" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_current_prices" ADD CONSTRAINT "fk_product_sku_current_prices_2" FOREIGN KEY ("source_apply_no") REFERENCES "app"."price_control_source_batches" ("apply_no") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle" ADD CONSTRAINT "fk_product_sku_lifecycle_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle" ADD CONSTRAINT "fk_product_sku_lifecycle_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle_events" ADD CONSTRAINT "fk_product_sku_lifecycle_events_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle_events" ADD CONSTRAINT "fk_product_sku_lifecycle_events_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_3" FOREIGN KEY ("current_source_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_4" FOREIGN KEY ("model_id") REFERENCES "app"."product_models" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_5" FOREIGN KEY ("category_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."scheduled_export_run_events" ADD CONSTRAINT "fk_scheduled_export_run_events_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_runs" ADD CONSTRAINT "fk_scheduled_export_runs_1" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_1" FOREIGN KEY ("dingtalk_config_id") REFERENCES "app"."dingtalk_robot_configs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_2" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE UNIQUE INDEX "idx_export_files_request_key" ON "app"."export_files" ("request_key") WHERE request_key IS NOT NULL;

CREATE INDEX "idx_export_files_status" ON "app"."export_files" ("status", "created_at" DESC);

CREATE INDEX "idx_export_files_run_id" ON "app"."export_files" ("run_id");

CREATE INDEX "idx_export_files_task_id" ON "app"."export_files" ("task_id", "created_at" DESC);

CREATE INDEX "idx_export_files_source_type" ON "app"."export_files" ("source_type", "created_at" DESC);

CREATE INDEX "idx_export_files_created_at" ON "app"."export_files" ("created_at" DESC);

CREATE INDEX "idx_export_files_expiry" ON "app"."export_files" ("status", "expires_at");

CREATE INDEX "idx_lifecycle_items_review" ON "app"."file_lifecycle_items" ("scan_id", "review_status", "detected_file_type");

CREATE INDEX "idx_lifecycle_items_file" ON "app"."file_lifecycle_items" ("file_id");

CREATE INDEX "idx_lifecycle_items_source" ON "app"."file_lifecycle_items" ("scan_id", "source_type");

CREATE INDEX "idx_lifecycle_items_scan" ON "app"."file_lifecycle_items" ("scan_id", "classification", "created_at" DESC);

CREATE INDEX "idx_lifecycle_scans_status" ON "app"."file_lifecycle_scans" ("status", "created_at" DESC);

CREATE INDEX "idx_lifecycle_scans_created" ON "app"."file_lifecycle_scans" ("created_at" DESC);

CREATE INDEX "idx_quarantine_records_status" ON "app"."file_quarantine_records" ("status", "quarantined_at" DESC);

CREATE INDEX "idx_foundation_capabilities_lookup" ON "app"."foundation_account_capabilities" ("capability_code", "status", "account_id");

CREATE INDEX "idx_foundation_identity_entity" ON "app"."foundation_identity_links" ("entity_type", "entity_id", "match_status");

CREATE INDEX "idx_foundation_accounts_source_status" ON "app"."foundation_integration_accounts" ("source_system_code", "status", "display_name");

CREATE INDEX "idx_foundation_owners_status_name" ON "app"."foundation_owners" ("status", "display_name");

CREATE INDEX "idx_foundation_source_runs_status" ON "app"."foundation_source_runs" ("domain", "status", "created_at" DESC);

CREATE INDEX "idx_foundation_task_events_history" ON "app"."foundation_task_events" ("task_id", "task_version" DESC);

CREATE INDEX "idx_foundation_task_leases_expiry" ON "app"."foundation_task_leases" ("expires_at");

CREATE INDEX "idx_foundation_tasks_owner" ON "app"."foundation_tasks" ("owner_id", "state", "priority", "updated_at" DESC);

CREATE INDEX "idx_foundation_tasks_domain" ON "app"."foundation_tasks" ("domain", "task_kind", "state", "updated_at" DESC);

CREATE INDEX "idx_foundation_tasks_queue" ON "app"."foundation_tasks" ("state", "priority", "available_at", "created_at");

CREATE INDEX "idx_foundation_warehouses_country_status" ON "app"."foundation_warehouses" ("country_code", "identity_status", "display_name");

CREATE INDEX "idx_growth_analysis_runs_inventory" ON "app"."growth_analysis_runs" ("inventory_batch_id", "created_at" DESC);

CREATE INDEX "idx_growth_analysis_runs_published" ON "app"."growth_analysis_runs" ("status", "analysis_date" DESC, "published_at" DESC);

CREATE UNIQUE INDEX "uq_growth_country_mapping_sets_active" ON "app"."growth_country_mapping_sets" ("status") WHERE status = 'active';

CREATE INDEX "idx_growth_data_quality_status" ON "app"."growth_data_quality_issues" ("status", "severity", "created_at" DESC);

CREATE INDEX "idx_growth_focus_item_events_analysis" ON "app"."growth_focus_item_events" ("analysis_run_id", "event_type", "occurred_at" DESC);

CREATE INDEX "idx_growth_focus_item_events_history" ON "app"."growth_focus_item_events" ("focus_item_id", "task_revision" DESC);

CREATE INDEX "idx_growth_focus_items_warehouse" ON "app"."growth_focus_items" ("country_code", "normalized_warehouse_name", "normalized_source_sku", "status", "priority");

CREATE INDEX "idx_growth_focus_items_latest_run" ON "app"."growth_focus_items" ("last_analysis_run_id", "is_hit_in_latest_run", "task_type");

CREATE INDEX "idx_growth_focus_items_shop_queue" ON "app"."growth_focus_items" ("internal_shop_id", "status", "priority", "last_detected_at" DESC);

CREATE INDEX "idx_growth_focus_items_owner_queue" ON "app"."growth_focus_items" ("owner_user_id", "status", "priority", "is_hit_in_latest_run", "last_detected_at" DESC);

CREATE UNIQUE INDEX "uq_growth_focus_items_active_task" ON "app"."growth_focus_items" ("task_key") WHERE status IN (
    'NEW',
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'MONITORING',
    'BLOCKED',
    'REOPENED'
  );

CREATE INDEX "idx_growth_inventory_raw_rows_hash" ON "app"."growth_inventory_raw_rows" ("row_hash");

CREATE INDEX "idx_growth_inventory_snapshots_warehouse" ON "app"."growth_inventory_snapshots" ("normalized_warehouse_name", "snapshot_at");

CREATE UNIQUE INDEX "uq_growth_inventory_snapshot_grain" ON "app"."growth_inventory_snapshots" ("snapshot_at", "normalized_source_sku", "normalized_warehouse_name") WHERE normalized_source_sku <> '' AND normalized_warehouse_name <> '';

CREATE INDEX "idx_growth_inventory_snapshots_sku" ON "app"."growth_inventory_snapshots" ("normalized_source_sku", "snapshot_at");

CREATE INDEX "idx_growth_mapping_events_mapping" ON "app"."growth_mapping_events" ("mapping_type", "mapping_id", "occurred_at" DESC);

CREATE INDEX "idx_growth_mapping_issues_status" ON "app"."growth_mapping_issues" ("issue_type", "status", "created_at" DESC);

CREATE INDEX "idx_growth_order_headers_shop" ON "app"."growth_order_headers" ("platform", "normalized_source_shop_name", "paid_at");

CREATE INDEX "idx_growth_order_headers_batch" ON "app"."growth_order_headers" ("source_batch_id", "effective_status");

CREATE INDEX "idx_growth_order_inventory_links_batch_status" ON "app"."growth_order_inventory_links" ("inventory_source_batch_id", "match_status", "is_current");

CREATE INDEX "idx_growth_order_lines_sku_warehouse" ON "app"."growth_order_lines" ("normalized_source_sku", "normalized_source_warehouse_name", "is_current");

CREATE INDEX "idx_growth_order_lines_sku" ON "app"."growth_order_lines" ("normalized_source_sku", "mapped_country", "mapping_status");

CREATE INDEX "idx_growth_order_lines_order" ON "app"."growth_order_lines" ("order_header_id", "is_current", "source_row_number");

CREATE INDEX "idx_growth_order_raw_rows_hash" ON "app"."growth_order_raw_rows" ("row_hash");

CREATE UNIQUE INDEX "uq_growth_rule_sets_active" ON "app"."growth_rule_sets" ("status") WHERE status = 'active';

CREATE INDEX "idx_growth_shop_metrics_run" ON "app"."growth_shop_daily_metrics" ("analysis_run_id", "platform", "owner_user_id", "display_name");

CREATE INDEX "idx_growth_shop_sku_coverage_current" ON "app"."growth_shop_sku_coverage_snapshots" ("internal_shop_id", "expires_at" DESC);

CREATE INDEX "idx_growth_shop_sku_metrics_sales" ON "app"."growth_shop_sku_daily_metrics" ("analysis_run_id", "internal_shop_id", "own_sales_quantity_28d" DESC);

CREATE INDEX "idx_growth_shop_sku_metrics_focus" ON "app"."growth_shop_sku_daily_metrics" ("analysis_run_id", "internal_shop_id", "is_growth_focus_candidate", "is_key_performer");

CREATE INDEX "idx_growth_shop_sku_observations_shop" ON "app"."growth_shop_sku_observations" ("internal_shop_id", "normalized_source_sku", "last_observed_at" DESC);

CREATE INDEX "idx_growth_shop_mappings_status" ON "app"."growth_shop_source_mappings" ("mapping_status", "platform", "updated_at" DESC);

CREATE INDEX "idx_growth_shops_platform_country" ON "app"."growth_shops" ("platform", "country_code", "status");

CREATE INDEX "idx_growth_signals_warehouse" ON "app"."growth_signals" ("analysis_run_id", "country_code", "normalized_warehouse_name", "normalized_source_sku", "signal_type");

CREATE INDEX "idx_growth_signals_shop" ON "app"."growth_signals" ("analysis_run_id", "internal_shop_id", "signal_type", "severity");

CREATE INDEX "idx_growth_signals_sku" ON "app"."growth_signals" ("analysis_run_id", "normalized_source_sku", "internal_shop_id");

CREATE INDEX "idx_growth_signals_type" ON "app"."growth_signals" ("analysis_run_id", "signal_type", "severity", "rule_code");

CREATE INDEX "idx_growth_sku_metrics_product" ON "app"."growth_sku_daily_metrics" ("mapped_product_id", "analysis_date" DESC);

CREATE INDEX "idx_growth_sku_metrics_status" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "product_status", "quality_status");

CREATE INDEX "idx_growth_sku_metrics_supply_summary" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "scope_type", "scope_key", "supply_risk_warehouse_count" DESC);

CREATE INDEX "idx_growth_sku_metrics_demand" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "scope_type", "scope_key", "category_l2", "assortment_percentile" DESC);

CREATE INDEX "idx_growth_sku_warehouse_metrics_product" ON "app"."growth_sku_warehouse_daily_metrics" ("mapped_product_id", "analysis_date" DESC);

CREATE INDEX "idx_growth_sku_warehouse_metrics_sku" ON "app"."growth_sku_warehouse_daily_metrics" ("analysis_run_id", "country_code", "normalized_source_sku", "normalized_warehouse_name");

CREATE INDEX "idx_growth_sku_warehouse_metrics_risk" ON "app"."growth_sku_warehouse_daily_metrics" ("analysis_run_id", "country_code", "supply_status", "source_current_sellable_days", "normalized_warehouse_name");

CREATE INDEX "idx_growth_sku_warehouse_sales_metrics_grain" ON "app"."growth_sku_warehouse_sales_metrics" ("snapshot_at", "normalized_source_sku", "normalized_source_warehouse_name");

CREATE INDEX "idx_growth_source_batches_hash" ON "app"."growth_source_batches" ("source_type", "source_sha256");

CREATE INDEX "idx_growth_source_batches_type_created" ON "app"."growth_source_batches" ("source_type", "created_at" DESC);

CREATE INDEX "idx_growth_warehouse_country_mappings_country" ON "app"."growth_warehouse_country_mappings" ("mapping_set_id", "country_code", "mapping_status");

CREATE INDEX "idx_mabang_sku_image_batches_sync_run" ON "app"."mabang_sku_image_batches" ("sync_run_id", "segment_no");

CREATE UNIQUE INDEX "uq_mabang_sku_image_batches_sync_segment" ON "app"."mabang_sku_image_batches" ("sync_run_id", "segment_no") WHERE sync_run_id IS NOT NULL;

CREATE INDEX "idx_mabang_sku_image_batches_account" ON "app"."mabang_sku_image_batches" ("account_id", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_batches_status" ON "app"."mabang_sku_image_batches" ("status", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_checkpoints_batch" ON "app"."mabang_sku_image_checkpoints" ("batch_id", "page_number");

CREATE INDEX "idx_mabang_sku_image_discoveries_failed" ON "app"."mabang_sku_image_discoveries" ("batch_id", "download_status", "error_code");

CREATE INDEX "idx_mabang_sku_image_discoveries_sku" ON "app"."mabang_sku_image_discoveries" ("source_sku_normalized", "download_status");

CREATE INDEX "idx_mabang_sku_image_discoveries_batch" ON "app"."mabang_sku_image_discoveries" ("batch_id", "source_page", "source_row_number");

CREATE INDEX "idx_mabang_sku_image_discovery_images_url_asset" ON "app"."mabang_sku_image_discovery_images" ("source_url_hash", "asset_id");

CREATE INDEX "idx_mabang_sku_image_discovery_images_asset" ON "app"."mabang_sku_image_discovery_images" ("asset_id");

CREATE INDEX "idx_mabang_sku_image_discovery_images_status" ON "app"."mabang_sku_image_discovery_images" ("download_status", "last_checked_at");

CREATE INDEX "idx_mabang_sku_image_discovery_images_discovery" ON "app"."mabang_sku_image_discovery_images" ("discovery_id", "image_index");

CREATE INDEX "idx_mabang_sku_image_sync_runs_account" ON "app"."mabang_sku_image_sync_runs" ("account_id", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_sync_runs_status" ON "app"."mabang_sku_image_sync_runs" ("status", "created_at" DESC);

CREATE INDEX "idx_managed_files_job" ON "app"."managed_files" ("job_id", "source_type");

CREATE INDEX "idx_managed_files_source" ON "app"."managed_files" ("source_type", "status", "registered_at" DESC);

CREATE INDEX "idx_operation_audit_status" ON "app"."operation_audit_events" ("status", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_action" ON "app"."operation_audit_events" ("action", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_module" ON "app"."operation_audit_events" ("module", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_occurred_at" ON "app"."operation_audit_events" ("occurred_at" DESC);

CREATE INDEX "idx_price_control_automation_due" ON "app"."price_control_automation_settings" ("enabled", "next_run_at");

CREATE INDEX "idx_price_control_snapshots_lookup" ON "app"."price_control_price_snapshots" ("country_code", "sku", "effective_at" DESC);

CREATE INDEX "idx_price_control_batches_effective" ON "app"."price_control_source_batches" ("country_code", "effective_at" DESC, "apply_no");

CREATE INDEX "idx_price_control_sync_runs_status" ON "app"."price_control_sync_runs" ("status", "created_at" DESC);

CREATE INDEX "idx_product_ai_contents_context" ON "app"."product_ai_contents" ("product_sku_id", "context_hash", "created_at" DESC);

CREATE INDEX "idx_product_ai_contents_listing_type" ON "app"."product_ai_contents" ("listing_draft_id", "content_type", "created_at" DESC);

CREATE INDEX "idx_product_ai_contents_country_sku" ON "app"."product_ai_contents" ("country", "sku", "status", "updated_at" DESC);

CREATE INDEX "idx_product_ai_contents_product_status" ON "app"."product_ai_contents" ("product_sku_id", "content_type", "status", "version" DESC);

CREATE INDEX "idx_product_categories_parent" ON "app"."product_categories" ("parent_id", "status", "normalized_name");

CREATE INDEX "idx_product_cost_snapshots_sku" ON "app"."product_cost_snapshots" ("sku_id", "created_at" DESC);

CREATE INDEX "idx_product_override_events_sku" ON "app"."product_field_override_events" ("sku_id", "occurred_at" DESC);

CREATE INDEX "idx_product_field_overrides_active" ON "app"."product_field_overrides" ("sku_id", "deleted_at", "field_code");

CREATE INDEX "idx_product_identity_mappings_status" ON "app"."product_identity_mappings" ("mapping_status", "platform", "country_code", "updated_at" DESC);

CREATE INDEX "idx_product_image_generation_items_status" ON "app"."product_image_generation_items" ("status", "updated_at");

CREATE INDEX "idx_product_image_generation_items_task" ON "app"."product_image_generation_items" ("task_id", "slot_index");

CREATE INDEX "idx_product_image_generation_tasks_status" ON "app"."product_image_generation_tasks" ("status", "updated_at");

CREATE INDEX "idx_product_image_generation_tasks_product" ON "app"."product_image_generation_tasks" ("product_sku_id", "created_at" DESC);

CREATE INDEX "idx_product_images_sku" ON "app"."product_images" ("sku_id", "status", "is_primary" DESC, "sort_order", "created_at");

CREATE INDEX "idx_product_import_batches_status_created" ON "app"."product_import_batches" ("status", "created_at" DESC);

CREATE UNIQUE INDEX "idx_product_import_batches_file" ON "app"."product_import_batches" ("source_system", "file_sha256");

CREATE INDEX "idx_product_import_field_changes_filter" ON "app"."product_import_field_changes" ("import_batch_id", "country_raw", "sku_code", "field_name");

CREATE INDEX "idx_product_import_field_changes_batch" ON "app"."product_import_field_changes" ("import_batch_id", "source_row_number", "field_name");

CREATE INDEX "idx_product_import_issues_batch" ON "app"."product_import_issues" ("batch_id", "severity", "status", "source_row_number");

CREATE INDEX "idx_product_import_rows_source_identity" ON "app"."product_import_rows" ("batch_id", "source_row_key", "source_row_number");

CREATE INDEX "idx_product_import_rows_product_key" ON "app"."product_import_rows" ("product_key", "batch_id");

CREATE INDEX "idx_product_import_rows_source_sku" ON "app"."product_import_rows" ("source_sku");

CREATE INDEX "idx_product_import_rows_batch_outcome" ON "app"."product_import_rows" ("batch_id", "outcome", "source_row_number");

CREATE INDEX "idx_product_inventory_snapshots_sku" ON "app"."product_inventory_snapshots" ("sku_id", "captured_at" DESC);

CREATE INDEX "idx_product_listing_drafts_target" ON "app"."product_listing_drafts" ("platform", "country", "shop_key", "status");

CREATE INDEX "idx_product_listing_drafts_product" ON "app"."product_listing_drafts" ("product_sku_id", "status", "updated_at" DESC);

CREATE UNIQUE INDEX "uq_product_listing_drafts_active_target" ON "app"."product_listing_drafts" ("product_sku_id", "platform", "country", "shop_key") WHERE deleted_at IS NULL;

CREATE INDEX "idx_product_listing_publish_records_draft" ON "app"."product_listing_publish_records" ("listing_draft_id", "created_at" DESC);

CREATE INDEX "idx_product_media_assets_status" ON "app"."product_media_assets" ("status", "created_at" DESC);

CREATE INDEX "idx_product_media_assets_source" ON "app"."product_media_assets" ("source_system", "created_at" DESC);

CREATE INDEX "idx_product_media_links_sku" ON "app"."product_media_links" ("source_sku_normalized", "country_code", "mapping_status");

CREATE INDEX "idx_product_media_links_product" ON "app"."product_media_links" ("product_id", "mapping_status", "media_role", "linked_at");

CREATE INDEX "idx_product_package_rows_latest_batch" ON "app"."product_package_rows" ("latest_batch_id", "latest_source_row_number");

CREATE INDEX "idx_product_package_rows_product" ON "app"."product_package_rows" ("country_normalized", "sku_normalized", "warehouse_normalized", "row_occurrence");

CREATE INDEX "idx_product_price_changes_batch" ON "app"."product_price_change_events" ("source_apply_no", "detected_at" DESC);

CREATE INDEX "idx_product_price_changes_scope" ON "app"."product_price_change_events" ("country_code", "category_name", "sku", "direction", "detected_at" DESC);

CREATE INDEX "idx_product_price_changes_detected" ON "app"."product_price_change_events" ("detected_at" DESC, "id");

CREATE INDEX "idx_product_sku_current_prices_scope" ON "app"."product_sku_current_prices" ("country_code", "sku", "platform", "shop_type", "price_type");

CREATE INDEX "idx_product_sku_lifecycle_status" ON "app"."product_sku_lifecycle" ("status_code", "updated_at" DESC);

CREATE INDEX "idx_product_lifecycle_events_sku" ON "app"."product_sku_lifecycle_events" ("sku_id", "occurred_at" DESC);

CREATE INDEX "idx_product_skus_deleted" ON "app"."product_skus" ("deleted_at", "country_raw", "sku_code_normalized");

CREATE INDEX "idx_product_skus_sku_code" ON "app"."product_skus" ("sku_code_normalized", "country_raw");

CREATE UNIQUE INDEX "idx_product_skus_country_sku" ON "app"."product_skus" ("source_system", "country_raw", "sku_code_normalized");

CREATE INDEX "idx_product_skus_name" ON "app"."product_skus" ("source_product_name");

CREATE INDEX "idx_product_skus_category" ON "app"."product_skus" ("category_id", "archived_at");

CREATE INDEX "idx_product_skus_model" ON "app"."product_skus" ("model_id", "archived_at");

CREATE INDEX "idx_run_events_run" ON "app"."scheduled_export_run_events" ("run_id", "id");

CREATE INDEX "idx_scheduled_export_runs_task" ON "app"."scheduled_export_runs" ("task_id", "created_at" DESC);

CREATE INDEX "idx_scheduled_export_runs_status" ON "app"."scheduled_export_runs" ("status", "scheduled_run_at");

CREATE INDEX "idx_scheduled_export_tasks_deleted_at" ON "app"."scheduled_export_tasks" ("deleted_at");

CREATE INDEX "idx_scheduled_export_tasks_due" ON "app"."scheduled_export_tasks" ("enabled", "next_run_at");

CREATE UNIQUE INDEX "uq_price_control_one_running_sync" ON "app"."price_control_sync_runs" ((1)) WHERE status='RUNNING';

CREATE VIEW "app"."foundation_open_tasks_v" AS
SELECT *
FROM foundation_tasks
WHERE state IN (
  'PENDING',
  'READY',
  'RUNNING',
  'PAUSE_REQUESTED',
  'PAUSED',
  'BLOCKED',
  'RETRY_WAIT'
);

CREATE VIEW "app"."foundation_owner_master_v" AS
SELECT
  id,
  display_name,
  source_system_code,
  external_key,
  status,
  metadata_json,
  created_at,
  updated_at
FROM foundation_owners;

CREATE VIEW "app"."foundation_product_master_v" AS
SELECT
  id,
  source_system,
  source_main_sku,
  canonical_name,
  category_id,
  identity_status,
  revision,
  created_at,
  updated_at,
  inactive_at
FROM product_models;

CREATE VIEW "app"."foundation_sku_master_v" AS
SELECT
  id,
  source_system,
  source_sku,
  normalized_sku,
  source_product_name,
  model_id,
  category_id,
  source_main_sku,
  source_style_code,
  source_style_name,
  source_sales_spec,
  source_status_raw,
  CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycle_status,
  revision,
  created_at,
  updated_at,
  archived_at
FROM product_skus;

CREATE VIEW "app"."foundation_store_master_v" AS
SELECT
  id,
  internal_shop_code,
  display_name,
  platform,
  country_code,
  country_name,
  owner_user_id,
  status,
  identity_status,
  revision,
  created_at,
  updated_at
FROM growth_shops;

CREATE VIEW "app"."foundation_task_domain_summary_v" AS
SELECT
  domain,
  state,
  COUNT(*) AS task_count,
  MIN(created_at) AS oldest_created_at,
  MAX(updated_at) AS latest_updated_at
FROM foundation_tasks
GROUP BY domain, state;

CREATE VIEW "app"."foundation_warehouse_master_v" AS
SELECT
  id,
  canonical_key,
  display_name,
  normalized_name,
  country_code,
  country_name,
  identity_status,
  metadata_json,
  created_at,
  updated_at
FROM foundation_warehouses;

CREATE VIEW "app"."growth_latest_published_run_v" AS
SELECT *
FROM growth_analysis_runs
WHERE id = (
  SELECT id
  FROM growth_analysis_runs
  WHERE status = 'published'
  ORDER BY analysis_date DESC, published_at DESC, id DESC
  LIMIT 1
);

CREATE VIEW "app"."growth_open_focus_items_v" AS
SELECT *
FROM growth_focus_items
WHERE status IN (
  'NEW',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'MONITORING',
  'BLOCKED',
  'REOPENED'
);

CREATE VIEW "app"."growth_latest_shop_metrics_v" AS
SELECT metric.*
FROM growth_shop_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW "app"."growth_latest_shop_sku_metrics_v" AS
SELECT metric.*
FROM growth_shop_sku_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW "app"."growth_latest_signals_v" AS
SELECT signal.*
FROM growth_signals signal
JOIN growth_latest_published_run_v latest ON latest.id = signal.analysis_run_id;

CREATE VIEW "app"."growth_latest_sku_metrics_v" AS
SELECT metric.*
FROM growth_sku_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW "app"."growth_latest_sku_warehouse_metrics_v" AS
SELECT metric.*
FROM growth_sku_warehouse_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW "app"."growth_latest_country_supply_summary_v" AS
SELECT
  metric.analysis_run_id,
  metric.country_code,
  COUNT(DISTINCT metric.normalized_warehouse_name) AS warehouse_count,
  COUNT(DISTINCT metric.normalized_source_sku) AS affected_sku_count,
  SUM(CASE WHEN metric.supply_status = 'OUT_OF_STOCK' THEN 1 ELSE 0 END)
    AS out_of_stock_count,
  SUM(CASE WHEN metric.supply_status = 'IN_TRANSIT_ONLY' THEN 1 ELSE 0 END)
    AS in_transit_only_count,
  SUM(CASE WHEN metric.supply_status = 'SUPPLY_CRITICAL' THEN 1 ELSE 0 END)
    AS critical_count,
  SUM(CASE WHEN metric.supply_status = 'SUPPLY_WARNING' THEN 1 ELSE 0 END)
    AS warning_count,
  SUM(CASE
    WHEN metric.supply_status IN ('SUPPLY_DATA_INSUFFICIENT', 'SUPPLY_DATA_CONFLICT')
    THEN 1 ELSE 0
  END) AS data_issue_count,
  SUM(metric.available_quantity) AS available_quantity,
  SUM(metric.in_transit_quantity) AS in_transit_quantity
FROM growth_latest_sku_warehouse_metrics_v metric
GROUP BY metric.analysis_run_id, metric.country_code;
