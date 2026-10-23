import type { Models } from "@earendil-works/pi-ai/models";

type LoginInteraction = Parameters<Models["login"]>[2];

export function createLoginInteraction(
  ask: (message: string, signal?: AbortSignal) => Promise<string>,
  write: (text: string) => void,
  signal?: AbortSignal,
): LoginInteraction {
  return {
    signal,
    async prompt(question) {
      const promptSignal =
        question.signal && signal
          ? AbortSignal.any([question.signal, signal])
          : (question.signal ?? signal);
      promptSignal?.throwIfAborted();
      if (question.type !== "select")
        return ask(question.message + "\n", promptSignal);
      if (question.options.length === 0)
        throw new Error("login_options_missing");
      const menu = question.options
        .map(
          (option, index) =>
            `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
        )
        .join("\n");
      for (;;) {
        const answer = (
          await ask(
            `${question.message}\n${menu}\n选择编号或选项 ID，回车使用 1：`,
            promptSignal,
          )
        ).trim();
        const option =
          answer === ""
            ? question.options[0]
            : (question.options.find((item) => item.id === answer) ??
              (/^[1-9]\d*$/.test(answer)
                ? question.options[Number(answer) - 1]
                : undefined));
        if (option) return option.id;
        write("请选择列表中的编号或选项 ID。\n");
      }
    },
    notify(event) {
      if (event.type === "auth_url") {
        if (event.instructions) write(event.instructions + "\n");
        write(event.url + "\n");
      } else if (event.type === "device_code") {
        write(`${event.verificationUri}\n${event.userCode}\n`);
      } else {
        write(event.message + "\n");
      }
    },
  };
}
