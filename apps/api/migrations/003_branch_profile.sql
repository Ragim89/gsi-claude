-- =====================================================================================
-- Branch profile: full legal/banking requisites, the person who heads the entity, photos.
--
-- Needed for the branch card and for printed forms (invoice bank details, letterhead
-- signatory). ASSUMPTION: actual registration, tax and bank data must come from GSI
-- (docs/07-open-questions.md #2); the seed fills placeholders marked "TBC".
-- =====================================================================================

ALTER TABLE branches
  ADD COLUMN legal_form       text,            -- A.Ş. / SRL / LLC / FZE …
  ADD COLUMN registration_no  text,            -- trade register / OGRN / CUI …
  ADD COLUMN tax_id           text,            -- tax number / INN / VKN …
  ADD COLUMN vat_number       text,
  ADD COLUMN bank_name        text,
  ADD COLUMN bank_account     text,            -- IBAN or local account number
  ADD COLUMN bank_swift       text,
  ADD COLUMN website          text,
  ADD COLUMN established_year integer CHECK (established_year BETWEEN 1900 AND 2100),
  ADD COLUMN description      text,
  -- The manager of the entity: a user of this same branch (composite FK enforces it).
  ADD COLUMN head_user_id     uuid,
  ADD COLUMN head_title       text,
  ADD COLUMN head_photo_key   text,            -- object key in S3-compatible storage
  ADD COLUMN photo_key        text;            -- office / team photo

ALTER TABLE branches
  ADD CONSTRAINT branches_head_fk FOREIGN KEY (head_user_id, id) REFERENCES users (id, branch_id);
