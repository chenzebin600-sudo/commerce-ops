from __future__ import annotations

import re
from typing import Any, MutableMapping


EXCEL_CELL_ERROR_CODE = "EXCEL_CELL_UNSAFE"
_LEADING_EXCEL_WHITESPACE = re.compile(
    r"^[\s\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*"
)
_NEGATIVE_NUMBER_TEXT = re.compile(
    r"^-(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?%?$",
    re.IGNORECASE,
)


class ExcelCellUnsafeError(ValueError):
    code = EXCEL_CELL_ERROR_CODE


def is_unsafe_excel_text(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    match = _LEADING_EXCEL_WHITESPACE.match(value)
    candidate = value[match.end():] if match else value
    if not candidate or candidate.startswith("'"):
        return False
    prefix = candidate[0]
    if prefix in ("=", "+", "@"):
        return True
    return prefix == "-" and _NEGATIVE_NUMBER_TEXT.fullmatch(candidate) is None


def sanitize_excel_text(
    value: Any,
    *,
    trusted_formula: bool = False,
    stats: MutableMapping[str, int] | None = None,
) -> Any:
    if not isinstance(value, str) or trusted_formula or not is_unsafe_excel_text(value):
        return value
    if stats is not None:
        stats["sanitized"] = int(stats.get("sanitized", 0)) + 1
    return "'" + value
