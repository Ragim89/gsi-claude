-- ---------------------------------------------------------------------------------------
-- 025. Refresh token registry (PHASE 12).
--
-- Until now a refresh token was a self-contained JWT: valid for its full 7-day life no
-- matter what happened to the account it named. This gives the server a row per token, so
-- a session can be told "no" before its JWT would have expired on its own.
--
-- The table is never touched by application SQL directly — like doc_counters (001), it is
-- RLS-enabled with no policies, reachable only through the SECURITY DEFINER functions below.
-- Login happens before any branch/user context exists, exactly like auth_find_user (008).
--
-- Rotation is a single atomic function, not three round trips from the service: the row is
-- locked with FOR UPDATE so two refreshes racing on the same token cannot both succeed, and
-- presenting a token a second time — the token that theft looks like — burns every other
-- token in its family instead of quietly issuing a new one.
-- ---------------------------------------------------------------------------------------

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Shared by every token descended from the same login; rotation keeps it, reuse burns it.
  family_id      uuid NOT NULL,
  -- Only the SHA-256 of the token is stored; the raw value is never written to disk.
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  replaced_by    uuid REFERENCES refresh_tokens(id),
  last_used_at   timestamptz,
  ip             inet,
  user_agent     text
);

CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY; -- no policies: only via the functions below

-- ---------- issue (login) --------------------------------------------------------------
CREATE FUNCTION auth_issue_refresh_token(
  p_user uuid, p_token_hash text, p_ttl_seconds integer, p_ip inet, p_user_agent text
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, ip, user_agent)
  VALUES (p_user, gen_random_uuid(), p_token_hash, now() + make_interval(secs => p_ttl_seconds), p_ip, p_user_agent)
  RETURNING id;
$$;

-- ---------- rotate (refresh) -------------------------------------------------------------
-- denied=true covers every reason to refuse: unknown token, expired token, deactivated user,
-- and reuse. The caller does not need to know which — it always just signs the person out —
-- but reused=true additionally says this was a replay, worth its own audit trail entry.
CREATE FUNCTION auth_rotate_refresh_token(
  p_token_hash text, p_new_hash text, p_new_ttl_seconds integer, p_ip inet, p_user_agent text
) RETURNS TABLE (user_id uuid, new_id uuid, reused boolean, denied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row refresh_tokens%ROWTYPE;
  v_new_id uuid;
  v_active boolean;
BEGIN
  SELECT * INTO v_row FROM refresh_tokens WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, false, true;
    RETURN;
  END IF;

  IF v_row.revoked_at IS NOT NULL THEN
    UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse_detected'
      WHERE family_id = v_row.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT v_row.user_id, NULL::uuid, true, true;
    RETURN;
  END IF;

  IF v_row.expires_at < now() THEN
    UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'expired' WHERE id = v_row.id;
    RETURN QUERY SELECT v_row.user_id, NULL::uuid, false, true;
    RETURN;
  END IF;

  SELECT is_active INTO v_active FROM users WHERE id = v_row.user_id;
  IF v_active IS NOT TRUE THEN
    UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'user_inactive' WHERE id = v_row.id;
    RETURN QUERY SELECT v_row.user_id, NULL::uuid, false, true;
    RETURN;
  END IF;

  INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, ip, user_agent)
  VALUES (v_row.user_id, v_row.family_id, p_new_hash, now() + make_interval(secs => p_new_ttl_seconds), p_ip, p_user_agent)
  RETURNING id INTO v_new_id;

  UPDATE refresh_tokens
    SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = v_new_id, last_used_at = now()
    WHERE id = v_row.id;

  RETURN QUERY SELECT v_row.user_id, v_new_id, false, false;
END $$;

-- ---------- logout (current session) ----------------------------------------------------
CREATE FUNCTION auth_revoke_refresh_token(p_token_hash text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
  WHERE token_hash = p_token_hash AND revoked_at IS NULL
  RETURNING true;
$$;

-- ---------- logout all devices / deactivation --------------------------------------------
CREATE FUNCTION auth_revoke_all_refresh_tokens(p_user uuid, p_reason text DEFAULT 'logout_all')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = p_reason
    WHERE user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION auth_issue_refresh_token(uuid, text, integer, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_rotate_refresh_token(text, text, integer, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_refresh_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_all_refresh_tokens(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_issue_refresh_token(uuid, text, integer, inet, text) TO gsi_app;
GRANT EXECUTE ON FUNCTION auth_rotate_refresh_token(text, text, integer, inet, text) TO gsi_app;
GRANT EXECUTE ON FUNCTION auth_revoke_refresh_token(text) TO gsi_app;
GRANT EXECUTE ON FUNCTION auth_revoke_all_refresh_tokens(uuid, text) TO gsi_app;
