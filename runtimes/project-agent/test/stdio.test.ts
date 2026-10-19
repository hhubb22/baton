import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { frames, MAX_FRAME, StdioClient } from "../../shared/stdio.js";

test("stdio 拒绝超限、无效 UTF-8 和残缺帧", async () => {
  for (const value of [
    Buffer.from("x".repeat(MAX_FRAME + 1)),
    Buffer.from([123, 255, 125, 10]),
    Buffer.from("{"),
  ]) {
    await assert.rejects(async () => {
      for await (const _ of frames(Readable.from([value]))) {
      }
    });
  }
});
test("stdio 响应按编号匹配，EOF 拒绝尚未完成的调用", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const client = new StdioClient(input, output);
  const first = client.call({ operation: "one" }),
    second = client.call({ operation: "two" });
  input.write('{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n');
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  const pending = client.call({ operation: "three" });
  input.end();
  await assert.rejects(pending, /sidecar_closed/);
});
