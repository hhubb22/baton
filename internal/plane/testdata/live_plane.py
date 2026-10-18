"""Opt-in Plane 1.4.2 contract replay; credentials and captured payloads stay in memory."""

import ast
import hashlib
import hmac
import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def secret(field):
    return subprocess.check_output(
        ["op", "read", "op://Baton Test/plane/" + field], stderr=subprocess.DEVNULL
    ).decode().strip()


def call(opener, url, method="GET", data=None, headers=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=20) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        # Never include URLs, bodies or credentials in failures.
        return err.code, None


actor = json.load(sys.stdin)
origin = secret("PLANE_URL").rstrip("/")
workspace = secret("PLANE_WORKSPACE_SLUG")
project = secret("PLANE_PROJECT_ID")
webhook = secret("PLANE_WEBHOOK_ID")
key = secret("PLANE_API_TOKEN")
signing = secret("PLANE_WEBHOOK_SECRET")
member = secret("PLANE_MEMBER_ID")
admin_email = secret("PLANE_ADMIN_EMAIL")
api = urllib.request.build_opener()
api_headers = {"X-API-Key": key}
prefix = origin + f"/api/v1/workspaces/{workspace}/projects/{project}/"
app = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
_, csrf = call(app, origin + "/auth/get-csrf-token/")
login = urllib.parse.urlencode({"email": admin_email, "password": secret("PLANE_ADMIN_PASSWORD"),
                               "csrfmiddlewaretoken": csrf["csrf_token"]}).encode()
app.open(urllib.request.Request(origin + "/auth/sign-in/", data=login, headers={"Referer": origin + "/"}), timeout=20).close()
status, me = call(app, origin + "/api/users/me/")
assert status == 200, "cannot verify admin identity"
admin_id = me["id"]


def plane(path, method="GET", data=None):
    status, result = call(api, prefix + path, method, data, api_headers)
    assert status in (200, 201, 204), f"Plane API {method} failed ({status})"
    return result


def logs(issue, action, field=None, event="issue"):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        status, rows = call(app, origin + f"/api/workspaces/{workspace}/webhook-logs/{webhook}/")
        assert status == 200, "webhook log read failed"
        if isinstance(rows, dict):
            rows = rows.get("results", [])
        for row in rows:
            data = ast.literal_eval(row["request_body"])
            if (data.get("event") == event and data["data"].get("issue" if event == "issue_comment" else "id") == issue
                    and data["action"] == action and (field is None or data["activity"].get("field") == field)):
                headers = ast.literal_eval(row["request_headers"])
                raw = json.dumps(data).encode()
                assert hmac.compare_digest(hmac.new(signing.encode(), raw, hashlib.sha256).hexdigest(),
                                           headers["X-Plane-Signature"]), "cannot reconstruct original signed payload"
                return data, raw, headers
        time.sleep(0.2)
    raise AssertionError("timed out waiting for Plane webhook fact")


