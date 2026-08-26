export function resolveMaxDevices(currentMaxDevices: number, purchasedMaxDevices: number, licenseIsActive: boolean): number {
  return licenseIsActive ? Math.max(currentMaxDevices, purchasedMaxDevices) : purchasedMaxDevices;
}
