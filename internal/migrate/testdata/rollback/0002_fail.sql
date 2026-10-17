CREATE TABLE doomed (
    id integer PRIMARY KEY
);

INSERT INTO doomed (id) VALUES (1);

DO $$
BEGIN
    RAISE EXCEPTION 'migration failed';
END
$$;

INSERT INTO doomed (id) VALUES (2);
