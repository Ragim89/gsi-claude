-- =====================================================================================
-- fx_rate_on(): fall back to the earliest known rate for dates before the rate history.
--
-- Fixed assets are bought years before the rate table starts, so the original lookup returned
-- NULL for them and their acquisition cost silently dropped out of every consolidated sum.
-- A rate from the nearest date we do know is an approximation, but a visible one — and far
-- better than treating a five-year-old office as worth nothing.
-- =====================================================================================

CREATE OR REPLACE FUNCTION fx_rate_on(p_currency char(3), p_base char(3), p_date date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_currency = p_base THEN 1::numeric ELSE COALESCE(
    -- the latest rate on or before the date …
    (SELECT r.rate FROM fx_rates r
      WHERE r.currency = p_currency AND r.base_currency = p_base AND r.rate_date <= p_date
      ORDER BY r.rate_date DESC LIMIT 1),
    -- … otherwise the earliest rate we have at all
    (SELECT r.rate FROM fx_rates r
      WHERE r.currency = p_currency AND r.base_currency = p_base
      ORDER BY r.rate_date ASC LIMIT 1)
  ) END
$$;
