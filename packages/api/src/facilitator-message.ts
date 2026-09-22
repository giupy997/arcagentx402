/**
 * The text a seller signs to register a wallet with the facilitator. Plain words, because the
 * wallet shows them: the signer should understand what they agree to. The time in it bounds how
 * long a signature can be replayed, which matters little (registration is idempotent) but is free.
 */
export function registrationMessage(payTo: string, issuedAt: string): string {
  return ["CRA AGENT facilitator", "", "Register this wallet as a seller. Payments to it may be settled by the CRA facilitator on Arc, within its daily allowance. No funds move by signing this.", "", `Wallet: ${payTo}`, `Issued: ${issuedAt}`].join("\n");
}
export const REGISTRATION_MAX_AGE_MS = 15 * 60_000;
