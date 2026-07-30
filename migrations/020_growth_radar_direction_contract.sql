UPDATE growth_rule_sets
SET status = 'retired',
    effective_to = '2026-07-27T00:00:00.000Z'
WHERE status = 'active';

INSERT INTO growth_rule_sets (
  id,
  version,
  status,
  metrics_contract_version,
  parameters_json,
  content_sha256,
  effective_from,
  created_by,
  created_at,
  activated_by,
  activated_at
) VALUES (
  'gr-rule-grv2-metrics-1-2-0',
  'GRV2-METRICS-1.2.0',
  'active',
  'GRV2-METRICS-1.2.0',
  '{"metricsContractVersion":"GRV2-METRICS-1.2.0","thresholdProfileVersion":"GRV2-THRESHOLDS-1.2.0-DEFAULT","validOrderStatuses":["已发货","待处理","配货中","已完成"],"windows":{"trendDays":7,"captureDays":28,"sourceEvidenceDays":[7,28,42]},"dataMinimums":{"trendSourceDays":14,"captureSourceDays":28,"extendedSourceDays":42},"thresholds":{"trend":{"changeRate":0.1,"minPreviousQuantity":5,"minAbsoluteChange":3,"newSalesMinQuantity":5},"assortment":{"highPercentile":0.8,"midPercentile":0.5,"minimumSampleSize":30},"capture":{"lowRatio":0.1},"storeGap":{"minimumEligibleHighSkus":10,"coverageRatio":0.5,"severeCoverageRatio":0.25,"severeMissingSkus":10},"supply":{"outOfStockDays":0,"criticalDays":7,"warningDays":14},"slowMoving":{"watchDays":60,"riskDays":90,"severeDays":180},"newProduct":{"observationDays":90},"priority":{"p0":{"salesStoppedMinPrevious7d":20,"declineRate":0.5,"declineMinAbsolute":20},"p1":{"declineRate":0.2,"declineMinAbsolute":5,"declineMinPrevious7d":10}},"task":{"managerHomeLimit":10}}}',
  'c7ee2a1bce13d3d6101698ba6435a7014378c0de07eedff6ec98c33d94a176e0',
  '2026-07-27T00:00:00.000Z',
  'system',
  '2026-07-27T00:00:00.000Z',
  'system',
  '2026-07-27T00:00:00.000Z'
);
