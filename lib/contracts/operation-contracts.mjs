import { FUTURE_MODULE_IDS, MODULE_IDS } from "./module-ids.mjs";

function contract(sourceModule, targetModule, required, optional, currentSupport, futureNode) {
  return Object.freeze({ sourceModule, targetModule, required, optional, currentSupport, futureNode });
}

export const OPERATION_CONTRACTS = Object.freeze({
  keywordToCompetitorLink: contract(
    MODULE_IDS.COMPETITOR_KEYWORD,
    MODULE_IDS.COMPETITOR_LINK,
    ["request_id", "platform", "country", "keyword", "listing_url"],
    ["search_rank", "sold_text", "sold_value", "confidence", "source_url"],
    "partial",
    "F2",
  ),
  mabangSkuToCompetitorSearch: contract(
    MODULE_IDS.MABANG_INVENTORY,
    MODULE_IDS.COMPETITOR_KEYWORD,
    ["request_id", "mabang_sku", "platform", "country"],
    ["product_name", "description", "image_file_id", "confidence"],
    "not_connected",
    "F2",
  ),
  advertisingRecordToListing: contract(
    MODULE_IDS.ADVERTISING,
    MODULE_IDS.COMPETITOR_LINK,
    ["request_id", "platform", "advertising_record_id"],
    ["listing_id", "listing_url", "platform_sku_id", "mabang_sku", "confidence"],
    "partial",
    "F2",
  ),
  advertisingAnomalyToTodo: contract(
    MODULE_IDS.ADVERTISING,
    FUTURE_MODULE_IDS.OPERATION_TASKS,
    ["request_id", "advertising_record_id", "anomaly_code", "severity"],
    ["listing_id", "evidence", "suggestion", "confidence"],
    "not_connected",
    "F3",
  ),
  inventoryToAdvertisingSuggestion: contract(
    MODULE_IDS.MABANG_INVENTORY,
    MODULE_IDS.ADVERTISING,
    ["request_id", "mabang_sku", "available_quantity", "observed_at"],
    ["listing_id", "days_of_supply", "suggestion", "confidence"],
    "not_connected",
    "F3",
  ),
  competitorToOpportunity: contract(
    MODULE_IDS.COMPETITOR_LINK,
    FUTURE_MODULE_IDS.OPPORTUNITY_PRODUCTS,
    ["request_id", "analysis_id", "platform", "country"],
    ["listing_ids", "opportunity_score", "evidence", "confidence"],
    "not_connected",
    "F3",
  ),
  opportunityToListingTask: contract(
    FUTURE_MODULE_IDS.OPPORTUNITY_PRODUCTS,
    FUTURE_MODULE_IDS.LISTING_TASKS,
    ["request_id", "opportunity_id", "platform", "country"],
    ["shop_id", "product_id", "sku_ids", "priority", "confidence"],
    "not_connected",
    "F4",
  ),
});
