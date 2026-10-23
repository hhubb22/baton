package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/inbox"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

type fixtureBrowserThreadOutput struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id,omitempty"`
	protocol.SessionResult
}

type fixtureInboxConflictResponse struct {
	Error   string        `json:"error"`
	Current inbox.Request `json:"current"`
}

type fixtureSetProjectExecInput struct {
	Enabled *bool `json:"enabled"`
}

type fixtureUpdateBrowseRootsInput struct {
	Path string `json:"path"`
}

type fixtureSubscriptionLoginInput struct {
	Provider string `json:"provider"`
}

type fixtureSubscriptionLoginResponse struct {
	Provider         string `json:"provider"`
	VerificationURI  string `json:"verification_uri"`
	UserCode         string `json:"user_code"`
	ExpiresInSeconds int    `json:"expires_in_seconds"`
}

type fixtureEnrollmentResponse struct {
	EnrollmentID    string `json:"enrollment_id"`
	EnrollmentToken string `json:"enrollment_token"`
	ExpiresAt       any    `json:"expires_at"`
	ExpiresInMS     int64  `json:"expires_in_ms"`
}

type fixtureRegisterNodeInput struct {
	EnrollmentToken string    `json:"enrollment_token"`
	DisplayName     string    `json:"display_name"`
	System          string    `json:"system"`
	Role            string    `json:"role"`
	Capabilities    *[]string `json:"capabilities"`
}

type fixtureNodesResponse struct {
	Nodes              []nodeStatusJSON  `json:"nodes"`
	DefaultDevice      defaultDeviceJSON `json:"default_device"`
	DefaultPC          defaultDeviceJSON `json:"default_pc"`
	LocalProcessNotice string            `json:"local_process_notice"`
}

type fixtureRevokeNodeResponse struct {
	NodeID             string            `json:"node_id"`
	Status             string            `json:"status"`
	OperatorID         string            `json:"operator_id"`
	CredentialIDs      []string          `json:"credential_ids"`
	RequestedAt        time.Time         `json:"requested_at"`
	AppliedAt          *time.Time        `json:"applied_at"`
	Message            string            `json:"message"`
	LocalProcessNotice string            `json:"local_process_notice"`
	DefaultDevice      defaultDeviceJSON `json:"default_device"`
	DefaultPC          defaultDeviceJSON `json:"default_pc"`
}

type fixtureSetDefaultDeviceInput struct {
	NodeID string `json:"node_id"`
}

type fixtureProjectsResponse struct {
	Projects    []projectagent.Project `json:"projects"`
	NextAfterID string                 `json:"next_after_id,omitempty"`
}

type fixtureOKResponse struct {
	OK bool `json:"ok"`
}

type fixtureMemoryRevisionsResponse struct {
	Revisions []store.MemoryRevision `json:"revisions"`
	Next      int64                  `json:"next_after_revision,omitempty"`
}

type fixtureMemoriesResponse struct {
	Entries     []projectagent.Memory `json:"entries"`
	NextAfterID string                `json:"next_after_id,omitempty"`
}

type fixtureWriteMemoryInput struct {
	Title            string `json:"title"`
	Content          string `json:"content"`
	ExpectedRevision *int64 `json:"expected_revision"`
}

type fixtureMemoryConflictResponse struct {
	Code            string               `json:"code"`
	Message         string               `json:"message"`
	RequestID       string               `json:"request_id"`
	CurrentRevision int64                `json:"current_revision"`
	Current         *projectagent.Memory `json:"current"`
}

type fixtureLoginInput struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type fixtureChangePasswordInput struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

type fixtureCreateBrowserThreadInput struct {
	ClientThreadID   string `json:"client_thread_id"`
	NodeID           string `json:"node_id"`
	AgentType        string `json:"agent_type"`
	Model            string `json:"model"`
	WorkingDirectory string `json:"working_directory"`
	Message          struct {
		ClientMessageID string `json:"client_message_id"`
		Content         string `json:"content"`
	} `json:"message"`
}

type fixtureSetThreadModelInput struct {
	Model string `json:"model"`
}

type fixtureThreadErrorResponse struct {
	*store.ThreadError
	RequestID string `json:"request_id"`
}

