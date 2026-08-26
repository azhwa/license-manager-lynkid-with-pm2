const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function formatLicenseKey(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < 16; index += 1) output += alphabet[bytes[index % bytes.length] % alphabet.length];
  return output.match(/.{1,4}/g)?.join('-') ?? '';
}

export function generateLicenseKey(): string { return formatLicenseKey(crypto.getRandomValues(new Uint8Array(16))); }
