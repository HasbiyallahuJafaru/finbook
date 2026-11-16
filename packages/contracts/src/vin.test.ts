import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VinInput, vinProblem, vinStatus } from './vin.ts';

test('valid VINs pass, including an X check digit', () => {
  assert.equal(vinProblem('1M8GDM9AXKP042788'), null); // the ISO 3779 textbook example (check digit X)
  assert.equal(vinProblem('11111111111111111'), null); // weights sum to 89 → 89 % 11 = 1
  assert.equal(vinStatus('1M8GDM9AXKP042788'), 'ok');
});

test('each rule gives its own reason', () => {
  assert.equal(vinProblem('1M8GDM9AXKP04278'), 'a VIN has 17 characters');
  assert.equal(vinProblem('1M8GDM9AXKP0427O8'), 'a VIN never contains I, O or Q');
  assert.equal(vinProblem('1M8GDM9AXKP04278-'), 'a VIN has only letters and digits');
  assert.equal(vinProblem('1M8GDM9A1KP042788'), 'check digit (9th character) should be X');
  assert.equal(vinStatus('1M8GDM9A1KP042788'), 'vin_needs_correction');
});

test('input is trimmed and upper-cased before checking; empty is refused', () => {
  assert.equal(VinInput.parse('  1m8gdm9axkp042788 '), '1M8GDM9AXKP042788');
  assert.equal(VinInput.safeParse('   ').success, false);
});