def sql(query):
    connection = urllib.parse.urlparse(os.environ["BATON_DATABASE_URL"])
    env = dict(os.environ, PGDATABASE=connection.path.lstrip("/"), PGUSER=urllib.parse.unquote(connection.username or ""),
               PGPASSWORD=urllib.parse.unquote(connection.password or ""), PGHOST=connection.hostname or "",
               PGPORT=str(connection.port or 5432), PGSSLMODE="disable")
    return subprocess.check_output(["psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query], env=env,
                                   stderr=subprocess.DEVNULL).decode().strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


issue = None
label_id = None
created_label = False
proc = None
try:
    states = plane("states/")["results"]
    todo = next(s["id"] for s in states if s["group"] == "unstarted")
    started = next(s["id"] for s in states if s["group"] == "started")
    labels = plane("labels/")["results"]
    before_issues = plane("issues/")["total_results"]
    match = next((x for x in labels if x["name"] == "design-approved"), None)
    if match:
        label_id = match["id"]
    else:
        label_id = plane("labels/", "POST", {"name": "design-approved", "color": "#339966"})["id"]
        created_label = True
    issue = plane("issues/", "POST", {"name": "baton-t25-ps130-" + uuid.uuid4().hex[:12],
                                      "description_html": "<p>PS-130 isolated webhook replay; no Agent starts.</p>",
                                      "state": todo})["id"]
    created = logs(issue, "created")
    source_actor = created[0]["activity"]["actor"]
    assert source_actor["id"] in (admin_id, member), "unapproved test actor"
    expected_email = admin_email if source_actor["id"] == admin_id else secret("PLANE_MEMBER_EMAIL")
    assert source_actor["email"].casefold() == expected_email.casefold(), "test actor email mismatch"
    actor.update(plane_user_id=source_actor["id"], email=expected_email)
    cfg = {"workspace_id": secret("PLANE_WORKSPACE_ID"), "workspace_slug": workspace, "project_id": project,
           "webhook_id": webhook, "approval_label_id": label_id, "actors": [actor]}
    port = free_port()
    address = f"http://127.0.0.1:{port}/hooks/plane"
    env = dict(os.environ, BATON_HTTP_ADDR=f"127.0.0.1:{port}", BATON_PLANE_CONFIG=json.dumps(cfg),
               BATON_PLANE_URL=origin, BATON_PLANE_API_KEY=key, BATON_PLANE_WEBHOOK_SECRET=signing)

    def start():
        process = subprocess.Popen([sys.argv[1], "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError("coordinator exited")
            try:
                status, _ = call(api, address)
                if status == 405:
                    return process
            except urllib.error.URLError:
                pass
            time.sleep(0.05)
        process.kill()
        process.wait()
        raise AssertionError("coordinator not ready")

    proc = start()

    def replay(capture, expected, code=None, mutate=None, forge=False, fresh_delivery=False):
        data, raw, headers = capture
        headers = dict(headers)
        if mutate:
            data = json.loads(json.dumps(data))
            mutate(data)
            raw = json.dumps(data).encode()
            headers["X-Plane-Signature"] = hmac.new(signing.encode(), raw, hashlib.sha256).hexdigest()
            headers["X-Plane-Delivery"] = str(uuid.uuid4())
        if forge:
            headers["X-Plane-Signature"] = "0" * 64
        if fresh_delivery:
            headers["X-Plane-Delivery"] = str(uuid.uuid4())
        req = urllib.request.Request(address, data=raw, headers=headers)
        try:
            with api.open(req, timeout=25) as resp:
                status, result = resp.status, json.load(resp)
        except urllib.error.HTTPError as err:
            status, result = err.code, json.load(err)
        assert status == (401 if forge else 503 if expected == "pending" else 200), f"webhook HTTP {status}"
        assert result["outcome"] == expected, f"unexpected outcome: {result.get('outcome')}/{result.get('code')}"
        if code:
            assert result.get("code") == code, "unexpected block reason"
        return result

    replay(created, "linked")
    plane(f"issues/{issue}/", "PATCH", {"state": started})
    state_event = logs(issue, "updated", "state")
    replay(state_event, "rejected", "invalid_signature", forge=True)
    replay(state_event, "blocked", "missing_fields", mutate=lambda e: e["activity"].pop("actor"))
    replay(state_event, "blocked", "unmapped_actor", mutate=lambda e: e["activity"]["actor"].update(email="unmapped@example.test"))
    replay(state_event, "blocked", "design_not_approved")
    plane(f"issues/{issue}/", "PATCH", {"labels": [label_id]})
    approved = logs(issue, "updated", "labels")
    schema = os.environ["BATON_DB_SCHEMA"]
    sql(f'''CREATE FUNCTION "{schema}".fail_plane_decision() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'temporary replay database fault'; END $$;
            CREATE TRIGGER fail_plane_decision BEFORE INSERT ON "{schema}".plane_triggers
            FOR EACH ROW EXECUTE FUNCTION "{schema}".fail_plane_decision()''')
    replay(approved, "pending", "unavailable")
    assert sql(f'SELECT count(*) FROM "{schema}".tasks') == "0", "failed decision created a task"
    sql(f'DROP TRIGGER fail_plane_decision ON "{schema}".plane_triggers')
    proc.kill()
    proc.wait()
    proc = start()
    delivery = str(uuid.UUID(approved[2]["X-Plane-Delivery"]))
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if sql(f'''SELECT outcome FROM "{schema}".plane_deliveries WHERE delivery_id='{delivery}' ''') == "accepted":
            break
        time.sleep(0.1)
    else:
        raise AssertionError("persisted event was not completed by background retry after restart")
    first = replay(approved, "accepted")
    replay(approved, "accepted")
    replay(approved, "accepted", fresh_delivery=True)
    replay(approved, "ignored", "non_trigger_event", mutate=lambda e: e["data"].update(external_source="baton"))
    plane(f"issues/{issue}/comments/", "POST", {"comment_html": "<p>baton-writeback isolated replay</p>",
                                               "access": "INTERNAL", "external_source": "baton",
                                               "external_id": str(uuid.uuid4())})
    replay(logs(issue, "created", event="issue_comment"), "ignored", "non_trigger_event")
    # The older version has never been processed; current facts must reject it.
    stale = json.loads(json.dumps(state_event[0]))
    stale["data"]["updated_at"] = "2020-01-01T00:00:00Z"
    replay((stale, b"", state_event[2]), "blocked", "stale_event", mutate=lambda e: None)
    assert sql(f'SELECT count(*) FROM "{schema}".tasks') == "1", "duplicate task"
    assert sql(f'SELECT count(*) FROM "{schema}".executions') == "1", "duplicate execution"
    proc.kill()
    proc.wait()
    proc = start()
    assert replay(approved, "accepted", fresh_delivery=True)["task_id"] == first["task_id"], "restart changed task"
    print("PASS: real Plane 1.4.2 signed events + real Coordinator; create-only, approval/identity/missing-field gates, forgery, reorder, duplicate/body replay, background retry after database fault and restart without redelivery, self-write suppression; 1 task / 1 execution")
finally:
    if proc is not None:
        proc.kill()
        proc.wait()
    if issue:
        plane(f"issues/{issue}/", "DELETE")
    if created_label:
        plane(f"labels/{label_id}/", "DELETE")
    if issue:
        assert plane("issues/")["total_results"] == before_issues, "test project issue count not restored"
        assert len(plane("labels/")["results"]) == len(labels), "test project label count not restored"
        print("PASS: test issue/label cleanup restored project counts")