type fixtureNodeSyncRequest struct {
	Type         string   `json:"type"`
	DisplayName  string   `json:"display_name"`
	System       string   `json:"system"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
}
type fixtureNodeSyncResult struct {
	Type string `json:"type"`
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

type protocolFixtureType struct {
	Value  any
	Source string
	GoName string
}

func TestExportProtocolFixtures(t *testing.T) {
	types := map[string]protocolFixtureType{
		"NodeSyncRequest":           {Value: fixtureNodeSyncRequest{}, Source: "internal/control/server.go", GoName: "onEnvelope2"},
		"NodeSyncResult":            {Value: fixtureNodeSyncResult{}, Source: "internal/control/server.go", GoName: "reply1"},
		"FileRequest":               {Value: protocol.FileRequest{}, Source: "internal/protocol/files.go", GoName: "FileRequest"},
		"FileRoot":                  {Value: protocol.FileRoot{}, Source: "internal/protocol/files.go", GoName: "FileRoot"},
		"FileEntry":                 {Value: protocol.FileEntry{}, Source: "internal/protocol/files.go", GoName: "FileEntry"},
		"FileRemainder":             {Value: protocol.FileRemainder{}, Source: "internal/protocol/files.go", GoName: "FileRemainder"},
		"FileResult":                {Value: protocol.FileResult{}, Source: "internal/protocol/files.go", GoName: "FileResult"},
		"HistoryEntry":              {Value: protocol.HistoryEntry{}, Source: "internal/protocol/history.go", GoName: "HistoryEntry"},
		"SessionHistoryPage":        {Value: protocol.SessionHistoryPage{}, Source: "internal/protocol/history.go", GoName: "SessionHistoryPage"},
		"ProjectExecRequest":        {Value: protocol.ProjectExecRequest{}, Source: "internal/protocol/node_settings.go", GoName: "ProjectExecRequest"},
		"ProjectExecResult":         {Value: protocol.ProjectExecResult{}, Source: "internal/protocol/node_settings.go", GoName: "ProjectExecResult"},
		"BrowseRootsRequest":        {Value: protocol.BrowseRootsRequest{}, Source: "internal/protocol/node_settings.go", GoName: "BrowseRootsRequest"},
		"BrowseRootsResult":         {Value: protocol.BrowseRootsResult{}, Source: "internal/protocol/node_settings.go", GoName: "BrowseRootsResult"},
		"SubscriptionLoginRequest":  {Value: protocol.SubscriptionLoginRequest{}, Source: "internal/protocol/node_settings.go", GoName: "SubscriptionLoginRequest"},
		"SubscriptionLoginResult":   {Value: protocol.SubscriptionLoginResult{}, Source: "internal/protocol/node_settings.go", GoName: "SubscriptionLoginResult"},
		"ProjectThreadUpdate":       {Value: protocol.ProjectThreadUpdate{}, Source: "internal/protocol/project_runtime.go", GoName: "ProjectThreadUpdate"},
		"ProjectRunCommand":         {Value: protocol.ProjectRunCommand{}, Source: "internal/protocol/project_runtime.go", GoName: "ProjectRunCommand"},
		"ProjectRuntimeRequest":     {Value: protocol.ProjectRuntimeRequest{}, Source: "internal/protocol/project_runtime.go", GoName: "ProjectRuntimeRequest"},
		"ProjectRuntimeResult":      {Value: protocol.ProjectRuntimeResult{}, Source: "internal/protocol/project_runtime.go", GoName: "ProjectRuntimeResult"},
		"Envelope":                  {Value: protocol.Envelope{}, Source: "internal/protocol/protocol.go", GoName: "Envelope"},
		"Route":                     {Value: protocol.Route{}, Source: "internal/protocol/protocol.go", GoName: "Route"},
		"Source":                    {Value: protocol.Source{}, Source: "internal/protocol/protocol.go", GoName: "Source"},
		"Revocation":                {Value: protocol.Revocation{}, Source: "internal/protocol/protocol.go", GoName: "Revocation"},
		"Presence":                  {Value: protocol.Presence{}, Source: "internal/protocol/protocol.go", GoName: "Presence"},
		"Frame":                     {Value: protocol.Frame{}, Source: "internal/protocol/protocol.go", GoName: "Frame"},
		"RuntimeReport":             {Value: protocol.RuntimeReport{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeReport"},
		"RuntimeAgent":              {Value: protocol.RuntimeAgent{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeAgent"},
		"RuntimeModel":              {Value: protocol.RuntimeModel{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeModel"},
		"ThreadCapabilities":        {Value: protocol.ThreadCapabilities{}, Source: "internal/protocol/runtime_report.go", GoName: "ThreadCapabilities"},
		"ProjectRuntime":            {Value: protocol.ProjectRuntime{}, Source: "internal/protocol/runtime_report.go", GoName: "ProjectRuntime"},
		"RuntimeProvider":           {Value: protocol.RuntimeProvider{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeProvider"},
		"RuntimeExec":               {Value: protocol.RuntimeExec{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeExec"},
		"RuntimeRoot":               {Value: protocol.RuntimeRoot{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeRoot"},
		"RuntimeRepo":               {Value: protocol.RuntimeRepo{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeRepo"},
		"RuntimeReportRequest":      {Value: protocol.RuntimeReportRequest{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeReportRequest"},
		"RuntimeReportResult":       {Value: protocol.RuntimeReportResult{}, Source: "internal/protocol/runtime_report.go", GoName: "RuntimeReportResult"},
		"SessionRequest":            {Value: protocol.SessionRequest{}, Source: "internal/protocol/session.go", GoName: "SessionRequest"},
		"SessionResult":             {Value: protocol.SessionResult{}, Source: "internal/protocol/session.go", GoName: "SessionResult"},
		"ThreadCommand":             {Value: protocol.ThreadCommand{}, Source: "internal/protocol/thread.go", GoName: "ThreadCommand"},
		"ThreadCommandResult":       {Value: protocol.ThreadCommandResult{}, Source: "internal/protocol/thread.go", GoName: "ThreadCommandResult"},
		"ThreadReport":              {Value: protocol.ThreadReport{}, Source: "internal/protocol/thread.go", GoName: "ThreadReport"},
		"ThreadReportResult":        {Value: protocol.ThreadReportResult{}, Source: "internal/protocol/thread.go", GoName: "ThreadReportResult"},
		"BrowserSubscription":       {Value: browserSubscription{}, Source: "internal/httpapi/events.go", GoName: "browserSubscription"},
		"BrowserThreadOutput":       {Value: fixtureBrowserThreadOutput{}, Source: "internal/httpapi/events.go", GoName: "events1"},
		"FileView":                  {Value: fileView{}, Source: "internal/httpapi/files.go", GoName: "fileView"},
		"InboxConflictResponse":     {Value: fixtureInboxConflictResponse{}, Source: "internal/httpapi/inbox.go", GoName: "writeInboxError1"},
		"SetProjectExecInput":       {Value: fixtureSetProjectExecInput{}, Source: "internal/httpapi/node_settings.go", GoName: "setProjectExec1"},
		"UpdateBrowseRootsInput":    {Value: fixtureUpdateBrowseRootsInput{}, Source: "internal/httpapi/node_settings_web.go", GoName: "updateBrowseRoots1"},
		"SubscriptionLoginInput":    {Value: fixtureSubscriptionLoginInput{}, Source: "internal/httpapi/node_settings_web.go", GoName: "startSubscriptionLogin1"},
		"SubscriptionLoginResponse": {Value: fixtureSubscriptionLoginResponse{}, Source: "internal/httpapi/node_settings_web.go", GoName: "startSubscriptionLogin2"},
		"EnrollmentResponse":        {Value: fixtureEnrollmentResponse{}, Source: "internal/httpapi/nodes.go", GoName: "issueEnrollment1"},
		"RegisterNodeInput":         {Value: fixtureRegisterNodeInput{}, Source: "internal/httpapi/nodes.go", GoName: "registerNode1"},
		"NodeStatus":                {Value: nodeStatusJSON{}, Source: "internal/httpapi/nodes.go", GoName: "nodeStatusJSON"},
		"NodeRevocation":            {Value: revocationJSON{}, Source: "internal/httpapi/nodes.go", GoName: "revocationJSON"},
		"DefaultDevice":             {Value: defaultDeviceJSON{}, Source: "internal/httpapi/nodes.go", GoName: "defaultDeviceJSON"},
		"NodesResponse":             {Value: fixtureNodesResponse{}, Source: "internal/httpapi/nodes.go", GoName: "listNodes1"},
		"RevokeNodeResponse":        {Value: fixtureRevokeNodeResponse{}, Source: "internal/httpapi/nodes.go", GoName: "revokeNode1"},
		"SetDefaultDeviceInput":     {Value: fixtureSetDefaultDeviceInput{}, Source: "internal/httpapi/nodes.go", GoName: "putDefaultDevice1"},
		"ProjectsResponse":          {Value: fixtureProjectsResponse{}, Source: "internal/httpapi/projects.go", GoName: "routeProject1"},
		"OKResponse":                {Value: fixtureOKResponse{}, Source: "internal/httpapi/projects.go", GoName: "routeProject2"},
		"MemoryRevisionsResponse":   {Value: fixtureMemoryRevisionsResponse{}, Source: "internal/httpapi/projects.go", GoName: "routeProject3"},
		"MemoriesResponse":          {Value: fixtureMemoriesResponse{}, Source: "internal/httpapi/projects.go", GoName: "routeProject4"},
		"WriteMemoryInput":          {Value: fixtureWriteMemoryInput{}, Source: "internal/httpapi/projects.go", GoName: "routeProject5"},
		"MemoryConflictResponse":    {Value: fixtureMemoryConflictResponse{}, Source: "internal/httpapi/projects.go", GoName: "writeProjectError1"},
		"LoginInput":                {Value: fixtureLoginInput{}, Source: "internal/httpapi/server.go", GoName: "login1"},
		"ChangePasswordInput":       {Value: fixtureChangePasswordInput{}, Source: "internal/httpapi/server.go", GoName: "changePassword1"},
		"Employee":                  {Value: employeeBody{}, Source: "internal/httpapi/server.go", GoName: "employeeBody"},
		"SessionResponse":           {Value: sessionResponse{}, Source: "internal/httpapi/server.go", GoName: "sessionResponse"},
		"SessionView":               {Value: sessionView{}, Source: "internal/httpapi/server.go", GoName: "sessionView"},
		"ErrorDetails":              {Value: errorDetails{}, Source: "internal/httpapi/server.go", GoName: "errorDetails"},
		"ErrorResponse":             {Value: errorBody{}, Source: "internal/httpapi/server.go", GoName: "errorBody"},
		"CreateBrowserThreadInput":  {Value: fixtureCreateBrowserThreadInput{}, Source: "internal/httpapi/threads.go", GoName: "routeThread1"},
		"SetThreadModelInput":       {Value: fixtureSetThreadModelInput{}, Source: "internal/httpapi/threads.go", GoName: "routeThread2"},
		"ThreadErrorResponse":       {Value: fixtureThreadErrorResponse{}, Source: "internal/httpapi/threads.go", GoName: "writeThreadError1"},
		"ProjectRunView":            {Value: store.ProjectRunView{}, Source: "internal/store/project_view.go", GoName: "ProjectRunView"},
		"ProjectStatus":             {Value: store.ProjectStatus{}, Source: "internal/store/project_view.go", GoName: "ProjectStatus"},
		"ProjectMessagePage":        {Value: store.ProjectMessagePage{}, Source: "internal/store/project_view.go", GoName: "ProjectMessagePage"},
		"ThreadTraceStep":           {Value: store.ThreadTraceStep{}, Source: "internal/store/thread_trace.go", GoName: "ThreadTraceStep"},
		"ThreadTrace":               {Value: store.ThreadTrace{}, Source: "internal/store/thread_trace.go", GoName: "ThreadTrace"},
		"ThreadError":               {Value: store.ThreadError{}, Source: "internal/store/thread_types.go", GoName: "ThreadError"},
		"Thread":                    {Value: store.Thread{}, Source: "internal/store/thread_types.go", GoName: "Thread"},
		"ThreadMessageInput":        {Value: store.ThreadMessageInput{}, Source: "internal/store/thread_types.go", GoName: "ThreadMessageInput"},
		"CreateThreadInput":         {Value: store.CreateThreadInput{}, Source: "internal/store/thread_types.go", GoName: "CreateThreadInput"},
		"ThreadMessage":             {Value: store.ThreadMessage{}, Source: "internal/store/thread_types.go", GoName: "ThreadMessage"},
		"ThreadTurn":                {Value: store.ThreadTurn{}, Source: "internal/store/thread_types.go", GoName: "ThreadTurn"},
		"ThreadView":                {Value: store.ThreadView{}, Source: "internal/store/thread_types.go", GoName: "ThreadView"},
		"ThreadSummary":             {Value: store.ThreadSummary{}, Source: "internal/store/thread_types.go", GoName: "ThreadSummary"},
		"ThreadPage":                {Value: store.ThreadPage{}, Source: "internal/store/thread_types.go", GoName: "ThreadPage"},
		"ThreadEvent":               {Value: store.ThreadEvent{}, Source: "internal/store/thread_types.go", GoName: "ThreadEvent"},
		"ThreadTimeline":            {Value: store.ThreadTimeline{}, Source: "internal/store/thread_types.go", GoName: "ThreadTimeline"},
		"EnrollmentView":            {Value: store.EnrollmentView{}, Source: "internal/store/web_views.go", GoName: "EnrollmentView"},
		"MemoryRevision":            {Value: store.MemoryRevision{}, Source: "internal/store/web_views.go", GoName: "MemoryRevision"},
		"PromptSnapshot":            {Value: projectagent.PromptSnapshot{}, Source: "internal/projectagent/compaction.go", GoName: "PromptSnapshot"},
		"Compaction":                {Value: projectagent.Compaction{}, Source: "internal/projectagent/compaction.go", GoName: "Compaction"},
		"ProjectPreview":            {Value: projectagent.Preview{}, Source: "internal/projectagent/preview.go", GoName: "Preview"},
		"ProjectMessageInput":       {Value: projectagent.MessageInput{}, Source: "internal/projectagent/project.go", GoName: "MessageInput"},
		"ProjectMessage":            {Value: projectagent.Message{}, Source: "internal/projectagent/project.go", GoName: "Message"},
		"Project":                   {Value: projectagent.Project{}, Source: "internal/projectagent/project.go", GoName: "Project"},
		"ProjectAgent":              {Value: projectagent.Agent{}, Source: "internal/projectagent/project.go", GoName: "Agent"},
		"ProjectConversation":       {Value: projectagent.Conversation{}, Source: "internal/projectagent/project.go", GoName: "Conversation"},
		"CreateProjectInput":        {Value: projectagent.CreateInput{}, Source: "internal/projectagent/project.go", GoName: "CreateInput"},
		"PatchProjectInput":         {Value: projectagent.Patch{}, Source: "internal/projectagent/project.go", GoName: "Patch"},
		"ProjectEvent":              {Value: projectagent.Event{}, Source: "internal/projectagent/project.go", GoName: "Event"},
		"ProjectEventPage":          {Value: projectagent.EventPage{}, Source: "internal/projectagent/project.go", GoName: "EventPage"},
		"ProjectMemory":             {Value: projectagent.Memory{}, Source: "internal/projectagent/project.go", GoName: "Memory"},
		"ProjectQueuedInput":        {Value: projectagent.QueuedInput{}, Source: "internal/projectagent/runtime.go", GoName: "QueuedInput"},
		"ProjectBootstrap":          {Value: projectagent.Bootstrap{}, Source: "internal/projectagent/runtime.go", GoName: "Bootstrap"},
		"ProjectClaim":              {Value: projectagent.Claim{}, Source: "internal/projectagent/runtime.go", GoName: "Claim"},
		"InboxOption":               {Value: inbox.Option{}, Source: "internal/inbox/inbox.go", GoName: "Option"},
		"InboxAsk":                  {Value: inbox.Ask{}, Source: "internal/inbox/inbox.go", GoName: "Ask"},
		"InboxResolution":           {Value: inbox.Resolution{}, Source: "internal/inbox/inbox.go", GoName: "Resolution"},
		"AttentionRequest":          {Value: inbox.Request{}, Source: "internal/inbox/inbox.go", GoName: "Request"},
		"HandleAttentionInput":      {Value: inbox.Handle{}, Source: "internal/inbox/inbox.go", GoName: "Handle"},
		"InboxPage":                 {Value: inbox.Page{}, Source: "internal/inbox/requests.go", GoName: "Page"},
		"NodeCredential":            {Value: node.Credential{}, Source: "internal/node/identity.go", GoName: "Credential"},
		"NodeIdentity":              {Value: node.Identity{}, Source: "internal/node/identity.go", GoName: "Identity"},
		"SavedDefaultDevice":        {Value: node.SavedDefault{}, Source: "internal/node/identity.go", GoName: "SavedDefault"},
	}
	exportProtocolFixtures(t, types)
}

// migrationHistoryEntry 是适配器规格的统一消息；Go 生产协议保持冻结。
type migrationHistoryEntry struct {
	ID              string     `json:"id"`
	Ordinal         int64      `json:"ordinal"`
	Role            string     `json:"role"`
	Text            string     `json:"text"`
	Timestamp       *time.Time `json:"timestamp"`
	ClientMessageID string     `json:"client_message_id,omitempty"`
	Reference       string     `json:"reference"`
	Bytes           int64      `json:"bytes"`
	Truncated       bool       `json:"truncated"`
}

type fixtureField struct {
	Name     string       `json:"name"`
	Optional bool         `json:"optional"`
	Shape    fixtureShape `json:"shape"`
}
type fixtureShape struct {
	Kind     string         `json:"kind"`
	Ref      string         `json:"ref,omitempty"`
	Nullable bool           `json:"nullable,omitempty"`
	Fields   []fixtureField `json:"fields,omitempty"`
	Element  *fixtureShape  `json:"element,omitempty"`
}
type exportedFixture struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Value  any    `json:"value"`
}
type exportedFixtureSchema struct {
	Source string       `json:"source"`
	GoName string       `json:"go_name"`
	Shape  fixtureShape `json:"shape"`
}

const fixtureUUID = "12345678-1234-4234-8234-123456789abc"

func exportProtocolFixtures(t *testing.T, types map[string]protocolFixtureType) {
	t.Helper()
	checkFixtureInventory(t, types)
	names := map[reflect.Type]string{}
	for name, entry := range types {
		names[reflect.TypeOf(entry.Value)] = name
	}
	names[reflect.TypeOf(migrationHistoryEntry{})] = "HistoryEntry"
	var describe func(reflect.Type, bool) fixtureShape
	describe = func(typ reflect.Type, root bool) fixtureShape {
		if typ == reflect.TypeOf(protocol.HistoryEntry{}) {
			typ = reflect.TypeOf(migrationHistoryEntry{})
		}
		if typ == reflect.TypeOf(time.Time{}) {
			return fixtureShape{Kind: "timestamp"}
		}
		if typ == reflect.TypeOf(json.RawMessage{}) {
			return fixtureShape{Kind: "json"}
		}
		if !root && names[typ] != "" {
			return fixtureShape{Kind: "ref", Ref: names[typ]}
		}
		switch typ.Kind() {
		case reflect.Pointer:
			s := describe(typ.Elem(), false)
			s.Nullable = true
			return s
		case reflect.Interface:
			return fixtureShape{Kind: "json"}
		case reflect.String:
			return fixtureShape{Kind: "string"}
		case reflect.Bool:
			return fixtureShape{Kind: "boolean"}
		case reflect.Int, reflect.Int64, reflect.Int32:
			return fixtureShape{Kind: "integer"}
		case reflect.Slice:
			element := describe(typ.Elem(), false)
			return fixtureShape{Kind: "array", Nullable: true, Element: &element}
		case reflect.Struct:
			out := fixtureShape{Kind: "struct"}
			for i := 0; i < typ.NumField(); i++ {
				f := typ.Field(i)
				tag := strings.Split(f.Tag.Get("json"), ",")
				if tag[0] == "-" {
					continue
				}
				if f.Anonymous && tag[0] == "" {
					s := describe(f.Type, true)
					if f.Type.Kind() == reflect.Pointer {
						s = describe(f.Type.Elem(), true)
					}
					for _, inherited := range s.Fields {
						exists := false
						for _, existing := range out.Fields {
							if existing.Name == inherited.Name {
								exists = true
								break
							}
						}
						if !exists {
							out.Fields = append(out.Fields, inherited)
						}
					}
					continue
				}
				key := tag[0]
				if key == "" {
					key = f.Name
				}
				fields := out.Fields[:0]
				for _, old := range out.Fields {
					if old.Name != key {
						fields = append(fields, old)
					}
				}
				out.Fields = fields
				out.Fields = append(out.Fields, fixtureField{Name: key, Optional: strings.Contains(f.Tag.Get("json"), ",omitempty"), Shape: describe(f.Type, false)})
			}
			return out
		default:
			t.Fatalf("没有处理的协议类型 %s", typ)
			return fixtureShape{}
		}
	}
	schemas := map[string]exportedFixtureSchema{}
	cases := []exportedFixture{}
	keys := []string{}
	for key := range types {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, name := range keys {
		entry := types[name]
		typ := reflect.TypeOf(entry.Value)
		schemas[name] = exportedFixtureSchema{entry.Source, entry.GoName, describe(typ, true)}
		for _, full := range []bool{true, false} {
			v := fixtureSample(typ, "", full).Interface()
			raw, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err = json.Unmarshal(raw, &value); err != nil {
				t.Fatal(err)
			}
			value = fixtureMigrationValue(value)
			mode := "full"
			if !full {
				mode = "sparse"
			}
			cases = append(cases, exportedFixture{name, mode, value})
		}
	}
	for _, kind := range []string{"thread.opened", "thread.open_failed", "message.queued", "message.sent", "message.withdrawn", "message.unknown", "turn.started", "reply", "turn.ended", "thread.resumed", "thread.stopped", "thread.unknown"} {
		report := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: fixtureUUID, EventID: fixtureUUID, WorkerSeq: 1, Kind: kind, StorageGeneration: fixtureUUID}
		switch kind {
		case "thread.opened", "thread.resumed":
			report.NativeSessionID = "native-session-1"
		case "message.queued", "message.sent", "message.withdrawn", "message.unknown":
			report.ClientMessageID = "input-1"
		case "turn.started":
			report.WorkerTurnSeq = 1
			report.ClientMessageID = "input-1"
			report.Model = "gpt-6.1-sol"
		case "reply":
			report.WorkerTurnSeq = 1
			report.Content = "检查已完成。"
			report.OriginalBytes = int64(len(report.Content))
			report.Attachments = json.RawMessage(`[{"kind":"file","node_id":"` + fixtureUUID + `","path":"logs/check.txt","status":"available"}]`)
		case "turn.ended":
			report.WorkerTurnSeq = 1
			report.Reason = "completed"
			report.QueueEmpty = true
		case "thread.open_failed", "thread.stopped", "thread.unknown":
			report.Reason = "本地进程已退出"
		}
		cases = append(cases, exportedFixture{"ThreadReport", kind, report})
	}
	for _, action := range []string{"open", "message", "withdraw", "stop", "resume"} {
		command := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: fixtureUUID, Action: action, StorageGeneration: fixtureUUID}
		if action == "open" {
			command.AgentType = "codex"
			command.WorkingDirectory = "/work/baton"
			command.ExecutionTimeoutSeconds = 7200
		}
		if action == "message" || action == "withdraw" {
			command.ClientMessageID = "input-1"
		}
		if action == "message" {
			command.Content = "运行检查"
			command.Mode = "queue"
		}
		cases = append(cases, exportedFixture{"ThreadCommand", action, command})
	}
	for _, kind := range []string{protocol.KindAuth, protocol.KindAuthResult, protocol.KindHeartbeat, protocol.KindEnvelope, protocol.KindError} {
		frame := protocol.Frame{Kind: kind}
		switch kind {
		case protocol.KindAuth:
			frame.Token = "fixture-not-a-real-node-credential"
			frame.Incarnation = fixtureUUID
		case protocol.KindAuthResult:
			frame.OK = true
		case protocol.KindError:
			frame.Code = protocol.CodeInvalidMessage
			frame.Message = "消息无法处理"
		case protocol.KindEnvelope:
			frame.Envelope, _ = json.Marshal(protocol.Envelope{Version: 1, MessageID: fixtureUUID, Route: protocol.Route{To: "control"}, Priority: "control", Body: json.RawMessage(`{"type":"node.runtime_report_result","ok":true}`)})
		}
		cases = append(cases, exportedFixture{"Frame", kind, frame})
	}
	for _, outcome := range []string{"succeeded", "failed", "cancelled", "unknown"} {
		cases = append(cases, exportedFixture{"ThreadReport", "command.completed." + outcome, struct {
			protocol.ThreadReport
			CommandID      string `json:"command_id"`
			CommandOutcome string `json:"command_outcome"`
		}{protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: fixtureUUID, EventID: fixtureUUID, WorkerSeq: 2, Kind: "command.completed", StorageGeneration: fixtureUUID, Reason: "命令已经结束"}, fixtureUUID, outcome}})
	}
	cases = append(cases, exportedFixture{"RuntimeAgent", "reason", struct {
		protocol.RuntimeAgent
		Reason string `json:"reason"`
	}{protocol.RuntimeAgent{AgentType: "cursor", Version: "1.0.35", Status: "unverified", Models: []protocol.RuntimeModel{}, Capabilities: protocol.ThreadCapabilities{}}, "尚未验证本机认证"}})
	cases = append(cases, exportedFixture{"ThreadCommandResult", "storage_generation", struct {
		protocol.ThreadCommandResult
		StorageGeneration string `json:"storage_generation"`
	}{protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: fixtureUUID, OK: true}, fixtureUUID}})
	cases = append(cases, exportedFixture{"DefaultDevice", "unset", defaultDeviceJSON{}})
	cases = append(cases, exportedFixture{"BrowserSubscription", "unsubscribe", browserSubscription{}})
	for _, operation := range []string{"bootstrap", "read_events", "renew", "started", "stopped", "wake_received", "claim_inputs", "wait_tool", "call_tool", "append_event", "commit_compaction", "finish", "exited", "start_failed", "report_failure", "preview"} {
		cases = append(cases, exportedFixture{"ProjectRuntimeRequest", operation, protocol.ProjectRuntimeRequest{Type: protocol.BodyProjectRuntimeRequest, RunID: fixtureUUID, LeaseEpoch: 1, Operation: operation}})
	}
	for _, code := range []string{"history_loading", "history_changed", "history_missing", "history_unavailable", "invalid_cursor"} {
		cases = append(cases, exportedFixture{"HistoryResult", code, protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: fixtureUUID, SessionID: fixtureUUID, Code: code}})
	}
	historyTime := time.Date(2026, 10, 23, 12, 34, 56, 123456789, time.UTC)
	type unifiedPage struct {
		Entries []migrationHistoryEntry `json:"entries"`
		Cursor  string                  `json:"cursor"`
		HasMore bool                    `json:"has_more"`
		Gap     bool                    `json:"gap"`
	}
	entries := []migrationHistoryEntry{
		{ID: "kiro-user-1", Ordinal: 0, Role: "user", Text: "运行检查", Timestamp: &historyTime, ClientMessageID: "input-1", Reference: "native:kiro-session-1:0", Bytes: int64(len("运行检查"))},
		{ID: "kiro-assistant-1", Ordinal: 1, Role: "assistant", Text: "检查已完成。", Reference: "native:kiro-session-1:1", Bytes: int64(len("检查已完成。"))},
	}
	cases = append(cases, exportedFixture{"HistoryResult", "kiro.logical_messages", struct {
		protocol.SessionResult
		History unifiedPage `json:"history"`
	}{protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: fixtureUUID, SessionID: fixtureUUID, OK: true}, unifiedPage{Entries: entries, Cursor: "snapshot:2"}}})
	appendHTTPQueryFixtures(t, &cases)
	document := struct {
		Schemas map[string]exportedFixtureSchema `json:"schemas"`
		Cases   []exportedFixture                `json:"cases"`
	}{schemas, cases}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join("..", "..", "packages", "protocol", "fixtures", "go-http-node.json")
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(target, append(raw, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("导出 %d 个结构、%d 个样例", len(schemas), len(cases))
}

func appendHTTPQueryFixtures(t *testing.T, cases *[]exportedFixture) {
	t.Helper()
	add := func(schema, name string, value any) { *cases = append(*cases, exportedFixture{schema, name, value}) }
	add("EmptyInput", "empty", struct{}{})
	add("BrowserReady", "ready", map[string]string{"type": "ready"})
	add("BrowserThreadChanged", "changed", map[string]string{"type": "thread.changed"})
	queries := []struct {
		Schema string
		Values url.Values
	}{
		{"ThreadListQuery", url.Values{"project_id": {fixtureUUID}, "node_id": {fixtureUUID}, "status": {"idle"}, "cursor": {"thread-cursor"}, "limit": {"20"}}},
		{"ThreadTimelineQuery", url.Values{"cursor": {"timeline-cursor"}, "limit": {"20"}}},
		{"ThreadHistoryQuery", url.Values{"cursor": {"history-cursor"}, "limit": {"16"}}},
		{"ThreadOutputQuery", url.Values{"cursor": {"output-cursor"}}},
		{"ThreadTraceQuery", url.Values{"worker_turn_seq": {"1"}}},
		{"FilesQuery", url.Values{"root_id": {"workspace"}, "path": {"src/main.ts"}}},
		{"ProjectListQuery", url.Values{"after_id": {fixtureUUID}, "limit": {"20"}}},
		{"ProjectMessagesQuery", url.Values{"client_message_id": {"input-1"}, "after_id": {"1"}, "limit": {"20"}}},
		{"ProjectEventsQuery", url.Values{"after_seq": {"1"}, "limit": {"20"}}},
		{"MemoryRevisionsQuery", url.Values{"after_revision": {"1"}, "limit": {"20"}}},
		{"InboxQuery", url.Values{"state": {"open"}, "cursor": {"inbox-cursor"}, "project_id": {fixtureUUID}, "thread_id": {fixtureUUID}}},
	}
	server := &Server{}
	for _, query := range queries {
		req := httptest.NewRequest("GET", "https://example.test/api?"+query.Values.Encode(), nil)
		if query.Schema == "FilesQuery" {
			if _, _, _, ok := server.fileQuery(httptest.NewRecorder(), req); !ok {
				t.Fatalf("文件查询样例无效")
			}
		}
		if query.Schema == "ProjectListQuery" {
			if _, _, ok := server.projectListQuery(httptest.NewRecorder(), req); !ok {
				t.Fatalf("项目分页样例无效")
			}
		}
		value := map[string]string{}
		for key, values := range req.URL.Query() {
			if len(values) != 1 {
				t.Fatal("重复查询字段")
			}
			value[key] = values[0]
		}
		add(query.Schema, "url_query", value)
	}
}

func fixtureMigrationValue(value any) any {
	switch v := value.(type) {
	case []any:
		for i, item := range v {
			v[i] = fixtureMigrationValue(item)
		}
	case map[string]any:
		if _, ok := v["reference"]; ok {
			if _, ok = v["bytes"]; ok {
				if _, ok = v["text"]; ok {
					if id, ok := v["id"].(string); !ok || id == "" {
						v["id"] = "native-message-1"
					}
					role := "assistant"
					if v["kind"] == "user" {
						role = "user"
					}
					delete(v, "parent_id")
					delete(v, "kind")
					v["ordinal"] = float64(1)
					v["role"] = role
					v["timestamp"] = nil
				}
			}
		}
		for key, item := range v {
			v[key] = fixtureMigrationValue(item)
		}
	}
	return value
}

func fixtureSample(typ reflect.Type, field string, full bool) reflect.Value {
	if typ == reflect.TypeOf(time.Time{}) {
		return reflect.ValueOf(time.Date(2026, 10, 23, 12, 34, 56, 123456789, time.UTC))
	}
	if typ == reflect.TypeOf(json.RawMessage{}) {
		text := `{"fixture":true,"details":[1,"检查",null]}`
		if field == "Attachments" {
			text = `[{"kind":"file","node_id":"` + fixtureUUID + `","path":"logs/check.txt","status":"available"}]`
		}
		return reflect.ValueOf(json.RawMessage(text))
	}
	out := reflect.New(typ).Elem()
	switch typ.Kind() {
	case reflect.Pointer:
		if !full && field != "Enabled" && field != "Capabilities" && field != "ExpectedRevision" && typ.Elem() != reflect.TypeOf(store.ThreadError{}) {
			return out
		}
		out.Set(reflect.New(typ.Elem()))
		out.Elem().Set(fixtureSample(typ.Elem(), field, full))
		if field == "Status" && typ.Elem().Kind() == reflect.String {
			out.Elem().SetString("active")
		}
	case reflect.Interface:
		out.Set(reflect.ValueOf("2026-10-23T12:34:56.123456789Z"))
	case reflect.String:
		out.SetString(fixtureString(typ, field))
	case reflect.Bool:
		out.SetBool(full)
	case reflect.Int, reflect.Int64, reflect.Int32:
		out.SetInt(1)
	case reflect.Slice:
		if !full && field != "Capabilities" {
			return out
		}
		count := 1
		if !full {
			count = 0
		}
		out.Set(reflect.MakeSlice(typ, count, count))
		if count == 0 {
			return out
		}
		out.Index(0).Set(fixtureSample(typ.Elem(), field, full))
	case reflect.Struct:
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if !out.Field(i).CanSet() {
				continue
			}
			if !full && strings.Contains(f.Tag.Get("json"), ",omitempty") {
				continue
			}
			out.Field(i).Set(fixtureSample(f.Type, f.Name, full))
			if f.Type.Kind() == reflect.String {
				if value, ok := fixtureSpecificString(typ.Name(), f.Name); ok {
					out.Field(i).SetString(value)
				}
			}
		}
	}
	if typ == reflect.TypeOf(projectagent.Patch{}) && !full {
		title := "本地检查"
		out.FieldByName("Title").Set(reflect.ValueOf(&title))
	}
	if typ == reflect.TypeOf(protocol.HistoryEntry{}) {
		out.FieldByName("Bytes").SetInt(int64(len(out.FieldByName("Text").String())))
	}
	if typ == reflect.TypeOf(protocol.RuntimeReport{}) {
		report := out.Interface().(protocol.RuntimeReport)
		if _, err := protocol.RuntimeReportJSON(report); err != nil {
			panic(fmt.Sprintf("能力报告样例无效: %v", err))
		}
	}
	return out
}

func fixtureSpecificString(parent, field string) (string, bool) {
	values := map[string]map[string]string{
		"fixtureNodeSyncRequest": {"Type": "node.sync"}, "fixtureNodeSyncResult": {"Type": "node.sync_result"},
		"FileEntry": {"Kind": "file"}, "FileRemainder": {"Kind": "file"}, "fileView": {"Kind": "file"},
		"FileRequest": {"Type": protocol.BodyFileBrowse}, "FileResult": {"Type": protocol.BodyFileResult, "Kind": "file"},
		"ProjectExecRequest": {"Type": protocol.BodyProjectExecSet}, "ProjectExecResult": {"Type": protocol.BodyProjectExecResult},
		"BrowseRootsRequest": {"Type": protocol.BodyBrowseRootsSet, "Action": "add"}, "BrowseRootsResult": {"Type": protocol.BodyBrowseRootsResult},
		"SubscriptionLoginRequest": {"Type": protocol.BodySubscriptionLogin}, "SubscriptionLoginResult": {"Type": protocol.BodySubscriptionLoginResult},
		"ProjectRunCommand": {"Type": protocol.BodyProjectRunStart}, "ProjectRuntimeRequest": {"Type": protocol.BodyProjectRuntimeRequest}, "ProjectRuntimeResult": {"Type": protocol.BodyProjectRuntimeResult},
		"RuntimeReportRequest": {"Type": protocol.BodyRuntimeReport}, "RuntimeReportResult": {"Type": protocol.BodyRuntimeReportResult},
		"SessionRequest": {"Type": protocol.BodySessionRequest, "Action": "output"}, "SessionResult": {"Type": protocol.BodySessionResult},
		"ThreadCommand": {"Type": protocol.BodyThreadCommand}, "ThreadCommandResult": {"Type": protocol.BodyThreadCommandResult}, "ThreadReport": {"Type": protocol.BodyThreadReport}, "ThreadReportResult": {"Type": protocol.BodyThreadReportResult},
		"Thread": {"Status": "idle"}, "Project": {"Status": "active"}, "Request": {"State": "open"}, "Conversation": {"State": "idle"},
		"Option": {"ID": "continue"}, "RuntimeModel": {"ID": "gpt-6.1-sol"}, "FileRoot": {"ID": "workspace"},
		"Frame": {"Kind": "heartbeat"}, "Source": {"Kind": "node"}, "Revocation": {"Kind": "credential"}, "revocationJSON": {"Status": "pending"},
		"fixtureBrowserThreadOutput": {"Type": "thread.output"}, "fixtureInboxConflictResponse": {"Error": "conflict"},
		"fixtureRevokeNodeResponse": {"Status": "pending"}, "fixtureMemoryConflictResponse": {"Code": "revision_conflict"},
		"ThreadTurn": {"Initiator": "employee"}, "ThreadMessage": {"Status": "sent"}, "Event": {"Kind": "message"}, "ThreadEvent": {"Kind": "reply"},
		"Preview": {"Status": "streaming"},
	}
	value, ok := values[parent][field]
	return value, ok
}

func fixtureString(typ reflect.Type, field string) string {
	switch field {
	case "Type":
		return "fixture"
	case "MessageID", "ID", "ThreadID", "NodeID", "EmployeeID", "EventID", "OperationID", "SessionID", "ProjectID", "ConversationID", "CredentialID", "Incarnation", "ConnID", "RunID", "OriginConversationID", "StorageGeneration", "ClientThreadID", "ClientProjectID", "RequestID", "OperatorID", "ConditionObjectID", "DefaultDeviceNodeID", "LegacyNodeID":
		return fixtureUUID
	case "AgentType":
		return "codex"
	case "Version", "BatondVersion":
		return "1.0.0"
	case "Status":
		return "available"
	case "State":
		return "idle"
	case "Model", "DefaultModel", "NextModel", "RequestedModel":
		return "gpt-6.1-sol"
	case "Provider":
		return "openai-codex"
	case "RootID":
		return "workspace"
	case "Path", "WorkingDirectory":
		return "/work/baton"
	case "Reference":
		return "native:session-1:0:12"
	case "Text", "Content", "Payload":
		return "检查已完成。"
	case "Origin":
		return "github.com/example/baton.git"
	case "To":
		return "control"
	case "Priority":
		return "control"
	case "Kind":
		return "reply"
	case "Action":
		return "message"
	case "Mode":
		return "queue"
	case "Reason", "StatusReason", "EndReason", "StopReason", "WithdrawReason":
		return "completed"
	case "ClientMessageID", "ClientEventID", "ClientRequestID":
		return "input-1"
	case "OptionID":
		return "continue"
	case "System":
		return "macos"
	case "Role":
		return "pc"
	case "AuthSource":
		return "local"
	case "User", "Username":
		return "fixture-user"
	case "DisplayName", "Name", "Title", "ProjectTitle", "Label", "OptionLabel":
		return "本地检查"
	case "Sender", "Author", "CreatedBy", "Initiator", "Actor":
		return "employee"
	case "Shell":
		return "/bin/sh"
	case "Source":
		return "agent"
	case "Operation":
		return "bootstrap"
	case "Cursor", "NextCursor", "HistoryCursor":
		return "fixture-cursor"
	case "NativeSessionID":
		return "native-session-1"
	case "Code":
		return "unavailable"
	case "Token", "EnrollmentToken", "CSRFToken", "Password", "CurrentPassword", "NewPassword":
		return "fixture-example-not-a-real-credential"
	case "VerificationURI", "ActionURL":
		return "https://example.test/verify"
	case "UserCode":
		return "ABCD-EFGH"
	case "RevocationStatus":
		return "none"
	case "Capabilities":
		return "threads"
	}
	return "fixture-value"
}

// 匿名 DTO 的字段和嵌入关系必须与 handler 中的声明相同。
func checkFixtureInventory(t *testing.T, types map[string]protocolFixtureType) {
	t.Helper()
	fs := token.NewFileSet()
	copied, err := parser.ParseFile(fs, "protocol_fixtures_test.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	copies := map[string]string{}
	render := func(n ast.Node) string {
		var b bytes.Buffer
		if err := format.Node(&b, fs, n); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	for _, decl := range copied.Decls {
		if gen, ok := decl.(*ast.GenDecl); ok {
			for _, spec := range gen.Specs {
				if ts, ok := spec.(*ast.TypeSpec); ok {
					copies[ts.Name.Name] = render(ts.Type)
				}
			}
		}
	}
	registered := map[string]string{}
	for name, entry := range types {
		registered[entry.Source+":"+entry.GoName] = name
	}
	for _, dir := range []string{"protocol", "httpapi", "store", "projectagent", "inbox", "node", "control"} {
		entries, err := os.ReadDir(filepath.Join("..", dir))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			file := entry.Name()
			if !strings.HasSuffix(file, ".go") || strings.HasSuffix(file, "_test.go") {
				continue
			}
			if (dir == "node" && file != "identity.go") || (dir == "control" && file != "server.go") {
				continue
			}
			path := filepath.Join("..", dir, file)
			f, err := parser.ParseFile(fs, path, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			source := "internal/" + dir + "/" + file
			tagged := func(st *ast.StructType) bool {
				for _, field := range st.Fields.List {
					if field.Tag != nil {
						tag, _ := strconv.Unquote(field.Tag.Value)
						if reflect.StructTag(tag).Get("json") != "" {
							return true
						}
					}
				}
				return false
			}
			for _, decl := range f.Decls {
				switch d := decl.(type) {
				case *ast.GenDecl:
					for _, spec := range d.Specs {
						if ts, ok := spec.(*ast.TypeSpec); ok {
							if st, ok := ts.Type.(*ast.StructType); ok && tagged(st) {
								if (dir == "store" || dir == "inbox") && !ast.IsExported(ts.Name.Name) {
									continue
								}
								if registered[source+":"+ts.Name.Name] == "" {
									t.Errorf("缺少命名协议结构 %s:%s", source, ts.Name.Name)
								}
							}
						}
					}
				case *ast.FuncDecl:
					if dir != "httpapi" && dir != "control" {
						continue
					}
					counter := 0
					ast.Inspect(d.Body, func(n ast.Node) bool {
						if st, ok := n.(*ast.StructType); ok {
							if tagged(st) {
								counter++
								if dir == "control" && len(st.Fields.List) <= 1 {
									return false
								}
								key := source + ":" + d.Name.Name + strconv.Itoa(counter)
								name := registered[key]
								if name == "" {
									t.Errorf("缺少 HTTP 匿名 DTO %s", key)
								} else if copies["fixture"+name] != render(st) {
									t.Errorf("HTTP DTO %s 与 handler 声明不符", name)
								}
							}
							return false
						}
						return true
					})
				}
			}
		}
	}
}
