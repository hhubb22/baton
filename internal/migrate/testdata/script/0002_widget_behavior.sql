/*
CREATE TABLE should_not_exist (id integer);
*/

CREATE FUNCTION widget_note() RETURNS text
LANGUAGE sql
AS $$
    SELECT 'keep; this';
$$;

CREATE FUNCTION widget_label() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.label := NEW.label || ';trg';
    RETURN NEW;
END;
$$;

CREATE TRIGGER widget_label_trg
    BEFORE INSERT ON widget
    FOR EACH ROW
    EXECUTE FUNCTION widget_label();

DO $$
BEGIN
    INSERT INTO widget (id, label) VALUES (1, E'a;b\'c');
END
$$;
