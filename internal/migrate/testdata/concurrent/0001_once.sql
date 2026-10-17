CREATE TABLE once_run (
    id integer PRIMARY KEY
);

INSERT INTO once_run (id) VALUES (1);

SELECT pg_sleep(0.5);
