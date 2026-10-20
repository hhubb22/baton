package db

import (
	"strings"
	"testing"
)

func TestValidatePostgreSQLVersion(t *testing.T) {
	for _, tt := range []struct {
		name    string
		num     int
		version string
		wantErr bool
	}{
		{"unknown", 0, "unknown", true},
		{"14", 140020, "14.20", true},
		{"15", 150015, "15.15", true},
		{"below_minimum", 159999, "15.9999", true},
		{"16_initial", 160000, "16.0", false},
		{"16_patch", 160015, "16.15 (Ubuntu)", false},
		{"17", 170011, "17.11", false},
		{"18", 180000, "18.0", false},
		{"future", 190000, "19.0", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePostgreSQLVersion(tt.num, tt.version)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validatePostgreSQLVersion(%d, %q) = %v, wantErr %v", tt.num, tt.version, err, tt.wantErr)
			}
			if err != nil && (!strings.Contains(err.Error(), "需要 PostgreSQL 16 或更高版本") || !strings.Contains(err.Error(), tt.version)) {
				t.Fatalf("版本错误缺少最低版本或当前版本: %v", err)
			}
		})
	}
}
