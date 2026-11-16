// VIN rule (CLAUDE.md → VINs; ISO 3779 check digit, as used in China under GB 16735): 17 characters, no I, O or Q,
// position 9 is the check digit. Shared by web (instant feedback) and api (the rule that counts).
import { z } from 'zod';

// ISO 3779 transliteration: each allowed character's value sits at the same index in VALUES. Weights per position,
// in hex so the 10 at position 8 fits one character.
const ALLOWED = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
const VALUES = '012345678912345678123457923456789';
const WEIGHTS = '8765432A098765432';

/** Why a VIN is invalid, or null if it is valid. Expects the VIN already trimmed and upper-cased. */
export function vinProblem(vin: string): string | null {
  if (vin.length !== 17) return 'a VIN has 17 characters';
  if (/[IOQ]/.test(vin)) return 'a VIN never contains I, O or Q';
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return 'a VIN has only letters and digits';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += parseInt(VALUES.charAt(ALLOWED.indexOf(vin.charAt(i))), 10) * parseInt(WEIGHTS.charAt(i), 16);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin.charAt(8) === check ? null : `check digit (9th character) should be ${check}`;
}

/** A VIN as typed or scanned: trimmed and upper-cased. Invalid ones are not rejected here: they import with
 *  status vin_needs_correction (see vinStatus), so a bad VIN on a real document is recorded, never silently fixed. */
export const VinInput = z.string().trim().toUpperCase().min(1);
export const vinStatus = (vin: string): 'ok' | 'vin_needs_correction' => (vinProblem(vin) === null ? 'ok' : 'vin_needs_correction');
