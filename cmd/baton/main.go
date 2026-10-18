package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"baton/internal/agentcli"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := agentcli.Run(ctx, os.Args[1:], os.Stdout, os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
