import { Queue } from "bun";
import { expectType } from "./utilities";

type Email = { to: string; subject?: string };

const emails = new Bun.Queue<Email>("emails", { path: "./queue.sqlite" });
expectType(emails).is<Queue<Email>>();
expectType(emails.name).is<string>();
expectType(new Queue("untyped")).is<Queue<unknown>>();
new Queue("in-memory", {});
new Queue("in-memory", { path: ":memory:" });

// @ts-expect-error
new Queue();
// @ts-expect-error
new Queue(1);
// @ts-expect-error
new Queue("emails", { path: 1 });

expectType(emails.send({ to: "a@example.com" })).is<Promise<void>>();
expectType(emails.send({ to: "a@example.com" }, { delaySeconds: 1.5, contentType: "v8" })).is<Promise<void>>();
// @ts-expect-error
emails.send({ from: "a@example.com" });
// @ts-expect-error
emails.send({ to: "a@example.com" }, { contentType: "xml" });
// @ts-expect-error
emails.send({ to: "a@example.com" }, { delaySeconds: "1" });

expectType(
  emails.sendBatch([{ body: { to: "a@example.com" } }, { body: { to: "b@example.com" }, delaySeconds: 5 }]),
).is<Promise<void>>();
expectType(
  emails.sendBatch(new Set([{ body: { to: "a@example.com" }, contentType: "json" as const }]), { delaySeconds: 1 }),
).is<Promise<void>>();
// @ts-expect-error
emails.sendBatch([{ to: "a@example.com" }]);
// @ts-expect-error
emails.sendBatch({ body: { to: "a@example.com" } });

expectType(emails.metrics()).is<Promise<Queue.Metrics>>();
expectType((await emails.metrics()).backlogCount).is<number>();
expectType((await emails.metrics()).backlogBytes).is<number>();
expectType((await emails.metrics()).oldestMessageTimestamp).is<number>();

const consumer = emails.consume(
  async batch => {
    expectType(batch).is<Queue.MessageBatch<Email>>();
    expectType(batch.queue).is<string>();
    expectType(batch.messages).is<readonly Queue.Message<Email>[]>();
    for (const message of batch.messages) {
      expectType(message.id).is<string>();
      expectType(message.timestamp).is<Date>();
      expectType(message.body).is<Email>();
      expectType(message.attempts).is<number>();
      expectType(message.ack()).is<void>();
      expectType(message.retry()).is<void>();
      expectType(message.retry({ delaySeconds: 30 })).is<void>();
      // @ts-expect-error
      message.retry({ delay: 30 });
      // @ts-expect-error
      message.body = { to: "" };
    }
    expectType(batch.ackAll()).is<void>();
    expectType(batch.retryAll()).is<void>();
    expectType(batch.retryAll({ delaySeconds: 30 })).is<void>();
    // @ts-expect-error
    batch.messages.push(batch.messages[0]);
  },
  {
    maxBatchSize: 10,
    maxBatchTimeout: 0.5,
    maxRetries: 3,
    retryDelay: attempts => 2 ** attempts,
    maxConcurrency: 4,
    deadLetterQueue: "emails-dead",
    visibilityTimeout: 30,
    onError(error, batch) {
      expectType(error).is<unknown>();
      expectType(batch).is<Queue.MessageBatch<Email> | undefined>();
    },
  },
);
expectType(consumer).is<Queue.Consumer>();
expectType(consumer.stop()).is<Promise<void>>();
expectType(consumer.ref()).is<Queue.Consumer>();
expectType(consumer.unref()).is<Queue.Consumer>();

emails.consume(() => {});
emails.consume(batch => batch.ackAll(), { retryDelay: 5 });
// @ts-expect-error
emails.consume();
// @ts-expect-error
emails.consume(() => {}, { maxRetries: "3" });
// @ts-expect-error
emails.consume(() => {}, { deadLetterQueue: emails });
// @ts-expect-error
emails.consume(() => {}, { retryDelay: () => "soon" });

expectType(emails.close()).is<Promise<void>>();

{
  using queue = new Queue<number>("numbers");
  using scoped = queue.consume(() => {});
  void scoped;
}
{
  await using queue = new Queue<number>("numbers");
  await using scoped = queue.consume(() => {});
  void scoped;
}

const options: Queue.ConsumerOptions<Email> = {};
const sendOptions: Queue.SendOptions = { contentType: "bytes" };
const request: Queue.MessageSendRequest<Email> = { body: { to: "a@example.com" } };
const contentType: Queue.ContentType = "text";
(void options, sendOptions, request, contentType);
