# Shopee Open Platform V2 全量接口评估

> 审计日期：2026-08-04；来源：Shopee Open Platform 官方 V2 文档左侧完整目录。

## 覆盖结果

- 左侧原始接口节点：448
- 去重后目录项：443
- 正常 V2 接口：441
- 官方标记即将下线：2
- 模块数量：29

标签：`CORE` 当前基础能力；`NEXT` 下一阶段；`LATER-READ` 后续只读；`CONTROLLED-WRITE` 受控写入；`LATER` 非当前主线；`CONDITIONAL` 条件接入；`OFFLINE` 不新接。

## 项目结论

1. 第一主线：`Public + Shop + Merchant + Product + Order + Logistics + Push`。
2. 第二主线：`Ads` 替换当前 Shopee 广告 CSV 人工导入。
3. 第三主线：`Payment + Returns + AccountHealth` 补齐利润、售后和风险。
4. `AMS` 是联盟营销，不是站内广告；先读后写。
5. 马帮和 Shopee API 必须确定唯一履约写入方。

## 模块总览

| 模块 | 接口数 | 判断 |
| --- | ---: | --- |
| AccountHealth / 店铺健康 | 6 | 下一阶段 |
| Add-On Deal / 加购优惠 | 14 | 后续受控写入 |
| Ads / 站内广告 | 25 | 立即接入只读 |
| AMS / 联盟营销 | 36 | 后续接入 |
| Bundle Deal / 套装优惠 | 10 | 后续受控写入 |
| Discount / 折扣 | 12 | 后续受控写入 |
| FBS | 4 | 条件接入 |
| FirstMile / 首公里 | 16 | 条件接入 |
| Follow Prize / 关注礼 | 6 | 低优先级 |
| GlobalProduct / 全球商品 | 34 | 条件接入 |
| Livestream / 直播 | 25 | 条件接入 |
| Logistics / 物流 | 46 | 立即读、后续写 |
| Media | 6 | 后续接入 |
| MediaSpace | 6 | 条件接入 |
| Merchant / 商户 | 6 | 立即接入 |
| Order / 订单 | 22 | 立即接入只读 |
| Payment / 财务 | 18 | 下一阶段 |
| BrandPortal / 品牌门户 | 11 | 暂不接入 |
| Product / 本地商品 | 58 | 立即接入只读 |
| Public / 授权 | 6 | 立即接入 |
| Push / 消息推送 | 4 | 立即接入 |
| Returns / 售后 | 15 | 下一阶段 |
| SBS | 5 | 条件接入 |
| Shop / 店铺 | 9 | 立即接入 |
| ShopCategory / 店铺分类 | 7 | 后续接入 |
| ShopFlashSale / 店铺秒杀 | 11 | 后续受控写入 |
| TopPicks / 精选商品 | 4 | 低优先级 |
| Video / Shopee Video | 15 | 条件接入 |
| Voucher / 优惠券 | 6 | 后续受控写入 |

## 完整接口目录

### AMS / 联盟营销

