export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyLynkSignature(signature: string | null, grandTotal: number, refId: string, messageId: string, merchantKey: string): Promise<boolean> {
  if (!signature || !merchantKey) return false;
  const expected = await sha256Hex(`${grandTotal}${refId}${messageId}${merchantKey}`);
  const actual = signature.trim().toLowerCase();
  if (actual.length !== expected.length) return false;
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  let mismatch = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) mismatch |= actualBytes[index] ^ expectedBytes[index];
  return mismatch === 0;
}
