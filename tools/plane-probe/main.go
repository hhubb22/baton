// Command plane-probe checks a Plane webhook signature against the raw body.
// It reads PLANE_WEBHOOK_SECRET from the environment and does not print it.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("plane-probe", flag.ContinueOnError)
	fs.SetOutput(stderr)
	bodyPath := fs.String("body", "", "raw request body file, or - for stdin")
	signature := fs.String("signature", "", "X-Plane-Signature hexadecimal value")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: plane-probe -body FILE -signature HEX")
		fmt.Fprintln(stderr, "PLANE_WEBHOOK_SECRET must be set. The secret is not printed.")
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *bodyPath == "" || *signature == "" {
		fs.Usage()
		return errors.New("body and signature are required")
	}
	var (
		body []byte
		err  error
	)
	if *bodyPath == "-" {
		body, err = io.ReadAll(os.Stdin)
	} else {
		body, err = os.ReadFile(*bodyPath)
	}
	if err != nil {
		return err
	}
	ok, err := verifySignature([]byte(getenv("PLANE_WEBHOOK_SECRET")), body, *signature)
	if err != nil {
		return err
	}
	if ok {
		fmt.Fprintln(stdout, "match=true")
		return nil
	}
	fmt.Fprintln(stdout, "match=false")
	return errors.New("signature mismatch")
}