- `LATER-READ` [v2.ams.get_open_campaign_added_product](https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product) — 文档 ID 2667
- `LATER-READ` [v2.ams.get_open_campaign_not_added_product](https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_not_added_product) — 文档 ID 2666
- `LATER` [v2.ams.batch_add_products_to_open_campaign](https://open.shopee.com/documents/v2/v2.ams.batch_add_products_to_open_campaign) — 文档 ID 2672
- `CONTROLLED-WRITE` [v2.ams.add_all_products_to_open_campaign](https://open.shopee.com/documents/v2/v2.ams.add_all_products_to_open_campaign) — 文档 ID 2673
- `LATER-READ` [v2.ams.get_auto_add_new_product_toggle_status](https://open.shopee.com/documents/v2/v2.ams.get_auto_add_new_product_toggle_status) — 文档 ID 2671
- `CONTROLLED-WRITE` [v2.ams.update_auto_add_new_product_setting](https://open.shopee.com/documents/v2/v2.ams.update_auto_add_new_product_setting) — 文档 ID 2677
- `LATER` [v2.ams.batch_edit_products_open_campaign_setting](https://open.shopee.com/documents/v2/v2.ams.batch_edit_products_open_campaign_setting) — 文档 ID 2675
- `CONTROLLED-WRITE` [v2.ams.edit_all_products_open_campaign_setting](https://open.shopee.com/documents/v2/v2.ams.edit_all_products_open_campaign_setting) — 文档 ID 2676
- `LATER` [v2.ams.batch_remove_products_open_campaign_setting](https://open.shopee.com/documents/v2/v2.ams.batch_remove_products_open_campaign_setting) — 文档 ID 2678
- `CONTROLLED-WRITE` [v2.ams.remove_all_products_open_campaign_setting](https://open.shopee.com/documents/v2/v2.ams.remove_all_products_open_campaign_setting) — 文档 ID 2679
- `LATER-READ` [v2.ams.get_open_campaign_batch_task_result](https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_batch_task_result) — 文档 ID 2674
- `LATER-READ` [v2.ams.get_optimization_suggestion_product](https://open.shopee.com/documents/v2/v2.ams.get_optimization_suggestion_product) — 文档 ID 2668
- `LATER-READ` [v2.ams.batch_get_products_suggested_rate](https://open.shopee.com/documents/v2/v2.ams.batch_get_products_suggested_rate) — 文档 ID 2669
- `LATER-READ` [v2.ams.get_shop_suggested_rate](https://open.shopee.com/documents/v2/v2.ams.get_shop_suggested_rate) — 文档 ID 2670
- `LATER-READ` [v2.ams.get_targeted_campaign_addable_product_list](https://open.shopee.com/documents/v2/v2.ams.get_targeted_campaign_addable_product_list) — 文档 ID 2684
- `LATER-READ` [v2.ams.get_recommended_affiliate_list](https://open.shopee.com/documents/v2/v2.ams.get_recommended_affiliate_list) — 文档 ID 2685
- `LATER-READ` [v2.ams.get_managed_affiliate_list](https://open.shopee.com/documents/v2/v2.ams.get_managed_affiliate_list) — 文档 ID 2686
- `LATER-READ` [v2.ams.query_affiliate_list](https://open.shopee.com/documents/v2/v2.ams.query_affiliate_list) — 文档 ID 2721
- `CONTROLLED-WRITE` [v2.ams.create_new_targeted_campaign](https://open.shopee.com/documents/v2/v2.ams.create_new_targeted_campaign) — 文档 ID 2687
- `LATER-READ` [v2.ams.get_targeted_campaign_list](https://open.shopee.com/documents/v2/v2.ams.get_targeted_campaign_list) — 文档 ID 2681
- `LATER-READ` [v2.ams.get_targeted_campaign_settings](https://open.shopee.com/documents/v2/v2.ams.get_targeted_campaign_settings) — 文档 ID 2682
- `CONTROLLED-WRITE` [v2.ams.update_basic_info_of_targeted_campaign](https://open.shopee.com/documents/v2/v2.ams.update_basic_info_of_targeted_campaign) — 文档 ID 2692
- `CONTROLLED-WRITE` [v2.ams.edit_product_list_of_targeted_campaign](https://open.shopee.com/documents/v2/v2.ams.edit_product_list_of_targeted_campaign) — 文档 ID 2688
- `CONTROLLED-WRITE` [v2.ams.edit_affiliate_list_of_targeted_campaign](https://open.shopee.com/documents/v2/v2.ams.edit_affiliate_list_of_targeted_campaign) — 文档 ID 2689
- `CONTROLLED-WRITE` [v2.ams.terminate_targeted_campaign](https://open.shopee.com/documents/v2/v2.ams.terminate_targeted_campaign) — 文档 ID 2693
- `LATER-READ` [v2.ams.get_performance_data_update_time](https://open.shopee.com/documents/v2/v2.ams.get_performance_data_update_time) — 文档 ID 2729
- `LATER-READ` [v2.ams.get_shop_performance](https://open.shopee.com/documents/v2/v2.ams.get_shop_performance) — 文档 ID 2718
- `LATER-READ` [v2.ams.get_product_performance](https://open.shopee.com/documents/v2/v2.ams.get_product_performance) — 文档 ID 2719
- `LATER-READ` [v2.ams.get_affiliate_performance](https://open.shopee.com/documents/v2/v2.ams.get_affiliate_performance) — 文档 ID 2720
- `LATER-READ` [v2.ams.get_content_performance](https://open.shopee.com/documents/v2/v2.ams.get_content_performance) — 文档 ID 2723
- `LATER-READ` [v2.ams.get_campaign_key_metrics_performance](https://open.shopee.com/documents/v2/v2.ams.get_campaign_key_metrics_performance) — 文档 ID 2724
- `LATER-READ` [v2.ams.get_open_campaign_performance](https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_performance) — 文档 ID 2725
- `LATER-READ` [v2.ams.get_targeted_campaign_performance](https://open.shopee.com/documents/v2/v2.ams.get_targeted_campaign_performance) — 文档 ID 2726
- `LATER-READ` [v2.ams.get_conversion_report](https://open.shopee.com/documents/v2/v2.ams.get_conversion_report) — 文档 ID 2727
- `LATER-READ` [v2.ams.get_validation_list](https://open.shopee.com/documents/v2/v2.ams.get_validation_list) — 文档 ID 2680
- `LATER-READ` [v2.ams.get_validation_report](https://open.shopee.com/documents/v2/v2.ams.get_validation_report) — 文档 ID 2728

### Video / Shopee Video

- `CONDITIONAL` [v2.video.get_cover_list](https://open.shopee.com/documents/v2/v2.video.get_cover_list) — 文档 ID 2735
- `CONDITIONAL` [v2.video.edit_video_info](https://open.shopee.com/documents/v2/v2.video.edit_video_info) — 文档 ID 2737
- `CONDITIONAL` [v2.video.post_video](https://open.shopee.com/documents/v2/v2.video.post_video) — 文档 ID 2738
- `CONDITIONAL` [v2.video.get_video_list](https://open.shopee.com/documents/v2/v2.video.get_video_list) — 文档 ID 2743
- `CONDITIONAL` [v2.video.get_video_detail](https://open.shopee.com/documents/v2/v2.video.get_video_detail) — 文档 ID 2740
- `CONDITIONAL` [v2.video.delete_video](https://open.shopee.com/documents/v2/v2.video.delete_video) — 文档 ID 2739
- `CONDITIONAL` [v2.video.get_overview_performance](https://open.shopee.com/documents/v2/v2.video.get_overview_performance) — 文档 ID 2744
- `CONDITIONAL` [v2.video.get_metric_trend](https://open.shopee.com/documents/v2/v2.video.get_metric_trend) — 文档 ID 2745
- `CONDITIONAL` [v2.video.get_user_demographics](https://open.shopee.com/documents/v2/v2.video.get_user_demographics) — 文档 ID 2746
- `CONDITIONAL` [v2.video.get_video_performance_list](https://open.shopee.com/documents/v2/v2.video.get_video_performance_list) — 文档 ID 2747
- `CONDITIONAL` [v2.video.get_prodcut_performance_list](https://open.shopee.com/documents/v2/v2.video.get_prodcut_performance_list) — 文档 ID 2748
- `CONDITIONAL` [v2.video.get_video_detail_performance](https://open.shopee.com/documents/v2/v2.video.get_video_detail_performance) — 文档 ID 2842
- `CONDITIONAL` [v2.video.get_video_detail_metric_trend](https://open.shopee.com/documents/v2/v2.video.get_video_detail_metric_trend) — 文档 ID 2843
- `CONDITIONAL` [v2.video.get_video_detail_audience_distribution](https://open.shopee.com/documents/v2/v2.video.get_video_detail_audience_distribution) — 文档 ID 2844
- `CONDITIONAL` [v2.video.get_video_detail_product_performance](https://open.shopee.com/documents/v2/v2.video.get_video_detail_product_performance) — 文档 ID 2845

### Product / 本地商品

- `CORE` [v2.product.get_category](https://open.shopee.com/documents/v2/v2.product.get_category) — 文档 ID 653
- `CORE` [v2.product.get_attribute_tree](https://open.shopee.com/documents/v2/v2.product.get_attribute_tree) — 文档 ID 1825
- `CORE` [v2.product.get_brand_list](https://open.shopee.com/documents/v2/v2.product.get_brand_list) — 文档 ID 684
- `CORE` [v2.product.get_item_limit](https://open.shopee.com/documents/v2/v2.product.get_item_limit) — 文档 ID 629
- `CORE` [v2.product.get_item_list](https://open.shopee.com/documents/v2/v2.product.get_item_list) — 文档 ID 614
- `CORE` [v2.product.get_item_base_info](https://open.shopee.com/documents/v2/v2.product.get_item_base_info) — 文档 ID 612
- `CORE` [v2.product.get_item_extra_info](https://open.shopee.com/documents/v2/v2.product.get_item_extra_info) — 文档 ID 613
- `CONTROLLED-WRITE` [v2.product.add_item](https://open.shopee.com/documents/v2/v2.product.add_item) — 文档 ID 616
- `CONTROLLED-WRITE` [v2.product.update_item](https://open.shopee.com/documents/v2/v2.product.update_item) — 文档 ID 617
- `CONTROLLED-WRITE` [v2.product.delete_item](https://open.shopee.com/documents/v2/v2.product.delete_item) — 文档 ID 615
- `LATER` [v2.product.init_tier_variation](https://open.shopee.com/documents/v2/v2.product.init_tier_variation) — 文档 ID 646
- `CONTROLLED-WRITE` [v2.product.update_tier_variation](https://open.shopee.com/documents/v2/v2.product.update_tier_variation) — 文档 ID 647
- `CORE` [v2.product.get_model_list](https://open.shopee.com/documents/v2/v2.product.get_model_list) — 文档 ID 618
- `CONTROLLED-WRITE` [v2.product.add_model](https://open.shopee.com/documents/v2/v2.product.add_model) — 文档 ID 649
- `CONTROLLED-WRITE` [v2.product.update_model](https://open.shopee.com/documents/v2/v2.product.update_model) — 文档 ID 648
- `CONTROLLED-WRITE` [v2.product.delete_model](https://open.shopee.com/documents/v2/v2.product.delete_model) — 文档 ID 650
- `CONTROLLED-WRITE` [v2.product.unlist_item](https://open.shopee.com/documents/v2/v2.product.unlist_item) — 文档 ID 622
- `CONTROLLED-WRITE` [v2.product.update_price](https://open.shopee.com/documents/v2/v2.product.update_price) — 文档 ID 651
- `CONTROLLED-WRITE` [v2.product.update_stock](https://open.shopee.com/documents/v2/v2.product.update_stock) — 文档 ID 652
- `CONTROLLED-WRITE` [v2.product.boost_item](https://open.shopee.com/documents/v2/v2.product.boost_item) — 文档 ID 624
- `CORE` [v2.product.get_boosted_list](https://open.shopee.com/documents/v2/v2.product.get_boosted_list) — 文档 ID 626
- `CORE` [v2.product.get_item_promotion](https://open.shopee.com/documents/v2/v2.product.get_item_promotion) — 文档 ID 661
- `CONTROLLED-WRITE` [v2.product.update_sip_item_price](https://open.shopee.com/documents/v2/v2.product.update_sip_item_price) — 文档 ID 662
- `CORE` [v2.product.search_item](https://open.shopee.com/documents/v2/v2.product.search_item) — 文档 ID 701
- `CORE` [v2.product.get_comment](https://open.shopee.com/documents/v2/v2.product.get_comment) — 文档 ID 562
- `CONTROLLED-WRITE` [v2.product.reply_comment](https://open.shopee.com/documents/v2/v2.product.reply_comment) — 文档 ID 563
- `CORE` [v2.product.category_recommend](https://open.shopee.com/documents/v2/v2.product.category_recommend) — 文档 ID 702
- `LATER` [v2.product.register_brand](https://open.shopee.com/documents/v2/v2.product.register_brand) — 文档 ID 743
- `CORE` [v2.product.get_recommend_attribute](https://open.shopee.com/documents/v2/v2.product.get_recommend_attribute) — 文档 ID 750
- `CORE` [v2.product.get_weight_recommendation](https://open.shopee.com/documents/v2/v2.product.get_weight_recommendation) — 文档 ID 1800
- `CORE` [v2.product.get_size_chart_list](https://open.shopee.com/documents/v2/v2.product.get_size_chart_list) — 文档 ID 1801
- `CORE` [v2.product.get_size_chart_detail](https://open.shopee.com/documents/v2/v2.product.get_size_chart_detail) — 文档 ID 1802
- `CORE` [v2.product.get_item_violation_info](https://open.shopee.com/documents/v2/v2.product.get_item_violation_info) — 文档 ID 1862
- `CORE` [v2.product.get_variations](https://open.shopee.com/documents/v2/v2.product.get_variations) — 文档 ID 1981
- `CORE` [v2.product.get_all_vehicle_list](https://open.shopee.com/documents/v2/v2.product.get_all_vehicle_list) — 文档 ID 2136
- `CORE` [v2.product.get_vehicle_list_by_compatibility_detail](https://open.shopee.com/documents/v2/v2.product.get_vehicle_list_by_compatibility_detail) — 文档 ID 2138
- `CORE` [v2.product.get_item_content_diagnosis_result](https://open.shopee.com/documents/v2/v2.product.get_item_content_diagnosis_result) — 文档 ID 2208
- `CORE` [v2.product.get_item_list_by_content_diagnosis](https://open.shopee.com/documents/v2/v2.product.get_item_list_by_content_diagnosis) — 文档 ID 2210
- `CORE` [v2.product.get_kit_item_limit](https://open.shopee.com/documents/v2/v2.product.get_kit_item_limit) — 文档 ID 2241
- `CONTROLLED-WRITE` [v2.product.add_kit_item](https://open.shopee.com/documents/v2/v2.product.add_kit_item) — 文档 ID 2242
- `CONTROLLED-WRITE` [v2.product.update_kit_item](https://open.shopee.com/documents/v2/v2.product.update_kit_item) — 文档 ID 2247
- `CORE` [v2.product.get_kit_item_info](https://open.shopee.com/documents/v2/v2.product.get_kit_item_info) — 文档 ID 2248
- `CORE` [v2.product.get_aitem_by_pitem_id](https://open.shopee.com/documents/v2/v2.product.get_aitem_by_pitem_id) — 文档 ID 2318
- `CORE` [v2.product.search_attribute_value_list](https://open.shopee.com/documents/v2/v2.product.search_attribute_value_list) — 文档 ID 2401
- `CORE` [v2.product.get_main_item_list](https://open.shopee.com/documents/v2/v2.product.get_main_item_list) — 文档 ID 2447
- `CORE` [v2.product.get_direct_item_list](https://open.shopee.com/documents/v2/v2.product.get_direct_item_list) — 文档 ID 2448
- `CORE` [v2.product.get_direct_shop_recommended_price](https://open.shopee.com/documents/v2/v2.product.get_direct_shop_recommended_price) — 文档 ID 2450
- `CORE` [v2.product.get_product_certification_rule](https://open.shopee.com/documents/v2/v2.product.get_product_certification_rule) — 文档 ID 2470
- `LATER` [v2.product.publish_item_to_outlet_shop](https://open.shopee.com/documents/v2/v2.product.publish_item_to_outlet_shop) — 文档 ID 2506
- `CORE` [v2.product.get_mart_item_mapping_by_id](https://open.shopee.com/documents/v2/v2.product.get_mart_item_mapping_by_id) — 文档 ID 2507
- `CORE` [v2.product.search_unpackaged_model_list](https://open.shopee.com/documents/v2/v2.product.search_unpackaged_model_list) — 文档 ID 2576
- `LATER` [v2.product.generate_kit_image](https://open.shopee.com/documents/v2/v2.product.generate_kit_image) — 文档 ID 2868
- `CORE` [v2.product.get_mart_item_by_outlet_item_id](https://open.shopee.com/documents/v2/v2.product.get_mart_item_by_outlet_item_id) — 文档 ID 3246
- `LATER` [v2.product.batch_update_outlet_price](https://open.shopee.com/documents/v2/v2.product.batch_update_outlet_price) — 文档 ID 3276
- `LATER` [v2.product.batch_update_outlet_stock](https://open.shopee.com/documents/v2/v2.product.batch_update_outlet_stock) — 文档 ID 3277
- `CORE` [v2.product.get_batch_task_result](https://open.shopee.com/documents/v2/v2.product.get_batch_task_result) — 文档 ID 3278
- `LATER` [v2.product.batch_add_item](https://open.shopee.com/documents/v2/v2.product.batch_add_item) — 文档 ID 3279
- `LATER` [v2.product.batch_publish_item_to_outlet_shop](https://open.shopee.com/documents/v2/v2.product.batch_publish_item_to_outlet_shop) — 文档 ID 3280

### GlobalProduct / 全球商品

- `CONDITIONAL` [v2.global_product.get_category](https://open.shopee.com/documents/v2/v2.global_product.get_category) — 文档 ID 654
- `CONDITIONAL` [v2.global_product.get_attribute_tree](https://open.shopee.com/documents/v2/v2.global_product.get_attribute_tree) — 文档 ID 1827
- `CONDITIONAL` [v2.global_product.get_brand_list](https://open.shopee.com/documents/v2/v2.global_product.get_brand_list) — 文档 ID 703
- `CONDITIONAL` [v2.global_product.get_global_item_limit](https://open.shopee.com/documents/v2/v2.global_product.get_global_item_limit) — 文档 ID 637
- `CONDITIONAL` [v2.global_product.get_global_item_list](https://open.shopee.com/documents/v2/v2.global_product.get_global_item_list) — 文档 ID 640
- `CONDITIONAL` [v2.global_product.get_global_item_info](https://open.shopee.com/documents/v2/v2.global_product.get_global_item_info) — 文档 ID 644
- `CONDITIONAL` [v2.global_product.add_global_item](https://open.shopee.com/documents/v2/v2.global_product.add_global_item) — 文档 ID 611
- `CONDITIONAL` [v2.global_product.update_global_item](https://open.shopee.com/documents/v2/v2.global_product.update_global_item) — 文档 ID 620
- `CONDITIONAL` [v2.global_product.delete_global_item](https://open.shopee.com/documents/v2/v2.global_product.delete_global_item) — 文档 ID 621
- `CONDITIONAL` [v2.global_product.init_tier_variation](https://open.shopee.com/documents/v2/v2.global_product.init_tier_variation) — 文档 ID 635
- `CONDITIONAL` [v2.global_product.update_tier_variation](https://open.shopee.com/documents/v2/v2.global_product.update_tier_variation) — 文档 ID 636
- `CONDITIONAL` [v2.global_product.add_global_model](https://open.shopee.com/documents/v2/v2.global_product.add_global_model) — 文档 ID 643
- `CONDITIONAL` [v2.global_product.update_global_model](https://open.shopee.com/documents/v2/v2.global_product.update_global_model) — 文档 ID 645
- `CONDITIONAL` [v2.global_product.delete_global_model](https://open.shopee.com/documents/v2/v2.global_product.delete_global_model) — 文档 ID 638
- `CONDITIONAL` [v2.global_product.get_global_model_list](https://open.shopee.com/documents/v2/v2.global_product.get_global_model_list) — 文档 ID 623
- `CONDITIONAL` [v2.global_product.support_size_chart](https://open.shopee.com/documents/v2/v2.global_product.support_size_chart) — 文档 ID 632
- `CONDITIONAL` [v2.global_product.update_size_chart](https://open.shopee.com/documents/v2/v2.global_product.update_size_chart) — 文档 ID 625
- `CONDITIONAL` [v2.global_product.create_publish_task](https://open.shopee.com/documents/v2/v2.global_product.create_publish_task) — 文档 ID 639
- `CONDITIONAL` [v2.global_product.get_publishable_shop](https://open.shopee.com/documents/v2/v2.global_product.get_publishable_shop) — 文档 ID 630
- `CONDITIONAL` [v2.global_product.get_publish_task_result](https://open.shopee.com/documents/v2/v2.global_product.get_publish_task_result) — 文档 ID 627
- `CONDITIONAL` [v2.global_product.get_published_list](https://open.shopee.com/documents/v2/v2.global_product.get_published_list) — 文档 ID 633
- `CONDITIONAL` [v2.global_product.update_price](https://open.shopee.com/documents/v2/v2.global_product.update_price) — 文档 ID 642
- `CONDITIONAL` [v2.global_product.update_stock](https://open.shopee.com/documents/v2/v2.global_product.update_stock) — 文档 ID 641
- `CONDITIONAL` [v2.global_product.set_sync_field](https://open.shopee.com/documents/v2/v2.global_product.set_sync_field) — 文档 ID 656
- `CONDITIONAL` [v2.global_product.get_global_item_id](https://open.shopee.com/documents/v2/v2.global_product.get_global_item_id) — 文档 ID 657
- `CONDITIONAL` [v2.global_product.category_recommend](https://open.shopee.com/documents/v2/v2.global_product.category_recommend) — 文档 ID 705
- `CONDITIONAL` [v2.global_product.get_recommend_attribute](https://open.shopee.com/documents/v2/v2.global_product.get_recommend_attribute) — 文档 ID 751
- `CONDITIONAL` [v2.global_product.get_shop_publishable_status](https://open.shopee.com/documents/v2/v2.global_product.get_shop_publishable_status) — 文档 ID 1902
- `CONDITIONAL` [v2.global_product.get_variations](https://open.shopee.com/documents/v2/v2.global_product.get_variations) — 文档 ID 1990
- `CONDITIONAL` [v2.global_product.get_size_chart_detail](https://open.shopee.com/documents/v2/v2.global_product.get_size_chart_detail) — 文档 ID 2334
- `CONDITIONAL` [v2.global_product.get_size_chart_list](https://open.shopee.com/documents/v2/v2.global_product.get_size_chart_list) — 文档 ID 2335
- `CONDITIONAL` [v2.global_product.search_global_attribute_value_list](https://open.shopee.com/documents/v2/v2.global_product.search_global_attribute_value_list) — 文档 ID 2399
- `CONDITIONAL` [v2.global_product.get_local_adjustment_rate](https://open.shopee.com/documents/v2/v2.global_product.get_local_adjustment_rate) — 文档 ID 2640
- `CONDITIONAL` [v2.global_product.update_local_adjustment_rate](https://open.shopee.com/documents/v2/v2.global_product.update_local_adjustment_rate) — 文档 ID 2641

### MediaSpace

- `CONDITIONAL` [v2.media_space.init_video_upload](https://open.shopee.com/documents/v2/v2.media_space.init_video_upload) — 文档 ID 531
- `CONDITIONAL` [v2.media_space.upload_video_part](https://open.shopee.com/documents/v2/v2.media_space.upload_video_part) — 文档 ID 532
- `CONDITIONAL` [v2.media_space.complete_video_upload](https://open.shopee.com/documents/v2/v2.media_space.complete_video_upload) — 文档 ID 533
- `CONDITIONAL` [v2.media_space.get_video_upload_result](https://open.shopee.com/documents/v2/v2.media_space.get_video_upload_result) — 文档 ID 534
- `CONDITIONAL` [v2.media_space.cancel_video_upload](https://open.shopee.com/documents/v2/v2.media_space.cancel_video_upload) — 文档 ID 535
- `CONDITIONAL` [v2.media_space.upload_image](https://open.shopee.com/documents/v2/v2.media_space.upload_image) — 文档 ID 660

### Media

- `CONTROLLED-WRITE` [v2.media.upload_image](https://open.shopee.com/documents/v2/v2.media.upload_image) — 文档 ID 2761
- `LATER` [v2.media.init_video_upload](https://open.shopee.com/documents/v2/v2.media.init_video_upload) — 文档 ID 2818
- `CONTROLLED-WRITE` [v2.media.upload_video_part](https://open.shopee.com/documents/v2/v2.media.upload_video_part) — 文档 ID 2819
- `LATER` [v2.media.complete_video_upload](https://open.shopee.com/documents/v2/v2.media.complete_video_upload) — 文档 ID 2820
- `LATER` [v2.media.get_video_upload_result](https://open.shopee.com/documents/v2/v2.media.get_video_upload_result) — 文档 ID 2821
- `CONTROLLED-WRITE` [v2.media.cancel_video_upload](https://open.shopee.com/documents/v2/v2.media.cancel_video_upload) — 文档 ID 2822

### Shop / 店铺

- `CORE` [v2.shop.get_shop_info](https://open.shopee.com/documents/v2/v2.shop.get_shop_info) — 文档 ID 536
- `CORE` [v2.shop.get_profile](https://open.shopee.com/documents/v2/v2.shop.get_profile) — 文档 ID 584
- `CONTROLLED-WRITE` [v2.shop.update_profile](https://open.shopee.com/documents/v2/v2.shop.update_profile) — 文档 ID 585
- `CORE` [v2.shop.get_warehouse_detail](https://open.shopee.com/documents/v2/v2.shop.get_warehouse_detail) — 文档 ID 1061
- `CORE` [v2.shop.get_shop_notification](https://open.shopee.com/documents/v2/v2.shop.get_shop_notification) — 文档 ID 1994
- `CORE` [v2.shop.get_authorised_reseller_brand](https://open.shopee.com/documents/v2/v2.shop.get_authorised_reseller_brand) — 文档 ID 2238
- `CORE` [v2.shop.get_br_shop_onboarding_info](https://open.shopee.com/documents/v2/v2.shop.get_br_shop_onboarding_info) — 文档 ID 2647
- `CORE` [v2.shop.get_shop_holiday_mode](https://open.shopee.com/documents/v2/v2.shop.get_shop_holiday_mode) — 文档 ID 2651
- `CONTROLLED-WRITE` [v2.shop.set_shop_holiday_mode](https://open.shopee.com/documents/v2/v2.shop.set_shop_holiday_mode) — 文档 ID 2654

### Merchant / 商户

- `CORE` [v2.merchant.get_merchant_info](https://open.shopee.com/documents/v2/v2.merchant.get_merchant_info) — 文档 ID 537
- `CORE` [v2.merchant.get_shop_list_by_merchant](https://open.shopee.com/documents/v2/v2.merchant.get_shop_list_by_merchant) — 文档 ID 700
- `CORE` [v2.merchant.get_merchant_warehouse_location_list](https://open.shopee.com/documents/v2/v2.merchant.get_merchant_warehouse_location_list) — 文档 ID 1781
- `CORE` [v2.merchant.get_merchant_warehouse_list](https://open.shopee.com/documents/v2/v2.merchant.get_merchant_warehouse_list) — 文档 ID 1864
- `CORE` [v2.merchant.get_warehouse_eligible_shop_list](https://open.shopee.com/documents/v2/v2.merchant.get_warehouse_eligible_shop_list) — 文档 ID 1865
- `CORE` [v2.merchant.get_merchant_prepaid_account_list](https://open.shopee.com/documents/v2/v2.merchant.get_merchant_prepaid_account_list) — 文档 ID 2302

### Order / 订单

- `CORE` [v2.order.get_order_list](https://open.shopee.com/documents/v2/v2.order.get_order_list) — 文档 ID 542
- `CORE` [v2.order.get_order_detail](https://open.shopee.com/documents/v2/v2.order.get_order_detail) — 文档 ID 557
- `CORE` [v2.order.get_shipment_list](https://open.shopee.com/documents/v2/v2.order.get_shipment_list) — 文档 ID 543
- `CORE` [v2.order.search_package_list](https://open.shopee.com/documents/v2/v2.order.search_package_list) — 文档 ID 2420
- `CORE` [v2.order.get_package_detail](https://open.shopee.com/documents/v2/v2.order.get_package_detail) — 文档 ID 2527
- `CONTROLLED-WRITE` [v2.order.split_order](https://open.shopee.com/documents/v2/v2.order.split_order) — 文档 ID 545
- `CONTROLLED-WRITE` [v2.order.unsplit_order](https://open.shopee.com/documents/v2/v2.order.unsplit_order) — 文档 ID 546
- `CONTROLLED-WRITE` [v2.order.cancel_order](https://open.shopee.com/documents/v2/v2.order.cancel_order) — 文档 ID 541
- `CONTROLLED-WRITE` [v2.order.handle_buyer_cancellation](https://open.shopee.com/documents/v2/v2.order.handle_buyer_cancellation) — 文档 ID 544
- `CONTROLLED-WRITE` [v2.order.set_note](https://open.shopee.com/documents/v2/v2.order.set_note) — 文档 ID 540
- `CORE` [v2.order.get_pending_buyer_invoice_order_list](https://open.shopee.com/documents/v2/v2.order.get_pending_buyer_invoice_order_list) — 文档 ID 745
- `CORE` [v2.order.get_buyer_invoice_info](https://open.shopee.com/documents/v2/v2.order.get_buyer_invoice_info) — 文档 ID 1021
- `CONTROLLED-WRITE` [v2.order.upload_invoice_doc](https://open.shopee.com/documents/v2/v2.order.upload_invoice_doc) — 文档 ID 744
- `LATER` [v2.order.download_invoice_doc](https://open.shopee.com/documents/v2/v2.order.download_invoice_doc) — 文档 ID 746
- `CONTROLLED-WRITE` [v2.order.handle_prescription_check](https://open.shopee.com/documents/v2/v2.order.handle_prescription_check) — 文档 ID 1521
- `CORE` [v2.order.get_warehouse_filter_config](https://open.shopee.com/documents/v2/v2.order.get_warehouse_filter_config) — 文档 ID 2440
- `CORE` [v2.order.get_booking_list](https://open.shopee.com/documents/v2/v2.order.get_booking_list) — 文档 ID 2177
- `CORE` [v2.order.get_booking_detail](https://open.shopee.com/documents/v2/v2.order.get_booking_detail) — 文档 ID 2178
- `LATER` [v2.order.generate_fbs_invoices](https://open.shopee.com/documents/v2/v2.order.generate_fbs_invoices) — 文档 ID 2634
- `CORE` [v2.order.get_fbs_invoices_result](https://open.shopee.com/documents/v2/v2.order.get_fbs_invoices_result) — 文档 ID 2635
- `LATER` [v2.order.download_fbs_invoices](https://open.shopee.com/documents/v2/v2.order.download_fbs_invoices) — 文档 ID 2636
- `CORE` [v2.order.get_estimate_cancel_value](https://open.shopee.com/documents/v2/v2.order.get_estimate_cancel_value) — 文档 ID 3265

### Logistics / 物流

- `CORE` [v2.logistics.get_shipping_parameter](https://open.shopee.com/documents/v2/v2.logistics.get_shipping_parameter) — 文档 ID 550
- `CORE` [v2.logistics.get_mass_shipping_parameter](https://open.shopee.com/documents/v2/v2.logistics.get_mass_shipping_parameter) — 文档 ID 2421
- `CONTROLLED-WRITE` [v2.logistics.ship_order](https://open.shopee.com/documents/v2/v2.logistics.ship_order) — 文档 ID 553
- `CONTROLLED-WRITE` [v2.logistics.mass_ship_order](https://open.shopee.com/documents/v2/v2.logistics.mass_ship_order) — 文档 ID 2422
- `CONTROLLED-WRITE` [v2.logistics.update_shipping_order](https://open.shopee.com/documents/v2/v2.logistics.update_shipping_order) — 文档 ID 555
- `CORE` [v2.logistics.get_tracking_number](https://open.shopee.com/documents/v2/v2.logistics.get_tracking_number) — 文档 ID 552
- `CORE` [v2.logistics.get_mass_tracking_number](https://open.shopee.com/documents/v2/v2.logistics.get_mass_tracking_number) — 文档 ID 2423
- `CORE` [v2.logistics.get_shipping_document_parameter](https://open.shopee.com/documents/v2/v2.logistics.get_shipping_document_parameter) — 文档 ID 549
- `CONTROLLED-WRITE` [v2.logistics.create_shipping_document](https://open.shopee.com/documents/v2/v2.logistics.create_shipping_document) — 文档 ID 547
- `CORE` [v2.logistics.get_shipping_document_result](https://open.shopee.com/documents/v2/v2.logistics.get_shipping_document_result) — 文档 ID 561
- `LATER` [v2.logistics.download_shipping_document](https://open.shopee.com/documents/v2/v2.logistics.download_shipping_document) — 文档 ID 548
- `CORE` [v2.logistics.get_shipping_document_data_info](https://open.shopee.com/documents/v2/v2.logistics.get_shipping_document_data_info) — 文档 ID 1534
- `CORE` [v2.logistics.get_tracking_info](https://open.shopee.com/documents/v2/v2.logistics.get_tracking_info) — 文档 ID 551
- `CORE` [v2.logistics.get_address_list](https://open.shopee.com/documents/v2/v2.logistics.get_address_list) — 文档 ID 558
- `CONTROLLED-WRITE` [v2.logistics.set_address_config](https://open.shopee.com/documents/v2/v2.logistics.set_address_config) — 文档 ID 556
- `CONTROLLED-WRITE` [v2.logistics.update_address](https://open.shopee.com/documents/v2/v2.logistics.update_address) — 文档 ID 2657
- `CONTROLLED-WRITE` [v2.logistics.delete_address](https://open.shopee.com/documents/v2/v2.logistics.delete_address) — 文档 ID 598
- `CORE` [v2.logistics.get_channel_list](https://open.shopee.com/documents/v2/v2.logistics.get_channel_list) — 文档 ID 559
- `CONTROLLED-WRITE` [v2.logistics.update_channel](https://open.shopee.com/documents/v2/v2.logistics.update_channel) — 文档 ID 554
- `CORE` [v2.logistics.get_operating_hours](https://open.shopee.com/documents/v2/v2.logistics.get_operating_hours) — 文档 ID 2432
- `CORE` [v2.logistics.get_operating_hour_restrictions](https://open.shopee.com/documents/v2/v2.logistics.get_operating_hour_restrictions) — 文档 ID 2431
- `CONTROLLED-WRITE` [v2.logistics.update_operating_hours](https://open.shopee.com/documents/v2/v2.logistics.update_operating_hours) — 文档 ID 2433
- `CONTROLLED-WRITE` [v2.logistics.delete_special_operating_hour](https://open.shopee.com/documents/v2/v2.logistics.delete_special_operating_hour) — 文档 ID 2434
- `LATER` [v2.logistics.batch_update_tpf_warehouse_tracking_status](https://open.shopee.com/documents/v2/v2.logistics.batch_update_tpf_warehouse_tracking_status) — 文档 ID 2397
- `CONTROLLED-WRITE` [v2.logistics.batch_ship_order](https://open.shopee.com/documents/v2/v2.logistics.batch_ship_order) — 文档 ID 688
- `CONTROLLED-WRITE` [v2.logistics.update_tracking_status](https://open.shopee.com/documents/v2/v2.logistics.update_tracking_status) — 文档 ID 2016
- `CORE` [v2.logistics.get_booking_shipping_parameter](https://open.shopee.com/documents/v2/v2.logistics.get_booking_shipping_parameter) — 文档 ID 2180
- `CONTROLLED-WRITE` [v2.logistics.ship_booking](https://open.shopee.com/documents/v2/v2.logistics.ship_booking) — 文档 ID 2181
- `CORE` [v2.logistics.get_booking_tracking_number](https://open.shopee.com/documents/v2/v2.logistics.get_booking_tracking_number) — 文档 ID 2182
- `CORE` [v2.logistics.get_booking_shipping_document_parameter](https://open.shopee.com/documents/v2/v2.logistics.get_booking_shipping_document_parameter) — 文档 ID 2183
- `CONTROLLED-WRITE` [v2.logistics.create_booking_shipping_document](https://open.shopee.com/documents/v2/v2.logistics.create_booking_shipping_document) — 文档 ID 2184
- `CORE` [v2.logistics.get_booking_shipping_document_result](https://open.shopee.com/documents/v2/v2.logistics.get_booking_shipping_document_result) — 文档 ID 2185
- `LATER` [v2.logistics.download_booking_shipping_document](https://open.shopee.com/documents/v2/v2.logistics.download_booking_shipping_document) — 文档 ID 2186
- `CORE` [v2.logistics.get_booking_shipping_document_data_info](https://open.shopee.com/documents/v2/v2.logistics.get_booking_shipping_document_data_info) — 文档 ID 2187
- `CORE` [v2.logistics.get_booking_tracking_info](https://open.shopee.com/documents/v2/v2.logistics.get_booking_tracking_info) — 文档 ID 2196
- `LATER` [v2.logistics.download_to_label](https://open.shopee.com/documents/v2/v2.logistics.download_to_label) — 文档 ID 2556
- `CONTROLLED-WRITE` [v2.logistics.create_shipping_document_job](https://open.shopee.com/documents/v2/v2.logistics.create_shipping_document_job) — 文档 ID 2660
- `CORE` [v2.logistics.get_shipping_document_job_status](https://open.shopee.com/documents/v2/v2.logistics.get_shipping_document_job_status) — 文档 ID 2661
- `LATER` [v2.logistics.download_shipping_document_job](https://open.shopee.com/documents/v2/v2.logistics.download_shipping_document_job) — 文档 ID 2662
- `CONTROLLED-WRITE` [v2.logistics.update_self_collection_order_logistics](https://open.shopee.com/documents/v2/v2.logistics.update_self_collection_order_logistics) — 文档 ID 2840
- `CORE` [v2.logistics.get_mart_packaging_info](https://open.shopee.com/documents/v2/v2.logistics.get_mart_packaging_info) — 文档 ID 2575
- `CONTROLLED-WRITE` [v2.logistics.set_mart_packaging_info](https://open.shopee.com/documents/v2/v2.logistics.set_mart_packaging_info) — 文档 ID 2577
- `CONTROLLED-WRITE` [v2.logistics.upload_serviceable_polygon](https://open.shopee.com/documents/v2/v2.logistics.upload_serviceable_polygon) — 文档 ID 2758
- `LATER` [v2.logistics.check_polygon_update_status](https://open.shopee.com/documents/v2/v2.logistics.check_polygon_update_status) — 文档 ID 2757
- `CORE` [v2.logistics.get_pause_status](https://open.shopee.com/documents/v2/v2.logistics.get_pause_status) — 文档 ID 3184
- `CONTROLLED-WRITE` [v2.logistics.set_pause_status](https://open.shopee.com/documents/v2/v2.logistics.set_pause_status) — 文档 ID 3185

### FirstMile / 首公里

- `CONDITIONAL` [v2.first_mile.get_unbind_order_list](https://open.shopee.com/documents/v2/v2.first_mile.get_unbind_order_list) — 文档 ID 605
- `CONDITIONAL` [v2.first_mile.get_detail](https://open.shopee.com/documents/v2/v2.first_mile.get_detail) — 文档 ID 601
- `CONDITIONAL` [v2.first_mile.generate_first_mile_tracking_number](https://open.shopee.com/documents/v2/v2.first_mile.generate_first_mile_tracking_number) — 文档 ID 600
- `CONDITIONAL` [v2.first_mile.bind_first_mile_tracking_number](https://open.shopee.com/documents/v2/v2.first_mile.bind_first_mile_tracking_number) — 文档 ID 599
- `CONDITIONAL` [v2.first_mile.unbind_first_mile_tracking_number](https://open.shopee.com/documents/v2/v2.first_mile.unbind_first_mile_tracking_number) — 文档 ID 604
- `CONDITIONAL` [v2.first_mile.get_tracking_number_list](https://open.shopee.com/documents/v2/v2.first_mile.get_tracking_number_list) — 文档 ID 602
- `CONDITIONAL` [v2.first_mile.get_waybill](https://open.shopee.com/documents/v2/v2.first_mile.get_waybill) — 文档 ID 603
- `CONDITIONAL` [v2.first_mile.get_channel_list](https://open.shopee.com/documents/v2/v2.first_mile.get_channel_list) — 文档 ID 606
- `CONDITIONAL` [v2.first_mile.get_courier_delivery_channel_list](https://open.shopee.com/documents/v2/v2.first_mile.get_courier_delivery_channel_list) — 文档 ID 2288
- `CONDITIONAL` [v2.first_mile.get_transit_warehouse_list](https://open.shopee.com/documents/v2/v2.first_mile.get_transit_warehouse_list) — 文档 ID 2289
- `CONDITIONAL` [v2.first_mile.generate_and_bind_first_mile_tracking_number](https://open.shopee.com/documents/v2/v2.first_mile.generate_and_bind_first_mile_tracking_number) — 文档 ID 2290
- `CONDITIONAL` [v2.first_mile.bind_courier_delivery_first_mile_tracking_number](https://open.shopee.com/documents/v2/v2.first_mile.bind_courier_delivery_first_mile_tracking_number) — 文档 ID 2291
- `CONDITIONAL` [v2.first_mile.unbind_first_mile_tracking_number_all](https://open.shopee.com/documents/v2/v2.first_mile.unbind_first_mile_tracking_number_all) — 文档 ID 2292
- `CONDITIONAL` [v2.first_mile.get_courier_delivery_detail](https://open.shopee.com/documents/v2/v2.first_mile.get_courier_delivery_detail) — 文档 ID 2296
- `CONDITIONAL` [v2.first_mile.get_courier_delivery_waybill](https://open.shopee.com/documents/v2/v2.first_mile.get_courier_delivery_waybill) — 文档 ID 2300
- `CONDITIONAL` [v2.first_mile.get_courier_delivery_tracking_number_list](https://open.shopee.com/documents/v2/v2.first_mile.get_courier_delivery_tracking_number_list) — 文档 ID 2301

### Payment / 财务

- `NEXT` [v2.payment.get_escrow_detail](https://open.shopee.com/documents/v2/v2.payment.get_escrow_detail) — 文档 ID 565
- `CONTROLLED-WRITE` [v2.payment.set_shop_installment_status](https://open.shopee.com/documents/v2/v2.payment.set_shop_installment_status) — 文档 ID 566
- `NEXT` [v2.payment.get_shop_installment_status](https://open.shopee.com/documents/v2/v2.payment.get_shop_installment_status) — 文档 ID 567
- `NEXT` [v2.payment.get_payout_detail](https://open.shopee.com/documents/v2/v2.payment.get_payout_detail) — 文档 ID 573
- `CONTROLLED-WRITE` [v2.payment.set_item_installment_status](https://open.shopee.com/documents/v2/v2.payment.set_item_installment_status) — 文档 ID 582
- `NEXT` [v2.payment.get_item_installment_status](https://open.shopee.com/documents/v2/v2.payment.get_item_installment_status) — 文档 ID 583
- `NEXT` [v2.payment.get_payment_method_list](https://open.shopee.com/documents/v2/v2.payment.get_payment_method_list) — 文档 ID 593
- `NEXT` [v2.payment.get_wallet_transaction_list](https://open.shopee.com/documents/v2/v2.payment.get_wallet_transaction_list) — 文档 ID 594
- `NEXT` [v2.payment.get_escrow_list](https://open.shopee.com/documents/v2/v2.payment.get_escrow_list) — 文档 ID 669
- `NEXT` [v2.payment.get_payout_info](https://open.shopee.com/documents/v2/v2.payment.get_payout_info) — 文档 ID 1886
- `NEXT` [v2.payment.get_billing_transaction_info](https://open.shopee.com/documents/v2/v2.payment.get_billing_transaction_info) — 文档 ID 1885
- `NEXT` [v2.payment.get_escrow_detail_batch](https://open.shopee.com/documents/v2/v2.payment.get_escrow_detail_batch) — 文档 ID 2068
- `NEXT` [v2.payment.generate_income_statement](https://open.shopee.com/documents/v2/v2.payment.generate_income_statement) — 文档 ID 2346
- `NEXT` [v2.payment.get_income_statement](https://open.shopee.com/documents/v2/v2.payment.get_income_statement) — 文档 ID 2347
- `NEXT` [v2.payment.generate_income_report](https://open.shopee.com/documents/v2/v2.payment.generate_income_report) — 文档 ID 2504
- `NEXT` [v2.payment.get_income_report](https://open.shopee.com/documents/v2/v2.payment.get_income_report) — 文档 ID 2505
- `NEXT` [v2.payment.get_income_overview](https://open.shopee.com/documents/v2/v2.payment.get_income_overview) — 文档 ID 2878
- `NEXT` [v2.payment.get_income_detail](https://open.shopee.com/documents/v2/v2.payment.get_income_detail) — 文档 ID 2879

### Discount / 折扣

- `LATER` [v2.discount.add_discount](https://open.shopee.com/documents/v2/v2.discount.add_discount) — 文档 ID 569
- `LATER` [v2.discount.add_discount_item](https://open.shopee.com/documents/v2/v2.discount.add_discount_item) — 文档 ID 570
- `LATER` [v2.discount.delete_discount](https://open.shopee.com/documents/v2/v2.discount.delete_discount) — 文档 ID 571
- `LATER` [v2.discount.delete_discount_item](https://open.shopee.com/documents/v2/v2.discount.delete_discount_item) — 文档 ID 572
- `LATER` [v2.discount.get_discount](https://open.shopee.com/documents/v2/v2.discount.get_discount) — 文档 ID 574
- `LATER` [v2.discount.get_discount_list](https://open.shopee.com/documents/v2/v2.discount.get_discount_list) — 文档 ID 575
- `LATER` [v2.discount.update_discount](https://open.shopee.com/documents/v2/v2.discount.update_discount) — 文档 ID 576
- `LATER` [v2.discount.update_discount_item](https://open.shopee.com/documents/v2/v2.discount.update_discount_item) — 文档 ID 577
- `LATER` [v2.discount.end_discount](https://open.shopee.com/documents/v2/v2.discount.end_discount) — 文档 ID 597
- `LATER` [v2.discount.get_sip_discounts](https://open.shopee.com/documents/v2/v2.discount.get_sip_discounts) — 文档 ID 2437
- `LATER` [v2.discount.set_sip_discount](https://open.shopee.com/documents/v2/v2.discount.set_sip_discount) — 文档 ID 2438
- `LATER` [v2.discount.delete_sip_discount](https://open.shopee.com/documents/v2/v2.discount.delete_sip_discount) — 文档 ID 2439

### Bundle Deal / 套装优惠

- `LATER` [v2.bundle_deal.add_bundle_deal](https://open.shopee.com/documents/v2/v2.bundle_deal.add_bundle_deal) — 文档 ID 689
- `LATER` [v2.bundle_deal.add_bundle_deal_item](https://open.shopee.com/documents/v2/v2.bundle_deal.add_bundle_deal_item) — 文档 ID 690
- `LATER` [v2.bundle_deal.get_bundle_deal_list](https://open.shopee.com/documents/v2/v2.bundle_deal.get_bundle_deal_list) — 文档 ID 694
- `LATER` [v2.bundle_deal.get_bundle_deal](https://open.shopee.com/documents/v2/v2.bundle_deal.get_bundle_deal) — 文档 ID 695
- `LATER` [v2.bundle_deal.get_bundle_deal_item](https://open.shopee.com/documents/v2/v2.bundle_deal.get_bundle_deal_item) — 文档 ID 696
- `LATER` [v2.bundle_deal.update_bundle_deal](https://open.shopee.com/documents/v2/v2.bundle_deal.update_bundle_deal) — 文档 ID 697
- `LATER` [v2.bundle_deal.update_bundle_deal_item](https://open.shopee.com/documents/v2/v2.bundle_deal.update_bundle_deal_item) — 文档 ID 698
- `LATER` [v2.bundle_deal.end_bundle_deal](https://open.shopee.com/documents/v2/v2.bundle_deal.end_bundle_deal) — 文档 ID 693
- `LATER` [v2.bundle_deal.delete_bundle_deal](https://open.shopee.com/documents/v2/v2.bundle_deal.delete_bundle_deal) — 文档 ID 691
- `LATER` [v2.bundle_deal.delete_bundle_deal_item](https://open.shopee.com/documents/v2/v2.bundle_deal.delete_bundle_deal_item) — 文档 ID 692

### Add-On Deal / 加购优惠

- `LATER` [v2.add_on_deal.add_add_on_deal](https://open.shopee.com/documents/v2/v2.add_on_deal.add_add_on_deal) — 文档 ID 710
- `LATER` [v2.add_on_deal.add_add_on_deal_main_item](https://open.shopee.com/documents/v2/v2.add_on_deal.add_add_on_deal_main_item) — 文档 ID 708
- `LATER` [v2.add_on_deal.add_add_on_deal_sub_item](https://open.shopee.com/documents/v2/v2.add_on_deal.add_add_on_deal_sub_item) — 文档 ID 709
- `LATER` [v2.add_on_deal.delete_add_on_deal](https://open.shopee.com/documents/v2/v2.add_on_deal.delete_add_on_deal) — 文档 ID 713
- `LATER` [v2.add_on_deal.delete_add_on_deal_main_item](https://open.shopee.com/documents/v2/v2.add_on_deal.delete_add_on_deal_main_item) — 文档 ID 711
- `LATER` [v2.add_on_deal.delete_add_on_deal_sub_item](https://open.shopee.com/documents/v2/v2.add_on_deal.delete_add_on_deal_sub_item) — 文档 ID 712
- `LATER` [v2.add_on_deal.get_add_on_deal_list](https://open.shopee.com/documents/v2/v2.add_on_deal.get_add_on_deal_list) — 文档 ID 715
- `LATER` [v2.add_on_deal.get_add_on_deal](https://open.shopee.com/documents/v2/v2.add_on_deal.get_add_on_deal) — 文档 ID 719
- `LATER` [v2.add_on_deal.get_add_on_deal_main_item](https://open.shopee.com/documents/v2/v2.add_on_deal.get_add_on_deal_main_item) — 文档 ID 717
- `LATER` [v2.add_on_deal.get_add_on_deal_sub_item](https://open.shopee.com/documents/v2/v2.add_on_deal.get_add_on_deal_sub_item) — 文档 ID 718
- `LATER` [v2.add_on_deal.update_add_on_deal](https://open.shopee.com/documents/v2/v2.add_on_deal.update_add_on_deal) — 文档 ID 722
- `LATER` [v2.add_on_deal.update_add_on_deal_main_item](https://open.shopee.com/documents/v2/v2.add_on_deal.update_add_on_deal_main_item) — 文档 ID 720
- `LATER` [v2.add_on_deal.update_add_on_deal_sub_item](https://open.shopee.com/documents/v2/v2.add_on_deal.update_add_on_deal_sub_item) — 文档 ID 721
- `LATER` [v2.add_on_deal.end_add_on_deal](https://open.shopee.com/documents/v2/v2.add_on_deal.end_add_on_deal) — 文档 ID 714

### Voucher / 优惠券

- `LATER` [v2.voucher.add_voucher](https://open.shopee.com/documents/v2/v2.voucher.add_voucher) — 文档 ID 723
- `LATER` [v2.voucher.delete_voucher](https://open.shopee.com/documents/v2/v2.voucher.delete_voucher) — 文档 ID 724
- `LATER` [v2.voucher.end_voucher](https://open.shopee.com/documents/v2/v2.voucher.end_voucher) — 文档 ID 725
- `LATER` [v2.voucher.update_voucher](https://open.shopee.com/documents/v2/v2.voucher.update_voucher) — 文档 ID 726
- `LATER` [v2.voucher.get_voucher](https://open.shopee.com/documents/v2/v2.voucher.get_voucher) — 文档 ID 727
- `LATER` [v2.voucher.get_voucher_list](https://open.shopee.com/documents/v2/v2.voucher.get_voucher_list) — 文档 ID 728

### ShopFlashSale / 店铺秒杀

- `LATER` [v2.shop_flash_sale.get_time_slot_id](https://open.shopee.com/documents/v2/v2.shop_flash_sale.get_time_slot_id) — 文档 ID 2225
- `LATER` [v2.shop_flash_sale.create_shop_flash_sale](https://open.shopee.com/documents/v2/v2.shop_flash_sale.create_shop_flash_sale) — 文档 ID 2217
- `LATER` [v2.shop_flash_sale.get_item_criteria](https://open.shopee.com/documents/v2/v2.shop_flash_sale.get_item_criteria) — 文档 ID 2220
- `LATER` [v2.shop_flash_sale.add_shop_flash_sale_items](https://open.shopee.com/documents/v2/v2.shop_flash_sale.add_shop_flash_sale_items) — 文档 ID 2216
- `LATER` [v2.shop_flash_sale.get_shop_flash_sale_list](https://open.shopee.com/documents/v2/v2.shop_flash_sale.get_shop_flash_sale_list) — 文档 ID 2226
- `LATER` [v2.shop_flash_sale.get_shop_flash_sale](https://open.shopee.com/documents/v2/v2.shop_flash_sale.get_shop_flash_sale) — 文档 ID 2221
- `LATER` [v2.shop_flash_sale.get_shop_flash_sale_items](https://open.shopee.com/documents/v2/v2.shop_flash_sale.get_shop_flash_sale_items) — 文档 ID 2222
- `LATER` [v2.shop_flash_sale.update_shop_flash_sale](https://open.shopee.com/documents/v2/v2.shop_flash_sale.update_shop_flash_sale) — 文档 ID 2224
- `LATER` [v2.shop_flash_sale.update_shop_flash_sale_items](https://open.shopee.com/documents/v2/v2.shop_flash_sale.update_shop_flash_sale_items) — 文档 ID 2223
- `LATER` [v2.shop_flash_sale.delete_shop_flash_sale](https://open.shopee.com/documents/v2/v2.shop_flash_sale.delete_shop_flash_sale) — 文档 ID 2218
- `LATER` [v2.shop_flash_sale.delete_shop_flash_sale_items](https://open.shopee.com/documents/v2/v2.shop_flash_sale.delete_shop_flash_sale_items) — 文档 ID 2219

### Follow Prize / 关注礼

- `LATER` [v2.follow_prize.add_follow_prize](https://open.shopee.com/documents/v2/v2.follow_prize.add_follow_prize) — 文档 ID 729
- `LATER` [v2.follow_prize.delete_follow_prize](https://open.shopee.com/documents/v2/v2.follow_prize.delete_follow_prize) — 文档 ID 730
- `LATER` [v2.follow_prize.end_follow_prize](https://open.shopee.com/documents/v2/v2.follow_prize.end_follow_prize) — 文档 ID 731
- `LATER` [v2.follow_prize.update_follow_prize](https://open.shopee.com/documents/v2/v2.follow_prize.update_follow_prize) — 文档 ID 732
- `LATER` [v2.follow_prize.get_follow_prize_detail](https://open.shopee.com/documents/v2/v2.follow_prize.get_follow_prize_detail) — 文档 ID 733
- `LATER` [v2.follow_prize.get_follow_prize_list](https://open.shopee.com/documents/v2/v2.follow_prize.get_follow_prize_list) — 文档 ID 734

### TopPicks / 精选商品

- `LATER` [v2.top_picks.get_top_picks_list](https://open.shopee.com/documents/v2/v2.top_picks.get_top_picks_list) — 文档 ID 578
- `LATER` [v2.top_picks.add_top_picks](https://open.shopee.com/documents/v2/v2.top_picks.add_top_picks) — 文档 ID 579
- `LATER` [v2.top_picks.update_top_picks](https://open.shopee.com/documents/v2/v2.top_picks.update_top_picks) — 文档 ID 580
- `LATER` [v2.top_picks.delete_top_picks](https://open.shopee.com/documents/v2/v2.top_picks.delete_top_picks) — 文档 ID 581
### ShopCategory / 店铺分类

- `LATER` [v2.shop_category.add_shop_category](https://open.shopee.com/documents/v2/v2.shop_category.add_shop_category) — 文档 ID 586
- `LATER` [v2.shop_category.get_shop_category_list](https://open.shopee.com/documents/v2/v2.shop_category.get_shop_category_list) — 文档 ID 587
- `LATER` [v2.shop_category.delete_shop_category](https://open.shopee.com/documents/v2/v2.shop_category.delete_shop_category) — 文档 ID 588
- `LATER` [v2.shop_category.update_shop_category](https://open.shopee.com/documents/v2/v2.shop_category.update_shop_category) — 文档 ID 589
- `LATER` [v2.shop_category.add_item_list](https://open.shopee.com/documents/v2/v2.shop_category.add_item_list) — 文档 ID 590
- `LATER` [v2.shop_category.get_item_list](https://open.shopee.com/documents/v2/v2.shop_category.get_item_list) — 文档 ID 591
- `LATER` [v2.shop_category.delete_item_list](https://open.shopee.com/documents/v2/v2.shop_category.delete_item_list) — 文档 ID 592

### Returns / 售后

- `NEXT` [v2.returns.get_return_list](https://open.shopee.com/documents/v2/v2.returns.get_return_list) — 文档 ID 608
- `NEXT` [v2.returns.get_return_detail](https://open.shopee.com/documents/v2/v2.returns.get_return_detail) — 文档 ID 607
- `CONTROLLED-WRITE` [v2.returns.confirm](https://open.shopee.com/documents/v2/v2.returns.confirm) — 文档 ID 609
- `CONTROLLED-WRITE` [v2.returns.dispute](https://open.shopee.com/documents/v2/v2.returns.dispute) — 文档 ID 610
- `NEXT` [v2.returns.get_available_solutions](https://open.shopee.com/documents/v2/v2.returns.get_available_solutions) — 文档 ID 755
- `CONTROLLED-WRITE` [v2.returns.offer](https://open.shopee.com/documents/v2/v2.returns.offer) — 文档 ID 756
- `CONTROLLED-WRITE` [v2.returns.accept_offer](https://open.shopee.com/documents/v2/v2.returns.accept_offer) — 文档 ID 757
- `LATER` [v2.returns.convert_image](https://open.shopee.com/documents/v2/v2.returns.convert_image) — 文档 ID 1312
- `CONTROLLED-WRITE` [v2.returns.upload_proof](https://open.shopee.com/documents/v2/v2.returns.upload_proof) — 文档 ID 1313
- `NEXT` [v2.returns.query_proof](https://open.shopee.com/documents/v2/v2.returns.query_proof) — 文档 ID 1311
- `NEXT` [v2.returns.get_return_dispute_reason](https://open.shopee.com/documents/v2/v2.returns.get_return_dispute_reason) — 文档 ID 1884
- `CONTROLLED-WRITE` [v2.returns.cancel_dispute](https://open.shopee.com/documents/v2/v2.returns.cancel_dispute) — 文档 ID 2371
- `NEXT` [v2.returns.get_shipping_carrier](https://open.shopee.com/documents/v2/v2.returns.get_shipping_carrier) — 文档 ID 2623
- `CONTROLLED-WRITE` [v2.returns.upload_shipping_proof](https://open.shopee.com/documents/v2/v2.returns.upload_shipping_proof) — 文档 ID 2625
- `NEXT` [v2.returns.get_reverse_tracking_info](https://open.shopee.com/documents/v2/v2.returns.get_reverse_tracking_info) — 文档 ID 2627

### AccountHealth / 店铺健康

- `NEXT` [v2.account_health.get_shop_performance](https://open.shopee.com/documents/v2/v2.account_health.get_shop_performance) — 文档 ID 2150
- `NEXT` [v2.account_health.get_metric_source_detail](https://open.shopee.com/documents/v2/v2.account_health.get_metric_source_detail) — 文档 ID 2323
- `NEXT` [v2.account_health.get_penalty_point_history](https://open.shopee.com/documents/v2/v2.account_health.get_penalty_point_history) — 文档 ID 2324
- `NEXT` [v2.account_health.get_punishment_history](https://open.shopee.com/documents/v2/v2.account_health.get_punishment_history) — 文档 ID 2325
- `NEXT` [v2.account_health.get_listings_with_issues](https://open.shopee.com/documents/v2/v2.account_health.get_listings_with_issues) — 文档 ID 2326
- `NEXT` [v2.account_health.get_late_orders](https://open.shopee.com/documents/v2/v2.account_health.get_late_orders) — 文档 ID 2327

### Ads / 站内广告

- `NEXT` [v2.ads.get_total_balance](https://open.shopee.com/documents/v2/v2.ads.get_total_balance) — 文档 ID 1833
- `NEXT` [v2.ads.get_shop_toggle_info](https://open.shopee.com/documents/v2/v2.ads.get_shop_toggle_info) — 文档 ID 1836
- `NEXT` [v2.ads.get_recommended_keyword_list](https://open.shopee.com/documents/v2/v2.ads.get_recommended_keyword_list) — 文档 ID 1838
- `NEXT` [v2.ads.get_recommended_item_list](https://open.shopee.com/documents/v2/v2.ads.get_recommended_item_list) — 文档 ID 1839
- `NEXT` [v2.ads.get_all_cpc_ads_hourly_performance](https://open.shopee.com/documents/v2/v2.ads.get_all_cpc_ads_hourly_performance) — 文档 ID 1840
- `NEXT` [v2.ads.get_all_cpc_ads_daily_performance](https://open.shopee.com/documents/v2/v2.ads.get_all_cpc_ads_daily_performance) — 文档 ID 1841
- `OFFLINE` [v2.ads.create_auto_product_ads](https://open.shopee.com/documents/v2/v2.ads.create_auto_product_ads) — 文档 ID 2197
- `OFFLINE` [v2.ads.edit_auto_product_ads](https://open.shopee.com/documents/v2/v2.ads.edit_auto_product_ads) — 文档 ID 2198
- `NEXT` [v2.ads.get_product_campaign_daily_performance](https://open.shopee.com/documents/v2/v2.ads.get_product_campaign_daily_performance) — 文档 ID 2199
- `NEXT` [v2.ads.get_product_campaign_hourly_performance](https://open.shopee.com/documents/v2/v2.ads.get_product_campaign_hourly_performance) — 文档 ID 2200
- `NEXT` [v2.ads.get_product_level_campaign_id_list](https://open.shopee.com/documents/v2/v2.ads.get_product_level_campaign_id_list) — 文档 ID 2201
- `NEXT` [v2.ads.get_product_level_campaign_setting_info](https://open.shopee.com/documents/v2/v2.ads.get_product_level_campaign_setting_info) — 文档 ID 2202
- `CONTROLLED-WRITE` [v2.ads.create_manual_product_ads](https://open.shopee.com/documents/v2/v2.ads.create_manual_product_ads) — 文档 ID 2253
- `CONTROLLED-WRITE` [v2.ads.edit_manual_product_ad_keywords](https://open.shopee.com/documents/v2/v2.ads.edit_manual_product_ad_keywords) — 文档 ID 2254
- `CONTROLLED-WRITE` [v2.ads.edit_manual_product_ads](https://open.shopee.com/documents/v2/v2.ads.edit_manual_product_ads) — 文档 ID 2255
- `NEXT` [v2.ads.get_create_product_ad_budget_suggestion](https://open.shopee.com/documents/v2/v2.ads.get_create_product_ad_budget_suggestion) — 文档 ID 2256
- `NEXT` [v2.ads.get_product_recommended_roi_target](https://open.shopee.com/documents/v2/v2.ads.get_product_recommended_roi_target) — 文档 ID 2349
- `NEXT` [v2.ads.get_ads_fácil_shop_rate](https://open.shopee.com/documents/v2/v2.ads.get_ads_f%C3%A1cil_shop_rate) — 文档 ID 2650
- `LATER` [v2.ads.check_create_gms_product_campaign_eligibility](https://open.shopee.com/documents/v2/v2.ads.check_create_gms_product_campaign_eligibility) — 文档 ID 2711
- `CONTROLLED-WRITE` [v2.ads.create_gms_product_campaign](https://open.shopee.com/documents/v2/v2.ads.create_gms_product_campaign) — 文档 ID 2712
- `CONTROLLED-WRITE` [v2.ads.edit_gms_product_campaign](https://open.shopee.com/documents/v2/v2.ads.edit_gms_product_campaign) — 文档 ID 2713
- `LATER` [v2.ads.list_gms_user_deleted_item](https://open.shopee.com/documents/v2/v2.ads.list_gms_user_deleted_item) — 文档 ID 2714
- `CONTROLLED-WRITE` [v2.ads.edit_gms_item_product_campaign](https://open.shopee.com/documents/v2/v2.ads.edit_gms_item_product_campaign) — 文档 ID 2715
- `NEXT` [v2.ads.get_gms_campaign_performance](https://open.shopee.com/documents/v2/v2.ads.get_gms_campaign_performance) — 文档 ID 2716
- `NEXT` [v2.ads.get_gms_item_performance](https://open.shopee.com/documents/v2/v2.ads.get_gms_item_performance) — 文档 ID 2717

### Public / 授权

- `CORE` [v2.public.get_shops_by_partner](https://open.shopee.com/documents/v2/v2.public.get_shops_by_partner) — 文档 ID 663
- `CORE` [v2.public.get_merchants_by_partner](https://open.shopee.com/documents/v2/v2.public.get_merchants_by_partner) — 文档 ID 664
- `CORE` [v2.public.get_access_token](https://open.shopee.com/documents/v2/v2.public.get_access_token) — 文档 ID 741
- `LATER` [v2.public.refresh_access_token](https://open.shopee.com/documents/v2/v2.public.refresh_access_token) — 文档 ID 742
- `CORE` [v2.public.get_token_by_resend_code](https://open.shopee.com/documents/v2/v2.public.get_token_by_resend_code) — 文档 ID 752
- `CORE` [v2.public.get_shopee_ip_ranges](https://open.shopee.com/documents/v2/v2.public.get_shopee_ip_ranges) — 文档 ID 1285

### Push / 消息推送

- `CORE` [v2.push.set_app_push_config](https://open.shopee.com/documents/v2/v2.push.set_app_push_config) — 文档 ID 1542
- `CORE` [v2.push.get_app_push_config](https://open.shopee.com/documents/v2/v2.push.get_app_push_config) — 文档 ID 1543
- `CORE` [v2.push.get_lost_push_message](https://open.shopee.com/documents/v2/v2.push.get_lost_push_message) — 文档 ID 1867
- `CORE` [v2.push.confirm_consumed_lost_push_message](https://open.shopee.com/documents/v2/v2.push.confirm_consumed_lost_push_message) — 文档 ID 1869

### SBS

- `CONDITIONAL` [v2.sbs.get_bound_whs_info](https://open.shopee.com/documents/v2/v2.sbs.get_bound_whs_info) — 文档 ID 2495
- `CONDITIONAL` [v2.sbs.get_current_inventory](https://open.shopee.com/documents/v2/v2.sbs.get_current_inventory) — 文档 ID 2496
- `CONDITIONAL` [v2.sbs.get_expiry_report](https://open.shopee.com/documents/v2/v2.sbs.get_expiry_report) — 文档 ID 2498
- `CONDITIONAL` [v2.sbs.get_stock_aging](https://open.shopee.com/documents/v2/v2.sbs.get_stock_aging) — 文档 ID 2499
- `CONDITIONAL` [v2.sbs.get_stock_movement](https://open.shopee.com/documents/v2/v2.sbs.get_stock_movement) — 文档 ID 2500

### FBS

- `CONDITIONAL` [v2.fbs.query_br_shop_enrollment_status](https://open.shopee.com/documents/v2/v2.fbs.query_br_shop_enrollment_status) — 文档 ID 2630
- `CONDITIONAL` [v2.fbs.query_br_shop_invoice_error](https://open.shopee.com/documents/v2/v2.fbs.query_br_shop_invoice_error) — 文档 ID 2631
- `CONDITIONAL` [v2.fbs.query_br_shop_block_status](https://open.shopee.com/documents/v2/v2.fbs.query_br_shop_block_status) — 文档 ID 2632
- `CONDITIONAL` [v2.fbs.query_br_sku_block_status](https://open.shopee.com/documents/v2/v2.fbs.query_br_sku_block_status) — 文档 ID 2633

### Livestream / 直播

- `CONDITIONAL` [v2.livestream.upload_image](https://open.shopee.com/documents/v2/v2.livestream.upload_image) — 文档 ID 2529
- `CONDITIONAL` [v2.livestream.create_session](https://open.shopee.com/documents/v2/v2.livestream.create_session) — 文档 ID 2530
- `CONDITIONAL` [v2.livestream.update_session](https://open.shopee.com/documents/v2/v2.livestream.update_session) — 文档 ID 2532
- `CONDITIONAL` [v2.livestream.start_session](https://open.shopee.com/documents/v2/v2.livestream.start_session) — 文档 ID 2533
- `CONDITIONAL` [v2.livestream.end_session](https://open.shopee.com/documents/v2/v2.livestream.end_session) — 文档 ID 2534
- `CONDITIONAL` [v2.livestream.get_session_detail](https://open.shopee.com/documents/v2/v2.livestream.get_session_detail) — 文档 ID 2531
- `CONDITIONAL` [v2.livestream.add_item_list](https://open.shopee.com/documents/v2/v2.livestream.add_item_list) — 文档 ID 2540
- `CONDITIONAL` [v2.livestream.delete_item_list](https://open.shopee.com/documents/v2/v2.livestream.delete_item_list) — 文档 ID 2541
- `CONDITIONAL` [v2.livestream.update_item_list](https://open.shopee.com/documents/v2/v2.livestream.update_item_list) — 文档 ID 2543
- `CONDITIONAL` [v2.livestream.get_item_count](https://open.shopee.com/documents/v2/v2.livestream.get_item_count) — 文档 ID 2537
- `CONDITIONAL` [v2.livestream.get_item_list](https://open.shopee.com/documents/v2/v2.livestream.get_item_list) — 文档 ID 2542
- `CONDITIONAL` [v2.livestream.update_show_item](https://open.shopee.com/documents/v2/v2.livestream.update_show_item) — 文档 ID 2546
- `CONDITIONAL` [v2.livestream.delete_show_item](https://open.shopee.com/documents/v2/v2.livestream.delete_show_item) — 文档 ID 2545
- `CONDITIONAL` [v2.livestream.get_show_item](https://open.shopee.com/documents/v2/v2.livestream.get_show_item) — 文档 ID 2544
- `CONDITIONAL` [v2.livestream.get_like_item_list](https://open.shopee.com/documents/v2/v2.livestream.get_like_item_list) — 文档 ID 2538
- `CONDITIONAL` [v2.livestream.get_recent_item_list](https://open.shopee.com/documents/v2/v2.livestream.get_recent_item_list) — 文档 ID 2539
- `CONDITIONAL` [v2.livestream.get_item_set_list](https://open.shopee.com/documents/v2/v2.livestream.get_item_set_list) — 文档 ID 2547
- `CONDITIONAL` [v2.livestream.get_item_set_item_list](https://open.shopee.com/documents/v2/v2.livestream.get_item_set_item_list) — 文档 ID 2548
- `CONDITIONAL` [v2.livestream.apply_item_set](https://open.shopee.com/documents/v2/v2.livestream.apply_item_set) — 文档 ID 2549
- `CONDITIONAL` [v2.livestream.get_session_metric](https://open.shopee.com/documents/v2/v2.livestream.get_session_metric) — 文档 ID 2535
- `CONDITIONAL` [v2.livestream.get_session_item_metric](https://open.shopee.com/documents/v2/v2.livestream.get_session_item_metric) — 文档 ID 2536
- `CONDITIONAL` [v2.livestream.get_latest_comment_list](https://open.shopee.com/documents/v2/v2.livestream.get_latest_comment_list) — 文档 ID 2550
- `CONDITIONAL` [v2.livestream.post_comment](https://open.shopee.com/documents/v2/v2.livestream.post_comment) — 文档 ID 2551
- `CONDITIONAL` [v2.livestream.ban_user_comment](https://open.shopee.com/documents/v2/v2.livestream.ban_user_comment) — 文档 ID 2552
- `CONDITIONAL` [v2.livestream.unban_user_comment](https://open.shopee.com/documents/v2/v2.livestream.unban_user_comment) — 文档 ID 2553

### BrandPortal / 品牌门户

- `CONDITIONAL` [v2.principal.get_shop_sales_performance_detail](https://open.shopee.com/documents/v2/v2.principal.get_shop_sales_performance_detail) — 文档 ID 3311
- `CONDITIONAL` [v2.principal.get_principal_sales_performance_detail](https://open.shopee.com/documents/v2/v2.principal.get_principal_sales_performance_detail) — 文档 ID 3312
- `CONDITIONAL` [v2.principal.get_shop_affiliate_performance](https://open.shopee.com/documents/v2/v2.principal.get_shop_affiliate_performance) — 文档 ID 3313
- `CONDITIONAL` [v2.principal.get_principal_affiliate_performance](https://open.shopee.com/documents/v2/v2.principal.get_principal_affiliate_performance) — 文档 ID 3314
- `CONDITIONAL` [v2.principal.get_content_affiliate_performance](https://open.shopee.com/documents/v2/v2.principal.get_content_affiliate_performance) — 文档 ID 3315
- `CONDITIONAL` [v2.principal.get_shop_livestream_performance](https://open.shopee.com/documents/v2/v2.principal.get_shop_livestream_performance) — 文档 ID 3316
- `CONDITIONAL` [v2.principal.get_principal_livestream_performance](https://open.shopee.com/documents/v2/v2.principal.get_principal_livestream_performance) — 文档 ID 3317
- `CONDITIONAL` [v2.principal.get_session_livestream_performance](https://open.shopee.com/documents/v2/v2.principal.get_session_livestream_performance) — 文档 ID 3318
- `CONDITIONAL` [v2.principal.get_shop_video_performance](https://open.shopee.com/documents/v2/v2.principal.get_shop_video_performance) — 文档 ID 3319
- `CONDITIONAL` [v2.principal.get_principal_video_performance](https://open.shopee.com/documents/v2/v2.principal.get_principal_video_performance) — 文档 ID 3320
- `CONDITIONAL` [v2.principal.get_clip_video_performance](https://open.shopee.com/documents/v2/v2.principal.get_clip_video_performance) — 文档 ID 3321

## 实施顺序

1. 授权、店铺、仓库、商品、订单、包裹和 Push 只读影子同步。
2. Ads API 替换 CSV，保留 CSV 作为证据与应急入口。
3. 接入财务、售后和店铺健康，形成 SKU/店铺利润事实。
4. 最后开放经过预览、确认、幂等、串行、回读和审计保护的写操作。
