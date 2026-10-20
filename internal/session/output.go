package session

import (
	"database/sql"
	"fmt"
	"time"

	"baton/internal/task"
)

// saveOutputLocked commits one drained item and its audit events together. The
// receipt lets a retry recognize a commit whose acknowledgement was lost.
func (w *workerDB) saveOutputLocked(sessionID, payload string, out Output, receipt string, native bool) error {
	if w.cancelled {
		if candidate, err := task.ParseCandidate(out.Final); err == nil && candidate.CommandResult != nil {
			w.pendingStopOutput = out.Final
		}
	}
	conn, tx, err := w.beginOutputTx()
	if err != nil {
		return err
	}
	defer rollbackOutputTx(conn, tx)
	var committed bool
	err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM execution_log WHERE kind='output_commit' AND body=?)`, receipt).Scan(&committed)
	if err != nil {
		return err
	}
	meaningful := !native || payload != "" || out.Final != "" || out.Exited || out.Uncertain || out.WaitingForChildren || len(out.Progress) > 0
	var deliveryUncertain bool
	if !committed {
		if len(out.Raw) > 0 {
			if err := insertLog(tx, "native_event", string(out.Raw), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
		}
		if w.cancelled {
			if err := w.writeStopOutputTx(tx); err != nil {
				return err
			}
		} else if meaningful {
			result, err := w.resultLocked(tx)
			if err != nil {
				return err
			}
			if native && result == nil && !w.resultDelivered {
				res, err := tx.Exec(`DELETE FROM native_delivery_checks`)
				if err != nil {
					return err
				}
				n, err := res.RowsAffected()
				if err != nil {
					return err
				}
				deliveryUncertain = n > 0
				if deliveryUncertain {
					out = Output{Uncertain: true, Exited: out.Exited}
				}
			}
			if err := w.recordExecutionTx(tx, sessionID, payload, out); err != nil {
				return err
			}
			if native && result == nil && !w.resultDelivered && !out.Uncertain && (out.Exited || out.WaitingForChildren) {
				if err := putMeta(tx, "output_recovery:"+receipt, fmt.Sprint(w.generation)); err != nil {
					return err
				}
			}
		}
		if err := insertLog(tx, "output_commit", receipt, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
		if err := w.confirmOutputCommit(conn, tx, receipt); err != nil {
			return err
		}
	} else {
		// Release the only SQLite connection before reading committed state.
		if err := rollbackOutputTx(conn, tx); err != nil {
			return err
		}
	}
	if w.cancelled {
		w.pendingStopOutput = ""
	}
	if err := w.refreshOutputStateLocked(receipt); err != nil {
		return err
	}
	if w.adapter == nil && !committed {
		for _, text := range out.Progress {
			w.appendLiveLocked(text+"\n", false)
		}
		w.appendLiveLocked(out.Final, false)
	}
	return nil
}

func (w *workerDB) refreshOutputStateLocked(receipt string) error {
	result, err := w.resultLocked(w.db)
	if err != nil {
		return err
	}
	var resolved string
	var uncertain, recovered bool
	if err := w.db.QueryRow(`SELECT COALESCE((SELECT value FROM meta WHERE key='input_resolved'),'0'),
		EXISTS(SELECT 1 FROM child_deliveries WHERE status='uncertain'),
		EXISTS(SELECT 1 FROM meta WHERE key=? AND value=?)`, "output_recovery:"+receipt, fmt.Sprint(w.generation)).Scan(&resolved, &uncertain, &recovered); err != nil {
		return err
	}
	w.inputResolved = resolved == "1" || result != nil
	w.deliveryUncertain = uncertain
	if !w.cancelled && (recovered || result != nil && (result.Status == task.StatusCompleted || result.Status == task.StatusFailed)) {
		w.recoveredUncertain = false
		w.uncertainCode = ""
	}
	return nil
}

func (w *workerDB) confirmOutputCommit(conn *sql.Conn, tx *sql.Tx, receipt string) error {
	return commitOutputTx(conn, tx, func() (bool, error) {
		var saved bool
		err := w.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM execution_log WHERE kind='output_commit' AND body=?)`, receipt).Scan(&saved)
		return saved, err
	})
}
