const SCALE_DIGITS = 6;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export function decimalToScaled(value) {
  if (typeof value === "bigint") return value;
  const normalized = String(value ?? "").trim().replaceAll(",", "");
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new TypeError(`Invalid decimal value: ${String(value).slice(0, 80)}`);
  const fraction = `${match[3] || ""}${"0".repeat(SCALE_DIGITS)}`.slice(0, SCALE_DIGITS);
  const scaled = BigInt(match[2]) * SCALE + BigInt(fraction || "0");
  return match[1] ? -scaled : scaled;
}

export function scaledToDecimal(value) {
  const scaled = BigInt(value);
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const integer = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function multiplyDecimals(left, right) {
  const product = decimalToScaled(left) * decimalToScaled(right);
  const rounded = product >= 0n ? (product + SCALE / 2n) / SCALE : (product - SCALE / 2n) / SCALE;
  return rounded;
}

export function divideDecimals(left, right) {
  const divisor = decimalToScaled(right);
  if (divisor <= 0n) throw new RangeError("Decimal divisor must be greater than zero");
  const dividend = decimalToScaled(left) * SCALE;
  return dividend >= 0n ? (dividend + divisor / 2n) / divisor : (dividend - divisor / 2n) / divisor;
}

export function percentageString(numerator, denominator) {
  const base = BigInt(denominator);
  if (base <= 0n) return null;
  const value = BigInt(numerator);
  const precision = 100_000_000n;
  const scaledPercent = value * 100n * precision / base;
  const negative = scaledPercent < 0n;
  const absolute = negative ? -scaledPercent : scaledPercent;
  const integer = absolute / precision;
  const fraction = String(absolute % precision).padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function sumScaled(values) {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}
