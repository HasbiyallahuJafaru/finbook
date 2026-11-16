-- VIN rule in the database (CLAUDE.md → VINs; ISO 3779, GB 16735): 17 characters, no I/O/Q, check digit at position 9.
-- vehicles.vin_status is generated from it (0012), so no client can mark a bad VIN as good. Mirrors vinProblem() in
-- packages/contracts/src/vin.ts, which gives the user the reason; a test runs both on the same VINs.
CREATE FUNCTION vin_status_of(vin text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN vin !~ '^[A-HJ-NPR-Z0-9]{17}$' THEN 'vin_needs_correction'
    WHEN substr(vin, 9, 1) = (
      SELECT CASE WHEN s % 11 = 10 THEN 'X' ELSE (s % 11)::text END
        FROM (SELECT sum(substr('012345678912345678123457923456789', strpos('0123456789ABCDEFGHJKLMNPRSTUVWXYZ', substr(vin, i, 1)), 1)::int
                         * (ARRAY[8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2])[i]) AS s
                FROM generate_series(1, 17) AS i) t)
      THEN 'ok'
    ELSE 'vin_needs_correction'
  END
$$;
