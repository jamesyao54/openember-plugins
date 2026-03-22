export function normalizeMobile(input: string): string | null {
  let cleaned = input.replace(/[\s\-()]/g, "");
  cleaned = cleaned.replace(/^(\+86|0086|86)/, "");
  if (/^1[3-9]\d{9}$/.test(cleaned)) return cleaned;
  return null;
}

export function maskMobile(mobile: string): string {
  return mobile.slice(0, 3) + "****" + mobile.slice(7);
}
