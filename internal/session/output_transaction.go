package session

import (
	"database/sql"
	"database/sql/driver"
	"errors"
)

// commitOutputTx releases the pinned connection before checking durable state.
// A failed SQLite COMMIT can leave its transaction active after sql.Tx is done;
// discarding that connection prevents uncommitted reads and nested transactions.
func commitOutputTx(conn *sql.Conn, tx *sql.Tx, committed func() (bool, error)) error {
	commitErr := tx.Commit()
	if commitErr == nil {
		return conn.Close()
	}
	if err := discardOutputConn(conn); err != nil {
		return errors.Join(commitErr, err)
	}
	// The failed transaction's connection is gone; this read uses an independent
	// connection and can only observe committed rows.
	saved, err := committed()
	if err == nil && saved {
		return nil
	}
	return errors.Join(commitErr, err)
}

func rollbackOutputTx(conn *sql.Conn, tx *sql.Tx) error {
	err := tx.Rollback()
	if err != nil && !errors.Is(err, sql.ErrTxDone) {
		return errors.Join(err, discardOutputConn(conn))
	}
	if err := conn.Close(); err != nil && !errors.Is(err, sql.ErrConnDone) {
		return err
	}
	return nil
}

func discardOutputConn(conn *sql.Conn) error {
	err := conn.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) {
		return nil
	}
	return err
}
