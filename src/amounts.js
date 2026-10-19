export function parseDecimalToWei(value, decimals = 18) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Valor decimal invalido: ${value}`);
  }
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction.slice(0, decimals)}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatWeiToDecimal(wei, decimals = 18, precision = 6) {
  const value = BigInt(wei);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (precision <= 0) return whole.toString();
  const fractionText = fraction.toString().padStart(decimals, "0").slice(0, precision);
  const trimmed = fractionText.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

export function hexWeiToBigInt(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) {
    throw new Error(`Wei hex invalido: ${hex}`);
  }
  return BigInt(hex);
}
