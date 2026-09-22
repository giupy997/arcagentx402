/** The text a seller signs. Kept identical to the API's copy by a test. */
export function registrationMessage(payTo: string, issuedAt: string): string {
  return ["CRA AGENT facilitator", "", "Register this wallet as a seller. Payments to it may be settled by the CRA facilitator on Arc, within its daily allowance. No funds move by signing this.", "", `Wallet: ${payTo}`, `Issued: ${issuedAt}`].join("\n");
}
