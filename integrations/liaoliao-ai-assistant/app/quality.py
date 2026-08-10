from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from typing import Any, Iterable


INTENT_TERMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("refund", ("refund", "money back", "退款", "退钱", "คืนเงิน", "hoàn tiền")),
    ("cancel", ("cancel", "取消", "ยกเลิก", "hủy")),
    ("complaint", ("complaint", "scam", "fake", "angry", "投诉", "骗子", "差评", "โกง")),
    ("return", ("return", "send back", "退货", "退回", "คืนสินค้า")),
    ("damaged_or_wrong", ("damaged", "broken", "wrong item", "missing item", "破损", "坏了", "错发", "少件")),
    ("delivery", ("where is", "tracking", "arrive", "delivery", "parcel", "物流", "到哪", "送达", "快递", "พัสดุ")),
    ("ship_time", ("ship", "dispatch", "发货", "什么时候发", "จัดส่ง")),
    ("stock", ("stock", "available", "库存", "有货", "พร้อมส่ง")),
    ("product", ("size", "color", "material", "尺寸", "颜色", "材质", "ขนาด", "สี")),
    ("price", ("price", "discount", "coupon", "价格", "优惠", "折扣", "ราคา")),
)

RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
HIGH_RISK_INTENTS = {"refund", "cancel", "complaint", "return", "damaged_or_wrong"}
MEDIUM_RISK_INTENTS = {"delivery", "ship_time", "stock", "price"}

SECTION_TERMS: dict[str, tuple[str, ...]] = {
    "order": ("订单", "order", "订单号", "order id", "支付", "paid", "状态"),
    "logistics": ("物流", "tracking", "快递", "运单", "承运", "shipment", "delivery", "揽收", "运输"),
    "product": ("商品", "product", "sku", "规格", "variation", "型号", "颜色", "尺寸"),
    "after_sales": ("退款", "退货", "售后", "refund", "return", "cancel", "取消", "争议"),
}

ORDER_REF_RE = re.compile(r"(?i)(?:order(?:\s*(?:id|no\.?))?|订单号|订单)\s*[:：#]?\s*([A-Z0-9][A-Z0-9_-]{5,})")
SKU_RE = re.compile(r"(?i)(?:sku|seller\s*sku|货号)\s*[:：#]?\s*([A-Z0-9][A-Z0-9._/-]{2,})")


def detect_intent(text: str) -> str:
    lowered = text.casefold()
    for intent, terms in INTENT_TERMS:
        if any(term.casefold() in lowered for term in terms):
            return intent
    return "general"


def risk_for_intent(intent: str) -> str:
    if intent in HIGH_RISK_INTENTS:
        return "high"
    if intent in MEDIUM_RISK_INTENTS:
        return "medium"
    return "low"


def highest_risk(*values: str | None) -> str:
    normalized = [value for value in values if value in RISK_ORDER]
    return max(normalized, key=lambda value: RISK_ORDER[value], default="low")


def structure_operational_context(text: str) -> dict[str, Any]:
    clean_lines: list[str] = []
    seen: set[str] = set()
    for raw_line in str(text or "").splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line or line in seen:
            continue
        seen.add(line)
        clean_lines.append(line[:500])

    sections: dict[str, list[str]] = {key: [] for key in SECTION_TERMS}
    other: list[str] = []
    for line in clean_lines:
        lowered = line.casefold()
        matched = False
        for section, terms in SECTION_TERMS.items():
            if any(term.casefold() in lowered for term in terms):
                sections[section].append(line)
                matched = True
        if not matched:
            other.append(line)

    order_refs = list(dict.fromkeys(ORDER_REF_RE.findall("\n".join(clean_lines))))[:5]
    skus = list(dict.fromkeys(SKU_RE.findall("\n".join(clean_lines))))[:10]
    return {
        "available": bool(clean_lines),
        "order_refs": order_refs,
        "skus": skus,
        "sections": {key: values[:30] for key, values in sections.items() if values},
        "other": other[:20],
        "raw_text": "\n".join(clean_lines)[:20_000],
    }


def parse_json_object(value: str) -> dict[str, Any] | None:
    text = str(value or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            payload = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return payload if isinstance(payload, dict) else None


def normalize_string_list(value: Any, limit: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip()[:300] for item in value if str(item).strip()][:limit]


def deterministic_quality_issues(
    reply: str,
    *,
    intent: str,
    operational_context_available: bool,
    knowledge_available: bool = False,
) -> list[str]:
    text = reply.strip()
    lowered = text.casefold()
    issues: list[str] = []
    if not text:
        return ["empty_reply"]
    if len(text) > 1_200:
        issues.append("reply_too_long")
    if any(marker in lowered for marker in ("as an ai", "system prompt", "knowledge base", "内部字段", "提示词")):
        issues.append("internal_information_exposure")
    unsupported_execution = (
        "i have refunded",
        "we have refunded",
        "refund has been processed",
        "already shipped",
        "已为您退款",
        "退款已完成",
        "已经为您发货",
    )
    if any(marker in lowered for marker in unsupported_execution):
        issues.append("claims_completed_action")
    certainty_markers = ("guarantee", "definitely arrive", "一定会到", "保证送达")
    if not operational_context_available and any(marker in lowered for marker in certainty_markers):
        issues.append("unsupported_promise")
    unsupported_resource_markers = (
        "i'll send you the link",
        "i will send you the link",
        "i'll send the video",
        "i will send the video",
        "gửi link video cho bạn",
        "发送视频链接给您",
        "给您发送视频",
    )
    if not knowledge_available and any(marker in lowered for marker in unsupported_resource_markers):
        issues.append("unsupported_resource_promise")
    if intent in HIGH_RISK_INTENTS and len(text) < 12:
        issues.append("high_risk_reply_too_short")
    return issues


def edit_similarity(original: str, final: str) -> float:
    return round(SequenceMatcher(None, original.strip(), final.strip()).ratio(), 4)


def format_examples(examples: Iterable[dict[str, Any]]) -> str:
    blocks = []
    for index, example in enumerate(examples, start=1):
        customer = str(example.get("customer_message") or "").strip()
        reply = str(example.get("final_reply") or "").strip()
        if customer and reply:
            blocks.append(f"示例{index}\n客户：{customer[:500]}\n已采用回复：{reply[:1000]}")
    return "\n\n".join(blocks)
