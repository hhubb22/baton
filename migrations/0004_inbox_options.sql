ALTER TABLE attention_requests DROP CONSTRAINT attention_requests_options_check;
ALTER TABLE attention_requests ADD CONSTRAINT attention_requests_options_check
    CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 50);
