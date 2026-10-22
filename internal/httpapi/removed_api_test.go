package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRemovedTaskAndSessionAPIsAreNotFound(t *testing.T) {
	api := &Server{log: slog.New(slog.DiscardHandler)}
	const id = "00000000-0000-4000-8000-000000000001"
	paths := []string{
		"/tasks", "/tasks/", "/tasks/" + id,
		"/tasks/" + id + "/events", "/tasks/" + id + "/cancel", "/tasks/" + id + "/resolve", "/tasks/" + id + "/rerun", "/tasks/" + id + "/acceptance",
		"/sessions", "/sessions/", "/sessions/" + id,
		"/sessions/" + id + "/history", "/sessions/" + id + "/input", "/sessions/" + id + "/supplement", "/sessions/" + id + "/stop",
		"/acceptances", "/acceptances/" + id,
	}
	for _, path := range paths {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			t.Run(method+path, func(t *testing.T) {
				response := httptest.NewRecorder()
				api.ServeHTTP(response, httptest.NewRequest(method, "/api/v1"+path, nil))
				var body errorBody
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if response.Code != http.StatusNotFound || body.Code != "not_found" {
					t.Fatalf("%d %s", response.Code, response.Body.String())
				}
			})
		}
	}
}
